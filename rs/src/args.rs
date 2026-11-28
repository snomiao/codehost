//! The spellings of a command line the binary answers itself. yargs 17 (with
//! `.strict()`) accepts many more, and answers some with help or an error in
//! the user's language; every line outside this subset is `None` and goes to
//! the JavaScript.
//!
//! Accepted: `--name value`, `--name=value`, `-x value` for an option with a
//! value; `--name` and `-x` for a flag; positionals up to the command's count.
//! Each option at most once, under whichever of its names.
//!
//! Not accepted, among others: `--flag=…`, `--no-flag`, `-xvalue`, `-x=value`,
//! grouped short flags, a separate value that starts with `-`, `--`, a
//! repeated option, an option yargs does not know (strict mode), and any word
//! `help` (yargs prints the help when it is the last word, in the user's
//! language), `true` or `false` (yargs takes them as the value of a flag
//! before them: `open --print false` opens the browser).

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Flag,
    Value,
}

pub struct Opt {
    pub long: &'static str,
    pub short: Option<char>,
    pub kind: Kind,
}

pub const fn flag(long: &'static str, short: Option<char>) -> Opt {
    Opt { long, short, kind: Kind::Flag }
}

pub const fn value(long: &'static str, short: Option<char>) -> Opt {
    Opt { long, short, kind: Kind::Value }
}

pub struct Parsed {
    pub positionals: Vec<String>,
    /// By long name: `None` for a flag, the value for an option with one.
    given: Vec<(&'static str, Option<String>)>,
}

impl Parsed {
    pub fn has(&self, long: &str) -> bool {
        self.given.iter().any(|(name, _)| *name == long)
    }

    pub fn value(&self, long: &str) -> Option<&str> {
        self.given.iter().find(|(name, _)| *name == long).and_then(|(_, value)| value.as_deref())
    }
}

pub fn parse(args: &[String], opts: &[Opt], max_positionals: usize) -> Option<Parsed> {
    if args.iter().any(|arg| matches!(arg.as_str(), "help" | "true" | "false" | "--")) {
        return None;
    }
    let mut parsed = Parsed { positionals: Vec::new(), given: Vec::new() };
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let (opt, inline) = if let Some(body) = arg.strip_prefix("--") {
            let (name, inline) = match body.split_once('=') {
                Some((name, value)) => (name, Some(value)),
                None => (body, None),
            };
            (opts.iter().find(|opt| opt.long == name)?, inline)
        } else if let Some(body) = arg.strip_prefix('-') {
            let mut chars = body.chars();
            let (Some(short), None) = (chars.next(), chars.next()) else { return None };
            (opts.iter().find(|opt| opt.short == Some(short))?, None)
        } else {
            if parsed.positionals.len() == max_positionals {
                return None;
            }
            parsed.positionals.push(arg.clone());
            continue;
        };
        if parsed.has(opt.long) {
            return None;
        }
        let value = match (opt.kind, inline) {
            (Kind::Flag, None) => None,
            (Kind::Flag, Some(_)) => return None,
            // `--name=-x` is how yargs is given a value that starts with `-`;
            // whether it then reads `--name=--help` as help was not tried.
            (Kind::Value, Some(value)) if value.starts_with('-') => return None,
            (Kind::Value, Some(value)) => Some(value.to_string()),
            (Kind::Value, None) => {
                let value = rest.next()?;
                if value.starts_with('-') {
                    return None;
                }
                Some(value.clone())
            }
        };
        parsed.given.push((opt.long, value));
    }
    Some(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPEN: [Opt; 4] = [value("token", Some('t')), flag("anon", None), value("page", None), flag("print", None)];

    fn words(line: &str) -> Vec<String> {
        line.split(' ').filter(|w| !w.is_empty()).map(String::from).collect()
    }

    fn accepts(line: &str) -> bool {
        parse(&words(line), &OPEN, 1).is_some()
    }

    #[test]
    fn plain_spellings_are_accepted() {
        for line in ["--print", "--print a/b", "a/b --print -t x", "--token=x --page=y --anon --print z", "--token= --print", "--page https://x.dev --print"] {
            assert!(accepts(line), "{line}");
        }
        let parsed = parse(&words("--token=a=b x --print"), &OPEN, 1).unwrap();
        assert_eq!(parsed.value("token"), Some("a=b"));
        assert_eq!(parsed.positionals, ["x"]);
        assert!(parsed.has("print") && !parsed.has("anon"));
    }

    #[test]
    fn everything_else_goes_back() {
        for line in [
            "--print false", "--print true", "--print=true", "--print=false", "--no-print", "--print --print", "-t a --token b",
            "--print help", "help --print", "--print --help", "--print -h", "--print --version", "--print -- a", "--print a b",
            "--print -tabc", "--print -t=abc", "--print -t -x", "--print -t", "--print --tok x", "--print --Print", "--print -",
            "--print --token=-x", "--print --unknown", "--print -x",
        ] {
            assert!(!accepts(line), "{line}");
        }
    }
}
