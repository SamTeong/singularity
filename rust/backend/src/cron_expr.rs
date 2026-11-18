//! UTC cron-expression parser and next-fire calculator.
//!
//! Port of the `cron-parser` surface `server/crons.mjs:39-47` uses:
//! `CronExpressionParser.parse(expr, { utc: true, tz: 'UTC' }).next()`. The
//! grammar below was measured against the pinned `cron-parser` (^5.7.0) rather
//! than assumed — see the wave-1 design note and the measured probe table:
//!
//! - 5 fields (`minute hour day-of-month month day-of-week`) or 6 with a
//!   leading `seconds` field. A 7th (`year`) field is rejected.
//! - `*` and `?` are equivalent wildcards in every field.
//! - Items: `a`, `a-b`, `a/n` (`a..max` step `n`), `a-b/n`, `*/n`, comma lists.
//! - Names `JAN..DEC` / `SUN..SAT`, case-insensitive. The day-of-week suffix
//!   `L` must be uppercase.
//! - Day-of-month `L` (last day), including inside a list (`L,15`).
//!   `L-n`, `nW` and `LW` are **not** supported by the pinned parser and are
//!   rejected here too.
//! - Day-of-week `n#k` (k 1..5) and `nL` (last weekday). `#` may not combine
//!   with `,`, `-` or `/`; bare `L` is rejected. Reference quirk preserved:
//!   `5L#3` parses as `5L` (the trailing occurrence is ignored).
//! - `@yearly`/`@annually`, `@monthly`, `@weekly`, `@daily`, `@hourly` only
//!   (lowercase); `@midnight` is not accepted by the pinned parser.
//! - Duplicate expanded values are rejected for seconds/minutes/hours/
//!   day-of-month/month; the reference disables that check for day-of-week.
//! - An explicit day-of-month that can never occur is rejected only when the
//!   day-of-week field is a syntactic wildcard and the month field resolves to
//!   exactly one month (reference: `min(dom) > days_in_month(month)`).
//!
//! `next_fire_after` is strictly after the supplied instant, all arithmetic is
//! UTC (`time::OffsetDateTime` at `UtcOffset::UTC`), and the search horizon is
//! eight years (the longest gap between leap days). Exhausting the horizon is
//! the equivalent of the reference's "no matching time" failure.
//!
//! No I/O, no locks, no process state: [`validate`], [`next_fire_after`] and
//! [`iso_utc`] are pure functions.

use time::{Date, Duration, OffsetDateTime};

fn days_in_month(year: i32, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 31,
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Longest possible month length; February is 29 because the reference accepts
/// `29 2 *` (a leap-day schedule).
fn max_days_in_month(month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => 29,
        _ => 31,
    }
}

const MONTH_NAMES: [(&str, u8); 12] = [
    ("JAN", 1),
    ("FEB", 2),
    ("MAR", 3),
    ("APR", 4),
    ("MAY", 5),
    ("JUN", 6),
    ("JUL", 7),
    ("AUG", 8),
    ("SEP", 9),
    ("OCT", 10),
    ("NOV", 11),
    ("DEC", 12),
];

const DOW_NAMES: [(&str, u8); 7] = [
    ("SUN", 0),
    ("MON", 1),
    ("TUE", 2),
    ("WED", 3),
    ("THU", 4),
    ("FRI", 5),
    ("SAT", 6),
];

#[derive(Clone, Copy)]
struct Spec {
    min: u8,
    max: u8,
    label: &'static str,
}

const SECONDS: Spec = Spec {
    min: 0,
    max: 59,
    label: "CronSecond",
};
const MINUTES: Spec = Spec {
    min: 0,
    max: 59,
    label: "CronMinute",
};
const HOURS: Spec = Spec {
    min: 0,
    max: 23,
    label: "CronHour",
};
const DAY_OF_MONTH: Spec = Spec {
    min: 1,
    max: 31,
    label: "CronDayOfMonth",
};
const MONTHS: Spec = Spec {
    min: 1,
    max: 12,
    label: "CronMonth",
};
const DAY_OF_WEEK: Spec = Spec {
    min: 0,
    max: 7,
    label: "CronDayOfWeek",
};

