//! Deep links and repository keys: src/shared/repo.ts (`gitUrlToPath`,
//! `shareableDeepLink`, `toPosixPath`) and `parseGitRemote` of
//! src/cli/git.ts.
//!
//! Each regular expression is matched by hand, with the result a
//! backtracking engine gives; the comments quote the expression. A JavaScript
//! expression without the `u` flag works on UTF-16 units, and the negated
//! ASCII classes used here match both halves of a pair alike, so matching
//! on characters gives the same captures. `.` does not match a line
//! terminator (`js::is_line_terminator`), `\d` is ASCII, and the `i` flag
//! folds ASCII letters only.
//!
//! A host is lower-cased by `toLowerCase()`; one that is not ASCII is
//! `Err(HandBack)`.

use crate::js;
use crate::HandBack;

/// `(.+)$`: the rest of the text, when it is not empty and has no line terminator.
fn dot_plus(rest: &str) -> Option<&str> {
    (!rest.is_empty() && !rest.chars().any(js::is_line_terminator)).then_some(rest)
}

/// `(?:\/tree\/(.+))?$` at the end of a match: `Some(None)` when nothing is
/// left, `Some(Some(branch))` for `/tree/<branch>`.
pub fn tree_tail(tail: &str) -> Option<Option<&str>> {
    if tail.is_empty() {
        return Some(None);
    }
    dot_plus(tail.strip_prefix("/tree/")?).map(Some)
}

/// `^[^@/]+@`: the length of a leading `user@`, if there is one.
fn user_prefix(text: &str) -> Option<usize> {
    let at = text.find(['@', '/'])?;
    (at > 0 && text.as_bytes()[at] == b'@').then_some(at + 1)
}

/// `^[a-z][a-z0-9+.-]*:\/\/` with the `i` flag: the length of a leading scheme.
fn scheme_prefix(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    if !bytes.first()?.is_ascii_alphabetic() {
        return None;
    }
    let end = 1 + bytes[1..].iter().take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-')).count();
    text[end..].starts_with("://").then_some(end + 3)
}

fn lower(host: &str) -> Result<String, HandBack> {
    js::ascii_lower(host).ok_or(HandBack)
}

/// `shareableDeepLink({ repo, branch })` for a repo key of three parts.
pub fn repo_link(repo: &str, branch: Option<&str>) -> Option<String> {
    let mut parts = repo.split('/');
    let (host, owner, name) = (parts.next()?, parts.next()?, parts.next()?);
    if host.is_empty() || owner.is_empty() || name.is_empty() {
        return None;
    }
    let base = format!("/{host}/{owner}/{name}");
    Some(match branch.filter(|b| !b.is_empty()) {
        Some(branch) => format!("{base}/tree/{branch}"),
        None => base,
    })
}

/// `shareableDeepLink({ folder, host })`: `/<user>@<machine>/<path>` with an
/// empty user, or `/dev/<path>` when no machine is known.
pub fn folder_link(folder: &str, host: &str) -> String {
    let path = folder.trim_start_matches('/');
    if host.is_empty() {
        format!("/dev/{path}")
    } else {
        format!("/@{}/{path}", js::encode_uri_component(host))
    }
}

/// `gitUrlToPath(input)`
pub fn git_url_to_path(input: &str) -> Result<Option<String>, HandBack> {
    let mut s: &str = js::trim(input);
    if s.is_empty() {
        return Ok(None);
    }
    if let Some(n) = scheme_prefix(s) {
        s = &s[n..];
    }
    if let Some(n) = user_prefix(s) {
        s = &s[n..];
    }
    // `s.replace(/^([^/:]+):(?!\d)/, "$1/")`
    let scp;
    if let Some(i) = s.find(['/', ':']) {
        if i > 0 && s.as_bytes()[i] == b':' && !s[i + 1..].starts_with(|c: char| c.is_ascii_digit()) {
            scp = format!("{}/{}", &s[..i], &s[i + 1..]);
            s = &scp;
        }
    }
    // `s.split(/[?#]/)[0].replace(/\/+$/, "")`
    let s = s.find(['?', '#']).map_or(s, |i| &s[..i]).trim_end_matches('/');
    // `/^([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/(.+))?$/`
    let Some((m1, rest)) = s.split_once('/') else { return Ok(None) };
    let Some((m2, rest)) = rest.split_once('/') else { return Ok(None) };
    if m1.is_empty() || m2.is_empty() {
        return Ok(None);
    }
    let end = rest.find('/').unwrap_or(rest.len());
    let (segment, tail) = rest.split_at(end);
    let Some(branch) = tree_tail(tail) else { return Ok(None) };
    if segment.is_empty() {
        return Ok(None);
    }
    // The lazy `([^/]+?)` stops before a final `.git` when something is left.
    let name = match segment.strip_suffix(".git") {
        Some(name) if !name.is_empty() => name,
        _ => segment,
    };
    let host = lower(m1)?;
    if !host.contains('.') {
        return Ok(None);
    }
    Ok(repo_link(&format!("{host}/{m2}/{name}"), branch))
}

