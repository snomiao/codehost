import { resolve } from "node:path";
import type { CommandModule } from "yargs";
import { scaffoldCodehost } from "../init";

interface InitArgs {
  dir: string;
  force: boolean;
}

export const initCommand: CommandModule<{}, InitArgs> = {
  command: "init [dir]",
  describe: "Scaffold .codehost/ (config.yaml + setup.sh) so repo links auto-provision",
  builder: (y) =>
    y
      .positional("dir", { describe: "Home dir to scaffold (defaults to cwd)", type: "string", default: "." })
      .option("force", { alias: "f", describe: "Overwrite existing files", type: "boolean", default: false }) as any,
  handler: (argv) => {
    const dir = resolve(process.cwd(), argv.dir);
    const written = scaffoldCodehost(dir, argv.force);
    if (written.length === 0) {
      console.log(`[codehost] .codehost/ already set up in ${dir} (use --force to overwrite)`);
      return;
    }
    console.log(`[codehost] scaffolded:\n${written.map((p) => `  ${p}`).join("\n")}`);
    console.log(`[codehost] edit .codehost/setup.sh, then run: codehost serve ${dir}`);
  },
};
