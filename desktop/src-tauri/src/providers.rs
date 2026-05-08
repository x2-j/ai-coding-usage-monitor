use crate::models::{empty_totals_map, AppSettings, ProviderAvailability, UsageSnapshot, UsageTotals};
use crate::sanitized_log::log;
use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Utc};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use walkdir::WalkDir;

const CLAUDE_ID: &str = "claude_code";
const CODEX_ID: &str = "openai_codex_cli";
const CODEX_SESSION_FALLBACK_BUDGET_TOKENS: i64 = 350_000_000;
const CODEX_WEEKLY_FALLBACK_BUDGET_TOKENS: i64 = 3_500_000_000;

pub struct ProviderResult {
    pub snapshot: UsageSnapshot,
    pub totals: BTreeMap<String, UsageTotals>,
}

pub fn provider_availability(settings: &AppSettings, data_dir: &Path) -> Vec<ProviderAvailability> {
    vec![
        claude_availability(settings, data_dir),
        codex_availability(settings),
    ]
}

pub fn collect_provider(provider_id: &str, settings: &AppSettings, data_dir: &Path) -> Option<ProviderResult> {
    match provider_id {
        CODEX_ID => Some(collect_codex(settings)),
        CLAUDE_ID => Some(collect_claude(settings, data_dir)),
        _ => None,
    }
}

fn claude_availability(settings: &AppSettings, data_dir: &Path) -> ProviderAvailability {
    let latest = data_dir.join("statusline_latest.json");
    if latest.exists() {
        return ProviderAvailability {
            provider_id: CLAUDE_ID.to_string(),
            provider_name: "Anthropic".to_string(),
            display_label: "Claude Code".to_string(),
            available: true,
            source: "Claude Code statusline".to_string(),
            message: Some("Statusline capture file is available.".to_string()),
            has_data: true,
            tracking_enabled: true,
        };
    }
    let has_logs = has_jsonl_files(Path::new(&settings.claude_log_dir));
    ProviderAvailability {
        provider_id: CLAUDE_ID.to_string(),
        provider_name: "Anthropic".to_string(),
        display_label: "Claude Code".to_string(),
        available: has_logs,
        source: if has_logs { "Claude Code local logs" } else { "Claude Code" }.to_string(),
        message: Some(if has_logs {
            "Local Claude Code logs are available for estimates.".to_string()
        } else {
            "No Claude Code usage data found.".to_string()
        }),
        has_data: has_logs,
        tracking_enabled: true,
    }
}

fn codex_availability(settings: &AppSettings) -> ProviderAvailability {
    let cmd = find_codex_command();
    if cmd.is_none() {
        return ProviderAvailability {
            provider_id: CODEX_ID.to_string(),
            provider_name: "OpenAI".to_string(),
            display_label: "OpenAI Codex CLI".to_string(),
            available: false,
            source: "Codex CLI".to_string(),
            message: Some("Codex CLI is not on PATH.".to_string()),
            has_data: false,
            tracking_enabled: settings.codex_tracking_enabled,
        };
    }
    let has_records = settings.codex_tracking_enabled && has_jsonl_files(&Path::new(&settings.codex_home).join("sessions"));
    ProviderAvailability {
        provider_id: CODEX_ID.to_string(),
        provider_name: "OpenAI".to_string(),
        display_label: "OpenAI Codex CLI".to_string(),
        available: true,
        source: "Codex CLI local sessions".to_string(),
        message: Some(if settings.codex_tracking_enabled {
            if has_records { "Local token usage records found.".to_string() } else { "Tracking enabled, but no local token usage records found yet.".to_string() }
        } else {
            "Codex CLI detected, but local tracking is disabled.".to_string()
        }),
        has_data: has_records,
        tracking_enabled: settings.codex_tracking_enabled,
    }
}

fn has_jsonl_files(root: &Path) -> bool {
    if !root.exists() {
        return false;
    }
    WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .any(|entry| entry.path().extension().is_some_and(|ext| ext == "jsonl"))
}

pub fn collect_claude(settings: &AppSettings, data_dir: &Path) -> ProviderResult {
    let totals = scan_claude_logs(settings);
    let statusline = data_dir.join("statusline_latest.json");
    let mut snapshot = if statusline.exists() {
        fs::read_to_string(&statusline)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|value| snapshot_from_statusline(&value))
            .unwrap_or_else(|| UsageSnapshot::error(CLAUDE_ID, "Anthropic", "Could not parse statusline data.".to_string()))
    } else {
        UsageSnapshot::error(CLAUDE_ID, "Anthropic", "No Claude Code statusline data yet; using local estimates.".to_string())
    };
    apply_token_totals(&mut snapshot, &totals, settings, true);
    ProviderResult { snapshot, totals }
}

