//! `codehost open [target] --print` (src/cli/commands/open.ts).
//!
//! Only with `--print`: without it the command opens the default browser,
//! and that stays the JavaScript's.

use std::fs;
use std::io::ErrorKind;

use crate::args::{self, flag, value, Opt};
use crate::json::{self, Json};
use crate::runtime::Machine;
use crate::{git, js, node, repo, Answer, HandBack};

/// `PAGE_URL`
const PAGE_URL: &str = "https://codehost.dev";

const OPTIONS: [Opt; 4] = [value("token", Some('t')), flag("anon", None), value("page", None), flag("print", None)];

pub struct Open {
    target: Option<String>,
    token: Option<String>,
    anon: bool,
    page: String,
}

pub fn recognise(args: &[String]) -> Option<Open> {
    let parsed = args::parse(args, &OPTIONS, 1)?;
    if !parsed.has("print") {
        return None;
    }
    Some(Open {
        target: parsed.positionals.first().cloned(),
        token: parsed.value("token").map(String::from),
        anon: parsed.has("anon"),
        page: parsed.value("page").unwrap_or(PAGE_URL).to_string(),
    })
}

/// `/^https?:\/\//i`
fn is_http_url(text: &str) -> bool {
    let bytes = text.as_bytes();
    let starts = |prefix: &[u8]| bytes.len() >= prefix.len() && bytes[..prefix.len()].eq_ignore_ascii_case(prefix);
    starts(b"http://") || starts(b"https://")
}

/// `/^[^/]*@[^/@]+(\/|$)/`: the first segment is `<user>@<machine>`, which
/// is to say its last `@` is not its last character.
fn machine_scoped(clean: &str) -> bool {
    let segment = clean.split('/').next().unwrap_or("");
    segment.rfind('@').is_some_and(|at| at + 1 < segment.len())
}

/// `pathFromTarget(target)`
fn path_from_target(target: &str) -> Result<String, HandBack> {
    let clean = target.trim_start_matches('/');
    if ["gh/", "git/", "host/", "dev/"].iter().any(|start| clean.starts_with(start)) || machine_scoped(clean) {
        return Ok(format!("/{clean}"));
    }
    if let Some(path) = repo::git_url_to_path(target)? {
        return Ok(path);
    }
    // /^([^/]+)\/([^/]+)(?:\/tree\/(.+))?$/ -> a GitHub repository
    if let Some((owner, rest)) = clean.split_once('/') {
        let (name, tail) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
        if !owner.is_empty() && !name.is_empty() {
            if let Some(branch) = repo::tree_tail(tail) {
                return Ok(repo::repo_link(&format!("github.com/{owner}/{name}"), branch).unwrap_or_else(|| "/".to_string()));
            }
        }
    }
    Ok(format!("/dev/{clean}"))
}

/// `pathFromCwd()`: the path, and what it writes to standard error.
fn path_from_cwd(machine: &Machine) -> Result<(String, Option<&'static str>), HandBack> {
    let identity = git::repo_identity(&node::resolve(&machine.cwd, "."))?;
    Ok(match identity.link() {
        Some(path) => (path, None),
        None => ("/".to_string(), Some("[codehost] no git repo found here; opening the codehost home page\n")),
    })
}

/// `readConfig().token`, where it reads as a string or as nothing.
fn saved_token(machine: &Machine) -> Result<Option<String>, HandBack> {
    let content = match fs::read(machine.state_file("config.json")) {
        // readFileSync throws, readConfig() is {}.
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
        // A directory, no permission: also {}, but not compared.
        Err(_) => return Err(HandBack),
        Ok(content) => content,
    };
    let text = std::str::from_utf8(&content).map_err(|_| HandBack)?;
    match json::parse(text, false).ok_or(HandBack)? {
        config @ Json::Obj(_) => match config.get("token") {
            None | Some(Json::Null) => Ok(None),
            Some(Json::Str(token)) => Ok((!token.is_empty()).then(|| token.clone())),
            // A number or an object would be printed by JavaScript's rules.
            Some(_) => Err(HandBack),
        },
        // `null.token` throws.
        Json::Null => Err(HandBack),
        // A string, a number, a boolean or an array has no `token`.
        _ => Ok(None),
    }
}

/// `base` with `#t=<token>`, when there is one.
fn with_token(base: String, token: Option<String>) -> String {
    match token {
        Some(token) => format!("{base}#t={}", js::encode_uri_component(&token)),
        None => base,
    }
}

/// `buildUrl` for a target that is not blank. The token is asked for only
/// where the TypeScript reads it: not for a URL opened as it is.
pub(crate) fn url_for_target(target: &str, page: &str, token: impl FnOnce() -> Result<Option<String>, HandBack>) -> Result<String, HandBack> {
    // A full URL that is not a repository is opened as it is.
    if is_http_url(target) && repo::git_url_to_path(target)?.is_none() {
        return Ok(target.to_string());
    }
    let base = format!("{}{}", page.trim_end_matches('/'), path_from_target(target)?);
    Ok(with_token(base, token()?))
}

impl Open {
    #[cfg(test)]
    pub fn describe(&self) -> String {
        let show = |value: &Option<String>| value.clone().unwrap_or_else(|| "<none>".to_string());
        ["open".to_string(), show(&self.target), show(&self.token), self.anon.to_string(), self.page.clone()].join("\u{1}")
    }

    /// `argv.anon ? undefined : (argv.token?.trim() || readConfig().token)`
    fn token(&self, machine: &Machine) -> Result<Option<String>, HandBack> {
        if self.anon {
            return Ok(None);
        }
        match self.token.as_deref().map(js::trim).filter(|token| !token.is_empty()) {
            Some(token) => Ok(Some(token.to_string())),
            None => saved_token(machine),
        }
    }

    /// `buildUrl(argv)`, then `console.log`.
    pub fn run(&self, machine: &Machine) -> Result<Answer, HandBack> {
        let target = self.target.as_deref().map(js::trim).filter(|target| !target.is_empty());
        if let Some(target) = target {
            let url = url_for_target(target, &self.page, || self.token(machine))?;
            return Ok(Answer::out(format!("[codehost] {url}\n")));
        }
        // Outside a repository this writes to standard error, which bun
        // colours on a terminal. Whether it is a repository is only known
        // after asking git, and git is not to be asked twice: decline first.
        machine.plain_stderr()?;
        let (path, stderr) = path_from_cwd(machine)?;
        let url = with_token(format!("{}{path}", self.page.trim_end_matches('/')), self.token(machine)?);
        Ok(Answer { stderr: stderr.unwrap_or_default().to_string(), ..Answer::out(format!("[codehost] {url}\n")) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets() {
        for (target, path) in [
            ("owner/repo", "/github.com/owner/repo"),
            ("owner/repo/tree/feat/x", "/github.com/owner/repo/tree/feat/x"),
            ("//gh/x", "/gh/x"),
            ("me@box/C:/ws", "/me@box/C:/ws"),
            ("git@github.com:Foo/Bar.git", "/git@github.com:Foo/Bar.git"),
            ("x@", "/dev/x@"),
            ("gitlab.com/a/b", "/gitlab.com/a/b"),
            ("a/b/c", "/dev/a/b/c"),
            ("a/b/tree", "/dev/a/b/tree"),
            ("null", "/dev/null"),
        ] {
            assert_eq!(path_from_target(target).ok().as_deref(), Some(path), "{target}");
        }
    }
}
