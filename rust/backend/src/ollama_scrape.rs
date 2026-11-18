//! Pure port of Node's Ollama settings-page parser and page classifier
//! (`server/usage.mjs:55-68` and `:366-370`).
//!
//! No I/O happens here: every function takes already-captured HTML/URL text, so
//! the browser driver in `ollama_browser` and the route tests exercise the exact
//! contract without a browser, a login or a network call.
//!
//! Contracts preserved from Node, including its quirks:
//!   * `parseOllamaHtml` needs at least two `aria-label="Session|Weekly usage
//!     N% used"` meters; fewer means the page is not a usage page at all.
//!   * meters are read positionally, not by window name: index 0 is `session`,
//!     index 1 is `weekly`, whatever the labels say.
//!   * a meter's model slice ends at the *next meter's* start, so a third meter
//!     bounds the second one's models.
//!   * `resetsAt` is `times[i]` positionally, so a page with fewer `data-time`
//!     attributes yields `null` instead of shifting the values.
//!   * `pctUsed` is `parseFloat` of `[\d.]+`, which parses the longest valid
//!     numeric prefix (`"1.2.3"` is `1.2`), and `requests` is `Number(...)`;
//!     both become `null` when JavaScript would produce `NaN`/`Infinity`.
use regex::Regex;
use serde_json::{Map, Number, Value};
use std::str::FromStr;
use std::sync::OnceLock;

/// `parseOllamaHtml` (`usage.mjs:55`): the settings page's usage document, or
/// `None` when the markers that make the page a usage page are missing.
pub fn parse_ollama_html(html: &str) -> Option<Value> {
    let meters: Vec<regex::Captures<'_>> = meters().captures_iter(html).collect();
    if meters.len() < 2 {
        return None;
    }
    let times: Vec<String> = times()
        .captures_iter(html)
        .filter_map(|found| found.get(1).map(|time| time.as_str().to_owned()))
        .collect();

    let mut document = Map::new();
    document.insert("ok".into(), Value::Bool(true));
    document.insert("source".into(), Value::String("ollama".into()));
    document.insert(
        "plan".into(),
        match plan().captures(html) {
            Some(found) => Value::String(found[1].to_owned()),
            None => Value::Null,
        },
    );
    document.insert("session".into(), window_at(html, &meters, 0, &times));
    document.insert("weekly".into(), window_at(html, &meters, 1, &times));
    document.insert("extra".into(), Value::Null);
    Some(Value::Object(document))
}

/// `classifyOllamaPage` (`usage.mjs:366`): why a page without a usage meter is
/// not a reading. `auth-expired` is the only outcome that sets `needsAuth`.
pub fn classify_ollama_page(url: &str, html: &str) -> &'static str {
    if sign_in_route().is_match(url) || sign_in_text().is_match(html) {
        return "auth-expired";
    }
    if challenge().is_match(html) {
        return "challenge-required";
    }
    "scrape-incompatible"
}

/// `scrapeOllamaOnce`'s own guard (`usage.mjs:378`): a case-sensitive `/signin`
/// test on the landing URL, applied *in addition* to a missing meter. It is
/// deliberately narrower than `classifyOllamaPage`'s `/signin|/login` test, so
/// a `/login` URL that still renders a meter is parsed rather than classified.
pub fn is_sign_in_route(url: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"/signin").expect("the sign-in route pattern is valid"))
        .is_match(url)
}

fn window_at(html: &str, meters: &[regex::Captures<'_>], index: usize, times: &[String]) -> Value {
    let meter = &meters[index];
    let start = meter.get(0).expect("capture 0 always exists").start();
    let end = meters
        .get(index + 1)
        .map(|next| next.get(0).expect("capture 0 always exists").start())
        .unwrap_or(html.len());
    let models = models()
        .captures_iter(&html[start..end])
        .map(|found| {
            let mut model = Map::new();
            model.insert("model".into(), Value::String(found[1].to_owned()));
            model.insert("requests".into(), js_number(parse_float(&found[2])));
            Value::Object(model)
        })
        .collect();

    let mut window = Map::new();
    window.insert("pctUsed".into(), js_number(parse_float(&meter[2])));
    window.insert(
        "resetsAt".into(),
        match times.get(index) {
            Some(time) => Value::String(time.clone()),
            None => Value::Null,
        },
    );
    window.insert("models".into(), Value::Array(models));
    Value::Object(window)
}

/// `parseFloat` restricted to the `[0-9.]+` alphabet the meter pattern allows:
/// the longest prefix Rust parses as a float is exactly the prefix JavaScript
/// reads (`"5."` is 5, `".5"` is 0.5, `"1.2.3"` is 1.2, `"."` is `NaN`).
fn parse_float(text: &str) -> f64 {
    for end in (1..=text.len()).rev() {
        if let Ok(value) = text[..end].parse::<f64>() {
            return value;
        }
    }
    f64::NAN
}

/// A JSON number spelled the way `JSON.stringify` spells it, so `42` stays `42`
/// rather than `42.0`; non-finite values stringify as `null`.
fn js_number(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    let text = ryu_js::Buffer::new().format_finite(value).to_owned();
    Value::Number(Number::from_str(&text).expect("ECMAScript number text is valid JSON"))
}

fn plan() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // JavaScript's `\w` is ASCII-only, so `[\w-]` is spelled out.
    RE.get_or_init(|| {
        Regex::new(r#"capitalize"\s*>\s*([A-Za-z][A-Za-z0-9_-]*)\s*<"#)
            .expect("the plan pattern is valid")
    })
}

fn meters() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"aria-label="(Session|Weekly) usage ([0-9.]+)% used""#)
            .expect("the meter pattern is valid")
    })
}

