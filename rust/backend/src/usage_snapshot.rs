//! Provider usage snapshot storage and local reads.
//!
//! Paths are supplied by the caller; this module never discovers application paths.
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use time::format_description::well_known::Rfc3339;
use time::{Date, OffsetDateTime, Time};

const TAIL_BYTES: usize = 8192;
const CODEX_HEARTBEAT_MS: i64 = 5 * 60 * 1000;

type Fields = Vec<(String, Box<RawValue>)>;

/// One typed operation accepted by the future early raw-dispatch branch.
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum SnapshotRequest {
    AppendOllama {
        path: PathBuf,
        reading: Box<RawValue>,
        now_ms: i64,
    },
    AppendCodex {
        path: PathBuf,
        reading: Box<RawValue>,
        now_ms: i64,
    },
    AppendClaude {
        live_path: PathBuf,
        archive_dir: PathBuf,
        cost_state: bool,
        raw: Box<RawValue>,
        now_ms: i64,
        cost_reading: Option<ClaudeCostReading>,
    },
    ReadClaude {
        live_path: PathBuf,
        selected_archive_path: Option<PathBuf>,
        max_age_ms: i64,
        now_ms: i64,
    },
    ReadCodex {
        path: PathBuf,
        max_age_ms: i64,
        now_ms: i64,
    },
    ReadCostState {
        directory: PathBuf,
        max_age_ms: i64,
        now_ms: i64,
    },
}

#[derive(Deserialize)]
pub struct ClaudeCostReading {
    pub session: Box<RawValue>,
    pub weekly: Box<RawValue>,
    #[serde(default)]
    pub fetched_at_ms: Option<i64>,
}

#[derive(Serialize)]
#[serde(tag = "kind", content = "result", rename_all = "snake_case")]
pub enum SnapshotResponse {
    Append(AppendResult),
    ClaudeSnapshot(Option<ClaudeSnapshot>),
    CodexSnapshot(Option<CodexSnapshot>),
    CostState(Option<CostStateLimits>),
}

#[derive(Deserialize)]
#[serde(transparent)]
struct RawFields(#[serde(deserialize_with = "deserialize_fields")] Fields);

fn deserialize_fields<'de, D>(deserializer: D) -> Result<Fields, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct FieldsVisitor;
    impl<'de> Visitor<'de> for FieldsVisitor {
        type Value = Fields;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a JSON object")
        }
        fn visit_map<A>(self, mut map: A) -> Result<Fields, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut fields = Vec::new();
            while let Some(field) = map.next_entry::<String, Box<RawValue>>()? {
                fields.push(field);
            }
            Ok(fields)
        }
    }
    deserializer.deserialize_map(FieldsVisitor)
}

fn fields(raw: &RawValue) -> Option<Fields> {
    if !raw.get().starts_with('{') {
        return None;
    }
    serde_json::from_str::<RawFields>(raw.get())
        .ok()
        .map(|v| v.0)
}

fn get<'a>(fields: &'a Option<Fields>, key: &str) -> Option<&'a RawValue> {
    fields
        .as_ref()?
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_ref())
}

fn js_truthy(raw: Option<&RawValue>) -> bool {
    let Some(raw) = raw else { return false };
    match raw.get() {
        "null" | "false" => false,
        "0" | "-0" | "0.0" | "\"\"" => false,
        value if value.starts_with('"') => serde_json::from_str::<String>(value)
            .map(|v| !v.is_empty())
            .unwrap_or(true),
        _ => true,
    }
}

fn finite_number(raw: Option<&RawValue>) -> Option<f64> {
    let raw = raw?;
    if raw.get().starts_with('"') || raw.get().starts_with('{') || raw.get().starts_with('[') {
        return None;
    }
    let value = raw.get().parse::<f64>().ok()?;
    value.is_finite().then_some(value)
}

fn same_js_primitive(a: Option<&RawValue>, b: Option<&RawValue>) -> bool {
    let a = a.filter(|v| v.get() != "null");
    let b = b.filter(|v| v.get() != "null");
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) if a.get().starts_with('"') && b.get().starts_with('"') => {
            serde_json::from_str::<String>(a.get()).ok()
                == serde_json::from_str::<String>(b.get()).ok()
        }
        (Some(a), Some(b))
            if a.get().starts_with('{')
                || a.get().starts_with('[')
                || b.get().starts_with('{')
                || b.get().starts_with('[') =>
        {
            false
        }
        (Some(a), Some(b)) => match (finite_number(Some(a)), finite_number(Some(b))) {
            (Some(a), Some(b)) => a == b,
            _ => a.get() == b.get(),
        },
        _ => false,
    }
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("serializing a string cannot fail")
}

fn field_or_omit(out: &mut Vec<String>, name: &str, value: Option<&RawValue>) {
    if let Some(value) = value {
        out.push(format!("{}:{}", json_string(name), value.get()));
    }
}

fn local_timestamp(epoch_ms: i64) -> Option<String> {
    let (year, month, day, hour, minute, second) = local_parts(epoch_ms.div_euclid(1000))?;
    Some(format!(
        "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}"
    ))
}

fn local_month(epoch_ms: i64) -> Option<String> {
    let (year, month, _, _, _, _) = local_parts(epoch_ms.div_euclid(1000))?;
    Some(format!("{year:04}-{month:02}"))
}

fn parse_date_ms(value: &str) -> Option<i64> {
    if let Ok(dt) = OffsetDateTime::parse(value, &Rfc3339) {
        return i64::try_from(dt.unix_timestamp_nanos() / 1_000_000).ok();
    }
    if let Some(at) = parse_legacy_date_ms(value) {
        return Some(at);
    }
    if let Some(epoch) = parse_iso_date_or_datetime_ms(value) {
        return Some(epoch);
    }
    let date_only = value.len() == 10;
    let (date, time, zone) = if date_only {
        (parse_date(&value[..10])?, Time::MIDNIGHT, None)
    } else {
        let separator = value.find('T').or_else(|| value.find(' '))?;
        let clock_and_zone = value.get(separator + 1..)?;
        let (clock, zone) = if let Some(clock) = clock_and_zone.strip_suffix('Z') {
            (clock, Some("Z"))
        } else {
            match clock_and_zone.find(['+', '-']) {
                Some(i) => (&clock_and_zone[..i], Some(&clock_and_zone[i..])),
                None => (clock_and_zone, None),
            }
        };
        (parse_date(&value[..separator])?, parse_clock(clock)?, zone)
    };
    if date_only {
        let epoch = Date::from_calendar_date(1970, time::Month::January, 1).ok()?;
        let days = date.to_julian_day() as i64 - epoch.to_julian_day() as i64;
        return Some(days * 86_400_000);
    }
    if let Some(zone) = zone {
        if zone == "Z" {
            return utc_epoch_ms(date, time);
        }
        let sign = if zone.starts_with('-') { -1i64 } else { 1 };
        let digits = zone[1..].replace(':', "");
        if digits.len() != 4 {
            return None;
        }
        let hours: i64 = digits[..2].parse().ok()?;
        let minutes: i64 = digits[2..].parse().ok()?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        Some(utc_epoch_ms(date, time)? - sign * (hours * 60 + minutes) * 60_000)
    } else {
        local_to_epoch_ms(date, time)
    }
}

