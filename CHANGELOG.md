## [0.20.2](https://github.com/snomiao/codehost/compare/v0.20.1...v0.20.2) (2026-06-11)


### Performance Improvements

* **tunnel:** 64KB frames, gzip passthrough, immutable-asset SW cache, event-driven backpressure; ICE path badge ([da3647c](https://github.com/snomiao/codehost/commit/da3647c96ac1e323237e4743e7f0e4b1a83f741d))

## [0.20.1](https://github.com/snomiao/codehost/compare/v0.20.0...v0.20.1) (2026-06-11)


### Bug Fixes

* **signaling:** tame the room-DO request storm; live agent titles on the sidepanel ([d39dceb](https://github.com/snomiao/codehost/commit/d39dceb2c7e3cd47dcb17f099aa8e0d37d3a7e13))

# [0.20.0](https://github.com/snomiao/codehost/compare/v0.19.0...v0.20.0) (2026-06-11)


### Features

* **web:** edit a host's .codehost config from the site — advertised as a ⚙ workspace entry ([7c97b87](https://github.com/snomiao/codehost/commit/7c97b870715d6879cee39dab286cc7b8d45f08a6))

# [0.19.0](https://github.com/snomiao/codehost/compare/v0.18.2...v0.19.0) (2026-06-11)


### Features

* **web:** GitHub-URL header/title for the open workspace; agent chips link into the agent-yes console ([83d62bc](https://github.com/snomiao/codehost/commit/83d62bc2ab3e70722f8a4f0f817541bea7cf69a2))

## [0.18.2](https://github.com/snomiao/codehost/compare/v0.18.1...v0.18.2) (2026-06-11)


### Bug Fixes

* **signaling:** recover instantly when a throttled tab wakes (visibility/focus/online) ([d459132](https://github.com/snomiao/codehost/commit/d45913267f053ee1fee062bae550cfe60a193207))

## [0.18.1](https://github.com/snomiao/codehost/compare/v0.18.0...v0.18.1) (2026-06-11)


### Bug Fixes

* **signaling:** abort connect attempts stuck in CONNECTING; guard tunnel stream enqueue ([b3ae0d1](https://github.com/snomiao/codehost/commit/b3ae0d11299a195b8d09e42355cd14a3b09b8d2f))

# [0.18.0](https://github.com/snomiao/codehost/compare/v0.17.0...v0.18.0) (2026-06-11)


### Features

* **cli:** ~/ws as the default workspace root + loud y/N confirm for serving $HOME ([aee5a20](https://github.com/snomiao/codehost/commit/aee5a207a930058472f5b2042a56904051e079a7))
* **provision:** batteries-included roots — setup auto-scaffolds .codehost/, scaffold detaches fresh clones ([625d958](https://github.com/snomiao/codehost/commit/625d9587d97b59da0bb595aa456a56d3bf920ac4))

# [0.17.0](https://github.com/snomiao/codehost/compare/v0.16.0...v0.17.0) (2026-06-11)


### Bug Fixes

* **vscode:** reject the desktop bin/code wrapper — probe serve-web support, not just --version ([e5b133d](https://github.com/snomiao/codehost/commit/e5b133d0ff38f4e1052f87c22279c7850eb98968))


### Features

* **history:** durable history via hostId + machine-preferring deep-link resolution ([1935579](https://github.com/snomiao/codehost/commit/1935579a40fb7c42f46b8f1596497dac812cdc2b))
* **host:** one daemon per host — `dev` registers with a live root daemon instead of spawning a second peer ([43051de](https://github.com/snomiao/codehost/commit/43051deaae33f647b26bdcf0facb0bac9507471f))
* **identity:** stable per-machine hostId, advertised in PeerMeta; web groups workspaces by host ([43a48a2](https://github.com/snomiao/codehost/commit/43a48a2630534c36c399f0cce294a2e96235b5fb))
* **lib:** embeddable room-client bundle for external consoles (agent-yes.com) ([fd0afd1](https://github.com/snomiao/codehost/commit/fd0afd19234816127b640c397eeac5cc7968f484))
* **plugins:** daemon plugin layer + agent-yes plugin (agents[] in meta, ay API proxy over the tunnel) ([60f77b2](https://github.com/snomiao/codehost/commit/60f77b2dbbe3b649bbc8a34982b028d5a432ddb7))
* **tree:** root daemons advertise enumerated workspaces; live meta updates; exact deep-link matching ([81493be](https://github.com/snomiao/codehost/commit/81493be6694d85110a0e9f1244bd6604875c02a2))

# [0.16.0](https://github.com/snomiao/codehost/compare/v0.15.0...v0.16.0) (2026-06-10)


### Features

* **provision:** codehost init scaffolds .codehost/ (config + setup hooks) ([b1a2e9c](https://github.com/snomiao/codehost/commit/b1a2e9c23230e09dc6a291dbcab098083bb59f4d))
* **provision:** daemon-side provision handler over the tunnel ([c297e95](https://github.com/snomiao/codehost/commit/c297e9577b3e1a65260ab105478feb63186fce46))
* **provision:** tested security core for workspace provisioning ([ca7508c](https://github.com/snomiao/codehost/commit/ca7508c48e78eb46fbf8bf42ef398360bea38f86))
* **web:** provisioning browser flow — run setup.sh on repo open, stream log ([9bd8742](https://github.com/snomiao/codehost/commit/9bd8742b143e84d386f8af138df73e57cac70e46))

# [0.15.0](https://github.com/snomiao/codehost/compare/v0.14.0...v0.15.0) (2026-06-10)


### Features

* **web:** 'open a GitHub URL' box + deepest-root repo resolution ([0d9ebec](https://github.com/snomiao/codehost/commit/0d9ebec4409430c327e2945657b6803ca704fd53))

# [0.14.0](https://github.com/snomiao/codehost/compare/v0.13.0...v0.14.0) (2026-06-10)


### Features

* **web:** always show /tree/<branch> for repo workspaces ([ad34bc2](https://github.com/snomiao/codehost/commit/ad34bc2e2e8acea98ac392b90766488c6f3b4e52))

# [0.13.0](https://github.com/snomiao/codehost/compare/v0.12.0...v0.13.0) (2026-06-09)


### Features

* **web:** host-scoped folder deep links — /host/<hostname>/<path> ([f6955ab](https://github.com/snomiao/codehost/commit/f6955ab37517f312ee780795efc503cb74ccdc36))

# [0.12.0](https://github.com/snomiao/codehost/compare/v0.11.1...v0.12.0) (2026-06-09)


### Features

* **web:** URL-driven reconnect — Forward rehydrates, auto-reconnect on drop ([8e1f186](https://github.com/snomiao/codehost/commit/8e1f186bd6611d5d56a9061fed23ed7316c735ca))

## [0.11.1](https://github.com/snomiao/codehost/compare/v0.11.0...v0.11.1) (2026-06-09)


### Bug Fixes

* **signaling:** harden reconnect backoff + log close code/duration ([a0aa1ce](https://github.com/snomiao/codehost/commit/a0aa1ce7aeae49815fc51dd272a8e08852ed55b2))

# [0.11.0](https://github.com/snomiao/codehost/compare/v0.10.0...v0.11.0) (2026-06-09)


### Features

* **web:** update URL on Connect + Back returns to the list ([7258a16](https://github.com/snomiao/codehost/commit/7258a168a0bcc1d476aab8a7f3fcd81f35ccfcb5))

# [0.10.0](https://github.com/snomiao/codehost/compare/v0.9.1...v0.10.0) (2026-06-09)


### Features

* **web:** join multiple rooms at once, merged workspace list ([de5ae61](https://github.com/snomiao/codehost/commit/de5ae610068b6f2a26792ed7d6e67d1fb5c08257))

## [0.9.1](https://github.com/snomiao/codehost/compare/v0.9.0...v0.9.1) (2026-06-08)


### Bug Fixes

* **web:** stop rendering raw room token in the input ([abf7ea5](https://github.com/snomiao/codehost/commit/abf7ea5abd96f156f178f5f5c8ddb0e31f8fdd81))

# [0.9.0](https://github.com/snomiao/codehost/compare/v0.8.0...v0.9.0) (2026-06-08)


### Features

* Windows fallback daemon via Scheduled Task (persists + auto-starts at logon) ([cd72bb7](https://github.com/snomiao/codehost/commit/cd72bb7954d05ddf093337b627bcf6b9e9003c53))

# [0.8.0](https://github.com/snomiao/codehost/compare/v0.7.1...v0.8.0) (2026-06-08)


### Features

* **web:** filterable workspace list with fake-tags (ay-ls style) ([83dff4f](https://github.com/snomiao/codehost/commit/83dff4ffb813ac93afddf6bb4118b5ffb5278c3b))

## [0.7.1](https://github.com/snomiao/codehost/compare/v0.7.0...v0.7.1) (2026-06-08)


### Bug Fixes

* ch list shows only codehost daemons, not all oxmgr processes ([e9cf4fc](https://github.com/snomiao/codehost/commit/e9cf4fca40b653c430c26eb29ba47ef9a154f089))
* kill the VS Code serve-web process tree on stop (no orphans) ([d6337f6](https://github.com/snomiao/codehost/commit/d6337f6d45bf41fb57f2d0cd28c60a70f55f62d0))

# [0.7.0](https://github.com/snomiao/codehost/compare/v0.6.0...v0.7.0) (2026-06-08)


### Features

* add 'ch' bin alias for codehost CLI ([b66983d](https://github.com/snomiao/codehost/commit/b66983dd4d56073a9b1e8257eaf858440249968a))

# [0.6.0](https://github.com/snomiao/codehost/compare/v0.5.1...v0.6.0) (2026-06-08)


### Features

* detached fallback daemon when oxmgr is unavailable ([3aeddad](https://github.com/snomiao/codehost/commit/3aeddad595a2fc65f8a65050a5cc6171f41bca8f))

## [0.5.1](https://github.com/snomiao/codehost/compare/v0.5.0...v0.5.1) (2026-06-08)


### Bug Fixes

* don't time out (and oxmgr-restart-loop) on first-run VS Code server download ([5ad1b06](https://github.com/snomiao/codehost/commit/5ad1b068668afda4d19f403286240827a0a4b9c4))
* Windows ?folder= path must be /C:/ws (file-URI form), not git-bash /c/ws ([f6d2485](https://github.com/snomiao/codehost/commit/f6d24858c943dd2b7b5f1d5a96f71468e9552140))

# [0.5.0](https://github.com/snomiao/codehost/compare/v0.4.0...v0.5.0) (2026-06-08)


### Features

* shareable workspace URLs (host-agnostic) + Share button + cross-room search ([f1db806](https://github.com/snomiao/codehost/commit/f1db806a1ec86cdc369b17ccca82057eb9526385))

# [0.4.0](https://github.com/snomiao/codehost/compare/v0.3.1...v0.4.0) (2026-06-08)


### Bug Fixes

* normalize Windows serve path to POSIX-drive form for VS Code web ([8add2d6](https://github.com/snomiao/codehost/commit/8add2d66a6b5ae765f91386f738ad38abcb90057))


### Features

* setup.sh/ps1 installer aliases + self-update to latest on serve/setup ([93a5d64](https://github.com/snomiao/codehost/commit/93a5d64170c5851ca0f488348975dae46f467b5e))

## [0.3.1](https://github.com/snomiao/codehost/compare/v0.3.0...v0.3.1) (2026-06-07)


### Bug Fixes

* add repository metadata so npm provenance publish succeeds ([e794bc2](https://github.com/snomiao/codehost/commit/e794bc2cef66276a53ca9fca9bece1a056bef703))

# [0.3.0](https://github.com/snomiao/codehost/compare/v0.2.0...v0.3.0) (2026-06-07)


### Features

* open token URL after setup/serve and auto-connect a single server ([b6183a2](https://github.com/snomiao/codehost/commit/b6183a2dc35e3e2ce1b4dffa8d4228fab377f4e3))

# [0.2.0](https://github.com/snomiao/codehost/compare/v0.1.1...v0.2.0) (2026-06-05)


### Bug Fixes

* oxmgr works under bun/bunx and on Windows (no Node, no global install) ([b339b31](https://github.com/snomiao/codehost/commit/b339b319c7147eee4e99c5abe977ace3146e41d6))
* tunnel VS Code's resource URLs via the real host, not 127.0.0.1 ([c9d22e2](https://github.com/snomiao/codehost/commit/c9d22e27946464252cd753424f0e267eb664fb93))


### Features

* `-d` enables login auto-start via oxmgr's service integration ([623e022](https://github.com/snomiao/codehost/commit/623e02291cf0d1bc4c71c0344b333e93e72783db))
* `codehost expose <port>` — tunnel any local HTTP/WS server over WebRTC ([1ec57f4](https://github.com/snomiao/codehost/commit/1ec57f4f8d221b699c8f713b2eb6f0e2187665b7))
* deep-link to a live workspace via codehost.dev/gh/<owner>/<repo>/tree/<branch> ([1567ba7](https://github.com/snomiao/codehost/commit/1567ba7e64b821d5dea989235db63c5f22d9b4c9))
* proxy VS Code's CORS-less CDN through the signaling Worker ([0a362ee](https://github.com/snomiao/codehost/commit/0a362ee0d0c3247963da72bcc3b12365711c6d4a))
