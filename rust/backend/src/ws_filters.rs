//! Terminal escape-sequence filters for the `/ws` PTY bridge.
//!
//! Verbatim port of the two regexes in `server/pty-ws.mjs:24-57`:
//!
//! - [`strip_queries`] removes terminal *query* sequences from replayed
//!   scrollback (`attach`, `pty-ws.mjs:172`). xterm.js answers queries on the
//!   same channel as keystrokes; a replayed query would leak a stale reply into
//!   whatever the app currently has focused. Live `output` frames are never
//!   filtered.
//! - [`strip_color_responses`] removes the automatic OSC 10/11/12 colour
//!   replies xterm sends through `onData`, so a delayed reply never reaches the
//!   PTY as prompt text (`pty-ws.mjs:176`).
//!
//! Covered queries (Node comment, `pty-ws.mjs:21-23`): DA1 (`CSI c` / `CSI 0c`),
//! DA2 (`CSI > c`), DA3 (`CSI = c`), DSR status/cursor (`CSI 5n` / `CSI 6n`),
//! OSC 10/11/12 colour queries (BEL or ST terminated), XTGETTCAP
//! (`DCS + q ... ST`) and the kitty keyboard protocol query (`CSI ? u`).

use regex::Regex;
use std::sync::OnceLock;

/// `QUERY_RE` (`pty-ws.mjs:24-32`), same alternatives in the same order.
fn query_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(concat!(
            r"\x1b\[0?c",
            r"|\x1b\[>\d*c",
            r"|\x1b\[=c",
            r"|\x1b\[[56]n",
            r"|\x1b\]1[012];\?(?:\x07|\x1b\\)",
            r"|\x1bP\+q[0-9a-fA-F;]*\x1b\\",
            r"|\x1b\[\?u",
        ))
        .expect("constant regex is valid")
    })
}

/// `COLOR_RESPONSE_RE` (`pty-ws.mjs:38-40`).
fn color_response_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(concat!(
            r"\x1b\]1[012];rgb:",
            r"[0-9a-fA-F]{1,4}/[0-9a-fA-F]{1,4}/[0-9a-fA-F]{1,4}",
            r"(?:\x07|\x1b\\)",
        ))
        .expect("constant regex is valid")
    })
}

// VERIFY: ws-filters-strip-queries
/// `stripQueries` (`pty-ws.mjs:33`): drop terminal query sequences from a
/// scrollback replay.
pub fn strip_queries(value: &str) -> String {
    query_regex().replace_all(value, "").into_owned()
}

// VERIFY: ws-filters-strip-color-responses
/// `stripColorResponses` (`pty-ws.mjs:41`): drop automatic OSC colour replies
/// from live input.
pub fn strip_color_responses(value: &str) -> String {
    color_response_regex().replace_all(value, "").into_owned()
}

#[cfg(test)]
mod tests {
    use super::{strip_color_responses, strip_queries};

    // Oracle: `server/pty-ws.test.mjs:74-87`.
    #[test]
    fn strip_queries_removes_each_covered_query_sequence() {
        assert_eq!(strip_queries("\x1b[c"), ""); // DA1
        assert_eq!(strip_queries("\x1b[0c"), ""); // DA1
        assert_eq!(strip_queries("\x1b[>c"), ""); // DA2
        assert_eq!(strip_queries("\x1b[>0c"), ""); // DA2 with param
        assert_eq!(strip_queries("\x1b[=c"), ""); // DA3
        assert_eq!(strip_queries("\x1b[5n"), ""); // DSR status
        assert_eq!(strip_queries("\x1b[6n"), ""); // DSR cursor position
        assert_eq!(strip_queries("\x1b]10;?\x07"), ""); // OSC 10 (fg), BEL-terminated
        assert_eq!(strip_queries("\x1b]11;?\x1b\\"), ""); // OSC 11 (bg), ST-terminated
        assert_eq!(strip_queries("\x1b]12;?\x07"), ""); // OSC 12 (cursor colour)
        assert_eq!(strip_queries("\x1bP+q544e\x1b\\"), ""); // XTGETTCAP
        assert_eq!(strip_queries("\x1b[?u"), ""); // kitty keyboard protocol query
    }

    // Oracle: `server/pty-ws.test.mjs:89-92`.
    #[test]
    fn strip_queries_strips_only_the_query_leaving_surrounding_output_intact() {
        let input = "hello\x1b[c\x1b]10;?\x07world";
        assert_eq!(strip_queries(input), "helloworld");
    }

    // Oracle: `server/pty-ws.test.mjs:94-102`.
    #[test]
    fn strip_queries_leaves_ordinary_output_byte_identical() {
        for sample in ["plain text", "\x1b[31mred\x1b[0m", "\x1b[2J", "\x1b[10;5H"] {
            assert_eq!(strip_queries(sample), sample);
        }
    }

    // Oracle: `server/pty-ws.test.mjs:104-108`.
    #[test]
    fn strip_color_responses_removes_automatic_osc_colour_replies() {
        let reply = "\x1b]10;rgb:d9d9/d2d2/eeee\x1b\\\x1b]11;rgb:0b0b/0808/1313\x1b\\";
        assert_eq!(strip_color_responses(reply), "");
        assert_eq!(
            strip_color_responses(&format!("before{reply}after")),
            "beforeafter"
        );
    }

    // Oracle: `server/pty-ws.test.mjs:110-112`.
    #[test]
    fn strip_color_responses_leaves_normal_input_byte_identical() {
        assert_eq!(strip_color_responses("hello\x1b[A"), "hello\x1b[A");
    }
}