/// A parsed expression. Value vectors are sorted ascending; day-of-week values
/// are normalised (7 becomes 0).
#[derive(Clone, Debug)]
struct Schedule {
    seconds: Vec<u8>,
    minutes: Vec<u8>,
    hours: Vec<u8>,
    days_of_month: Vec<u8>,
    months: Vec<u8>,
    days_of_week: Vec<u8>,
    dom_last: bool,
    dow_last: Vec<u8>,
    dow_nth: Vec<(u8, u8)>,
    dom_restricted: bool,
    dow_restricted: bool,
}

// VERIFY: crons-expr-validate
/// Parses `expr` and discards the schedule; the error string is what the HTTP
/// layer returns verbatim as `{ok:false,error}` with status 400.
pub fn validate(expr: &str) -> Result<(), String> {
    parse(expr).map(|_| ())
}

// VERIFY: crons-expr-next
/// The first matching instant strictly after `from_ms`, in epoch milliseconds.
pub fn next_fire_after(expr: &str, from_ms: i64) -> Result<i64, String> {
    parse(expr)?.next_after(from_ms)
}

// VERIFY: crons-expr-iso
/// `toISOString()` shape: `YYYY-MM-DDTHH:MM:SS.mmmZ`, always three fraction
/// digits. `time::Rfc3339` trims a zero fraction, so this is formatted by hand.
pub fn iso_utc(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let instant =
        OffsetDateTime::from_unix_timestamp(seconds).unwrap_or(OffsetDateTime::UNIX_EPOCH);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        instant.year(),
        u8::from(instant.month()),
        instant.day(),
        instant.hour(),
        instant.minute(),
        instant.second(),
        millis
    )
}

fn parse(expr: &str) -> Result<Schedule, String> {
    // Reference quirk: the empty string parses as "every minute"; a
    // whitespace-only string is rejected.
    let source = if expr.is_empty() {
        "* * * * *"
    } else {
        let trimmed = expr.trim();
        if trimmed.is_empty() {
            return Err("Invalid characters, got value: ".to_owned());
        }
        trimmed
    };
    let expanded = expand_alias(source)?;
    let fields: Vec<&str> = expanded.split_whitespace().collect();
    let (seconds, minutes, hours, dom, months, dow) = match fields.len() {
        // A 5-field expression fires at second 0, not every second.
        5 => ("0", fields[0], fields[1], fields[2], fields[3], fields[4]),
        6 => (
            fields[0], fields[1], fields[2], fields[3], fields[4], fields[5],
        ),
        count => {
            return Err(format!(
                "Constraint error, expected 5 or 6 fields, got {count}"
            ));
        }
    };

    let second_values = parse_simple(seconds, SECONDS, None)?;
    let minute_values = parse_simple(minutes, MINUTES, None)?;
    let hour_values = parse_simple(hours, HOURS, None)?;
    let month_values = parse_simple(months, MONTHS, Some(&MONTH_NAMES))?;
    ensure_unique(&second_values, SECONDS.label)?;
    ensure_unique(&minute_values, MINUTES.label)?;
    ensure_unique(&hour_values, HOURS.label)?;
    ensure_unique(&month_values, MONTHS.label)?;

    let (day_values, dom_last) = parse_day_of_month(dom)?;
    ensure_unique(&day_values, DAY_OF_MONTH.label)?;
    let (dow_values, dow_last, dow_nth) = parse_day_of_week(dow)?;

    let dom_restricted = !is_wildcard(dom);
    let dow_restricted = !is_wildcard(dow);

    // A day-of-month that cannot exist in the one selected month is rejected
    // by the reference only when day-of-week is a wildcard (otherwise the OR
    // rule can still match) and the month field has exactly one value.
    if !dow_restricted && month_values.len() == 1 && !day_values.is_empty() {
        let month = month_values[0];
        let max_day = max_days_in_month(month);
        if *day_values.iter().min().unwrap_or(&1) > max_day {
            return Err("Invalid explicit day of month definition".to_owned());
        }
    }

    let mut seconds = second_values;
    let mut minutes = minute_values;
    let mut hours = hour_values;
    let mut days_of_month = day_values;
    let mut months = month_values;
    let mut days_of_week = dow_values;
    seconds.sort_unstable();
    minutes.sort_unstable();
    hours.sort_unstable();
    days_of_month.sort_unstable();
    months.sort_unstable();
    days_of_week.sort_unstable();
    days_of_week.dedup();

    Ok(Schedule {
        seconds,
        minutes,
        hours,
        days_of_month,
        months,
        days_of_week,
        dom_last,
        dow_last,
        dow_nth,
        dom_restricted,
        dow_restricted,
    })
}

