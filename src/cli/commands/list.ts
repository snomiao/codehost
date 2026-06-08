import type { CommandModule } from "yargs";
import { hasOxmgr, listDaemons } from "../oxmgr";
import { listFallbackDaemons } from "../fallback-daemon";

export const listCommand: CommandModule = {
  command: "list",
  aliases: ["ls"],
  describe: "List codehost servers (oxmgr-managed and detached)",
  handler: async () => {
    const detached = listFallbackDaemons();
    if (detached.length) {
      console.log("Detached daemons (no oxmgr):");
      for (const d of detached) {
        console.log(`  ${d.name}  pid ${d.pid}  ${d.cwd}  (log: ${d.log})`);
      }
      console.log("");
    }
    // Only hit oxmgr if it's actually runnable — `hasOxmgr` doesn't self-heal,
    // so a broken install won't re-download its binary on every `list`.
    if (await hasOxmgr()) {
      const shown = await listDaemons();
      // listDaemons returns the count of codehost daemons (>=0) or -1 if oxmgr
      // is unusable; only the latter is an error exit. It prints its own
      // "No codehost daemons running." message when the count is 0.
      process.exit(shown < 0 ? 1 : 0);
    }
    if (!detached.length) console.log("No codehost daemons running.");
    process.exit(0);
  },
};
