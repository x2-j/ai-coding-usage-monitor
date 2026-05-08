# Codex / Agent Instructions — Claude Usage Monitor

## Project purpose

This project is a lightweight, local-first Windows utility for monitoring AI coding-agent usage, starting with Claude Code. It currently includes a working system tray icon and a floating widget-style panel. The long-term direction is a developer telemetry tool for tracking AI usage, rate-limit burn, reset windows, prompt spikes, provider/model breakdowns, alerts, and eventually optional native Windows integration.

The app must remain trustworthy, privacy-preserving, and safe to run beside development tools.

## Current product principles

1. Local-first by default.
2. No scraping user accounts or browser sessions.
3. No undocumented API polling unless explicitly approved and isolated behind a feature flag.
4. Do not collect, transmit, or commit private usage history, auth tokens, prompts, project names, or local file paths.
5. Prefer robust local integrations over fragile remote calls.
6. Keep the app lightweight until there is a deliberate migration to Tauri, Electron, WinUI 3, or another native shell.
7. Preserve the known-working tray behaviour unless replacing it with a tested equivalent.
8. Any feature that estimates cost, limits, or time-to-limit must label estimates clearly unless sourced from an official/local exact source.

## Known project context

The app has evolved through several prototypes:

- Earlier versions had a working system tray icon but incorrect usage data.
- A later attempt to switch tray implementation regressed the tray icon.
- The current useful direction is to keep the working tray approach and improve data collection, forecasting, and UI.
- A true Windows 11 widget beside the Weather widget is not the same as a tray icon or floating panel. It likely requires Windows App SDK, WinUI 3, MSIX packaging, and a Widget Provider extension. Treat this as a separate research/prototype track, not a quick patch.

## Safety and privacy rules

Never commit or print secrets. This includes:

- Anthropic/Claude credentials
- OpenAI API keys
- Gemini API keys
- Cursor tokens
- OAuth tokens
- local Claude Code credential files
- `.env` files
- local settings files containing private paths
- usage history databases
- token snapshot logs
- prompt or response content captured from the user
- debug logs containing usernames, project paths, repo names, or prompts

Before adding logs, ask: “Could this reveal the user’s private work?” If yes, redact it.

Logs should prefer:

- timestamps
- app state transitions
- provider availability status
- error category
- sanitized exception messages

Logs should avoid:

- full file paths when possible
- raw API responses
- raw statusline payloads if they contain prompt/project data
- auth headers
- credential filenames with full paths
- prompt text
- response text

## Data source policy

Allowed by default:

- Local Claude Code statusline data if configured by the user.
- Local app-generated usage snapshots.
- User-provided exported usage data.
- Publicly documented local logs/configs, provided they do not expose private prompt content unnecessarily.

Require explicit user approval:

- Any network calls to provider APIs.
- Any reading of provider credential files.
- Any migration that changes where data is stored.
- Any collection of per-prompt content or metadata beyond token deltas/timestamps.

Avoid:

- Scraping provider web dashboards.
- Polling undocumented OAuth endpoints.
- Browser automation against account pages.
- Sending local telemetry to third-party services.

## Engineering approach

Work in small, safe changes. Prefer one coherent task per commit.

For each task:

1. Inspect the current code first.
2. Identify the smallest safe implementation path.
3. Preserve existing working behaviour.
4. Add tests or lightweight validation where possible.
5. Update documentation when behaviour changes.
6. Avoid large rewrites unless specifically requested.

When uncertain, implement behind a feature flag or configuration option.

## Suggested architecture direction

The codebase should move toward these boundaries:

- `providers/`
  - Provider adapters such as Claude Code, Cursor, OpenAI Codex CLI, Gemini CLI.
- `usage/`
  - Internal usage data model, normalization, reset-window logic.
- `history/`
  - Local snapshot persistence and queries.
- `forecasting/`
  - Burn-rate calculations, velocity, time-to-limit projections.
- `alerts/`
  - Threshold checks, notification suppression, reset-aware alert state.
- `ui/`
  - Tray icon, floating widget, main app window, settings.
