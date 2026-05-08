# Claude Code Usage Tray v6

Lightweight Windows monitor for Claude Code usage.

## What v6 changes

- Restores the working `pystray` system tray icon approach from earlier versions.
- Keeps the Claude Code statusline data reader from v5 where available.
- Removes OAuth/API polling.
- Adds a small floating desktop widget near the lower-left taskbar area.
- The floating widget shows Session and Weekly usage/reset countdowns.
- The widget logo animates briefly whenever data refreshes.
- Refresh interval defaults to 10 seconds and is configurable in Settings.

## Important limitation

This is not an official Windows Widgets Board widget. Windows 11 widgets that appear in the widgets board next to the weather/taskbar widget require a packaged Windows app/MSIX + Windows App SDK widget provider. This ZIP is intentionally a lightweight Python tray app.

## Install/run

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
