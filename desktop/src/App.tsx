import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import type { AppSettings, MonitorState, ProviderAvailability, ProviderUsage, UsageTotals, WidgetMode } from "./types";

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
type InternalNotification = {
  id: string;
  title: string;
  message: string;
};
type LimitKind = "session" | "weekly";
type LimitOutpacingMap = Record<string, { session: boolean; weekly: boolean }>;

const usageThresholds = [80, 90, 100] as const;

function fmt(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  return Math.round(n).toLocaleString();
}

function compactNumber(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  const abs = Math.abs(n);
  const scaled = (value: number, divisor: number, suffix: string) => `${(value / divisor).toFixed(abs >= divisor * 10 ? 0 : 1).replace(/\.0$/, "")}${suffix}`;
  if (abs >= 1_000_000_000) return scaled(n, 1_000_000_000, "B");
  if (abs >= 1_000_000) return scaled(n, 1_000_000, "M");
  if (abs >= 1_000) return scaled(n, 1_000, "K");
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

function chartValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pctTooltipFormatter(value: unknown, name: unknown) {
  return [pct(chartValue(value)), String(name)];
}

function tokenTooltipFormatter(value: unknown, name: unknown) {
  return [compactNumber(chartValue(value)), String(name)];
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
    <span className={`trend-icon ${trend.kind} ${trend.severity}`} aria-label={label}>
      {trend.kind === "up" ? <ArrowUpIcon /> : <ResetArrowIcon />}
    </span>
  );
}

function OutpacingIcon({ active, label }: { active?: boolean; label: string }) {
  if (!active) return null;
  return (
    <span className="outpacing-icon" aria-label={label}>
      !
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

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 5l10 10" />
      <path d="M15 5L5 15" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M16 8a6 6 0 1 0 1 5" />
      <path d="M16 8V4" />
      <path d="M16 8h-4" />
    </svg>
  );
}

function MiniIcon({ kind }: { kind: "clock" | "bolt" | "gauge" | "tokens" | "cache" | "requests" | "provider" | "agents" }) {
  return <span className={`mini-icon ${kind}`} aria-hidden="true" />;
}

function limitSeverity(value: number | null | undefined, warning: number, critical: number): UsageTrend["severity"] {
  if (value === null || value === undefined || Number.isNaN(value)) return "normal";
  if (value >= critical) return "critical";
  if (value >= warning) return "warning";
  return "normal";
}

function widgetSeverity(state: MonitorState): UsageTrend["severity"] {
  return state.provider_usages.reduce<UsageTrend["severity"]>((severity, usage) => {
    const snapshot = usage.snapshot;
    const session = limitSeverity(
      snapshot.session_usage_percent,
      state.settings.session_warning_threshold,
      state.settings.session_critical_threshold
    );
    const weekly = limitSeverity(
      snapshot.weekly_usage_percent,
      state.settings.weekly_warning_threshold,
      state.settings.weekly_critical_threshold
    );
    if (session === "critical" || weekly === "critical") return "critical";
    if (session === "warning" || weekly === "warning" || severity === "warning") return "warning";
    return severity;
  }, "normal");
}

function notificationId(title: string, message: string) {
  return `${Date.now()}-${title}-${message}`;
}

function notifyDesktop(title: string, message: string) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  const show = () => {
    try {
      new Notification(title, { body: message });
    } catch {
      // The in-app notification remains the reliable fallback.
    }
  };
  if (Notification.permission === "granted") {
    show();
  } else if (Notification.permission === "default") {
    Notification.requestPermission().then((permission) => {
      if (permission === "granted") show();
    }).catch(() => undefined);
  }
}

function thresholdLabel(percent: number) {
  return percent >= 100 ? "hit" : "approaching";
}

function limitNotificationMessage(provider: string, limitName: LimitKind, threshold: number, value: number) {
  const displayLimit = limitName === "session" ? "Session" : "Weekly";
  return `${provider} ${displayLimit} usage is ${thresholdLabel(threshold)} ${threshold}% (${value.toFixed(1)}%).`;
}