fn parse_iso_date_or_datetime_ms(value: &str) -> Option<i64> {
    let expanded = value.starts_with('+') || value.starts_with('-');
    let (year, date_text, rest) = if expanded {
        let year_end = value[1..].find('-')? + 1;
        if year_end != 7 {
            return None;
        }
        let year = value[..year_end].parse::<i32>().ok()?;
        if value.starts_with('-') && year == 0 {
            return None;
        }
        let tail = value.get(year_end + 1..)?;
        let date_len = if tail.as_bytes().get(2) == Some(&b'-') {
            5
        } else {
            2
        };
        let date_text = tail.get(..date_len)?;
        (year, date_text, tail.get(date_len..).unwrap_or(""))
    } else {
        let year = value.get(..4)?.parse::<i32>().ok()?;
        let tail = value.get(5..)?;
        let date_len = if tail.as_bytes().get(2) == Some(&b'-') {
            5
        } else {
            2
        };
        let date_text = tail.get(..date_len)?;
        (year, date_text, tail.get(date_len..).unwrap_or(""))
    };
    if expanded && date_text.len() == 2 {
        let month = date_text.parse::<u8>().ok()?;
        return rest
            .is_empty()
            .then(|| year_month_start_ms(year, month))
            .flatten();
    }
    if date_text.len() == 2 && !expanded && rest.is_empty() {
        let month = date_text.parse::<u8>().ok()?;
        return year_month_start_ms(year, month);
    }
    if date_text.len() != 5 {
        return None;
    }
    let month = date_text.get(0..2)?.parse::<u8>().ok()?;
    let day = date_text.get(3..5)?.parse::<u8>().ok()?;
    if date_text.as_bytes().get(2) != Some(&b'-') || day == 0 || day > 31 {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    let mut millis = days.checked_mul(86_400_000)?;
    if rest.is_empty() {
        return (millis.abs() <= 8_640_000_000_000_000).then_some(millis);
    }
    let rest = rest.strip_prefix(['T', ' '])?;
    let zone_at = rest.find(['Z', '+', '-']).unwrap_or(rest.len());
    let clock = parse_clock(&rest[..zone_at])?;
    millis = millis.checked_add(
        i64::from(clock.hour()) * 3_600_000
            + i64::from(clock.minute()) * 60_000
            + i64::from(clock.second()) * 1_000
            + i64::from(clock.millisecond()),
    )?;
    let zone = &rest[zone_at..];
    if zone.is_empty() {
        let at = local_to_epoch_civil(year, month, day, clock)?;
        return (at.abs() <= 8_640_000_000_000_000).then_some(at);
    }
    if zone != "Z" {
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let digits = zone[1..].replace(':', "");
        if digits.len() != 4 {
            return None;
        }
        let hours = digits[..2].parse::<i64>().ok()?;
        let minutes = digits[2..].parse::<i64>().ok()?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        millis = millis.checked_sub(sign * (hours * 60 + minutes) * 60_000)?;
    }
    (millis.abs() <= 8_640_000_000_000_000).then_some(millis)
}

fn days_from_civil(year: i32, month: u8, day: u8) -> Option<i64> {
    if !(1..=12).contains(&month) {
        return None;
    }
    let y = i64::from(year) - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let next_month = if month == 12 { 1 } else { month + 1 };
    let next_year = year + i32::from(month == 12);
    let max_day = days_from_civil_unchecked_month(next_year, next_month)
        - days_from_civil_unchecked_month(year, month);
    (day <= max_day as u8).then_some(days)
}

fn days_from_civil_unchecked_month(year: i32, month: u8) -> i64 {
    let y = i64::from(year) - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

fn parse_legacy_date_ms(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if let Some(at) = parse_named_date_ms(trimmed) {
        return Some(at);
    }
    if let Some(at) = parse_slash_date_ms(trimmed) {
        return Some(at);
    }
    if let Some(at) = parse_comma_date_ms(trimmed) {
        return Some(at);
    }
    let unsigned = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    if let Some((month, day)) = unsigned.split_once('.') {
        if month.bytes().all(|byte| byte.is_ascii_digit())
            && day.bytes().all(|byte| byte.is_ascii_digit())
        {
            let month = month.parse::<u8>().ok()?;
            let day = day.parse::<u8>().ok()?;
            let date = Date::from_calendar_date(2001, month.try_into().ok()?, 1).ok()?
                + time::Duration::days(i64::from(day.checked_sub(1)?));
            return local_to_epoch_ms(date, Time::MIDNIGHT);
        }
    }
    let digits = unsigned.split('.').next().unwrap_or("");
    if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) {
        let number = digits.parse::<u32>().ok()?;
        let (year, month) = match digits.len() {
            1 | 2 if number == 0 => (2000, 1),
            1 | 2 if number <= 12 => (2001, number as u8),
            1 | 2 if (32..=49).contains(&number) => (2000 + number as i32, 1),
            1 | 2 if (50..=99).contains(&number) => (1900 + number as i32, 1),
            1 | 2 => return None,
            _ => (i32::try_from(number).ok()?, 1),
        };
        return year_month_start_ms(year, month);
    }
    None
}

fn parse_slash_date_ms(value: &str) -> Option<i64> {
    let parts = value.split('/').collect::<Vec<_>>();
    if parts.len() != 3 {
        return None;
    }
    let (year, month, day) = if parts[0].len() == 4 {
        (
            parts[0].parse::<i32>().ok()?,
            parts[1].parse::<u8>().ok()?,
            parts[2].parse::<u8>().ok()?,
        )
    } else {
        (
            legacy_year(parts[2])?,
            parts[0].parse::<u8>().ok()?,
            parts[1].parse::<u8>().ok()?,
        )
    };
    let date = Date::from_calendar_date(year, month.try_into().ok()?, 1).ok()?
        + time::Duration::days(i64::from(day.checked_sub(1)?));
    local_to_epoch_ms(date, Time::MIDNIGHT)
}

fn parse_comma_date_ms(value: &str) -> Option<i64> {
    let parts = value.split(',').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0].len() != 4 {
        return None;
    }
    let year = parts[0].parse::<i32>().ok()?;
    let month = parts[1].parse::<u8>().ok()?;
    let day = parts[2].parse::<u8>().ok()?;
    let date = Date::from_calendar_date(year, month.try_into().ok()?, 1).ok()?
        + time::Duration::days(i64::from(day.checked_sub(1)?));
    local_to_epoch_ms(date, Time::MIDNIGHT)
}

fn parse_named_date_ms(value: &str) -> Option<i64> {
    let mut cleaned = value.to_owned();
    while let Some(start) = cleaned.find('(') {
        let end = cleaned[start..].find(')')? + start;
        cleaned.replace_range(start..=end, " ");
    }
    let parts = cleaned
        .replace(',', " ")
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let month_index = parts.iter().position(|part| month_number(part).is_some())?;
    let month = month_number(&parts[month_index])?;
    let left = month_index
        .checked_sub(1)
        .and_then(|i| parts.get(i))
        .map(String::as_str);
    let right = parts.get(month_index + 1).map(String::as_str);
    let (year, day) = match (left, right) {
        (Some(left), Some(right))
            if left.bytes().all(|b| b.is_ascii_digit()) && left.len() >= 3 =>
        {
            (legacy_year(left)?, right.parse::<u8>().ok()?)
        }
        (Some(left), Some(right)) if left.bytes().all(|b| b.is_ascii_digit()) => {
            (legacy_year(right)?, left.parse::<u8>().ok()?)
        }
        (Some(_), Some(right)) if right.bytes().all(|b| b.is_ascii_digit()) => (
            legacy_year(parts.get(month_index + 2)?.as_str())?,
            right.parse::<u8>().ok()?,
        ),
        (Some(left), None) if left.bytes().all(|b| b.is_ascii_digit()) && left.len() >= 3 => (
            legacy_year(left)?,
            parts.get(month_index.checked_sub(2)?)?.parse::<u8>().ok()?,
        ),
        (Some(left), Some(right)) => (legacy_year(right)?, left.parse::<u8>().ok()?),
        (None, Some(day)) => (
            legacy_year(parts.get(month_index + 2)?.as_str())?,
            day.parse::<u8>().ok()?,
        ),
        _ => return None,
    };
    let date = Date::from_calendar_date(year, month.try_into().ok()?, 1).ok()?
        + time::Duration::days(i64::from(day.checked_sub(1)?));
    let time = if let Some(part) = parts.iter().find(|part| part.contains(':')) {
        parse_clock(part)?
    } else {
        Time::MIDNIGHT
    };
    let meridiem = parts
        .iter()
        .find(|part| matches!(part.to_ascii_uppercase().as_str(), "AM" | "PM"));
    let time = if let Some(meridiem) = meridiem {
        let hour = match (time.hour(), meridiem.eq_ignore_ascii_case("PM")) {
            (12, false) => 0,
            (hour, true) if hour < 12 => hour + 12,
            (hour, _) => hour,
        };
        Time::from_hms_milli(hour, time.minute(), time.second(), time.millisecond()).ok()?
    } else {
        time
    };
    if let Some(offset) = parts.iter().find_map(|part| timezone_offset_minutes(part)) {
        Some(utc_epoch_ms(date, time)? - i64::from(offset) * 60_000)
    } else {
        local_to_epoch_ms(date, time)
    }
}

fn legacy_year(value: &str) -> Option<i32> {
    let year = value.parse::<i32>().ok()?;
    Some(if value.len() == 2 {
        if year <= 49 { 2000 + year } else { 1900 + year }
    } else {
        year
    })
}

