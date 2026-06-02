import { TunnelClient } from "./tunnel-client";
import { makeTunnelWebSocket } from "./tunnel-websocket";

// Page-side glue between the Service Worker and the per-peer TunnelClients.
// - Registers the SW.
// - Holds a TunnelClient for each connected peer (keyed by peerId).
// - Answers the SW's `tunnel-fetch` messages by running the request over the
//   matching data channel and streaming the response back through the port.
// - Exposes window.__codehostMakeWS so the VS Code iframe's injected bootstrap
//   can install a WebSocket shim bound to the right peer (same-origin access).

const clients = new Map<string, TunnelClient>();

declare global {
  interface Window {
    __codehostMakeWS?: (peerId: string, basePath: string) => unknown;
  }
}

export async function registerTunnelHost(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    console.warn("[codehost] no service worker support; VS Code tunneling unavailable");
    return;
  }

  navigator.serviceWorker.addEventListener("message", onSwMessage);

  window.__codehostMakeWS = (peerId: string, basePath: string) => {
    const client = clients.get(peerId);
    return client ? makeTunnelWebSocket(client, basePath) : undefined;
  };

  // Built to /sw.js at the web root (see vite.sw.config.ts) so its scope is "/".
  await navigator.serviceWorker.register("/sw.js", { type: "module", scope: "/" });
  await navigator.serviceWorker.ready;
}

export function setTunnelClient(peerId: string, channel: RTCDataChannel): TunnelClient {
  const client = new TunnelClient(channel);
  clients.set(peerId, client);
  return client;
}

export function clearTunnelClient(peerId: string): void {
  clients.delete(peerId);
}

function onSwMessage(event: MessageEvent): void {
  const msg = event.data;
  if (msg?.type !== "tunnel-fetch") return;
  const port = event.ports[0];
  const client = clients.get(msg.peerId);
  if (!client) {
    port.postMessage({ type: "error", message: "peer not connected" });
    return;
  }

  void client
    .fetch(msg.method, msg.path, msg.headers, msg.body ? new Uint8Array(msg.body) : undefined)
    .then(async (res) => {
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      port.postMessage({ type: "head", status: res.status, statusText: res.statusText, headers });
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // Transfer the underlying buffer to avoid a copy.
          const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
          port.postMessage({ type: "body", chunk: buf }, [buf]);
        }
      }
      port.postMessage({ type: "end" });
    })
    .catch((err) => {
      port.postMessage({ type: "error", message: String(err) });
    });
}
