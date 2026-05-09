mod config;
mod forecast;
mod import_legacy;
mod models;
mod providers;
mod sanitized_log;
mod storage;

use crate::config::{default_app_data_dir, sanitize_settings};
use crate::forecast::{calculate_burn, detect_spikes};
use crate::import_legacy::import_legacy_if_needed;
use crate::models::{AppSettings, BurnRateProjection, MonitorState, ProviderUsage, UsageSnapshot, UsageTotals};
use crate::providers::{collect_provider, provider_availability};
use crate::storage::Store;
use chrono::Utc;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub struct AppCore {
    data_dir: PathBuf,
    store: Store,
    imported_legacy: bool,
}

impl AppCore {
    fn initialize() -> Result<Self, String> {
        let data_dir = default_app_data_dir();
        fs::create_dir_all(&data_dir).map_err(|e| format!("Could not create app data directory: {e}"))?;
        let store = Store::open(&data_dir)?;
        let imported_legacy = import_legacy_if_needed(&store).unwrap_or_else(|e| {
            sanitized_log::log(&format!("legacy import failed: {e}"));
            false
        });
        Ok(Self {
            data_dir,
            store,
            imported_legacy,
        })
    }

    fn settings(&self) -> Result<AppSettings, String> {
        self.store.get_settings()
    }

    fn save_settings(&self, settings: AppSettings) -> Result<AppSettings, String> {
        let settings = sanitize_settings(settings);
        self.store.save_settings(&settings)?;
        Ok(settings)
    }

    fn monitor_state(&self, force_refresh: bool) -> Result<MonitorState, String> {
        let mut settings = self.settings()?;
        let providers = provider_availability(&settings, &self.data_dir);
        let mut app_state = "paused".to_string();
        let mut status_message = "Paused: no provider usage data found yet.".to_string();

        let mut provider_usages = Vec::new();
        for provider in providers.iter().filter(|p| p.has_data) {
            let Some(result) = collect_provider(&provider.provider_id, &settings, &self.data_dir) else {
                continue;
            };
            if provider.provider_id == "claude_code" && maybe_auto_calibrate_claude_session(&mut settings, &result.snapshot, &result.totals) {
                settings = self.save_settings(settings.clone())?;
            }
            let mut provider_history = self.store.history_points(5, Some(&provider.provider_id))?;
            if force_refresh {
                if should_append_snapshot(&result.snapshot) {
                    self.store.append_snapshot(&result.snapshot)?;
                    provider_history = self.store.history_points(5, Some(&provider.provider_id))?;
                }
            }
            if provider_history.is_empty() {
                let snapshot = &result.snapshot;
                if should_append_snapshot(snapshot) {
                    self.store.append_snapshot(snapshot)?;
                    provider_history = self.store.history_points(5, Some(&provider.provider_id))?;
                }
            }

            let mut burn = BTreeMap::new();
            burn.insert(
                "session".to_string(),
                calculate_burn(&provider_history, "session", result.snapshot.session_usage_percent),
            );
            burn.insert(
                "week".to_string(),
                calculate_burn(&provider_history, "weekly", result.snapshot.weekly_usage_percent),
            );
            provider_usages.push(ProviderUsage {
                provider_id: provider.provider_id.clone(),
                display_label: provider.display_label.clone(),
                spikes: detect_spikes(&provider_history),
                burn,
                snapshot: result.snapshot,
                totals: result.totals,
            });
        }

        let history = self.store.history_points(5, None)?;
        let latest_snapshot = provider_usages.first().map(|usage| usage.snapshot.clone());
        let totals = provider_usages
            .first()
            .map(|usage| usage.totals.clone())
            .unwrap_or_else(crate::models::empty_totals_map);
        let mut burn = BTreeMap::new();
        burn.insert("session".to_string(), BurnRateProjection::reason("see provider cards"));
        burn.insert("week".to_string(), BurnRateProjection::reason("see provider cards"));
        let spikes = provider_usages
            .first()
            .map(|usage| usage.spikes.clone())
            .unwrap_or_default();

        if !provider_usages.is_empty() {
            app_state = if provider_usages.iter().any(|usage| usage.snapshot.error_state.is_some()) {
                "error".to_string()
            } else {
                "ready".to_string()
            };
            let estimate_count = provider_usages.iter().filter(|usage| usage.snapshot.is_estimate).count();
            status_message = if estimate_count > 0 {
                format!("Ready: {} provider(s) refreshed; local fallback estimates are labelled.", provider_usages.len())
            } else {
                format!("Ready: {} provider(s) refreshed.", provider_usages.len())
            };
        }

        Ok(MonitorState {
            settings,
            active_provider_id: None,
            providers,
            provider_usages,
            latest_snapshot,
            totals,
            burn,
            spikes,
            history,
            app_state,
            status_message,
            imported_legacy: self.imported_legacy,
        })
    }
}

