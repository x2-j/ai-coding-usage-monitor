import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  enableCodexTracking,
  getMonitorState,
  openUsagePage,
  refreshUsage,
  saveSettings,
  setupStatusline
} from "./api";
import { installTray, showWindow } from "./tray";
import type { AppSettings, MonitorState, UsageTotals } from "./types";

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

export default function App() {
  const [state, setState] = useState<MonitorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowLabel, setWindowLabel] = useState("main");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    try {
      setWindowLabel(getCurrentWindow().label);
    } catch {
      setWindowLabel("main");
    }
    installTray().catch(() => undefined);
    getMonitorState().then(setState).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!state) return;
    const ms = Math.max(1, state.settings.refresh_seconds) * 1000;
    const id = window.setInterval(() => {
      refreshUsage().then(setState).catch((e) => setError(String(e)));
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
    return <WidgetView state={state} onOpen={() => showWindow("main")} />;
  }

  const snapshot = state.latest_snapshot;
  const session = state.totals.session || emptyTotals;
  const week = state.totals.week || emptyTotals;

  async function updateSettings(next: AppSettings) {
    setSaving(true);
    try {
      const updated = await saveSettings(next);
      setState(updated);
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
        <button onClick={() => refreshUsage().then(setState)}>Refresh</button>
        <button onClick={() => showWindow("widget")}>Show Widget</button>
        <button onClick={() => openUsagePage()}>Open Usage Page</button>
        <button onClick={() => setupStatusline().then((message) => setError(message))}>Install Statusline</button>
      </section>

      {state.app_state === "paused" && <section className="notice">No provider usage data found yet. Providers without local usage data are hidden.</section>}
      {error && <section className="notice error">{error}</section>}

      <section className="grid two">
        <MetricCard title="Session" value={limitValue(snapshot?.session_usage_percent)} sub={resetLabel(snapshot?.session_reset_at, snapshot?.session_usage_percent, snapshot?.is_estimate)} />
        <MetricCard title="Weekly" value={limitValue(snapshot?.weekly_usage_percent)} sub={resetLabel(snapshot?.weekly_reset_at, snapshot?.weekly_usage_percent, snapshot?.is_estimate)} />
      </section>

      <section className="panel">
        <h2>Provider Usage Limits</h2>
        <p className="big">
          {snapshot
            ? `${snapshot.provider_name || "Provider"} ${snapshot.session_usage_percent === null && snapshot.weekly_usage_percent === null ? "local token tracking" : snapshot.is_estimate ? "local estimate" : "statusline"}`
            : "No active provider"}
        </p>
        <p>
          Source: {snapshot?.source || "none"} {snapshot?.model_name ? `| Model: ${snapshot.model_name}` : ""}
        </p>
        {snapshot?.raw_limit_name && <p className="muted">{snapshot.raw_limit_name}</p>}
        {snapshot?.error_state && <p className="error">{snapshot.error_state}</p>}
        <div className="grid two">
          <div>
            <strong>Session forecast</strong>
            <p>{duration(state.burn.session.minutes_until_limit, state.burn.session.reason)}</p>
            <small>{fmt(state.burn.session.rate_per_hour)} tokens/hr | {pct(state.burn.session.pct_per_hour)}/hr</small>
          </div>
          <div>
            <strong>Weekly forecast</strong>
            <p>{duration(state.burn.week.minutes_until_limit, state.burn.week.reason)}</p>
            <small>{fmt(state.burn.week.rate_per_hour)} tokens/hr | {pct(state.burn.week.pct_per_hour)}/hr</small>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Rolling 5-hour graphs</h2>
        {providerSeries.length > 1 && (
          <div className="chart-legend">
            {providerSeries.map((series) => <span key={series.providerId} style={{ "--series-color": series.color } as React.CSSProperties}>{series.label}</span>)}
          </div>
        )}
        <div className="charts">
          <Chart title="Usage %" data={chartData}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" />
              <XAxis dataKey="label" stroke="var(--muted)" />
              <YAxis stroke="var(--muted)" domain={[0, 100]} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={tooltipLabelStyle} />
              {providerSeries.map((series) => (
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
              {providerSeries.map((series) => (
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
              {providerSeries.map((series) => (
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

      <section className="grid two">
        <TotalsCard title="Session" totals={session} />
        <TotalsCard title="Week" totals={week} />
      </section>

      <section className="panel">
        <h2>Session Timeline</h2>
        <table>
          <thead>
            <tr><th>Timestamp</th><th>Estimated tokens</th><th>Input / Output</th><th>Usage increase</th></tr>
          </thead>
          <tbody>
            {state.spikes.length === 0 && <tr><td colSpan={4}>No large local spikes detected yet.</td></tr>}
            {state.spikes.map((spike) => (
              <tr key={`${spike.timestamp_utc}-${spike.token_increase}`}>
                <td>{new Date(spike.timestamp_utc).toLocaleString()}</td>
                <td>{fmt(spike.token_increase)}</td>
                <td>{fmt(spike.input_increase)} / {fmt(spike.output_increase)}</td>
                <td>{pct(spike.pct_increase)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="grid two">
        <ProvidersPanel state={state} onEnableCodex={() => enableCodexTracking().then(setState)} />
        <SettingsPanel state={state} saving={saving} onSave={updateSettings} />
      </section>
    </main>
  );
}

function WidgetView({ state, onOpen }: { state: MonitorState; onOpen: () => void }) {
  const snapshot = state.latest_snapshot;
  const mode = state.settings.widget_display_mode;
  return (
    <main className={`widget ${mode}`} onDoubleClick={onOpen}>
      <div className="widget-head" data-tauri-drag-region onMouseDown={startWindowDrag} title="Drag to move">
        <span className="logo-dot" />
        <strong>AI Usage</strong>
      </div>
      {mode === "minimal" ? (
        <p>{limitValue(snapshot?.session_usage_percent)} session | {limitValue(snapshot?.weekly_usage_percent)} week</p>
      ) : (
        <>
          <WidgetRow label="Session" value={limitValue(snapshot?.session_usage_percent)} reset={snapshot?.session_usage_percent == null ? "no limit data" : snapshot?.is_estimate && !snapshot.session_reset_at ? "local estimate" : countdown(snapshot?.session_reset_at)} />
          <WidgetRow label="Weekly" value={limitValue(snapshot?.weekly_usage_percent)} reset={snapshot?.weekly_usage_percent == null ? "no limit data" : snapshot?.is_estimate && !snapshot.weekly_reset_at ? "local estimate" : countdown(snapshot?.weekly_reset_at)} />
          {mode === "full" && <small>{state.status_message}</small>}
        </>
      )}
    </main>
  );
}

function WidgetRow({ label, value, reset }: { label: string; value: string; reset: string }) {
  return <div className="widget-row"><span>{label}</span><strong>{value}</strong><em>{reset}</em></div>;
}

function MetricCard({ title, value, sub }: { title: string; value: string; sub: string }) {
  return <section className="metric"><span>{title}</span><strong>{value}</strong><small>{sub}</small></section>;
}

function TotalsCard({ title, totals }: { title: string; totals: UsageTotals }) {
  return (
    <section className="panel">
      <h2>{title} Token Totals</h2>
      <p className="big">{fmt(totals.visible_tokens)} visible tokens</p>
      <p>{fmt(totals.input_tokens)} input | {fmt(totals.output_tokens)} output</p>
      <p>{fmt(totals.cache_read_tokens + totals.cache_write_tokens)} cache | {fmt(totals.requests)} requests</p>
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
