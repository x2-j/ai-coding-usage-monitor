use crate::config::{default_settings, sanitize_settings};
use crate::models::{AppSettings, ChartPoint, UsageSnapshot};
use chrono::{Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub struct Store {
    db_path: PathBuf,
}

impl Store {
    pub fn open(app_data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir).map_err(|e| format!("Could not create app data directory: {e}"))?;
        let store = Self {
            db_path: app_data_dir.join("usage-monitor.sqlite3"),
        };
        store.init()?;
        Ok(store)
    }

    fn connect(&self) -> Result<Connection, String> {
        Connection::open(&self.db_path).map_err(|e| format!("Could not open SQLite store: {e}"))
    }

    fn init(&self) -> Result<(), String> {
        let conn = self.connect()?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS settings(
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS usage_snapshots(
                id INTEGER PRIMARY KEY,
                provider_id TEXT,
                provider_name TEXT,
                source TEXT,
                timestamp_utc TEXT,
                model_name TEXT,
                input_tokens INTEGER,
                output_tokens INTEGER,
                cache_read_tokens INTEGER,
                cache_write_tokens INTEGER,
                total_tokens INTEGER,
                session_usage_percent REAL,
                weekly_usage_percent REAL,
                session_reset_at TEXT,
                weekly_reset_at TEXT,
                raw_limit_name TEXT,
                is_estimate INTEGER,
                error_state TEXT
            );
            CREATE TABLE IF NOT EXISTS scan_cache(
                path_hash TEXT PRIMARY KEY,
                provider_id TEXT,
                size INTEGER,
                mtime_utc TEXT,
                last_seen_utc TEXT
            );
            CREATE TABLE IF NOT EXISTS alert_state(
                scope TEXT,
                threshold_kind TEXT,
                reset_at TEXT,
                last_fired_at TEXT,
                PRIMARY KEY(scope, threshold_kind, reset_at)
            );
            "#,
        )
        .map_err(|e| format!("Could not initialize SQLite schema: {e}"))?;
        Ok(())
    }

    pub fn get_settings(&self) -> Result<AppSettings, String> {
        let conn = self.connect()?;
        let text: Option<String> = conn
            .query_row("SELECT value_json FROM settings WHERE key='app'", [], |row| row.get(0))
            .optional()
            .map_err(|e| format!("Could not read settings: {e}"))?;
        if let Some(text) = text {
            let settings = serde_json::from_str::<AppSettings>(&text).unwrap_or_else(|_| default_settings());
            Ok(sanitize_settings(settings))
        } else {
            let settings = default_settings();
            self.save_settings(&settings)?;
            Ok(settings)
        }
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<(), String> {
        let conn = self.connect()?;
        let settings = sanitize_settings(settings.clone());
        let json = serde_json::to_string_pretty(&settings).map_err(|e| format!("Could not serialize settings: {e}"))?;
        conn.execute(
            "INSERT INTO settings(key, value_json, updated_at) VALUES('app', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
            params![json, Utc::now().to_rfc3339()],
        )
        .map_err(|e| format!("Could not save settings: {e}"))?;
        Ok(())
    }

    pub fn legacy_import_done(&self) -> Result<bool, String> {
        let conn = self.connect()?;
        let done: Option<String> = conn
            .query_row("SELECT value_json FROM settings WHERE key='legacy_import_done'", [], |row| row.get(0))
            .optional()
            .map_err(|e| format!("Could not read import marker: {e}"))?;
        Ok(done.is_some())
    }

    pub fn mark_legacy_import_done(&self) -> Result<(), String> {
        let conn = self.connect()?;
        conn.execute(
            "INSERT INTO settings(key, value_json, updated_at) VALUES('legacy_import_done', 'true', ?1)
             ON CONFLICT(key) DO UPDATE SET value_json='true', updated_at=excluded.updated_at",
            params![Utc::now().to_rfc3339()],
        )
        .map_err(|e| format!("Could not write import marker: {e}"))?;
        Ok(())
    }

    pub fn append_snapshot(&self, snapshot: &UsageSnapshot) -> Result<(), String> {
        let conn = self.connect()?;
        conn.execute(
            r#"
            INSERT INTO usage_snapshots(
                provider_id, provider_name, source, timestamp_utc, model_name,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
                session_usage_percent, weekly_usage_percent, session_reset_at, weekly_reset_at,
                raw_limit_name, is_estimate, error_state
            ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
            "#,
            params![
                snapshot.provider_id,
                snapshot.provider_name,
                snapshot.source,
                snapshot.timestamp_utc,
                snapshot.model_name,
                snapshot.input_tokens,
                snapshot.output_tokens,
                snapshot.cache_read_tokens,
                snapshot.cache_write_tokens,
                snapshot.total_tokens,
                snapshot.session_usage_percent,
                snapshot.weekly_usage_percent,
                snapshot.session_reset_at,
                snapshot.weekly_reset_at,
                snapshot.raw_limit_name,
                if snapshot.is_estimate { 1 } else { 0 },
                snapshot.error_state
            ],
        )
        .map_err(|e| format!("Could not append usage snapshot: {e}"))?;
        Ok(())
    }

    pub fn import_legacy_row(&self, row: &Value) -> Result<(), String> {
        let provider_name = row.get("provider_name").and_then(Value::as_str).unwrap_or("Anthropic").to_string();
        let provider_id = if provider_name.eq_ignore_ascii_case("openai") {
            "openai_codex_cli"
        } else {
            "claude_code"
        };
        let totals = row.get("totals").and_then(|v| v.get("session"));
        let input = totals.and_then(|v| v.get("input_tokens")).and_then(Value::as_i64).unwrap_or_else(|| row.get("input_tokens").and_then(Value::as_i64).unwrap_or(0));
        let output = totals.and_then(|v| v.get("output_tokens")).and_then(Value::as_i64).unwrap_or_else(|| row.get("output_tokens").and_then(Value::as_i64).unwrap_or(0));
        let cache_write = totals.and_then(|v| v.get("cache_creation_input_tokens")).and_then(Value::as_i64).unwrap_or_else(|| row.get("cache_creation_input_tokens").and_then(Value::as_i64).unwrap_or(0));
        let cache_read = totals.and_then(|v| v.get("cache_read_input_tokens")).and_then(Value::as_i64).unwrap_or_else(|| row.get("cache_read_input_tokens").and_then(Value::as_i64).unwrap_or(0));
        let snapshot = UsageSnapshot {
            provider_id: provider_id.to_string(),
            provider_name,
            source: row.get("source").and_then(Value::as_str).unwrap_or("legacy import").to_string(),
            timestamp_utc: row.get("timestamp").and_then(Value::as_str).unwrap_or_else(|| row.get("timestamp_utc").and_then(Value::as_str).unwrap_or("")).to_string(),
            model_name: row.get("model_name").and_then(Value::as_str).map(ToString::to_string),
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_write_tokens: cache_write,
            total_tokens: input + output + cache_read + cache_write,
            session_usage_percent: row.get("session_usage_pct").or_else(|| row.get("session_usage_percent")).and_then(Value::as_f64),
            weekly_usage_percent: row.get("weekly_usage_pct").or_else(|| row.get("weekly_usage_percent")).and_then(Value::as_f64),
            session_reset_at: row.get("session_reset_time").or_else(|| row.get("session_reset_at")).and_then(Value::as_str).map(ToString::to_string),
            weekly_reset_at: row.get("weekly_reset_time").or_else(|| row.get("weekly_reset_at")).and_then(Value::as_str).map(ToString::to_string),
            raw_limit_name: None,
            is_estimate: true,
            error_state: row.get("statusline_error").or_else(|| row.get("error_state")).and_then(Value::as_str).map(ToString::to_string),
        };
        if !snapshot.timestamp_utc.is_empty() {
            self.append_snapshot(&snapshot)?;
        }
        Ok(())
    }

    pub fn history_points(&self, hours: i64) -> Result<Vec<ChartPoint>, String> {
        let conn = self.connect()?;
        let cutoff = (Utc::now() - Duration::hours(hours)).to_rfc3339();
        let mut stmt = conn
            .prepare(
                r#"
                SELECT timestamp_utc, session_usage_percent, weekly_usage_percent,
                       total_tokens, input_tokens,
                       output_tokens
                FROM usage_snapshots
                WHERE timestamp_utc >= ?1
                ORDER BY timestamp_utc ASC
                "#,
            )
            .map_err(|e| format!("Could not prepare history query: {e}"))?;
        let rows = stmt
            .query_map([cutoff], |row| {
                Ok(ChartPoint {
                    timestamp_utc: row.get(0)?,
                    session_usage_percent: row.get(1)?,
                    weekly_usage_percent: row.get(2)?,
                    session_tokens: row.get(3)?,
                    input_tokens: row.get(4)?,
                    output_tokens: row.get(5)?,
                })
            })
            .map_err(|e| format!("Could not query history: {e}"))?;
        Ok(rows.filter_map(Result::ok).collect())
    }
}
