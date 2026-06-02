import { Room } from "./room";

export { Room };

interface Env {
  ROOM: DurableObjectNamespace;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // GET /room/:token  -> WebSocket upgrade routed to the per-token DO.
    const match = url.pathname.match(/^\/room\/([^/]+)\/?$/);
    if (match) {
      const token = decodeURIComponent(match[1]);
      const id = env.ROOM.idFromName(token);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "codehost-signal" }), {
        headers: { "content-type": "application/json", ...CORS },
      });
    }

    return new Response("not found", { status: 404, headers: CORS });
  },
};
