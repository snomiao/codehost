import type { CommandModule } from "yargs";
import { runSupervisor } from "../fallback-daemon";

interface SuperviseArgs {
  name: string;
}

// Hidden internal command: the supervisor process behind a fallback daemon (see
// fallback-daemon.ts). Not meant to be run by hand — `serve -d` / `setup` launch
// it (detached child on POSIX, scheduled task on Windows) when oxmgr isn't
// available. It reads its serve argv from the registry by name.
export const superviseCommand: CommandModule<{}, SuperviseArgs> = {
  command: "__supervise",
  describe: false, // hidden from help
  builder: (y) => y.option("name", { type: "string", demandOption: true }) as any,
  handler: async (a) => {
    const code = await runSupervisor(a.name);
    process.exit(code);
  },
};
