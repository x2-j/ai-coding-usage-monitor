---
name: provider-adapter-expert
description: Expert workflow for implementing new provider adapters in the Simple AI Usage Monitor Tauri/Rust app. Use when adding, reviewing, or extending providers such as Claude Code, Codex CLI, Gemini CLI, Cursor, OpenAI tools, or any local AI usage source; includes privacy-safe parsing, provider registration, settings, tests, and documentation updates.
---

# Provider Adapter Expert

Use this skill to add a new provider adapter to Simple AI Usage Monitor without weakening the app's local-first privacy boundary.

## First Moves

1. Read `AGENTS.md`.
2. Read `PROVIDER_ADAPTERS.md`.
3. Inspect the current adapter code:
   - `desktop/src-tauri/src/providers.rs`
   - `desktop/src-tauri/src/models.rs`
   - `desktop/src-tauri/src/config.rs`
   - `desktop/src/types.ts`
   - `desktop/src/App.tsx`
4. Identify the provider's safe local data source before editing.

Do not start by adding UI. The backend adapter shape and privacy boundary come first.

## Provider Acceptance Rules

A provider is acceptable by default only if it uses one of these sources:

- Local statusline data configured by the user.
- Local app-generated snapshots.
- User-provided exports.
- Publicly documented local logs/configs that expose token counters without prompt content.

Require explicit user approval and feature gating for:

- Network calls.
- Credential-file reads.
- Provider API polling.
- Any source that could include prompt or response content.

Avoid:

- Browser dashboard scraping.
- Undocumented OAuth endpoints.
- Reading auth files.
- Sending local usage data to third-party services.

## Implementation Workflow

### 1. Define the Provider Contract

For the provider, decide:

- `provider_id`: stable snake_case id, never renamed after release.
- `provider_name`: vendor name.
- `display_label`: tool/integration name.
- `source`: safe data-source label.
- tracking default: enabled only for safe sources, opt-in for sensitive or broad local logs.

Use the shared structs from `desktop/src-tauri/src/models.rs`:

- `ProviderAvailability`
- `UsageSnapshot`
- `UsageTotals`
- `AppSettings`

### 2. Add Settings

Add provider settings only when needed.

Typical fields:

```rust
pub example_home: String,
pub example_tracking_enabled: bool,
```

Update all matching layers:

- `AppSettings` in `desktop/src-tauri/src/models.rs`
- `default_settings()` and `sanitize_settings()` in `desktop/src-tauri/src/config.rs`
- `desktop/src/types.ts`
- `desktop/src/App.tsx` if the user must see or edit the setting

Default opt-in providers to disabled.

### 3. Register Availability

In `desktop/src-tauri/src/providers.rs`:

- Add a `const PROVIDER_ID: &str`.
- Add a `*_availability` function.
- Add the provider to `provider_availability`.

Availability messages must be safe. Do not show full paths, file names from user workspaces, tokens, auth state, prompts, or response text.

### 4. Implement Collection

Add:

- `collect_provider_name(...) -> ProviderResult`
- `scan_provider_name_logs(...)`
- `usage_record_from_provider_name_json(...)` or equivalent parser

Register it in `collect_active_provider`.

Use `apply_estimates` when the provider supplies tokens but not exact rate-limit percentages.

### 5. Parse Safely

Only copy these kinds of fields into `UsageSnapshot`:

- timestamp
- model name
- provider name
- token counters
- usage percentages
- reset timestamps
- safe error state

Never copy prompt text, response text, tool output, raw request bodies, local workspace paths, credential filenames, or auth metadata.

For JSONL, prefer the existing scanner helpers:

- `collect_jsonl_records`
- `bucket_records`
- `find_first_value`
- `number`
- `parse_time`

Use stable request ids for deduplication when available. If not available, use the existing hashed path/line fallback, not full paths.

### 6. Add UI Only After Backend Works

The frontend should call Tauri commands and render sanitized state. It must not scan provider files directly.

For opt-in tracking:

- Add a visible provider row.
- Add an enable button.
- Add a Tauri command or extend an existing command to update settings.

### 7. Test

Add Rust tests with synthetic fixtures for:

- availability when source is missing
- availability when tracking is disabled
- parser accepts a minimal token record
- parser rejects records with no token counters
- malformed JSONL lines are skipped
- totals bucket into `session`, `today`, `week`, `all`
- no prompt/response/tool-output fields reach `UsageSnapshot`

Then run:

```bat
cd desktop\src-tauri
cargo test
cargo check
```

If frontend settings or provider UI changed, also run:

```bat
cd desktop
npm run check
```

## Documentation Updates

Update docs when behavior changes:

- `README.md` only for high-level provider support.
- `PROVIDER_ADAPTERS.md` for adapter patterns, accepted formats, and new conventions.
- Provider-specific docs only when setup is non-obvious.

Keep docs generic. Avoid version-specific "what changed" sections.

## Security Review Before Finishing

Check:

- No secrets are printed or logged.
- No credential files are read.
- No network calls were added without explicit approval.
- No prompt/response/tool content is stored.
- No full local paths appear in normal UI or logs.
- Missing/corrupt provider files fail safely.
- Existing Claude and Codex behavior still works.

## Report Back

In the final response, include:

- Provider added.
- Local source used.
- Files touched.
- Tests/checks run.
- Privacy behavior and whether it changed.
- Any limitations, especially estimate vs exact usage.