fn expand_alias(source: &str) -> Result<String, String> {
    if !source.starts_with('@') {
        return Ok(source.to_owned());
    }
    let expanded = match source {
        "@yearly" | "@annually" => "0 0 1 1 *",
        "@monthly" => "0 0 1 * *",
        "@weekly" => "0 0 * * 0",
        "@daily" => "0 0 * * *",
        "@hourly" => "0 * * * *",
        other => {
            return Err(format!(
                "Validation error, cannot resolve alias \"{other}\""
            ));
        }
    };
    Ok(expanded.to_owned())
}

fn is_wildcard(raw: &str) -> bool {
    raw == "*" || raw == "?"
}

fn parse_simple(raw: &str, spec: Spec, names: Option<&[(&str, u8)]>) -> Result<Vec<u8>, String> {
    if is_wildcard(raw) {
        return Ok((spec.min..=spec.max).collect());
    }
    let mut values = Vec::new();
    for item in raw.split(',') {
        if item.is_empty() {
            return Err("Invalid list value format".to_owned());
        }
        values.extend(parse_item(item, spec, names, false)?);
    }
    Ok(values)
}

/// One comma-list item: `a`, `a-b`, `a/n`, `a-b/n`, `*/n`.
///
/// `dow_range_keeps_max` reproduces the measured reference quirk where a
/// day-of-week range ending at 7 keeps 7 even when the step would skip it
/// (`6-7/2` → {6,7}, `3-7/2` → {3,5,7}).
fn parse_item(
    item: &str,
    spec: Spec,
    names: Option<&[(&str, u8)]>,
    dow_range_keeps_max: bool,
) -> Result<Vec<u8>, String> {
    let (base, step) = match item.split_once('/') {
        Some((base, raw_step)) => {
            let step: u32 = raw_step.parse().map_err(|_| {
                format!("Constraint error, cannot repeat at every {raw_step} time.")
            })?;
            if step == 0 {
                return Err("Constraint error, cannot repeat at every 0 time.".to_owned());
            }
            (base, Some(step))
        }
        None => (item, None),
    };
    let explicit_range = base.contains('-') && base != "*" && base != "?";
    let (start, end) = if base == "*" || base == "?" {
        (spec.min, spec.max)
    } else if let Some((left, right)) = base.split_once('-') {
        let start = parse_value(left, spec, names)?;
        let end = parse_value(right, spec, names)?;
        if start > end {
            return Err(format!(
                "Invalid range: {left}-{right}, min({start}) > max({end})"
            ));
        }
        (start, end)
    } else {
        let start = parse_value(base, spec, names)?;
        (start, if step.is_some() { spec.max } else { start })
    };
    let step = step.unwrap_or(1);
    let mut values = Vec::new();
    let mut value = u64::from(start);
    let end = u64::from(end);
    let step = u64::from(step);
    while value <= end {
        values.push(value as u8);
        value += step;
    }
    if dow_range_keeps_max && explicit_range && end == 7 && !values.contains(&7) {
        values.push(7);
    }
    Ok(values)
}

