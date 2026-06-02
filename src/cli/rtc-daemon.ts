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
const ndc = require("node-datachannel") as typeof import("node-datachannel");

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
