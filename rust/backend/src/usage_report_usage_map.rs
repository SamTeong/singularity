//! Pure mapping from a parsed usage API value to the report snapshot shape.
//!
//! Mirrors `_map_usage` in the bundled harness usage-report script
//! (`stats.mjs:1744-1767`). The caller owns credentials, the request,
//! `fetched_at`, and persistence; this only reshapes an already-parsed JSON
//! value.

use serde::Serialize;
use serde_json::Value;

/// One utilization window: `five_hour`, `seven_day`, or a per-model weekly.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageWindow {
    pub utilization: Value,
    pub resets_at: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsagePerModel {
    pub sonnet: Option<UsageWindow>,
    pub opus: Option<UsageWindow>,
    pub design: Option<UsageWindow>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageExtra {
    pub is_enabled: Value,
    pub monthly_limit: Value,
    pub used_credits: Value,
    pub utilization: Value,
}

/// Snapshot payload the record spreads ahead of `fetched_at` and `raw`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageMap {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
    pub per_model: UsagePerModel,
    pub extra_usage: Option<UsageExtra>,
}

// `_map_usage`'s `o && typeof o === "object"`: arrays count as objects, every
// other nullable JSON kind is null.
fn as_object(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| matches!(value, Value::Object(_) | Value::Array(_)))
}

// `o.utilization ?? null`: a missing key and an explicit null both yield null.
fn field_or_null(object: &Value, key: &str) -> Value {
    object.get(key).cloned().unwrap_or(Value::Null)
}

fn pick(value: Option<&Value>) -> Option<UsageWindow> {
    let object = as_object(value)?;
    Some(UsageWindow {
        utilization: field_or_null(object, "utilization"),
        resets_at: field_or_null(object, "resets_at"),
    })
}

fn pick_extra(value: Option<&Value>) -> Option<UsageExtra> {
    let object = as_object(value)?;
    Some(UsageExtra {
        is_enabled: field_or_null(object, "is_enabled"),
        monthly_limit: field_or_null(object, "monthly_limit"),
        used_credits: field_or_null(object, "used_credits"),
        utilization: field_or_null(object, "utilization"),
    })
}

pub fn map_usage(raw: &Value) -> UsageMap {
    UsageMap {
        five_hour: pick(raw.get("five_hour")),
        seven_day: pick(raw.get("seven_day")),
        per_model: UsagePerModel {
            sonnet: pick(raw.get("seven_day_sonnet")),
            opus: pick(raw.get("seven_day_opus")),
            // The API key is `seven_day_omelette`; claumon reports it as "design".
            design: pick(raw.get("seven_day_omelette")),
        },
        extra_usage: pick_extra(raw.get("extra_usage")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn serialized(raw: Value) -> Value {
        serde_json::to_value(map_usage(&raw)).unwrap()
    }

    #[test]
    fn maps_every_window_per_model_and_extra_usage() {
        let raw = json!({
            "five_hour": {"utilization": 12.5, "resets_at": "2026-10-27T10:00:00Z"},
            "seven_day": {"utilization": 40, "resets_at": "2026-11-01T00:00:00Z"},
            "seven_day_sonnet": {"utilization": 7.25, "resets_at": null},
            "seven_day_opus": {"utilization": 0, "resets_at": "2026-11-02T00:00:00Z"},
            "seven_day_omelette": {"utilization": 99, "resets_at": "2026-11-03T00:00:00Z"},
            "extra_usage": {
                "is_enabled": true,
                "monthly_limit": 2000,
                "used_credits": 120.5,
                "utilization": 6.025,
            },
        });
        assert_eq!(
            serialized(raw),
            json!({
                "five_hour": {"utilization": 12.5, "resets_at": "2026-10-27T10:00:00Z"},
                "seven_day": {"utilization": 40, "resets_at": "2026-11-01T00:00:00Z"},
                "per_model": {
                    "sonnet": {"utilization": 7.25, "resets_at": null},
                    "opus": {"utilization": 0, "resets_at": "2026-11-02T00:00:00Z"},
                    "design": {"utilization": 99, "resets_at": "2026-11-03T00:00:00Z"},
                },
                "extra_usage": {
                    "is_enabled": true,
                    "monthly_limit": 2000,
                    "used_credits": 120.5,
                    "utilization": 6.025,
                },
            })
        );
    }

    #[test]
    fn absent_and_non_object_sections_stay_null() {
        for raw in [
            json!(null),
            json!(42),
            json!("text"),
            json!(true),
            json!({}),
        ] {
            assert_eq!(
                serialized(raw.clone()),
                json!({
                    "five_hour": null,
                    "seven_day": null,
                    "per_model": {"sonnet": null, "opus": null, "design": null},
                    "extra_usage": null,
                }),
                "raw {raw}"
            );
        }
        assert_eq!(
            serialized(json!({
                "five_hour": "50%",
                "seven_day": false,
                "seven_day_sonnet": 3,
                "seven_day_opus": null,
                "extra_usage": "on",
            })),
            json!({
                "five_hour": null,
                "seven_day": null,
                "per_model": {"sonnet": null, "opus": null, "design": null},
                "extra_usage": null,
            })
        );
    }

    #[test]
    fn arrays_count_as_objects_but_yield_null_fields() {
        // JS `typeof [] === "object"`, so `pick` returns an all-null window.
        assert_eq!(
            serialized(json!({
                "five_hour": [1, 2],
                "extra_usage": [],
            })),
            json!({
                "five_hour": {"utilization": null, "resets_at": null},
                "seven_day": null,
                "per_model": {"sonnet": null, "opus": null, "design": null},
                "extra_usage": {
                    "is_enabled": null,
                    "monthly_limit": null,
                    "used_credits": null,
                    "utilization": null,
                },
            })
        );
    }

    #[test]
    fn partial_objects_keep_present_values_verbatim() {
        // `?? null` replaces only null/undefined; strings, objects and arrays pass through.
        assert_eq!(
            serialized(json!({
                "seven_day": {"utilization": "42", "extra": {"kept": true}},
                "extra_usage": {"used_credits": [1, 2], "is_enabled": null},
            })),
            json!({
                "five_hour": null,
                "seven_day": {"utilization": "42", "resets_at": null},
                "per_model": {"sonnet": null, "opus": null, "design": null},
                "extra_usage": {
                    "is_enabled": null,
                    "monthly_limit": null,
                    "used_credits": [1, 2],
                    "utilization": null,
                },
            })
        );
    }

    #[test]
    fn raw_object_with_unknown_keys_maps_nothing_extra() {
        let map = map_usage(&json!({
            "unknown": {"utilization": 1},
            "seven_day_haiku": {"utilization": 2, "resets_at": "x"},
        }));
        assert_eq!(
            map,
            UsageMap {
                five_hour: None,
                seven_day: None,
                per_model: UsagePerModel {
                    sonnet: None,
                    opus: None,
                    design: None,
                },
                extra_usage: None,
            }
        );
    }
}
