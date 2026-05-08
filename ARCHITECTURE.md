# Simple AI Usage Monitor Architecture Notes

This document captures the current v6 architecture before any app rewrite.

## App entry points

- `claude_usage_tray.py` is the main Tkinter application. Running it logs `App starting v6`, constructs `App`, and enters `root.mainloop()`.
- `start.bat` launches the app with `pythonw claude_usage_tray.py` for normal background use on Windows.
- `debug_start.bat` launches `python claude_usage_tray.py` in a console and pauses afterward, which is useful when the GUI fails to appear.
- `install.bat` installs Python dependencies from `requirements.txt`.
- `install_statusline.bat` runs `setup_statusline.py`, which writes Claude Code statusline settings.
- `statusline_capture.py` is not the tray app; it is the Claude Code statusline command that captures Claude's statusline JSON to disk and prints a compact statusline string.

## Tray icon implementation

- `claude_usage_tray.py` imports `pystray` and Pillow opportunistically. If either import fails, `pystray`, `Image`, and `ImageDraw` are set to `None`, and the app continues without a tray icon.
- `make_icon()` draws a generated 64x64 RGBA icon with Pillow: circular background, rotating signal motif, and a bottom usage bar based on session percentage.
- `App._start_tray()` creates a `pystray.Icon` named `simple_ai_usage_monitor`, attaches a menu for Usage summary, Open app, Show desktop widget, and Quit, then starts it with `run_detached()`.
- Tray callbacks marshal back to Tk with `root.after(0, ...)`, which avoids directly touching Tk widgets from pystray callback context.
- During refresh animation and data updates, the tray title and icon are replaced with updated reset text, usage percentage, and spin angle.

## Floating widget implementation

- The floating desktop widget is a Tk `Toplevel`, not a Windows Widgets Board provider.
- `App.show_desktop_widget()` creates a topmost, fixed-size, dark-themed window near the lower-left taskbar area.
- The widget contains a small canvas logo plus Session and Weekly rows. Values are backed by `StringVar` objects for `session`, `session_reset`, `week`, and `week_reset`.
- Double-clicking the widget, its header frames, or logo opens the main app window.
- `App._update_widget()` reads the effective usage model, updates percentages and reset labels, refreshes the timestamp, and redraws the logo.
- `App._update_widget_logo()` redraws a simple canvas logo with a dot position derived from `self.spin_angle`; `App._spin_tick()` advances that angle briefly after each refresh starts.

## Settings and config files

- Runtime app config lives under `%APPDATA%\ClaudeCodeUsageTray` on Windows, or `Path.home()` when `APPDATA` is absent.
- `config.json` is created on first run from `DEFAULT_CONFIG`. Settings include Claude log directory, refresh interval, fallback session hours, fallback token budgets, cache-token inclusion, start-minimized behavior, widget startup visibility, and usage source.
- `statusline_latest.json` in the same config directory is the latest captured Claude Code statusline payload.
- `debug.log` in the same config directory is the app debug log.
- `setup_statusline.py` edits `~/.claude/settings.json`, backs up any existing file, and writes a `statusLine` command pointing at `.venv\Scripts\python.exe` plus `statusline_capture.py` with refresh interval 10.

## Usage data sources

- Provider access now goes through `UsageProviderAdapter` in `claude_usage_tray.py`. Each adapter exposes a provider id/name, display label, local availability check, latest provider-neutral usage snapshot, optional local history import, and current error state.
- The main UI only shows providers with real local usage data. Installed tools without a safe usage source are treated as unused and hidden from provider usage sections.
- `ClaudeCodeProviderAdapter` is the first adapter. It wraps the existing Claude Code statusline reader and local JSONL scanner without changing the data source policy or reading credentials.
- `CodexCliProviderAdapter` is availability-only. It checks for a runnable `codex` CLI and safe `~/.codex/config.toml` presence, but it does not read `auth.json`, session transcripts, history, logs, SQLite rows, prompts, responses, project paths, or credential material.
- Preferred source: `read_statusline_usage()` reads `statusline_latest.json`, unwraps the `raw` object if present, and looks for `rate_limits`/`rate_limit` with `five_hour`/`session` and `seven_day`/`weekly` fields.
- The statusline reader accepts `used_percentage` or `utilization`, accepts `resets_at` or `reset_at`, and normalizes fractional utilization values from 0..1 to 0..100.
- Fallback source: `scan_usage()` recursively scans `*.jsonl` files under the configured Claude projects log directory, finds nested `usage` dictionaries, extracts token counts, deduplicates records by request/message/id fields when available, and buckets totals into session, today, week, and all-time windows.
- Local fallback percentages are estimated from scanned token totals divided by configurable session and weekly token budgets. Cache tokens are included only when `include_cache_tokens` is enabled.

