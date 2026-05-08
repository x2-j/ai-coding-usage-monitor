# Adding a Provider Adapter

This guide explains how to add a new provider to the Tauri app. The current implementation is intentionally simple: providers are registered in Rust functions inside `desktop/src-tauri/src/providers.rs`, and they all normalize into shared structs from `desktop/src-tauri/src/models.rs`.

The goal is not to mirror every provider's native schema. The goal is to safely extract local usage counters and normalize them into a privacy-preserving shape the UI can render.

## Adapter Contract

Every provider should answer three questions:

1. Is there a safe local data source?
2. What is the latest usage snapshot?
3. What are the token totals for useful time windows?

Those answers map to these types.

### `ProviderAvailability`

```rust
pub struct ProviderAvailability {
    pub provider_id: String,
    pub provider_name: String,
    pub display_label: String,
    pub available: bool,
    pub source: String,
    pub message: Option<String>,
    pub has_data: bool,
    pub tracking_enabled: bool,
}
```

Use this for provider discovery and provider-list UI.

Field notes:

| Field | Format | Meaning |
|---|---|---|
| `provider_id` | stable snake_case id | Internal id, for example `claude_code`, `openai_codex_cli`, `gemini_cli`. |
| `provider_name` | display vendor name | Vendor or provider, for example `Anthropic`, `OpenAI`, `Google`. |
| `display_label` | user-facing integration name | Specific tool name, for example `Claude Code`. |
| `available` | boolean | The tool/source exists locally. |
| `source` | short label | Data source label shown to the user. |
| `message` | optional sentence | Safe status detail. Do not include private paths. |
| `has_data` | boolean | True only when usable local usage data exists. |
| `tracking_enabled` | boolean | False for opt-in providers until enabled. |

### `UsageSnapshot`

```rust
pub struct UsageSnapshot {
    pub provider_id: String,
    pub provider_name: String,
    pub source: String,
    pub timestamp_utc: String,
    pub model_name: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub total_tokens: i64,
    pub session_usage_percent: Option<f64>,
    pub weekly_usage_percent: Option<f64>,
    pub session_reset_at: Option<String>,
    pub weekly_reset_at: Option<String>,
    pub raw_limit_name: Option<String>,
    pub is_estimate: bool,
    pub error_state: Option<String>,
}
```

Use UTC ISO-8601 strings for `timestamp_utc`, `session_reset_at`, and `weekly_reset_at`.

Use `None` when a provider does not supply a field. Missing usage percentages are allowed; `apply_estimates` can derive local fallback percentages from configured token budgets.

### `UsageTotals`

```rust
pub struct UsageTotals {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub requests: i64,
    pub visible_tokens: i64,
    pub total_tokens: i64,
}
```

Providers return a `BTreeMap<String, UsageTotals>` with these keys:

| Key | Meaning |
|---|---|
| `session` | Current rolling session window, controlled by `settings.session_hours`. |
| `today` | Local calendar day. |
| `week` | Current local week. |
| `all` | All parsed local records. |

Use `empty_totals_map()` to create the required keys.

## Supported Local Formats

Adapters should prefer structured local sources and avoid fragile scraping.

### JSONL Usage Records

JSONL is the easiest format to support. Each line should be independently parseable JSON.

Minimal supported record:

```json
{
  "timestamp": "2026-05-08T15:30:00Z",
  "model": "example-model",
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 420,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  }
}
```

Useful id fields for deduplication:

```json
{
  "request_id": "req_123",
  "timestamp": "2026-05-08T15:30:00Z",
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 420
  }
}
```

The current scanner recognizes these id keys:

```text
requestId, request_id, response_id, message_id, uuid, id
```

If none exists, the scanner falls back to a path hash and line number. That avoids storing full paths.

### Statusline-Like Snapshot

If a provider can emit a latest local snapshot, normalize it to:

```json
{
  "captured_at": "2026-05-08T15:30:00Z",
  "provider": "Example",
  "model": "example-model",
  "timestamp": "2026-05-08T15:30:00Z",
  "rate_limits": {
    "session": {
      "used_percentage": 42.5,
      "reset_at": "2026-05-08T20:00:00Z"
    },
    "weekly": {
      "used_percentage": 64.2,
      "reset_at": "2026-05-12T00:00:00Z"
    }
  },
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 420,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  }
}
```

Accepted percentage aliases:

```text
used_percentage, utilization
```

Accepted reset aliases:

```text
reset_at, resets_at
```

Percentages may be `0..100` or fractional `0..1`. Fractional values are normalized to `0..100`.

## Implementation Steps

### 1. Add Settings

Add provider-specific configuration to `AppSettings` in `desktop/src-tauri/src/models.rs` if needed.

Examples:

```rust
pub example_home: String,
pub example_tracking_enabled: bool,
```

Then update:

- `default_settings()` in `desktop/src-tauri/src/config.rs`
- `sanitize_settings()` if the setting needs validation
- `settings_from_legacy_json()` only if importing old Python config is relevant
- `desktop/src/types.ts`
- `desktop/src/App.tsx` settings UI, if the user should edit it

For providers that may expose sensitive local files, default tracking to `false`.

### 2. Add Provider Constants

In `desktop/src-tauri/src/providers.rs`, add a stable id:

```rust
const EXAMPLE_ID: &str = "example_cli";
```

Use snake_case and never change it once snapshots may exist in SQLite.

### 3. Register Availability

Add the provider to `provider_availability`:

```rust
pub fn provider_availability(settings: &AppSettings, data_dir: &Path) -> Vec<ProviderAvailability> {
    vec![
        claude_availability(settings, data_dir),
        codex_availability(settings),
        example_availability(settings),
    ]
}
```