fn parse_value(token: &str, spec: Spec, names: Option<&[(&str, u8)]>) -> Result<u8, String> {
    if let Ok(value) = token.parse::<u64>() {
        if value < u64::from(spec.min) || value > u64::from(spec.max) {
            return Err(format!(
                "Constraint error, got value {value} expected range {}-{}",
                spec.min, spec.max
            ));
        }
        return Ok(value as u8);
    }
    if let Some(names) = names {
        if let Some((_, value)) = names
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(token))
        {
            return Ok(*value);
        }
    }
    Err(format!("Invalid characters, got value: {token}"))
}

fn ensure_unique(values: &[u8], label: &str) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for value in values {
        if !seen.insert(*value) {
            return Err(format!(
                "{label} Validation error, duplicate values found: {value}"
            ));
        }
    }
    Ok(())
}

fn parse_day_of_month(raw: &str) -> Result<(Vec<u8>, bool), String> {
    if is_wildcard(raw) {
        return Ok(((1..=31).collect(), false));
    }
    let mut values = Vec::new();
    let mut last = false;
    for item in raw.split(',') {
        if item.is_empty() {
            return Err("Invalid list value format".to_owned());
        }
        if item == "L" {
            last = true;
            continue;
        }
        values.extend(parse_item(item, DAY_OF_MONTH, None, false)?);
    }
    Ok((values, last))
}

fn parse_day_of_week(raw: &str) -> Result<(Vec<u8>, Vec<u8>, Vec<(u8, u8)>), String> {
    if is_wildcard(raw) {
        return Ok(((0..=6).collect(), Vec::new(), Vec::new()));
    }
    if raw.contains('#') && raw.contains(',') {
        return Err(
            "Constraint error, invalid dayOfWeek `#` and `,` special characters are incompatible"
                .to_owned(),
        );
    }
    let mut values = Vec::new();
    let mut last = Vec::new();
    let mut nth = Vec::new();
    for item in raw.split(',') {
        if item.is_empty() {
            return Err("Invalid list value format".to_owned());
        }
        if let Some((left, occurrence_raw)) = item.split_once('#') {
            if left.contains('-') || left.contains('/') {
                return Err(
                    "Constraint error, invalid dayOfWeek `#` and `-` special characters are incompatible"
                        .to_owned(),
                );
            }
            if let Some(prefix) = left.strip_suffix('L') {
                // Measured quirk: `5L#3` behaves exactly like `5L`.
                let day = parse_value(prefix, DAY_OF_WEEK, Some(&DOW_NAMES))?;
                last.push(normalize_weekday(day));
                continue;
            }
            let day = parse_value(left, DAY_OF_WEEK, Some(&DOW_NAMES))?;
            let occurrence: u8 = occurrence_raw.parse().map_err(|_| {
                "Constraint error, invalid dayOfWeek occurrence number (#)".to_owned()
            })?;
            if !(1..=5).contains(&occurrence) {
                return Err("Constraint error, invalid dayOfWeek occurrence number (#)".to_owned());
            }
            nth.push((normalize_weekday(day), occurrence));
        } else if let Some(prefix) = item.strip_suffix('L') {
            if prefix.is_empty() {
                return Err("CronDayOfWeek Validation error, unexpected standalone L".to_owned());
            }
            if prefix.contains('-') || prefix.contains('/') {
                return Err(format!("Invalid characters, got value: {item}"));
            }
            let day = parse_value(prefix, DAY_OF_WEEK, Some(&DOW_NAMES))?;
            last.push(normalize_weekday(day));
        } else {
            values.extend(parse_item(item, DAY_OF_WEEK, Some(&DOW_NAMES), true)?);
        }
    }
    Ok((
        values.into_iter().map(normalize_weekday).collect(),
        last,
        nth,
    ))
}

fn normalize_weekday(day: u8) -> u8 {
    if day == 7 { 0 } else { day }
}

