use crate::usage_snapshot::parse_date_ms;

/// Converts a raw Retry-After value to milliseconds from `response_time_ms`.
/// `None` means no usable value; infinities are retained for cutoff handling.
pub(crate) fn retry_after_ms(value: Option<&str>, response_time_ms: i64) -> Option<f64> {
    let value = value?;
    if value.is_empty() {
        return None;
    }

    let trimmed = trim_ecmascript(value);
    let number = number_from_string(trimmed);
    if let Some(number) = number.filter(|n| n.is_finite()) {
        return Some((number * 1_000.0).max(0.0));
    }

    let date = parse_date_ms(trimmed)?;
    const MAX_DATE_MS: i64 = 8_640_000_000_000_000;
    if !(-MAX_DATE_MS..=MAX_DATE_MS).contains(&date) {
        return None;
    }
    Some(((date as f64) - (response_time_ms as f64)).max(0.0))
}

fn trim_ecmascript(value: &str) -> &str {
    fn is_space(c: char) -> bool {
        matches!(c,
            '\u{0009}'..='\u{000D}' | ' ' | '\u{00A0}' | '\u{1680}' |
            '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' |
            '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
    }
    value.trim_matches(is_space)
}

fn number_from_string(value: &str) -> Option<f64> {
    if value.is_empty() {
        return Some(0.0);
    }
    if matches!(value, "Infinity" | "+Infinity") {
        return Some(f64::INFINITY);
    }
    if value == "-Infinity" {
        return Some(f64::NEG_INFINITY);
    }
    if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        return radix_number(hex, 16);
    }
    if let Some(bin) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        return radix_number(bin, 2);
    }
    if let Some(oct) = value
        .strip_prefix("0o")
        .or_else(|| value.strip_prefix("0O"))
    {
        return radix_number(oct, 8);
    }
    if !valid_decimal(value) {
        return None;
    }
    value.parse::<f64>().ok()
}

