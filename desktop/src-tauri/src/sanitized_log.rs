use crate::config::default_app_data_dir;
use chrono::Local;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;

pub fn log(message: &str) {
    let dir = default_app_data_dir();
    if create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("debug.log");
    let sanitized = sanitize(message);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} {}", Local::now().format("%Y-%m-%dT%H:%M:%S"), sanitized);
    }
}

pub fn sanitize(message: &str) -> String {
    message
        .replace('\\', "/")
        .split_whitespace()
        .map(|part| {
            if part.contains("/.claude/")
                || part.contains("/.codex/")
                || part.contains("auth")
                || part.contains("token")
                || part.contains("secret")
            {
                "[redacted]"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
