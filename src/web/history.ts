// Persists which rooms you've joined and which repo opened where, so a deep
// link (/gh/<owner>/<repo>/...) can resolve to the right room + server without
// re-entering a token. Keyed by repoKey ("gh/owner/repo").

const ROOMS_KEY = "codehost.rooms";
const HISTORY_KEY = "codehost.history";

export interface HistoryEntry {
  token: string;
  /** Stable machine id of the server that opened it — unlike a peerId it
   *  survives daemon restarts, so reconnect prefers the same machine. */
  hostId?: string;
  kind?: "repo" | "root";
  /** For root-kind opens, the ?folder= path used. */
  folder?: string;
  name?: string;
  /** Hostname — display + match fallback for pre-hostId daemons/entries. */
  host?: string;
  lastConnected: number;
}

function read<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, val: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    // quota / private mode — non-fatal
  }
}

export function getRooms(): string[] {
  return read<string[]>(ROOMS_KEY, []);
}

export function addRoom(token: string): void {
  if (!token) return;
  const rooms = getRooms();
  if (!rooms.includes(token)) write(ROOMS_KEY, [...rooms, token]);
}

/** Replace the persisted joined-room set (deduped, empties dropped). */
export function setRooms(tokens: string[]): void {
  write(ROOMS_KEY, [...new Set(tokens.filter(Boolean))]);
}

export function getHistory(): Record<string, HistoryEntry> {
  return read<Record<string, HistoryEntry>>(HISTORY_KEY, {});
}

export function historyFor(repoKey: string): HistoryEntry | undefined {
  return getHistory()[repoKey];
}

export function recordConnection(repoKey: string, entry: HistoryEntry): void {
  const all = getHistory();
  all[repoKey] = entry;
  write(HISTORY_KEY, all);
}
