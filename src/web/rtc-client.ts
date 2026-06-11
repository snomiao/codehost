import { CHANNEL_LABEL, ICE_SERVERS, type RtcSignal } from "../shared/rtc";

export interface RtcClientOptions {
  /** Relay a signal to the server peer via the signaling channel. */
  sendSignal: (data: RtcSignal) => void;
  onOpen?: (channel: RTCDataChannel) => void;
  onClose?: () => void;
  onState?: (state: RTCPeerConnectionState) => void;
}

/**
 * Browser-side WebRTC client. The viewer is the offerer: it creates the data
 * channel, makes an offer, and exchanges ICE with the daemon via signaling.
 */
export class RtcClient {
  private pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;

  constructor(private opts: RtcClientOptions) {
    this.pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS.map((urls) => ({ urls })),
    });

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.opts.sendSignal({
          kind: "candidate",
          candidate: ev.candidate.candidate,
          mid: ev.candidate.sdpMid ?? "0",
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      this.opts.onState?.(this.pc.connectionState);
    };
  }

  /** Create the data channel + offer and kick off the handshake. */
  async start(): Promise<void> {
    const channel = this.pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
    channel.binaryType = "arraybuffer";
    this.channel = channel;
    channel.onopen = () => this.opts.onOpen?.(channel);
    channel.onclose = () => this.opts.onClose?.();

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.opts.sendSignal({ kind: "offer", type: "offer", sdp: offer.sdp ?? "" });
  }

  /** Handle an inbound signal from the daemon. */
  async handleSignal(data: unknown): Promise<void> {
    const sig = data as RtcSignal;
    if (!sig || typeof sig !== "object") return;

    if (sig.kind === "answer") {
      await this.pc.setRemoteDescription({ type: "answer", sdp: sig.sdp });
    } else if (sig.kind === "candidate") {
      try {
        await this.pc.addIceCandidate({ candidate: sig.candidate, sdpMid: sig.mid });
      } catch (err) {
        console.error("[rtc] addIceCandidate failed:", err);
      }
    }
  }

  get dataChannel(): RTCDataChannel | null {
    return this.channel;
  }

  /**
   * Which ICE path the nominated candidate pair uses: "lan" when both ends
   * are host candidates (same network — traffic never leaves it), "p2p" for a
   * NAT-traversed direct path, null while undetermined. Surfaced in the UI so
   * "it feels slow" reports come with the path attached.
   */
  async selectedPath(): Promise<"lan" | "p2p" | null> {
    try {
      const stats = await this.pc.getStats();
      let pairId: string | null = null;
      stats.forEach((s) => {
        if (s.type === "transport" && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
      });
      let pair: RTCIceCandidatePairStats | null = null;
      stats.forEach((s) => {
        if (pairId ? s.id === pairId : s.type === "candidate-pair" && s.state === "succeeded" && s.nominated) {
          pair = s as RTCIceCandidatePairStats;
        }
      });
      if (!pair) return null;
      const { localCandidateId, remoteCandidateId } = pair as RTCIceCandidatePairStats;
      let lan = true;
      let found = 0;
      stats.forEach((s) => {
        if (s.id === localCandidateId || s.id === remoteCandidateId) {
          found++;
          if ((s as { candidateType?: string }).candidateType !== "host") lan = false;
        }
      });
      if (found < 2) return null;
      return lan ? "lan" : "p2p";
    } catch {
      return null;
    }
  }

  close(): void {
    try {
      this.channel?.close();
    } catch {
      // ignore
    }
    try {
      this.pc.close();
    } catch {
      // ignore
    }
  }
}
