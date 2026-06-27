/**
 * Live git-status watching for provisioned worktrees — the part of the
 * provisioning standard that needs the native `@parcel/watcher`.
 *
 * Split out from `codehost/provision` so consumers that only clone/fetch/pull
 * (e.g. an agent spawner) never load the native watcher addon. Import this
 * module (`codehost/provision/watch`) only when you want a live status feed.
 */

import watcher from "@parcel/watcher";
import { folderFor, readStatus, type GitStatus, type RepoSpec } from "./index";

/**
 * A watch notification. `activity` is true for every (debounced) filesystem
 * burst — the signal the UI uses to show a "working" spinner. `status` is
 * present only when the git status actually changed since the last burst (or
 * for the snapshot handed to a brand-new subscriber), so the wire stays quiet
 * when nothing meaningful moved.
 */
export type StatusEvent = { activity: boolean; status?: GitStatus };

/**
 * One shared native watcher per worktree, fanned out to many subscribers.
 * Recursive watch over a large tree (and the `git status` it triggers) is
 * expensive, so N browser tabs on the same repo must NOT each spin one up —
 * that starves the single-threaded dev server. We keep a per-folder registry:
 * the first subscriber creates the watcher, the last to leave tears it down,
 * and every change recomputes status once and broadcasts it.
 */
type WatchEntry = {
  subscribers: Set<(e: StatusEvent) => void>;
  last?: GitStatus;
  teardown: () => Promise<void>;
};
const watches = new Map<string, WatchEntry>();

/**
 * Subscribe to live git status for `spec`'s worktree. `onChange` fires with a
 * fresh `GitStatus` whenever the working tree or index may have changed (and
 * immediately with the last-known status, if any). Native recursive watch via
 * @parcel/watcher (FSEvents / inotify / ReadDirectoryChangesW); node_modules
 * and `.git/objects` churn are ignored, but `.git/index` & `.git/HEAD` are
 * watched so stage/commit/checkout transitions are caught; bursts are
 * debounced before the (fast) `git status`. Returns an unsubscribe fn; the
 * underlying watcher is shared and only torn down when the last subscriber
 * leaves. Best-effort: errors are swallowed.
 */
export async function watchStatus(
  spec: RepoSpec,
  onChange: (e: StatusEvent) => void,
  wsRoot?: string,
): Promise<() => Promise<void>> {
  const folder = folderFor(spec, wsRoot);
  let entry = watches.get(folder);

  if (!entry) {
    // Register synchronously (before the async subscribe) so a second
    // concurrent caller joins this entry instead of creating a rival watcher.
    const subscribers = new Set<(e: StatusEvent) => void>();
    entry = { subscribers, teardown: async () => {} };
    watches.set(folder, entry);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastKey = "";
    let pendingWorkingTree = false; // did a non-.git file change this burst?
    const schedule = (workingTree: boolean) => {
      if (workingTree) pendingWorkingTree = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const activity = pendingWorkingTree;
        pendingWorkingTree = false;
        try {
          const status = await readStatus(folder);
          const key = JSON.stringify(status);
          const changed = key !== lastKey;
          if (changed) {
            lastKey = key;
            entry!.last = status;
          }
          // `activity` (the spinner) fires only on real working-tree edits, not
          // on .git churn — VS Code has this folder open and pokes .git
          // constantly (git polling), which would otherwise spin the title
          // forever. Flags still update on .git changes too (commit, pull).
          // Stay silent when neither the working tree nor the status moved.
          if (!activity && !changed) return;
          for (const cb of subscribers)
            cb({ activity, status: changed ? status : undefined });
        } catch {
          // worktree vanished mid-watch, or a transient git lock — ignore
        }
      }, 300);
    };
    try {
      const sub = await watcher.subscribe(
        folder,
        (err, events) => {
          if (err) return;
          // A change outside .git is a real edit (spins the title); .git-only
          // bursts still recompute status but don't spin.
          const workingTree = events.some(
            (e) => !/[\\/]\.git[\\/]/.test(e.path),
          );
          schedule(workingTree);
        },
        {
          ignore: [
            "**/node_modules/**",
            "**/.git/objects/**",
            "**/.git/lfs/**",
          ],
        },
      );
      entry.teardown = async () => {
        if (timer) clearTimeout(timer);
        await sub.unsubscribe();
      };
    } catch {
      // watcher unavailable — drop the entry so a later call can retry
      watches.delete(folder);
      throw new Error("watch unavailable");
    }
  }

  entry.subscribers.add(onChange);
  // Hand the newcomer current state at once (no `activity` → no spurious spin).
  if (entry.last) onChange({ activity: false, status: entry.last });

  return async () => {
    const e = watches.get(folder);
    if (!e) return;
    e.subscribers.delete(onChange);
    if (e.subscribers.size === 0) {
      watches.delete(folder);
      await e.teardown();
    }
  };
}
