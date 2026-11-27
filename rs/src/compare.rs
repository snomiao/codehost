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
use crate::{commands::open, js, repo, runtime, token};

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
    // Command lines for the argument gate, from words its rules care about.
    const COMMANDS: &[&str] = &["open", "open", "open", "init", "init", "serve", "dev", "dev", "expose"];
    const WORDS: &[&str] = &[
        "--print", "--print", "--anon", "-t", "--token", "--token=x y", "--token=", "--page", "--page=http://p.dev/", "-f", "--force",
        "--name", "--signal", "ws://127.0.0.1:1", "--port", "8080", "08080", "abc", "--approve", "auto", "confirm", "maybe",
        "--standalone", "-d", "--allow", "o/r", "a b", "", " ", "-", "--", "help", "true", "false", "--help", "-h", "--version",
        "-x", "--unknown", "1e3", "0x10", "-5", "--no-print", "--print=true", "-tabc", "-t=abc", "--Token", "é", "dir", "short",
        "Changeme1234", "--anon=false", "-f=x", "--token=-x", "70000", "null", "undefined", "__proto__", "constructor",
    ];
    const PLAIN: &[&str] = &[
        "--print", "--print", "--anon", "-t", "--token", "x y", "--token=x y", "--page", "--page=http://p.dev/", "https://p.dev//", "-f",
        "--force", "--name", "n", "--signal", "ws://127.0.0.1:1", "--port", "8080", "--approve", "auto", "confirm", "--standalone",
        "o/r", "dir", "short", "Changeme1234", "a b", "é", "1e3",
    ];
    let lines: Vec<Vec<String>> = (0..20000)
        .map(|_| {
            let mut line = vec![COMMANDS[random.below(COMMANDS.len())].to_string()];
            for _ in 0..random.below(7) {
                let pool = if random.below(4) == 0 { WORDS } else { PLAIN };
                line.push(pool[random.below(pool.len())].to_string());
            }
            line
        })
        .collect();
    let line_lists: Vec<String> = lines.iter().map(|line| quoted(line)).collect();

    let request = format!(
        "{{\"urls\":{},\"texts\":{},\"folders\":[{}],\"targets\":[{}],\"lines\":[{}]}}",
        quoted(&urls),
        quoted(&tokens),
        folder_pairs.join(","),
        target_triples.join(","),
        line_lists.join(",")
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
    // Every line the binary takes, yargs takes too (no error, no help, no
    // version), and gives the command the same values.
    let mut taken = 0;
    for (line, theirs) in lines.iter().zip(texts(answer("parsed"))) {
        if let Some(command) = crate::commands::recognise(line) {
            assert_eq!(Some(command.describe()), theirs, "the command line {line:?}");
            taken += 1;
        }
    }
    println!("{taken} of {} generated command lines taken by the binary, each parsed alike by yargs", lines.len());
    assert!(taken >= 1000, "only {taken} command lines taken");
    println!("{compared} answers compared, {declined} declined (handed back)");
    assert!(declined * 50 < compared, "too many declined: {declined} of {}", compared + declined);
}

// ── what bun reads before the program: project files and .env ──────────────

/// Runs `bun <entry>` in each of `dirs` (each holding the files of one
/// input), three at a time, with nothing in the environment but PATH, HOME,
/// TMPDIR and `env`, and returns what each printed (stdout, stderr).
fn bun_in_each(dirs: &[std::path::PathBuf], entry: &Path, home: &Path, env: &[(&str, &str)]) -> Vec<(String, String)> {
    let run = |dir: &Path| {
        let mut command = Command::new("bun");
        command
            .arg(entry)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", home)
            .env("TMPDIR", home)
            .current_dir(dir)
            .stdin(Stdio::null());
        for (name, value) in env {
            command.env(name, value);
        }
        let output = command.output().expect("this test needs bun on PATH");
        assert!(output.status.success(), "bun failed in {}: {}", dir.display(), String::from_utf8_lossy(&output.stderr));
        (String::from_utf8_lossy(&output.stdout).into_owned(), String::from_utf8_lossy(&output.stderr).into_owned())
    };
    let chunk = dirs.len().div_ceil(3).max(1);
    std::thread::scope(|scope| {
        let workers: Vec<_> = dirs.chunks(chunk).map(|part| scope.spawn(move || part.iter().map(|dir| run(dir)).collect::<Vec<_>>())).collect();
        workers.into_iter().flat_map(|worker| worker.join().unwrap()).collect()
    })
}

