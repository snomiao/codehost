#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { serveCommand } from "./commands/serve";
import { listCommand } from "./commands/list";
import { stopCommand } from "./commands/stop";

yargs(hideBin(process.argv))
  .scriptName("codehost")
  .usage("$0 <command> [options]")
  .command(serveCommand)
  .command(listCommand)
  .command(stopCommand)
  .demandCommand(1, "Specify a command, e.g. `codehost serve`")
  .strict()
  .help()
  .alias("h", "help")
  .version()
  .parse();
