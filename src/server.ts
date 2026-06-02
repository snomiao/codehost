#!/usr/bin/env bun
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import {
  getOrCreateSession,
  handleWsClose,
  handleWsMessage,
  handleWsOpen,
  listSessions,
  sessionKeyForCwd,
  validateCwd,
  type WsData,
} from "./terminal-ws";

const PORT = parseInt(process.env.PORT ?? "3001");
const app = new Hono();

app.use("*", cors({ origin: "*" }));

// Health check
app.get("/api/health", (c) => c.json({ ok: true }));

// List terminal sessions
app.get("/api/sessions", (c) => c.json(listSessions()));

// Serve built frontend in production
app.use("*", serveStatic({ root: "./dist/public" }));
app.get("*", serveStatic({ path: "./dist/public/index.html" }));

Bun.serve<WsData>({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for terminal
    if (url.pathname === "/ws") {
      const rawCwd = url.searchParams.get("cwd");
      const cols = parseInt(url.searchParams.get("cols") ?? "80");
      const rows = parseInt(url.searchParams.get("rows") ?? "24");

      let cwd: string;
      try {
        cwd = validateCwd(rawCwd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(msg, { status: 400 });
      }

      const sessionKey = sessionKeyForCwd(cwd);
      getOrCreateSession(sessionKey, cwd, cols, rows);

      const upgraded = server.upgrade(req, { data: { sessionKey } });
      if (upgraded) return;
      return new Response("WebSocket upgrade failed", { status: 426 });
    }

    return app.fetch(req);
  },

  websocket: {
    open: handleWsOpen,
    message: handleWsMessage,
    close: handleWsClose,
  },
});

console.log(`Codehost server listening on http://localhost:${PORT}`);
