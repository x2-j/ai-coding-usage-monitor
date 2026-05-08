use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageTotals {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub requests: i64,
    pub visible_tokens: i64,
    pub total_tokens: i64,
}

impl UsageTotals {
    pub fn empty() -> Self {
        Self {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            requests: 0,
            visible_tokens: 0,
            total_tokens: 0,
        }
    }

    pub fn add_record(&mut self, record: &UsageSnapshot) {
        self.input_tokens += record.input_tokens;
        self.output_tokens += record.output_tokens;
        self.cache_read_tokens += record.cache_read_tokens;
        self.cache_write_tokens += record.cache_write_tokens;
        self.requests += 1;
        self.visible_tokens = self.input_tokens + self.output_tokens;
        self.total_tokens = self.visible_tokens + self.cache_read_tokens + self.cache_write_tokens;
    }
}

pub fn empty_totals_map() -> BTreeMap<String, UsageTotals> {
    ["session", "today", "week", "all"]
        .into_iter()
        .map(|key| (key.to_string(), UsageTotals::empty()))
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSnapshot {
    pub provider_id: String,
    pub provider_name: String,
    pub source: String,
    pub timestamp_utc: String,
    pub model_name: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub total_tokens: i64,
    pub session_usage_percent: Option<f64>,
    pub weekly_usage_percent: Option<f64>,
    pub session_reset_at: Option<String>,
    pub weekly_reset_at: Option<String>,
    pub raw_limit_name: Option<String>,
    pub is_estimate: bool,
    pub error_state: Option<String>,
}

impl UsageSnapshot {
    pub fn error(provider_id: &str, provider_name: &str, message: String) -> Self {
        Self {
            provider_id: provider_id.to_string(),
            provider_name: provider_name.to_string(),
            source: "local estimate".to_string(),
            timestamp_utc: chrono::Utc::now().to_rfc3339(),
            model_name: None,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            total_tokens: 0,
            session_usage_percent: None,
            weekly_usage_percent: None,
            session_reset_at: None,
            weekly_reset_at: None,
            raw_limit_name: None,
            is_estimate: true,
            error_state: Some(message),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderAvailability {
    pub provider_id: String,
    pub provider_name: String,
    pub display_label: String,
    pub available: bool,
    pub source: String,
    pub message: Option<String>,
    pub has_data: bool,
    pub tracking_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BurnRateProjection {
    pub rate_per_minute: Option<f64>,
    pub rate_per_hour: Option<f64>,
    pub pct_per_hour: Option<f64>,
    pub minutes_until_limit: Option<f64>,
    pub reason: Option<String>,
}

impl BurnRateProjection {
    pub fn reason(reason: &str) -> Self {
        Self {
            rate_per_minute: None,
            rate_per_hour: None,
            pct_per_hour: None,
            minutes_until_limit: None,
            reason: Some(reason.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSpike {
    pub timestamp_utc: String,
    pub token_increase: i64,
    pub input_increase: Option<i64>,
    pub output_increase: Option<i64>,
    pub pct_increase: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub claude_log_dir: String,
    pub codex_home: String,
    pub codex_tracking_enabled: bool,
    pub selected_provider_id: String,
    pub refresh_seconds: u64,
    pub session_hours: f64,
    pub session_budget_tokens: i64,
    pub weekly_budget_tokens: i64,
    pub include_cache_tokens: bool,
    pub start_minimized: bool,
    pub show_desktop_widget: bool,
    pub widget_display_mode: String,
    pub theme_mode: String,
    pub usage_source: String,
    pub history_retention_days: u32,
    pub alerts_enabled: bool,
    pub session_warning_threshold: f64,
    pub session_critical_threshold: f64,
    pub weekly_warning_threshold: f64,
    pub weekly_critical_threshold: f64,
    pub claude_session_calibration_percent: Option<f64>,
    pub claude_session_calibration_tokens: Option<i64>,
    pub claude_session_calibration_budget_tokens: Option<i64>,
    pub claude_session_calibration_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartPoint {
    pub provider_id: String,
    pub provider_name: String,
    pub timestamp_utc: String,
    pub session_usage_percent: Option<f64>,
    pub weekly_usage_percent: Option<f64>,
    pub session_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderUsage {
    pub provider_id: String,
    pub display_label: String,
    pub snapshot: UsageSnapshot,
    pub totals: BTreeMap<String, UsageTotals>,
    pub burn: BTreeMap<String, BurnRateProjection>,
    pub spikes: Vec<UsageSpike>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorState {
    pub settings: AppSettings,
    pub active_provider_id: Option<String>,
    pub providers: Vec<ProviderAvailability>,
    pub provider_usages: Vec<ProviderUsage>,
    pub latest_snapshot: Option<UsageSnapshot>,
    pub totals: BTreeMap<String, UsageTotals>,
    pub burn: BTreeMap<String, BurnRateProjection>,
    pub spikes: Vec<UsageSpike>,
    pub history: Vec<ChartPoint>,
    pub app_state: String,
    pub status_message: String,
    pub imported_legacy: bool,
}
