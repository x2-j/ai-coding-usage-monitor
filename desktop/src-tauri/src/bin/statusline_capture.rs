use chrono::Utc;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::PathBuf;

fn main() {
    let data_dir = data_dir_from_args().unwrap_or_else(default_data_dir);
    if let Err(err) = fs::create_dir_all(&data_dir) {
        println!("Claude usage: statusline capture error");
        eprintln!("statusline_capture: could not create data directory: {err}");
        return;
    }

    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        write_error(&data_dir, "stdin read failed");
        println!("Claude usage: statusline capture error");
        return;
    }

    match serde_json::from_str::<Value>(input.trim()).or_else(|_| Ok::<Value, serde_json::Error>(json!({}))) {
        Ok(raw) => {
            let sanitized = sanitize_statusline(&raw);
            let path = data_dir.join("statusline_latest.json");
            if fs::write(&path, serde_json::to_string_pretty(&sanitized).unwrap()).is_err() {
                write_error(&data_dir, "latest write failed");
                println!("Claude usage: statusline capture error");
                return;
            }
            let (session, weekly) = extract_percentages(&sanitized);
            println!("Claude usage: 5h {:.0}% | 7d {:.0}%", session.unwrap_or(0.0), weekly.unwrap_or(0.0));
        }
        Err(_) => {
            write_error(&data_dir, "json parse failed");
            println!("Claude usage: statusline capture error");
        }
    }
}

fn data_dir_from_args() -> Option<PathBuf> {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--data-dir" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

fn default_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("SimpleAIUsageMonitor")
}

fn sanitize_statusline(raw: &Value) -> Value {
    let rate_limits = raw.get("rate_limits").or_else(|| raw.get("rate_limit")).cloned().unwrap_or_else(|| json!({}));
    let usage = find_usage_dict(raw).cloned().unwrap_or_else(|| json!({}));
    json!({
        "captured_at": Utc::now().to_rfc3339(),
        "provider": find_first_string(raw, &["provider", "provider_name", "providerName"]),
        "model": find_first_string(raw, &["model", "model_name", "modelName"]),
        "timestamp": find_first_value(raw, &["timestamp", "created_at", "createdAt", "time"]).cloned(),
        "rate_limits": rate_limits,
        "usage": {
            "input_tokens": usage.get("input_tokens").cloned().unwrap_or(json!(0)),
            "output_tokens": usage.get("output_tokens").cloned().unwrap_or(json!(0)),
            "cache_creation_input_tokens": usage.get("cache_creation_input_tokens").cloned().unwrap_or(json!(0)),
            "cache_read_input_tokens": usage.get("cache_read_input_tokens").cloned().unwrap_or(json!(0))
        }
    })
}

fn extract_percentages(value: &Value) -> (Option<f64>, Option<f64>) {
    let rate_limits = value.get("rate_limits").unwrap_or(&Value::Null);
    let five = rate_limits.get("five_hour").or_else(|| rate_limits.get("session")).unwrap_or(&Value::Null);
    let seven = rate_limits.get("seven_day").or_else(|| rate_limits.get("weekly")).unwrap_or(&Value::Null);
    (
        pct(five.get("used_percentage").or_else(|| five.get("utilization"))),
        pct(seven.get("used_percentage").or_else(|| seven.get("utilization"))),
    )
}

fn pct(value: Option<&Value>) -> Option<f64> {
    let n = value.and_then(Value::as_f64)?;
    if (0.0..=1.0).contains(&n) { Some(n * 100.0) } else { Some(n) }
}

fn find_usage_dict(value: &Value) -> Option<&Value> {
    if let Value::Object(map) = value {
        for key in ["usage", "current_usage"] {
            if map.get(key).is_some_and(Value::is_object) {
                return map.get(key);
            }
        }
        for child in map.values() {
            if let Some(found) = find_usage_dict(child) {
                return Some(found);
            }
        }
    } else if let Value::Array(items) = value {
        for child in items {
            if let Some(found) = find_usage_dict(child) {
                return Some(found);
            }
        }
    }
    None
}

fn find_first_value<'a>(value: &'a Value, names: &[&str]) -> Option<&'a Value> {
    if let Value::Object(map) = value {
        for name in names {
            if let Some(found) = map.get(*name) {
                return Some(found);
            }
        }
        for child in map.values() {
            if let Some(found) = find_first_value(child, names) {
                return Some(found);
            }
        }
    } else if let Value::Array(items) = value {
        for child in items {
            if let Some(found) = find_first_value(child, names) {
                return Some(found);
            }
        }
    }
    None
}

fn find_first_string(value: &Value, names: &[&str]) -> Option<String> {
    find_first_value(value, names).and_then(|v| v.as_str().map(ToString::to_string))
}

fn write_error(data_dir: &PathBuf, message: &str) {
    let _ = fs::write(data_dir.join("statusline_error.log"), message);
}
