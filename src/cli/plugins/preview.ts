import type { DaemonPlugin } from "./types";

// preview plugin: HTTP-proxy /__codehost/port/<PORT>/* to http://127.0.0.1:<PORT>/*
// so an embedder (the agent-yes console) can render a local dev server IN the
// existing WebRTC tunnel — the viewer's traffic goes peer-to-peer through the
// codehost DataChannel instead of the public edge relay.
//
// Trust: the room token already grants code execution (the editor is a
// terminal), so proxying to a loopback port is the same boundary — no new
// capability. Only 127.0.0.1 is reachable; the Host is rewritten to the local
// port so dev-server host allow-lists (Vite/webpack/Next) accept the request.

const PORT_PATH = /^\/(\d{1,5})(\/.*)?$/;

export function previewPlugin(): DaemonPlugin {
  return {
    name: "port",
    route: async (path, req) => {
      const m = PORT_PATH.exec(path);
      if (!m) return new Response("expected /__codehost/port/<PORT>/…", { status: 404 });
      const port = Number(m[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return new Response("invalid port", { status: 400 });
      }
      const rest = m[2] || "/";
      const headers = new Headers(req.headers);
      // Present the loopback host so dev servers with a host allow-list accept
      // it; keep the public host available to the app via x-forwarded-host.
      const forwarded = headers.get("host");
      if (forwarded) headers.set("x-forwarded-host", forwarded);
      headers.set("host", `127.0.0.1:${port}`);
      headers.set("x-forwarded-proto", "https");
      try {
        return await fetch(`http://127.0.0.1:${port}${rest}`, {
          method: req.method,
          headers,
          body: req.body as BodyInit | undefined,
          redirect: "manual",
        });
      } catch {
        return new Response(`nothing is listening on 127.0.0.1:${port}`, { status: 502 });
      }
    },
  };
}