pub fn collect_codex(settings: &AppSettings) -> ProviderResult {
    let (latest, totals) = scan_codex_logs(settings);
    let mut snapshot = latest.unwrap_or_else(|| UsageSnapshot::error(CODEX_ID, "OpenAI", "No Codex token usage records found.".to_string()));
    apply_token_totals(&mut snapshot, &totals, settings, true);
    apply_codex_fallback_budgets(&mut snapshot, &totals, settings);
    ProviderResult { snapshot, totals }
}

fn apply_token_totals(
    snapshot: &mut UsageSnapshot,
    totals: &BTreeMap<String, UsageTotals>,
    settings: &AppSettings,
    estimate_percentages: bool,
) {
    let session = totals.get("session").cloned().unwrap_or_else(UsageTotals::empty);
    let week = totals.get("week").cloned().unwrap_or_else(UsageTotals::empty);
    let session_tokens = if settings.include_cache_tokens { session.total_tokens } else { session.visible_tokens };
    let weekly_tokens = if settings.include_cache_tokens { week.total_tokens } else { week.visible_tokens };
    let mut estimated_any = false;
    if estimate_percentages && snapshot.session_usage_percent.is_none() {
        snapshot.session_usage_percent = percentage(session_tokens, settings.session_budget_tokens);
        snapshot.is_estimate = true;
        estimated_any = snapshot.session_usage_percent.is_some();
    }
    if estimate_percentages && snapshot.weekly_usage_percent.is_none() {
        snapshot.weekly_usage_percent = percentage(weekly_tokens, settings.weekly_budget_tokens);
        snapshot.is_estimate = true;
        estimated_any = estimated_any || snapshot.weekly_usage_percent.is_some();
    }
    if estimated_any {
        snapshot.raw_limit_name = Some("Local fallback estimate from token totals and configured budgets".to_string());
    }
    snapshot.input_tokens = session.input_tokens;
    snapshot.output_tokens = session.output_tokens;
    snapshot.cache_read_tokens = session.cache_read_tokens;
    snapshot.cache_write_tokens = session.cache_write_tokens;
    snapshot.total_tokens = if settings.include_cache_tokens { session.total_tokens } else { session.visible_tokens };
    if snapshot.error_state.is_some() && snapshot.total_tokens > 0 && estimated_any {
        snapshot.error_state = None;
        snapshot.source = "local token budget estimate".to_string();
    }
}

fn percentage(tokens: i64, budget: i64) -> Option<f64> {
    if budget <= 0 {
        None
    } else {
        Some(((tokens as f64 / budget as f64) * 100.0).clamp(0.0, 100.0))
    }
}

fn apply_codex_fallback_budgets(
    snapshot: &mut UsageSnapshot,
    totals: &BTreeMap<String, UsageTotals>,
    settings: &AppSettings,
) {
    if !snapshot.is_estimate {
        return;
    }
    let session = totals.get("session").cloned().unwrap_or_else(UsageTotals::empty);
    let week = totals.get("week").cloned().unwrap_or_else(UsageTotals::empty);
    let session_tokens = if settings.include_cache_tokens { session.total_tokens } else { session.visible_tokens };
    let weekly_tokens = if settings.include_cache_tokens { week.total_tokens } else { week.visible_tokens };
    let session_budget = settings.session_budget_tokens.max(CODEX_SESSION_FALLBACK_BUDGET_TOKENS);
    let weekly_budget = settings.weekly_budget_tokens.max(CODEX_WEEKLY_FALLBACK_BUDGET_TOKENS);
    snapshot.session_usage_percent = percentage(session_tokens, session_budget);
    snapshot.weekly_usage_percent = percentage(weekly_tokens, weekly_budget);
    snapshot.raw_limit_name = Some(
        "OpenAI local fallback estimate from token counters and Codex-sized configured budgets".to_string(),
    );
}