/// A directory of its own under the temp directory, removed by the caller.
fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("codehost-compare-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("home")).unwrap();
    std::fs::create_dir_all(dir.join("entry")).unwrap();
    dir
}

fn pick<'a>(random: &mut Random, items: &[&'a str]) -> &'a str {
    items[random.below(items.len())]
}

/// `"key": value` members, each with the given chance, in a JSON object.
fn object(random: &mut Random, members: &[(&str, &[&str])], chance: usize) -> String {
    let mut chosen: Vec<String> = Vec::new();
    for (key, values) in members {
        if random.below(100) < chance {
            chosen.push(format!("{}: {}", json::stringify_str(key), pick(random, values)));
        }
    }
    format!("{{{}}}", chosen.join(", "))
}

/// Every package.json, tsconfig.json or jsconfig.json the binary takes for
/// one bun says nothing about. Generates some hundreds from the shapes bun
/// checks (rs/src/runtime.rs), has bun 1.4.0 start beside each, and
/// requires an empty standard error wherever `plain_project_file` says yes.
#[test]
fn project_files_the_binary_accepts_are_quiet_in_bun() {
    let mut random = Random(0x2545_f491_4f6c_dd1d);
    const TARGETS: &[&str] = &["\"./src/*\"", "\"../x/*\"", "\"src/*\"", "\"*\"", "\"*/*\"", "\"./a/*/b/*\"", "\".\"", "\"..\"", "\".\\\\x\"", "\"C:/x\"", "\"\"", "\"/abs/*\"", "\"./x\"", "5"];
    const KEYS: &[&str] = &["@/*", "*", "a*b*", "x", "", "~/*", "**", "@app/*", "./*"];
    const FACTORIES: &[&str] = &[
        "\"React.createElement\"", "\"h\"", "\"a-b\"", "\"a b\"", "\"a.\"", "\".a\"", "\"a..b\"", "\"\"", "\"1x\"", "\"$\"", "\"_a.$b\"", "\"class\"", "\"é\"",
        "\"a.b.c\"", "\"a.1\"", "5", "null",
    ];
    let mut files: Vec<(&str, String)> = Vec::new();
    for _ in 0..360 {
        let name = pick(&mut random, &["tsconfig.json", "tsconfig.json", "jsconfig.json"]);
        let paths: Vec<String> = (0..random.below(4))
            .map(|_| {
                let value = match random.below(8) {
                    0 => pick(&mut random, &["\"./x\"", "5", "null", "{}"]).to_string(),
                    _ => format!("[{}]", (0..random.below(4)).map(|_| pick(&mut random, TARGETS)).collect::<Vec<_>>().join(", ")),
                };
                format!("{}: {value}", json::stringify_str(pick(&mut random, KEYS)))
            })
            .collect();
        let mut options = object(
            &mut random,
            &[
                ("baseUrl", &["\".\"", "\"\"", "\"./src\"", "5", "null", "\"src\""]),
                ("jsxFactory", FACTORIES),
                ("jsxFragmentFactory", FACTORIES),
                ("jsx", &["\"react-jsx\"", "\"weird\"", "5"]),
                ("strict", &["true"]),
                ("importsNotUsedAsValues", &["\"remove\"", "\"x\""]),
            ],
            35,
        );
        if random.below(4) != 0 {
            options.insert_str(1, &format!("\"paths\": {{{}}}{}", paths.join(", "), if options.len() > 2 { ", " } else { "" }));
        }
        let content = match random.below(20) {
            0 => format!("{{\"extends\": \"./base.json\", \"compilerOptions\": {options}}}"),
            1 => "{\"compilerOptions\": 5}".to_string(),
            _ => format!("// generated\n{{\"compilerOptions\": {options},}}\n"),
        };
        files.push((name, content));
    }
    const EXPORTS: &[&str] = &[
        "\"./x.js\"", "{\".\": \"./a.js\"}", "{\"./a\": {\"import\": \"./a.js\", \"default\": \"./b.js\"}}", "{\"import\": \"./a.js\"}",
        "{\".\": \"./a.js\", \"x\": \"./b\"}", "{\"./a\": 5}", "{\"./a\": [\"./x\"]}", "{\"./a\": null}", "{}", "5", "null", "[\"./x\"]",
    ];
    for _ in 0..240 {
        let content = object(
            &mut random,
            &[
                ("name", &["\"x\"", "\"@a/b\"", "5", "{}"]),
                ("version", &["\"1.0.0\"", "\"x\"", "1"]),
                ("type", &["\"module\"", "\"commonjs\"", "\"Module\"", "5", "null"]),
                ("main", &["\"./x.js\"", "5"]),
                ("exports", EXPORTS),
                ("imports", &["{\"#a\": \"./x.js\"}", "{\"a\": \"./x\"}", "{\"#a\": {\"node\": \"./x\"}}", "{\"#a\": 5}", "{}", "5", "{\"#a\": null}"]),
                ("browser", &["\"./b.js\"", "{\"./a\": false}", "{\"a\": \"./c\"}", "{\"a\": 5}", "{\"a\": true}", "5", "false"]),
                ("sideEffects", &["false", "[\"*.css\"]", "[5]", "\"x\""]),
                ("workspaces", &["[\"packages/*\"]", "5"]),
                ("dependencies", &["{\"a\": \"^1\"}", "{\"a\": 5}", "[]"]),
                ("scripts", &["{\"t\": \"x\"}", "5"]),
            ],
            30,
        );
        files.push(("package.json", content));
    }

    let base = scratch("project-files");
    let entry = base.join("entry").join("x.ts");
    std::fs::write(&entry, "").unwrap();
    let mut dirs = vec![base.join("empty")];
    std::fs::create_dir_all(&dirs[0]).unwrap();
    for (i, (name, content)) in files.iter().enumerate() {
        let dir = base.join(i.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), content).unwrap();
        dirs.push(dir);
    }
    let answers = bun_in_each(&dirs, &entry, &base.join("home"), &[]);
    std::fs::remove_dir_all(&base).unwrap();
    assert_eq!(answers[0], (String::new(), String::new()), "bun is not quiet in an empty directory here; the comparison needs one");
    let (mut accepted, mut warned) = (0, 0);
    for ((name, content), (_, stderr)) in files.iter().zip(&answers[1..]) {
        if !stderr.is_empty() {
            warned += 1;
        }
        if runtime::plain_project_file(name, content.as_bytes()) {
            accepted += 1;
            assert!(stderr.is_empty(), "the binary answers beside this {name}, but bun warns:\n{content}\n{stderr}");
        }
    }
    println!("{} project files: the binary accepts {accepted}, bun warns about {warned}", files.len());
    assert!(accepted >= 100 && warned >= 100, "too few of either to compare: {accepted} accepted, {warned} warned about");
}

