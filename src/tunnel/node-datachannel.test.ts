import { afterAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import type { DataChannel, PeerConnection } from "node-datachannel";
import { TunnelClient } from "./client";
import { TunnelHost } from "./host";
import { MAX_CHUNK } from "./protocol";
import { nodeDataChannelTransport } from "./node-datachannel";

// Native addon: require resolves the prebuilt .node from node_modules under
// Bun where the ESM import may not (see rtc-daemon.ts for the long story).
const require = createRequire(import.meta.url);
const ndc = require("node-datachannel") as typeof import("node-datachannel");

// Real WebRTC loopback (host ICE candidates only, no STUN): exercises the
// node-datachannel adapter — Buffer conversion, sendMessageBinary, buffered-
// amount plumbing — under the same protocol conformance as the memory pair.

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response("no upgrade", { status: 400 });
    }
    if (url.pathname === "/big") {
      return new Response(new Uint8Array(MAX_CHUNK * 2 + 7).map((_, i) => (i * 11) & 0xff));
    }
    return new Response(`ok:${url.pathname}`);
  },
  websocket: {
    message(ws, message) {
      ws.send(message);
    },
  },
});

const pcs: PeerConnection[] = [];
afterAll(() => {
  for (const pc of pcs) pc.close();
  server.stop(true);
});

function rtcLoopbackPair(): Promise<[DataChannel, DataChannel]> {
  return new Promise((resolve, reject) => {
    const a = new ndc.PeerConnection("a", { iceServers: [] });
    const b = new ndc.PeerConnection("b", { iceServers: [] });
    pcs.push(a, b);
    a.onLocalDescription((sdp, type) => b.setRemoteDescription(sdp, type));
    b.onLocalDescription((sdp, type) => a.setRemoteDescription(sdp, type));
    a.onLocalCandidate((cand, mid) => b.addRemoteCandidate(cand, mid));
    b.onLocalCandidate((cand, mid) => a.addRemoteCandidate(cand, mid));

    // The two open events race — resolve once BOTH ends are up.
    const timer = setTimeout(() => reject(new Error("rtc loopback timed out")), 10_000);
    let aChan: DataChannel | null = null;
    let bChan: DataChannel | null = null;
    const maybeDone = () => {
      if (aChan && bChan) {
        clearTimeout(timer);
        resolve([aChan, bChan]);
      }
    };
    b.onDataChannel((chan) => {
      bChan = chan;
      maybeDone();
    });
    const chan = a.createDataChannel("tunnel");
    chan.onOpen(() => {
      aChan = chan;
      maybeDone();
    });
  });
}

describe("node-datachannel adapter", () => {
  test("http + fragmented ws echo over a real data channel", async () => {
    const [clientChan, hostChan] = await rtcLoopbackPair();
    new TunnelHost(nodeDataChannelTransport(hostChan), { port: server.port! });
    const client = new TunnelClient(nodeDataChannelTransport(clientChan));

    const res = await client.fetch("GET", "/hello", {});
    expect(await res.text()).toBe("ok:/hello");

    const big = new Uint8Array(await (await client.fetch("GET", "/big", {})).arrayBuffer());
    expect(big.byteLength).toBe(MAX_CHUNK * 2 + 7);
    expect(big[MAX_CHUNK * 2]).toBe(((MAX_CHUNK * 2) * 11) & 0xff);

    // WS echo with a message that spans WsCont frames both ways.
    const payload = new Uint8Array(MAX_CHUNK + 100).map((_, i) => (i * 5) & 0xff);
    const echoed = await new Promise<Uint8Array>((resolve, reject) => {
      const handle = client.openWs("/ws", undefined, {
        onOpenAck: (ok) => {
          if (!ok) reject(new Error("ws open failed"));
          else handle.sendBin(payload);
        },
        onText: () => {},
        onBin: resolve,
        onClose: (code, reason) => reject(new Error(`ws closed ${code} ${reason}`)),
      });
    });
    expect(Buffer.from(echoed)).toEqual(Buffer.from(payload));
  }, 20_000);
});
