//! What the TypeScript asks of Node's API, on Unix: `path.resolve`,
//! `os.hostname()`, `process.kill(pid, 0)`, and whether a directory can be
//! written into (which the JavaScript finds out by trying).

use std::ffi::{c_char, c_int, CString};

/// `path.resolve(cwd, path)` on POSIX: purely by the text, links are not
/// followed.
pub fn resolve(cwd: &str, path: &str) -> String {
    let joined = if path.starts_with('/') { path.to_string() } else { format!("{cwd}/{path}") };
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

/// `path.join(dir, name)` for a `dir` that `resolve` gave.
pub fn join(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

extern "C" {
    fn gethostname(name: *mut c_char, len: usize) -> c_int;
    fn kill(pid: i32, sig: c_int) -> c_int;
    fn access(path: *const c_char, mode: c_int) -> c_int;
}

const W_OK: c_int = 2;
const X_OK: c_int = 1;

/// `os.hostname()`, when it is UTF-8.
pub fn hostname() -> Option<String> {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer is as long as said; the result is checked.
    let status = unsafe { gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    if status != 0 {
        return None;
    }
    let end = buffer.iter().position(|&b| b == 0)?;
    String::from_utf8(buffer[..end].to_vec()).ok()
}

/// `process.kill(pid, 0)` does not throw: the process exists and this user
/// may signal it.
pub fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 sends nothing; it only checks.
    unsafe { kill(pid, 0) == 0 }
}

/// Whether new entries can be made in the directory `dir`.
pub fn writable_dir(dir: &str) -> bool {
    let Ok(path) = CString::new(dir) else { return false };
    // SAFETY: a valid C string; `access` only reads it.
    unsafe { access(path.as_ptr(), W_OK | X_OK) == 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_like_node() {
        assert_eq!(resolve("/a/b", "."), "/a/b");
        assert_eq!(resolve("/a/b", "c//d/./e/"), "/a/b/c/d/e");
        assert_eq!(resolve("/a/b", "../../../x"), "/x");
        assert_eq!(resolve("/a/b", "/x/../y"), "/y");
        assert_eq!(resolve("/a/b", ""), "/a/b");
        assert_eq!(resolve("/", ".."), "/");
        assert_eq!(join("/", ".codehost"), "/.codehost");
        assert_eq!(join("/a", ".codehost"), "/a/.codehost");
    }
}
