import type { CommandModule } from "yargs";
import { stopDaemon } from "../oxmgr";

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
  handler: (argv) => {
    process.exit(stopDaemon(argv.name));
  },
};
