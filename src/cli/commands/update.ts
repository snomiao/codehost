import type { CommandModule } from "yargs";
import { resolveCodeBinary } from "../vscode-install";

export const updateCommand: CommandModule = {
  command: "update",
  describe: "Download the latest VS Code CLI now (ignores the daily check throttle)",
  handler: async () => {
    if (process.env.CODEHOST_CODE_BIN) {
      console.log(`[codehost] CODEHOST_CODE_BIN is set; nothing to update (${process.env.CODEHOST_CODE_BIN})`);
      return;
    }
    if (Bun.which("code")) {
      console.log("[codehost] using system `code` on PATH; update it with your package manager.");
      return;
    }
    const bin = await resolveCodeBinary({ force: true });
    console.log(`[codehost] up to date: ${bin}`);
  },
};