impl Schedule {
    fn next_after(&self, from_ms: i64) -> Result<i64, String> {
        let seconds = from_ms.div_euclid(1000);
        let floor = OffsetDateTime::from_unix_timestamp(seconds)
            .map_err(|_| "Invalid expression, timestamp out of range".to_owned())?;
        // Strictly after: start at the next whole second.
        let start = floor + Duration::seconds(1);
        let start_date = start.date();
        // Eight years covers the longest leap-day gap (2096-03-01 → 2104-02-29).
        let horizon_days: i64 = 366 * 8 + 2;
        for offset in 0..horizon_days {
            let Some(date) = start_date.checked_add(Duration::days(offset)) else {
                break;
            };
            if !self.months.contains(&u8::from(date.month())) {
                continue;
            }
            if !self.day_matches(date) {
                continue;
            }
            for &hour in &self.hours {
                for &minute in &self.minutes {
                    for &second in &self.seconds {
                        let candidate = match date.with_hms(hour, minute, second) {
                            Ok(candidate) => candidate.assume_utc(),
                            Err(_) => continue,
                        };
                        if candidate >= start {
                            return Ok(candidate.unix_timestamp() * 1000);
                        }
                    }
                }
            }
        }
        Err("Invalid expression, no fire time within 8 years".to_owned())
    }

    fn day_matches(&self, date: Date) -> bool {
        let month = u8::from(date.month());
        let dom_ok = self.days_of_month.contains(&date.day())
            || (self.dom_last && date.day() == days_in_month(date.year(), month));
        let weekday = date.weekday().number_days_from_sunday();
        let dow_ok = self.days_of_week.contains(&weekday)
            || (self.dow_last.contains(&weekday)
                && date.day() + 7 > days_in_month(date.year(), month))
            || self
                .dow_nth
                .iter()
                .any(|(day, occurrence)| *day == weekday && nth_occurrence(date) == *occurrence);
        match (self.dom_restricted, self.dow_restricted) {
            (true, true) => dom_ok || dow_ok,
            (true, false) => dom_ok,
            (false, true) => dow_ok,
            (false, false) => true,
        }
    }
}

/// Which occurrence of its weekday `date` is (1..=5).
fn nth_occurrence(date: Date) -> u8 {
    (date.day() - 1) / 7 + 1
}

#[cfg(test)]
mod tests {
    use super::{iso_utc, next_fire_after, validate};
    use time::{Date, Month};

    fn at(year: i32, month: Month, day: u8, hour: u8, minute: u8, second: u8) -> i64 {
        Date::from_calendar_date(year, month, day)
            .unwrap()
            .with_hms(hour, minute, second)
            .unwrap()
            .assume_utc()
            .unix_timestamp()
            * 1000
    }

    fn base() -> i64 {
        at(2026, Month::January, 15, 10, 30, 0)
    }

    fn next(expr: &str) -> String {
        iso_utc(next_fire_after(expr, base()).unwrap())
    }

    // VERIFY: crons-expr-second
    #[test]
    fn five_and_six_field_forms_match_the_reference() {
        assert_eq!(next("* * * * *"), "2026-01-15T10:31:00.000Z");
        assert_eq!(next("* * * * * *"), "2026-01-15T10:30:01.000Z");
        assert!(validate("0 0 * * * 2026").is_err(), "7 fields rejected");
        assert!(validate("0 0 * *").is_err());
    }

    // VERIFY: crons-expr-wildcard
    #[test]
    fn question_mark_is_a_wildcard_in_every_field() {
        assert_eq!(next("? ? ? ? ?"), "2026-01-15T10:31:00.000Z");
        assert_eq!(next("? * * * * *"), "2026-01-15T10:30:01.000Z");
        assert_eq!(next("0 0 15 * ?"), "2026-02-15T00:00:00.000Z");
    }

    // VERIFY: crons-expr-steps
    #[test]
    fn ranges_steps_and_lists_match_the_reference() {
        assert_eq!(next("*/5 * * * *"), "2026-01-15T10:35:00.000Z");
        assert_eq!(next("1-5/2 * * * *"), "2026-01-15T11:01:00.000Z");
        assert_eq!(next("5/2 * * * *"), "2026-01-15T10:31:00.000Z");
        assert_eq!(next("30/20 * * * *"), "2026-01-15T10:50:00.000Z");
        assert_eq!(next("5/100 * * * *"), "2026-01-15T11:05:00.000Z");
        assert_eq!(next("0 0 * * 1-5/2"), "2026-01-16T00:00:00.000Z");
        assert_eq!(next("0 0 * * 1-5/10"), "2026-01-19T00:00:00.000Z");
    }

