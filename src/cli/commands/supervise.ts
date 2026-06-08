import type { CommandModule } from "yargs";
import { runSupervisor } from "../fallback-daemon";

interface SuperviseArgs {
  name: string;
  argv: string;
}

// Hidden internal command: the supervisor process behind a detached fallback
// daemon (see fallback-daemon.ts). Not meant to be run by hand — `serve -d` /
// `setup` spawn it when oxmgr isn't available.
export const superviseCommand: CommandModule<{}, SuperviseArgs> = {
  command: "__supervise",
  describe: false, // hidden from help
  builder: (y) =>
    y
      .option("name", { type: "string", demandOption: true })
      .option("argv", { type: "string", demandOption: true, describe: "JSON-encoded serve argv" }) as any,
  handler: async (a) => {
    const argv = JSON.parse(a.argv) as string[];
    const code = await runSupervisor(a.name, argv);
    process.exit(code);
  },
};
