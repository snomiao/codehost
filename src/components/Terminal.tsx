/**
 * xterm.js terminal wired to the PTY WebSocket at /ws.
 *
 * Features:
 * - VS Code Dark/Light Modern themes with system auto-switch
 * - OSC 7 CWD tracking → onCwdChange callback
 * - OSC 11 background color query response
 * - CJK double-width (Unicode11Addon)
 * - Clickable URLs with wrapped-URL reconstruction
 * - Auto-copy on selection; Cmd/Ctrl+C copies when text is selected
 * - ResizeObserver for responsive fit
 * - Auto-reconnect on unexpected disconnect (2 s)
 * - Heartbeat ping/pong every 10 s to detect zombie sockets
 */
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { CSSProperties, useEffect, useRef, useState } from "react";

const lightTheme = {
  background: "#ffffff",
  foreground: "#3b3b3b",
  cursor: "#005fb8",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  black: "#000000",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

const darkTheme = {
  background: "#1f1f1f",
  foreground: "#cccccc",
  cursor: "#aeafad",
  cursorAccent: "#1f1f1f",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

function hexToOscRgb(hex: string): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
const getTheme = () => (prefersDark.matches ? darkTheme : lightTheme);

interface TerminalProps {
  wsUrl: string;
  cwd?: string;
  session?: string;
  onCwdChange?: (cwd: string) => void;
  initialCmd?: string;
  style?: CSSProperties;
}

export function Terminal({ wsUrl, cwd, session, onCwdChange, initialCmd, style }: TerminalProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onCwdRef = useRef(onCwdChange);
  onCwdRef.current = onCwdChange;

  const [wsStatus, setWsStatus] = useState<"connecting" | "connected" | "reconnecting" | "ended">(
    "connecting",
  );

  useEffect(() => {
    if (!containerRef.current) return;
    if (wsUrl === "/ws" && !cwd && !session) return;
    let disposed = false;

    const init = async () => {
      if (disposed) return;

      const term = new XTerm({
        cursorBlink: true,
        fontSize: 14,
        lineHeight: 1.2,
        allowProposedApi: true,
        rightClickSelectsWord: true,
        scrollback: 10000,
        fontFamily:
          "'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Consolas', 'Menlo', 'Monaco', 'Courier New', monospace",
        theme: getTheme(),
        linkHandler: {
          activate(_event, text) {
            window.open(text, "_blank", "noopener");
          },
        },
      });

      const fitAddon = new FitAddon();
      const unicode11 = new Unicode11Addon();
      const webLinks = new WebLinksAddon(((_e: MouseEvent, uri: string, range: { start: { y: number } }) => {
        let fullUrl = uri;
        try {
          const buf = term.buffer.active;
          const startRow = range.start.y + buf.viewportY;
          for (let row = startRow + 1; row < buf.length; row++) {
            const line = buf.getLine(row);
            if (!line?.isWrapped) break;
            fullUrl += line.translateToString(true);
          }
          fullUrl = fullUrl.replace(/[\s\x00-\x1f]+$/, "");
        } catch { /* fallback */ }
        window.open(fullUrl, "_blank", "noopener");
      }) as never);
      const searchAddon = new SearchAddon();
      const clipboardAddon = new ClipboardAddon();

      term.loadAddon(fitAddon);
      term.loadAddon(unicode11);
      term.loadAddon(webLinks);
      term.loadAddon(searchAddon);
      term.loadAddon(clipboardAddon);
      term.unicode.activeVersion = "11";
      term.open(containerRef.current!);

      // Auto-switch theme on system preference change
      const onThemeChange = () => {
        term.options.theme = getTheme();
        if (wrapperRef.current) wrapperRef.current.style.backgroundColor = getTheme().background;
        wsRef.current?.send(`\x1b[?997;${prefersDark.matches ? "1" : "2"}h`);
      };
      prefersDark.addEventListener("change", onThemeChange);

      // OSC 11: respond to background color query
      term.parser.registerOscHandler(11, (data) => {
        if (data === "?") {
          const reply = `\x1b]11;${hexToOscRgb(getTheme().background)}\x1b\\`;
          wsRef.current?.send(reply);
        }
        return true;
      });

      // Auto-copy on selection
      term.onSelectionChange(() => {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
      });

      // Ctrl/Cmd+C copies selection; otherwise sends SIGINT
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && e.key === "c" && term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection()).catch(() => {});
          term.clearSelection();
          return false;
        }
        return true;
      });

      // Fit
      let fitRaf = 0;
      const debouncedFit = () => {
        cancelAnimationFrame(fitRaf);
        fitRaf = requestAnimationFrame(() => {
          if (disposed) return;
          const buf = term.buffer.active;
          const wasAtBottom = buf.baseY + term.rows >= buf.length;
          fitAddon.fit();
          if (wasAtBottom) term.scrollToBottom();
        });
      };

      await document.fonts.ready;
      let stableCount = 0, lastH = 0;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        if (disposed) { term.dispose(); return; }
        const { clientHeight } = containerRef.current ?? {};
        if (clientHeight && clientHeight === lastH) { if (++stableCount >= 3) break; }
        else { stableCount = 0; lastH = clientHeight ?? 0; }
      }
      if (disposed) { term.dispose(); return; }
      fitAddon.fit();
      setTimeout(() => { if (!disposed) fitAddon.fit(); }, 300);
      setTimeout(() => { if (!disposed) fitAddon.fit(); }, 800);

      // WebSocket connection
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const base =
        wsUrl.startsWith("ws://") || wsUrl.startsWith("wss://")
          ? wsUrl
          : `${protocol}//${window.location.host}${wsUrl}`;
      const params = new URLSearchParams({
        cols: String(term.cols),
        rows: String(term.rows),
        ...(cwd && { cwd }),
        ...(session && { session }),
      });
      const absUrl = `${base}?${params}`;

      let ws: WebSocket | null = null;
      const setWs = (w: WebSocket | null) => { ws = w; wsRef.current = w; };

      term.onData((data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(data); });
      term.onResize(({ cols, rows }) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
      });

      let heartbeatInterval: number | undefined;
      let pongTimer: number | undefined;
      const stopHeartbeat = () => {
        clearInterval(heartbeatInterval);
        clearTimeout(pongTimer);
        heartbeatInterval = pongTimer = undefined;
      };
      const startHeartbeat = () => {
        stopHeartbeat();
        heartbeatInterval = window.setInterval(() => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
          pongTimer = window.setTimeout(() => { try { ws?.close(); } catch { /* */ } }, 8000);
        }, 10000);
      };

      const connect = () => {
        if (disposed) return;
        setWs(new WebSocket(absUrl));
        ws!.binaryType = "arraybuffer";

        ws!.onopen = () => {
          setWsStatus("connected");
          debouncedFit();
          ws!.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          if (initialCmd) ws!.send(initialCmd + "\n");
          startHeartbeat();
        };

        ws!.onmessage = (e) => {
          if (typeof e.data === "string") {
            try {
              const msg = JSON.parse(e.data);
              if (msg.type === "pong") { if (pongTimer) { clearTimeout(pongTimer); pongTimer = undefined; } return; }
              if (msg.type === "cwd" && msg.path) { onCwdRef.current?.(msg.path); return; }
            } catch { /* not a control message */ }
            term.write(e.data);
          } else {
            term.write(e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data);
          }
        };

        ws!.onclose = (ev) => {
          stopHeartbeat();
          if (disposed) return;
          if (ev.code === 1000 || ev.code === 1008) { setWsStatus("ended"); return; }
          setWsStatus("reconnecting");
          setTimeout(connect, 2000);
        };

        ws!.onerror = () => setWsStatus("reconnecting");
      };

      connect();

      const observer = new ResizeObserver(debouncedFit);
      if (wrapperRef.current) observer.observe(wrapperRef.current);

      if (wrapperRef.current) wrapperRef.current.style.backgroundColor = getTheme().background;

      return () => {
        disposed = true;
        stopHeartbeat();
        cancelAnimationFrame(fitRaf);
        observer.disconnect();
        prefersDark.removeEventListener("change", onThemeChange);
        ws?.close();
        setWs(null);
        term.dispose();
      };
    };

    let cleanup: (() => void) | undefined;
    init().then((fn) => { cleanup = fn; });
    return () => { disposed = true; cleanup?.(); };
  }, [wsUrl, cwd, session]);

  return (
    <div
      ref={wrapperRef}
      style={{ position: "relative", overflow: "hidden", ...style }}
    >
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} onContextMenu={(e) => e.preventDefault()} />
      {wsStatus !== "connected" && (
        <div
          style={{
            position: "absolute", top: 8, right: 12, padding: "4px 10px",
            fontSize: 12, fontFamily: "monospace", borderRadius: 4, pointerEvents: "none", zIndex: 10,
            background: wsStatus === "reconnecting" ? "#b58900" : wsStatus === "ended" ? "#586e75" : "#268bd2",
            color: "#fff",
          }}
        >
          {wsStatus === "reconnecting" ? "reconnecting…" : wsStatus === "ended" ? "session ended" : "connecting…"}
        </div>
      )}
    </div>
  );
}
