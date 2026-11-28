//! `repoIdentity(dir)` of src/cli/git.ts: the same `git` commands, in the
//! same order, read the same way.

use std::io::{ErrorKind, Read as _};
use std::os::unix::process::CommandExt as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::{js, node, repo, HandBack};

/// bun's `spawnSync` reads at most this much of a child's standard output,
/// and as much of its standard error (Node's default `maxBuffer`, counted in
/// bytes). One byte more and it kills the child and reports a failure, which
/// the JavaScript takes for "", sooner or later depending on how fast the
/// child writes (measured with bun 1.4.0: never up to 1,048,576 bytes,
/// sometimes at 1,048,577, always from 2 MB).
const MAX_BUFFER: usize = 1024 * 1024;

/// Whether a file starts as a program the system runs by itself does: a
/// `#!` line, or an ELF or Mach-O header (a fat one included).
fn runnable_start(start: &[u8]) -> bool {
    const HEADERS: [[u8; 4]; 9] = [
        *b"\x7fELF",
        [0xfe, 0xed, 0xfa, 0xce],
        [0xfe, 0xed, 0xfa, 0xcf],
        [0xce, 0xfa, 0xed, 0xfe],
        [0xcf, 0xfa, 0xed, 0xfe],
        [0xca, 0xfe, 0xba, 0xbe],
        [0xca, 0xfe, 0xba, 0xbf],
        [0xbe, 0xba, 0xfe, 0xca],
        [0xbf, 0xba, 0xfe, 0xca],
    ];
    start.starts_with(b"#!") || HEADERS.iter().any(|header| start.starts_with(header))
}

/// The `git` that `spawnSync("git", …)` starts: the first `git` on PATH that
/// is a file this user may execute (`None`: there is none, and the
/// JavaScript gets "" from every call). bun starts it with exec, which fails
/// with ENOEXEC for a script without a `#!` line, while macOS's posix_spawnp
/// (and glibc's execvp) hand such a script to /bin/sh and run it: found on
/// macOS, the case `verify: open with a git script without #! first on
/// PATH`. So anything that is neither a `#!` script nor a program hands
/// back. That very file is then started, so that a `git` that cannot be
/// started (a `#!` naming a missing interpreter) is not passed over for the
/// next one on PATH, as posix_spawnp does. (PATH has absolute entries only:
/// runtime::machine.)
fn git_program() -> Result<Option<PathBuf>, HandBack> {
    let path = std::env::var_os("PATH").ok_or(HandBack)?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join("git");
        if !candidate.metadata().is_ok_and(|meta| meta.is_file()) || !node::executable(&candidate) {
            continue;
        }
        let mut start = Vec::with_capacity(4);
        std::fs::File::open(&candidate).and_then(|file| file.take(4).read_to_end(&mut start)).map_err(|_| HandBack)?;
        return if runnable_start(&start) { Ok(Some(candidate)) } else { Err(HandBack) };
    }
    Ok(None)
}

/// `git(dir, args)`: `spawnSync("git", ["-C", dir, ...args])`, its standard
/// output trimmed when it exits 0, otherwise "". A `git` that cannot be
/// found gives "" there too, as does one whose `#!` names an interpreter
/// that is not there; any other failure to start it, a file that is not a
/// program (`git_program`), output that is not UTF-8 (which the JavaScript
/// would decode with replacement characters), and either stream longer than
/// `MAX_BUFFER`, is the JavaScript's.
fn git(dir: &str, args: &[&str]) -> Result<String, HandBack> {
    let Some(program) = git_program()? else { return Ok(String::new()) };
    let output = Command::new(program)
        .arg0("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    match output {
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(String::new()),
        Err(_) => Err(HandBack),
        Ok(output) if output.stdout.len() > MAX_BUFFER || output.stderr.len() > MAX_BUFFER => Err(HandBack),
        Ok(output) if output.status.code() == Some(0) => {
            let text = String::from_utf8(output.stdout).map_err(|_| HandBack)?;
            Ok(js::trim(&text).to_string())
        }
        Ok(_) => Ok(String::new()),
    }
}

pub struct RepoIdentity {
    /// `<host>/<owner>/<repo>`
    pub repo: Option<String>,
    pub branch: Option<String>,
}

/// `repoIdentity(dir)`
pub fn repo_identity(dir: &str) -> Result<RepoIdentity, HandBack> {
    // isGitRepo(dir)
    if git(dir, &["rev-parse", "--is-inside-work-tree"])? != "true" {
        return Ok(RepoIdentity { repo: None, branch: None });
    }
    let mut remote = git(dir, &["remote", "get-url", "origin"])?;
    if remote.is_empty() {
        remote = git(dir, &["config", "--get", "remote.origin.url"])?;
    }
    let mut branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if branch.is_empty() {
        branch = git(dir, &["symbolic-ref", "--short", "HEAD"])?;
    }
    Ok(RepoIdentity {
        repo: repo::parse_git_remote(&remote)?,
        branch: (!branch.is_empty() && branch != "HEAD").then_some(branch),
    })
}

impl RepoIdentity {
    /// `shareableDeepLink({ repo, branch })`, when there is a repo.
    pub fn link(&self) -> Option<String> {
        repo::repo_link(self.repo.as_deref()?, self.branch.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_starts_as_a_program() {
        for start in [&b"#!/bin/sh\n"[..], b"#!", b"\x7fELF\x02\x01", &[0xcf, 0xfa, 0xed, 0xfe], &[0xca, 0xfe, 0xba, 0xbe]] {
            assert!(runnable_start(start), "{start:?}");
        }
        for start in [&b""[..], b"#", b" #!", b"case", b"\x7fEL", b"MZ\x90\x00"] {
            assert!(!runnable_start(start), "{start:?}");
        }
    }
}
