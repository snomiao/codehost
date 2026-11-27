//! The helpers against the TypeScript they replace, input by input.
//!
//! Generates some thousands of strings from pieces that the regular
//! expressions and the token policy care about (schemes, `@`, `:`, ports,
//! `.git`, `/tree/`, `?` and `#`, every kind of JavaScript whitespace, line
//! terminators, non-ASCII and astral characters, the Kelvin sign), has bun
//! run src/shared/repo.ts, src/cli/git.ts, src/shared/token.ts and the
//! `buildUrl` of src/cli/commands/open.ts on them (rs/parity/helpers.ts),
//! and compares every answer. Where the Rust declines (a host that is not
//! ASCII), the case is counted, not compared: the binary hands those back.
//!
//! Needs bun on PATH and the repository's dependencies installed.

use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::json::{self, Json};
use crate::{commands::open, js, repo, token};

const PIECES: &[&str] = &[
    "https://", "http://", "HTTPS://", "ssh://", "git://", "git+ssh://", "file://", "x-y.z+1://", "://", "git@", "user:pw@", "@", "@@", "a@b",
    ":", ":22", ":443/", ":x", "/", "//", "///", "github.com", "GitHub.COM", "gitlab.com", "localhost", "a.b", "x.y.z", "host", "owner", "Repo",
    "repo", ".git", ".GIT", ".git/", "git", "/tree/", "tree/", "/tree", "feat/x", "main", "?", "?q=1", "#", "#frag", " ", "\t", "\n", "\r",
    "\u{b}", "\u{c}", "\u{a0}", "\u{1680}", "\u{2000}", "\u{200a}", "\u{2028}", "\u{2029}", "\u{202f}", "\u{205f}", "\u{3000}", "\u{feff}",
    "\u{85}", "\u{180e}", "\u{200b}", "ü", "É", "İ", "\u{212a}", "😀", "-", "_", ".", "~", "%", "+", "=", "\\", "C:", "c:\\", "D:/", "gh/",
    "git/", "host/", "dev/", "me@box", "@Mac", "0", "9", "12", "Aa1", "aA1-", "x", "Z", "changeme1234", "Changeme1234", "PASSWORD1234",
    "letmein12345", "codehost1234", "!", "'", "(", ")", "*", "\"", "\u{1}", "\u{7f}",
];

/// xorshift64*: the same strings on every run.
struct Random(u64);

impl Random {
    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 33) as usize % n
    }

    fn text(&mut self, max_pieces: usize) -> String {
        (0..1 + self.below(max_pieces)).map(|_| PIECES[self.below(PIECES.len())]).collect()
    }
}

fn quoted(items: &[String]) -> String {
    let parts: Vec<String> = items.iter().map(|item| json::stringify_str(item)).collect();
    format!("[{}]", parts.join(","))
}

fn texts(value: &Json) -> Vec<Option<String>> {
    let Json::Arr(items) = value else { panic!("not a list: {value:?}") };
    items
        .iter()
        .map(|item| match item {
            Json::Str(text) => Some(text.clone()),
            Json::Null => None,
            other => panic!("not a string: {other:?}"),
        })
        .collect()
}

fn numbers(value: &Json) -> Vec<usize> {
    let Json::Arr(items) = value else { panic!("not a list") };
    items.iter().map(|item| if let Json::Num(n) = item { n.parse().unwrap() } else { panic!("not a number") }).collect()
}

