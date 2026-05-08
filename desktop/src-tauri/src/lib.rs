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
use crate::models::{AppSettings, BurnRateProjection, MonitorState};
use crate::providers::{collect_active_provider, provider_availability};
use crate::storage::Store;
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
        let settings = self.settings()?;
        let providers = provider_availability(&settings, &self.data_dir);
        let active = collect_active_provider(&settings, &self.data_dir);
        let mut app_state = "paused".to_string();
        let mut status_message = "Paused: no provider usage data found yet.".to_string();
        let mut latest_snapshot = None;
        let mut totals = crate::models::empty_totals_map();

        if let Some(result) = active {
            app_state = if result.snapshot.error_state.is_some() { "error" } else { "ready" }.to_string();
            status_message = if result.snapshot.error_state.is_some() {
                result.snapshot.error_state.clone().unwrap_or_else(|| "Provider unavailable.".to_string())
            } else if result.snapshot.is_estimate {
                "Ready: local estimate refreshed.".to_string()
            } else {
                "Ready: statusline usage refreshed.".to_string()
            };
            totals = result.totals;
            if force_refresh {
                self.store.append_snapshot(&result.snapshot)?;
            }
            latest_snapshot = Some(result.snapshot);
        }

        let history = self.store.history_points(5)?;
        let mut burn = BTreeMap::new();
        burn.insert(
            "session".to_string(),
            calculate_burn(&history, "session", latest_snapshot.as_ref().and_then(|s| s.session_usage_percent)),
        );
        burn.insert(
            "week".to_string(),
            calculate_burn(&history, "weekly", latest_snapshot.as_ref().and_then(|s| s.weekly_usage_percent)),
        );
        if burn.is_empty() {
            burn.insert("session".to_string(), BurnRateProjection::reason("not enough data yet"));
            burn.insert("week".to_string(), BurnRateProjection::reason("not enough data yet"));
        }

        Ok(MonitorState {
            settings,
            active_provider_id: latest_snapshot.as_ref().map(|s| s.provider_id.clone()),
            providers,
            latest_snapshot,
            totals,
            burn,
            spikes: detect_spikes(&history),
            history,
            app_state,
            status_message,
            imported_legacy: self.imported_legacy,
        })
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
    let cmd = format!("\"{}\" --data-dir \"{}\"", sidecar.display(), data_dir.display());
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let core = AppCore::initialize().map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            app.manage(Mutex::new(core));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_monitor_state,
            refresh_usage,
            get_settings,
            save_settings,
            enable_codex_tracking,
            setup_statusline,
            open_usage_page
        ])
        .run(tauri::generate_context!())
        .expect("error while running Simple AI Usage Monitor");
}
