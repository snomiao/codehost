import { spawn } from "node:child_process";

/** Public codehost page that brokers the WebRTC handshake. */
export const PAGE_URL = "https://codehost.dev";

/**
 * Build the auto-connect URL for a room token. The token rides in the URL
 * *fragment* (`#t=<token>`) on purpose: the page is a static asset, so the
 * fragment never leaves the browser — it isn't sent to Cloudflare, nor written
 * to access logs or `Referer` headers. The page reads it, fills the token, and
 * auto-connects when a single server is live.
 */
export function connectUrl(token: string, page: string = PAGE_URL): string {
  return `${page}/#t=${encodeURIComponent(token)}`;
}

/** Open `url` in the default browser. Best-effort, cross-platform, detached. */
export function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      // `start` is a cmd builtin; the empty "" is the (ignored) window title so
      // a quoted URL isn't mistaken for one.
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // best-effort; the URL is always printed too.
  }
}

/**
 * Print the connect URL and, in an interactive terminal, open it in the
 * browser. The TTY guard keeps the oxmgr-spawned daemon (which re-runs
 * `serve`/`dev` in the foreground with no TTY) from popping a tab on every
 * restart — it just logs the URL.
 */
export function announceConnect(token: string, page: string = PAGE_URL): void {
  const url = connectUrl(token, page);
  console.log(`[codehost] connect: ${url}`);
  if (process.stdout.isTTY) {
    console.log("[codehost] opening your browser…");
    openBrowser(url);
  }
}
