//! `repoIdentity(dir)` of src/cli/git.ts: the same `git` commands, in the
//! same order, read the same way.

use std::io::ErrorKind;
use std::process::{Command, Stdio};

use crate::{js, repo, HandBack};

/// `git(dir, args)`: `spawnSync("git", ["-C", dir, ...args])`, its standard
/// output trimmed when it exits 0, otherwise "". A `git` that cannot be
/// found gives "" there too; any other failure to start it, and output that
/// is not UTF-8 (which the JavaScript would decode with replacement
/// characters), is the JavaScript's.
fn git(dir: &str, args: &[&str]) -> Result<String, HandBack> {
    let output = Command::new("git")
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
