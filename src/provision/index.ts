// The provision implementation lives in packages/ws-provision (published as
// @snomiao/ws-provision so light consumers like agent-yes's `ay ws` can depend
// on it without codehost's heavy deps). This shim keeps both the public
// `codehost/provision` subpath and codehost's internal `../provision` imports
// stable — the relative path resolves inside the published codehost tarball
// too, since npm ships the whole repo (no `files` allowlist).
export * from "../../packages/ws-provision/src/index";
