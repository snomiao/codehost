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