fn should_append_snapshot(snapshot: &crate::models::UsageSnapshot) -> bool {
    let has_usage = snapshot.total_tokens > 0
        || snapshot.session_usage_percent.is_some()
        || snapshot.weekly_usage_percent.is_some();
    if !has_usage {
        return false;
    }
    snapshot.error_state.is_none() || snapshot.source.contains("statusline stale")
}

fn maybe_auto_calibrate_claude_session(
    settings: &mut AppSettings,
    snapshot: &UsageSnapshot,
    totals: &BTreeMap<String, UsageTotals>,
) -> bool {
    if snapshot.provider_id != "claude_code" || snapshot.is_estimate || snapshot.error_state.is_some() {
        return false;
    }
    if !snapshot.source.eq_ignore_ascii_case("Claude Code statusline") {
        return false;
    }
    let Some(percent) = snapshot.session_usage_percent else {
        return false;
    };
    if !percent.is_finite() || percent <= 0.0 || percent >= 100.0 {
        return false;
    }
    let session = totals.get("session").cloned().unwrap_or_else(UsageTotals::empty);
    let session_tokens = if settings.include_cache_tokens { session.total_tokens } else { session.visible_tokens };
    if session_tokens <= 0 {
        return false;
    }
    let budget_tokens = ((session_tokens as f64) / (percent / 100.0)).round() as i64;
    let existing_tokens = settings.claude_session_calibration_tokens.unwrap_or(-1);
    let existing_percent = settings.claude_session_calibration_percent.unwrap_or(-1.0);
    if existing_tokens == session_tokens && (existing_percent - percent).abs() < 0.05 {
        return false;
    }
    settings.claude_session_calibration_percent = Some(percent);
    settings.claude_session_calibration_tokens = Some(session_tokens);
    settings.claude_session_calibration_budget_tokens = Some(budget_tokens.max(session_tokens + 1));
    settings.claude_session_calibration_at = Some(Utc::now().to_rfc3339());
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::default_settings;
    use crate::models::empty_totals_map;

    #[test]
    fn exact_fresh_claude_statusline_auto_calibrates_session_budget() {
        let mut settings = default_settings();
        let mut totals = empty_totals_map();
        totals.get_mut("session").unwrap().input_tokens = 500;
        totals.get_mut("session").unwrap().visible_tokens = 500;
        totals.get_mut("session").unwrap().total_tokens = 500;
        let snapshot = UsageSnapshot {
            provider_id: "claude_code".to_string(),
            provider_name: "Anthropic".to_string(),
            source: "Claude Code statusline".to_string(),
            timestamp_utc: Utc::now().to_rfc3339(),
            model_name: None,
            input_tokens: 500,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            total_tokens: 500,
            session_usage_percent: Some(25.0),
            weekly_usage_percent: Some(10.0),
            session_reset_at: None,
            weekly_reset_at: None,
            raw_limit_name: None,
            is_estimate: false,
            error_state: None,
        };

        assert!(maybe_auto_calibrate_claude_session(&mut settings, &snapshot, &totals));
        assert_eq!(settings.claude_session_calibration_percent, Some(25.0));
        assert_eq!(settings.claude_session_calibration_tokens, Some(500));
        assert_eq!(settings.claude_session_calibration_budget_tokens, Some(2000));
    }

    #[test]
    fn stale_or_estimated_claude_snapshot_does_not_auto_calibrate() {
        let mut settings = default_settings();
        let mut totals = empty_totals_map();
        totals.get_mut("session").unwrap().input_tokens = 500;
        totals.get_mut("session").unwrap().visible_tokens = 500;
        totals.get_mut("session").unwrap().total_tokens = 500;
        let snapshot = UsageSnapshot {
            provider_id: "claude_code".to_string(),
            provider_name: "Anthropic".to_string(),
            source: "Claude Code local logs (statusline stale)".to_string(),
            timestamp_utc: Utc::now().to_rfc3339(),
            model_name: None,
            input_tokens: 500,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            total_tokens: 500,
            session_usage_percent: Some(25.0),
            weekly_usage_percent: None,
            session_reset_at: None,
            weekly_reset_at: None,
            raw_limit_name: None,
            is_estimate: true,
            error_state: Some("stale".to_string()),
        };

        assert!(!maybe_auto_calibrate_claude_session(&mut settings, &snapshot, &totals));
        assert_eq!(settings.claude_session_calibration_percent, None);
    }
}

#[tauri::command]
fn get_monitor_state(core: State<'_, Mutex<AppCore>>) -> Result<MonitorState, String> {
    core.lock().map_err(|_| "App state lock failed.".to_string())?.monitor_state(false)
}

#[tauri::command]
fn refresh_usage(core: State<'_, Mutex<AppCore>>) -> Result<MonitorState, String> {
    core.lock().map_err(|_| "App state lock failed.".to_string())?.monitor_state(true)
}

#[tauri::command]
fn get_settings(core: State<'_, Mutex<AppCore>>) -> Result<AppSettings, String> {
    core.lock().map_err(|_| "App state lock failed.".to_string())?.settings()
}

#[tauri::command]
fn save_settings(core: State<'_, Mutex<AppCore>>, settings: AppSettings) -> Result<MonitorState, String> {
    let core = core.lock().map_err(|_| "App state lock failed.".to_string())?;
    core.save_settings(settings)?;
    core.monitor_state(true)
}