fn snapshot_from_statusline(value: &Value) -> UsageSnapshot {
    let data = value.get("raw").unwrap_or(value);
    let rate_limits = data.get("rate_limits").or_else(|| data.get("rate_limit")).unwrap_or(&Value::Null);
    let five = rate_limits.get("five_hour").or_else(|| rate_limits.get("session")).unwrap_or(&Value::Null);
    let seven = rate_limits.get("seven_day").or_else(|| rate_limits.get("weekly")).unwrap_or(&Value::Null);
    let usage = find_usage_dict(data).unwrap_or(&Value::Null);
    let input = number(usage.get("input_tokens"));
    let output = number(usage.get("output_tokens"));
    let cache_write = number(usage.get("cache_creation_input_tokens"));
    let cache_read = number(usage.get("cache_read_input_tokens"));
    UsageSnapshot {
        provider_id: CLAUDE_ID.to_string(),
        provider_name: find_first_string(data, &["provider", "provider_name", "providerName"]).unwrap_or_else(|| "Anthropic".to_string()),
        source: "Claude Code statusline".to_string(),
        timestamp_utc: parse_time(find_first_value(data, &["timestamp", "created_at", "createdAt", "time"])).unwrap_or_else(|| Utc::now().to_rfc3339()),
        model_name: find_first_string(data, &["model", "model_name", "modelName"]),
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        total_tokens: input + output + cache_read + cache_write,
        session_usage_percent: normalize_pct(five.get("used_percentage").or_else(|| five.get("utilization"))),
        weekly_usage_percent: normalize_pct(seven.get("used_percentage").or_else(|| seven.get("utilization"))),
        session_reset_at: parse_time(five.get("resets_at").or_else(|| five.get("reset_at"))),
        weekly_reset_at: parse_time(seven.get("resets_at").or_else(|| seven.get("reset_at"))),
        raw_limit_name: None,
        is_estimate: false,
        error_state: None,
    }
}

fn scan_claude_logs(settings: &AppSettings) -> BTreeMap<String, UsageTotals> {
    scan_jsonl_usage(Path::new(&settings.claude_log_dir), settings, "Anthropic", CLAUDE_ID, usage_record_from_claude_json)
}

fn scan_codex_logs(settings: &AppSettings) -> (Option<UsageSnapshot>, BTreeMap<String, UsageTotals>) {
    let records = collect_jsonl_records(&Path::new(&settings.codex_home).join("sessions"), "OpenAI", CODEX_ID, usage_record_from_codex_json);
    let latest = records.values().max_by_key(|rec| rec.timestamp_utc.clone()).cloned();
    (bucket_records(records.into_values(), settings), latest).swap()
}

trait SwapTuple {
    fn swap(self) -> (Option<UsageSnapshot>, BTreeMap<String, UsageTotals>);
}

impl SwapTuple for (BTreeMap<String, UsageTotals>, Option<UsageSnapshot>) {
    fn swap(self) -> (Option<UsageSnapshot>, BTreeMap<String, UsageTotals>) {
        (self.1, self.0)
    }
}

fn scan_jsonl_usage(
    root: &Path,
    settings: &AppSettings,
    provider_name: &str,
    provider_id: &str,
    parser: fn(&Value, &str, &str, i64) -> Option<UsageSnapshot>,
) -> BTreeMap<String, UsageTotals> {
    let records = collect_jsonl_records(root, provider_name, provider_id, parser);
    bucket_records(records.into_values(), settings)
}

fn collect_jsonl_records(
    root: &Path,
    provider_name: &str,
    provider_id: &str,
    parser: fn(&Value, &str, &str, i64) -> Option<UsageSnapshot>,
) -> HashMap<String, UsageSnapshot> {
    let mut records = HashMap::new();
    if !root.exists() {
        return records;
    }
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_file() || !path.extension().is_some_and(|ext| ext == "jsonl") {
            continue;
        }
        let fallback = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or_else(|| Utc::now().timestamp());
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) => {
                log(&format!("usage scan skipped {}: {e}", safe_file_name(path)));
                continue;
            }
        };
        for (idx, line) in text.lines().enumerate() {
            let value = match serde_json::from_str::<Value>(line) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let Some(record) = parser(&value, provider_name, provider_id, fallback) else {
                continue;
            };
            let key = find_first_string(&value, &["requestId", "request_id", "response_id", "message_id", "uuid", "id"])
                .unwrap_or_else(|| format!("{}:{idx}", path_hash(path)));
            let replace = records.get(&key).map(|old: &UsageSnapshot| record.total_tokens >= old.total_tokens).unwrap_or(true);
            if replace {
                records.insert(key, record);
            }
        }
    }
    records
}

