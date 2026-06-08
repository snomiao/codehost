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
