use crate::config::{legacy_app_data_dir, settings_from_legacy_json};
use crate::sanitized_log::log;
use crate::storage::Store;
use serde_json::Value;
use std::fs;

pub fn import_legacy_if_needed(store: &Store) -> Result<bool, String> {
    if store.legacy_import_done()? {
        return Ok(false);
    }
    let legacy_dir = legacy_app_data_dir();
    let config_path = legacy_dir.join("config.json");
    if config_path.exists() {
        match fs::read_to_string(&config_path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        {
            Some(value) => {
                let settings = settings_from_legacy_json(&value);
                store.save_settings(&settings)?;
            }
            None => log("legacy config import skipped: malformed config.json"),
        }
    }

    let history_path = legacy_dir.join("usage_history.jsonl");
    if history_path.exists() {
        match fs::read_to_string(&history_path) {
            Ok(text) => {
                for line in text.lines() {
                    if let Ok(value) = serde_json::from_str::<Value>(line) {
                        let _ = store.import_legacy_row(&value);
                    }
                }
            }
            Err(_) => log("legacy history import skipped: could not read usage_history.jsonl"),
        }
    }

    let latest_path = legacy_dir.join("statusline_latest.json");
    if latest_path.exists() {
        let new_dir = crate::config::default_app_data_dir();
        let _ = fs::create_dir_all(&new_dir);
        let _ = fs::copy(&latest_path, new_dir.join("statusline_latest.json"));
    }

    store.mark_legacy_import_done()?;
    Ok(true)
}
