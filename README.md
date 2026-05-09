# Simple AI Usage Monitor

Lightweight, local-first monitor for AI coding-agent usage. The app focuses on safe local telemetry: usage percentages, token totals, reset windows, forecasts, timeline spikes, tray status, and a floating widget.

## Current Shape

This repository currently contains two app tracks:

- `desktop/`: the Tauri + React migration app. This is the cross-platform shell direction and includes a Rust backend, SQLite storage, tray/window integration, and a Rust Claude Code statusline sidecar.
- `claude_usage_tray.py`: the original Python Windows tray app. It remains available during parity migration and rollback.

The Tauri app is the preferred development path. The Python app is still useful while behavior parity is being validated.

## Features

- System tray icon and tray menu.
- Floating widget with Full, Compact, and Minimal modes.
- Main dashboard and settings UI.
- Claude Code statusline capture.
- Claude Code local log fallback estimates.
- Optional OpenAI Codex CLI local session tracking.
- Local SQLite history in the Tauri app.
- Rolling charts, burn-rate forecasts, and session timeline spike detection.
- Dark, light, and system theme modes.

## Provider Adapters

Provider integrations live behind the Rust backend in the Tauri app. A provider adapter turns a safe local data source into the shared usage model used by the dashboard, widget, forecasts, history, and charts.

Start with the dedicated guide:

[Adding a Provider Adapter](PROVIDER_ADAPTERS.md)

For coding-agent workflows, this repo also includes a starter skill:

[Provider Adapter Expert Skill](agents/provider-adapter-expert/SKILL.md)

At a high level, a provider must supply:

- `ProviderAvailability`: whether the provider is installed/configured and whether it has local usage data.
- `UsageSnapshot`: the latest provider-neutral usage snapshot.
- `UsageTotals`: token totals for `session`, `today`, `week`, and `all`.
- Optional parsing helpers for local JSON, JSONL, statusline output, or exported data.

The dashboard header shows how many providers currently have usable local data. Clicking that status opens provider setup details sourced from each adapter's safe configuration note and data-source description, so new providers should document both in `ProviderAvailability`.

Adapters must not read credential files, scrape dashboards, store prompt/response content, or log private paths. If a provider requires network access or credentials, treat that as a separate opt-in feature behind explicit approval and configuration.

## Privacy

The app is local-first by default.

It should not collect, transmit, store, or log prompts, responses, credentials, auth tokens, project paths, or provider account data. Provider integrations read local usage counters and statusline data only. Codex CLI tracking is opt-in.

No provider API polling, dashboard scraping, or browser automation is used.

## Run The Tauri App

Install dependencies once:

```bat
cd desktop
npm install
```

Run in development:

```bat
npm run dev
```

From the repo root:

```bat
start_tauri.bat
```

`start_tauri.bat` is a convenience wrapper for `cd desktop` followed by `npm run dev`.

Debug helper:

```bat
debug_start_tauri.bat
```

## Build The Tauri App

```bat
cd desktop
npm run build
```

The build prepares the Rust statusline sidecar, builds the React frontend, compiles the Tauri app, and creates a Windows NSIS installer under:

```text
desktop\src-tauri\target\release\bundle\nsis\
```

## Run The Python App

The original Python app remains available:

1. Run `install.bat`
2. Run `install_statusline.bat`
3. Restart Claude Code or send one new Claude Code message so statusline data is written
4. Run `start.bat`

If something does not appear, run:

```bat
debug_start.bat
```

Python debug log:

```text
%APPDATA%\ClaudeCodeUsageTray\debug.log
```

## Statusline Capture

Claude Code usage is captured through a local statusline command. The Tauri app includes a Rust sidecar for this; the Python app includes `statusline_capture.py`.

The statusline capture stores sanitized usage fields in the local app data folder and prints a compact statusline message for Claude Code.

## Notes

- Tray icons may be hidden under the Windows `^` hidden-icons menu.
- The floating widget is not a Windows Widgets Board widget.
- A true Windows 11 Widget provider requires a separate Windows App SDK/MSIX widget-provider track.
- Forecasts and local fallback percentages are estimates unless sourced from recognized statusline rate-limit data.
- Codex CLI local tracking shows local token counters, not ChatGPT/Codex plan usage percentage.
- Session timeline entries are based on local token deltas and do not include prompt or response content.
