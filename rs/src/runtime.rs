//! Whether this machine is one on which the JavaScript would do exactly what
//! the ported commands do, decided before anything is printed or changed.
//!
//! "The JavaScript" is `bun src/cli/index.ts`, and before its first line:
//!
//! - bun takes options and switches from variables named for it, Node and the
//!   libraries inside it (BUN_*, NODE_*, MIMALLOC_*, ICU_*), and the dynamic
//!   loader that starts bun (a glibc or musl program, where this binary is
//!   static) reads LD_* (LD_PRELOAD, LD_LIBRARY_PATH, LD_DEBUG, …): any of
//!   them, except BUN_INSTALL, which bun's installer puts in every profile,
//!   hands back;
//! - bun reads `bunfig.toml` in the current directory (not in the
//!   directories above it): hands back. bun 1.4.0 ignores ~/.bunfig.toml and
//!   $XDG_CONFIG_HOME/.bunfig.toml when it runs a file, but those hand back
//!   too, which costs nothing;
//! - bun loads `.env` files of the current directory (only there) into the
//!   environment, without overriding a variable that is set, and every
//!   program the JavaScript starts inherits them: `git` reads not only GIT_*
//!   but LD_*, SUDO_UID, HOME, XDG_*, LANG and more. So a `.env` file that
//!   may define a variable that is not already set (and not empty) hands back
//!   (`dotenv_keys` finds every name bun could take for a key, and more);
//!   one whose every key is set already changes nothing. A file that
//!   mentions GIT_, XDG_, BUN, NODE, ICU or COLOR anywhere, in any case,
//!   hands back as well;
//! - bun reads package.json, tsconfig.json and jsconfig.json in the current
//!   directory and every directory above it, and writes to standard error
//!   what it does not like in them: a syntax error, a key given twice, a
//!   `type` other than "module" or "commonjs", an `exports` or `imports` map
//!   of the wrong shape, a `browser` mapping that is not a string or a
//!   boolean; in `compilerOptions`, a `paths` entry that is not an array, a
//!   `paths` pattern or target with more than one `*`, a target that is not
//!   relative when there is no `baseUrl`, a `jsxFactory` or
//!   `jsxFragmentFactory` that is not a member expression, an unknown
//!   `importsNotUsedAsValues`. A file is accepted only when it is in a shape
//!   that was compared and none of these (see `plain_project_file`, and the
//!   comparison with bun in rs/src/compare.rs); an `extends` (which makes bun
//!   read another file) hands back. (A token rejection would not need this:
//!   `process.exit` drops bun's warnings. It goes back all the same.);
//! - every command imports src/cli/rtc-daemon.ts, which loads the native
//!   node-datachannel addon and, when that fails, prints a line and
//!   downloads it before the command runs. The addon has to be where
//!   `require` finds it, or the invocation goes back. (A file that is there
//!   but cannot be loaded, such as a glibc build on a musl system, is not
//!   detected: there the TypeScript fails at every command.)
//!
//! And while it runs, bun prints `console.error` in red when standard output
//! or standard error is a terminal, or FORCE_COLOR is set. A command that
//! would write to standard error then hands back (`Machine::plain_stderr`).
//!
//! Only on Linux is anything answered natively: nothing was compared on
//! macOS or Windows.

use std::ffi::OsStr;
use std::fs;
use std::io::{ErrorKind, IsTerminal};
use std::path::{Path, PathBuf};

use crate::json::{self, Json};
use crate::HandBack;

pub struct Machine {
    /// `os.homedir()`: $HOME.
    pub home: String,
    /// `process.cwd()`
    pub cwd: String,
    /// Whether `console.error` would be coloured.
    coloured_stderr: bool,
}

impl Machine {
    /// `Ok` when what the command writes to standard error comes out as
    /// plain text in the JavaScript too.
    pub fn plain_stderr(&self) -> Result<(), HandBack> {
        if self.coloured_stderr {
            Err(HandBack)
        } else {
            Ok(())
        }
    }

