export type WidgetMode = "full" | "compact" | "minimal";
export type ThemeMode = "system" | "dark" | "light";

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  requests: number;
  visible_tokens: number;
  total_tokens: number;
}

export interface UsageSnapshot {
  provider_id: string;
  provider_name: string;
  source: string;
  timestamp_utc: string;
  model_name: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  session_usage_percent: number | null;
  weekly_usage_percent: number | null;
  session_reset_at: string | null;
  weekly_reset_at: string | null;
  raw_limit_name: string | null;
  is_estimate: boolean;
  error_state: string | null;
}

export interface ProviderAvailability {
  provider_id: string;
  provider_name: string;
  display_label: string;
  available: boolean;
  source: string;
  message: string | null;
  has_data: boolean;
  tracking_enabled: boolean;
}

export interface BurnRateProjection {
  rate_per_minute: number | null;
  rate_per_hour: number | null;
  pct_per_hour: number | null;
  minutes_until_limit: number | null;
  reason: string | null;
}

export interface UsageSpike {
  timestamp_utc: string;
  token_increase: number;
  input_increase: number | null;
  output_increase: number | null;
  pct_increase: number | null;
}

export interface AppSettings {
  claude_log_dir: string;
  codex_home: string;
  codex_tracking_enabled: boolean;
  selected_provider_id: string;
  refresh_seconds: number;
  session_hours: number;
  session_budget_tokens: number;
  weekly_budget_tokens: number;
  include_cache_tokens: boolean;
  start_minimized: boolean;
  show_desktop_widget: boolean;
  widget_display_mode: WidgetMode;
  theme_mode: ThemeMode;
  usage_source: string;
  history_retention_days: number;
  alerts_enabled: boolean;
  session_warning_threshold: number;
  session_critical_threshold: number;
  weekly_warning_threshold: number;
  weekly_critical_threshold: number;
}

export interface ChartPoint {
  provider_id: string;
  provider_name: string;
  timestamp_utc: string;
  session_usage_percent: number | null;
  weekly_usage_percent: number | null;
  session_tokens: number;
  input_tokens: number;
  output_tokens: number;
}

export interface ProviderUsage {
  provider_id: string;
  display_label: string;
  snapshot: UsageSnapshot;
  totals: Record<string, UsageTotals>;
  burn: {
    session: BurnRateProjection;
    week: BurnRateProjection;
  };
  spikes: UsageSpike[];
}

export interface MonitorState {
  settings: AppSettings;
  active_provider_id: string | null;
  providers: ProviderAvailability[];
  provider_usages: ProviderUsage[];
  latest_snapshot: UsageSnapshot | null;
  totals: Record<string, UsageTotals>;
  burn: {
    session: BurnRateProjection;
    week: BurnRateProjection;
  };
  spikes: UsageSpike[];
  history: ChartPoint[];
  app_state: "loading" | "ready" | "paused" | "error";
  status_message: string;
  imported_legacy: boolean;
}