#[tauri::command]
fn enable_codex_tracking(core: State<'_, Mutex<AppCore>>) -> Result<MonitorState, String> {
    let core = core.lock().map_err(|_| "App state lock failed.".to_string())?;
    let mut settings = core.settings()?;
    settings.codex_tracking_enabled = true;
    settings.selected_provider_id = "openai_codex_cli".to_string();
    core.save_settings(settings)?;
    core.monitor_state(true)
}

#[tauri::command]
fn calibrate_claude_session(core: State<'_, Mutex<AppCore>>, percent: f64) -> Result<MonitorState, String> {
    if !percent.is_finite() || percent <= 0.0 || percent >= 100.0 {
        return Err("Session calibration must be greater than 0 and less than 100.".to_string());
    }
    let core = core.lock().map_err(|_| "App state lock failed.".to_string())?;
    let mut settings = core.settings()?;
    let result = collect_provider("claude_code", &settings, &core.data_dir)
        .ok_or_else(|| "Claude Code provider is unavailable.".to_string())?;
    let session = result
        .totals
        .get("session")
        .cloned()
        .unwrap_or_else(crate::models::UsageTotals::empty);
    let session_tokens = if settings.include_cache_tokens { session.total_tokens } else { session.visible_tokens };
    if session_tokens <= 0 {
        return Err("No local Claude session token total is available to calibrate from yet.".to_string());
    }
    let budget_tokens = ((session_tokens as f64) / (percent / 100.0)).round() as i64;
    settings.claude_session_calibration_percent = Some(percent);
    settings.claude_session_calibration_tokens = Some(session_tokens);
    settings.claude_session_calibration_budget_tokens = Some(budget_tokens.max(session_tokens + 1));
    settings.claude_session_calibration_at = Some(Utc::now().to_rfc3339());
    core.save_settings(settings)?;
    core.monitor_state(true)
}

#[tauri::command]
fn setup_statusline(app: AppHandle, core: State<'_, Mutex<AppCore>>) -> Result<String, String> {
    let data_dir = {
        let core = core.lock().map_err(|_| "App state lock failed.".to_string())?;
        core.data_dir.clone()
    };
    let sidecar = app
        .path()
        .resolve("statusline_capture.exe", tauri::path::BaseDirectory::Resource)
        .or_else(|_| app.path().resolve("statusline_capture", tauri::path::BaseDirectory::Resource))
        .map_err(|e| format!("Could not resolve statusline sidecar: {e}"))?;
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory.".to_string())?;
    let claude_dir = home.join(".claude");
    fs::create_dir_all(&claude_dir).map_err(|e| format!("Could not create Claude settings directory: {e}"))?;
    let settings_path = claude_dir.join("settings.json");
    let backup_path = if settings_path.exists() {
        let backup = settings_path.with_extension(format!("backup-{}.json", chrono::Local::now().format("%Y%m%d-%H%M%S")));
        fs::copy(&settings_path, &backup).map_err(|e| format!("Could not back up Claude settings: {e}"))?;
        Some(backup)
    } else {
        None
    };
    let mut value = fs::read_to_string(&settings_path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let sidecar_cmd_path = command_path(&sidecar);
    let data_dir_cmd_path = command_path(&data_dir);
    let cmd = format!("\"{}\" --data-dir \"{}\"", sidecar_cmd_path, data_dir_cmd_path);
    value["statusLine"] = serde_json::json!({
        "type": "command",
        "command": cmd,
        "padding": 1,
        "refreshInterval": 10
    });
    fs::write(&settings_path, serde_json::to_string_pretty(&value).unwrap())
        .map_err(|e| format!("Could not write Claude settings: {e}"))?;
    Ok(match backup_path {
        Some(backup) => format!("Claude Code statusline installed. Backup: {}", backup.display()),
        None => "Claude Code statusline installed.".to_string(),
    })
}

#[tauri::command]
fn open_usage_page(core: State<'_, Mutex<AppCore>>) -> Result<(), String> {
    let settings = core.lock().map_err(|_| "App state lock failed.".to_string())?.settings()?;
    let url = if settings.selected_provider_id == "openai_codex_cli" {
        "https://chatgpt.com/codex/settings/usage"
    } else {
        "https://claude.ai/settings/usage"
    };
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| format!("Could not open usage page: {e}"))
}

fn command_path(path: &std::path::Path) -> String {
    path.to_string_lossy().trim_start_matches(r"\\?\").to_string()
}

pub fn run() {
    let core = AppCore::initialize().expect("failed to initialize Simple AI Usage Monitor state");
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(core))
        .invoke_handler(tauri::generate_handler![
            get_monitor_state,
            refresh_usage,
            get_settings,
            save_settings,
            enable_codex_tracking,
            calibrate_claude_session,
            setup_statusline,
            open_usage_page
        ])
        .run(tauri::generate_context!())
        .expect("error while running Simple AI Usage Monitor");
}