fn times() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"data-time="([^"]+)""#).expect("the time pattern is valid"))
}

fn models() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"data-model="([^"]+)"[\s\S]*?data-requests="([0-9]+)""#)
            .expect("the model pattern is valid")
    })
}

fn sign_in_route() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)/signin|/login").expect("the sign-in pattern is valid"))
}

fn sign_in_text() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)sign in|log in to ollama").expect("the sign-in text pattern is valid")
    })
}

fn challenge() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)turnstile|verify (you are )?human|checking your browser|challenge")
            .expect("the challenge pattern is valid")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A settings page shaped like the real one: the plan badge, two usage
    /// meters each owning its own model rows, and two reset times.
    fn settings_page() -> String {
        r#"
        <div class="capitalize">pro</div>
        <section data-usage-meter>
          <span aria-label="Session usage 42.5% used"></span>
          <span data-time="2026-10-29T05:00:00.000Z"></span>
          <li data-model="llama3.3:70b" data-requests="12"></li>
        </section>
        <section data-usage-meter>
          <span aria-label="Weekly usage 7% used"></span>
          <span data-time="2026-11-04T00:00:00.000Z"></span>
          <li data-model="qwen3:32b" data-requests="300"></li>
          <li data-model="llama3.3:70b" data-requests="41"></li>
        </section>
        "#
        .to_owned()
    }

    // VERIFY: ollama-html-parse
    #[test]
    fn two_meters_yield_the_plan_and_both_windows() {
        let parsed = parse_ollama_html(&settings_page()).expect("the fixture is a usage page");
        assert_eq!(parsed["ok"], Value::Bool(true));
        assert_eq!(parsed["source"], Value::String("ollama".into()));
        assert_eq!(parsed["plan"], Value::String("pro".into()));
        assert_eq!(parsed["extra"], Value::Null);
        assert_eq!(parsed["session"]["pctUsed"].as_f64(), Some(42.5));
        assert_eq!(
            parsed["session"]["resetsAt"],
            Value::String("2026-10-29T05:00:00.000Z".into())
        );
        assert_eq!(parsed["weekly"]["pctUsed"].as_f64(), Some(7.0));
        assert_eq!(
            parsed["session"]["models"],
            serde_json::json!([{ "model": "llama3.3:70b", "requests": 12 }])
        );
        assert_eq!(
            parsed["weekly"]["models"],
            serde_json::json!([
                { "model": "qwen3:32b", "requests": 300 },
                { "model": "llama3.3:70b", "requests": 41 },
            ])
        );
    }

    #[test]
    fn whole_percentages_keep_javascript_number_text() {
        let parsed = parse_ollama_html(&settings_page()).unwrap();
        assert!(
            parsed.to_string().contains(r#""pctUsed":7,"#),
            "a whole percentage is written as `7`, not `7.0`: {parsed}"
        );
    }

    #[test]
    fn a_single_meter_is_not_a_usage_page() {
        let html = r#"
            <span aria-label="Session usage 42% used"></span>
            <span data-time="2026-10-29T05:00:00.000Z"></span>
        "#;
        assert_eq!(parse_ollama_html(html), None);
    }

    #[test]
    fn a_missing_time_leaves_resets_at_null() {
        let html = r#"
            <span aria-label="Session usage 42% used"></span>
            <span aria-label="Weekly usage 7% used"></span>
        "#;
        let parsed = parse_ollama_html(html).expect("two meters are enough");
        assert_eq!(parsed["session"]["resetsAt"], Value::Null);
        assert_eq!(parsed["weekly"]["resetsAt"], Value::Null);
    }

    #[test]
    fn a_meter_s_models_stop_at_the_next_meter() {
        // Each meter owns the rows up to the next meter: the third meter's row
        // belongs to nobody, because only the first two windows are returned.
        let html = r#"
            <span aria-label="Session usage 1% used" data-time="a"></span>
            <li data-model="session-only" data-requests="1"></li>
            <span aria-label="Weekly usage 2% used" data-time="b"></span>
            <li data-model="weekly-only" data-requests="2"></li>
            <span aria-label="Session usage 3% used" data-time="c"></span>
            <li data-model="third-only" data-requests="3"></li>
        "#;
        let parsed = parse_ollama_html(html).unwrap();
        assert_eq!(
            parsed["session"]["models"],
            serde_json::json!([{ "model": "session-only", "requests": 1 }]),
            "the first meter owns its own rows"
        );
        assert_eq!(
            parsed["weekly"]["models"],
            serde_json::json!([{ "model": "weekly-only", "requests": 2 }]),
            "a later meter bounds this one, so `third-only` is not weekly's"
        );
    }

    #[test]
    fn times_are_taken_positionally_even_when_there_are_more_meters_than_times() {
        let html = r#"
            <span aria-label="Session usage 1% used"></span>
            <span aria-label="Weekly usage 2% used"></span>
            <span aria-label="Session usage 3% used"></span>
            <span data-time="only-one"></span>
        "#;
        let parsed = parse_ollama_html(html).unwrap();
        assert_eq!(
            parsed["session"]["resetsAt"],
            Value::String("only-one".into())
        );
        assert_eq!(parsed["weekly"]["resetsAt"], Value::Null);
    }

    #[test]
    fn pct_used_follows_parse_float_and_a_missing_plan_is_null() {
        let html = r#"
            <span aria-label="Session usage 1.2.3% used"></span>
            <span aria-label="Weekly usage .5% used"></span>
        "#;
        let parsed = parse_ollama_html(html).unwrap();
        assert_eq!(parsed["plan"], Value::Null);
        assert_eq!(parsed["session"]["pctUsed"].as_f64(), Some(1.2));
        assert_eq!(parsed["weekly"]["pctUsed"].as_f64(), Some(0.5));
    }

    #[test]
    fn a_meter_value_that_is_not_a_number_stringifies_as_null() {
        let html = r#"
            <span aria-label="Session usage .% used"></span>
            <span aria-label="Weekly usage 2% used"></span>
        "#;
        let parsed = parse_ollama_html(html).unwrap();
        assert_eq!(parsed["session"]["pctUsed"], Value::Null);
    }

    // VERIFY: ollama-page-classify
    #[test]
    fn a_sign_in_url_is_an_expired_login() {
        assert_eq!(
            classify_ollama_page("https://ollama.com/signin?next=/settings", ""),
            "auth-expired"
        );
        assert_eq!(
            classify_ollama_page("https://ollama.com/login", ""),
            "auth-expired"
        );
        assert_eq!(
            classify_ollama_page("https://ollama.com/SIGNIN", ""),
            "auth-expired"
        );
    }

    #[test]
    fn sign_in_text_is_an_expired_login() {
        assert_eq!(
            classify_ollama_page("https://ollama.com/settings", "<h1>Sign in</h1>"),
            "auth-expired"
        );
        assert_eq!(
            classify_ollama_page("https://ollama.com/settings", "Please log in to Ollama"),
            "auth-expired"
        );
    }

    #[test]
    fn challenge_text_is_a_challenge() {
        assert_eq!(
            classify_ollama_page(
                "https://ollama.com/settings",
                "<div class=\"cf-turnstile\">"
            ),
            "challenge-required"
        );
        assert_eq!(
            classify_ollama_page("https://ollama.com/settings", "Verify you are human"),
            "challenge-required"
        );
        assert_eq!(
            classify_ollama_page("https://ollama.com/settings", "Checking your browser…"),
            "challenge-required"
        );
    }

    #[test]
    fn a_plain_page_without_a_meter_is_incompatible() {
        assert_eq!(
            classify_ollama_page("https://ollama.com/settings", "<h1>Settings</h1>"),
            "scrape-incompatible"
        );
    }

    #[test]
    fn the_scrape_route_guard_is_case_sensitive_and_ignores_login() {
        assert!(is_sign_in_route("https://ollama.com/signin"));
        assert!(!is_sign_in_route("https://ollama.com/SignIn"));
        assert!(!is_sign_in_route("https://ollama.com/login"));
    }
}
