# Simple AI Usage Monitor

Lightweight Windows monitor for local AI coding-agent usage.

## What v6 changes

- Restores the working `pystray` system tray icon approach from earlier versions.
- Keeps the Claude Code statusline data reader from v5 where available.
- Removes OAuth/API polling.
- Adds a small floating desktop widget near the lower-left taskbar area.
- The floating widget shows Session and Weekly usage/reset countdowns.
- Adds floating widget display modes: Full, Compact, and Minimal.
- Adds dark/light theme support with a Windows-following system option.
- Adds a subtle purple glow and a non-provider-specific refresh logo.
- The widget logo animates smoothly and briefly whenever data refreshes.
- Shows clear loading, paused, and error states.
- Adds a Session Timeline section that flags large usage spikes from local history.
- Refresh interval defaults to 10 seconds and is configurable in Settings.

## Important limitation

This is not an official Windows Widgets Board widget. Windows 11 widgets that appear in the widgets board next to the weather/taskbar widget require a packaged Windows app/MSIX + Windows App SDK widget provider. This ZIP is intentionally a lightweight Python tray app.

## Install/run

### Tauri migration app

The cross-platform shell migration lives in `desktop/`.

Development run:

1. `cd desktop`
2. `npm install`
3. `npm run dev`

From the repo root you can also run `start_tauri.bat`.

The original Python app remains available during parity migration.

### Legacy Python app

1. Run `install.bat`
2. Run `install_statusline.bat`
3. Restart Claude Code or send one new Claude Code message so statusline data is written
4. Run `start.bat`

If something does not appear, run `debug_start.bat`.

Debug log:

`%APPDATA%\ClaudeCodeUsageTray\debug.log`

## Notes

- Tray icon may be hidden under the `^` hidden-icons menu.
- Double-click the floating widget to open the main app.
- The floating widget can be disabled in Settings.
- Widget display mode can be changed in Settings:
  - Full: session and weekly details, reset countdowns, and forecast text.
  - Compact: session and weekly percentages only.
  - Minimal: one combined status line.
- Theme can be changed in Settings:
  - System: follows the Windows app theme when available.
  - Dark: preserves the original dark widget and graph style.
  - Light: uses a high-contrast light palette.
- Session Timeline spike entries are estimates from local snapshots and do not include prompts, responses, file names, or project paths.
