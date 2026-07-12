import type { DataChannel } from "node-datachannel";
import type { TunnelTransport } from "./transport";

/** Wrap a node-datachannel DataChannel as a TunnelTransport. */
export function nodeDataChannelTransport(channel: DataChannel): TunnelTransport {
  return {
    send(frame) {
      channel.sendMessageBinary(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
    },
    isOpen: () => channel.isOpen(),
    bufferedAmount: () => channel.bufferedAmount(),
    setBufferedAmountLow(bytes, cb) {
      try {
        channel.setBufferedAmountLowThreshold(bytes);
        channel.onBufferedAmountLow(cb);
      } catch {
        // older node-datachannel: the sender's safety poll still covers it
      }
    },
    onFrame(cb) {
      channel.onMessage((msg) => {
        if (typeof msg === "string") return; // all frames are binary
        const buf = msg as Buffer;
        cb(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      });
    },
    onClose(cb) {
      channel.onClosed(cb);
    },
  };
}
