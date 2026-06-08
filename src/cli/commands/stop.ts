import type { CommandModule } from "yargs";
import { daemonName, stopDaemon } from "../oxmgr";
import { stopFallbackDaemon } from "../fallback-daemon";

interface StopArgs {
  name: string;
}

export const stopCommand: CommandModule<{}, StopArgs> = {
  command: "stop <name>",
  describe: "Stop a daemonized codehost server (name from `codehost list`)",
  builder: (y) =>
    y.positional("name", {
      describe: "Daemon name, e.g. codehost-myproject (or just the label)",
      type: "string",
      demandOption: true,
    }) as any,
  handler: async (argv) => {
    // Detached daemons are tracked locally; check those first so we don't poke
    // (and possibly re-download) oxmgr when it isn't even managing this one.
    const full = argv.name.startsWith("codehost-") ? argv.name : daemonName(argv.name);
    if (stopFallbackDaemon(full) || stopFallbackDaemon(argv.name)) {
      console.log(`[codehost] stopped ${full}`);
      process.exit(0);
    }
    process.exit(await stopDaemon(argv.name));
  },
};
