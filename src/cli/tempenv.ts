// TEMP/TMP repair is now provided by @snomiao/daemon-kit (shared with agent-yes).
// This module stays as the side-effect entrypoint — index.ts imports it FIRST so
// the env is fixed before any native dep (node-datachannel/bun-pty) or child
// process reads it — and re-exports the helpers for tests.
import { normalizeTempEnv } from "@snomiao/daemon-kit";

export { expandWinVars, normalizeTempEnv } from "@snomiao/daemon-kit";

normalizeTempEnv();
