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

export type RtcSignal = SdpSignal | CandidateSignal;

/** Label used for the control/tunnel data channel. */
export const CHANNEL_LABEL = "codehost";
