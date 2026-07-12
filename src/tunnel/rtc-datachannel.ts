import type { TunnelTransport } from "./transport";

/** Wrap a browser RTCDataChannel as a TunnelTransport. */
export function rtcDataChannelTransport(channel: RTCDataChannel): TunnelTransport {
  channel.binaryType = "arraybuffer";
  return {
    send(frame) {
      // Copy into a fresh ArrayBuffer-backed view to satisfy send()'s typing.
      const copy = new Uint8Array(frame.byteLength);
      copy.set(frame);
      channel.send(copy.buffer);
    },
    isOpen: () => channel.readyState === "open",
    bufferedAmount: () => channel.bufferedAmount,
    setBufferedAmountLow(bytes, cb) {
      channel.bufferedAmountLowThreshold = bytes;
      channel.addEventListener("bufferedamountlow", cb);
    },
    onFrame(cb) {
      channel.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") return; // all frames are binary
        cb(new Uint8Array(ev.data as ArrayBuffer));
      });
    },
    onClose(cb) {
      channel.addEventListener("close", cb);
    },
  };
}
