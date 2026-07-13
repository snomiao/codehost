import { afterAll, describe, expect, test } from "bun:test";
import { previewPlugin } from "./preview";
import { routePlugins } from "./types";

// A local "dev server" that echoes what it received, so we can assert the
// proxy rewrote the Host and preserved path/method/body.
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    return Response.json({
      path: url.pathname + url.search,
      method: req.method,
      host: req.headers.get("host"),
      xfh: req.headers.get("x-forwarded-host"),
      body: req.method === "GET" ? null : await req.text(),
    });
  },
});
afterAll(() => upstream.stop(true));

const req = (method: string, headers: Record<string, string> = {}, body?: Uint8Array) => ({
  method,
  headers: new Headers(headers),
  body,
});

describe("preview plugin", () => {
  const p = previewPlugin();

  test("mounts at /__codehost/port and proxies to 127.0.0.1:<PORT>", async () => {
    const res = routePlugins([p], {
      method: "GET",
      path: `/__codehost/port/${upstream.port}/assets/app.js?v=1`,
      headers: new Headers({ host: "x7.agent-yes.com" }),
    });
    expect(res).not.toBeNull();
    const body = (await (await res!).json()) as Record<string, unknown>;
    expect(body.path).toBe("/assets/app.js?v=1");
    // Host rewritten to the loopback port (so dev-server allow-lists accept it),
    // public host preserved in x-forwarded-host.
    expect(body.host).toBe(`127.0.0.1:${upstream.port}`);
    expect(body.xfh).toBe("x7.agent-yes.com");
  });

  test("bare port maps to /", async () => {
    const res = await p.route!(`/${upstream.port}`, req("GET"));
    expect(((await res.json()) as { path: string }).path).toBe("/");
  });

  test("forwards method + body", async () => {
    const res = await p.route!(`/${upstream.port}/api`, req("POST", {}, new TextEncoder().encode("hi")));
    const body = (await res.json()) as { method: string; body: string };
    expect(body.method).toBe("POST");
    expect(body.body).toBe("hi");
  });

  test("bad port shapes are rejected", async () => {
    expect((await p.route!("/notaport/x", req("GET"))).status).toBe(404);
    expect((await p.route!("/99999/x", req("GET"))).status).toBe(400);
  });

  test("dead upstream port -> 502", async () => {
    expect((await p.route!("/1/x", req("GET"))).status).toBe(502);
  });
});