fn timezone_offset_minutes(value: &str) -> Option<i32> {
    let upper = value.to_ascii_uppercase();
    let named = match upper.as_str() {
        "GMT" | "UTC" | "UT" | "Z" => Some(0),
        "PST" => Some(-480),
        "PDT" => Some(-420),
        "MST" => Some(-420),
        "MDT" => Some(-360),
        "CST" => Some(-360),
        "CDT" => Some(-300),
        "EST" => Some(-300),
        "EDT" => Some(-240),
        _ => None,
    };
    if named.is_some() {
        return named;
    }
    let sign = match upper.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let digits = upper[1..].replace(':', "");
    if digits.len() != 4 {
        return None;
    }
    let hour = digits[..2].parse::<i32>().ok()?;
    let minute = digits[2..].parse::<i32>().ok()?;
    (hour <= 23 && minute <= 59).then_some(sign * (hour * 60 + minute))
}

fn month_number(value: &str) -> Option<u8> {
    Some(match value.get(..3)?.to_ascii_lowercase().as_str() {
        "jan" => 1,
        "feb" => 2,
        "mar" => 3,
        "apr" => 4,
        "may" => 5,
        "jun" => 6,
        "jul" => 7,
        "aug" => 8,
        "sep" => 9,
        "oct" => 10,
        "nov" => 11,
        "dec" => 12,
        _ => return None,
    })
}

fn year_start_ms(year: i32) -> Option<i64> {
    let days = if (1..=9999).contains(&year) {
        let date = Date::from_calendar_date(year, time::Month::January, 1).ok()?;
        let epoch = Date::from_calendar_date(1970, time::Month::January, 1).ok()?;
        i64::from(date.to_julian_day() - epoch.to_julian_day())
    } else {
        let prior = i64::from(year) - 1;
        let epoch_prior = 1969i64;
        let days_before_year = |year: i64| 365 * year + year / 4 - year / 100 + year / 400;
        days_before_year(prior) - days_before_year(epoch_prior)
    };
    days.checked_mul(86_400_000)
}

fn year_month_start_ms(year: i32, month: u8) -> Option<i64> {
    if month == 1 {
        return year_start_ms(year);
    }
    let date = Date::from_calendar_date(year, month.try_into().ok()?, 1).ok()?;
    let epoch = Date::from_calendar_date(1970, time::Month::January, 1).ok()?;
    i64::from(date.to_julian_day() - epoch.to_julian_day()).checked_mul(86_400_000)
}

fn parse_fetched_at(raw: &RawValue) -> Option<i64> {
    let at = parse_date_ms(&date_parse_string(raw)?)?;
    (at.abs() <= 8_640_000_000_000_000).then_some(at)
}

fn object_has_own_to_string(raw: &RawValue) -> bool {
    fields(raw).is_some_and(|fields| fields.iter().any(|(name, _)| name == "toString"))
}

fn date_parse_string(raw: &RawValue) -> Option<String> {
    match raw.get() {
        "null" => Some("null".into()),
        "true" => Some("true".into()),
        "false" => Some("false".into()),
        value if value.starts_with('"') => serde_json::from_str(value).ok(),
        value if value.starts_with('[') => {
            let values = serde_json::from_str::<Vec<Box<RawValue>>>(value).ok()?;
            let parts = values
                .iter()
                .map(|item| match item.get() {
                    "null" => Some(String::new()),
                    value if value.starts_with('[') => date_parse_string(item),
                    value if value.starts_with('{') => {
                        if object_has_own_to_string(item) {
                            None
                        } else {
                            Some("[object Object]".into())
                        }
                    }
                    value if value.starts_with('"') => serde_json::from_str(value).ok(),
                    value => Some(number_to_js_string(value)),
                })
                .collect::<Option<Vec<_>>>()?;
            Some(parts.join(","))
        }
        value if value.starts_with('{') => {
            if object_has_own_to_string(raw) {
                None
            } else {
                Some("[object Object]".into())
            }
        }
        value => Some(number_to_js_string(value)),
    }
}

fn number_to_js_string(value: &str) -> String {
    value
        .parse::<f64>()
        .map(|number| {
            if number == 0.0 {
                "0".into()
            } else {
                ryu_js::Buffer::new().format_finite(number).to_owned()
            }
        })
        .unwrap_or_else(|_| value.to_owned())
}

fn utc_epoch_ms(date: Date, time: Time) -> Option<i64> {
    let epoch = Date::from_calendar_date(1970, time::Month::January, 1).ok()?;
    let days = date.to_julian_day() as i64 - epoch.to_julian_day() as i64;
    Some(
        days * 86_400_000
            + i64::from(time.hour()) * 3_600_000
            + i64::from(time.minute()) * 60_000
            + i64::from(time.second()) * 1_000
            + i64::from(time.millisecond()),
    )
}

