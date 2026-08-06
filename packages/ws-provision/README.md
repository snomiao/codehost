# @snomiao/ws-provision

Provision git workspaces in the standard `<wsRoot>/<owner>/<repo>/tree/<branch>` layout —
independent clone per branch, `fork` as a linked worktree — plus non-interactive GitHub
credential probes (`hasGitCredentials`, `gitAuthHint`) so a private-repo failure diagnoses
itself instead of masquerading as "repository not found".

Extracted from [codehost](https://github.com/snomiao/codehost)'s `codehost/provision`
subpath (which now re-exports this package, so either import works). Zero runtime
dependencies; ships TypeScript source, consumed directly by Bun — the same convention
codehost itself uses. Consumers: codehost's daemon provisioning, agent-yes's `ay ws`.

```ts
import { provision, parseSource, gitAuthHint } from "@snomiao/ws-provision";

const spec = parseSource("snomiao/codehost@main");
const res = await provision(spec, { wsRoot: "~/ws" });
if (!res.ok && res.reason === "auth-missing") console.error(gitAuthHint().join("\n"));
```

Filesystem watching (`codehost/provision/watch`) intentionally stays in codehost — it is
the only piece with a native dependency (`@parcel/watcher`).
