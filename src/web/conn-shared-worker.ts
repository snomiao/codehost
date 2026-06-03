// SharedWorker: coordinates a single WebRTC connection per server (peerId)
// across every codehost.dev tab of this origin. It owns no media itself
// (RTCPeerConnection is Window-only) — it just elects one tab as the "owner"
// that holds the data channel, and relays tunnel RPCs between the other tabs
// and that owner, with failover when the owner tab goes away.
//
// This file is intentionally DOM-free (only MessagePort/MessageEvent) so it
// type-checks under the app's DOM tsconfig and bundles as a module worker.

interface Tab {
  id: number;
  port: MessagePort;
  alive: number; // last heartbeat (ms, from the tab's clock; only compared loosely)
}

type Msg = Record<string, unknown> & { t: string };

const tabs = new Map<number, Tab>();
const owners = new Map<string, number>(); // peerId -> owner tabId
const subs = new Map<string, Set<number>>(); // peerId -> interested tabIds
const ready = new Set<string>(); // peerIds whose owner has an open channel
let nextId = 1;

// SharedWorkerGlobalScope isn't in the DOM lib; reach the connect hook via any.
(self as unknown as { onconnect: (e: MessageEvent) => void }).onconnect = (e) => {
  const port = e.ports[0];
  const tab: Tab = { id: nextId++, port, alive: Date.now() };
  tabs.set(tab.id, tab);
  port.onmessage = (ev: MessageEvent) => onMessage(tab, ev.data as Msg);
  port.start?.();
  send(tab, { t: "welcome", tabId: tab.id });
};

function send(tab: Tab | undefined, msg: Msg): void {
  tab?.port.postMessage(msg);
}

function onMessage(tab: Tab, msg: Msg): void {
  tab.alive = Date.now();
  switch (msg.t) {
    case "ping":
      return;
    case "bye":
      cleanup(tab.id);
      return;
    case "acquire": {
      const peerId = msg.peerId as string;
      (subs.get(peerId) ?? subs.set(peerId, new Set()).get(peerId)!).add(tab.id);
      if (!owners.has(peerId)) {
        owners.set(peerId, tab.id);
        send(tab, { t: "role", peerId, owner: true });
      } else {
        send(tab, { t: "role", peerId, owner: false, ownerTabId: owners.get(peerId) });
        // If the owner is already up, don't make the latecomer wait for the next
        // broadcast — tell it the connection is ready right now.
        if (ready.has(peerId)) send(tab, { t: "ready", peerId });
      }
      return;
    }
    case "ready": {
      // Owner finished establishing — wake everyone waiting on this peer.
      const peerId = msg.peerId as string;
      ready.add(peerId);
      for (const id of subs.get(peerId) ?? []) {
        if (id !== tab.id) send(tabs.get(id), { t: "ready", peerId });
      }
      return;
    }
    case "release": {
      const peerId = msg.peerId as string;
      subs.get(peerId)?.delete(tab.id);
      if (owners.get(peerId) === tab.id) reassign(peerId, tab.id);
      return;
    }
    case "rpc": {
      // Route a tunnel call to the current owner of this peer.
      const peerId = msg.peerId as string;
      const owner = tabs.get(owners.get(peerId) ?? -1);
      if (!owner) {
        send(tab, { t: "rpc-reply", peerId, callId: msg.callId, payload: { op: "error", message: "no owner" } });
        return;
      }
      send(owner, { t: "rpc", peerId, callId: msg.callId, fromTabId: tab.id, payload: msg.payload });
      return;
    }
    case "rpc-reply": {
      // Owner answering a routed call — deliver to the original requester.
      send(tabs.get(msg.toTabId as number), {
        t: "rpc-reply",
        peerId: msg.peerId,
        callId: msg.callId,
        payload: msg.payload,
      });
      return;
    }
  }
}

function cleanup(tabId: number): void {
  tabs.delete(tabId);
  for (const [peerId, set] of subs) {
    set.delete(tabId);
    if (owners.get(peerId) === tabId) reassign(peerId, tabId);
    if (set.size === 0) {
      subs.delete(peerId);
      owners.delete(peerId);
      ready.delete(peerId);
    }
  }
}

// Promote a remaining subscriber to owner (failover), or drop the peer.
function reassign(peerId: string, goneTabId: number): void {
  owners.delete(peerId);
  ready.delete(peerId); // new owner must re-establish before anyone proxies
  const candidate = [...(subs.get(peerId) ?? [])].find((id) => id !== goneTabId && tabs.has(id));
  if (candidate == null) return;
  owners.set(peerId, candidate);
  send(tabs.get(candidate), { t: "promoted", peerId });
  for (const id of subs.get(peerId) ?? []) {
    if (id !== candidate) send(tabs.get(id), { t: "owner-gone", peerId });
  }
}

// Evict tabs that stopped heart-beating (covers crashes / killed tabs where no
// `bye` arrived). Heartbeats land ~every 4s; allow generous slack.
setInterval(() => {
  const now = Date.now();
  for (const [id, tab] of tabs) {
    if (now - tab.alive > 15_000) cleanup(id);
  }
}, 5_000);
