//! The ported commands. `recognise` takes a command line the binary answers
//! itself, in a spelling it implements exactly; `None` sends it to the
//! JavaScript.

pub mod init;
pub mod open;
pub mod server;

use crate::runtime::Machine;
use crate::{Answer, HandBack};

pub enum Command {
    Open(open::Open),
    Init(init::Init),
    Server(server::Server),
}

pub fn recognise(args: &[String]) -> Option<Command> {
    let (name, rest) = args.split_first()?;
    match name.as_str() {
        "open" => open::recognise(rest).map(Command::Open),
        "init" => init::recognise(rest).map(Command::Init),
        "serve" => server::recognise(server::Kind::Serve, rest).map(Command::Server),
        "dev" => server::recognise(server::Kind::Dev, rest).map(Command::Server),
        "expose" => server::recognise(server::Kind::Expose, rest).map(Command::Server),
        _ => None,
    }
}

impl Command {
    /// What the command was given, in the form rs/parity/helpers.ts writes
    /// for yargs's parse of the same line (rs/src/compare.rs).
    #[cfg(test)]
    pub fn describe(&self) -> String {
        match self {
            Command::Open(open) => open.describe(),
            Command::Init(init) => init.describe(),
            Command::Server(server) => server.describe(),
        }
    }

    pub fn run(&self, machine: &Machine) -> Result<Answer, HandBack> {
        match self {
            Command::Open(open) => open.run(machine),
            Command::Init(init) => init.run(machine),
            Command::Server(server) => server.run(machine),
        }
    }
}
