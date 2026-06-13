import { createInterface, type Interface } from "node:readline";

/**
 * Host-side admission policy for clients (connecting browsers — each gets a full
 * VS Code session, so this is a real gate, not just UX).
 *  - "auto":    admit everyone with the token (default; the token is the gate).
 *  - "confirm": hold each new client until the host approves it at the terminal,
 *               unless its label matches a pre-approved `--allow` pattern.
 */
export type ApprovePolicy = "auto" | "confirm";

export interface ApproverOptions {
  policy: ApprovePolicy;
  /** Case-insensitive label substrings auto-approved even under "confirm". */
  allow: string[];
  /** Tear down a live client's connection (kick). */
  kick: (clientId: string) => void;
  /** Emit a "pending approval" hint to a client that's now waiting on a human. */
  notifyPending: (clientId: string) => void;
  /** Whether stdin is an interactive terminal (defaults to process.stdin.isTTY). */
  isTTY?: boolean;
  /** Injected input/output for tests; default to the real process streams. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (msg: string) => void;
}

interface Pending {
  clientId: string;
  label: string;
  resolve: (ok: boolean) => void;
}

/**
 * Decides whether to admit clients and drives an interactive terminal console
 * for approve / deny / kick / list. Self-contained (no WebRTC deps) so the
 * daemon stays thin and this stays unit-testable.
 */
export class Approver {
  private opts: ApproverOptions;
  private isTTY: boolean;
  private out: NodeJS.WritableStream;
  private log: (msg: string) => void;

  /** Labels approved with "a(lways)" this session — auto-admit on sight. */
  private sessionAllow = new Set<string>();
  /** Live clients (admitted + connected), for `list` / `kick`. */
  private active = new Map<string, string>();
  /** Approvals waiting on the host; the head is the one being asked. */
  private queue: Pending[] = [];
  private asking = false;
  private rl: Interface | null = null;

  constructor(opts: ApproverOptions) {
    this.opts = opts;
    this.isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
    this.out = opts.output ?? process.stdout;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  /** Announce the active policy once at startup. */
  banner(): void {
    if (this.opts.policy === "auto") return;
    if (this.isTTY) {
      this.log("[codehost] approval: confirm — new clients wait for your OK. Commands: list · kick <n>");
    } else {
      this.log(
        "[codehost] approval: confirm, but no terminal is attached — clients can't be approved " +
          "interactively and will be denied. Use --approve auto or --allow <label> for a daemon.",
      );
    }
    if (this.opts.allow.length) this.log(`[codehost] auto-approving labels matching: ${this.opts.allow.join(", ")}`);
  }

  /** Resolve true to admit `clientId`, false to deny. Called once per offer. */
  admit(clientId: string, label: string): Promise<boolean> {
    if (this.opts.policy === "auto" || this.preApproved(label)) return Promise.resolve(true);

    // Confirm mode but no terminal to ask at: deny safely.
    if (!this.isTTY) {
      this.log(`[codehost] denied "${label}" (${short(clientId)}): confirm mode needs a terminal`);
      return Promise.resolve(false);
    }

    this.opts.notifyPending(clientId);
    return new Promise<boolean>((resolve) => {
      this.queue.push({ clientId, label, resolve });
      this.pumpQueue();
    });
  }

  /** Mark a client live once its tunnel is bridged (for the console roster). */
  onConnected(clientId: string, label: string): void {
    this.active.set(clientId, label);
  }

  /** Drop a client from the roster and resolve any in-flight approval as denied. */
  onDisconnected(clientId: string): void {
    this.active.delete(clientId);
    const idx = this.queue.findIndex((p) => p.clientId === clientId);
    if (idx >= 0) {
      const [p] = this.queue.splice(idx, 1);
      p.resolve(false);
    }
  }

  private preApproved(label: string): boolean {
    if (this.sessionAllow.has(label)) return true;
    const l = label.toLowerCase();
    return this.opts.allow.some((p) => p && l.includes(p.toLowerCase()));
  }

  // ---- interactive console ----

  /** Start the readline console (no-op unless confirm + TTY). */
  start(): void {
    if (this.opts.policy !== "confirm" || !this.isTTY || this.rl) return;
    this.rl = createInterface({ input: this.opts.input ?? process.stdin, output: this.out });
    this.rl.on("line", (line) => this.onLine(line.trim()));
  }

  stop(): void {
    this.rl?.close();
    this.rl = null;
  }

  private pumpQueue(): void {
    if (this.asking || this.queue.length === 0) return;
    this.asking = true;
    const { label, clientId } = this.queue[0];
    this.out.write(`\n[codehost] "${label}" (${short(clientId)}) wants to connect. Approve? [y/N/a=always] `);
  }

  private onLine(line: string): void {
    if (this.asking) {
      this.answer(line);
      return;
    }
    this.command(line);
  }

  private answer(line: string): void {
    const pending = this.queue.shift();
    this.asking = false;
    if (!pending) return;
    const a = line.toLowerCase();
    const always = a === "a" || a === "always";
    const yes = always || a === "y" || a === "yes";
    if (always) this.sessionAllow.add(pending.label);
    this.log(`[codehost] ${yes ? "approved" : "denied"} "${pending.label}" (${short(pending.clientId)})`);
    pending.resolve(yes);
    this.pumpQueue();
  }

  private command(line: string): void {
    if (!line) return;
    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "l":
      case "ls":
      case "list":
        this.printList();
        break;
      case "k":
      case "kick":
        this.doKick(arg);
        break;
      case "h":
      case "help":
      case "?":
        this.log("[codehost] commands: list · kick <n|id> · help");
        break;
      default:
        this.log(`[codehost] unknown command "${cmd}" — try: list · kick <n|id>`);
    }
  }

  private printList(): void {
    const entries = [...this.active.entries()];
    if (entries.length === 0) {
      this.log("[codehost] no clients connected");
      return;
    }
    this.log("[codehost] connected clients:");
    entries.forEach(([id, label], i) => this.log(`  ${i + 1}. ${label} (${short(id)})`));
  }

  private doKick(arg: string): void {
    const id = this.resolveClient(arg);
    if (!id) {
      this.log(`[codehost] no connected client matches "${arg}" — see: list`);
      return;
    }
    const label = this.active.get(id) ?? "client";
    this.log(`[codehost] kicking "${label}" (${short(id)})`);
    this.opts.kick(id);
  }

  /** Resolve a `kick` argument: 1-based index from `list`, or a peerId prefix. */
  private resolveClient(arg: string): string | null {
    if (!arg) return null;
    const entries = [...this.active.keys()];
    const n = Number(arg);
    if (Number.isInteger(n) && n >= 1 && n <= entries.length) return entries[n - 1];
    return entries.find((id) => id.startsWith(arg) || short(id) === arg) ?? null;
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}