fn usage_record_from_claude_json(value: &Value, provider_name: &str, provider_id: &str, fallback: i64) -> Option<UsageSnapshot> {
    let usage = find_usage_dict(value)?;
    let input = number(usage.get("input_tokens"));
    let output = number(usage.get("output_tokens"));
    let cache_write = number(usage.get("cache_creation_input_tokens"));
    let cache_read = number(usage.get("cache_read_input_tokens"));
    if input <= 0 && output <= 0 && cache_write <= 0 && cache_read <= 0 {
        return None;
    }
    Some(UsageSnapshot {
        provider_id: provider_id.to_string(),
        provider_name: provider_name.to_string(),
        source: "Claude Code local logs".to_string(),
        timestamp_utc: parse_time(find_first_value(value, &["timestamp", "created_at", "createdAt", "time"])).unwrap_or_else(|| timestamp_from_epoch(fallback)),
        model_name: find_first_string(value, &["model", "model_name", "modelName"]),
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        total_tokens: input + output + cache_read + cache_write,
        session_usage_percent: None,
        weekly_usage_percent: None,
        session_reset_at: None,
        weekly_reset_at: None,
        raw_limit_name: None,
        is_estimate: true,
        error_state: None,
    })
}

fn usage_record_from_codex_json(value: &Value, provider_name: &str, provider_id: &str, fallback: i64) -> Option<UsageSnapshot> {
    let usage = iter_usage_dicts(value).into_iter().next()?;
    let input_details = usage.get("input_tokens_details").unwrap_or(&Value::Null);
    let input = number(usage.get("input_tokens").or_else(|| usage.get("prompt_tokens")));
    let output = number(usage.get("output_tokens").or_else(|| usage.get("completion_tokens")));
    let cache_read = number(input_details.get("cached_tokens").or_else(|| usage.get("cached_input_tokens")).or_else(|| usage.get("cached_tokens")).or_else(|| usage.get("cache_read_tokens")));
    if input <= 0 && output <= 0 && cache_read <= 0 {
        return None;
    }
    Some(UsageSnapshot {
        provider_id: provider_id.to_string(),
        provider_name: provider_name.to_string(),
        source: "Codex CLI local token counters (no exact limit data)".to_string(),
        timestamp_utc: parse_time(find_first_value(value, &["timestamp", "created_at", "createdAt", "time", "ts"])).unwrap_or_else(|| timestamp_from_epoch(fallback)),
        model_name: find_first_string(value, &["model", "model_name", "modelName"]),
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: 0,
        total_tokens: input + output + cache_read,
        session_usage_percent: None,
        weekly_usage_percent: None,
        session_reset_at: None,
        weekly_reset_at: None,
        raw_limit_name: None,
        is_estimate: true,
        error_state: None,
    })
}

fn bucket_records(records: impl Iterator<Item = UsageSnapshot>, settings: &AppSettings) -> BTreeMap<String, UsageTotals> {
    let now = Local::now();
    let session_start = now - Duration::minutes((settings.session_hours * 60.0) as i64);
    let today_start = now.date_naive().and_hms_opt(0, 0, 0).and_then(|n| Local.from_local_datetime(&n).single()).unwrap_or(now);
    let week_start_date = now.date_naive() - Duration::days(now.weekday().num_days_from_monday() as i64);
    let week_start = week_start_date.and_hms_opt(0, 0, 0).and_then(|n| Local.from_local_datetime(&n).single()).unwrap_or(now);
    let mut totals = empty_totals_map();
    for record in records {
        let ts = DateTime::parse_from_rfc3339(&record.timestamp_utc).ok().map(|dt| dt.with_timezone(&Local)).unwrap_or(now);
        for key in ["all"] {
            totals.get_mut(key).unwrap().add_record(&record);
        }
        if ts >= session_start {
            totals.get_mut("session").unwrap().add_record(&record);
        }
        if ts >= today_start {
            totals.get_mut("today").unwrap().add_record(&record);
        }
        if ts >= week_start {
            totals.get_mut("week").unwrap().add_record(&record);
        }
    }
    totals
}

fn find_codex_command() -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).find_map(|dir| {
            ["codex.cmd", "codex.exe", "codex"]
                .into_iter()
                .map(|name| dir.join(name))
                .find(|path| path.exists())
        })
    })
}