/// `[^/:]+` up to a `:` and `(.+)$` after it.
fn scp_host_path(text: &str) -> Option<(&str, &str)> {
    let colon = text.find(['/', ':'])?;
    if colon == 0 || text.as_bytes()[colon] != b':' {
        return None;
    }
    dot_plus(&text[colon + 1..]).map(|path| (&text[..colon], path))
}

/// `([^/:]+)(?::\d+)?\/(.+)$`
fn uri_host_path(text: &str) -> Option<(&str, &str)> {
    let end = text.find(['/', ':']).unwrap_or(text.len());
    if end == 0 {
        return None;
    }
    let (host, rest) = text.split_at(end);
    let rest = match rest.strip_prefix(':') {
        Some(port) => {
            let digits = port.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                return None;
            }
            port[digits..].strip_prefix('/')?
        }
        None => rest.strip_prefix('/')?,
    };
    dot_plus(rest).map(|path| (host, path))
}

/// `(?:[^@/]+@)?` in front of `then`: with the user first, then without.
fn with_optional_user<'a>(text: &'a str, then: fn(&'a str) -> Option<(&'a str, &'a str)>) -> Option<(&'a str, &'a str)> {
    if let Some(n) = user_prefix(text) {
        if let Some(found) = then(&text[n..]) {
            return Some(found);
        }
    }
    then(text)
}

/// `parseGitRemote(url)`: `<lower-cased host>/<owner>/<repo>`.
pub fn parse_git_remote(url: &str) -> Result<Option<String>, HandBack> {
    let u = js::trim(url);
    if u.is_empty() {
        return Ok(None);
    }
    // `u.replace(/\.git\/?$/i, "")`
    let bytes = u.as_bytes();
    let n = bytes.len();
    let cut = if n >= 5 && bytes[n - 1] == b'/' && bytes[n - 5..n - 1].eq_ignore_ascii_case(b".git") {
        n - 5
    } else if n >= 4 && bytes[n - 4..].eq_ignore_ascii_case(b".git") {
        n - 4
    } else {
        n
    };
    let u = &u[..cut];
    // uri: /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i
    // scp: /^(?:[^@/]+@)?([^/:]+):(.+)$/, used only without `://`
    let uri = scheme_prefix(u).and_then(|n| with_optional_user(&u[n..], uri_host_path));
    let found = match uri {
        Some(found) => Some(found),
        None if !u.contains("://") => with_optional_user(u, scp_host_path),
        None => None,
    };
    let Some((host, path)) = found else { return Ok(None) };
    let mut segments = path.trim_start_matches('/').split('/').filter(|s| !s.is_empty());
    let (Some(owner), Some(name)) = (segments.next(), segments.next()) else { return Ok(None) };
    Ok(Some(format!("{}/{owner}/{name}", lower(host)?)))
}