    /// `join(homedir(), ".codehost", name)`
    pub fn state_file(&self, name: &str) -> PathBuf {
        Path::new(&self.home).join(".codehost").join(name)
    }
}

/// Variables bun, Node's compatibility layer, the allocator, ICU or the
/// dynamic loader that starts bun read for themselves.
fn for_the_runtime(name: &OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_uppercase();
    name != "BUN_INSTALL" && ["BUN_", "NODE_", "MIMALLOC_", "ICU_", "LD_"].iter().any(|start| name.starts_with(start))
}

/// Every file bun may load from the current directory, under any NODE_ENV.
const DOTENV_FILES: [&str; 8] = [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.production",
    ".env.production.local",
    ".env.test",
    ".env.test.local",
];

/// What a `.env` file must not mention, in any case.
const DOTENV_NAMES: [&[u8]; 6] = [b"GIT_", b"XDG_", b"BUN", b"NODE", b"ICU", b"COLOR"];

fn mentions(content: &[u8], name: &[u8]) -> bool {
    content.windows(name.len()).any(|window| window.eq_ignore_ascii_case(name))
}

fn absent(path: &Path) -> Result<(), HandBack> {
    match fs::symlink_metadata(path) {
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        _ => Err(HandBack),
    }
}

/// The contents of a regular file, `None` when there is nothing at `path`,
/// `HandBack` for anything else there.
fn read_if_there(path: &Path) -> Result<Option<Vec<u8>>, HandBack> {
    match fs::metadata(path) {
        Err(err) if err.kind() == ErrorKind::NotFound => {
            // A dangling link is something.
            absent(path)?;
            Ok(None)
        }
        Ok(meta) if meta.is_file() => fs::read(path).map(Some).map_err(|_| HandBack),
        _ => Err(HandBack),
    }
}

/// A character bun takes into the key of a `.env` line.
fn key_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
}

/// Every name bun's `.env` parser could take for a key in `content`, and
/// more. bun reads a key as the longest run of `[A-Za-z0-9_.-]` where a line
/// starts (after blanks, and after `export `), or after a quoted value, and
/// takes it when blanks and then `=`, or `:` and a blank, follow. Wherever
/// it starts, nothing before it is a key character. So every such run in
/// the file that is followed by blanks and `=` or `:` is taken here,
/// wherever it is, inside values and comments too: a name too many only
/// hands back.
pub fn dotenv_keys(content: &[u8]) -> Vec<&[u8]> {
    let mut keys = Vec::new();
    let mut at = 0;
    while at < content.len() {
        if !key_byte(content[at]) {
            at += 1;
            continue;
        }
        let start = at;
        while at < content.len() && key_byte(content[at]) {
            at += 1;
        }
        let mut next = at;
        while next < content.len() && matches!(content[next], b' ' | b'\t' | b'\x0b' | b'\x0c') {
            next += 1;
        }
        if matches!(content.get(next), Some(b'=' | b':')) {
            keys.push(&content[start..at]);
        }
    }
    keys
}

/// Whether the variable is set to something, so that bun keeps it as it is.
fn set(name: &[u8]) -> bool {
    use std::os::unix::ffi::OsStrExt as _;
    std::env::var_os(OsStr::from_bytes(name)).is_some_and(|value| !value.is_empty())
}

/// Whether bun, loading `content` from a `.env` file, leaves the environment
/// as it is: every key it could define is `set` already, and the file
/// mentions none of `DOTENV_NAMES`.
pub fn dotenv_changes_nothing(content: &[u8], set: impl Fn(&[u8]) -> bool) -> bool {
    !DOTENV_NAMES.iter().any(|name| mentions(content, name)) && dotenv_keys(content).into_iter().all(set)
}

fn harmless_dotenv(path: &Path) -> Result<(), HandBack> {
    match read_if_there(path)? {
        Some(content) if !dotenv_changes_nothing(&content, set) => Err(HandBack),
        _ => Ok(()),
    }
}

/// `exports`/`imports` targets: a path, or conditions (no key starting with
/// `.`) whose values are targets.
fn plain_target(value: &Json) -> bool {
    match value {
        Json::Str(_) => true,
        Json::Obj(members) => members.iter().all(|(key, value)| !key.starts_with('.') && plain_target(value)),
        _ => false,
    }
}

