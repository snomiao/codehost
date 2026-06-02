/**
 * PTY session manager for the web terminal.
 *
 * Each session wraps a bun-pty shell process with a 1MB replay buffer.
 * Sessions persist across WebSocket disconnects so reconnecting clients
 * get the full output history.
 *
 * Adapted from snomiao/sno-codehost terminal-ws-lib.ts.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";

const MAX_BUFFER_BYTES = 1024 * 1024; // 1 MB replay buffer
const MIN_COLS = 10;
const MIN_ROWS = 2;

// OSC 7: shell reports CWD after each prompt
const OSC7_RE = /\x1b\]7;file:\/\/[^/]*(\/.+?)(?:\x07|\x1b\\)/;
const OSC7_MARKER = 0x1b;
const textDecoder = new TextDecoder();

function extractOsc7Cwd(data: Uint8Array): string | null {
  if (!data.includes(OSC7_MARKER)) return null;
  const text = textDecoder.decode(data);
  if (!text.includes("\x1b]7;")) return null;
  const m = text.match(OSC7_RE);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

// Set up a temp ZDOTDIR that emits OSC 7 on every zsh prompt
const ZDOTDIR = join(tmpdir(), "codehost-term-zshrc");
mkdirSync(ZDOTDIR, { recursive: true });
writeFileSync(join(ZDOTDIR, ".zshenv"), `[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"\n`);
writeFileSync(join(ZDOTDIR, ".zprofile"), `[[ -f "$HOME/.zprofile" ]] && source "$HOME/.zprofile"\n`);
writeFileSync(
  join(ZDOTDIR, ".zshrc"),
  `[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"
_codehost_report_cwd() { printf '\\033]7;file://%s%s\\007' "\${HOST:-localhost}" "$PWD"; }
precmd_functions+=(_codehost_report_cwd)
`,
);

interface PtyHandle {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: Uint8Array) => void): void;
  onExit(cb: () => void): void;
}

function spawnPty(cmd: string, cols: number, rows: number, cwd: string): PtyHandle {
  const { spawn: ptySpawn } = require("bun-pty");
  const pty = ptySpawn(cmd, [], {
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      ZDOTDIR,
      PROMPT_COMMAND: `printf '\\033]7;file://%s%s\\007' "$HOSTNAME" "$PWD"${process.env.PROMPT_COMMAND ? `; ${process.env.PROMPT_COMMAND}` : ""}`,
    },
  });
  return {
    write(data) {
      pty.write(typeof data === "string" ? data : textDecoder.decode(data));
    },
    resize(c, r) {
      pty.resize(c, r);
    },
    kill() {
      pty.kill();
    },
    onData(cb) {
      pty.onData((str: string) => cb(new TextEncoder().encode(str)));
    },
    onExit(cb) {
      pty.onExit(cb);
    },
  };
}

export interface Session {
  pty: PtyHandle;
  buffer: Uint8Array[];
  bufferBytes: number;
  clients: Set<ServerWebSocket<WsData>>;
  cols: number;
  rows: number;
  cwd: string;
  exited: boolean;
  startedAt: number;
  lastActivity: number;
}

export type WsData = { sessionKey: string };

const sessions = new Map<string, Session>();

const resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function bufferPush(session: Session, chunk: Uint8Array) {
  session.buffer.push(chunk);
  session.bufferBytes += chunk.length;
  while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length > 1) {
    session.bufferBytes -= session.buffer.shift()!.length;
  }
}

function debouncedResize(sessionKey: string) {
  clearTimeout(resizeTimers.get(sessionKey));
  resizeTimers.set(
    sessionKey,
    setTimeout(() => {
      const s = sessions.get(sessionKey);
      if (!s || s.clients.size === 0) return;
      s.pty.resize(s.cols, s.rows);
    }, 50),
  );
}

export function getOrCreateSession(sessionKey: string, cwd: string, cols: number, rows: number): Session {
  let session = sessions.get(sessionKey);
  if (session && session.exited) {
    session.pty.kill();
    sessions.delete(sessionKey);
    session = undefined;
  }
  if (session) return session;

  const shell = process.env.SHELL ?? "bash";
  const pty = spawnPty(shell, Math.max(MIN_COLS, cols), Math.max(MIN_ROWS, rows), cwd);
  const s: Session = {
    pty,
    buffer: [],
    bufferBytes: 0,
    clients: new Set(),
    cols: Math.max(MIN_COLS, cols),
    rows: Math.max(MIN_ROWS, rows),
    cwd,
    exited: false,
    startedAt: Date.now(),
    lastActivity: Date.now(),
  };

  pty.onData((data) => {
    s.lastActivity = Date.now();

    // Answer terminal queries so the PTY never blocks waiting for xterm.js
    const text = textDecoder.decode(data);
    if (text.includes("\x1b[c") || text.includes("\x1b[0c")) pty.write("\x1b[?1;2c");
    if (text.includes("\x1b[6n")) pty.write("\x1b[1;1R");

    bufferPush(s, data);

    const newCwd = extractOsc7Cwd(data);
    const cwdMsg =
      newCwd && newCwd !== s.cwd ? JSON.stringify({ type: "cwd", path: newCwd }) : null;
    if (cwdMsg) s.cwd = newCwd!;

    for (const client of s.clients) {
      client.send(data);
      if (cwdMsg) client.send(cwdMsg);
    }
  });

  pty.onExit(() => {
    s.exited = true;
    const msg = new TextEncoder().encode("\r\n\x1b[33m[session ended]\x1b[0m\r\n");
    bufferPush(s, msg);
    for (const client of s.clients) client.send(msg);
  });

  sessions.set(sessionKey, s);
  return s;
}

export function sessionKeyForCwd(cwd: string): string {
  return "s_" + createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

export function validateCwd(raw: string | null): string {
  if (!raw) throw new Error("cwd is required");
  const resolved = raw.replace(/\\/g, "/");
  const isAbsolute = resolved.startsWith("/") || /^[A-Za-z]:\//.test(resolved);
  if (!isAbsolute || resolved.includes("/../")) throw new Error(`invalid cwd: ${raw}`);
  if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true });
  return resolved;
}

export function handleWsOpen(ws: ServerWebSocket<WsData>) {
  const sessionKey = ws.data.sessionKey;
  const session = sessions.get(sessionKey);
  if (!session) return;
  session.clients.add(ws);
  for (const chunk of session.buffer) ws.send(chunk);
  if (!session.exited) debouncedResize(sessionKey);
}

export function handleWsMessage(ws: ServerWebSocket<WsData>, message: string | Buffer) {
  const session = sessions.get(ws.data.sessionKey);
  if (!session || session.exited) return;

  if (typeof message === "string") {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === "resize" && parsed.cols && parsed.rows) {
        session.cols = Math.max(MIN_COLS, parsed.cols);
        session.rows = Math.max(MIN_ROWS, parsed.rows);
        debouncedResize(ws.data.sessionKey);
        return;
      }
      if (parsed.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", t: parsed.t ?? Date.now() }));
        return;
      }
    } catch {
      // not JSON — treat as raw stdin
    }
    session.pty.write(message);
  } else {
    session.pty.write(new Uint8Array(message));
  }
}

export function handleWsClose(ws: ServerWebSocket<WsData>) {
  const session = sessions.get(ws.data.sessionKey);
  if (!session) return;
  session.clients.delete(ws);
}

export function listSessions() {
  return Array.from(sessions.entries()).map(([key, s]) => ({
    key,
    cwd: s.cwd,
    cols: s.cols,
    rows: s.rows,
    clients: s.clients.size,
    bufferBytes: s.bufferBytes,
    startedAt: s.startedAt,
    lastActivity: s.lastActivity,
    exited: s.exited,
  }));
}
