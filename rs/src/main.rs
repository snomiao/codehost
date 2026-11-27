//! codehost — Rust entry point.
//!
//! Installed from npm, this binary is the command users run (`codehost` and
//! `ch`). A command runs here once it has been ported and the parity cases
//! (rs/parity.json) show it behaves like the TypeScript; everything else is
//! handed back to the JavaScript the package still ships, src/cli/index.ts,
//! so nothing changes for users.
//!
//! Native, on Linux and macOS: `open --print`, `init`, the token check of
//! `serve`, `dev` and `expose`, and `dev` registering with a live host
//! daemon. Each of them works out its whole answer first (what it prints,
//! what it writes), and declines (`HandBack`) before any of it shows. On
//! Windows everything is handed back.

mod js_fallback;

#[cfg(unix)]
mod args;
#[cfg(unix)]
mod commands;
#[cfg(unix)]
mod git;
#[cfg(unix)]
mod js;
#[cfg(unix)]
mod json;
#[cfg(unix)]
mod node;
#[cfg(unix)]
mod repo;
#[cfg(unix)]
mod runtime;
#[cfg(unix)]
mod token;

#[cfg(all(unix, test))]
mod compare;

/// The package's JavaScript entry, relative to the package root: what `bin`
/// in package.json names for both commands, run by bun (`#!/usr/bin/env
/// bun`). Users' service managers store this path; it must not move.
const JS_ENTRY: &str = "src/cli/index.ts";

/// `CODEHOST_NO_NATIVE=1` hands every command back to the JavaScript: the way
/// out for a user if a ported command misbehaves.
#[cfg_attr(not(unix), allow(dead_code))]
fn native() -> bool {
    std::env::var_os("CODEHOST_NO_NATIVE").is_none()
}

/// "Not mine": the invocation has to go to the JavaScript. Only ever
/// returned before the first output and the first change.
#[cfg(unix)]
#[derive(Debug, PartialEq)]
pub struct HandBack;

/// A change a command makes before it prints.
#[cfg(unix)]
pub enum Change {
    Mkdir(String),
    Write { path: String, content: String, executable: bool },
}

/// Everything a ported command does, worked out before any of it is done.
#[cfg(unix)]
#[derive(Default)]
pub struct Answer {
    pub changes: Vec<Change>,
    pub stderr: String,
    pub stdout: String,
    pub code: i32,
}

#[cfg(unix)]
impl Answer {
    pub fn out(stdout: String) -> Answer {
        Answer { stdout, ..Answer::default() }
    }
}

fn main() {
    // Arguments that are not valid UTF-8 are for the JavaScript to deal with.
    let args: Option<Vec<String>> = std::env::args_os().skip(1).map(|arg| arg.into_string().ok()).collect();
    #[cfg(unix)]
    if let (Some(args), true) = (&args, native()) {
        answer(args);
    }
    drop(args);
    js_fallback::run(JS_ENTRY)
}

/// Answers a ported command and ends the process, or returns for the
/// invocation to be handed back. A panic before anything has been done is a
/// hand-back too: a bug in a ported command must not cost the user their
/// command.
#[cfg(unix)]
fn answer(args: &[String]) {
    let report = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let outcome = std::panic::catch_unwind(|| {
        let command = commands::recognise(args).ok_or(HandBack)?;
        let machine = runtime::machine()?;
        command.run(&machine)
    });
    std::panic::set_hook(report);
    if let Ok(Ok(answer)) = outcome {
        finish(answer);
    }
}

/// Makes the changes, then prints, then exits. If the first change cannot
/// be made nothing has happened yet, and the invocation still goes back;
/// after that there is no way back.
#[cfg(unix)]
fn finish(answer: Answer) {
    use std::io::Write as _;

    let mut changed = false;
    for change in &answer.changes {
        if let Err(err) = make(change, &mut changed) {
            if !changed {
                return;
            }
            let path = match change {
                Change::Mkdir(path) | Change::Write { path, .. } => path,
            };
            eprintln!(
                "[codehost] could not write {path}: {err}. Nothing more was done; run the command again with CODEHOST_NO_NATIVE=1 for the JavaScript's own report."
            );
            std::process::exit(1);
        }
    }
    // In the order the TypeScript writes them; a reader that has gone away
    // is not an error, as it is not for bun.
    let _ = std::io::stderr().write_all(answer.stderr.as_bytes());
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(answer.stdout.as_bytes()).and_then(|()| stdout.flush());
    std::process::exit(answer.code)
}

#[cfg(unix)]
fn make(change: &Change, changed: &mut bool) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::PermissionsExt as _;

    match change {
        // mkdirSync: mode 0777 less the umask.
        Change::Mkdir(path) => {
            std::fs::create_dir(path)?;
            *changed = true;
        }
        // writeFileSync: mode 0666 less the umask for a new file; then
        // chmodSync(path, 0o755) for the hook, its failure ignored.
        Change::Write { path, content, executable } => {
            let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(path)?;
            *changed = true;
            file.write_all(content.as_bytes())?;
            drop(file);
            if *executable {
                let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
            }
        }
    }
    Ok(())
}