fn valid_decimal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    if matches!(b.first(), Some(b'+') | Some(b'-')) {
        i += 1;
    }
    let before = digits(b, &mut i);
    let after = if b.get(i) == Some(&b'.') {
        i += 1;
        digits(b, &mut i)
    } else {
        0
    };
    if before + after == 0 {
        return false;
    }
    if b.get(i) == Some(&b'e') || b.get(i) == Some(&b'E') {
        i += 1;
        if matches!(b.get(i), Some(b'+') | Some(b'-')) {
            i += 1;
        }
        if digits(b, &mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

fn digits(b: &[u8], i: &mut usize) -> usize {
    let start = *i;
    while matches!(b.get(*i), Some(b'0'..=b'9')) {
        *i += 1;
    }
    *i - start
}

/// Correctly rounds arbitrary-length unsigned radix integers to binary64.
fn radix_number(s: &str, radix: u32) -> Option<f64> {
    if s.is_empty() {
        return None;
    }
    let mut digits = Vec::with_capacity(s.len());
    for c in s.bytes() {
        let d = match c {
            b'0'..=b'9' => (c - b'0') as u32,
            b'a'..=b'f' => (c - b'a' + 10) as u32,
            b'A'..=b'F' => (c - b'A' + 10) as u32,
            _ => return None,
        };
        if d >= radix {
            return None;
        }
        digits.push(d);
    }
    let Some(first) = digits.iter().position(|d| *d != 0) else {
        return Some(0.0);
    };
    let width = match radix {
        2 => 1,
        8 => 3,
        16 => 4,
        _ => return None,
    };
    let mut bits = Vec::with_capacity((digits.len() - first) * width);
    for (index, digit) in digits.iter().enumerate().skip(first) {
        let start = if index == first {
            (31 - digit.leading_zeros()) as usize
        } else {
            width - 1
        };
        for bit in (0..=start).rev() {
            bits.push((digit >> bit) & 1 != 0);
        }
    }
    let n = bits.len();
    let mut top = 0u64;
    for bit in bits.iter().take(53) {
        top = (top << 1) | u64::from(*bit);
    }
    if n > 53 {
        let guard = bits[53];
        let sticky = bits[54..].iter().any(|b| *b);
        if guard && (sticky || top & 1 == 1) {
            top += 1;
        }
    }
    let mut exponent = n - 1;
    if top == (1u64 << 53) {
        top >>= 1;
        exponent += 1;
    }
    if n <= 53 {
        return Some(top as f64);
    }
    if exponent > 1023 {
        return Some(f64::INFINITY);
    }
    let shift = exponent as i32 - 52;
    Some((top as f64) * 2.0f64.powi(shift))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_node_parity_vectors() {
        let vectors: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../server/fixtures/retry-after-parity.json"
        ))
        .unwrap();
        for vector in vectors {
            let value = vector["value"].as_str();
            let anchor = vector["anchor"].as_i64().unwrap();
            let actual = retry_after_ms(value, anchor);
            let expected = match &vector["expected"] {
                serde_json::Value::Null => None,
                serde_json::Value::String(s) if s == "Infinity" => Some(f64::INFINITY),
                value => Some(value.as_f64().unwrap()),
            };
            match (actual, expected) {
                (None, None) => {}
                (Some(actual), Some(expected)) if actual == expected => {}
                (actual, expected) => {
                    panic!("vector {:?}: {actual:?} != {expected:?}", vector["value"])
                }
            }
        }
    }

    #[test]
    fn raw_empty_and_ecmascript_whitespace_are_distinct() {
        assert_eq!(retry_after_ms(None, 0), None);
        assert_eq!(retry_after_ms(Some(""), 0), None);
        for s in [" ", "\u{FEFF}", "\u{2028}", "\t\r\n"] {
            assert_eq!(retry_after_ms(Some(s), 0), Some(0.0));
        }
    }

    #[test]
    fn decimal_grammar_and_number_conversion_vectors() {
        for (s, expected) in [
            ("2", 2_000.0),
            ("1.5", 1_500.0),
            (".5", 500.0),
            ("1.", 1_000.0),
            ("01", 1_000.0),
            ("1e-400", 0.0),
            ("-1", 0.0),
            ("-0", 0.0),
        ] {
            assert_eq!(retry_after_ms(Some(s), 0), Some(expected), "{s}");
        }
        assert_eq!(retry_after_ms(Some("1e308"), 0), Some(f64::INFINITY));
        assert_eq!(retry_after_ms(Some("-1e308"), 0), Some(0.0));
        for s in [
            "1e309",
            "Infinity",
            "+Infinity",
            "-Infinity",
            "+0x10",
            "0x1_0",
            "10n",
            "2junk",
        ] {
            assert_eq!(retry_after_ms(Some(s), 0), None, "{s}");
        }
    }

    #[test]
    fn radix_values_round_arbitrary_lengths_to_even() {
        assert_eq!(number_from_string("0x10"), Some(16.0));
        assert_eq!(number_from_string("0b10000"), Some(16.0));
        assert_eq!(number_from_string("0o20"), Some(16.0));
        assert_eq!(
            number_from_string("0x1fffffffffffff"),
            Some(9_007_199_254_740_991.0)
        );
        assert_eq!(
            number_from_string("0x20000000000001"),
            Some(9_007_199_254_740_992.0)
        );
        assert_eq!(
            number_from_string("0x20000000000003"),
            Some(9_007_199_254_740_996.0)
        );
        assert_eq!(
            number_from_string(&format!("0x1{}", "0".repeat(300))),
            Some(f64::INFINITY)
        );
        assert_eq!(number_from_string("0b10"), Some(2.0));
        assert_eq!(number_from_string("0o10"), Some(8.0));
        for s in ["0x0", "0x000", "0b0", "0o0"] {
            assert_eq!(number_from_string(s), Some(0.0), "{s}");
        }
        for s in ["0x", "0b", "0o", "0xG", "0b2", "0o8"] {
            assert_eq!(number_from_string(s), None, "{s}");
        }
    }

    #[test]
    fn date_fallback_uses_anchor_and_clamps_past() {
        let anchor = parse_date_ms("2030-03-01T00:00:00Z").unwrap();
        assert_eq!(
            retry_after_ms(Some("2030-03-01T00:00:02Z"), anchor),
            Some(2_000.0)
        );
        assert_eq!(
            retry_after_ms(Some("2030-02-28T00:00:00Z"), anchor),
            Some(0.0)
        );
        assert_eq!(
            retry_after_ms(Some("Sun, 06 Nov 1994 08:49:37 GMT"), anchor),
            Some(0.0)
        );
    }

    #[test]
    fn fractional_and_cutoff_values_stay_unrounded() {
        assert_eq!(retry_after_ms(Some("0.0005"), 0), Some(0.5));
        assert_eq!(retry_after_ms(Some("4.999"), 0), Some(4_999.0));
        assert_eq!(retry_after_ms(Some("5"), 0), Some(5_000.0));
        assert_eq!(retry_after_ms(Some("5.001"), 0), Some(5_001.0));
    }
}