fn format_snapshot_timestamp(epoch_ms: i64) -> Option<String> {
    let days = epoch_ms.div_euclid(86_400_000);
    let day_ms = epoch_ms.rem_euclid(86_400_000);
    let z = days.checked_add(719_468)?;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let hour = day_ms / 3_600_000;
    let minute = day_ms % 3_600_000 / 60_000;
    let second = day_ms % 60_000 / 1_000;
    let millis = day_ms % 1_000;
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{abs:06}", abs = year.abs())
    } else {
        format!("+{year:06}")
    };
    Some(format!(
        "{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    ))
}

fn parse_date(s: &str) -> Option<Date> {
    let mut parts = s.split('-');
    let year = parts.next()?.parse().ok()?;
    let month = parts.next()?.parse::<u8>().ok()?.try_into().ok()?;
    let day = parts.next()?.parse::<i32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    if !(1..=31).contains(&day) {
        return None;
    }
    let first = Date::from_calendar_date(year, month, 1).ok()?;
    Some(first + time::Duration::days(i64::from(day - 1)))
}

fn parse_clock(s: &str) -> Option<Time> {
    let s = s.strip_suffix('Z').unwrap_or(s);
    let mut parts = s.split(':');
    let hour = parts.next()?.parse().ok()?;
    let minute = parts.next()?.parse().ok()?;
    let seconds = parts.next().unwrap_or("0");
    if parts.next().is_some() {
        return None;
    }
    let (whole_seconds, fractional) = seconds.split_once('.').unwrap_or((seconds, ""));
    let second = whole_seconds.parse().ok()?;
    let millis = if fractional.is_empty() {
        0
    } else {
        let digits = fractional.bytes().take(3).collect::<Vec<_>>();
        let value = std::str::from_utf8(&digits).ok()?.parse::<u16>().ok()?;
        value * 10u16.pow(3u32.saturating_sub(digits.len() as u32))
    };
    let time = Time::from_hms_milli(hour, minute, second, millis).ok()?;
    Some(time)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppendResult {
    pub appended: bool,
    pub error: Option<String>,
}

impl AppendResult {
    fn skipped() -> Self {
        Self {
            appended: false,
            error: None,
        }
    }
    fn success() -> Self {
        Self {
            appended: true,
            error: None,
        }
    }
    fn failure(error: impl ToString) -> Self {
        Self {
            appended: false,
            error: Some(error.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeSnapshot {
    pub raw: Box<RawValue>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotWindow {
    pub utilization: f64,
    pub resets_at: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexSnapshot {
    pub fetched_at: String,
    pub plan: Option<Box<RawValue>>,
    pub session: Option<SnapshotWindow>,
    pub weekly: Option<SnapshotWindow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CostStateLimits {
    pub fetched_at: String,
    pub session: Option<SnapshotWindow>,
    pub weekly: Option<SnapshotWindow>,
}

#[derive(Default)]
pub struct SnapshotService {
    ollama_last: Option<Vec<Option<Box<RawValue>>>>,
    codex_last: Option<Vec<Option<Box<RawValue>>>>,
    codex_last_at: i64,
    claude_cost_last: Option<(Option<Box<RawValue>>, Option<Box<RawValue>>)>,
    rotation_month: Option<String>,
}

impl SnapshotService {
    pub fn execute(&mut self, request: SnapshotRequest) -> SnapshotResponse {
        match request {
            SnapshotRequest::AppendOllama {
                path,
                reading,
                now_ms,
            } => SnapshotResponse::Append(self.append_ollama(&path, &reading, now_ms)),
            SnapshotRequest::AppendCodex {
                path,
                reading,
                now_ms,
            } => SnapshotResponse::Append(self.append_codex(&path, &reading, now_ms)),
            SnapshotRequest::AppendClaude {
                live_path,
                archive_dir,
                cost_state,
                raw,
                now_ms,
                cost_reading,
            } => {
                let cost = cost_reading
                    .as_ref()
                    .map(|v| (v.session.as_ref(), v.weekly.as_ref()));
                let fetched_at_ms = cost_reading.as_ref().and_then(|v| v.fetched_at_ms);
                SnapshotResponse::Append(self.append_claude(
                    &live_path,
                    &archive_dir,
                    cost_state,
                    &raw,
                    now_ms,
                    cost,
                    fetched_at_ms,
                ))
            }
            SnapshotRequest::ReadClaude {
                live_path,
                selected_archive_path,
                max_age_ms,
                now_ms,
            } => SnapshotResponse::ClaudeSnapshot(self.read_claude_snapshot(
                &live_path,
                selected_archive_path.as_deref(),
                max_age_ms,
                now_ms,
            )),
            SnapshotRequest::ReadCodex {
                path,
                max_age_ms,
                now_ms,
            } => {
                SnapshotResponse::CodexSnapshot(self.read_codex_snapshot(&path, max_age_ms, now_ms))
            }
            SnapshotRequest::ReadCostState {
                directory,
                max_age_ms,
                now_ms,
            } => SnapshotResponse::CostState(self.read_cost_state(&directory, max_age_ms, now_ms)),
        }
    }

    pub fn append_ollama(&mut self, path: &Path, reading: &RawValue, now_ms: i64) -> AppendResult {
        let root = fields(reading);
        let session = fields(get(&root, "session").unwrap_or_else(|| raw_null()));
        let weekly = fields(get(&root, "weekly").unwrap_or_else(|| raw_null()));
        let keys = [
            get(&session, "pctUsed"),
            get(&session, "resetsAt"),
            get(&weekly, "pctUsed"),
            get(&weekly, "resetsAt"),
        ];
        let same = self.ollama_last.as_ref().is_some_and(|last| {
            keys.iter()
                .zip(last)
                .all(|(a, b)| same_js_primitive(*a, b.as_deref()))
        });
        if same {
            return AppendResult::skipped();
        }
        let Some(fetched_at) = local_timestamp(now_ms) else {
            return AppendResult::failure("invalid local time");
        };
        let mut row = vec![format!("\"fetched_at\":{}", json_string(&fetched_at))];
        for name in ["session", "weekly"] {
            let window = get(&root, name);
            if !js_truthy(window) {
                row.push(format!("{}:null", json_string(name)));
                continue;
            }
            let value = fields(window.unwrap());
            let mut nested = Vec::new();
            field_or_omit(&mut nested, "utilization", get(&value, "pctUsed"));
            field_or_omit(&mut nested, "resets_at", get(&value, "resetsAt"));
            row.push(format!("{}:{{{}}}", json_string(name), nested.join(",")));
        }
        field_or_omit(
            &mut row,
            "plan",
            get(&root, "plan").filter(|v| v.get() != "null"),
        );
        if get(&root, "plan").is_none_or(|v| v.get() == "null") {
            row.push("\"plan\":null".into());
        }
        let models = fields(get(&root, "weekly").unwrap_or_else(|| raw_null()));
        row.push(format!(
            "\"models\":{}",
            get(&models, "models")
                .filter(|v| v.get() != "null")
                .map(RawValue::get)
                .unwrap_or("[]")
        ));
        match append_line(path, &format!("{{{}}}", row.join(","))) {
            Ok(()) => {
                self.ollama_last = Some(keys.iter().map(|v| v.map(clone_raw)).collect());
                AppendResult::success()
            }
            Err(e) => AppendResult::failure(e),
        }
    }

    pub fn append_codex(&mut self, path: &Path, reading: &RawValue, now_ms: i64) -> AppendResult {
        let root = fields(reading);
        let session = fields(get(&root, "session").unwrap_or_else(|| raw_null()));
        let weekly = fields(get(&root, "weekly").unwrap_or_else(|| raw_null()));
        let keys = [
            get(&session, "pctUsed"),
            get(&session, "resetsAt"),
            None,
            get(&weekly, "pctUsed"),
            get(&weekly, "resetsAt"),
            None,
        ];
        let mut keys = keys;
        keys[2] = get(&session, "started").filter(|v| v.get() == "false");
        keys[5] = get(&weekly, "started").filter(|v| v.get() == "false");
        let reading_same = self.codex_last.as_ref().is_some_and(|last| {
            keys.iter()
                .zip(last)
                .all(|(a, b)| same_js_primitive(*a, b.as_deref()))
        });
        if reading_same && now_ms.saturating_sub(self.codex_last_at) < CODEX_HEARTBEAT_MS {
            return AppendResult::skipped();
        }
        let Some(fetched_at) = local_timestamp(now_ms) else {
            return AppendResult::failure("invalid local time");
        };
        let mut row = vec![format!("\"fetched_at\":{}", json_string(&fetched_at))];
        for name in ["session", "weekly"] {
            let window = get(&root, name);
            if !js_truthy(window) {
                row.push(format!("{}:null", json_string(name)));
                continue;
            }
            let value = fields(window.unwrap());
            let mut nested = Vec::new();
            field_or_omit(&mut nested, "utilization", get(&value, "pctUsed"));
            field_or_omit(&mut nested, "resets_at", get(&value, "resetsAt"));
            if get(&value, "started").is_some_and(|v| v.get() == "false") {
                nested.push("\"started\":false".into());
            }
            row.push(format!("{}:{{{}}}", json_string(name), nested.join(",")));
        }
        field_or_omit(
            &mut row,
            "plan",
            get(&root, "plan").filter(|v| v.get() != "null"),
        );
        if get(&root, "plan").is_none_or(|v| v.get() == "null") {
            row.push("\"plan\":null".into());
        }
        match append_line(path, &format!("{{{}}}", row.join(","))) {
            Ok(()) => {
                self.codex_last = Some(keys.iter().map(|v| v.map(clone_raw)).collect());
                self.codex_last_at = now_ms;
                AppendResult::success()
            }
            Err(e) => AppendResult::failure(e),
        }
    }

    pub fn append_claude(
        &mut self,
        live_path: &Path,
        archive_dir: &Path,
        cost_state: bool,
        raw: &RawValue,
        now_ms: i64,
        cost_reading: Option<(&RawValue, &RawValue)>,
        fetched_at_ms: Option<i64>,
    ) -> AppendResult {
        if cost_state {
            let Some((session, weekly)) = cost_reading else {
                return AppendResult::skipped();
            };
            if !js_truthy(Some(session)) {
                return AppendResult::skipped();
            }
            let s = fields(session);
            let key = (
                get(&s, "pctUsed").map(clone_raw),
                get(&s, "resetsAt").map(clone_raw),
            );
            if self.claude_cost_last.as_ref().is_some_and(|last| {
                same_js_primitive(key.0.as_deref(), last.0.as_deref())
                    && same_js_primitive(key.1.as_deref(), last.1.as_deref())
            }) {
                return AppendResult::skipped();
            }
            let Some(fetched_at) = local_timestamp(fetched_at_ms.unwrap_or(now_ms)) else {
                return AppendResult::failure("invalid local time");
            };
            let mut windows = Vec::new();
            for (key, name, value) in [
                ("five_hour", "session", session),
                ("seven_day", "weekly", weekly),
            ] {
                if !js_truthy(Some(value)) {
                    windows.push(format!("{}:null", json_string(key)));
                    continue;
                }
                let fields = fields(value);
                let mut nested = Vec::new();
                field_or_omit(&mut nested, "utilization", get(&fields, "pctUsed"));
                field_or_omit(&mut nested, "resets_at", get(&fields, "resetsAt"));
                windows.push(format!("{}:{{{}}}", json_string(key), nested.join(",")));
                let _ = name;
            }
            let record = format!(
                "{{\"fetched_at\":{},\"source\":\"cost-state\",\"raw\":{{{}}}}}",
                json_string(&fetched_at),
                windows.join(",")
            );
            match self.append_claude_row(live_path, archive_dir, &record, now_ms) {
                result if result.appended => {
                    self.claude_cost_last = Some(key);
                    result
                }
                result => result,
            }
        } else {
            let Some(fetched_at) = local_timestamp(now_ms) else {
                return AppendResult::failure("invalid local time");
            };
            let record = format!(
                "{{\"fetched_at\":{},\"raw\":{}}}",
                json_string(&fetched_at),
                raw.get()
            );
            self.append_claude_row(live_path, archive_dir, &record, now_ms)
        }
    }

    fn append_claude_row(
        &mut self,
        live: &Path,
        archives: &Path,
        record: &str,
        now_ms: i64,
    ) -> AppendResult {
        self.rotate_claude(live, archives, now_ms);
        match append_line(live, record) {
            Ok(()) => AppendResult::success(),
            Err(e) => AppendResult::failure(e),
        }
    }

    fn rotate_claude(&mut self, live: &Path, archives: &Path, now_ms: i64) {
        self.rotate_claude_using(
            live,
            archives,
            now_ms,
            |source: &Path, target: &Path| fs::hard_link(source, target),
            |path: &Path| fs::remove_file(path),
        )
    }

    fn rotate_claude_using<L, U>(
        &mut self,
        live: &Path,
        archives: &Path,
        now_ms: i64,
        link: L,
        unlink: U,
    ) where
        L: Fn(&Path, &Path) -> std::io::Result<()>,
        U: Fn(&Path) -> std::io::Result<()>,
    {
        let Some(month) = local_month(now_ms) else {
            return;
        };
        if self.rotation_month.as_deref() == Some(&month) {
            return;
        }
        let head = match first_line(live) {
            Ok(v) => v,
            Err(_) => return,
        };
        if !head.is_empty() {
            let Ok(root) = serde_json::from_str::<Box<RawValue>>(&head) else {
                return;
            };
            let root = fields(&root);
            let Some(date) = get(&root, "fetched_at").and_then(parse_fetched_at) else {
                return;
            };
            let Some(source_month) = local_month(date) else {
                return;
            };
            if source_month < month {
                let target = archives.join(format!("usage-snapshots-{source_month}.jsonl"));
                match link(live, &target) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        match same_file(live, &target) {
                            Ok(true) => {}
                            Ok(false) => {
                                self.rotation_month = Some(month);
                                return;
                            }
                            Err(_) => return,
                        }
                    }
                    Err(_) => return,
                }
                if unlink(live).is_err() {
                    return;
                }
            }
        }
        self.rotation_month = Some(month);
    }

    pub fn read_claude_snapshot(
        &self,
        live: &Path,
        archive: Option<&Path>,
        max_age_ms: i64,
        now_ms: i64,
    ) -> Option<ClaudeSnapshot> {
        let path = match fs::metadata(live) {
            Ok(meta) if meta.len() > 0 => live,
            _ => archive?,
        };
        let row = last_line(path)?;
        let raw_row: Box<RawValue> = serde_json::from_str(&row).ok()?;
        let root = fields(&raw_row);
        let raw = get(&root, "raw")?;
        if !js_truthy(Some(raw))
            || get(&root, "source").is_some_and(|v| v.get() == "\"cost-state\"")
        {
            return None;
        }
        let at = parse_fetched_at(get(&root, "fetched_at")?)?;
        if now_ms.saturating_sub(at) > max_age_ms {
            return None;
        }
        Some(ClaudeSnapshot {
            raw: clone_raw(raw),
            fetched_at: format_snapshot_timestamp(at)?,
        })
    }

    pub fn read_codex_snapshot(
        &self,
        path: &Path,
        max_age_ms: i64,
        now_ms: i64,
    ) -> Option<CodexSnapshot> {
        let row = last_line(path)?;
        let raw: Box<RawValue> = serde_json::from_str(&row).ok()?;
        let root = fields(&raw);
        let at = parse_fetched_at(get(&root, "fetched_at")?)?;
        if now_ms.saturating_sub(at) > max_age_ms {
            return None;
        }
        let session = read_window(get(&root, "session"));
        let weekly = read_window(get(&root, "weekly"));
        if session.is_none() && weekly.is_none() {
            return None;
        }
        let plan = get(&root, "plan_type")
            .filter(|v| v.get() != "null")
            .or_else(|| get(&root, "plan").filter(|v| v.get() != "null"))
            .map(clone_raw);
        Some(CodexSnapshot {
            fetched_at: format_snapshot_timestamp(at)?,
            plan,
            session,
            weekly,
        })
    }

    pub fn read_cost_state(
        &self,
        directory: &Path,
        max_age_ms: i64,
        now_ms: i64,
    ) -> Option<CostStateLimits> {
        let entries = fs::read_dir(directory).ok()?;
        let mut candidates = Vec::new();
        for entry in entries.flatten() {
            if !entry.file_name().to_string_lossy().ends_with(".json") {
                continue;
            }
            let path = entry.path();
            let at = fs::metadata(&path)
                .and_then(|v| v.modified())
                .ok()
                .and_then(system_time_ms)
                .unwrap_or(0);
            if now_ms.saturating_sub(at) <= max_age_ms {
                candidates.push((path, at));
            }
        }
        candidates.sort_by(|a, b| b.1.cmp(&a.1));
        for (path, at) in candidates {
            let Ok(text) = fs::read_to_string(path) else {
                continue;
            };
            let Ok(raw) = serde_json::from_str::<Box<RawValue>>(&text) else {
                continue;
            };
            let root = fields(&raw);
            let limits = fields(get(&root, "rate_limits").unwrap_or_else(|| raw_null()));
            let session = read_cost_window(get(&limits, "five_hour"));
            let weekly = read_cost_window(get(&limits, "seven_day"));
            if session.is_none() && weekly.is_none() {
                continue;
            }
            let fetched_at = match format_snapshot_timestamp(at) {
                Some(v) => v,
                None => continue,
            };
            return Some(CostStateLimits {
                fetched_at,
                session,
                weekly,
            });
        }
        None
    }
}

fn read_window(raw: Option<&RawValue>) -> Option<SnapshotWindow> {
    let value = fields(raw?);
    let utilization = finite_number(get(&value, "utilization"))?;
    Some(SnapshotWindow {
        utilization,
        resets_at: get(&value, "resets_at")
            .filter(|v| v.get() != "null")
            .map(clone_raw),
        started: get(&value, "started")
            .filter(|v| v.get() == "false")
            .map(|_| false),
    })
}

fn read_cost_window(raw: Option<&RawValue>) -> Option<SnapshotWindow> {
    let value = fields(raw?);
    let utilization = finite_number(get(&value, "used_percentage"))?;
    let resets_at = finite_number(get(&value, "resets_at"))
        .and_then(|n| {
            let at =
                OffsetDateTime::from_unix_timestamp_nanos((n * 1_000_000_000.0) as i128).ok()?;
            format_snapshot_timestamp((at.unix_timestamp_nanos() / 1_000_000) as i64)
        })
        .and_then(|s| RawValue::from_string(json_string(&s)).ok());
    Some(SnapshotWindow {
        utilization,
        resets_at,
        started: None,
    })
}

fn clone_raw(raw: &RawValue) -> Box<RawValue> {
    RawValue::from_string(raw.get().to_owned()).expect("RawValue source is valid JSON")
}
fn raw_null() -> &'static RawValue {
    static NULL: std::sync::OnceLock<Box<RawValue>> = std::sync::OnceLock::new();
    NULL.get_or_init(|| RawValue::from_string("null".into()).unwrap())
        .as_ref()
}

fn append_line(path: &Path, record: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    writeln!(file, "{record}")
}

fn tail(path: &Path) -> Option<Vec<u8>> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let take = len.min(TAIL_BYTES as u64);
    file.seek(SeekFrom::Start(len - take)).ok()?;
    let mut data = vec![0; take as usize];
    file.read_exact(&mut data).ok()?;
    Some(data)
}

fn last_line(path: &Path) -> Option<String> {
    let data = tail(path)?;
    String::from_utf8_lossy(&data)
        .split('\n')
        .filter(|line| !line.is_empty())
        .last()
        .map(str::to_owned)
}

fn first_line(path: &Path) -> std::io::Result<String> {
    let mut file = match File::open(path) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e),
    };
    let mut data = vec![0; TAIL_BYTES];
    let len = file.read(&mut data)?;
    Ok(String::from_utf8_lossy(&data[..len])
        .split('\n')
        .next()
        .unwrap_or("")
        .to_owned())
}

fn system_time_ms(time: std::time::SystemTime) -> Option<i64> {
    i64::try_from(time.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis()).ok()
}

#[cfg(unix)]
fn local_parts(epoch: i64) -> Option<(i32, u8, u8, u8, u8, u8)> {
    let mut value = unsafe { std::mem::zeroed::<libc::tm>() };
    let time = epoch as libc::time_t;
    if unsafe { libc::localtime_r(&time, &mut value) }.is_null() {
        return None;
    }
    Some((
        value.tm_year + 1900,
        (value.tm_mon + 1) as u8,
        value.tm_mday as u8,
        value.tm_hour as u8,
        value.tm_min as u8,
        value.tm_sec as u8,
    ))
}

#[cfg(unix)]
fn local_to_epoch_ms(date: Date, time: Time) -> Option<i64> {
    local_to_epoch_civil(date.year(), date.month() as u8, date.day(), time)
}

#[cfg(unix)]
fn local_to_epoch_civil(year: i32, month: u8, day: u8, time: Time) -> Option<i64> {
    let mut value = unsafe { std::mem::zeroed::<libc::tm>() };
    value.tm_year = year.checked_sub(1900)?;
    value.tm_mon = i32::from(month) - 1;
    value.tm_mday = i32::from(day);
    value.tm_hour = time.hour() as i32;
    value.tm_min = time.minute() as i32;
    value.tm_sec = time.second() as i32;
    value.tm_isdst = -1;
    let seconds = unsafe { libc::mktime(&mut value) };
    (seconds != -1).then_some(seconds as i64 * 1000 + i64::from(time.millisecond()))
}

#[cfg(windows)]
fn local_to_epoch_civil(year: i32, month: u8, day: u8, time: Time) -> Option<i64> {
    if !(1601..=30_827).contains(&year) {
        return None;
    }
    local_to_epoch_system_time(year, month, day, time)
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> std::io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let a = fs::metadata(a)?;
    let b = fs::metadata(b)?;
    Ok(a.dev() == b.dev() && a.ino() == b.ino())
}

#[cfg(windows)]
#[derive(Clone, Copy)]
#[repr(C)]
struct WinSystemTime {
    year: u16,
    month: u16,
    weekday: u16,
    day: u16,
    hour: u16,
    minute: u16,
    second: u16,
    millis: u16,
}
#[cfg(windows)]
#[repr(C)]
struct FileTime {
    low: u32,
    high: u32,
}
#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn FileTimeToSystemTime(file: *const FileTime, system: *mut WinSystemTime) -> i32;
    fn SystemTimeToTzSpecificLocalTimeEx(
        zone: *const u8,
        utc: *const WinSystemTime,
        local: *mut WinSystemTime,
    ) -> i32;
}

#[cfg(windows)]
fn local_parts(epoch: i64) -> Option<(i32, u8, u8, u8, u8, u8)> {
    let ticks = (epoch as i128 + 11_644_473_600) * 10_000_000;
    if ticks < 0 || ticks > u64::MAX as i128 {
        return None;
    }
    let filetime = FileTime {
        low: ticks as u64 as u32,
        high: (ticks as u64 >> 32) as u32,
    };
    let mut utc = WinSystemTime {
        year: 0,
        month: 0,
        weekday: 0,
        day: 0,
        hour: 0,
        minute: 0,
        second: 0,
        millis: 0,
    };
    let mut local = utc;
    if unsafe { FileTimeToSystemTime(&filetime, &mut utc) } == 0
        || unsafe { SystemTimeToTzSpecificLocalTimeEx(std::ptr::null(), &utc, &mut local) } == 0
    {
        return None;
    }
    Some((
        local.year as i32,
        local.month as u8,
        local.day as u8,
        local.hour as u8,
        local.minute as u8,
        local.second as u8,
    ))
}

#[cfg(windows)]
fn local_to_epoch_ms(date: Date, time: Time) -> Option<i64> {
    local_to_epoch_civil(date.year(), date.month() as u8, date.day(), time)
}

#[cfg(windows)]
fn local_to_epoch_system_time(year: i32, month: u8, day: u8, time: Time) -> Option<i64> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn TzSpecificLocalTimeToSystemTimeEx(
            zone: *const u8,
            local: *const WinSystemTime,
            utc: *mut WinSystemTime,
        ) -> i32;
        fn SystemTimeToFileTime(system: *const WinSystemTime, file: *mut FileTime) -> i32;
    }
    let local = WinSystemTime {
        year: year as u16,
        month: month as u16,
        weekday: 0,
        day: day as u16,
        hour: time.hour() as u16,
        minute: time.minute() as u16,
        second: time.second() as u16,
        millis: time.millisecond(),
    };
    let mut utc = local;
    if unsafe { TzSpecificLocalTimeToSystemTimeEx(std::ptr::null(), &local, &mut utc) } == 0 {
        return None;
    }
    let mut file = FileTime { low: 0, high: 0 };
    if unsafe { SystemTimeToFileTime(&utc, &mut file) } == 0 {
        return None;
    }
    let ticks = ((file.high as u64) << 32 | file.low as u64) as i128;
    i64::try_from((ticks / 10_000 - 11_644_473_600_000) as i128).ok()
}

