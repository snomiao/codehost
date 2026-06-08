// "Fake-tags": searchable mnemonics derived from a server's advertised meta
// (host, cwd, repo, branch, room). They exist only so a workspace list is easy
// to scan, filter, and remember — they are user-mutable and may collide across
// machines, so the system never addresses anything by them. Canonical identity
// stays in the peerId + room token.
//
// The matcher mirrors `ay ls`: identity-ish fields match exactly, human text
// matches as a substring, and a `key:value` token matches a tag by key.

import type { PeerMeta } from "./signaling";

/**
 * A short, non-secret label for a room token. The token is a bearer secret —
 * it lives only in the URL fragment and is never sent to a server (see
 * `tokenFromHash`) — so it must never be rendered into the DOM. This derives a
 * stable 4-char tag from it (FNV-1a, base36) for display/filtering instead.
 */
export function shortRoomLabel(token: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).slice(0, 4).padStart(4, "0");
}

/** Build the mnemonic tag list for a server from its advertised metadata. */
export function deriveTags(meta: PeerMeta | null, opts: { roomLabel?: string } = {}): string[] {
  const tags: string[] = [];
  if (opts.roomLabel) tags.push(`room:${opts.roomLabel}`);
  if (meta?.host) tags.push(`host:${meta.host}`);
  tags.push(`kind:${meta?.kind ?? "repo"}`);
  if (meta?.repo) tags.push(`repo:${meta.repo}`);
  if (meta?.branch) tags.push(`wt:${meta.branch}`);
  if (meta?.cwd) tags.push(`cwd:${meta.cwd}`);
  return tags;
}

/** The key part of a `key:value` tag (empty string for an unkeyed tag). */
export function tagKey(tag: string): string {
  const i = tag.indexOf(":");
  return i < 0 ? "" : tag.slice(0, i);
}

function tagValue(tag: string): string {
  const i = tag.indexOf(":");
  return i < 0 ? tag : tag.slice(i + 1);
}

export interface Filterable {
  tags: string[];
  name: string;
  /** Optional numeric id (e.g. a pid); matched exactly by a bare-numeric token. */
  pid?: string;
}

/**
 * Match one whitespace-delimited query token against an entry, `ay ls` style:
 *  - `key:value` → some tag with that key whose value contains `value` (substring)
 *  - bare numeric → exact pid
 *  - bare text → substring over the name or any tag (value or key)
 */
export function matchToken(e: Filterable, token: string): boolean {
  const tok = token.toLowerCase();
  if (!tok) return true;
  const ci = tok.indexOf(":");
  if (ci > 0) {
    const k = tok.slice(0, ci);
    const v = tok.slice(ci + 1);
    return e.tags.some(
      (t) => tagKey(t).toLowerCase() === k && (v === "" || tagValue(t).toLowerCase().includes(v)),
    );
  }
  if (/^\d+$/.test(tok)) return e.pid === tok; // identity: exact
  if (e.name.toLowerCase().includes(tok)) return true;
  return e.tags.some((t) => t.toLowerCase().includes(tok)); // text: substring
}

/** Every whitespace-separated token must match (AND), like `ay ls [keyword]`. */
export function matchQuery(e: Filterable, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((t) => matchToken(e, t));
}
