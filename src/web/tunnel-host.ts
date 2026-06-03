import { connBroker } from "./conn-broker";
import { makeTunnelWebSocket } from "./tunnel-websocket";

// Page-side glue between the Service Worker and the connection broker.
// - Registers the SW and starts the broker (SharedWorker coordination).
// - Answers the SW's `tunnel-fetch` messages by running the request over the
//   right tunnel for the peer (local channel if this tab owns it, else a proxy
//   to the owner tab) and streaming the response back through the port.
// - Exposes window.__codehostMakeWS so the VS Code iframe's injected bootstrap
//   can install a WebSocket shim bound to the right peer (same-origin access).

declare global {
  interface Window {
    __codehostMakeWS?: (peerId: string, basePath: string) => unknown;
  }
}

export async function registerTunnelHost(): Promise<void> {
  connBroker.init();

  if (!("serviceWorker" in navigator)) {
    console.warn("[codehost] no service worker support; VS Code tunneling unavailable");
    return;
  }

  navigator.serviceWorker.addEventListener("message", onSwMessage);

  window.__codehostMakeWS = (peerId: string, basePath: string) =>
    makeTunnelWebSocket(connBroker.tunnelFor(peerId), basePath);

  // Built to /sw.js at the web root (see vite.sw.config.ts) so its scope is "/".
  await navigator.serviceWorker.register("/sw.js", { type: "module", scope: "/" });
  await navigator.serviceWorker.ready;
}

function onSwMessage(event: MessageEvent): void {
  const msg = event.data;
  if (msg?.type !== "tunnel-fetch") return;
  const port = event.ports[0];

  void connBroker
    .tunnelFor(msg.peerId)
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
