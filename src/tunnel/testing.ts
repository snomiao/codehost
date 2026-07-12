import type { TunnelTransport } from "./transport";

/**
 * One end of an in-memory transport pair. Frames sent on one side are
 * delivered asynchronously (microtask) to the other, in order. No real
 * network, no fragment-size limit — the protocol layer under test does its
 * own chunking. Test-only knobs on top of the transport contract: close()
 * and a settable fake bufferedAmount (backpressure tests).
 */
export class MemoryTransport implements TunnelTransport {
  peer: MemoryTransport | null = null;
  private open = true;
  private fakeBuffered: number | null = null;
  private frameCb: ((data: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private lowCb: { bytes: number; cb: () => void } | null = null;

  send(frame: Uint8Array): void {
    const peer = this.peer;
    if (!this.open || !peer?.open) return;
    const copy = frame.slice();
    queueMicrotask(() => {
      if (peer.open) peer.frameCb?.(copy);
    });
  }

  isOpen(): boolean {
    return this.open;
  }

  bufferedAmount(): number {
    return this.fakeBuffered ?? 0;
  }

  setBufferedAmountLow(bytes: number, cb: () => void): void {
    this.lowCb = { bytes, cb };
  }

  onFrame(cb: (data: Uint8Array) => void): void {
    this.frameCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.closeCb?.();
    const peer = this.peer;
    if (peer?.open) {
      peer.open = false;
      peer.closeCb?.();
    }
  }

  /** Override the reported bufferedAmount (null = real, i.e. always 0). */
  setFakeBufferedAmount(bytes: number | null): void {
    this.fakeBuffered = bytes;
    if (bytes !== null && this.lowCb && bytes < this.lowCb.bytes) this.lowCb.cb();
  }
}

/** A connected pair of in-memory transports. */
export function memoryTransportPair(): [MemoryTransport, MemoryTransport] {
  const a = new MemoryTransport();
  const b = new MemoryTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