    // VERIFY: crons-expr-names
    #[test]
    fn names_are_case_insensitive_and_weekday_seven_is_sunday() {
        assert_eq!(next("0 0 * jan-mar *"), "2026-01-16T00:00:00.000Z");
        assert_eq!(next("0 0 * * mon-fri"), "2026-01-16T00:00:00.000Z");
        assert_eq!(next("0 0 * * 0"), "2026-01-18T00:00:00.000Z");
        assert_eq!(next("0 0 * * 7"), "2026-01-18T00:00:00.000Z");
        assert_eq!(next("0 0 * * SUN"), "2026-01-18T00:00:00.000Z");
        assert_eq!(next("0 0 * * 0-7"), "2026-01-16T00:00:00.000Z");
        assert_eq!(next("0 0 * * 6-7/2"), "2026-01-17T00:00:00.000Z");
        assert_eq!(next("0 0 * * 3-7/2"), "2026-01-16T00:00:00.000Z");
    }

    // VERIFY: crons-expr-dom-last
    #[test]
    fn day_of_month_last_is_supported_but_l_minus_n_and_w_are_not() {
        assert_eq!(next("0 0 L * *"), "2026-01-31T00:00:00.000Z");
        assert_eq!(next("0 0 L 2 *"), "2026-02-28T00:00:00.000Z");
        assert_eq!(next("0 0 1,L * *"), "2026-01-31T00:00:00.000Z");
        assert_eq!(next("0 0 L,15 * *"), "2026-01-31T00:00:00.000Z");
        for unsupported in ["0 0 L-3 * *", "0 0 15W * *", "0 0 1W * *", "0 0 LW * *"] {
            assert!(
                validate(unsupported).is_err(),
                "{unsupported} must be rejected"
            );
        }
    }

    // VERIFY: crons-expr-dow-specials
    #[test]
    fn nth_and_last_weekdays_match_the_reference() {
        assert_eq!(next("0 0 * * 5#3"), "2026-01-16T00:00:00.000Z");
        assert_eq!(next("0 0 * * 5L"), "2026-01-30T00:00:00.000Z");
        assert_eq!(next("0 0 * * 0L"), "2026-01-25T00:00:00.000Z");
        assert_eq!(next("0 0 * * 7L"), "2026-01-25T00:00:00.000Z");
        assert_eq!(next("0 0 * * MONL"), "2026-01-26T00:00:00.000Z");
        assert_eq!(next("0 0 * * 5L,1"), "2026-01-19T00:00:00.000Z");
        // Reference quirk: the trailing occurrence after `nL` is ignored.
        assert_eq!(next("0 0 * * 5L#3"), "2026-01-30T00:00:00.000Z");
        for unsupported in [
            "0 0 * * L",
            "0 0 * * 1,L",
            "0 0 * * 1-5#2",
            "0 0 * * 5#0",
            "0 0 * * 5l",
        ] {
            assert!(
                validate(unsupported).is_err(),
                "{unsupported} must be rejected"
            );
        }
    }

    // VERIFY: crons-expr-day-rule
    #[test]
    fn restricted_day_fields_use_the_or_rule() {
        // Both restricted: union (Fridays), not the 13th.
        assert_eq!(next("0 0 13 * 5"), "2026-01-16T00:00:00.000Z");
        assert_eq!(next("0 0 15 * 5"), "2026-01-16T00:00:00.000Z");
        assert_eq!(next("0 0 L * 5"), "2026-01-16T00:00:00.000Z");
        // Only day-of-week restricted.
        assert_eq!(next("0 0 ? * 5"), "2026-01-16T00:00:00.000Z");
        // Only day-of-month restricted.
        assert_eq!(next("0 0 15 * ?"), "2026-02-15T00:00:00.000Z");
    }