fn find_usage_dict(value: &Value) -> Option<&Value> {
    if let Value::Object(map) = value {
        if map.get("usage").is_some_and(Value::is_object) {
            return map.get("usage");
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

fn iter_usage_dicts(value: &Value) -> Vec<&Value> {
    let mut out = Vec::new();
    if let Value::Object(map) = value {
        for key in ["last_token_usage", "usage", "token_usage", "total_token_usage"] {
            if map.get(key).is_some_and(Value::is_object) {
                out.push(map.get(key).unwrap());
            }
        }
        for child in map.values() {
            out.extend(iter_usage_dicts(child));
        }
    } else if let Value::Array(items) = value {
        for child in items {
            out.extend(iter_usage_dicts(child));
        }
    }
    out
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
    find_first_value(value, names).and_then(|v| v.as_str().map(ToString::to_string).or_else(|| v.as_i64().map(|n| n.to_string())))
}

fn number(value: Option<&Value>) -> i64 {
    value.and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|n| n as i64))).unwrap_or(0)
}

fn normalize_pct(value: Option<&Value>) -> Option<f64> {
    let pct = value.and_then(Value::as_f64)?;
    if (0.0..=1.0).contains(&pct) {
        Some(pct * 100.0)
    } else {
        Some(pct)
    }
}

fn parse_time(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if text.chars().all(|c| c.is_ascii_digit()) => {
            text.parse::<i64>().ok().map(timestamp_from_epoch)
        }
        Value::String(text) => DateTime::parse_from_rfc3339(&text.replace('Z', "+00:00")).ok().map(|dt| dt.with_timezone(&Utc).to_rfc3339()),
        Value::Number(n) => n.as_i64().map(timestamp_from_epoch),
        _ => None,
    }
}

fn timestamp_from_epoch(mut value: i64) -> String {
    if value > 10_000_000_000 {
        value /= 1000;
    }
    Utc.timestamp_opt(value, 0).single().unwrap_or_else(Utc::now).to_rfc3339()
}

fn path_hash(path: &Path) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    hasher.finish()
}

fn safe_file_name(path: &Path) -> String {
    path.file_name().and_then(|v| v.to_str()).unwrap_or("[unknown]").to_string()
}

#[allow(dead_code)]
fn codex_version() -> Option<String> {
    let cmd = find_codex_command()?;
    let output = Command::new(cmd).arg("--version").output().ok()?;
    Some(String::from_utf8_lossy(if output.stdout.is_empty() { &output.stderr } else { &output.stdout }).lines().next().unwrap_or("unknown").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::default_settings;

    #[test]
    fn codex_token_totals_become_labelled_fallback_percentages() {
        let mut settings = default_settings();
        settings.session_budget_tokens = 1_000;
        settings.weekly_budget_tokens = 1_000;
        let mut totals = empty_totals_map();
        totals.get_mut("session").unwrap().input_tokens = 250;
        totals.get_mut("session").unwrap().visible_tokens = 250;
        totals.get_mut("session").unwrap().total_tokens = 250;
        totals.get_mut("week").unwrap().input_tokens = 500;
        totals.get_mut("week").unwrap().visible_tokens = 500;
        totals.get_mut("week").unwrap().total_tokens = 500;
        let mut snapshot = UsageSnapshot::error(CODEX_ID, "OpenAI", "test".to_string());

        apply_token_totals(&mut snapshot, &totals, &settings, true);

        apply_codex_fallback_budgets(&mut snapshot, &totals, &settings);

        assert!(snapshot.session_usage_percent.unwrap() < 1.0);
        assert!(snapshot.weekly_usage_percent.unwrap() < 1.0);
        assert_eq!(snapshot.input_tokens, 250);
        assert_eq!(snapshot.error_state, None);
        assert_eq!(snapshot.raw_limit_name.as_deref(), Some("OpenAI local fallback estimate from token counters and Codex-sized configured budgets"));
    }

    #[test]
    fn claude_local_estimates_still_use_configured_budgets() {
        let mut settings = default_settings();
        settings.session_budget_tokens = 1_000;
        settings.weekly_budget_tokens = 2_000;
        let mut totals = empty_totals_map();
        totals.get_mut("session").unwrap().input_tokens = 250;
        totals.get_mut("session").unwrap().visible_tokens = 250;
        totals.get_mut("session").unwrap().total_tokens = 250;
        totals.get_mut("week").unwrap().input_tokens = 500;
        totals.get_mut("week").unwrap().visible_tokens = 500;
        totals.get_mut("week").unwrap().total_tokens = 500;
        let mut snapshot = UsageSnapshot::error(CLAUDE_ID, "Anthropic", "test".to_string());

        apply_token_totals(&mut snapshot, &totals, &settings, true);

        assert_eq!(snapshot.session_usage_percent, Some(25.0));
        assert_eq!(snapshot.weekly_usage_percent, Some(25.0));
    }
}
