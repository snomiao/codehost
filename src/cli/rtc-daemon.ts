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
  /** Relay a signal to a viewer peer via the signaling channel. */
  sendSignal: (to: string, data: RtcSignal) => void;
  /** Called when a viewer's data channel opens. */
  onChannel: (viewerId: string, channel: DataChannel) => void;
}

interface ViewerConn {
  pc: PeerConnectionT;
}

/**
 * Daemon-side WebRTC manager. The browser (viewer) is the offerer; for each
 * viewer that sends an offer we create an answering PeerConnection and surface
 * its data channel. STUN-only.
 */
export class RtcDaemon {
  private viewers = new Map<string, ViewerConn>();

  constructor(private opts: RtcDaemonOptions) {}

  /** Route an inbound signaling payload from a viewer. */
  handleSignal(from: string, data: unknown): void {
    const sig = data as RtcSignal;
    if (!sig || typeof sig !== "object") return;

    if (sig.kind === "offer") {
      this.acceptOffer(from, sig.sdp);
    } else if (sig.kind === "candidate") {
      const conn = this.viewers.get(from);
      if (conn) {
        try {
          conn.pc.addRemoteCandidate(sig.candidate, sig.mid);
        } catch (err) {
          console.error(`[rtc] addRemoteCandidate failed for ${from.slice(0, 8)}:`, err);
        }
      }
    }
  }

  private acceptOffer(viewerId: string, sdp: string): void {
    // Replace any prior connection for this viewer (e.g. page reload).
    this.dropViewer(viewerId);

    const pc = new ndc.PeerConnection(`viewer-${viewerId.slice(0, 8)}`, {
      iceServers: ICE_SERVERS,
    });
    this.viewers.set(viewerId, { pc });

    pc.onLocalDescription((localSdp, type) => {
      this.opts.sendSignal(viewerId, {
        kind: type as "answer",
        type: type as "answer",
        sdp: localSdp,
      });
    });

    pc.onLocalCandidate((candidate, mid) => {
      this.opts.sendSignal(viewerId, { kind: "candidate", candidate, mid });
    });

    pc.onStateChange((state) => {
      console.log(`[rtc] ${viewerId.slice(0, 8)} state: ${state}`);
      if (state === "disconnected" || state === "failed" || state === "closed") {
        this.dropViewer(viewerId);
      }
    });

    pc.onDataChannel((dc) => {
      console.log(`[rtc] ${viewerId.slice(0, 8)} channel "${dc.getLabel()}" open`);
      this.opts.onChannel(viewerId, dc);
    });

    try {
      pc.setRemoteDescription(sdp, "offer");
    } catch (err) {
      console.error(`[rtc] setRemoteDescription failed for ${viewerId.slice(0, 8)}:`, err);
      this.dropViewer(viewerId);
    }
  }

  private dropViewer(viewerId: string): void {
    const conn = this.viewers.get(viewerId);
    if (!conn) return;
    this.viewers.delete(viewerId);
    try {
      conn.pc.close();
    } catch {
      // ignore
    }
  }

  closeAll(): void {
    for (const id of [...this.viewers.keys()]) this.dropViewer(id);
    try {
      ndc.cleanup();
    } catch {
      // ignore
    }
  }
}