Then implement a safe availability check:

```rust
fn example_availability(settings: &AppSettings) -> ProviderAvailability {
    let root = Path::new(&settings.example_home).join("sessions");
    let has_records = settings.example_tracking_enabled && has_jsonl_files(&root);

    ProviderAvailability {
        provider_id: EXAMPLE_ID.to_string(),
        provider_name: "Example".to_string(),
        display_label: "Example CLI".to_string(),
        available: root.exists(),
        source: "Example CLI local sessions".to_string(),
        message: Some(if has_records {
            "Local token usage records found.".to_string()
        } else if settings.example_tracking_enabled {
            "Tracking enabled, but no local usage records found yet.".to_string()
        } else {
            "Example CLI detected, but local tracking is disabled.".to_string()
        }),
        has_data: has_records,
        tracking_enabled: settings.example_tracking_enabled,
    }
}
```

Do not include full local paths in `message`.

### 4. Register Collection

Update `collect_active_provider`:

```rust
match selected.provider_id.as_str() {
    CODEX_ID => Some(collect_codex(settings)),
    EXAMPLE_ID => Some(collect_example(settings)),
    _ => Some(collect_claude(settings, data_dir)),
}
```

Then implement:

```rust
pub fn collect_example(settings: &AppSettings) -> ProviderResult {
    let (latest, totals) = scan_example_logs(settings);
    let mut snapshot = latest.unwrap_or_else(|| {
        UsageSnapshot::error(EXAMPLE_ID, "Example", "No Example token usage records found.".to_string())
    });
    apply_estimates(&mut snapshot, &totals, settings);
    ProviderResult { snapshot, totals }
}
```

### 5. Parse Local Records

For JSONL sources, use the existing scanner:

```rust
fn scan_example_logs(settings: &AppSettings) -> (Option<UsageSnapshot>, BTreeMap<String, UsageTotals>) {
    let root = Path::new(&settings.example_home).join("sessions");
    let records = collect_jsonl_records(&root, "Example", EXAMPLE_ID, usage_record_from_example_json);
    let latest = records.values().max_by_key(|rec| rec.timestamp_utc.clone()).cloned();
    (latest, bucket_records(records.into_values(), settings))
}
```

Parser template:

```rust
fn usage_record_from_example_json(
    value: &Value,
    provider_name: &str,
    provider_id: &str,
    fallback: i64,
) -> Option<UsageSnapshot> {
    let usage = value.get("usage")?;
    let input = number(usage.get("input_tokens"));
    let output = number(usage.get("output_tokens"));
    let cache_read = number(usage.get("cache_read_input_tokens"));
    let cache_write = number(usage.get("cache_creation_input_tokens"));

    if input <= 0 && output <= 0 && cache_read <= 0 && cache_write <= 0 {
        return None;
    }

    Some(UsageSnapshot {
        provider_id: provider_id.to_string(),
        provider_name: provider_name.to_string(),
        source: "Example CLI local sessions".to_string(),
        timestamp_utc: parse_time(value.get("timestamp")).unwrap_or_else(|| timestamp_from_epoch(fallback)),
        model_name: value.get("model").and_then(Value::as_str).map(ToString::to_string),
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        total_tokens: input + output + cache_read + cache_write,
        session_usage_percent: None,
        weekly_usage_percent: None,
        session_reset_at: None,
        weekly_reset_at: None,
        raw_limit_name: None,
        is_estimate: true,
        error_state: None,
    })
}
```

If a provider supplies exact percentages or reset times, set those fields and use `is_estimate: false` for that part of the snapshot.

Do not convert raw token totals into provider subscription usage percentages unless the provider has a documented token budget for that exact limit window. For example, Codex CLI local token counters are useful for velocity and history, but they are not exact ChatGPT/Codex plan usage percentages.

### 6. Add UI Controls

For providers that are opt-in, add a button similar to Codex in `desktop/src/App.tsx`.

The frontend should call a Tauri command that updates settings. It should not scan provider files directly.

### 7. Add Tests

Add Rust tests for:

- availability when the provider path is missing
- parser accepts sanitized fixture records
- parser rejects records with no token counters
- deduplication uses id fields when available
- totals bucket into `session`, `today`, `week`, and `all`
- malformed JSONL lines are skipped safely
- no prompt/response/tool-output fields are copied into `UsageSnapshot`

Use fixtures that contain only synthetic data.

## Privacy Checklist

Before opening a provider PR, verify:

- No credential files are read.
- No provider auth files are probed.
- No prompt text is parsed, stored, logged, or sent to the frontend.
- No response text is parsed, stored, logged, or sent to the frontend.
- No tool output is parsed, stored, logged, or sent to the frontend.
- Logs contain only provider status, sanitized error categories, and safe filenames.
- Full local paths are not displayed in UI messages.
- Network calls are not added unless explicitly approved and feature-gated.
- The provider clearly marks estimates as estimates.

## Naming And Source Labels

Recommended conventions:

| Item | Format | Example |
|---|---|---|
| Provider id | snake_case | `gemini_cli` |
| Provider name | Vendor | `Google` |
| Display label | Tool | `Gemini CLI` |
| Source label | Data source | `Gemini CLI local sessions` |
| Error text | Safe user status | `Tracking enabled, but no local usage records found yet.` |

## Current Providers

| Provider id | Display label | Data source | Tracking |
|---|---|---|---|
| `claude_code` | Claude Code | statusline, local JSONL fallback | enabled by default |
| `openai_codex_cli` | OpenAI Codex CLI | local session JSONL | opt-in |

Use these as reference implementations when adding the next provider.