/// A `jsxFactory` bun reads without a word: ASCII identifiers joined by
/// single dots (`h`, `React.createElement`). bun takes a few more (`.a`,
/// `a..b`, an empty string, non-ASCII letters); those go back.
fn member_expression(text: &str) -> bool {
    text.split('.').all(|part| {
        let mut chars = part.chars();
        matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
    })
}

/// A package.json, tsconfig.json or jsconfig.json about which bun says
/// nothing (see the module's comment). Shapes outside these were not
/// compared and go back.
pub fn plain_project_file(name: &str, content: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(content) else { return false };
    let Some(Json::Obj(members)) = json::parse(text, true) else { return false };
    let root = Json::Obj(members);
    if name == "package.json" {
        let type_ok = match root.get("type") {
            None => true,
            Some(Json::Str(kind)) => kind == "module" || kind == "commonjs",
            Some(_) => false,
        };
        let exports_ok = match root.get("exports") {
            None | Some(Json::Str(_)) => true,
            Some(Json::Obj(members)) => {
                let subpaths = members.iter().filter(|(key, _)| key.starts_with('.')).count();
                (subpaths == 0 || subpaths == members.len()) && members.iter().all(|(_, value)| plain_target(value))
            }
            Some(_) => false,
        };
        let imports_ok = match root.get("imports") {
            None => true,
            Some(Json::Obj(members)) => members.iter().all(|(_, value)| plain_target(value)),
            Some(_) => false,
        };
        let browser_ok = match root.get("browser") {
            None | Some(Json::Str(_)) => true,
            Some(Json::Obj(members)) => members.iter().all(|(_, value)| matches!(value, Json::Str(_) | Json::Bool(_))),
            Some(_) => false,
        };
        type_ok && exports_ok && imports_ok && browser_ok
    } else {
        if root.get("extends").is_some() {
            return false;
        }
        match root.get("compilerOptions") {
            None => true,
            Some(options @ Json::Obj(_)) => {
                // bun warns about a pattern or a target with more than one
                // `*`, and, without a baseUrl, about a target that does not
                // start with `./` or `../` (it lets some others pass, such
                // as `*`; those go back all the same).
                let base_url = matches!(options.get("baseUrl"), Some(Json::Str(base)) if !base.is_empty());
                let pattern = |text: &str| text.matches('*').count() <= 1;
                let target = |item: &Json| {
                    matches!(item, Json::Str(text) if pattern(text) && (base_url || text.starts_with("./") || text.starts_with("../")))
                };
                let paths_ok = match options.get("paths") {
                    None => true,
                    Some(Json::Obj(members)) => {
                        members.iter().all(|(key, value)| pattern(key) && matches!(value, Json::Arr(items) if items.iter().all(target)))
                    }
                    Some(_) => false,
                };
                let jsx_ok = ["jsxFactory", "jsxFragmentFactory"].iter().all(|name| match options.get(name) {
                    None => true,
                    Some(Json::Str(text)) => member_expression(text),
                    Some(_) => false,
                });
                paths_ok && jsx_ok && options.get("importsNotUsedAsValues").is_none()
            }
            Some(_) => false,
        }
    }
}

/// Where `require("node-datachannel")` from src/cli/ finds the package (the
/// nearest node_modules above it), and whether its addon is there.
fn datachannel_addon(package_root: &Path) -> bool {
    let start = package_root.join("src").join("cli");
    for dir in start.ancestors() {
        if dir.file_name() == Some(OsStr::new("node_modules")) {
            continue;
        }
        let package = dir.join("node_modules").join("node-datachannel");
        if fs::symlink_metadata(&package).is_ok() {
            return package.join("package.json").is_file() && package.join("build").join("Release").join("node_datachannel.node").is_file();
        }
    }
    false
}

/// bun cannot load a program from a path with `?` or `\` in it (it takes the
/// one for a query and the other for a `/`).
fn loadable(path: &Path) -> bool {
    !path.to_string_lossy().contains(['?', '\\'])
}