/// `toPosixPath(p)`
pub fn to_posix_path(p: &str) -> String {
    // /^([A-Za-z]):(?:[\\/](.*))?$/
    let bytes = p.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let rest = &p[2..];
        let tail = if rest.is_empty() {
            Some("")
        } else if rest.starts_with(['\\', '/']) && !rest[1..].chars().any(js::is_line_terminator) {
            Some(&rest[1..])
        } else {
            None
        };
        if let Some(tail) = tail {
            let tail = tail.replace('\\', "/");
            let tail = tail.trim_end_matches('/');
            let letter = &p[..1];
            return if tail.is_empty() { format!("/{letter}:") } else { format!("/{letter}:/{tail}") };
        }
    }
    p.replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(input: &str) -> Option<String> {
        git_url_to_path(input).unwrap()
    }

    fn remote(input: &str) -> Option<String> {
        parse_git_remote(input).unwrap()
    }

    // The expectations of src/shared/repo.test.ts.
    #[test]
    fn parse_git_remote_as_repo_test_ts() {
        assert_eq!(remote("https://github.com/snomiao/codehost.git").as_deref(), Some("github.com/snomiao/codehost"));
        assert_eq!(remote("git@github.com:snomiao/codehost.git").as_deref(), Some("github.com/snomiao/codehost"));
        assert_eq!(remote("ssh://git@github.com/snomiao/codehost").as_deref(), Some("github.com/snomiao/codehost"));
        assert_eq!(remote("https://gitlab.com/group/proj.git").as_deref(), Some("gitlab.com/group/proj"));
        assert_eq!(remote("git@bitbucket.org:team/repo.git").as_deref(), Some("bitbucket.org/team/repo"));
        assert_eq!(remote("ssh://git@git.company.com:2222/team/svc.git").as_deref(), Some("git.company.com/team/svc"));
        assert_eq!(remote("https://GitHub.com/Owner/Repo").as_deref(), Some("github.com/Owner/Repo"));
        assert_eq!(remote("https://gitlab.com/group/sub/proj.git").as_deref(), Some("gitlab.com/group/sub"));
        assert_eq!(remote(""), None);
        assert_eq!(remote("not a url"), None);
        assert_eq!(remote("https://github.com/onlyowner"), None);
    }

    #[test]
    fn git_url_to_path_as_repo_test_ts() {
        assert_eq!(link("https://github.com/snomiao/codehost").as_deref(), Some("/github.com/snomiao/codehost"));
        assert_eq!(link("https://github.com/snomiao/codehost.git").as_deref(), Some("/github.com/snomiao/codehost"));
        assert_eq!(link("https://github.com/snomiao/codehost/tree/feat/x?y=1#z").as_deref(), Some("/github.com/snomiao/codehost/tree/feat/x"));
        assert_eq!(link("git@gitlab.com:group/proj.git").as_deref(), Some("/gitlab.com/group/proj"));
        assert_eq!(link("GitHub.com/a/b/").as_deref(), Some("/github.com/a/b"));
        assert_eq!(link("a/b/c"), None);
        assert_eq!(link("https://localhost:8080/a/b"), None);
        assert_eq!(link("https://github.com:443/a/b").as_deref(), Some("/github.com:443/a/b"));
        assert_eq!(link("x.y/a/b.git.git").as_deref(), Some("/x.y/a/b.git"));
        assert_eq!(link("x.y/a/.git").as_deref(), Some("/x.y/a/.git"));
        assert_eq!(link("x.y/a/b/tree"), None);
        assert_eq!(link("x.y/a/b/tree/a\nb"), None);
    }

    #[test]
    fn to_posix_path_as_repo_test_ts() {
        for (from, to) in [
            ("C:\\ws", "/C:/ws"),
            ("C:\\Users\\taku", "/C:/Users/taku"),
            ("c:\\ws", "/c:/ws"),
            ("C:\\", "/C:"),
            ("C:", "/C:"),
            ("C:/ws", "/C:/ws"),
            ("/Users/sno/ws", "/Users/sno/ws"),
            ("/", "/"),
            ("/C:/ws", "/C:/ws"),
            ("C:\\ws\\", "/C:/ws"),
        ] {
            assert_eq!(to_posix_path(from), to, "{from}");
        }
    }

    #[test]
    fn folder_links() {
        assert_eq!(folder_link("/C:/ws", "EC2AMAZ-PH8C4K1"), "/@EC2AMAZ-PH8C4K1/C:/ws");
        assert_eq!(folder_link("/C:/ws", ""), "/dev/C:/ws");
        assert_eq!(folder_link("/a b", "my host"), "/@my%20host/a b");
    }
}
