use crate::transcripts::TranscriptRawText;
use ring::digest;
use serde_json::value::RawValue;
use std::fs;

pub fn fingerprint(path: &str) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    fingerprint_bytes(&bytes)
}

fn fingerprint_bytes(bytes: &[u8]) -> Option<String> {
    let json = String::from_utf8_lossy(bytes);
    fingerprint_json(&json)
}

fn fingerprint_json(json: &str) -> Option<String> {
    let document: Box<RawValue> = serde_json::from_str(json).ok()?;
    let tokens = last_object_member(document.get(), "tokens")?;
    let account_id = last_object_member(tokens, "account_id")?;
    let units = TranscriptRawText::from_json_token(account_id.to_owned())
        .ok()?
        .units()
        .ok()?;
    let account_id = String::from_utf16_lossy(&units);
    if account_id.is_empty() {
        return None;
    }

    let hash = digest::digest(&digest::SHA256, account_id.as_bytes());
    let mut fingerprint = String::with_capacity(64);
    for byte in hash.as_ref() {
        use std::fmt::Write as _;
        write!(&mut fingerprint, "{byte:02x}").ok()?;
    }
    Some(fingerprint)
}

fn last_object_member<'a>(token: &'a str, wanted: &str) -> Option<&'a str> {
    let bytes = token.as_bytes();
    if bytes.first() != Some(&b'{') {
        return None;
    }

    let mut cursor = 1;
    skip_space(bytes, &mut cursor);
    let mut found = None;
    while bytes.get(cursor) != Some(&b'}') {
        let key_start = cursor;
        cursor = string_end(bytes, cursor)?;
        let key_end = cursor;
        skip_space(bytes, &mut cursor);
        if bytes.get(cursor) != Some(&b':') {
            return None;
        }
        cursor += 1;
        skip_space(bytes, &mut cursor);
        let value_start = cursor;
        cursor = value_end(bytes, cursor)?;
        if json_string_equals_ascii(&bytes[key_start..key_end], wanted) {
            found = std::str::from_utf8(&bytes[value_start..cursor]).ok();
        }
        skip_space(bytes, &mut cursor);
        match bytes.get(cursor) {
            Some(b',') => {
                cursor += 1;
                skip_space(bytes, &mut cursor);
            }
            Some(b'}') => break,
            _ => return None,
        }
    }
    found
}

fn skip_space(bytes: &[u8], cursor: &mut usize) {
    while bytes
        .get(*cursor)
        .is_some_and(|byte| matches!(byte, b' ' | b'\n' | b'\r' | b'\t'))
    {
        *cursor += 1;
    }
}

fn string_end(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) != Some(&b'"') {
        return None;
    }
    let mut cursor = start + 1;
    while let Some(byte) = bytes.get(cursor) {
        match byte {
            b'"' => return Some(cursor + 1),
            b'\\' => cursor += 2,
            _ => cursor += 1,
        }
    }
    None
}

fn value_end(bytes: &[u8], start: usize) -> Option<usize> {
    match bytes.get(start)? {
        b'"' => string_end(bytes, start),
        b'{' | b'[' => {
            let mut closers = vec![if bytes[start] == b'{' { b'}' } else { b']' }];
            let mut cursor = start + 1;
            while let Some(byte) = bytes.get(cursor) {
                match byte {
                    b'"' => cursor = string_end(bytes, cursor)?,
                    b'{' => {
                        closers.push(b'}');
                        cursor += 1;
                    }
                    b'[' => {
                        closers.push(b']');
                        cursor += 1;
                    }
                    b'}' | b']' => {
                        if closers.pop() != Some(*byte) {
                            return None;
                        }
                        cursor += 1;
                        if closers.is_empty() {
                            return Some(cursor);
                        }
                    }
                    _ => cursor += 1,
                }
            }
            None
        }
        _ => {
            let mut cursor = start;
            while bytes.get(cursor).is_some_and(|byte| {
                !matches!(byte, b',' | b']' | b'}' | b' ' | b'\n' | b'\r' | b'\t')
            }) {
                cursor += 1;
            }
            (cursor > start).then_some(cursor)
        }
    }
}