function minutesUntil(iso: string | null | undefined) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms / 60000;
}

function isOutpacingLimit(usage: ProviderUsage, limitName: LimitKind) {
  const burn = limitName === "session" ? usage.burn.session : usage.burn.week;
  const resetAt = limitName === "session" ? usage.snapshot.session_reset_at : usage.snapshot.weekly_reset_at;
  const value = limitName === "session" ? usage.snapshot.session_usage_percent : usage.snapshot.weekly_usage_percent;
  const resetMinutes = minutesUntil(resetAt);
  const limitMinutes = burn.minutes_until_limit;
  if (value === null || value === undefined || Number.isNaN(value) || value >= 100) return false;
  if (resetMinutes === null || limitMinutes === null || limitMinutes <= 0) return false;
  return limitMinutes < resetMinutes;
}

function outpacingLimits(state: MonitorState): LimitOutpacingMap {
  return Object.fromEntries(state.provider_usages.map((usage) => [
    usage.provider_id,
    {
      session: isOutpacingLimit(usage, "session"),
      weekly: isOutpacingLimit(usage, "weekly")
    }
  ]));
}

function outpacingLabel(provider: string, limitName: LimitKind) {
  const displayLimit = limitName === "session" ? "session" : "weekly";
  return `Careful, you are outpacing your ${displayLimit} limit for ${provider}.`;
}

function InternalNotificationBar({ notification, onClose }: { notification: InternalNotification; onClose: () => void }) {
  useEffect(() => {
    const id = window.setTimeout(onClose, 30000);
    return () => window.clearTimeout(id);
  }, [notification.id, onClose]);

  return (
    <section className="notice internal-notification" role="status" aria-live="polite">
      <span className="notification-icon" aria-hidden="true">!</span>
      <div>
        <strong>{notification.title}</strong>
        <p>{notification.message}</p>
      </div>
      <button className="notification-close" onClick={onClose} type="button" aria-label="Dismiss notification">
        <CloseIcon />
      </button>
    </section>
  );
}

function InternalNotificationHost({ notifications, onClose }: { notifications: InternalNotification[]; onClose: (id: string) => void }) {
  if (notifications.length === 0) return null;
  return (
    <div className="internal-notification-stack">
      {notifications.map((item) => (
        <InternalNotificationBar key={item.id} notification={item} onClose={() => onClose(item.id)} />
      ))}
    </div>
  );
}

function ProviderConnectionPill({ state, onClick }: { state: MonitorState; onClick: () => void }) {
  const connectedCount = state.provider_usages.length;
  const label = connectedCount > 0 ? "Connected" : "No Data";
  const statusLabel = connectedCount > 0
    ? `${connectedCount} provider${connectedCount === 1 ? "" : "s"} currently have usable local usage data. Click for provider setup details.`
    : "No providers currently have usable local usage data. Click for setup details.";

  return (
    <button
      className={`provider-status ${connectedCount > 0 ? "connected" : "no-data"}`}
      onClick={onClick}
      type="button"
      aria-label={statusLabel}
    >
      <MiniIcon kind="agents" />
      <strong>{connectedCount}</strong>
      <span>{label}</span>
    </button>
  );
}