- `platform/windows/`
  - Windows-specific tray, toast, startup, theme, and future native integrations.
- `diagnostics/`
  - Sanitized logging, health checks, debug exports.
- `packaging/`
  - Build scripts, release packaging, installer configuration.

Do not force this structure in one large refactor. Move gradually as tasks require.

## Core usage model

Create and use a provider-neutral usage snapshot model with fields similar to:

- `provider_id`
- `provider_name`
- `source`
- `timestamp`
- `model_name`
- `input_tokens`
- `output_tokens`
- `cache_read_tokens`
- `cache_write_tokens`
- `total_tokens`
- `session_usage_percent`
- `weekly_usage_percent`
- `session_reset_at`
- `weekly_reset_at`
- `raw_limit_name`
- `is_estimate`
- `error_state`

Not all providers will supply every field. Missing values must be handled gracefully.

## Local history requirements

The app should store periodic snapshots locally for forecasting and graphs.

Requirements:

- Prefer SQLite or JSONL; choose based on existing project complexity.
- Store timestamps in UTC.
- Avoid storing prompt/response content.
- Support querying at least:
  - last 5 hours
  - last 24 hours
  - last 7 days
- Handle resets where usage percentage decreases.
- Handle missing/corrupt history gracefully.
- Provide a safe way to clear local history.

## Forecasting requirements

Forecasting should be conservative and clearly labelled.

Support:

- token velocity per minute
- token velocity per hour
- usage percent change per hour
- projected time until session limit
- projected time until weekly limit
- “not enough data yet” fallback

Handle:

- zero usage
- sparse data
- window reset
- provider unavailable
- percentage decrease after reset
- clock skew

Never present forecasts as official provider limits unless sourced from official/current provider data.

## Session timeline requirements

A session timeline may show token deltas and spikes, but must avoid private content.

Allowed:

- timestamp
- token delta
- percentage delta
- provider/model if available
- estimated interaction size

Avoid:

- prompt text
- response text
- project path
- file names unless explicitly user-enabled

## Cost estimation requirements

Cost estimates must be optional and labelled as approximate.

Requirements:

- Configurable pricing table.
- Provider/model-specific pricing where known.
- Graceful fallback for unknown models.
- Separate input/output/cache pricing if supported.
- Do not imply Claude Pro subscription usage maps directly to API billing.

## Alert requirements

Smart alerts should be useful but not noisy.

Defaults:

- Session warning at 80%.
- Session critical at 95%.
- Weekly warning at 80%.
- Weekly critical at 95%.

Rules:

- Suppress repeated notifications for the same threshold within the same reset window.
- Reset alert state when the relevant usage window resets.
- Make thresholds configurable.
- Allow alerts to be disabled.
- Log alert events without private data.

## UI requirements

The current product should support:

- system tray icon
- floating widget-style panel
- main app/settings window
- refresh animation
- clear Session and Weekly headings
- percentages from 0–100 where appropriate
- reset countdowns
- readable dark style

Future UI modes:

- Full mode: percentages, reset times, forecast, status.
- Compact mode: session and weekly percentages only.
- Minimal mode: one-line/icon status.

Visual style:

- dark/slate base
- restrained purple glow
- subtle animation
- clear hierarchy
- no distracting motion
- readable on Windows scaling settings
- dark/light adaptive theme where possible

## Windows integration policy

Lightweight track:

- tray icon
- floating always-on-top widget
- Windows toast notifications
- launch on startup
- packaged ZIP or installer

Native Windows track:

- WinUI 3
- Windows App SDK
- MSIX packaging
- Windows 11 Widget Provider extension

Do not mix these tracks accidentally. A true Windows Widgets board/taskbar widget should be treated as a separate prototype or native companion app.

## Multi-provider strategy

Add providers through adapters, not hardcoded UI branches.

Initial provider targets:

- Claude Code
- Cursor
- OpenAI Codex CLI
- Gemini CLI

Before implementing any provider adapter, investigate:

