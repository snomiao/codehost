#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { setupCommand } from "./commands/setup";
import { serveCommand } from "./commands/serve";
import { listCommand } from "./commands/list";
import { stopCommand } from "./commands/stop";
import { updateCommand } from "./commands/update";

yargs(hideBin(process.argv))
  .scriptName("codehost")
  .usage("$0 <command> [options]")
  .command(setupCommand)
  .command(serveCommand)
  .command(listCommand)
  .command(stopCommand)
  .command(updateCommand)
  .demandCommand(1, "Specify a command, e.g. `codehost serve`")
  .strict()
  .help()
  .alias("h", "help")
  .version()
  .parse();
