// The tunnel protocol package: binary framing + the two protocol endpoints
// (TunnelHost proxies to a local port; TunnelClient issues fetch/WebSocket
// over the wire), decoupled from any one transport. Adapters:
//   ./rtc-datachannel  — browser RTCDataChannel
//   ./node-datachannel — node-datachannel DataChannel (daemon side)
//   ./testing          — in-memory pair for conformance tests
export * from "./protocol";
export * from "./transport";
export * from "./host";
export * from "./client";
export { rtcDataChannelTransport } from "./rtc-datachannel";
