use crate::models::AppSettings;
use serde_json::Value;
use std::path::PathBuf;

pub fn default_app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("SimpleAIUsageMonitor")
}

pub fn legacy_app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("ClaudeCodeUsageTray")
}

pub fn default_settings() -> AppSettings {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    AppSettings {
        claude_log_dir: home.join(".claude").join("projects").to_string_lossy().to_string(),
        codex_home: std::env::var("CODEX_HOME")
            .unwrap_or_else(|_| home.join(".codex").to_string_lossy().to_string()),
        codex_tracking_enabled: false,
        selected_provider_id: "claude_code".to_string(),
        refresh_seconds: 10,
        session_hours: 5.0,
        session_budget_tokens: 1_000_000,
        weekly_budget_tokens: 10_000_000,
        include_cache_tokens: false,
        start_minimized: false,
        show_desktop_widget: true,
        widget_display_mode: "full".to_string(),
        theme_mode: "system".to_string(),
        usage_source: "statusline_then_local".to_string(),
        history_retention_days: 30,
        alerts_enabled: true,
        session_warning_threshold: 80.0,
        session_critical_threshold: 95.0,
        weekly_warning_threshold: 80.0,
        weekly_critical_threshold: 95.0,
    }
}

pub fn sanitize_settings(mut settings: AppSettings) -> AppSettings {
    settings.refresh_seconds = settings.refresh_seconds.max(1);
    settings.session_hours = if settings.session_hours.is_finite() && settings.session_hours > 0.0 {
        settings.session_hours
    } else {
        5.0
    };
    settings.session_budget_tokens = settings.session_budget_tokens.max(0);
    settings.weekly_budget_tokens = settings.weekly_budget_tokens.max(0);
    if !["full", "compact", "minimal"].contains(&settings.widget_display_mode.as_str()) {
        settings.widget_display_mode = "full".to_string();
    }
    if !["system", "dark", "light"].contains(&settings.theme_mode.as_str()) {
        settings.theme_mode = "system".to_string();
    }
    settings.history_retention_days = settings.history_retention_days.max(1);
    settings
}

pub fn settings_from_legacy_json(value: &Value) -> AppSettings {
    let mut settings = default_settings();
    if let Some(v) = value.get("claude_log_dir").and_then(Value::as_str) {
        settings.claude_log_dir = v.to_string();
    }
    if let Some(v) = value.get("codex_home").and_then(Value::as_str) {
        settings.codex_home = v.to_string();
    }
    if let Some(v) = value.get("codex_tracking_enabled").and_then(Value::as_bool) {
        settings.codex_tracking_enabled = v;
    }
    if let Some(v) = value.get("selected_provider_id").and_then(Value::as_str) {
        settings.selected_provider_id = v.to_string();
    }
    if let Some(v) = value.get("refresh_seconds").and_then(Value::as_u64) {
        settings.refresh_seconds = v;
    }
    if let Some(v) = value.get("session_hours").and_then(Value::as_f64) {
        settings.session_hours = v;
    }
    if let Some(v) = value.get("session_budget_tokens").and_then(Value::as_i64) {
        settings.session_budget_tokens = v;
    }
    if let Some(v) = value.get("weekly_budget_tokens").and_then(Value::as_i64) {
        settings.weekly_budget_tokens = v;
    }
    if let Some(v) = value.get("include_cache_tokens").and_then(Value::as_bool) {
        settings.include_cache_tokens = v;
    }
    if let Some(v) = value.get("start_minimized").and_then(Value::as_bool) {
        settings.start_minimized = v;
    }
    if let Some(v) = value.get("show_desktop_widget").and_then(Value::as_bool) {
        settings.show_desktop_widget = v;
    }
    if let Some(v) = value.get("widget_display_mode").and_then(Value::as_str) {
        settings.widget_display_mode = v.to_string();
    }
    if let Some(v) = value.get("theme_mode").and_then(Value::as_str) {
        settings.theme_mode = v.to_string();
    }
    sanitize_settings(settings)
}
