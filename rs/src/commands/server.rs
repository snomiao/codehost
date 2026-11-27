//! `codehost serve`, `dev` and `expose` (src/cli/commands/serve.ts, dev.ts,
//! expose.ts), as far as they need neither VS Code nor the network:
//!
//! - all three first trim the room token and check it against the policy; a
//!   token the policy rejects is reported on standard error, exit 1;
//! - `dev`, when a host daemon is live (~/.codehost/daemon.json), only
//!   registers its directory in ~/.codehost/workspaces.json and prints a
//!   link into the daemon's room.
//!
//! Everything else (a server in the foreground, `-d`, `dev --standalone`,
//! `dev` without a live daemon) goes back to the JavaScript. So do the
//! options whose spelling yargs has to judge: `-d` and `--allow` are not
//! accepted here at all.

use std::fs;
use std::io::ErrorKind;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::args::{self, flag, value, Opt};
use crate::json::{self, Json};
use crate::runtime::Machine;
use crate::{git, js, node, repo, token, Answer, Change, HandBack};

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Serve,
    Dev,
    Expose,
}

const SERVE: [Opt; 5] = [value("token", Some('t')), value("name", None), value("signal", None), value("port", None), value("approve", None)];
const DEV: [Opt; 6] = [
    value("token", Some('t')),
    value("name", None),
    value("signal", None),
    value("port", None),
    value("approve", None),
    flag("standalone", None),
];
const EXPOSE: [Opt; 3] = [value("token", Some('t')), value("name", None), value("signal", None)];

pub struct Server {
    kind: Kind,
    token: String,
    dir: Option<String>,
    standalone: bool,
}

fn digits(text: &str) -> bool {
    (1..=5).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())
}

pub fn recognise(kind: Kind, args: &[String]) -> Option<Server> {
    let parsed = match kind {
        Kind::Serve => args::parse(args, &SERVE, 1)?,
        Kind::Dev => args::parse(args, &DEV, 1)?,
        Kind::Expose => args::parse(args, &EXPOSE, 1)?,
    };
    // `--approve` has choices, `--port` and expose's port are numbers: yargs
    // checks the first itself; only plain numbers were compared.
    if parsed.value("approve").is_some_and(|approve| approve != "auto" && approve != "confirm") {
        return None;
    }
    if parsed.value("port").is_some_and(|port| !digits(port)) {
        return None;
    }
    if kind == Kind::Expose && !parsed.positionals.first().is_some_and(|port| digits(port)) {
        return None;
    }
    // `demandOption`
    let token = parsed.value("token")?.to_string();
    Some(Server { kind, token, dir: parsed.positionals.first().cloned(), standalone: parsed.has("standalone") })
}

impl Server {
    pub fn run(&self, machine: &Machine) -> Result<Answer, HandBack> {
        let token = js::trim(&self.token);
        if let Some(reason) = token::rejection(token) {
            machine.plain_stderr()?;
            return Ok(Answer {
                stderr: format!("[codehost] {reason}\n[codehost] room token requires: {}\n", token::REQUIREMENTS),
                code: 1,
                ..Answer::default()
            });
        }
        match self.kind {
            Kind::Dev if !self.standalone => register_with_daemon(machine, token, self.dir.as_deref().unwrap_or(".")),
            _ => Err(HandBack),
        }
    }
}

/// `liveDaemon()`, when it finds one; every other answer means that `dev`
/// serves by itself, which is the JavaScript's.
struct Daemon {
    pid: i32,
    root: String,
    token: String,
}

/// A JSON number written as a plain integer, as JavaScript prints it back.
fn plain_integer(value: &Json, max: u64) -> Option<u64> {
    let Json::Num(text) = value else { return None };
    if !text.bytes().all(|b| b.is_ascii_digit()) || (text.len() > 1 && text.starts_with('0')) {
        return None;
    }
    text.parse::<u64>().ok().filter(|n| *n <= max)
}

