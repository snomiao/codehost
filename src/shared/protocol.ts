// Binary framing for multiplexing HTTP requests and WebSocket streams over a
// single WebRTC data channel. One data-channel message == one frame:
//
//   byte 0      : opcode
//   bytes 1..4  : streamId (uint32, big-endian)
//   bytes 5..   : payload (raw bytes; JSON-encoded for control frames)
//
// The browser (Service Worker / WS shim, via the page) is the client; the
// daemon is the server proxying to the local `code serve-web` instance.

export enum Op {
  // HTTP client -> server
  HttpReq = 1, // JSON { method, path, headers }
  HttpReqBody = 2, // raw bytes
  HttpReqEnd = 3,
  // HTTP server -> client
  HttpResHead = 4, // JSON { status, statusText, headers }
  HttpResBody = 5, // raw bytes
  HttpResEnd = 6,
  // WebSocket client -> server
  WsOpen = 7, // JSON { path, protocols? }
  WsText = 9, // utf-8 text
  WsBin = 10, // raw bytes
  WsClose = 11, // JSON { code?, reason? }
  // WebSocket server -> client
  WsOpenAck = 8, // JSON { ok, protocol? }
  // either direction
  Error = 12, // JSON { message }
  // WebSocket continuation: raw bytes prepended to the next WsText/WsBin frame
  // of the same stream, so a single WS message can span multiple frames.
  WsCont = 13,
}

// WebRTC data-channel messages must stay small to be portable: 16 KiB is the
// largest size every WebRTC stack (libdatachannel, Chrome, Firefox) reliably
// accepts. A frame is [op:1][streamId:4][payload], so the payload budget is
// 16 KiB minus the 5-byte header.
export const FRAME_HEADER = 5;
export const MAX_FRAME = 16 * 1024;
/** Max payload bytes per frame; larger bodies/messages are split across frames. */
export const MAX_CHUNK = MAX_FRAME - FRAME_HEADER;

export interface HttpReqHead {
  method: string;
  path: string;
  headers: Record<string, string>;
}

export interface HttpResHead {
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeFrame(op: Op, streamId: number, payload?: Uint8Array): Uint8Array {
  const len = payload?.byteLength ?? 0;
  const buf = new Uint8Array(5 + len);
  buf[0] = op;
  new DataView(buf.buffer).setUint32(1, streamId >>> 0, false);
  if (payload && len) buf.set(payload, 5);
  return buf;
}

export function encodeJson(op: Op, streamId: number, obj: unknown): Uint8Array {
  return encodeFrame(op, streamId, enc.encode(JSON.stringify(obj)));
}

export function encodeText(op: Op, streamId: number, text: string): Uint8Array {
  return encodeFrame(op, streamId, enc.encode(text));
}

export interface DecodedFrame {
  op: Op;
  streamId: number;
  payload: Uint8Array;
}

export function decodeFrame(data: ArrayBuffer | Uint8Array): DecodedFrame {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const op = u8[0] as Op;
  const streamId = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(1, false);
  const payload = u8.subarray(5);
  return { op, streamId, payload };
}

export function payloadJson<T>(payload: Uint8Array): T {
  return JSON.parse(dec.decode(payload)) as T;
}

export function payloadText(payload: Uint8Array): string {
  return dec.decode(payload);
}

/** Split a body into MAX_CHUNK-sized slices (copies, safe to transfer). */
export function* chunk(body: Uint8Array): Generator<Uint8Array> {
  for (let off = 0; off < body.byteLength; off += MAX_CHUNK) {
    yield body.slice(off, Math.min(off + MAX_CHUNK, body.byteLength));
  }
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/**
 * Frames for one WebSocket message. Messages that fit in a single frame emit
 * just a WsText/WsBin frame (back-compatible). Larger ones are split into
 * WsCont frames carrying the leading bytes, terminated by the WsText/WsBin
 * frame with the final bytes; the receiver concatenates them in order.
 */
export function* wsMessageFrames(
  terminal: Op.WsText | Op.WsBin,
  streamId: number,
  payload: Uint8Array,
): Generator<Uint8Array> {
  let off = 0;
  while (payload.byteLength - off > MAX_CHUNK) {
    yield encodeFrame(Op.WsCont, streamId, payload.subarray(off, off + MAX_CHUNK));
    off += MAX_CHUNK;
  }
  yield encodeFrame(terminal, streamId, payload.subarray(off));
}

/**
 * Reassembles WsCont + terminal frames back into whole WebSocket messages,
 * keyed by streamId. Feed it every WsCont/WsText/WsBin payload; it returns the
 * complete message bytes on a terminal frame, or null while buffering.
 */
export class WsReassembler {
  private pending = new Map<number, Uint8Array[]>();

  cont(streamId: number, payload: Uint8Array): void {
    const buf = this.pending.get(streamId);
    if (buf) buf.push(payload.slice());
    else this.pending.set(streamId, [payload.slice()]);
  }

  finish(streamId: number, payload: Uint8Array): Uint8Array {
    const buf = this.pending.get(streamId);
    if (!buf) return payload;
    this.pending.delete(streamId);
    buf.push(payload);
    return concatBytes(buf);
  }

  drop(streamId: number): void {
    this.pending.delete(streamId);
  }
}
