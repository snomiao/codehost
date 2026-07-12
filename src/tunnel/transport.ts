// Transport abstraction for the tunnel protocol. A transport delivers whole
// frames (one send == one message) in order, both ways — WebRTC data channels
// today; a WebSocket leg (e.g. daemon -> edge relay) fits the same shape.

export interface TunnelTransport {
  /** Queue one frame. Callers gate on isOpen(); implementations may copy. */
  send(frame: Uint8Array): void;
  isOpen(): boolean;
  /** Bytes queued but not yet handed to the network (0 if unknowable). */
  bufferedAmount(): number;
  /**
   * Ask to be called (repeatedly) whenever bufferedAmount drops below
   * `bytes`. Optional: senders that pause on backpressure also poll.
   */
  setBufferedAmountLow?(bytes: number, cb: () => void): void;
  /** Deliver every incoming binary frame. Non-binary messages are dropped. */
  onFrame(cb: (data: Uint8Array) => void): void;
  onClose(cb: () => void): void;
}