- supported local data sources
- official APIs
- credential risks
- whether usage data is exact or estimated
- whether prompt content might be exposed
- expected failure modes

Do not use unsupported scraping.

## Testing and validation

For each meaningful change, add one or more of:

- unit tests for pure logic
- fixture-based parser tests
- migration tests for local storage
- manual Windows validation checklist
- screenshot or UI smoke test where practical

Important test areas:

- usage reset detection
- forecasting with sparse data
- alert deduplication
- corrupt config/history files
- provider unavailable
- tray startup
- floating widget open/close
- refresh loop cancellation

Do not require real provider credentials in tests.

Use sanitized fixtures only.

## Error handling expectations

The app should fail visibly but safely.

Prefer:

- clear user-facing error states
- debug log entries with sanitized details
- fallback to last known good snapshot
- “provider unavailable” state
- no crash on missing files

Avoid:

- silent failures
- infinite retry loops
- blocking UI on provider reads
- unbounded log growth
- showing tracebacks in normal UI

## Configuration expectations

Settings should be easy to edit and safe by default.

Likely settings:

- refresh interval seconds
- widget mode
- theme mode
- alerts enabled
- alert thresholds
- low-refresh mode enabled
- normal refresh interval
- low-refresh interval
- launch at startup
- selected providers
- history retention days
- debug logging enabled

Do not store credentials in normal settings files.

## Packaging expectations

A Windows package should include:

- start script
- debug start script
- install/setup script if needed
- README
- changelog
- version number
- dependency notes
- troubleshooting section

Packaging should not include:

- local state
- logs
- credentials
- usage history
- virtual environment folders
- cache directories

## Documentation expectations

Keep documentation short but practical.

Update docs when adding:

- new settings
- provider adapters
- history storage
- alert behaviour
- packaging workflow
- native Windows prototype instructions

Include troubleshooting for:

- tray icon hidden under Windows `^` menu
- provider unavailable
- missing statusline data
- debug log location
- startup behaviour

## Coding style

Prefer simple, explicit code over clever abstractions.

Guidelines:

- Small functions.
- Typed data structures where reasonable.
- Clear module boundaries.
- No global mutable state unless necessary for UI framework integration.
- No broad `except Exception` without logging and safe fallback.
- No blocking file/network operations on the UI thread.
- No hardcoded user paths.
- Use `pathlib` for paths.
- Use UTC internally for timestamps.

## Dependency policy

Keep dependencies minimal.

Before adding a dependency, consider:

- Is it actively maintained?
- Is it needed for core functionality?
- Does it complicate packaging on Windows?
- Does it add native build requirements?
- Can the feature be implemented simply without it?

For charts/UI, lightweight is preferred until/unless migrating to Tauri/Electron.

## Performance expectations

The app runs beside development tools, so it should be quiet and efficient.

Requirements:

- Low CPU usage when idle.
- Refresh interval configurable.
- No tight polling loops.
- Back off when provider unavailable.
- Avoid unbounded memory growth.
- Prune or compact old history.
- Keep widget animations lightweight.

## Security review checklist for each task

Before finishing, check:

- Did I add any logging of private data?
- Did I read credential files unnecessarily?
- Did I add network calls?
- Did I create files that should be ignored by git?
- Did I store prompt/response content?
- Did I handle missing/corrupt files safely?
- Did I preserve existing tray/widget behaviour?

## Recommended first implementation sequence

1. Audit current architecture.
2. Create provider-neutral usage model.
3. Add local history storage.
4. Add burn-rate calculations.
5. Add time-to-limit forecast text.
6. Add alert thresholds.
7. Add toast notifications.
8. Add rolling 5-hour graph.
9. Add session timeline spike detection.
10. Add compact/minimal widget modes.
11. Add packaging reliability.
12. Investigate native Windows widget path separately.

## When reporting back

For each completed task, report:

- What changed.
- Files touched.
- How to run/test it.
- Any risks or follow-up tasks.
- Whether user data/privacy behaviour changed.

Be honest about limitations. Do not claim exact provider usage unless the data source is exact and documented.
