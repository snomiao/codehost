//! A JSON reader that says "not sure" instead of guessing.
//!
//! Two readers stand behind the files the ported commands look at:
//! `JSON.parse` (~/.codehost/*.json) and bun's own parser (package.json,
//! tsconfig.json and jsconfig.json, read before the program starts). This
//! one accepts a subset of what both accept, so that whatever it reads, they
//! read the same way. Everything else is `None`, and the caller hands the
//! invocation back:
//!
//! - text that is not JSON, even where `JSON.parse` would read it as
//!   something (and where bun's parser is more lenient: single quotes, hex
//!   numbers);
//! - a key given twice in one object, at any depth (bun warns about it);
//! - a `\u` escape that is half of a surrogate pair (a string Rust cannot
//!   hold, and one `encodeURIComponent` throws on);
//! - a byte order mark, and nesting deeper than 256.
//!
//! With `lenient`, comments (`//` to the end of the line, `/* */`) and a comma
//! before `]` or `}` are accepted too, as bun accepts them in the files it
//! reads; a `//` comment holding a carriage return or U+2028/U+2029 is not,
//! since where bun ends such a line was not established.

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    /// The number as written.
    Num(String),
    Str(String),
    Arr(Vec<Json>),
    /// Members in the order written; keys are unique.
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(members) => members.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

const MAX_DEPTH: usize = 256;

pub fn parse(text: &str, lenient: bool) -> Option<Json> {
    let mut reader = Reader { text: text.as_bytes(), at: 0, lenient };
    reader.space()?;
    let value = reader.value(0)?;
    reader.space()?;
    (reader.at == reader.text.len()).then_some(value)
}

struct Reader<'a> {
    text: &'a [u8],
    at: usize,
    lenient: bool,
}

