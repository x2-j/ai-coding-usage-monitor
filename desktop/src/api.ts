import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, MonitorState } from "./types";

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke?: unknown;
  };
};

const TAURI_UNAVAILABLE_MESSAGE =
  "Tauri backend is unavailable. Run the app with start_tauri.bat or `npm run dev`; the Vite browser page cannot read local usage data by itself.";

function hasTauriBackend() {
  return typeof window !== "undefined" && typeof (window as TauriWindow).__TAURI_INTERNALS__?.invoke === "function";
}

function callBackend<T>(command: string, args?: Record<string, unknown>) {
  if (!hasTauriBackend()) {
    return Promise.reject(new Error(TAURI_UNAVAILABLE_MESSAGE));
  }
  return invoke<T>(command, args);
}

export const getMonitorState = () => callBackend<MonitorState>("get_monitor_state");
export const refreshUsage = () => callBackend<MonitorState>("refresh_usage");
export const getSettings = () => callBackend<AppSettings>("get_settings");
export const saveSettings = (settings: AppSettings) => callBackend<MonitorState>("save_settings", { settings });
export const enableCodexTracking = () => callBackend<MonitorState>("enable_codex_tracking");
export const setupStatusline = () => callBackend<string>("setup_statusline");
export const openUsagePage = () => callBackend<void>("open_usage_page");
