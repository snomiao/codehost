import type { PeerMeta } from "../../shared/signaling";

// Daemon plugin surface: a plugin contributes (a) fields merged into the
// advertised PeerMeta on every refresh, and (b) an HTTP route mounted under the
// tunnel at /__codehost/<name>/*. codehost stays the transport + registry;
// plugins (agent-yes first) own their domain.

export interface DaemonPlugin {
  /** Identifier; also the tunnel mount: requests to /__codehost/<name>/* land
   *  in `route`. */
  name: string;
  /** Resource contribution, merged into PeerMeta by the daemon's meta builder
   *  (startup + every refresh). Keep it small — it rides room broadcasts. */
  meta?: () => Partial<PeerMeta>;
  /** Serve a tunneled request. `path` is the remainder after the mount, always
   *  starting with "/" and keeping the query string. */
  route?: (path: string, req: { method: string; headers: Headers; body?: Uint8Array }) => Promise<Response>;
}

/** Route a local tunnel request to the owning plugin, or null to fall through. */
export function routePlugins(
  plugins: DaemonPlugin[],
  req: { method: string; path: string; headers: Headers; body?: Uint8Array },
): Promise<Response> | null {
  for (const p of plugins) {
    if (!p.route) continue;
    const mount = `/__codehost/${p.name}`;
    if (req.path === mount || req.path.startsWith(`${mount}/`) || req.path.startsWith(`${mount}?`)) {
      const rest = req.path.slice(mount.length) || "/";
      return p.route(rest.startsWith("/") ? rest : `/${rest}`, req);
    }
  }
  return null;
}

/** Merge every plugin's meta contribution into a base meta. */
export function withPluginMeta(base: PeerMeta, plugins: DaemonPlugin[]): PeerMeta {
  return Object.assign({}, base, ...plugins.map((p) => p.meta?.() ?? {}));
}