## Refresh loop

- `App.__init__()` builds the UI, starts the tray, immediately calls `refresh()`, starts `_poll()` every 500 ms, and schedules `_scheduled()` based on `refresh_seconds`.
- `refresh()` is guarded by `_refreshing`; if a scan is already running, a new refresh request returns early.
- Each refresh starts a short spin animation, then launches `_scan_thread()` on a daemon thread.
- `_scan_thread()` asks the configured provider adapter for availability, latest usage, and imported local history, then pushes `(RateLimitUsage, totals)` into a queue. Failures are logged and converted into an error `RateLimitUsage` plus empty totals.
- `_poll()` runs on Tk's event loop, drains queued scan results, clears `_refreshing`, and calls `_update()`.
- `_update()` stores the latest data, computes effective percentages, updates main labels, status text, tray title/icon, usage panel, and floating widget.

## Logging and debug flow

- `log()` appends timestamped messages to `%APPDATA%\ClaudeCodeUsageTray\debug.log` and suppresses logging failures.
- The app logs startup, pystray availability/startup, skipped JSONL scan files, and refresh failures.
- The main window exposes an `Open Debug Log` button that opens `debug.log` if it exists.
- `debug_start.bat` runs the app in a console instead of `pythonw`, making import errors or Tk failures visible.
- `statusline_capture.py` writes statusline parsing exceptions to `%APPDATA%\ClaudeCodeUsageTray\statusline_error.log` and prints a fallback statusline message.

## Known fragile areas

- Most app logic lives in one large file and a single `App` class, so UI, data access, scheduling, and persistence are tightly coupled.
- `pystray` and Tk run in the same process with cross-thread callback coordination. The current callbacks use `root.after`, but icon mutation also occurs during Tk refresh updates and animation.
- The local JSONL scanner recursively reads every `*.jsonl` file on each refresh. Large Claude project histories may make a 10-second refresh interval expensive.
- Usage parsing relies on recursive key searches and inferred schemas. Changes to Claude Code log/statusline JSON can silently fall back to estimates or miss data.
- Deduplication uses the first recognized ID key, or falls back to `path:line_no`; schema changes or repeated records without stable IDs could overcount or undercount.
- `setup_statusline.py` assumes a Windows virtualenv interpreter at `.venv\Scripts\python.exe`, while `install.bat` installs into whatever `python` resolves to and does not create `.venv`.
- Numeric settings are validated only in the Settings dialog. Existing malformed `config.json` values can still fail in refresh scheduling or budget calculations.
- Several broad `except Exception` blocks suppress errors, which improves resilience but can hide actionable failures.
- Topmost floating/panel windows and fixed screen positioning may behave poorly across DPI settings, multi-monitor setups, non-Windows desktops, or taskbar layouts.

## Safe next refactors

1. Split pure usage parsing/scanning functions into a small module with unit tests and fixture JSONL/statusline payloads.
2. Introduce typed config loading/validation that sanitizes existing `config.json` before the UI or scheduler uses it.
3. Extract the refresh worker and queue protocol from `App` so threading and Tk event-loop boundaries are explicit.
4. Add incremental/local scan caching based on file path, size, and mtime to avoid rescanning all JSONL history every interval.
5. Centralize effective usage calculation into a pure function that accepts statusline data, local totals, and config.
6. Replace broad silent exception handling with targeted exceptions plus visible debug-log context.
7. Normalize launcher/install behavior so `install.bat`, `setup_statusline.py`, and documented Python interpreter paths agree.
8. Move tray icon drawing and widget logo drawing behind small rendering helpers that can be tested without starting the full app.
9. Keep the current Tk UI intact during the first refactors; only move pure logic and adapters before changing UI behavior.