fn json_string_equals_ascii(token: &[u8], wanted: &str) -> bool {
    if token.first() != Some(&b'"') || token.last() != Some(&b'"') || !wanted.is_ascii() {
        return false;
    }
    let mut decoded = Vec::with_capacity(wanted.len());
    let mut cursor = 1;
    while cursor + 1 < token.len() {
        let byte = token[cursor];
        cursor += 1;
        if byte == b'\\' {
            let Some(escape) = token.get(cursor).copied() else {
                return false;
            };
            cursor += 1;
            match escape {
                b'u' => {
                    let Some(hex) = token.get(cursor..cursor + 4) else {
                        return false;
                    };
                    let Ok(hex) = std::str::from_utf8(hex) else {
                        return false;
                    };
                    let Ok(unit) = u16::from_str_radix(hex, 16) else {
                        return false;
                    };
                    if unit > 0x7f {
                        return false;
                    }
                    decoded.push(unit as u8);
                    cursor += 4;
                }
                b'"' | b'\\' | b'/' => decoded.push(escape),
                b'b' => decoded.push(0x08),
                b'f' => decoded.push(0x0c),
                b'n' => decoded.push(b'\n'),
                b'r' => decoded.push(b'\r'),
                b't' => decoded.push(b'\t'),
                _ => return false,
            }
        } else if byte.is_ascii() {
            decoded.push(byte);
        } else {
            return false;
        }
    }
    decoded == wanted.as_bytes()
}

#[cfg(test)]
mod tests {
    use super::{fingerprint_bytes, fingerprint_json};

    #[test]
    fn auth_projection_matches_node_oracle_for_bounded_fixtures() {
        const ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        const REPLACEMENT: &str =
            "83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097";
        const GRINNING: &str = "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9";
        const LAST: &str = "3547cb112ac4489af2310c0626cdba6f3097a2ad5a3b42ddd3b59c76c7a079a3";
        const FIRST: &str = "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e";
        let cases = [
            ("ordinary", r#"{"tokens":{"account_id":"abc"}}"#, Some(ABC)),
            (
                "lone high surrogate",
                r#"{"tokens":{"account_id":"\ud800"}}"#,
                Some(REPLACEMENT),
            ),
            (
                "lone low surrogate",
                r#"{"tokens":{"account_id":"\udc00"}}"#,
                Some(REPLACEMENT),
            ),
            (
                "unrelated surrogate value",
                r#"{"other":"\ud800","tokens":{"account_id":"abc"}}"#,
                Some(ABC),
            ),
            (
                "unrelated surrogate key",
                r#"{"\ud800":0,"tokens":{"account_id":"abc"}}"#,
                Some(ABC),
            ),
            (
                "valid surrogate pair",
                r#"{"tokens":{"account_id":"\ud83d\ude00"}}"#,
                Some(GRINNING),
            ),
            (
                "duplicate inner last wins",
                r#"{"tokens":{"account_id":"first","account_id":"last"}}"#,
                Some(LAST),
            ),
            (
                "duplicate inner reverse order",
                r#"{"tokens":{"account_id":"last","account_id":"first"}}"#,
                Some(FIRST),
            ),
            (
                "duplicate outer last wins",
                r#"{"tokens":{"account_id":"first"},"tokens":{"account_id":"last"}}"#,
                Some(LAST),
            ),
            (
                "duplicate outer reverse order",
                r#"{"tokens":{"account_id":"last"},"tokens":{"account_id":"first"}}"#,
                Some(FIRST),
            ),
            ("malformed JSON", r#"{"tokens":{"account_id":"bad""#, None),
            (
                "trailing data",
                r#"{"tokens":{"account_id":"abc"}} trailing"#,
                None,
            ),
            ("array tokens", r#"{"tokens":[{"account_id":"abc"}]}"#, None),
            (
                "non-string account",
                r#"{"tokens":{"account_id":42}}"#,
                None,
            ),
            ("empty account", r#"{"tokens":{"account_id":""}}"#, None),
            ("missing account", r#"{"tokens":{}}"#, None),
            ("missing tokens", r#"{}"#, None),
            (
                "escaped names and nested values",
                r#"{"tok\u0065ns":{"unrelated":[{"\ud800":"ignored"}],"account\u005fid":"abc"}}"#,
                Some(ABC),
            ),
        ];
        for (name, json, expected) in cases {
            assert_eq!(
                fingerprint_json(json).as_deref(),
                expected,
                "Node oracle fixture: {name}"
            );
        }
        assert_eq!(fingerprint_json(r#"{"tokens":{"account_id":null}}"#), None);
        let malformed_utf8 = [
            b'{', b'"', b't', b'o', b'k', b'e', b'n', b's', b'"', b':', b'{', b'"', b'a', b'c',
            b'c', b'o', b'u', b'n', b't', b'_', b'i', b'd', b'"', b':', b'"', 0xff, b'"', b'}',
            b'}',
        ];
        assert_eq!(
            fingerprint_bytes(&malformed_utf8).as_deref(),
            Some(REPLACEMENT),
            "Node oracle fixture: malformed UTF-8 replacement"
        );
    }
}
