// WebRTC signal payloads carried inside the signaling relay's `data` field.
// The browser (viewer) is always the initiator/offerer; the daemon (server)
// answers. STUN-only for v1 (TURN can be added to ICE_SERVERS later).

export const ICE_SERVERS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
];

export interface SdpSignal {
  kind: "offer" | "answer";
  type: "offer" | "answer";
  sdp: string;
}

export interface CandidateSignal {
  kind: "candidate";
  candidate: string;
  /** sdpMid / media line id. */
  mid: string;
}

/**
 * Host-side admission control, relayed opaquely like any other signal. The
 * daemon sends "pending" while a client awaits the host's approval and "denied"
 * if the host rejects (or kicks) it — so the client can show why it's waiting or
 * was cut off, instead of a silent hang. Approval needs no signal: the daemon
 * just answers the offer. Old daemons never send these; old clients ignore an
 * unknown `kind`, so this is backward compatible both ways.
 */
export interface ControlSignal {
  kind: "pending" | "denied";
}

export type RtcSignal = SdpSignal | CandidateSignal | ControlSignal;

/** Label used for the control/tunnel data channel. */
export const CHANNEL_LABEL = "codehost";
/**
 * Second data channel for bulk HTTP bodies. Separate channel = separate SCTP
 * stream, so multi-MB asset downloads no longer head-of-line block the
 * interactive WS traffic (VS Code remote protocol, terminal) on
 * CHANNEL_LABEL. The daemon spins up one Tunnel per incoming channel, so old
 * daemons handle this unmodified; old browsers simply never open it.
 */
export const BULK_CHANNEL_LABEL = "codehost-bulk";