impl Reader<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    /// Whitespace as JSON has it (space, tab, CR, LF), and comments when lenient.
    fn space(&mut self) -> Option<()> {
        loop {
            match self.peek() {
                Some(b' ' | b'\t' | b'\n' | b'\r') => self.at += 1,
                Some(b'/') if self.lenient => match self.text.get(self.at + 1) {
                    Some(b'/') => {
                        let end = self.text[self.at..].iter().position(|&b| b == b'\n').map_or(self.text.len(), |p| self.at + p);
                        let comment = std::str::from_utf8(&self.text[self.at..end]).ok()?;
                        if comment.contains(['\r', '\u{2028}', '\u{2029}']) {
                            return None;
                        }
                        self.at = end;
                    }
                    Some(b'*') => {
                        let rest = &self.text[self.at + 2..];
                        let close = rest.windows(2).position(|w| w == b"*/")?;
                        self.at += 2 + close + 2;
                    }
                    _ => return None,
                },
                _ => return Some(()),
            }
        }
    }

    fn value(&mut self, depth: usize) -> Option<Json> {
        if depth > MAX_DEPTH {
            return None;
        }
        match self.peek()? {
            b'{' => {
                self.at += 1;
                let mut members: Vec<(String, Json)> = Vec::new();
                self.space()?;
                if self.eat(b'}') {
                    return Some(Json::Obj(members));
                }
                loop {
                    if self.peek()? != b'"' {
                        return None;
                    }
                    let key = self.string()?;
                    if members.iter().any(|(k, _)| *k == key) {
                        return None;
                    }
                    self.space()?;
                    if !self.eat(b':') {
                        return None;
                    }
                    self.space()?;
                    let value = self.value(depth + 1)?;
                    members.push((key, value));
                    self.space()?;
                    if self.eat(b'}') {
                        return Some(Json::Obj(members));
                    }
                    if !self.eat(b',') {
                        return None;
                    }
                    self.space()?;
                    if self.lenient && self.eat(b'}') {
                        return Some(Json::Obj(members));
                    }
                }
            }
            b'[' => {
                self.at += 1;
                let mut items = Vec::new();
                self.space()?;
                if self.eat(b']') {
                    return Some(Json::Arr(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.space()?;
                    if self.eat(b']') {
                        return Some(Json::Arr(items));
                    }
                    if !self.eat(b',') {
                        return None;
                    }
                    self.space()?;
                    if self.lenient && self.eat(b']') {
                        return Some(Json::Arr(items));
                    }
                }
            }
            b'"' => self.string().map(Json::Str),
            b't' => self.word("true", Json::Bool(true)),
            b'f' => self.word("false", Json::Bool(false)),
            b'n' => self.word("null", Json::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn word(&mut self, word: &str, value: Json) -> Option<Json> {
        if self.text[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            Some(value)
        } else {
            None
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Option<Json> {
        let start = self.at;
        self.eat(b'-');
        match self.peek()? {
            b'0' => self.at += 1,
            b'1'..=b'9' => {
                self.digits();
            }
            _ => return None,
        }
        if self.eat(b'.') && self.digits() == 0 {
            return None;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if !self.eat(b'+') {
                self.eat(b'-');
            }
            if self.digits() == 0 {
                return None;
            }
        }
        Some(Json::Num(std::str::from_utf8(&self.text[start..self.at]).ok()?.to_string()))
    }

    fn hex4(&mut self) -> Option<u32> {
        let digits = std::str::from_utf8(self.text.get(self.at..self.at + 4)?).ok()?;
        if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        self.at += 4;
        u32::from_str_radix(digits, 16).ok()
    }

    fn string(&mut self) -> Option<String> {
        self.at += 1; // the opening quote
        let mut out = String::new();
        loop {
            let start = self.at;
            while let Some(b) = self.peek() {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.at += 1;
            }
            out.push_str(std::str::from_utf8(&self.text[start..self.at]).ok()?);
            match self.peek()? {
                b'"' => {
                    self.at += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.at += 1;
                    let escaped = self.peek()?;
                    self.at += 1;
                    match escaped {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            let code = match unit {
                                0xd800..=0xdbff => {
                                    if !(self.eat(b'\\') && self.eat(b'u')) {
                                        return None;
                                    }
                                    let low = self.hex4()?;
                                    if !(0xdc00..=0xdfff).contains(&low) {
                                        return None;
                                    }
                                    0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)
                                }
                                0xdc00..=0xdfff => return None,
                                _ => unit,
                            };
                            out.push(char::from_u32(code)?);
                        }
                        _ => return None,
                    }
                }
                // A control character: not allowed unescaped.
                _ => return None,
            }
        }
    }
}

/// `JSON.stringify(text)`
pub fn stringify_str(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(pairs: &[(&str, Json)]) -> Json {
        Json::Obj(pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect())
    }

    #[test]
    fn reads_plain_json() {
        assert_eq!(parse(r#" {"a": [1, -2.5e3, true, null], "b": "x\u00e9\ud83d\ude00\n"} "#, false), Some(obj(&[
            ("a", Json::Arr(vec![Json::Num("1".into()), Json::Num("-2.5e3".into()), Json::Bool(true), Json::Null])),
            ("b", Json::Str("xé😀\n".into())),
        ])));
    }

    #[test]
    fn declines_what_it_is_not_sure_of() {
        for text in [
            "", "\u{feff}{}", "{\"a\":1,\"a\":2}", "{\"x\":{\"a\":1,\"a\":2}}", "\"\\ud800\"", "\"\\udc00\"", "01", "1.", ".5", "+1", "0x10",
            "'a'", "{a:1}", "[1,]", "{\"a\":1,}", "// c\n{}", "\"a\tb\"", "NaN", "[1 2]", "{} {}", "\"\\x\"",
        ] {
            assert_eq!(parse(text, false), None, "{text:?}");
        }
        for text in ["[1,,]", "[,]", "{,}", "// a\r{}", "/* open {}", "{'a':1}", "{\"a\":1,\"a\":2}"] {
            assert_eq!(parse(text, true), None, "{text:?}");
        }
    }

    #[test]
    fn lenient_takes_comments_and_trailing_commas() {
        assert_eq!(parse("// c\n{\"a\": [1,],} /* end */", true), Some(obj(&[("a", Json::Arr(vec![Json::Num("1".into())]))])));
    }

    #[test]
    fn stringifies_like_json_stringify() {
        assert_eq!(stringify_str("a\"\\\u{1}\u{1f}\n\u{2028}é"), "\"a\\\"\\\\\\u0001\\u001f\\n\u{2028}é\"");
    }
}
