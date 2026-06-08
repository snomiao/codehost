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
      process.exit(await listDaemons());
    }
    if (!detached.length) console.log("No codehost daemons running.");
    process.exit(0);
  },
};
