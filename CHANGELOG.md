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