function ProviderDetailsModal({ providers, onClose }: { providers: ProviderAvailability[]; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-labelledby="provider-help-title"
        aria-modal="true"
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="modal-head">
          <div>
            <h2 id="provider-help-title">Provider Setup</h2>
            <p>Each adapter reads local usage data only. No credentials, prompts, responses, or account pages are scanned.</p>
          </div>
          <button className="notification-close" onClick={onClose} type="button" aria-label="Close provider setup">
            <CloseIcon />
          </button>
        </div>
        <div className="provider-help-list">
          {providers.map((provider) => {
            const stateLabel = provider.has_data ? "Connected" : provider.available ? "Detected" : "No Data";
            const stateClass = provider.has_data ? "connected" : provider.available ? "detected" : "no-data";
            return (
              <article className="provider-help-card" key={provider.provider_id}>
                <div className="provider-help-title">
                  <strong>{provider.display_label}</strong>
                  <span className={`provider-help-state ${stateClass}`}>
                    {stateLabel}
                  </span>
                </div>
                <p>{provider.configuration_note}</p>
                <p>{provider.data_description}</p>
                <small>{provider.message || provider.source}</small>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<MonitorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowLabel, setWindowLabel] = useState("main");
  const [saving, setSaving] = useState(false);
  const [hiddenProviders, setHiddenProviders] = useState<Set<string>>(() => new Set());
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(() => new Set());
  const [trends, setTrends] = useState<UsageTrendMap>({});
  const [notifications, setNotifications] = useState<InternalNotification[]>([]);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const stateRef = useRef<MonitorState | null>(null);
  const seenProviderIds = useRef<Set<string>>(new Set());
  const deliveredNotifications = useRef<Set<string>>(new Set());

  function pushNotification(title: string, message: string, stableKey?: string) {
    if (stableKey && deliveredNotifications.current.has(stableKey)) return;
    if (stableKey) deliveredNotifications.current.add(stableKey);
    setNotifications((current) => [...current.slice(-2), { id: notificationId(title, message), title, message }]);
    notifyDesktop(title, message);
  }

  function closeNotification(id: string) {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }

  function notifyUsageThresholds(previous: MonitorState | null, next: MonitorState) {
    for (const usage of next.provider_usages) {
      const previousUsage = previous?.provider_usages.find((candidate) => candidate.provider_id === usage.provider_id);
      const limits = [
        {
          name: "session" as const,
          value: usage.snapshot.session_usage_percent,
          previousValue: previousUsage?.snapshot.session_usage_percent
        },
        {
          name: "weekly" as const,
          value: usage.snapshot.weekly_usage_percent,
          previousValue: previousUsage?.snapshot.weekly_usage_percent
        }
      ];

      for (const limit of limits) {
        if (limit.value === null || limit.value === undefined || Number.isNaN(limit.value)) continue;
        for (const threshold of usageThresholds) {
          const crossed = limit.previousValue === null
            || limit.previousValue === undefined
            || Number.isNaN(limit.previousValue)
            || limit.previousValue < threshold;
          if (limit.value >= threshold && crossed) {
            const key = `${usage.provider_id}:${limit.name}:${threshold}:${usage.snapshot.session_reset_at || "session"}:${usage.snapshot.weekly_reset_at || "weekly"}`;
            pushNotification(
              `Usage ${thresholdLabel(threshold)}`,
              limitNotificationMessage(usage.display_label, limit.name, threshold, limit.value),
              key
            );
          }
        }
      }
    }
  }

  function notifyOutpacingLimits(previous: MonitorState | null, next: MonitorState) {
    for (const usage of next.provider_usages) {
      const previousUsage = previous?.provider_usages.find((candidate) => candidate.provider_id === usage.provider_id);
      for (const limitName of ["session", "weekly"] as LimitKind[]) {
        const active = isOutpacingLimit(usage, limitName);
        const wasActive = previousUsage ? isOutpacingLimit(previousUsage, limitName) : false;
        if (!active || wasActive) continue;
        const resetAt = limitName === "session" ? usage.snapshot.session_reset_at : usage.snapshot.weekly_reset_at;
        const key = `${usage.provider_id}:${limitName}:outpacing:${resetAt || "unknown-reset"}`;
        pushNotification("Usage pace warning", outpacingLabel(usage.display_label, limitName), key);
      }
    }
  }

  function collapseNewProviders(nextState: MonitorState) {
    setCollapsedProviders((current) => {
      let changed = false;
      const next = new Set(current);
      for (const usage of nextState.provider_usages) {
        if (seenProviderIds.current.has(usage.provider_id)) continue;
        seenProviderIds.current.add(usage.provider_id);
        next.add(usage.provider_id);
        changed = true;
      }
      return changed ? next : current;
    });
  }

  function applyMonitorState(next: MonitorState) {
    const previous = stateRef.current;
    setTrends(usageTrends(previous, next));
    notifyUsageThresholds(previous, next);
    notifyOutpacingLimits(previous, next);
    collapseNewProviders(next);
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
    const lastValues = new Map<string, Record<string, number | null>>();
    const points = [...(state?.history || [])].sort((a, b) => a.timestamp_utc.localeCompare(b.timestamp_utc));
    for (const point of points) {
      const key = point.timestamp_utc;
      const row = rows.get(key) || {
        timestamp_utc: point.timestamp_utc,
        label: timeLabel(point.timestamp_utc)
      };
      lastValues.set(point.provider_id, {
        [chartKey(point.provider_id, "session_usage_percent")]: point.session_usage_percent,
        [chartKey(point.provider_id, "weekly_usage_percent")]: point.weekly_usage_percent,
        [chartKey(point.provider_id, "session_tokens")]: point.session_tokens
      });
      for (const values of lastValues.values()) {
        Object.assign(row, values);
      }
      rows.set(key, row);
    }
    return Array.from(rows.values()).sort((a, b) => String(a.timestamp_utc).localeCompare(String(b.timestamp_utc)));
  }, [state]);

  const outpacing = useMemo(() => state ? outpacingLimits(state) : {}, [state]);

  if (!state) {
    return (
      <main className="shell">
        <p className="status">{error ? "Could not load usage data." : "Loading usage data..."}</p>
        {error && <InternalNotificationBar notification={{ id: "load-error", title: "Could not load usage data", message: error }} onClose={() => setError(null)} />}
      </main>
    );
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

  if (windowLabel === "widget") {
    return (
      <WidgetView
        state={state}
        trends={trends}
        outpacing={outpacing}
        onOpen={() => showWindow("main")}
        onStateChange={applyMonitorState}
        onUpdateSettings={updateSettings}
      />
    );
  }

  async function calibrateSession(percent: number) {
    setSaving(true);
    try {
      const updated = await calibrateClaudeSession(percent);
      pushNotification("Claude calibration saved", `Claude session calibration is now anchored at ${percent.toFixed(1)}%.`);
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
        <ProviderConnectionPill state={state} onClick={() => setProviderModalOpen(true)} />
      </header>
      {providerModalOpen && <ProviderDetailsModal providers={state.providers} onClose={() => setProviderModalOpen(false)} />}

      <section className="toolbar">
        <button onClick={() => refreshUsage().then(applyMonitorState)}>Refresh</button>
        <button onClick={() => showWindow("widget")}>Show Widget</button>
        <button onClick={() => openUsagePage()}>Open Usage Page</button>
        <button onClick={() => setupStatusline().then((message) => pushNotification("Statusline updated", message)).catch((e) => setError(String(e)))}>Install Statusline</button>
      </section>

      {state.app_state === "paused" && <section className="notice">No provider usage data found yet. Providers without local usage data are hidden.</section>}
      <InternalNotificationHost notifications={notifications} onClose={closeNotification} />
      {error && <InternalNotificationBar notification={{ id: `error-${error}`, title: "Action failed", message: error }} onClose={() => setError(null)} />}

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
              <Tooltip contentStyle={tooltipStyle} formatter={pctTooltipFormatter} labelStyle={tooltipLabelStyle} />
              {visibleProviderSeries.map((series) => (
                <Line
                  key={series.usageKey}
                  name={`${series.label} session`}
                  type="monotone"
                  dataKey={series.usageKey}
                  stroke={series.color}
                  strokeWidth={2.4}
                  dot={chartData.length < 2}
                  activeDot={{ r: 5, strokeWidth: 2 }}
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
                  strokeWidth={2.1}
                  dot={false}
                  activeDot={{ r: 5, strokeWidth: 2 }}
                  connectNulls
                />
              ))}
            </LineChart>
          </Chart>
          <Chart title="Session Tokens" data={chartData}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid)" />
              <XAxis dataKey="label" stroke="var(--muted)" />
              <YAxis stroke="var(--muted)" tickFormatter={compactNumber} />
              <Tooltip contentStyle={tooltipStyle} formatter={tokenTooltipFormatter} labelStyle={tooltipLabelStyle} />
              {visibleProviderSeries.map((series) => (
                <Line
                  key={series.tokenKey}
                  name={`${series.label} tokens`}
                  type="monotone"
                  dataKey={series.tokenKey}
                  stroke={series.color}
                  strokeWidth={2.4}
                  dot={chartData.length < 2}
                  activeDot={{ r: 5, strokeWidth: 2 }}
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
              outpacing={outpacing[usage.provider_id]}
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

function WidgetView({
  state,
  trends,
  outpacing,
  onOpen,
  onStateChange,
  onUpdateSettings
}: {
  state: MonitorState;
  trends: UsageTrendMap;
  outpacing: LimitOutpacingMap;
  onOpen: () => void;
  onStateChange: (state: MonitorState) => void;
  onUpdateSettings: (settings: AppSettings) => Promise<void>;
}) {
  const mode = state.settings.widget_display_mode;
  const widgetRef = useRef<HTMLElement | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const severity = widgetSeverity(state);

  useLayoutEffect(() => {
    const element = widgetRef.current;
    if (!element) return;
    const minWidth = mode === "minimal" ? 330 : mode === "compact" ? 340 : 420;
    const maxWidth = mode === "minimal" ? 720 : mode === "compact" ? 520 : 640;
    const minHeight = mode === "minimal" ? 58 : mode === "compact" ? 74 : 118;
    let frame = 0;
    const resizeToContent = () => {
      frame = window.requestAnimationFrame(() => {
        const width = Math.min(maxWidth, Math.max(minWidth, Math.ceil(element.scrollWidth + 2)));
        const height = Math.max(minHeight, Math.ceil(element.scrollHeight + 2));
        getCurrentWindow().setSize(new LogicalSize(width, height)).catch(() => undefined);
      });
    };
    resizeToContent();
    const observer = new ResizeObserver(resizeToContent);
    observer.observe(element);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [mode, state.provider_usages, state.status_message, trends]);

  async function closeWidget() {
    await getCurrentWindow().hide();
  }

  async function refreshWidget() {
    setRefreshing(true);
    try {
      onStateChange(await refreshUsage());
    } finally {
      setRefreshing(false);
    }
  }

  async function setWidgetMode(nextMode: WidgetMode) {
    if (nextMode === mode) return;
    await onUpdateSettings({ ...state.settings, widget_display_mode: nextMode });
  }

  return (
    <main ref={widgetRef} className={`widget ${mode} ${severity}`} onDoubleClick={onOpen}>
      <div className="widget-head" data-tauri-drag-region onMouseDown={startWindowDrag}>
        <div className="widget-title">
          <span className="logo-dot" />
          <strong>AI Usage</strong>
        </div>
        <div className="widget-controls" onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
          <div className="widget-mode-tabs" role="group" aria-label="Widget display mode">
            {(["full", "compact", "minimal"] as WidgetMode[]).map((option) => (
              <button
                aria-label={`Use ${option} widget mode`}
                className={option === mode ? "active" : ""}
                key={option}
                onClick={() => setWidgetMode(option)}
                type="button"
              >
                {option === "full" ? "F" : option === "compact" ? "C" : "M"}
              </button>
            ))}
          </div>
          <button className="widget-icon-button" disabled={refreshing} onClick={refreshWidget} type="button" aria-label="Refresh usage">
            <RefreshIcon />
          </button>
          <button className="widget-icon-button" onClick={closeWidget} type="button" aria-label="Close widget">
            <CloseIcon />
          </button>
        </div>
      </div>
      {mode === "minimal" ? (
        <p className="widget-minimal-line">{state.provider_usages.map((usage) => `${usage.display_label}: ${limitValue(usage.snapshot.session_usage_percent)}`).join(" | ") || "No data"}</p>
      ) : (
        <>
          {state.provider_usages.map((usage) => (
            <WidgetProviderRows key={usage.provider_id} trends={trends[usage.provider_id]} outpacing={outpacing[usage.provider_id]} usage={usage} />
          ))}
          {state.provider_usages.length === 0 && <small>No provider data.</small>}
          {mode === "full" && <small className="widget-status">{state.status_message}</small>}
        </>
      )}
    </main>
  );
}

function WidgetProviderRows({ usage, trends, outpacing }: { usage: ProviderUsage; trends?: UsageTrendMap[string]; outpacing?: LimitOutpacingMap[string] }) {
  const snapshot = usage.snapshot;
  return (
    <div className="widget-provider">
      <strong>{usage.display_label}</strong>
      <WidgetRow label="Session" trend={trends?.session} outpacing={outpacing?.session} outpacingLabel={outpacingLabel(usage.display_label, "session")} value={limitValue(snapshot.session_usage_percent)} reset={snapshot.session_usage_percent == null ? "no limit data" : snapshot.is_estimate && !snapshot.session_reset_at ? "local estimate" : countdown(snapshot.session_reset_at)} />
      <WidgetRow label="Weekly" trend={trends?.weekly} outpacing={outpacing?.weekly} outpacingLabel={outpacingLabel(usage.display_label, "weekly")} value={limitValue(snapshot.weekly_usage_percent)} reset={snapshot.weekly_usage_percent == null ? "no limit data" : snapshot.is_estimate && !snapshot.weekly_reset_at ? "local estimate" : countdown(snapshot.weekly_reset_at)} />
    </div>
  );
}

function WidgetRow({ label, value, reset, trend, outpacing, outpacingLabel }: { label: string; value: string; reset: string; trend?: UsageTrend; outpacing?: boolean; outpacingLabel: string }) {
  return <div className="widget-row"><span>{label}</span><strong><TrendIcon trend={trend} /><OutpacingIcon active={outpacing} label={outpacingLabel} />{value}</strong><em>{reset}</em></div>;
}

function MetricCard({ title, value, sub, trend, outpacing, outpacingLabel }: { title: string; value: string; sub: string; trend?: UsageTrend; outpacing?: boolean; outpacingLabel: string }) {
  return (
    <section className="metric">
      <span><MiniIcon kind="gauge" />{title}</span>
      <strong><TrendIcon trend={trend} /><OutpacingIcon active={outpacing} label={outpacingLabel} /><span className="value-chip primary">{value}</span></strong>
      <small><MiniIcon kind="clock" />{sub}</small>
    </section>
  );
}

function CollapsedProviderSummary({ usage, trends, outpacing }: { usage: ProviderUsage; trends?: UsageTrendMap[string]; outpacing?: LimitOutpacingMap[string] }) {
  const snapshot = usage.snapshot;
  return (
    <div className="mini-limit-grid" aria-label={`${usage.display_label} usage overview`}>
      <CollapsedLimitCard
        title="Session"
        value={limitValue(snapshot.session_usage_percent)}
        sub={resetLabel(snapshot.session_reset_at, snapshot.session_usage_percent, snapshot.is_estimate)}
        trend={trends?.session}
        outpacing={outpacing?.session}
        outpacingLabel={outpacingLabel(usage.display_label, "session")}
      />
      <CollapsedLimitCard
        title="Weekly"
        value={limitValue(snapshot.weekly_usage_percent)}
        sub={resetLabel(snapshot.weekly_reset_at, snapshot.weekly_usage_percent, snapshot.is_estimate)}
        trend={trends?.weekly}
        outpacing={outpacing?.weekly}
        outpacingLabel={outpacingLabel(usage.display_label, "weekly")}
      />
    </div>
  );
}

function CollapsedLimitCard({ title, value, sub, trend, outpacing, outpacingLabel }: { title: string; value: string; sub: string; trend?: UsageTrend; outpacing?: boolean; outpacingLabel: string }) {
  return (
    <article className="mini-limit-card">
      <span><MiniIcon kind="gauge" />{title}</span>
      <strong><TrendIcon trend={trend} /><OutpacingIcon active={outpacing} label={outpacingLabel} />{value}</strong>
      <small><MiniIcon kind="clock" />{sub}</small>
    </article>
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

function SourceChip({ icon, children }: { icon: "provider" | "tokens" | "gauge"; children: React.ReactNode }) {
  return (
    <span className="source-chip">
      <MiniIcon kind={icon} />
      <span>{children}</span>
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

function ProviderUsagePanel({ collapsed, onToggle, usage, trends, outpacing, calibration, saving, onCalibrate }: { collapsed: boolean; onToggle: () => void; usage: ProviderUsage; trends?: UsageTrendMap[string]; outpacing?: LimitOutpacingMap[string]; calibration: AppSettings; saving: boolean; onCalibrate: (percent: number) => void }) {
  const snapshot = usage.snapshot;
  const session = usage.totals.session || emptyTotals;
  const week = usage.totals.week || emptyTotals;
  const [calibrationPercent, setCalibrationPercent] = useState("");
  const knownCalibration = calibration.claude_session_calibration_percent;
  const resetMs = snapshot.session_reset_at ? new Date(snapshot.session_reset_at).getTime() : NaN;
  const showCalibration = usage.provider_id === "claude_code"
    && snapshot.source.includes("statusline stale")
    && Number.isFinite(resetMs)
    && resetMs > Date.now();
  return (
    <section className={`panel provider-usage ${collapsed ? "is-collapsed" : ""}`}>
      <div className="provider-title">
        <div>
          <h2>{usage.display_label}</h2>
          <p className="muted">
            <SourceChip icon="provider">
              {snapshot.is_estimate ? "Local fallback estimate" : "Provider statusline"}
            </SourceChip>
            <SourceChip icon="gauge">
              Source: {snapshot.source}
            </SourceChip>
            {snapshot.model_name && (
              <SourceChip icon="tokens">
                Model: {snapshot.model_name}
              </SourceChip>
            )}
          </p>
        </div>
        <button className="icon-toggle" onClick={onToggle} type="button" aria-label={collapsed ? "Show provider details" : "Hide provider details"}>
          <ChevronIcon expanded={!collapsed} />
        </button>
        {snapshot.error_state && <span className="error">{snapshot.error_state}</span>}
      </div>
      {collapsed ? (
        <CollapsedProviderSummary usage={usage} trends={trends} outpacing={outpacing} />
      ) : (
        <>
      {snapshot.raw_limit_name && <p className="muted">{snapshot.raw_limit_name}</p>}
      <div className="grid two">
        <MetricCard title="Session" trend={trends?.session} outpacing={outpacing?.session} outpacingLabel={outpacingLabel(usage.display_label, "session")} value={limitValue(snapshot.session_usage_percent)} sub={resetLabel(snapshot.session_reset_at, snapshot.session_usage_percent, snapshot.is_estimate)} />
        <MetricCard title="Weekly" trend={trends?.weekly} outpacing={outpacing?.weekly} outpacingLabel={outpacingLabel(usage.display_label, "weekly")} value={limitValue(snapshot.weekly_usage_percent)} sub={resetLabel(snapshot.weekly_reset_at, snapshot.weekly_usage_percent, snapshot.is_estimate)} />
      </div>
      <ForecastSection usage={usage} />
      {showCalibration && (
        <section className="subsection calibration">
          <div className="section-row">
            <h3><MiniIcon kind="gauge" />Session Calibration</h3>
          </div>
          <p className="muted">
            Claude Code has not refreshed exact statusline usage for over 15 minutes, but the last known 5-hour session window has not reset yet. Enter the current Session percentage from the Claude usage page to anchor local token deltas until exact data resumes.
          </p>
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
        <button className="icon-toggle" onClick={() => setCollapsed((value) => !value)} type="button" aria-label={collapsed ? "Show forecasts" : "Hide forecasts"}>
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
        <button className="icon-toggle" onClick={() => setCollapsed((value) => !value)} type="button" aria-label={collapsed ? "Show token totals" : "Hide token totals"}>
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
        <button className="icon-toggle" onClick={() => setCollapsed((value) => !value)} type="button" aria-label={collapsed ? "Show timeline table" : "Hide timeline table"}>
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
