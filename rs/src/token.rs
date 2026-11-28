//! The room-token policy (src/shared/token.ts), which the page and the
//! signaling Worker enforce with the same function: the verdict here has to
//! be theirs, so lengths are JavaScript's (UTF-16 units) and whitespace is
//! JavaScript's `\s`.

/// `TOKEN_REQUIREMENTS`
pub const REQUIREMENTS: &str = "at least 12 characters, no spaces, mixing at least 3 of: lowercase, uppercase, digits, symbols";

const MIN_LENGTH: usize = 12;
const MAX_LENGTH: usize = 256;
const MIN_CHAR_CLASSES: usize = 3;
const WEAK_TOKENS: [&str; 4] = ["changeme1234", "password1234", "codehost1234", "letmein12345"];

/// `validateToken(token).reason`: why the policy rejects a token, or `None`
/// when it accepts it. The token is the trimmed one, as the callers pass it.
pub fn rejection(token: &str) -> Option<&'static str> {
    let length = crate::js::length(token);
    if length < MIN_LENGTH {
        return Some("token must be at least 12 characters");
    }
    if length > MAX_LENGTH {
        return Some("token must be at most 256 characters");
    }
    if token.chars().any(crate::js::is_space) {
        return Some("token must not contain whitespace");
    }
    // [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/]: ASCII classes; anything
    // else is a symbol.
    let classes = [
        token.bytes().any(|b| b.is_ascii_lowercase()),
        token.bytes().any(|b| b.is_ascii_uppercase()),
        token.bytes().any(|b| b.is_ascii_digit()),
        token.chars().any(|c| !c.is_ascii_alphanumeric()),
    ];
    if classes.iter().filter(|&&has| has).count() < MIN_CHAR_CLASSES {
        return Some("token must mix at least 3 of: lowercase, uppercase, digits, symbols");
    }
    // `WEAK_TOKENS.has(token.toLowerCase())`. Only ASCII lowers to these
    // ASCII words (the Kelvin sign lowers to `k`, which none of them has).
    if token.is_ascii() && WEAK_TOKENS.iter().any(|weak| token.eq_ignore_ascii_case(weak)) {
        return Some("token is too common; choose a unique secret");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_policy_of_the_worker() {
        assert_eq!(rejection("Aa1-aaaaaaa"), Some("token must be at least 12 characters"));
        assert_eq!(rejection("Aa1-aaaaaaaa"), None);
        assert_eq!(rejection(&format!("Aa1-{}", "a".repeat(252))), None);
        assert_eq!(rejection(&format!("Aa1-{}", "a".repeat(253))), Some("token must be at most 256 characters"));
        // Six emoji are twelve UTF-16 units, and symbols.
        assert_eq!(rejection("😀😀😀😀😀😀"), Some("token must mix at least 3 of: lowercase, uppercase, digits, symbols"));
        assert_eq!(rejection("😀😀😀😀😀a1"), None);
        assert_eq!(rejection("Aa1-aaaa\u{a0}aaaa"), Some("token must not contain whitespace"));
        assert_eq!(rejection("Aa1-aaaa\u{85}aaaa"), None);
        assert_eq!(rejection("Changeme1234"), Some("token is too common; choose a unique secret"));
        assert_eq!(rejection("changeme1234"), Some("token must mix at least 3 of: lowercase, uppercase, digits, symbols"));
    }
}
