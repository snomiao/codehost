// Default signaling endpoint. In production the page is served from
// codehost.dev and talks to the Worker on signal.codehost.dev; in local dev
// (vite on :5173) it talks to `wrangler dev` on :8787. Override either with
// localStorage key "codehost.signal".

function defaultSignalUrl(): string {
  if (typeof window === "undefined") return "wss://signal.codehost.dev";
  const { hostname, protocol } = window.location;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  if (isLocal) return "ws://localhost:8787";
  const wsProto = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//signal.${hostname.replace(/^www\./, "")}`;
}

export function getSignalUrl(): string {
  if (typeof localStorage !== "undefined") {
    const override = localStorage.getItem("codehost.signal");
    if (override) return override;
  }
  return defaultSignalUrl();
}
