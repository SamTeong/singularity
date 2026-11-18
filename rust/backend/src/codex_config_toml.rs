//! TOML validation for the Codex config editor write route
//! (`PUT /api/codex-config/:scope`, `server/codex-config.mjs` `writeConfig`).
//!
//! Node validated with `@iarna/toml`'s `parse`, a TOML **0.5** parser; this port
//! validates with `toml_edit` 0.25 (the TOML **1.1** grammar) and reports its own
//! wording. Both are parse-only: the document is never re-serialized.
//!
//! Acceptance edges that differ (a 121-case differential against the installed
//! `@iarna/toml` found 12, pinned in `accept_reject_divergences_from_iarna`):
//!   * 1.1 syntax 0.5 rejects: heterogeneous arrays, `\e`/`\xHH` escapes,
//!     newlines in inline tables, times without seconds, lowercase `t`/`z`,
//!     `"""` followed by a fourth quote, and a leading BOM;
//!   * `@iarna` leniency this port rejects: i64 overflow, and a table defined
//!     both by dotted keys and by a `[header]`;
//!   * error wording and placement: `@iarna`'s message is multi-line and carries
//!     its own `row`/`col` text, this port emits one line.
//!
//! `validate` always reports a single line, `<message> at line L, column C`
//! (1-based, from the error's byte span; a span-less error reports 1,1), so the
//! route can prefix `invalid TOML: ` and keep the reason on one line.

use std::ops::Range;

/// Parse `content` as a TOML document, returning the one-line reason on failure.
pub(crate) fn validate(content: &str) -> Result<(), String> {
    let error = match toml_edit::Document::parse(content) {
        Ok(_) => return Ok(()),
        Err(error) => error,
    };
    let (line, column) = position(content, error.span());
    Err(format!(
        "{} at line {line}, column {column}",
        single_line(error.message())
    ))
}

/// Collapse every whitespace run (the parser's descriptions can wrap lines) so
/// the reason stays on one line, exactly one space between words.
fn single_line(message: &str) -> String {
    message.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 1-based line and character column for a byte span start. Columns count
/// characters, not bytes, so a multi-byte prefix does not shift the caret.
fn position(content: &str, span: Option<Range<usize>>) -> (usize, usize) {
    let Some(span) = span else {
        return (1, 1);
    };
    let mut end = span.start.min(content.len());
    while !content.is_char_boundary(end) {
        end -= 1;
    }
    let before = &content[..end];
    let line = before.matches('\n').count() + 1;
    let column = before
        .rsplit('\n')
        .next()
        .map_or(1, |tail| tail.chars().count() + 1);
    (line, column)
}

#[cfg(test)]
mod tests {
    use super::validate;

    fn reason(content: &str) -> String {
        match validate(content) {
            Ok(()) => panic!("expected {content:?} to be rejected"),
            Err(reason) => reason,
        }
    }

    /// The trailing ` at line L, column C` suffix, parsed back out.
    fn placement(reason: &str) -> (usize, usize) {
        let (_, tail) = reason
            .rsplit_once(" at line ")
            .unwrap_or_else(|| panic!("missing placement in {reason:?}"));
        let (line, column) = tail
            .split_once(", column ")
            .unwrap_or_else(|| panic!("missing column in {reason:?}"));
        (line.parse().unwrap(), column.parse().unwrap())
    }

    #[test]
    fn accepts_documents_the_editor_writes() {
        for content in [
            "",
            "\n",
            "# comment only\n",
            "model = \"gpt-5\"\n",
            "model = \"gpt-5\"\napproval_policy = \"on-request\"\n",
            "[profiles.fast]\nmodel = \"o4-mini\"\n",
            "projects = [\"~/work\", \"/tmp/x\"]\n",
            "mixed = [1, \"x\"]\n", // TOML 1.1 accepts what @iarna (0.5) rejected
            "model = \"\u{66f4}\u{65b0} \u{2713}\"\n",
            "text = \"\"\"\nmulti\nline\n\"\"\"\n",
            "inline = { a = 1, b = \"x\" }\n",
            "inline = { a = 1, }\n", // TOML 1.1 (and @iarna) allow the trailing comma
            "when = 1979-05-27T07:32:00Z\n",
        ] {
            assert_eq!(validate(content), Ok(()), "{content:?}");
        }
    }

    #[test]
    fn rejects_the_same_syntax_errors_both_parsers_share() {
        for content in [
            "model = ",
            "model = \"unterminated\n",
            "= 1\n",
            "[a\n",
            "a = 1 b = 2\n",
            "a = 1\n[a]\nb = 2\n",
        ] {
            assert!(validate(content).is_err(), "{content:?}");
        }
    }

    #[test]
    fn every_reason_is_one_line_with_a_placement() {
        for content in ["model = ", "a = 1 b = 2\n", "[a\n", "a = 1\n[a]\n"] {
            let reason = reason(content);
            assert!(!reason.contains('\n'), "{reason:?}");
            assert!(!reason.contains('\r'), "{reason:?}");
            assert!(!reason.contains("  "), "{reason:?}");
            assert_eq!(reason, reason.trim(), "{reason:?}");
            let (line, column) = placement(&reason);
            assert!(line >= 1 && column >= 1, "{reason:?}");
        }
    }

    #[test]
    fn placement_is_one_based_and_counts_lines_and_characters() {
        // `model = ` on the first line: the parser points at the missing value.
        assert_eq!(placement(&reason("model = ")).0, 1);
        // The second line fails, and a multi-byte prefix must not shift the
        // column of the first line's error either.
        let (line, _) = placement(&reason("a = 1\nb = \n"));
        assert_eq!(line, 2);
        let (first, _) = placement(&reason("\u{66f4}\u{65b0} = "));
        assert_eq!(first, 1);
        // A span-less error would report 1,1; parse errors carry a span.
        assert_eq!(super::position("a = 1", None), (1, 1));
    }

    #[test]
    fn accept_reject_divergences_from_iarna() {
        // @iarna (0.5) rejects; toml_edit (1.1) accepts.
        for content in [
            "\u{feff}a = 1\n",
            "a = [1, \"two\", 3.0]\n",
            "t = {\n  a = 1\n}\n",
            "a = \"\\e\"\n",
            "a = \"\\x41\"\n",
            "a = \"\"\"abc\"\"\"\"\n",
            "a = 1979-05-27t07:32:00z\n",
            "a = 1979-05-27T07:32Z\n",
            "a = 07:32\n",
        ] {
            assert_eq!(validate(content), Ok(()), "{content:?}");
        }
        // @iarna accepts; toml_edit rejects.
        for content in [
            "a = 9223372036854775808\n",
            "[t]\na.b = 1\n[t.a]\nc = 2\n",
            "a.b = 1\n[a]\nc = 2\n",
        ] {
            assert!(validate(content).is_err(), "{content:?}");
        }
    }

    #[test]
    fn a_valid_document_never_carries_a_reason() {
        assert_eq!(validate("model = \"gpt-5\"\n"), Ok(()));
        assert_eq!(validate("model = \"gpt-5\"\n").err(), None);
    }
}