pub fn machine() -> Result<Machine, HandBack> {
    // Compared on Linux only: macOS and Windows go back.
    if cfg!(not(target_os = "linux")) {
        return Err(HandBack);
    }
    if std::env::vars_os().any(|(name, _)| for_the_runtime(&name)) {
        return Err(HandBack);
    }
    let package_root = crate::js_fallback::package_root().ok_or(HandBack)?;
    let real_root = fs::canonicalize(&package_root).map_err(|_| HandBack)?;
    if !loadable(&package_root) || !loadable(&real_root) || !datachannel_addon(&real_root) {
        return Err(HandBack);
    }
    // Without HOME, `os.homedir()` asks the system's user database.
    let home = std::env::var("HOME").ok().filter(|home| !home.is_empty()).ok_or(HandBack)?;
    // `git` is looked up in PATH; an empty or relative entry is looked up
    // from the current directory, which the two runtimes need not do alike.
    let path = std::env::var("PATH").map_err(|_| HandBack)?;
    if path.split(':').any(|dir| !dir.starts_with('/')) {
        return Err(HandBack);
    }
    let cwd = std::env::current_dir().map_err(|_| HandBack)?;
    let cwd_text = cwd.to_str().ok_or(HandBack)?.to_string();

    absent(&cwd.join("bunfig.toml"))?;
    absent(&Path::new(&home).join(".bunfig.toml"))?;
    if let Some(config) = std::env::var_os("XDG_CONFIG_HOME") {
        absent(&Path::new(&config).join(".bunfig.toml"))?;
    }
    for name in DOTENV_FILES {
        harmless_dotenv(&cwd.join(name))?;
    }
    for dir in cwd.ancestors() {
        for name in ["package.json", "tsconfig.json", "jsconfig.json"] {
            if let Some(content) = read_if_there(&dir.join(name))? {
                if !plain_project_file(name, &content) {
                    return Err(HandBack);
                }
            }
        }
    }

    let terminal = std::io::stdout().is_terminal() || std::io::stderr().is_terminal();
    let coloured_stderr = terminal || std::env::var_os("FORCE_COLOR").is_some();
    Ok(Machine { home, cwd: cwd_text, coloured_stderr })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(name: &str, text: &str) -> bool {
        plain_project_file(name, text.as_bytes())
    }

    // What bun 1.4.0 said about each of these, written beside it.
    #[test]
    fn project_files_bun_says_nothing_about() {
        for text in [
            r#"{"name": "x", "type": "module", "exports": {"./a": {"import": "./a.js", "default": "./b.js"}, "./package.json": "./package.json"}}"#,
            r#"{"exports": {"import": "./a.js", "require": "./b.cjs"}}"#,
            r##"{"exports": "x", "imports": {"#a": {"node": "./x.js"}}, "browser": {"./a": false, "b": "./c"}}"##,
            r#"{"main": 5, "module": {}, "sideEffects": [5], "workspaces": 5, "dependencies": {"a": 5}, "name": {}}"#,
            "// c\n{\"a\": 1,}",
        ] {
            assert!(plain("package.json", text), "{text}");
        }
        for text in [
            "// comment\n{\"compilerOptions\": {\"strict\": true, \"lib\": [\"es2020\",],},/* x */}",
            r#"{"compilerOptions": {"paths": {"@/*": ["./src/*"]}, "baseUrl": ".", "jsx": "weird"}}"#,
            r#"{"compilerOptions": {"paths": {"@/*": ["src/*", "../x/*"], "*": ["*"]}, "baseUrl": "."}}"#,
            r#"{"compilerOptions": {"paths": {}, "jsxFactory": "React.createElement", "jsxFragmentFactory": "h"}}"#,
            r#"{"compilerOptions": {"jsxFactory": "$._a1.b"}}"#,
        ] {
            assert!(plain("tsconfig.json", text), "{text}");
        }
    }

    #[test]
    fn project_files_bun_warns_about_or_not_compared() {
        for text in [
            "{bad", r#"{"a":1,"a":2}"#, r#"{"x": {"a":1,"a":2}}"#, r#"{"type": "weird"}"#, r#"{"type": 5}"#, r#"{"exports": 5}"#,
            r#"{"exports": {".": "./a.js", "x": "./b.js"}}"#, r#"{"exports": {"./a": 5}}"#, r#"{"exports": {"./a": ["./x", 5]}}"#,
            r#"{"imports": 5}"#, r#"{"browser": {"a": 5}}"#, "[]", "", "{'a': 1}",
        ] {
            assert!(!plain("package.json", text), "{text}");
        }
        for text in [r#"{"compilerOptions": {"paths": {"a": 5}}}"#, r#"{"compilerOptions": {"importsNotUsedAsValues": "weird"}}"#, r#"{"extends": "./x.json"}"#, r#"{"a":1,"a":2}"#] {
            assert!(!plain("tsconfig.json", text), "{text}");
        }
        // bun 1.4.0 warns about these: `Invalid pattern "a*b*", must have at
        // most one "*" character`, `Non-relative path "src/*" is not allowed
        // when "baseUrl" is not set`, `Invalid JSX member expression: "a-b"`.
        for text in [
            r#"{"compilerOptions": {"paths": {"a*b*": ["./x"]}}}"#,
            r#"{"compilerOptions": {"paths": {"@/*": ["./src/*/*"]}}}"#,
            r#"{"compilerOptions": {"paths": {"x/*": ["*/*"]}, "baseUrl": "."}}"#,
            r#"{"compilerOptions": {"paths": {"@/*": ["src/*"]}}}"#,
            r#"{"compilerOptions": {"paths": {"@/*": ["src/*"]}, "baseUrl": ""}}"#,
            r#"{"compilerOptions": {"paths": {"@/*": ["src/*"]}, "baseUrl": 5}}"#,
            r#"{"compilerOptions": {"jsxFactory": "a-b"}}"#,
            r#"{"compilerOptions": {"jsxFragmentFactory": "a b"}}"#,
            r#"{"compilerOptions": {"jsxFactory": "a."}}"#,
            r#"{"compilerOptions": {"jsxFactory": "1x"}}"#,
        ] {
            assert!(!plain("tsconfig.json", text), "{text}");
            assert!(!plain("jsconfig.json", text), "{text}");
        }
        // bun says nothing about these, but they were not needed: back.
        for text in [r#"{"compilerOptions": {"paths": {"@/*": ["*"]}}}"#, r#"{"compilerOptions": {"jsxFactory": ""}}"#, r#"{"compilerOptions": {"jsxFactory": 5}}"#] {
            assert!(!plain("tsconfig.json", text), "{text}");
        }
    }

    #[test]
    fn every_name_bun_could_take_for_a_key() {
        let keys = |text: &str| dotenv_keys(text.as_bytes()).into_iter().map(|key| String::from_utf8_lossy(key).into_owned()).collect::<Vec<_>>();
        assert_eq!(keys("A=1\n  export B = 2\r\nC: 3\n# D=4\nE=\"x\" F=5\n"), ["A", "B", "C", "D", "E", "F"]);
        assert_eq!(keys("URL=https://x.dev/?a=b\n"), ["URL", "https", "a"]);
        assert_eq!(keys("a.b-c_d=1\téx=2"), ["a.b-c_d", "x"]);
        assert!(keys("# only a comment\n\n   \nexport\n").is_empty());
    }

    #[test]
    fn variables_for_the_runtime() {
        for name in ["BUN_OPTIONS", "NODE_ENV", "node_options", "MIMALLOC_VERBOSE", "ICU_DATA", "BUN_INSTALL_CACHE_DIR", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_DEBUG"] {
            assert!(for_the_runtime(OsStr::new(name)), "{name}");
        }
        for name in ["BUN_INSTALL", "HOME", "NODENV_ROOT", "BUNDLE_PATH", "CODEHOST_NO_NATIVE", "OLDPWD"] {
            assert!(!for_the_runtime(OsStr::new(name)), "{name}");
        }
    }
}
