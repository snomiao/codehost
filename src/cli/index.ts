#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { setupCommand } from "./commands/setup";
import { initCommand } from "./commands/init";
import { serveCommand } from "./commands/serve";
import { devCommand } from "./commands/dev";
import { exposeCommand } from "./commands/expose";
import { openCommand } from "./commands/open";
import { listCommand } from "./commands/list";
import { stopCommand } from "./commands/stop";
import { updateCommand } from "./commands/update";
import { superviseCommand } from "./commands/supervise";

yargs(hideBin(process.argv))
  .scriptName("codehost")
  .usage("$0 <command> [options]")
  .command(setupCommand)
  .command(initCommand)
  .command(serveCommand)
  .command(devCommand)
  .command(exposeCommand)
  .command(openCommand)
  .command(listCommand)
  .command(stopCommand)
  .command(updateCommand)
  .command(superviseCommand)
  .demandCommand(1, "Specify a command, e.g. `codehost serve`")
  .strict()
  .help()
  .alias("h", "help")
  .version()
  .parse();