#[test]
fn helpers_answer_as_the_typescript_does() {
    let mut random = Random(0x9e37_79b9_7f4a_7c15);
    let mut urls: Vec<String> = (0..6000).map(|_| random.text(9)).collect();
    // The shapes users paste, so that most inputs reach the end of the rules.
    const NAMES: &[&str] = &["owner", "Repo", "a", "x-y", "_", ".", "ü", "😀", "0", "%", "+", "~", "'", "@", ":", " ", "\u{a0}", "git"];
    const TAILS: &[&str] = &["", "", ".git", ".git/", "/", "/tree/main", "/tree/feat/x", "/tree/", "/tree", "/x", "?q=1", "#f", ".GIT", "\n"];
    for _ in 0..4000 {
        let shape = [
            ["https://", "github.com", "/"],
            ["git@", "gitlab.com", ":"],
            ["ssh://git@", "x.y", ":22/"],
            ["", "host.dev", "/"],
            ["", "GitHub.COM", ":"],
            ["http://", "localhost", ":8080/"],
        ][random.below(6)];
        let name = |random: &mut Random| (0..1 + random.below(3)).map(|_| NAMES[random.below(NAMES.len())]).collect::<String>();
        let (owner, repo) = (name(&mut random), name(&mut random));
        let tail = TAILS[random.below(TAILS.len())];
        urls.push(format!("{}{}{}{owner}/{repo}{tail}", shape[0], shape[1], shape[2]));
    }
    let mut tokens: Vec<String> = (0..4000).map(|_| random.text(12)).collect();
    // Around the upper limit, in UTF-16 units: an astral character counts two.
    for n in 248..264 {
        tokens.push(format!("Aa1-{}", "x".repeat(n - 4)));
        tokens.push(format!("Aa1-{}{}", "😀".repeat((n - 4) / 2), "x".repeat((n - 4) % 2)));
        tokens.push(format!("Aa1-{}é", "x".repeat(n - 5)));
    }
    let folders: Vec<(String, String)> = (0..500).map(|_| (repo::to_posix_path(&random.text(5)), random.text(2))).collect();
    let mut targets: Vec<(String, Option<String>, String)> = Vec::new();
    for url in &urls {
        if js::trim(url).is_empty() {
            continue;
        }
        // A blank token would make buildUrl read the saved one.
        let token = match random.below(3) {
            0 => None,
            _ => Some(random.text(4)).filter(|t| !js::trim(t).is_empty()),
        };
        let page = ["https://codehost.dev", "https://x.dev///", "", "http://127.0.0.1:5173/"][random.below(4)].to_string();
        targets.push((url.clone(), token, page));
    }

    let folder_pairs: Vec<String> = folders.iter().map(|(f, h)| format!("[{},{}]", json::stringify_str(f), json::stringify_str(h))).collect();
    let target_triples: Vec<String> = targets
        .iter()
        .map(|(t, token, page)| {
            let token = token.as_deref().map_or("null".to_string(), json::stringify_str);
            format!("[{},{token},{}]", json::stringify_str(t), json::stringify_str(page))
        })
        .collect();
    let request = format!(
        "{{\"urls\":{},\"texts\":{},\"folders\":[{}],\"targets\":[{}]}}",
        quoted(&urls),
        quoted(&tokens),
        folder_pairs.join(","),
        target_triples.join(",")
    );

    let home = std::env::temp_dir().join(format!("codehost-compare-home-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("parity").join("helpers.ts");
    let mut child = Command::new("bun")
        .arg(&script)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", &home)
        .env("TMPDIR", &home)
        .current_dir(&home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("this test needs bun on PATH");
    child.stdin.take().unwrap().write_all(request.as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    std::fs::remove_dir_all(&home).unwrap();
    assert!(output.status.success(), "rs/parity/helpers.ts failed");
    let answers = json::parse(std::str::from_utf8(&output.stdout).unwrap(), false).expect("bun's answer is JSON");
    let answer = |name: &str| answers.get(name).unwrap_or_else(|| panic!("no {name}"));
    // A comparison of nothing but "no answer" would prove little.
    for (name, at_least) in [("gitUrlToPath", 2000), ("parseGitRemote", 2000), ("reason", 2000)] {
        let found = texts(answer(name)).iter().filter(|text| text.is_some()).count();
        assert!(found >= at_least, "only {found} answers of {name} are not null");
    }
    let accepted = texts(answer("reason")).iter().filter(|text| text.is_none()).count();
    assert!(accepted >= 300, "only {accepted} tokens are accepted by the policy");
    let distinct: std::collections::BTreeSet<_> = texts(answer("reason")).into_iter().collect();
    assert_eq!(distinct.len(), 6, "every verdict of the policy: {distinct:?}");

    let mut compared = 0;
    let mut declined = 0;
    let mut check = |what: &str, input: &str, ours: Result<Option<String>, crate::HandBack>, theirs: &Option<String>| match ours {
        Ok(ours) => {
            assert_eq!(&ours, theirs, "{what}({input:?})");
            compared += 1;
        }
        Err(_) => declined += 1,
    };
    for (url, theirs) in urls.iter().zip(texts(answer("gitUrlToPath"))) {
        check("gitUrlToPath", url, repo::git_url_to_path(url), &theirs);
    }
    for (url, theirs) in urls.iter().zip(texts(answer("parseGitRemote"))) {
        check("parseGitRemote", url, repo::parse_git_remote(url), &theirs);
    }
    for (path, theirs) in urls.iter().zip(texts(answer("toPosixPath"))) {
        check("toPosixPath", path, Ok(Some(repo::to_posix_path(path))), &theirs);
    }
    for ((folder, host), theirs) in folders.iter().zip(texts(answer("folderLink"))) {
        check("folderLink", folder, Ok(Some(repo::folder_link(folder, host))), &theirs);
    }
    for (text, theirs) in tokens.iter().zip(texts(answer("reason"))) {
        check("validateToken", text, Ok(token::rejection(js::trim(text)).map(String::from)), &theirs);
    }
    for (text, theirs) in tokens.iter().zip(texts(answer("trim"))) {
        check("trim", text, Ok(Some(js::trim(text).to_string())), &theirs);
    }
    for (text, theirs) in tokens.iter().zip(texts(answer("encoded"))) {
        check("encodeURIComponent", text, Ok(Some(js::encode_uri_component(text))), &theirs);
    }
    for (text, theirs) in tokens.iter().zip(numbers(answer("length"))) {
        assert_eq!(js::length(text), theirs, "length({text:?})");
    }
    for ((target, token, page), theirs) in targets.iter().zip(texts(answer("buildUrl"))) {
        let ours = open::url_for_target(js::trim(target), page, || Ok(token.as_deref().map(|t| js::trim(t).to_string())));
        check("buildUrl", target, ours.map(Some), &theirs);
    }
    println!("{compared} answers compared, {declined} declined (handed back)");
    assert!(declined * 50 < compared, "too many declined: {declined} of {}", compared + declined);
}