fn live_daemon(machine: &Machine) -> Result<Daemon, HandBack> {
    let content = fs::read(machine.state_file("daemon.json")).map_err(|_| HandBack)?;
    let presence = json::parse(std::str::from_utf8(&content).map_err(|_| HandBack)?, false).ok_or(HandBack)?;
    let pid = presence.get("pid").and_then(|pid| plain_integer(pid, i32::MAX as u64)).filter(|pid| *pid > 0).ok_or(HandBack)?;
    let (Some(Json::Str(root)), Some(Json::Str(token))) = (presence.get("root"), presence.get("token")) else { return Err(HandBack) };
    if root.is_empty() || token.is_empty() || !node::alive(pid as i32) {
        return Err(HandBack);
    }
    Ok(Daemon { pid: pid as i32, root: root.clone(), token: token.clone() })
}

/// `registerWorkspace(dir)`: the new content of workspaces.json, or `None`
/// when the directory is registered already. Only a file of `{path,
/// addedAt}` entries is read: the JavaScript rewrites the whole file and
/// drops entries it does not take, by rules not compared here.
fn register(machine: &Machine, dir: &str) -> Result<Option<Change>, HandBack> {
    let file = machine.state_file("workspaces.json");
    let mut entries: Vec<Vec<(String, String)>> = Vec::new();
    match fs::metadata(&file) {
        Err(err) if err.kind() == ErrorKind::NotFound && fs::symlink_metadata(&file).is_err() => {}
        Ok(meta) if meta.is_file() => {
            let content = fs::read(&file).map_err(|_| HandBack)?;
            let Json::Arr(items) = json::parse(std::str::from_utf8(&content).map_err(|_| HandBack)?, false).ok_or(HandBack)? else {
                return Err(HandBack);
            };
            for item in items {
                let Json::Obj(members) = item else { return Err(HandBack) };
                if members.len() != 2 {
                    return Err(HandBack);
                }
                let mut entry = Vec::new();
                for (key, value) in &members {
                    let text = match (key.as_str(), value) {
                        ("path", Json::Str(path)) => {
                            if path == dir {
                                return Ok(None);
                            }
                            json::stringify_str(path)
                        }
                        ("addedAt", value) => plain_integer(value, (1 << 53) - 1).ok_or(HandBack)?.to_string(),
                        _ => return Err(HandBack),
                    };
                    entry.push((key.clone(), text));
                }
                entries.push(entry);
            }
        }
        _ => return Err(HandBack),
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| HandBack)?.as_millis();
    entries.push(vec![("path".to_string(), json::stringify_str(dir)), ("addedAt".to_string(), now.to_string())]);
    // JSON.stringify(all, null, 2)
    let objects: Vec<String> = entries
        .iter()
        .map(|entry| {
            let members: Vec<String> = entry.iter().map(|(key, text)| format!("    {}: {text}", json::stringify_str(key))).collect();
            format!("  {{\n{}\n  }}", members.join(",\n"))
        })
        .collect();
    let content = format!("[\n{}\n]", objects.join(",\n"));
    Ok(Some(Change::Write { path: file.to_str().ok_or(HandBack)?.to_string(), content, executable: false }))
}

/// The branch of `dev` taken when a host daemon is live.
fn register_with_daemon(machine: &Machine, token: &str, dir: &str) -> Result<Answer, HandBack> {
    let dir = node::resolve(&machine.cwd, dir);
    let host = node::hostname().ok_or(HandBack)?;
    let daemon = live_daemon(machine)?;
    let change = register(machine, &dir)?;
    let identity = git::repo_identity(&dir)?;
    let path = match identity.repo {
        Some(_) => identity.link(),
        None => Some(repo::folder_link(&repo::to_posix_path(&dir), &host)),
    }
    .unwrap_or_else(|| "/".to_string());
    let mut stdout = format!(
        "[codehost] host daemon already serving \"{}\" (pid {})\n[codehost] registered {dir} with it — no second daemon needed\n[codehost] open: https://codehost.dev{path}#t={}\n",
        daemon.root,
        daemon.pid,
        js::encode_uri_component(&daemon.token)
    );
    if daemon.token != token {
        stdout.push_str("[codehost] note: the host daemon's room differs from your -t; the link above uses the daemon's room\n");
    }
    stdout.push_str("[codehost] (use --standalone to force an own daemon instead)\n");
    Ok(Answer { changes: change.into_iter().collect(), ..Answer::out(stdout) })
}
