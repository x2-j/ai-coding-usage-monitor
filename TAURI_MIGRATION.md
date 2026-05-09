# Tauri + React Migration

This repository now contains an isolated Tauri 2 migration app in `desktop/`.
The current Python tray app remains available during parity work.

## Run the migration app

```bat
start_tauri.bat
```

or:

```bat
cd desktop
npm install
npm run dev
```

`start_tauri.bat` runs the same development command from the repo root.

## Build the Windows installer

```bat
cd desktop
npm run build
```

The build script compiles and stages the `statusline_capture` sidecar before
running the Tauri NSIS bundle.

## Build on Ubuntu/Debian

Install the native Tauri/WebKit dependencies before running the build:

```bash
sudo apt install build-essential pkg-config libdbus-1-dev libglib2.0-dev libcairo2-dev libpango1.0-dev libgtk-3-dev libsoup-3.0-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
```

Then run:

```bash
cd desktop
npm install
npm run build
```

The current Tauri config targets the Windows NSIS bundle. To create Ubuntu/Debian artifacts, add a Linux target such as `deb` or `appimage` to `desktop/src-tauri/tauri.conf.json` before building on Linux.

## Privacy boundary

The React frontend only renders sanitized state returned by Tauri commands.
The Rust backend owns local filesystem reads, provider parsing, history storage,
forecasting, and settings validation.

The statusline sidecar writes sanitized statusline data to the app data folder.
It does not store prompts, responses, tool output, auth data, or workspace paths.

## Legacy Python app

The Python app is still started by `start.bat` and `debug_start.bat`.
On first Tauri launch, compatible settings/history are imported from:

`%APPDATA%\ClaudeCodeUsageTray`

Old files are preserved for rollback.
