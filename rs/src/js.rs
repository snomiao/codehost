//! The parts of JavaScript's string semantics that decide what the ported
//! commands print. Each function names the JavaScript it stands for; the
//! comparison test (`compare.rs`) runs them against bun.

/// ECMAScript's WhiteSpace and LineTerminator: what `String.prototype.trim`
/// removes and what `\s` matches. Not Rust's `char::is_whitespace`, which
/// takes U+0085 and leaves U+FEFF.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// What `.` in a regular expression does not match.
pub fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `text.trim()`
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `text.length`: UTF-16 code units.
pub fn length(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `encodeURIComponent(text)`. A Rust string has no lone surrogate, the one
/// input for which JavaScript throws.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `text.toLowerCase()` where both agree: ASCII. Anything else is left to
/// the JavaScript (`None`), since the two Unicode tables need not be of the
/// same version.
pub fn ascii_lower(text: &str) -> Option<String> {
    text.is_ascii().then(|| text.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_is_javascripts() {
        assert_eq!(trim("\u{feff} a \u{3000}"), "a");
        assert_eq!(trim("\u{85}a\u{85}"), "\u{85}a\u{85}");
        assert_eq!(trim("\u{180e}a"), "\u{180e}a");
        assert_eq!(trim(" \t\n\u{b}\u{c}\r"), "");
    }

    #[test]
    fn length_counts_utf16_units() {
        assert_eq!(length("abc"), 3);
        assert_eq!(length("é"), 1);
        assert_eq!(length("😀"), 2);
    }

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_uri_component("a b/c+ü"), "a%20b%2Fc%2B%C3%BC");
        assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
        assert_eq!(encode_uri_component("#?&=%"), "%23%3F%26%3D%25");
    }
}
