import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, MonitorState } from "./types";

export const getMonitorState = () => invoke<MonitorState>("get_monitor_state");
export const refreshUsage = () => invoke<MonitorState>("refresh_usage");
export const getSettings = () => invoke<AppSettings>("get_settings");
export const saveSettings = (settings: AppSettings) => invoke<MonitorState>("save_settings", { settings });
export const enableCodexTracking = () => invoke<MonitorState>("enable_codex_tracking");
export const setupStatusline = () => invoke<string>("setup_statusline");
export const openUsagePage = () => invoke<void>("open_usage_page");
