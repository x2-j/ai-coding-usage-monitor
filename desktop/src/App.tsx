import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import {
  calibrateClaudeSession,
  enableCodexTracking,
  getMonitorState,
  openUsagePage,
  refreshUsage,
  saveSettings,
  setupStatusline
} from "./api";
import { installTray, showWindow } from "./tray";
import type { AppSettings, MonitorState, ProviderUsage, UsageTotals } from "./types";

const chartColors = ["#ffd97a", "#8bd3ff", "#ac84ff", "#70e0ad"];
const tooltipStyle = {
  backgroundColor: "#202124",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  color: "#f4f4f4"
};
const tooltipLabelStyle = { color: "#f4f4f4" };

const emptyTotals: UsageTotals = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  requests: 0,
  visible_tokens: 0,
  total_tokens: 0
};

type UsageTrendKind = "up" | "reset";
type UsageTrend = {
  kind: UsageTrendKind;
  severity: "normal" | "warning" | "critical";
};
type UsageTrendMap = Record<string, { session?: UsageTrend; weekly?: UsageTrend }>;

function fmt(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  return Math.round(n).toLocaleString();
}

function pct(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  return `${n.toFixed(1)}%`;
}

function limitValue(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return "No exact data";
  return `${n.toFixed(1)}%`;
}

function resetLabel(iso: string | null | undefined, value: number | null | undefined, isEstimate?: boolean) {
  if (value === null || value === undefined || Number.isNaN(value)) return "Limit source unavailable";
  if (isEstimate && !iso) return "Local fallback estimate";
  return `Reset ${countdown(iso)}`;
}

function countdown(iso: string | null | undefined) {
  if (!iso) return "unknown";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "unknown";
  const minutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours > 0 ? `${hours}h ${mins.toString().padStart(2, "0")}m` : `${mins}m`;
}

function duration(minutes: number | null | undefined, reason?: string | null) {
  if (minutes === null || minutes === undefined) return reason || "n/a";
  const rounded = Math.max(0, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return hours > 0 ? `${hours}h ${mins.toString().padStart(2, "0")}m` : `${mins}m`;
}

function timeLabel(value: string) {
  const date = new Date(value);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function startWindowDrag() {
  getCurrentWindow().startDragging().catch(() => undefined);
}

function chartKey(providerId: string, metric: string) {
  return `${providerId.replace(/[^a-zA-Z0-9_]/g, "_")}_${metric}`;
}

function trendSeverity(value: number | null | undefined): UsageTrend["severity"] {
  if (value !== null && value !== undefined && !Number.isNaN(value) && value > 90) return "critical";
  if (value !== null && value !== undefined && !Number.isNaN(value) && value > 80) return "warning";
  return "normal";
}

function compareUsageValue(previous: number | null | undefined, next: number | null | undefined): UsageTrend | undefined {
  if (previous === null || previous === undefined || Number.isNaN(previous) || next === null || next === undefined || Number.isNaN(next)) {
    return undefined;
  }
  if (next > previous) return { kind: "up", severity: trendSeverity(next) };
  if (next < previous) return { kind: "reset", severity: "normal" };
  return undefined;
}

function usageTrends(previous: MonitorState | null, next: MonitorState): UsageTrendMap {
  if (!previous) return {};
  const previousByProvider = new Map(previous.provider_usages.map((usage) => [usage.provider_id, usage]));
  return Object.fromEntries(next.provider_usages.map((usage) => {
    const prior = previousByProvider.get(usage.provider_id);
    return [usage.provider_id, {
      session: compareUsageValue(prior?.snapshot.session_usage_percent, usage.snapshot.session_usage_percent),
      weekly: compareUsageValue(prior?.snapshot.weekly_usage_percent, usage.snapshot.weekly_usage_percent)
    }];
  }));
}

function TrendIcon({ trend }: { trend?: UsageTrend }) {
  if (!trend) return null;
  const label = trend.kind === "up" ? "Usage increased on last refresh" : "Usage reset or decreased on last refresh";
  return (
    <span className={`trend-icon ${trend.kind} ${trend.severity}`} title={label} aria-label={label}>
      {trend.kind === "up" ? <ArrowUpIcon /> : <ResetArrowIcon />}
    </span>
  );
}

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 16V4" />
      <path d="M5 9l5-5 5 5" />
    </svg>
  );
}

function ResetArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M15.7 8.5a6 6 0 1 0 1 5" />
      <path d="M15.7 8.5h-4.4" />
      <path d="M15.7 8.5V4.1" />
    </svg>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg className={`chevron-icon ${expanded ? "expanded" : ""}`} viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7 4l6 6-6 6" />
    </svg>
  );
}

function MiniIcon({ kind }: { kind: "clock" | "bolt" | "gauge" | "tokens" | "cache" | "requests" | "provider" }) {
  return <span className={`mini-icon ${kind}`} aria-hidden="true" />;
}

export default function App() {
  const [state, setState] = useState<MonitorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowLabel, setWindowLabel] = useState("main");
  const [saving, setSaving] = useState(false);
  const [hiddenProviders, setHiddenProviders] = useState<Set<string>>(() => new Set());
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(() => new Set());
  const [trends, setTrends] = useState<UsageTrendMap>({});
  const stateRef = useRef<MonitorState | null>(null);

  function applyMonitorState(next: MonitorState) {
    setTrends(usageTrends(stateRef.current, next));
    stateRef.current = next;
    setState(next);
  }

  useEffect(() => {
    try {
      setWindowLabel(getCurrentWindow().label);
    } catch {
      setWindowLabel("main");
    }
    installTray().catch(() => undefined);
    getMonitorState().then(applyMonitorState).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!state) return;
    const ms = Math.max(1, state.settings.refresh_seconds) * 1000;
    const id = window.setInterval(() => {
      refreshUsage().then(applyMonitorState).catch((e) => setError(String(e)));
    }, ms);
    return () => window.clearInterval(id);
  }, [state?.settings.refresh_seconds]);

  const providerSeries = useMemo(() => {
    const labels = new Map<string, string>();
    for (const provider of state?.providers || []) {
      labels.set(provider.provider_id, provider.display_label);
    }
    for (const point of state?.history || []) {
      if (!labels.has(point.provider_id)) {
        labels.set(point.provider_id, point.provider_name || point.provider_id);
      }
    }
    return Array.from(labels, ([providerId, label], index) => ({
      providerId,
      label,
      color: chartColors[index % chartColors.length],
      usageKey: chartKey(providerId, "session_usage_percent"),
      weeklyKey: chartKey(providerId, "weekly_usage_percent"),
      tokenKey: chartKey(providerId, "session_tokens")
    })).filter((series) => (state?.history || []).some((point) => point.provider_id === series.providerId));
  }, [state]);

  const visibleProviderSeries = useMemo(
    () => providerSeries.filter((series) => !hiddenProviders.has(series.providerId)),
    [providerSeries, hiddenProviders]
  );

  const chartData = useMemo(() => {
    const rows = new Map<string, Record<string, number | string | null>>();
    for (const point of state?.history || []) {
      const key = point.timestamp_utc;
      const row = rows.get(key) || {
        timestamp_utc: point.timestamp_utc,
        label: timeLabel(point.timestamp_utc)
      };
      row[chartKey(point.provider_id, "session_usage_percent")] = point.session_usage_percent;
      row[chartKey(point.provider_id, "weekly_usage_percent")] = point.weekly_usage_percent;
      row[chartKey(point.provider_id, "session_tokens")] = point.session_tokens;
      rows.set(key, row);
    }
    return Array.from(rows.values()).sort((a, b) => String(a.timestamp_utc).localeCompare(String(b.timestamp_utc)));
  }, [state]);

  if (!state) {
    return (
      <main className="shell">
        <p className="status">{error ? "Could not load usage data." : "Loading usage data..."}</p>
        {error && <section className="notice error">{error}</section>}
      </main>
    );
  }

  if (windowLabel === "widget") {
    return <WidgetView state={state} trends={trends} onOpen={() => showWindow("main")} />;
  }

  async function updateSettings(next: AppSettings) {
    setSaving(true);
    try {
      const updated = await saveSettings(next);
      applyMonitorState(updated);
    } finally {
      setSaving(false);
    }
  }

  async function calibrateSession(percent: number) {
    setSaving(true);
    try {
      const updated = await calibrateClaudeSession(percent);
      setError(`Claude session calibrated at ${percent.toFixed(1)}%.`);
      applyMonitorState(updated);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Simple AI Usage Monitor</h1>
          <p>Local-first AI coding-agent usage telemetry with tray and floating widget views.</p>
        </div>
        <div className={`pill ${state.app_state}`}>{state.status_message}</div>
      </header>

      <section className="toolbar">
        <button onClick={() => refreshUsage().then(applyMonitorState)}>Refresh</button>
        <button onClick={() => showWindow("widget")}>Show Widget</button>
        <button onClick={() => openUsagePage()}>Open Usage Page</button>
        <button onClick={() => setupStatusline().then((message) => setError(message))}>Install Statusline</button>
      </section>

      {state.app_state === "paused" && <section className="notice">No provider usage data found yet. Providers without local usage data are hidden.</section>}
      {error && <section className="notice error">{error}</section>}

      <section className="panel">
        <h2>Rolling 5-hour graphs</h2>
        <div className="chart-legend">
          {providerSeries.map((series) => (
            <button
              className={hiddenProviders.has(series.providerId) ? "is-hidden" : ""}
              key={series.providerId}
              onClick={() => setHiddenProviders((current) => {
                const next = new Set(current);
                if (next.has(series.providerId)) {
                  next.delete(series.providerId);
                } else {
                  next.add(series.providerId);
                }
                return next;
              })}
              style={{ "--series-color": series.color } as React.CSSProperties}
              type="button"
            >
              {series.label}
            </button>
          ))}
        </div>
        <div className="charts">
          <Chart title="Usage %" data={chartData}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" />
              <XAxis dataKey="label" stroke="var(--muted)" />
              <YAxis stroke="var(--muted)" domain={[0, 100]} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={tooltipLabelStyle} />
              {visibleProviderSeries.map((series) => (
                <Line
                  key={series.usageKey}
                  name={`${series.label} session`}
                  type="monotone"
                  dataKey={series.usageKey}
                  stroke={series.color}
                  dot={chartData.length < 2}
                  connectNulls
                />
              ))}
              {visibleProviderSeries.map((series) => (
                <Line
                  key={series.weeklyKey}
                  name={`${series.label} weekly`}
                  type="monotone"
                  dataKey={series.weeklyKey}
                  stroke={series.color}
                  strokeDasharray="4 4"
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </Chart>
          <Chart title="Session Tokens" data={chartData}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" />
              <XAxis dataKey="label" stroke="var(--muted)" />
              <YAxis stroke="var(--muted)" />
              <Tooltip contentStyle={tooltipStyle} labelStyle={tooltipLabelStyle} />
              {visibleProviderSeries.map((series) => (
                <Line
                  key={series.tokenKey}
                  name={`${series.label} tokens`}
                  type="monotone"
                  dataKey={series.tokenKey}
                  stroke={series.color}
                  dot={chartData.length < 2}
                  connectNulls
                />
              ))}
            </LineChart>
          </Chart>
        </div>
      </section>

      <section className="provider-usage-stack">
        {state.provider_usages.length === 0 ? (
          <section className="panel">No provider usage data found yet.</section>
        ) : (
          state.provider_usages.map((usage) => (
            <ProviderUsagePanel
              collapsed={collapsedProviders.has(usage.provider_id)}
              key={usage.provider_id}
              onToggle={() => setCollapsedProviders((current) => {
                const next = new Set(current);
                if (next.has(usage.provider_id)) {
                  next.delete(usage.provider_id);
                } else {
                  next.add(usage.provider_id);
                }
                return next;
              })}
              usage={usage}
              trends={trends[usage.provider_id]}
              calibration={state.settings}
              saving={saving}
              onCalibrate={calibrateSession}
            />
          ))
        )}
      </section>

      <section className="grid two">
        <ProvidersPanel state={state} onEnableCodex={() => enableCodexTracking().then(applyMonitorState)} />
        <SettingsPanel state={state} saving={saving} onSave={updateSettings} />
      </section>
    </main>
  );
}

function WidgetView({ state, trends, onOpen }: { state: MonitorState; trends: UsageTrendMap; onOpen: () => void }) {
  const mode = state.settings.widget_display_mode;
  useEffect(() => {
    const providerCount = Math.max(1, state.provider_usages.length);
    const size = mode === "minimal"
      ? new LogicalSize(300, 58)
      : mode === "compact"
        ? new LogicalSize(300, 72 + providerCount * 56)
        : new LogicalSize(340, 96 + providerCount * 76);
    getCurrentWindow().setSize(size).catch(() => undefined);
  }, [mode, state.provider_usages.length]);
  return (
    <main className={`widget ${mode}`} onDoubleClick={onOpen}>
      <div className="widget-head" data-tauri-drag-region onMouseDown={startWindowDrag} title="Drag to move">
        <span className="logo-dot" />
        <strong>AI Usage</strong>
      </div>
      {mode === "minimal" ? (
        <p>{state.provider_usages.map((usage) => `${usage.display_label}: ${limitValue(usage.snapshot.session_usage_percent)}`).join(" | ") || "No data"}</p>
      ) : (
        <>
          {state.provider_usages.map((usage) => (
            <WidgetProviderRows key={usage.provider_id} trends={trends[usage.provider_id]} usage={usage} />
          ))}
          {state.provider_usages.length === 0 && <small>No provider data.</small>}
          {mode === "full" && <small>{state.status_message}</small>}
        </>
      )}
    </main>
  );
}

function WidgetProviderRows({ usage, trends }: { usage: ProviderUsage; trends?: UsageTrendMap[string] }) {
  const snapshot = usage.snapshot;
  return (
    <div className="widget-provider">
      <strong>{usage.display_label}</strong>
      <WidgetRow label="Session" trend={trends?.session} value={limitValue(snapshot.session_usage_percent)} reset={snapshot.session_usage_percent == null ? "no limit data" : snapshot.is_estimate && !snapshot.session_reset_at ? "local estimate" : countdown(snapshot.session_reset_at)} />
      <WidgetRow label="Weekly" trend={trends?.weekly} value={limitValue(snapshot.weekly_usage_percent)} reset={snapshot.weekly_usage_percent == null ? "no limit data" : snapshot.is_estimate && !snapshot.weekly_reset_at ? "local estimate" : countdown(snapshot.weekly_reset_at)} />
    </div>
  );
}

function WidgetRow({ label, value, reset, trend }: { label: string; value: string; reset: string; trend?: UsageTrend }) {
  return <div className="widget-row"><span>{label}</span><strong><TrendIcon trend={trend} />{value}</strong><em>{reset}</em></div>;
}

function MetricCard({ title, value, sub, trend }: { title: string; value: string; sub: string; trend?: UsageTrend }) {
  return (
    <section className="metric">
      <span><MiniIcon kind="gauge" />{title}</span>
      <strong><TrendIcon trend={trend} /><span className="value-chip primary">{value}</span></strong>
      <small><MiniIcon kind="clock" />{sub}</small>
    </section>
  );
}

function StatChip({ label, value, icon }: { label: string; value: string; icon?: "bolt" | "tokens" | "cache" | "requests" | "clock" | "gauge" }) {
  return (
    <span className="stat-chip">
      {icon && <MiniIcon kind={icon} />}
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function TotalsCard({ title, totals }: { title: string; totals: UsageTotals }) {
  return (
    <section className="panel">
      <h2>{title} Token Totals</h2>
      <p className="big"><span className="value-chip">{fmt(totals.visible_tokens)}</span> visible tokens</p>
      <div className="chip-row">
        <StatChip icon="tokens" label="Input" value={fmt(totals.input_tokens)} />
        <StatChip icon="tokens" label="Output" value={fmt(totals.output_tokens)} />
        <StatChip icon="cache" label="Cache" value={fmt(totals.cache_read_tokens + totals.cache_write_tokens)} />
        <StatChip icon="requests" label="Requests" value={fmt(totals.requests)} />
      </div>
    </section>
  );
}

function ProviderUsagePanel({ collapsed, onToggle, usage, trends, calibration, saving, onCalibrate }: { collapsed: boolean; onToggle: () => void; usage: ProviderUsage; trends?: UsageTrendMap[string]; calibration: AppSettings; saving: boolean; onCalibrate: (percent: number) => void }) {
  const snapshot = usage.snapshot;
  const session = usage.totals.session || emptyTotals;
  const week = usage.totals.week || emptyTotals;
  const [calibrationPercent, setCalibrationPercent] = useState("");
  const knownCalibration = calibration.claude_session_calibration_percent;
  return (
    <section className="panel provider-usage">
      <div className="provider-title">
        <div>
          <h2>{usage.display_label}</h2>
          <p className="muted">
            <span className="source-chip"><MiniIcon kind="provider" />{snapshot.is_estimate ? "Local fallback estimate" : "Provider statusline"}</span>
            <span className="source-chip">Source: {snapshot.source}</span>
            {snapshot.model_name && <span className="source-chip">Model: {snapshot.model_name}</span>}
          </p>
        </div>
        <button className="icon-toggle" onClick={onToggle} type="button" title={collapsed ? "Show provider details" : "Hide provider details"} aria-label={collapsed ? "Show provider details" : "Hide provider details"}>
          <ChevronIcon expanded={!collapsed} />
        </button>
        {snapshot.error_state && <span className="error">{snapshot.error_state}</span>}
      </div>
      {!collapsed && (
        <>
      {snapshot.raw_limit_name && <p className="muted">{snapshot.raw_limit_name}</p>}
      <div className="grid two">
        <MetricCard title="Session" trend={trends?.session} value={limitValue(snapshot.session_usage_percent)} sub={resetLabel(snapshot.session_reset_at, snapshot.session_usage_percent, snapshot.is_estimate)} />
        <MetricCard title="Weekly" trend={trends?.weekly} value={limitValue(snapshot.weekly_usage_percent)} sub={resetLabel(snapshot.weekly_reset_at, snapshot.weekly_usage_percent, snapshot.is_estimate)} />
      </div>
      <ForecastSection usage={usage} />
      {usage.provider_id === "claude_code" && (
        <section className="subsection calibration">
          <div className="section-row">
            <h3><MiniIcon kind="gauge" />Session Calibration</h3>
          </div>
          <div className="calibration-row">
            <label>Known current session %<input type="number" min={0.1} max={99.9} step={0.1} value={calibrationPercent} onChange={(e) => setCalibrationPercent(e.target.value)} /></label>
            <button
              disabled={saving || !Number.isFinite(Number(calibrationPercent))}
              onClick={() => onCalibrate(Number(calibrationPercent))}
              type="button"
            >
              Calibrate
            </button>
          </div>
          <p className="muted">
            {knownCalibration
              ? `Calibrated at ${knownCalibration.toFixed(1)}% with ${fmt(calibration.claude_session_calibration_tokens)} session tokens.`
              : "Use this when the Claude usage page gives you a trusted current session percentage."}
          </p>
        </section>
      )}
      <TotalsSection usage={usage} session={session} week={week} />
      <ProviderTimeline usage={usage} />
        </>
      )}
    </section>
  );
}

function ForecastSection({ usage }: { usage: ProviderUsage }) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <section className="subsection">
      <div className="section-row">
        <h3><MiniIcon kind="bolt" />Forecasts</h3>
        <button className="icon-toggle" onClick={() => setCollapsed((value) => !value)} type="button" title={collapsed ? "Show forecasts" : "Hide forecasts"} aria-label={collapsed ? "Show forecasts" : "Hide forecasts"}>
          <ChevronIcon expanded={!collapsed} />
        </button>
      </div>
      {!collapsed && (
        <div className="grid two dense">
          <ForecastCard
            title="Session"
            minutes={usage.burn.session.minutes_until_limit}
            reason={usage.burn.session.reason}
            rate={usage.burn.session.rate_per_hour}
            percentRate={usage.burn.session.pct_per_hour}
          />
          <ForecastCard
            title="Weekly"
            minutes={usage.burn.week.minutes_until_limit}
            reason={usage.burn.week.reason}
            rate={usage.burn.week.rate_per_hour}
            percentRate={usage.burn.week.pct_per_hour}
          />
        </div>
      )}
    </section>
  );
}

function ForecastCard({ title, minutes, reason, rate, percentRate }: { title: string; minutes: number | null; reason?: string | null; rate: number | null; percentRate: number | null }) {
  return (
    <div className="forecast-card">
      <strong><MiniIcon kind="bolt" />{title}</strong>
      <p><span className="value-chip">{duration(minutes, reason)}</span></p>
      <div className="chip-row">
        <StatChip icon="tokens" label="Velocity" value={`${fmt(rate)} / hr`} />
        <StatChip icon="gauge" label="Change" value={`${pct(percentRate)} / hr`} />
      </div>
    </div>
  );
}

function TotalsSection({ usage, session, week }: { usage: ProviderUsage; session: UsageTotals; week: UsageTotals }) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <section className="subsection">
      <div className="section-row">
        <h3><MiniIcon kind="tokens" />Token totals</h3>
        <button className="icon-toggle" onClick={() => setCollapsed((value) => !value)} type="button" title={collapsed ? "Show token totals" : "Hide token totals"} aria-label={collapsed ? "Show token totals" : "Hide token totals"}>
          <ChevronIcon expanded={!collapsed} />
        </button>
      </div>
      {!collapsed && (
        <div className="grid two dense">
          <TotalsCard title={`${usage.display_label} Session`} totals={session} />
          <TotalsCard title={`${usage.display_label} Week`} totals={week} />
        </div>
      )}
    </section>
  );
}

function ProviderTimeline({ usage }: { usage: ProviderUsage }) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <section className="timeline">
      <div className="timeline-head">
        <h3>{usage.display_label} Session Timeline</h3>
        <button className="icon-toggle" onClick={() => setCollapsed((value) => !value)} type="button" title={collapsed ? "Show timeline table" : "Hide timeline table"} aria-label={collapsed ? "Show timeline table" : "Hide timeline table"}>
          <ChevronIcon expanded={!collapsed} />
        </button>
      </div>
      {!collapsed && (
        <table>
          <thead>
            <tr><th>Timestamp</th><th>Estimated tokens</th><th>Input / Output</th><th>Usage increase</th></tr>
          </thead>
          <tbody>
            {usage.spikes.length === 0 && <tr><td colSpan={4}>No large local spikes detected yet.</td></tr>}
            {usage.spikes.map((spike) => (
              <tr key={`${usage.provider_id}-${spike.timestamp_utc}-${spike.token_increase}`}>
                <td>{new Date(spike.timestamp_utc).toLocaleString()}</td>
                <td>{fmt(spike.token_increase)}</td>
                <td>{fmt(spike.input_increase)} / {fmt(spike.output_increase)}</td>
                <td>{pct(spike.pct_increase)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Chart({ title, data, children }: { title: string; data: unknown[]; children: React.ReactElement }) {
  return (
    <div className="chart">
      <h3>{title}</h3>
      {data.length === 0 ? <p>No graph data yet.</p> : <ResponsiveContainer width="100%" height={210}>{children}</ResponsiveContainer>}
    </div>
  );
}

function ProvidersPanel({ state, onEnableCodex }: { state: MonitorState; onEnableCodex: () => void }) {
  return (
    <section className="panel">
      <h2>Providers</h2>
      {state.providers.map((provider) => (
        <div className="provider" key={provider.provider_id}>
          <strong>{provider.display_label}</strong>
          <span>{provider.has_data ? "Shown in monitor" : provider.available ? "Detected" : "Unavailable"}</span>
          <small>{provider.message || provider.source}</small>
          {provider.provider_id === "openai_codex_cli" && !provider.tracking_enabled && <button onClick={onEnableCodex}>Enable Tracking</button>}
        </div>
      ))}
    </section>
  );
}

function SettingsPanel({ state, saving, onSave }: { state: MonitorState; saving: boolean; onSave: (settings: AppSettings) => void }) {
  const [draft, setDraft] = useState(state.settings);
  useEffect(() => setDraft(state.settings), [state.settings]);
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => setDraft((current) => ({ ...current, [key]: value }));

  return (
    <section className="panel settings">
      <h2>Settings</h2>
      <label>Refresh seconds<input type="number" min={1} value={draft.refresh_seconds} onChange={(e) => set("refresh_seconds", Number(e.target.value))} /></label>
      <label>Widget mode
        <select value={draft.widget_display_mode} onChange={(e) => set("widget_display_mode", e.target.value as AppSettings["widget_display_mode"])}>
          <option value="full">Full</option><option value="compact">Compact</option><option value="minimal">Minimal</option>
        </select>
      </label>
      <label>Theme
        <select value={draft.theme_mode} onChange={(e) => set("theme_mode", e.target.value as AppSettings["theme_mode"])}>
          <option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option>
        </select>
      </label>
      <label><input type="checkbox" checked={draft.include_cache_tokens} onChange={(e) => set("include_cache_tokens", e.target.checked)} /> Include cache tokens</label>
      <label><input type="checkbox" checked={draft.show_desktop_widget} onChange={(e) => set("show_desktop_widget", e.target.checked)} /> Show widget on startup</label>
      <label>Claude log folder<input value={draft.claude_log_dir} onChange={(e) => set("claude_log_dir", e.target.value)} /></label>
      <label>Codex home<input value={draft.codex_home} onChange={(e) => set("codex_home", e.target.value)} /></label>
      <button disabled={saving} onClick={() => onSave(draft)}>{saving ? "Saving..." : "Save Settings"}</button>
    </section>
  );
}