#[cfg(windows)]
fn same_file(a: &Path, b: &Path) -> std::io::Result<bool> {
    use std::os::windows::ffi::OsStrExt;
    #[repr(C)]
    struct FileIdInfo {
        volume: u64,
        id: [u8; 16],
    }
    type Handle = *mut std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            path: *const u16,
            access: u32,
            share: u32,
            security: *mut std::ffi::c_void,
            creation: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
        fn GetFileInformationByHandleEx(
            handle: Handle,
            class: i32,
            info: *mut FileIdInfo,
            size: u32,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    fn id(path: &Path) -> std::io::Result<FileIdInfo> {
        let mut name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let h = unsafe {
            CreateFileW(
                name.as_mut_ptr(),
                0x80,
                0x1 | 0x2 | 0x4,
                std::ptr::null_mut(),
                3,
                0x02000000,
                std::ptr::null_mut(),
            )
        };
        if h as isize == -1 {
            return Err(std::io::Error::last_os_error());
        }
        let mut info = FileIdInfo {
            volume: 0,
            id: [0; 16],
        };
        let ok = unsafe {
            GetFileInformationByHandleEx(h, 18, &mut info, std::mem::size_of::<FileIdInfo>() as u32)
        };
        unsafe {
            CloseHandle(h);
        }
        if ok == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(info)
        }
    }
    let a = id(a)?;
    let b = id(b)?;
    Ok(a.volume == b.volume && a.id == b.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            for retry in 0u32.. {
                let path = std::env::temp_dir().join(format!("usage-snapshot-{id}-{retry}"));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("create fixture directory: {error}"),
                }
            }
            unreachable!("fixture name retries are bounded by available path space")
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn raw(s: &str) -> Box<RawValue> {
        RawValue::from_string(s.to_owned()).unwrap()
    }

    #[test]
    fn provider_rows_keep_shapes_and_raw_surrogates() {
        let f = Fixture::new();
        let mut service = SnapshotService::default();
        let o = raw(
            r#"{"session":{"pctUsed":12,"resetsAt":"x"},"weekly":null,"plan":null,"models":[]}"#,
        );
        assert!(
            service
                .append_ollama(&f.path("ollama.jsonl"), &o, 1_798_000_000_000)
                .appended
        );
        let row = fs::read_to_string(f.path("ollama.jsonl")).unwrap();
        assert!(row.contains(r#""session":{"utilization":12,"resets_at":"x"}"#));
        assert!(row.contains(r#""weekly":null"#) && row.contains(r#""models":[]"#));
        let c = raw(r#"{"session":{"pctUsed":0,"started":false},"weekly":null,"plan_type":"max"}"#);
        assert!(
            service
                .append_codex(&f.path("codex.jsonl"), &c, 1_798_000_000_000)
                .appended
        );
        let row = fs::read_to_string(f.path("codex.jsonl")).unwrap();
        assert!(row.contains(r#""started":false"#) && !row.contains(r#""models""#));
        let claude = raw(r#"{"raw":{"x":"\ud800"}}"#);
        assert!(
            service
                .append_claude(
                    &f.path("claude.jsonl"),
                    &f.0,
                    false,
                    &claude,
                    1_798_000_000_000,
                    None,
                    None
                )
                .appended
        );
        assert!(
            fs::read_to_string(f.path("claude.jsonl"))
                .unwrap()
                .contains(r#"\ud800"#)
        );
    }

    #[test]
    fn dedupe_heartbeat_and_failed_append_retry_commit_only_on_success() {
        let f = Fixture::new();
        let mut service = SnapshotService::default();
        let value = raw(r#"{"session":{"pctUsed":4},"weekly":null}"#);
        assert!(
            service
                .append_ollama(&f.path("o.jsonl"), &value, 1_798_000_000_000)
                .appended
        );
        assert!(
            !service
                .append_ollama(&f.path("o.jsonl"), &value, 1_798_000_001_000)
                .appended
        );
        assert!(
            service
                .append_codex(&f.path("c.jsonl"), &value, 1_798_000_000_000)
                .appended
        );
        assert!(
            !service
                .append_codex(&f.path("c.jsonl"), &value, 1_798_000_001_000)
                .appended
        );
        assert!(
            service
                .append_codex(&f.path("c.jsonl"), &value, 1_798_000_301_000)
                .appended
        );
        let blocked = f.path("blocked");
        fs::write(&blocked, "file").unwrap();
        let child = blocked.join("x.jsonl");
        let mut retry = SnapshotService::default();
        assert!(
            retry
                .append_ollama(&child, &value, 1_798_000_000_000)
                .error
                .is_some()
        );
        assert!(
            retry
                .append_ollama(&child, &value, 1_798_000_001_000)
                .error
                .is_some()
        );
    }

    #[test]
    fn dedupe_matches_js_nullish_and_codex_started_projection() {
        let f = Fixture::new();
        let mut service = SnapshotService::default();
        let absent = raw(r#"{"session":{"pctUsed":4},"weekly":null}"#);
        let explicit_null = raw(r#"{"session":{"pctUsed":4,"resetsAt":null},"weekly":null}"#);
        assert!(
            service
                .append_ollama(&f.path("o.jsonl"), &absent, 1_798_000_000_000)
                .appended
        );
        assert!(
            !service
                .append_ollama(&f.path("o.jsonl"), &explicit_null, 1_798_000_001_000)
                .appended
        );
        let no_started = raw(r#"{"session":{"pctUsed":4,"started":true},"weekly":null}"#);
        let missing_started = raw(r#"{"session":{"pctUsed":4},"weekly":null}"#);
        let false_started = raw(r#"{"session":{"pctUsed":4,"started":false},"weekly":null}"#);
        let mut codex = SnapshotService::default();
        assert!(
            codex
                .append_codex(&f.path("c.jsonl"), &no_started, 1_798_000_000_000)
                .appended
        );
        assert!(
            !codex
                .append_codex(&f.path("c.jsonl"), &missing_started, 1_798_000_001_000)
                .appended
        );
        assert!(
            codex
                .append_codex(&f.path("c.jsonl"), &false_started, 1_798_000_002_000)
                .appended
        );
    }

    #[test]
    fn tail_reads_last_row_and_cost_state_skips_unusable_candidate() {
        let f = Fixture::new();
        let service = SnapshotService::default();
        let codex = f.path("codex.jsonl");
        fs::write(&codex, "{\"fetched_at\":\"bad\"}\n{\"fetched_at\":\"2026-10-22 12:00:00\",\"session\":{\"utilization\":3}}\n").unwrap();
        assert!(
            service
                .read_codex_snapshot(&codex, 1_000_000_000, 1_798_000_000_000)
                .is_none()
        );
        let now = 1_792_643_696_000;
        fs::write(&codex, "\n").unwrap();
        assert!(service.read_codex_snapshot(&codex, 120_000, now).is_none());
        fs::write(
            &codex,
            "{\"fetched_at\":\"2026-10-22 11:00:00\",\"session\":{\"utilization\":3}}\n",
        )
        .unwrap();
        assert!(service.read_codex_snapshot(&codex, 120_000, now).is_none());
        fs::write(
            &codex,
            "{\"fetched_at\":\"2026-10-22 12:35:00\",\"session\":{\"utilization\":3}}\n",
        )
        .unwrap();
        assert!(service.read_codex_snapshot(&codex, 120_000, now).is_some());
        let dir = f.path("cost-state");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("new.json"), r#"{"rate_limits":{}}"#).unwrap();
        fs::write(
            dir.join("old.json"),
            r#"{"rate_limits":{"five_hour":{"used_percentage":5,"resets_at":1798000000}}}"#,
        )
        .unwrap();
        let limits = service
            .read_cost_state(&dir, 1_000_000_000_000, 1_798_000_000_000)
            .unwrap();
        assert_eq!(limits.session.unwrap().utilization, 5.0);
    }

    #[test]
    fn cost_state_uses_newest_usable_fresh_candidate_and_accepts_future_mtime() {
        let f = Fixture::new();
        let dir = f.path("candidate-state");
        fs::create_dir_all(&dir).unwrap();
        let now = 1_792_643_696_000;
        let stale = dir.join("stale.json");
        let malformed = dir.join("malformed.json");
        let usable = dir.join("usable.json");
        let future = dir.join("future.json");
        fs::write(
            &stale,
            r#"{"rate_limits":{"five_hour":{"used_percentage":1}}}"#,
        )
        .unwrap();
        fs::write(&malformed, "{").unwrap();
        fs::write(
            &usable,
            r#"{"rate_limits":{"five_hour":{"used_percentage":5}}}"#,
        )
        .unwrap();
        fs::write(
            &future,
            r#"{"rate_limits":{"seven_day":{"used_percentage":9}}}"#,
        )
        .unwrap();
        let set_time = |path: &Path, millis: i64| {
            let file = OpenOptions::new().write(true).open(path).unwrap();
            file.set_modified(
                std::time::UNIX_EPOCH + std::time::Duration::from_millis(millis as u64),
            )
            .unwrap();
        };
        set_time(&stale, now - 200_000);
        set_time(&malformed, now - 1_000);
        set_time(&usable, now - 2_000);
        set_time(&future, now + 2_000);
        let service = SnapshotService::default();
        let selected = service.read_cost_state(&dir, 120_000, now).unwrap();
        assert_eq!(selected.weekly.unwrap().utilization, 9.0);
        assert!(selected.session.is_none());
        fs::remove_file(future).unwrap();
        let fallback = service.read_cost_state(&dir, 120_000, now).unwrap();
        assert_eq!(fallback.session.unwrap().utilization, 5.0);
    }

    #[test]
    fn snapshot_read_matrix_handles_missing_empty_partial_stale_and_future_rows() {
        let f = Fixture::new();
        let service = SnapshotService::default();
        let live = f.path("usage.jsonl");
        let now = 1_792_643_696_000;
        assert!(
            service
                .read_claude_snapshot(&live, None, 120_000, now)
                .is_none()
        );
        fs::write(&live, "\n\n").unwrap();
        assert!(
            service
                .read_claude_snapshot(&live, None, 120_000, now)
                .is_none()
        );
        fs::write(
            &live,
            "{\"fetched_at\":\"2026-10-22 11:00:00\",\"raw\":{}}\n{\"broken\":\n",
        )
        .unwrap();
        assert!(
            service
                .read_claude_snapshot(&live, None, 120_000, now)
                .is_none()
        );
        fs::write(
            &live,
            "{\"fetched_at\":\"2026-10-22 11:00:00\",\"raw\":{}}\n",
        )
        .unwrap();
        assert!(
            service
                .read_claude_snapshot(&live, None, 120_000, now)
                .is_none()
        );
        fs::write(
            &live,
            "{\"fetched_at\":\"2026-10-22 12:34:00\",\"raw\":{\"fresh\":true}}\n",
        )
        .unwrap();
        assert!(
            service
                .read_claude_snapshot(&live, None, 120_000, now)
                .is_some()
        );
        fs::write(
            &live,
            "{\"fetched_at\":\"2026-10-22 12:35:00\",\"raw\":{\"future\":true}}\n",
        )
        .unwrap();
        assert!(
            service
                .read_claude_snapshot(&live, None, 120_000, now)
                .is_some()
        );
    }

    #[test]
    fn claude_snapshot_uses_javascript_raw_truthiness_and_only_the_last_row() {
        let f = Fixture::new();
        let live = f.path("usage-snapshots.jsonl");
        for raw_value in ["null", "false", "0", "\"\"", "{}", "[]"] {
            fs::write(
                &live,
                format!("{{\"fetched_at\":\"2026-10-22 12:35:00\",\"raw\":{raw_value}}}\n"),
            )
            .unwrap();
            let result = SnapshotService::default().read_claude_snapshot(
                &live,
                None,
                120_000,
                1_792_643_700_000,
            );
            assert_eq!(
                result.is_some(),
                raw_value == "{}" || raw_value == "[]",
                "{raw_value}"
            );
        }
        fs::write(
            &live,
            "{\"fetched_at\":\"2026-10-22 12:35:00\",\"raw\":{}}\n{malformed\n",
        )
        .unwrap();
        assert!(
            SnapshotService::default()
                .read_claude_snapshot(&live, None, i64::MAX, 1_798_000_000_000)
                .is_none()
        );
    }

    #[test]
    fn timestamps_match_written_forms_and_iso_offsets() {
        assert_eq!(
            local_timestamp(1_792_643_696_000).as_deref(),
            Some("2026-10-22 12:34:56")
        );
        assert_eq!(
            local_timestamp(1_792_684_800_000).as_deref(),
            Some("2026-10-23 00:00:00")
        );
        assert_eq!(parse_date_ms("2026-10-22"), Some(1_792_627_200_000));
        assert_eq!(
            parse_date_ms("2026-10-22T12:34:56+08:00"),
            Some(1_792_643_696_000)
        );
        assert_eq!(
            parse_date_ms("2026-02-30T00:00:00Z"),
            Some(1_772_409_600_000)
        );
        assert_eq!(parse_date_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(
            parse_date_ms("2026-10-22T12:34:56.789Z"),
            Some(1_792_672_496_789)
        );
        assert_eq!(
            parse_date_ms("2026-10-22 12:34:56"),
            Some(
                local_to_epoch_ms(
                    parse_date("2026-10-22").unwrap(),
                    parse_clock("12:34:56").unwrap()
                )
                .unwrap()
            )
        );
    }

    #[test]
    fn fetched_at_uses_date_parse_coercion_and_selection_boundary() {
        let f = Fixture::new();
        let service = SnapshotService::default();
        let live = f.path("coerced-timestamps.jsonl");
        assert_eq!(parse_date_ms("2026-10"), Some(1_790_812_800_000));
        let accepted = [
            ("0", 946_656_000_000i64),
            ("1", 978_278_400_000),
            ("12", 1_007_136_000_000),
            ("49", 2_493_043_200_000),
            ("50", -631_179_000_000),
            ("99", 915_120_000_000),
            ("2026", 1_767_225_600_000),
            ("2027", 1_798_761_600_000),
            ("123456", 3_833_727_811_200_000),
            ("1.5", 978_624_000_000),
            ("-1", 978_278_400_000),
            ("-50", -631_179_000_000),
            ("[0]", 946_656_000_000),
            ("[1]", 978_278_400_000),
            ("[12]", 1_007_136_000_000),
            ("[2026]", 1_767_225_600_000),
            ("[[1]]", 978_278_400_000),
            ("[\"2026-10-22\"]", 1_792_627_200_000),
            ("[\"2026\",\"10\",\"22\"]", 1_792_598_400_000),
            ("\"2026-10-22\"", 1_792_627_200_000),
            ("\"2026-10-22 12:34:56\"", 1_792_643_696_000),
            ("\"2026-10-22T12:34:56+08:00\"", 1_792_643_696_000),
            ("\"2026-10-22T12:34:56.789Z\"", 1_792_672_496_789),
            ("\"2026-10-22T12:34:56.789+0800\"", 1_792_643_696_789),
            ("\"2026-10\"", 1_790_812_800_000),
            ("\"+010000-01-01\"", 253_402_300_800_000),
            ("\"+010000-01-01T00:00:00Z\"", 253_402_300_800_000),
            ("\"+010000-01-01T00:00:00\"", 253_402_272_000_000),
            ("\"-000001-01-01T00:00:00Z\"", -62_198_755_200_000),
            ("\"+275760-09-13T00:00:00Z\"", 8_640_000_000_000_000),
            ("\"1950-01-01T00:00:00\"", -631_180_800_000),
            ("\"1900-01-01T00:00:00\"", -2_209_017_600_000),
            ("\"2026-02-30T00:00:00Z\"", 1_772_409_600_000),
            ("\"2026/10/22\"", 1_792_598_400_000),
            ("\"10/22/2026\"", 1_792_598_400_000),
            ("\"Oct 22 2026\"", 1_792_598_400_000),
            ("\"Thu Oct 22 2026\"", 1_792_598_400_000),
            ("\"October 22, 2026 12:34:56 GMT\"", 1_792_672_496_000),
            ("\"2026 Oct 22\"", 1_792_598_400_000),
            ("\"Oct 22 2026 12:34:56 GMT\"", 1_792_672_496_000),
            ("\"22 Oct 2026 12:34:56 UTC\"", 1_792_672_496_000),
            ("\"10/22/26\"", 1_792_598_400_000),
            ("\"Oct 22 2026 (comment)\"", 1_792_598_400_000),
            ("\"Monday, October 22, 2026\"", 1_792_598_400_000),
            ("\"Oct 22, 2026 12:34:56 PM\"", 1_792_643_696_000),
            ("\"2026 Oct 22 12:34:56 GMT\"", 1_792_672_496_000),
            ("\"Thu, 22 Oct 2026 12:34:56 +0000\"", 1_792_672_496_000),
            ("\"Thu, 22 Oct 2026 12:34:56 PST\"", 1_792_701_296_000),
            ("\"22 2026 Oct\"", 1_792_598_400_000),
            ("\"Oct 22 2026 EST\"", 1_792_645_200_000),
            ("\"Oct 22 2026 PST 12:34:56\"", 1_792_701_296_000),
            ("\"Oct 22 2026 12:34:56 GMT (UTC)\"", 1_792_672_496_000),
        ];
        for (input, at) in accepted {
            fs::write(
                &live,
                format!("{{\"fetched_at\":{input},\"raw\":{{\"at\":true}}}}\n"),
            )
            .unwrap();
            assert!(
                service
                    .read_claude_snapshot(&live, None, 2_000, at + 1_000)
                    .is_some(),
                "Date.parse accepted timestamp input {input}"
            );
        }
        for input in [
            "13",
            "\"-000001-01-01T00:00:00\"",
            "\"2026-13-01T00:00:00Z\"",
            "\"-000000-01-01\"",
            "\"+275760-09-13T00:00:00.001Z\"",
            "null",
            "true",
            "false",
            "{}",
            "{\"toString\":1}",
            "[]",
            "[null]",
            "[true]",
            "[{}]",
        ] {
            fs::write(&live, format!("{{\"fetched_at\":{input},\"raw\":{{}}}}\n")).unwrap();
            assert!(
                service
                    .read_claude_snapshot(&live, None, i64::MAX, 1_000_000_000_000)
                    .is_none(),
                "invalid Date.parse timestamp input {input}"
            );
        }
        assert_eq!(parse_fetched_at(&raw("\"+275760-09-14T00:00:00Z\"")), None);
    }

    #[test]
    fn snapshot_fetched_at_always_has_iso_millisecond_precision() {
        assert_eq!(
            format_snapshot_timestamp(1_792_627_200_000).as_deref(),
            Some("2026-10-22T00:00:00.000Z")
        );
        assert_eq!(
            format_snapshot_timestamp(253_402_300_800_000).as_deref(),
            Some("+010000-01-01T00:00:00.000Z")
        );
    }

    #[test]
    fn rotation_uses_first_row_and_preserves_same_inode_retry() {
        let f = Fixture::new();
        let live = f.path("usage-snapshots.jsonl");
        fs::write(&live, "{\"fetched_at\":\"2026-09-30 12:00:00\",\"raw\":{}}\n{\"fetched_at\":\"2026-10-01 00:00:00\",\"raw\":{}}\n").unwrap();
        let mut service = SnapshotService::default();
        service.rotate_claude(&live, &f.0, 1_798_000_000_000);
        assert!(f.path("usage-snapshots-2026-09.jsonl").exists());
        assert!(!live.exists());
        let bad = f.path("bad.jsonl");
        fs::write(&bad, "partial\n").unwrap();
        let mut retry = SnapshotService::default();
        retry.rotate_claude(&bad, &f.0, 1_798_000_000_000);
        assert!(retry.rotation_month.is_none());
    }

    #[test]
    fn rotation_retries_unlink_after_link_and_skips_distinct_archive_collision() {
        let f = Fixture::new();
        let live = f.path("usage-snapshots.jsonl");
        let now = 1_798_000_000_000;
        fs::write(
            &live,
            "{\"fetched_at\":\"2026-09-30 12:00:00\",\"raw\":{}}\n",
        )
        .unwrap();
        let mut retry = SnapshotService::default();
        let first = std::cell::Cell::new(true);
        retry.rotate_claude_using(
            &live,
            &f.0,
            now,
            |source: &Path, target: &Path| fs::hard_link(source, target),
            |path: &Path| {
                if first.replace(false) {
                    return Err(std::io::Error::other("fixture unlink failure"));
                }
                fs::remove_file(path)
            },
        );
        assert!(live.exists());
        assert!(f.path("usage-snapshots-2026-09.jsonl").exists());
        assert!(retry.rotation_month.is_none());
        retry.rotate_claude(&live, &f.0, now);
        assert!(!live.exists());
        assert!(retry.rotation_month.is_some());

        let collision_live = f.path("collision-live.jsonl");
        let collision = f.path("usage-snapshots-2026-09.jsonl");
        fs::write(
            &collision_live,
            "{\"fetched_at\":\"2026-09-30 12:00:00\",\"raw\":{}}\n",
        )
        .unwrap();
        fs::write(&collision, "distinct archive\n").unwrap();
        let mut collision_service = SnapshotService::default();
        collision_service.rotate_claude(&collision_live, &f.0, now);
        assert!(collision_live.exists());
        assert_eq!(
            fs::read_to_string(&collision).unwrap(),
            "distinct archive\n"
        );
        assert!(collision_service.rotation_month.is_some());
    }
}