/// What bun loads from a `.env` file, against what the binary looks for.
/// Generates some hundreds of files from the pieces bun's parser cares about
/// (blanks, `export`, `=` and `:`, quotes of three kinds, escapes, comments,
/// line ends of three kinds, also between a key and its `=`, `$` expansion),
/// and one file for every byte that is not a key character, put before a
/// key, inside it, between it and its `=`, and after its `:`. Has bun 1.4.0
/// print its environment beside each, and requires that every variable it
/// added is a name `dotenv_keys` found, and that the environment is
/// untouched wherever the binary would answer (`dotenv_changes_nothing`).
#[test]
fn dotenv_keys_cover_what_bun_loads() {
    let mut random = Random(0x9e37_79b9_7f4a_7c15 ^ 0xdead_beef);
    const KEYS: &[&str] = &["A", "B_1", "a.b", "x-y", "HOME", "PATH", "SET_X", "EMPTY_X", "export", "1", "_", "Q", "git_dir", "LD_X"];
    const BETWEEN: &[&str] = &[
        "=", "=", " = ", ": ", ":", " :", "\t=\t", " ", "==", ":\t", "\r=", "\n=", "\r\n=", "\x0b=", "\x0c =", " \n\t=", ":\n", "\n:\r",
    ];
    const VALUES: &[&str] = &[
        "1", "a b", "\"q\"", "'s'", "`b`", "\"multi\nline\"", "'multi\nC=3'", "$HOME", "${SET_X}", "x#y", "https://a.b/?c=d", "", "\"unterminated",
        "\\\"", "\"a\" B=2", "'x' Z: 1", "\"a\\\"b\" Y=1", "x # C=1", "\"#\"", "é", "\"\\n\"", "`x\ny`D=1",
    ];
    const BEFORE: &[&str] = &["", "", "  ", "export ", "\t", "# ", "export  ", "\u{feff}", "\x0b", "\x0c", "\r", "export\n"];
    const ENDS: &[&str] = &["\n", "\n", "\r\n", "\r", ""];
    let mut contents: Vec<Vec<u8>> = (0..400)
        .map(|_| {
            (0..1 + random.below(4))
                .map(|_| {
                    let parts = [pick(&mut random, BEFORE), pick(&mut random, KEYS), pick(&mut random, BETWEEN), pick(&mut random, VALUES), pick(&mut random, ENDS)];
                    parts.concat()
                })
                .collect::<String>()
                .into_bytes()
        })
        .collect();
    let key_byte = |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-');
    for byte in (0..=255u8).filter(|&byte| !key_byte(byte) && byte != b'=') {
        let mut content = Vec::new();
        for shape in [&b"\x00BYTE_BEFORE=v\n"[..], b"BYTE_\x00INSIDE=v\n", b"BYTE_BETWEEN\x00=v\n", b"BYTE_BETWEEN2\x00\x00=v\n", b"BYTE_COLON:\x00v\n"] {
            content.extend(shape.iter().map(|&b| if b == 0 { byte } else { b }));
        }
        contents.push(content);
    }
    // Files the binary answers beside, with keys that are all set already.
    for text in ["HOME\r=/x\n", "PATH\n=/y\n", "SET_X\r\n=2\n", "export HOME\n=1\nPATH :\t2\n", "# A=1\n", "\n\r\n\t\n", "SET_X=$HOME\r\nHOME='a'\n"] {
        contents.push(text.as_bytes().to_vec());
    }

    let base = scratch("dotenv");
    let entry = base.join("entry").join("env.ts");
    std::fs::write(&entry, "process.stdout.write(JSON.stringify(process.env));\n").unwrap();
    let mut dirs = vec![base.join("empty")];
    std::fs::create_dir_all(&dirs[0]).unwrap();
    for (i, content) in contents.iter().enumerate() {
        let dir = base.join(i.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".env"), content).unwrap();
        dirs.push(dir);
    }
    let given = [("SET_X", "1"), ("EMPTY_X", "")];
    let answers = bun_in_each(&dirs, &entry, &base.join("home"), &given);
    std::fs::remove_dir_all(&base).unwrap();
    let environment = |stdout: &str| match json::parse(stdout, false) {
        Some(Json::Obj(members)) => members.into_iter().filter(|(name, _)| name != "PWD" && name != "OLDPWD").collect::<Vec<_>>(),
        _ => panic!("bun printed no environment: {stdout}"),
    };
    let baseline = environment(&answers[0].0);
    let set = |name: &[u8]| baseline.iter().any(|(key, value)| key.as_bytes() == name && !matches!(value, Json::Str(text) if text.is_empty()));
    let (mut native, mut loaded) = (0, 0);
    for (content, (stdout, _)) in contents.iter().zip(&answers[1..]) {
        let after = environment(stdout);
        let keys = runtime::dotenv_keys(content);
        let shown = String::from_utf8_lossy(content);
        for (name, _) in after.iter().filter(|member| !baseline.contains(member)) {
            loaded += 1;
            assert!(keys.contains(&name.as_bytes()), "bun loaded {name:?} from this .env, which dotenv_keys does not find:\n{shown:?}");
        }
        if runtime::dotenv_changes_nothing(content, set) {
            native += 1;
            assert_eq!(after, baseline, "the binary answers beside this .env, but bun changed the environment:\n{shown:?}");
        }
    }
    println!("{} .env files: bun loaded {loaded} variables, the binary answers beside {native}", contents.len());
    assert!(loaded >= 300 && native >= 20, "too little to compare: {loaded} variables loaded, {native} files answered natively");
}