    // VERIFY: crons-expr-dom-impossible
    #[test]
    fn impossible_explicit_days_are_rejected_like_the_reference() {
        for invalid in ["0 0 31 2 *", "0 0 30 2 *", "0 0 31 4 *", "0 0 30-31 2 *"] {
            assert!(validate(invalid).is_err(), "{invalid} must be rejected");
        }
        for valid in [
            "0 0 29 2 *",
            "0 0 28-31 2 *",
            "0 0 1-31 2 *",
            "0 0 1-30 2 *",
            "0 0 30-31 4 *",
            "0 0 31 2,3 *",
            "0 0 31 1,4 *",
            "0 0 30 2 5",
        ] {
            assert!(validate(valid).is_ok(), "{valid} must be accepted");
        }
    }

    // VERIFY: crons-expr-duplicates
    #[test]
    fn duplicate_values_are_rejected_except_for_day_of_week() {
        for invalid in [
            "1,1 * * * *",
            "0 0 1,1 * *",
            "0 0 * 2,2 *",
            "0 0 1-5,3 * *",
            "*/5,10 * * * *",
        ] {
            assert!(validate(invalid).is_err(), "{invalid} must be rejected");
        }
        for valid in [
            "0 0 * * 1,1",
            "0 0 * * 0,7",
            "0 0 * * 7,7",
            "0 0 * * SUN,SUN",
        ] {
            assert!(validate(valid).is_ok(), "{valid} must be accepted");
        }
    }

    // VERIFY: crons-expr-alias
    #[test]
    fn aliases_are_lowercase_only_and_midnight_is_unsupported() {
        assert_eq!(next("@daily"), "2026-01-16T00:00:00.000Z");
        assert_eq!(next("@hourly"), "2026-01-15T11:00:00.000Z");
        assert_eq!(next("@weekly"), "2026-01-18T00:00:00.000Z");
        assert_eq!(next("@monthly"), "2026-02-01T00:00:00.000Z");
        assert_eq!(next("@yearly"), "2027-01-01T00:00:00.000Z");
        assert_eq!(next("@annually"), "2027-01-01T00:00:00.000Z");
        for unsupported in ["@midnight", "@DAILY", "@Daily", "@reboot", "@", "@foo"] {
            assert!(
                validate(unsupported).is_err(),
                "{unsupported} must be rejected"
            );
        }
    }

    // VERIFY: crons-expr-strictly-after
    #[test]
    fn next_fire_is_strictly_after_the_supplied_instant() {
        // Exactly on a match: the following match is returned.
        assert_eq!(
            iso_utc(next_fire_after("* * * * *", at(2026, Month::January, 15, 10, 30, 0)).unwrap()),
            "2026-01-15T10:31:00.000Z"
        );
        // Sub-second offset still lands on the next whole second.
        assert_eq!(
            iso_utc(next_fire_after("* * * * * *", base() + 500).unwrap()),
            "2026-01-15T10:30:01.000Z"
        );
    }

    // VERIFY: crons-expr-horizon
    #[test]
    fn leap_day_schedules_cross_the_longest_gap() {
        let from = at(2096, Month::March, 1, 0, 0, 0);
        assert_eq!(
            iso_utc(next_fire_after("0 0 29 2 *", from).unwrap()),
            "2104-02-29T00:00:00.000Z"
        );
    }

    // VERIFY: crons-expr-iso-test
    #[test]
    fn iso_format_always_carries_three_fraction_digits() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(iso_utc(999), "1970-01-01T00:00:00.999Z");
    }

    // VERIFY: crons-expr-errors
    #[test]
    fn malformed_expressions_fail_with_a_message() {
        for invalid in [
            "not a cron",
            "0 0 * *",
            "60 * * * *",
            "0 0 0 * *",
            "0 0 * 13 *",
            "0 0 * * 8",
            "5-1 * * * *",
            "0 0 * * SAT-SUN",
            "* * * * */0",
            "   ",
        ] {
            let error = validate(invalid).unwrap_err();
            assert!(!error.is_empty(), "{invalid} must carry a message");
        }
        // Reference quirk: the empty string means "every minute".
        assert!(validate("").is_ok());
    }
}
