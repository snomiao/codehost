import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type {
  DataChannel,
  PeerConnection as PeerConnectionT,
} from "node-datachannel";
import { ICE_SERVERS, type RtcSignal } from "../shared/rtc";

// node-datachannel is a native addon. Under Bun, the ESM `import` resolves the
// package to the global cache (where the prebuilt .node isn't), but `require`
// resolves correctly from the project's node_modules. So load it via require;
// the `import type` above is erased at build time and triggers no runtime load.
const require = createRequire(import.meta.url);
const ndc = loadNodeDataChannel();

/**
 * Load the native node-datachannel addon, self-healing the common failure where
 * its prebuilt `.node` was never fetched. That happens under `bunx codehost`:
 * bunx skips install lifecycle scripts (and `trustedDependencies` only applies
 * to `bun install`), so node-datachannel's `install` step — which downloads the
 * binary via `prebuild-install` — never runs. On the first load failure we run
 * that prebuild-install ourselves, then retry. A normal `bun add -g` install
 * already has the binary, so this is a no-op there.
 */
function loadNodeDataChannel(): typeof import("node-datachannel") {
  try {
    return require("node-datachannel") as typeof import("node-datachannel");
  } catch (firstErr) {
    if (!fetchNodeDataChannelBinary()) throw nativeLoadError(firstErr);
    try {
      return require("node-datachannel") as typeof import("node-datachannel");
    } catch (secondErr) {
      throw nativeLoadError(secondErr);
    }
  }
}

/** Run node-datachannel's bundled `prebuild-install` to fetch the prebuilt
 *  binary. Returns true if it exited cleanly. */
function fetchNodeDataChannelBinary(): boolean {
  let pkgDir: string;
  let prebuildBin: string;
  try {
    pkgDir = dirname(require.resolve("node-datachannel/package.json"));
    // prebuild-install is a dependency of node-datachannel; resolve its CLI
    // entry from the package's own module scope.
    prebuildBin = require.resolve("prebuild-install/bin.js", { paths: [pkgDir] });
  } catch {
    return false;
  }
  console.log("[codehost] fetching node-datachannel native binary (prebuild-install)…");
  const r = spawnSync(process.execPath, [prebuildBin, "-r", "napi"], {
    cwd: pkgDir,
    stdio: "inherit",
  });
  return r.status === 0;
}

function nativeLoadError(cause: unknown): Error {
  return new Error(
    "Failed to load the native WebRTC module (node-datachannel). Its prebuilt " +
      "binary could not be fetched automatically. Install codehost globally so " +
      "install scripts run — `bun add -g codehost` (or `npm i -g codehost`) — " +
      "and ensure network access. If your platform has no prebuilt, a C++ " +
      "toolchain + cmake is needed to build from source. " +
      `(cause: ${(cause as Error)?.message ?? cause})`,
  );
}

export interface RtcDaemonOptions {
  /** Relay a signal to a client peer via the signaling channel. */
  sendSignal: (to: string, data: RtcSignal) => void;
  /** Called when a client's data channel opens. */
  onChannel: (clientId: string, channel: DataChannel) => void;
  /**
   * Admission gate. Resolve true to answer the client's offer, false to deny.
   * Until it resolves we buffer the answer + local ICE so a pending client never
   * completes a connection. Omitted → admit everyone (default).
   */
  admit?: (clientId: string) => Promise<boolean>;
  /** Called once when a client's connection is torn down (drop / deny / kick). */
  onClose?: (clientId: string) => void;
}

interface ClientConn {
  pc: PeerConnectionT;
  /** True once the host has admitted this client; gates outbound answer/ICE. */
  admitted: boolean;
  /** Outbound signals withheld while admission is pending. */
  buffered: RtcSignal[];
}

/**
 * Daemon-side WebRTC manager. The browser (client) is the offerer; for each
 * client that sends an offer we create an answering PeerConnection and surface
 * its data channel. STUN-only.
 */
export class RtcDaemon {
  private clients = new Map<string, ClientConn>();

  constructor(private opts: RtcDaemonOptions) {}

  /** Route an inbound signaling payload from a client. */
  handleSignal(from: string, data: unknown): void {
    const sig = data as RtcSignal;
    if (!sig || typeof sig !== "object") return;

    if (sig.kind === "offer") {
      this.acceptOffer(from, sig.sdp);
    } else if (sig.kind === "candidate") {
      const conn = this.clients.get(from);
      if (conn) {
        try {
          conn.pc.addRemoteCandidate(sig.candidate, sig.mid);
        } catch (err) {
          console.error(`[rtc] addRemoteCandidate failed for ${from.slice(0, 8)}:`, err);
        }
      }
    }
  }

  /** Close a specific client's connection (host kick). */
  close(clientId: string): void {
    this.dropClient(clientId);
  }

  private acceptOffer(clientId: string, sdp: string): void {
    // Replace any prior connection for this client (e.g. page reload).
    this.dropClient(clientId);

    const pc = new ndc.PeerConnection(`client-${clientId.slice(0, 8)}`, {
      iceServers: ICE_SERVERS,
    });
    const conn: ClientConn = { pc, admitted: false, buffered: [] };
    this.clients.set(clientId, conn);

    // Withhold the answer + our ICE until the host admits this client; we still
    // accept the offer + remote candidates so ICE is ready to flush instantly.
    const emit = (sig: RtcSignal) => {
      if (conn.admitted) this.opts.sendSignal(clientId, sig);
      else conn.buffered.push(sig);
    };

    pc.onLocalDescription((localSdp, type) => {
      emit({ kind: type as "answer", type: type as "answer", sdp: localSdp });
    });

    pc.onLocalCandidate((candidate, mid) => {
      emit({ kind: "candidate", candidate, mid });
    });

    pc.onStateChange((state) => {
      console.log(`[rtc] ${clientId.slice(0, 8)} state: ${state}`);
      if (state === "disconnected" || state === "failed" || state === "closed") {
        this.dropClient(clientId);
      }
    });

    pc.onDataChannel((dc) => {
      console.log(`[rtc] ${clientId.slice(0, 8)} channel "${dc.getLabel()}" open`);
      this.opts.onChannel(clientId, dc);
    });

    try {
      pc.setRemoteDescription(sdp, "offer");
    } catch (err) {
      console.error(`[rtc] setRemoteDescription failed for ${clientId.slice(0, 8)}:`, err);
      this.dropClient(clientId);
      return;
    }

    const admit = this.opts.admit ? this.opts.admit(clientId) : Promise.resolve(true);
    admit
      .then((ok) => {
        // The client may have reloaded/dropped while we waited — only act if
        // this exact connection is still current.
        if (this.clients.get(clientId) !== conn) return;
        if (!ok) {
          this.opts.sendSignal(clientId, { kind: "denied" });
          this.dropClient(clientId);
          return;
        }
        conn.admitted = true;
        for (const sig of conn.buffered) this.opts.sendSignal(clientId, sig);
        conn.buffered = [];
      })
      .catch(() => this.dropClient(clientId));
  }

  private dropClient(clientId: string): void {
    const conn = this.clients.get(clientId);
    if (!conn) return;
    this.clients.delete(clientId);
    try {
      conn.pc.close();
    } catch {
      // ignore
    }
    this.opts.onClose?.(clientId);
  }

  closeAll(): void {
    for (const id of [...this.clients.keys()]) this.dropClient(id);
    try {
      ndc.cleanup();
    } catch {
      // ignore
    }
  }
}
