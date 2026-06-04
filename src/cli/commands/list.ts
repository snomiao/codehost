import type { CommandModule } from "yargs";
import { listDaemons } from "../oxmgr";

export const listCommand: CommandModule = {
  command: "list",
  aliases: ["ls"],
  describe: "List codehost servers running under oxmgr",
  handler: async () => {
    process.exit(await listDaemons());
  },
};
