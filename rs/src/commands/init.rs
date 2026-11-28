//! `codehost init [dir] [-f|--force]` (src/cli/commands/init.ts and
//! `scaffoldCodehost` of src/cli/init.ts).
//!
//! The three files are written byte for byte as the TypeScript's constants
//! evaluate (rs/src/templates/ was written from them by bun). Everything the
//! JavaScript would trip over is found before the first change: a file where
//! a directory has to be, a link, a directory where a file is to be
//! overwritten, a directory that cannot be written into. Those go back.

use std::fs::{self, OpenOptions};
use std::io::ErrorKind;
use std::path::Path;

use crate::args::{self, flag, Opt};
use crate::runtime::Machine;
use crate::{node, Answer, Change, HandBack};

const OPTIONS: [Opt; 1] = [flag("force", Some('f'))];

/// `FILES`, in their order.
const FILES: [(&str, &str, bool); 3] = [
    ("config.yaml", include_str!("../templates/config.yaml"), false),
    ("setup.sh", include_str!("../templates/setup.sh"), true),
    ("setup.ps1", include_str!("../templates/setup.ps1"), false),
];

pub struct Init {
    dir: String,
    force: bool,
}

pub fn recognise(args: &[String]) -> Option<Init> {
    let parsed = args::parse(args, &OPTIONS, 1)?;
    // An empty dir would be skipped by path.resolve; not compared.
    let dir = parsed.positionals.first().cloned().unwrap_or_else(|| ".".to_string());
    (!dir.is_empty()).then_some(Init { dir, force: parsed.has("force") })
}

/// What `mkdirSync(dir, { recursive: true })` creates, outermost first, or
/// `HandBack` when it would fail: something other than a directory in the
/// way, a link that leads nowhere, a parent that cannot be written into.
fn directories_to_make(dir: &str) -> Result<Vec<String>, HandBack> {
    let mut missing = Vec::new();
    let mut at = Path::new(dir);
    loop {
        match fs::metadata(at) {
            Ok(meta) if meta.is_dir() => {
                if !missing.is_empty() && !node::writable_dir(at.to_str().ok_or(HandBack)?) {
                    return Err(HandBack);
                }
                break;
            }
            Err(err) if err.kind() == ErrorKind::NotFound && fs::symlink_metadata(at).is_err() => {
                missing.push(at.to_str().ok_or(HandBack)?.to_string());
                at = at.parent().ok_or(HandBack)?;
            }
            _ => return Err(HandBack),
        }
    }
    missing.reverse();
    Ok(missing)
}

/// Whether a file is there to be overwritten: a regular file (no link) that
/// can be opened for writing. Opening it without truncating changes nothing.
fn overwritable(path: &str) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file()) && OpenOptions::new().write(true).open(path).is_ok()
}

impl Init {
    #[cfg(test)]
    pub fn describe(&self) -> String {
        ["init".to_string(), self.dir.clone(), self.force.to_string()].join("\u{1}")
    }

    pub fn run(&self, machine: &Machine) -> Result<Answer, HandBack> {
        let dir = node::resolve(&machine.cwd, &self.dir);
        let codehost = node::join(&dir, ".codehost");
        let mut changes: Vec<Change> = directories_to_make(&codehost)?.into_iter().map(Change::Mkdir).collect();
        let creates_dir = !changes.is_empty();
        let mut written = Vec::new();
        for (name, body, executable) in FILES {
            let path = node::join(&codehost, name);
            let write = match fs::symlink_metadata(&path) {
                Err(err) if err.kind() == ErrorKind::NotFound => {
                    // A new file in a directory that is already there.
                    if !creates_dir && !node::writable_dir(&codehost) {
                        return Err(HandBack);
                    }
                    true
                }
                // existsSync follows links; not compared.
                Ok(meta) if meta.file_type().is_symlink() => return Err(HandBack),
                // existsSync: kept, whatever it is.
                Ok(_) if !self.force => false,
                Ok(_) if overwritable(&path) => true,
                _ => return Err(HandBack),
            };
            if write {
                changes.push(Change::Write { path: path.clone(), content: body.to_string(), executable });
                written.push(path);
            }
        }
        let stdout = if written.is_empty() {
            format!("[codehost] .codehost/ already set up in {dir} (use --force to overwrite)\n")
        } else {
            let list: Vec<String> = written.iter().map(|path| format!("  {path}")).collect();
            format!("[codehost] scaffolded:\n{}\n[codehost] edit .codehost/setup.sh, then run: codehost serve {dir}\n", list.join("\n"))
        };
        Ok(Answer { changes, ..Answer::out(stdout) })
    }
}
