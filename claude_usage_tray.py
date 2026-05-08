from __future__ import annotations

import json, os, queue, threading, time, math, webbrowser
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
import shutil, subprocess
from typing import Any, Dict, List, Optional, Tuple

import tkinter as tk
from tkinter import ttk, messagebox

try:
    import winreg
except Exception:
    winreg = None

try:
    import pystray
    from PIL import Image, ImageDraw
except Exception:
    pystray = None
    Image = None
    ImageDraw = None

APP_NAME = "Simple AI Usage Monitor"
CONFIG_DIR = Path(os.environ.get("APPDATA", str(Path.home()))) / "ClaudeCodeUsageTray"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_PATH = CONFIG_DIR / "config.json"
STATUSLINE_LATEST = CONFIG_DIR / "statusline_latest.json"
USAGE_HISTORY_PATH = CONFIG_DIR / "usage_history.jsonl"
DEBUG_LOG = CONFIG_DIR / "debug.log"
DEFAULT_CLAUDE_LOG_DIR = Path.home() / ".claude" / "projects"
DEFAULT_CODEX_HOME = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
USAGE_HISTORY_SCHEMA_VERSION = 1
WIDGET_DISPLAY_MODES = ("full", "compact", "minimal")
THEME_MODES = ("system", "dark", "light")
THEMES = {
    "dark": {
        "bg": "#1b1d22",
        "surface": "#202124",
        "panel": "#252833",
        "text": "#f4f4f4",
        "strong_text": "#ffffff",
        "muted": "#b8b8b8",
        "subtle": "#d6d6d6",
        "border": "#3a3d42",
        "grid": "#34373d",
        "accent": "#ac84ff",
        "accent_bg": "#2b2438",
        "glow": "#5f3aa2",
        "warn": "#ffd97a",
        "series_blue": "#8bd3ff",
        "series_purple": "#d9a7ff",
        "button_bg": "#303441",
        "button_active": "#3a4050",
    },
    "light": {
        "bg": "#f6f7fb",
        "surface": "#ffffff",
        "panel": "#eef0f6",
        "text": "#1f2328",
        "strong_text": "#111318",
        "muted": "#5b6270",
        "subtle": "#3f4652",
        "border": "#cfd4df",
        "grid": "#e2e6ef",
        "accent": "#6f42c1",
        "accent_bg": "#eee7ff",
        "glow": "#d8c7ff",
        "warn": "#a15c00",
        "series_blue": "#006d9c",
        "series_purple": "#7d3fb2",
        "button_bg": "#e7eaf1",
        "button_active": "#d9dee9",
    },
}

DEFAULT_CONFIG = {
    "claude_log_dir": str(DEFAULT_CLAUDE_LOG_DIR),
    "refresh_seconds": 10,
    "session_hours": 5,
    "session_budget_tokens": 1000000,
    "weekly_budget_tokens": 10000000,
    "include_cache_tokens": False,
    "start_minimized": False,
    "show_desktop_widget": True,
    "widget_display_mode": "full",
    "theme_mode": "system",
    "usage_source": "statusline_then_local",
}

@dataclass
class UsageTotals:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    requests: int = 0
    @property
    def visible_tokens(self) -> int: return self.input_tokens + self.output_tokens
    @property
    def total_with_cache(self) -> int: return self.visible_tokens + self.cache_creation_input_tokens + self.cache_read_input_tokens

@dataclass
class UsageRecord:
    provider_name: str
    timestamp: datetime
    source: str
    model_name: Optional[str] = None
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    session_usage_pct: Optional[float] = None
    weekly_usage_pct: Optional[float] = None
    session_reset_time: Optional[Any] = None
    weekly_reset_time: Optional[Any] = None
    requests: int = 1
    error: Optional[str] = None

    @property
    def visible_tokens(self) -> int: return self.input_tokens + self.output_tokens
    @property
    def cache_tokens(self) -> int: return self.cache_creation_input_tokens + self.cache_read_input_tokens
    @property
    def total_with_cache(self) -> int: return self.visible_tokens + self.cache_tokens
    def to_totals(self) -> UsageTotals:
        return UsageTotals(self.input_tokens, self.output_tokens, self.cache_creation_input_tokens, self.cache_read_input_tokens, self.requests)

@dataclass
class RateLimitUsage:
    session_pct: Optional[float] = None
    session_reset: Optional[Any] = None
    weekly_pct: Optional[float] = None
    weekly_reset: Optional[Any] = None
    source: str = "local estimate"
    error: Optional[str] = None
    @classmethod
    def from_record(cls, record: UsageRecord) -> "RateLimitUsage":
        return cls(record.session_usage_pct, record.session_reset_time, record.weekly_usage_pct, record.weekly_reset_time, record.source, record.error)

@dataclass
class ProviderAvailability:
    available: bool
    source: str
    message: Optional[str] = None
    has_data: bool = False

@dataclass
class ProviderUsageSnapshot:
    record: UsageRecord
    totals: Dict[str, UsageTotals]

class UsageProviderAdapter(ABC):
    provider_id: str
    provider_name: str
    display_label: str
    availability_only = False

    def __init__(self, cfg: Dict[str, Any]):
        self.cfg = cfg
        self.error_state: Optional[str] = None

    @abstractmethod
    def check_availability(self) -> ProviderAvailability:
        """Return whether the provider has a usable local data source."""

    @abstractmethod
    def latest_usage_snapshot(self) -> UsageRecord:
        """Return the latest provider-neutral usage snapshot."""

    def import_history(self) -> Dict[str, UsageTotals]:
        """Optionally import local history into provider-neutral token totals."""
        return {k: UsageTotals() for k in ["session", "today", "week", "all"]}

    def collect_usage_snapshot(self) -> ProviderUsageSnapshot:
        return ProviderUsageSnapshot(
            record=self.latest_usage_snapshot(),
            totals=self.import_history(),
        )

@dataclass
class BurnRateProjection:
    rate_per_minute: Optional[float] = None
    rate_per_hour: Optional[float] = None
    pct_per_hour: Optional[float] = None
    time_until_limit: Optional[timedelta] = None
    reason: Optional[str] = None

@dataclass
class UsageSpike:
    timestamp: datetime
    token_increase: int
    input_increase: Optional[int] = None
    output_increase: Optional[int] = None
    pct_increase: Optional[float] = None

def log(msg: str) -> None:
    try:
        with DEBUG_LOG.open("a", encoding="utf-8") as f:
            f.write(f"{datetime.now().isoformat(timespec='seconds')} {msg}\n")
    except Exception: pass

def load_config() -> Dict[str, Any]:
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(json.dumps(DEFAULT_CONFIG, indent=2), encoding="utf-8")
        return dict(DEFAULT_CONFIG)
    try: existing = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception: existing = {}
    cfg = dict(DEFAULT_CONFIG); cfg.update(existing); return cfg

def save_config(cfg: Dict[str, Any]) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")

def iso_or_none(v: Any) -> Optional[str]:
    if isinstance(v, datetime): return v.astimezone().isoformat()
    dt = parse_reset(v)
    return dt.isoformat() if dt else None

def to_int(v: Any) -> int:
    try: return int(v or 0)
    except Exception: return 0

def parse_ts(v: Any, fallback: float) -> datetime:
    if isinstance(v, (int, float)):
        if v > 10_000_000_000: v = v / 1000
        return datetime.fromtimestamp(v, tz=timezone.utc).astimezone()
    if isinstance(v, str):
        try: return datetime.fromisoformat(v.replace("Z", "+00:00")).astimezone()
        except Exception: pass
    return datetime.fromtimestamp(fallback, tz=timezone.utc).astimezone()

def find_first_key(obj: Any, names: Tuple[str, ...]) -> Any:
    if isinstance(obj, dict):
        for n in names:
            if n in obj: return obj[n]
        for v in obj.values():
            x = find_first_key(v, names)
            if x is not None: return x
    elif isinstance(obj, list):
        for v in obj:
            x = find_first_key(v, names)
            if x is not None: return x
    return None

def find_usage_dict(obj: Any) -> Optional[Dict[str, Any]]:
    if isinstance(obj, dict):
        if isinstance(obj.get("usage"), dict): return obj["usage"]
        for v in obj.values():
            r = find_usage_dict(v)
            if r: return r
    elif isinstance(obj, list):
        for v in obj:
            r = find_usage_dict(v)
            if r: return r
    return None

def normalize_pct(v: Any) -> Optional[float]:
    try:
        if v is None: return None
        p = float(v)
        return p * 100 if 0 <= p <= 1 else p
    except Exception: return None

def normalized_widget_mode(v: Any) -> str:
    mode = str(v or "full").strip().lower()
    return mode if mode in WIDGET_DISPLAY_MODES else "full"

def normalized_theme_mode(v: Any) -> str:
    mode = str(v or "system").strip().lower()
    return mode if mode in THEME_MODES else "system"

def windows_prefers_light_theme() -> Optional[bool]:
    if winreg is None:
        return None
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as key:
            value, _ = winreg.QueryValueEx(key, "AppsUseLightTheme")
            return bool(value)
    except Exception:
        return None

def resolved_theme_name(mode: Any) -> str:
    mode = normalized_theme_mode(mode)
    if mode == "system":
        prefers_light = windows_prefers_light_theme()
        if prefers_light is None:
            return "dark"
        return "light" if prefers_light else "dark"
    return mode

def usage_record_from_log(obj: Dict[str, Any], fallback_ts: float) -> Optional[UsageRecord]:
    usage = find_usage_dict(obj)
    if not usage: return None
    model = find_first_key(obj, ("model", "model_name", "modelName"))
    return UsageRecord(
        provider_name="Anthropic",
        model_name=str(model) if model else None,
        timestamp=parse_ts(find_first_key(obj, ("timestamp", "created_at", "createdAt", "time")), fallback_ts),
        input_tokens=to_int(usage.get("input_tokens")),
        output_tokens=to_int(usage.get("output_tokens")),
        cache_creation_input_tokens=to_int(usage.get("cache_creation_input_tokens")),
        cache_read_input_tokens=to_int(usage.get("cache_read_input_tokens")),
        source="Claude Code local logs",
    )

def week_start(dt: datetime) -> datetime:
    s = dt.astimezone() - timedelta(days=dt.astimezone().weekday())
    return s.replace(hour=0, minute=0, second=0, microsecond=0)

def scan_usage(cfg: Dict[str, Any]) -> Dict[str, UsageTotals]:
    root = Path(cfg.get("claude_log_dir") or DEFAULT_CLAUDE_LOG_DIR).expanduser()
    now = datetime.now().astimezone()
    session_start, weekly_start = now - timedelta(hours=float(cfg.get("session_hours", 5))), week_start(now)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    totals = {k: UsageTotals() for k in ["session", "today", "week", "all"]}
    if not root.exists(): return totals
    records: Dict[str, UsageRecord] = {}
    for path in root.rglob("*.jsonl"):
        try:
            mtime = path.stat().st_mtime
            with path.open("r", encoding="utf-8", errors="ignore") as f:
                for line_no, line in enumerate(f, 1):
                    try: obj = json.loads(line)
                    except Exception: continue
                    rec = usage_record_from_log(obj, mtime)
                    if not rec: continue
                    rid = find_first_key(obj, ("requestId", "request_id", "message_id", "uuid", "id"))
                    key = str(rid) if rid else f"{path}:{line_no}"
                    old = records.get(key)
                    if old is None or rec.total_with_cache >= old.total_with_cache: records[key] = rec
        except Exception as e: log(f"scan skipped {path}: {e!r}")
    for rec in records.values():
        keys = ["all"]
        if rec.timestamp >= session_start: keys.append("session")
        if rec.timestamp >= today_start: keys.append("today")
        if rec.timestamp >= weekly_start: keys.append("week")
        for k in keys:
            t = totals[k]
            t.input_tokens += rec.input_tokens; t.output_tokens += rec.output_tokens
            t.cache_creation_input_tokens += rec.cache_creation_input_tokens; t.cache_read_input_tokens += rec.cache_read_input_tokens; t.requests += 1
    return totals

def pct(used: int, budget: int) -> float:
    return 0.0 if budget <= 0 else max(0.0, min(100.0, used / budget * 100))

def parse_reset(v: Any) -> Optional[datetime]:
    if v is None: return None
    try:
        if isinstance(v, str) and v.strip().isdigit(): v = int(v)
        if isinstance(v, (int, float)):
            if v > 10_000_000_000: v = v / 1000
            return datetime.fromtimestamp(v, tz=timezone.utc).astimezone()
        if isinstance(v, str): return datetime.fromisoformat(v.replace("Z", "+00:00")).astimezone()
    except Exception: return None
    return None

def countdown(v: Any) -> str:
    dt = parse_reset(v)
    if not dt: return "unknown"
    seconds = max(0, int((dt - datetime.now().astimezone()).total_seconds()))
    h, r = divmod(seconds, 3600); m = r // 60
    return f"{h}h {m:02d}m" if h else f"{m}m"

def fmt(n: int) -> str: return f"{n:,}"

def totals_to_dict(t: UsageTotals) -> Dict[str, int]:
    return {
        "input_tokens": t.input_tokens,
        "output_tokens": t.output_tokens,
        "cache_creation_input_tokens": t.cache_creation_input_tokens,
        "cache_read_input_tokens": t.cache_read_input_tokens,
        "requests": t.requests,
    }

def history_pct(used: int, budget: Any) -> float:
    try: return pct(used, int(budget or 0))
    except Exception: return 0.0

def build_usage_snapshot(record: UsageRecord, totals: Dict[str, UsageTotals], cfg: Dict[str, Any]) -> Dict[str, Any]:
    session_tokens = totals["session"].total_with_cache if cfg.get("include_cache_tokens") else totals["session"].visible_tokens
    weekly_tokens = totals["week"].total_with_cache if cfg.get("include_cache_tokens") else totals["week"].visible_tokens
    session_pct = record.session_usage_pct if record.session_usage_pct is not None else history_pct(session_tokens, cfg.get("session_budget_tokens"))
    weekly_pct = record.weekly_usage_pct if record.weekly_usage_pct is not None else history_pct(weekly_tokens, cfg.get("weekly_budget_tokens"))
    source = record.source if not record.error else "local estimate"
    session_totals = totals["session"]
    return {
        "schema_version": USAGE_HISTORY_SCHEMA_VERSION,
        "timestamp": datetime.now().astimezone().isoformat(),
        "provider_name": record.provider_name,
        "model_name": record.model_name,
        "input_tokens": session_totals.input_tokens,
        "output_tokens": session_totals.output_tokens,
        "cache_creation_input_tokens": session_totals.cache_creation_input_tokens,
        "cache_read_input_tokens": session_totals.cache_read_input_tokens,
        "session_usage_pct": session_pct,
        "weekly_usage_pct": weekly_pct,
        "session_reset_time": iso_or_none(record.session_reset_time),
        "weekly_reset_time": iso_or_none(record.weekly_reset_time),
        "source": source,
        "statusline_error": record.error,
        "totals": {k: totals_to_dict(v) for k, v in totals.items()},
    }

def append_usage_snapshot(record: UsageRecord, totals: Dict[str, UsageTotals], cfg: Dict[str, Any]) -> None:
    try:
        USAGE_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
        snapshot = build_usage_snapshot(record, totals, cfg)
        with USAGE_HISTORY_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(snapshot, separators=(",", ":")) + "\n")
    except Exception as e: log(f"usage history append failed: {e!r}")

def query_usage_history(hours: float) -> List[Dict[str, Any]]:
    if not USAGE_HISTORY_PATH.exists(): return []
    cutoff = datetime.now().astimezone() - timedelta(hours=hours)
    rows: List[Dict[str, Any]] = []
    try:
        with USAGE_HISTORY_PATH.open("r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                try: row = json.loads(line)
                except Exception: continue
                ts = parse_reset(row.get("timestamp"))
                if ts and ts >= cutoff: rows.append(row)
    except Exception as e: log(f"usage history query failed: {e!r}")
    return rows

def query_usage_last_5_hours() -> List[Dict[str, Any]]: return query_usage_history(5)
def query_usage_last_24_hours() -> List[Dict[str, Any]]: return query_usage_history(24)
def query_usage_last_7_days() -> List[Dict[str, Any]]: return query_usage_history(24 * 7)

def history_token_total(row: Dict[str, Any], scope: str = "session", include_cache: bool = False) -> Optional[int]:
    totals = row.get("totals")
    if isinstance(totals, dict) and isinstance(totals.get(scope), dict):
        t = totals[scope]
        visible = to_int(t.get("input_tokens")) + to_int(t.get("output_tokens"))
        if include_cache:
            return visible + to_int(t.get("cache_creation_input_tokens")) + to_int(t.get("cache_read_input_tokens"))
        return visible
    if scope == "session":
        visible = to_int(row.get("input_tokens")) + to_int(row.get("output_tokens"))
        if include_cache:
            return visible + to_int(row.get("cache_creation_input_tokens")) + to_int(row.get("cache_read_input_tokens"))
        return visible
    return None

def history_token_component(row: Dict[str, Any], component: str, scope: str = "session") -> Optional[int]:
    totals = row.get("totals")
    if isinstance(totals, dict) and isinstance(totals.get(scope), dict):
        return to_int(totals[scope].get(component))
    if scope == "session":
        return to_int(row.get(component))
    return None

def history_points(rows: List[Dict[str, Any]], value_fn) -> List[Tuple[datetime, float]]:
    points: List[Tuple[datetime, float]] = []
    for row in rows:
        ts = parse_reset(row.get("timestamp"))
        if not ts: continue
        value = value_fn(row)
        if value is None: continue
        try: points.append((ts, float(value)))
        except Exception: continue
    points.sort(key=lambda p: p[0])
    deduped: List[Tuple[datetime, float]] = []
    for ts, value in points:
        if deduped and ts == deduped[-1][0]: deduped[-1] = (ts, value)
        else: deduped.append((ts, value))
    return deduped

def latest_monotonic_segment(points: List[Tuple[datetime, float]]) -> List[Tuple[datetime, float]]:
    if len(points) < 2: return points
    segment = [points[-1]]
    previous = points[-1][1]
    for ts, value in reversed(points[:-1]):
        if value > previous:
            break
        segment.append((ts, value))
        previous = value
    segment.reverse()
    return segment

def detect_usage_spikes(rows: List[Dict[str, Any]], include_cache: bool = False, limit: int = 8) -> List[UsageSpike]:
    token_points = history_points(rows, lambda row: history_token_total(row, "session", include_cache))
    input_points = dict(history_points(rows, lambda row: history_token_component(row, "input_tokens", "session")))
    output_points = dict(history_points(rows, lambda row: history_token_component(row, "output_tokens", "session")))
    pct_points = dict(history_points(rows, lambda row: normalize_pct(row.get("session_usage_pct"))))
    spikes: List[UsageSpike] = []
    for (prev_ts, prev_tokens), (ts, tokens) in zip(token_points, token_points[1:]):
        token_delta = int(round(tokens - prev_tokens))
        if token_delta <= 0:
            continue
        prev_pct = pct_points.get(prev_ts)
        pct_value = pct_points.get(ts)
        pct_delta = None
        if prev_pct is not None and pct_value is not None and pct_value >= prev_pct:
            pct_delta = pct_value - prev_pct
        if token_delta < 1000 and (pct_delta is None or pct_delta < 1.0):
            continue
        input_delta = None
        output_delta = None
        if prev_ts in input_points and ts in input_points:
            input_delta = max(0, int(round(input_points[ts] - input_points[prev_ts])))
        if prev_ts in output_points and ts in output_points:
            output_delta = max(0, int(round(output_points[ts] - output_points[prev_ts])))
        spikes.append(UsageSpike(ts, token_delta, input_delta, output_delta, pct_delta))
    spikes.sort(key=lambda spike: spike.timestamp, reverse=True)
    return spikes[:limit]

def value_velocity_per_hour(rows: List[Dict[str, Any]], value_fn) -> Optional[float]:
    segment = latest_monotonic_segment(history_points(rows, value_fn))
    if len(segment) < 2: return None
    start_ts, start_value = segment[0]
    end_ts, end_value = segment[-1]
    elapsed_hours = (end_ts - start_ts).total_seconds() / 3600
    if elapsed_hours <= 0: return None
    return max(0.0, end_value - start_value) / elapsed_hours

def token_velocity_per_hour(rows: List[Dict[str, Any]], scope: str = "session", include_cache: bool = False) -> Optional[float]:
    return value_velocity_per_hour(rows, lambda row: history_token_total(row, scope, include_cache))

def token_velocity_per_minute(rows: List[Dict[str, Any]], scope: str = "session", include_cache: bool = False) -> Optional[float]:
    hourly = token_velocity_per_hour(rows, scope, include_cache)
    return None if hourly is None else hourly / 60

def usage_percentage_change_per_hour(rows: List[Dict[str, Any]], pct_key: str = "session_usage_pct") -> Optional[float]:
    return value_velocity_per_hour(rows, lambda row: normalize_pct(row.get(pct_key)))

def latest_history_pct(rows: List[Dict[str, Any]], pct_key: str) -> Optional[float]:
    points = history_points(rows, lambda row: normalize_pct(row.get(pct_key)))
    return points[-1][1] if points else None

def projected_time_until_limit(current_pct: Optional[float], pct_per_hour: Optional[float], reset_time: Any = None) -> Tuple[Optional[timedelta], Optional[str]]:
    if current_pct is None:
        return None, "missing usage percentage"
    if pct_per_hour is None:
        return None, "not enough data"
    if pct_per_hour <= 0:
        return None, "zero activity"
    remaining_pct = max(0.0, 100.0 - current_pct)
    if remaining_pct <= 0:
        return timedelta(0), None
    projected = timedelta(hours=remaining_pct / pct_per_hour)
    reset = parse_reset(reset_time)
    if reset:
        until_reset = reset - datetime.now().astimezone()
        if until_reset.total_seconds() >= 0 and projected > until_reset:
            return None, "resets before projected limit"
    return projected, None

def projected_time_until_session_limit(rows: List[Dict[str, Any]], current_pct: Optional[float] = None, reset_time: Any = None) -> Tuple[Optional[timedelta], Optional[str]]:
    if current_pct is None:
        current_pct = latest_history_pct(rows, "session_usage_pct")
    return projected_time_until_limit(current_pct, usage_percentage_change_per_hour(rows, "session_usage_pct"), reset_time)

def projected_time_until_weekly_limit(rows: List[Dict[str, Any]], current_pct: Optional[float] = None, reset_time: Any = None) -> Tuple[Optional[timedelta], Optional[str]]:
    if current_pct is None:
        current_pct = latest_history_pct(rows, "weekly_usage_pct")
    return projected_time_until_limit(current_pct, usage_percentage_change_per_hour(rows, "weekly_usage_pct"), reset_time)

def calculate_burn_rate(rows: List[Dict[str, Any]], scope: str, pct_key: str, current_pct: Optional[float], reset_time: Any, include_cache: bool = False) -> BurnRateProjection:
    per_hour = token_velocity_per_hour(rows, scope, include_cache)
    pct_hour = usage_percentage_change_per_hour(rows, pct_key)
    if current_pct is None:
        current_pct = latest_history_pct(rows, pct_key)
    until_limit, reason = projected_time_until_limit(current_pct, pct_hour, reset_time)
    return BurnRateProjection(
        rate_per_minute=None if per_hour is None else per_hour / 60,
        rate_per_hour=per_hour,
        pct_per_hour=pct_hour,
        time_until_limit=until_limit,
        reason=reason,
    )

def fmt_rate(v: Optional[float], suffix: str) -> str:
    if v is None: return "n/a"
    if abs(v) >= 100: return f"{v:,.0f}{suffix}"
    return f"{v:,.1f}{suffix}"

def fmt_duration(v: Optional[timedelta], reason: Optional[str] = None) -> str:
    if v is None: return reason or "n/a"
    seconds = max(0, int(v.total_seconds()))
    h, r = divmod(seconds, 3600); m = r // 60
    if h >= 24:
        d, h = divmod(h, 24)
        return f"{d}d {h}h"
    return f"{h}h {m:02d}m" if h else f"{m}m"

def fmt_forecast_duration(v: timedelta, weekly: bool = False) -> str:
    seconds = max(0, int(v.total_seconds()))
    hours, remainder = divmod(seconds, 3600)
    minutes = remainder // 60
    if weekly:
        days, hours = divmod(hours, 24)
        return f"{days}d {hours}h"
    return f"{hours}h {minutes}m"

def usage_record_error(message: str, source: str = "Claude Code statusline") -> UsageRecord:
    return UsageRecord(provider_name="Anthropic", timestamp=datetime.now().astimezone(), source=source, error=message)

def usage_record_from_statusline(data: Dict[str, Any]) -> UsageRecord:
    if isinstance(data.get("raw"), dict): data = data["raw"]
    rl = data.get("rate_limits") or data.get("rate_limit") or {}
    five = rl.get("five_hour") or rl.get("session") or {}
    seven = rl.get("seven_day") or rl.get("weekly") or {}
    usage = find_usage_dict(data) or {}
    sp = five.get("used_percentage", five.get("utilization")) if isinstance(five, dict) else None
    wp = seven.get("used_percentage", seven.get("utilization")) if isinstance(seven, dict) else None
    sr = five.get("resets_at", five.get("reset_at")) if isinstance(five, dict) else None
    wr = seven.get("resets_at", seven.get("reset_at")) if isinstance(seven, dict) else None
    model = find_first_key(data, ("model", "model_name", "modelName"))
    provider = find_first_key(data, ("provider", "provider_name", "providerName")) or "Anthropic"
    ts = parse_ts(find_first_key(data, ("timestamp", "created_at", "createdAt", "time")), time.time())
    return UsageRecord(
        provider_name=str(provider),
        model_name=str(model) if model else None,
        timestamp=ts,
        input_tokens=to_int(usage.get("input_tokens")),
        output_tokens=to_int(usage.get("output_tokens")),
        cache_creation_input_tokens=to_int(usage.get("cache_creation_input_tokens")),
        cache_read_input_tokens=to_int(usage.get("cache_read_input_tokens")),
        session_usage_pct=normalize_pct(sp),
        weekly_usage_pct=normalize_pct(wp),
        session_reset_time=sr,
        weekly_reset_time=wr,
        source="Claude Code statusline",
        requests=0,
    )

def read_statusline_record() -> UsageRecord:
    if not STATUSLINE_LATEST.exists():
        return usage_record_error("No Claude Code statusline data yet. Run install_statusline.bat, then send one message in Claude Code.")
    try: data = json.loads(STATUSLINE_LATEST.read_text(encoding="utf-8"))
    except Exception as e: return usage_record_error(f"Could not read statusline data: {e}")
    record = usage_record_from_statusline(data)
    if record.session_usage_pct is None and record.weekly_usage_pct is None:
        return usage_record_error("Statusline file exists, but it has no recognized rate_limits fields. Fallback local totals are being used.")
    return record

def read_statusline_usage() -> RateLimitUsage:
    return RateLimitUsage.from_record(read_statusline_record())

def has_jsonl_files(root: Path) -> bool:
    if not root.exists():
        return False
    try:
        next(root.rglob("*.jsonl"))
        return True
    except StopIteration:
        return False
    except Exception as e:
        log(f"provider data probe failed for {root.name}: {e!r}")
        return False

class ClaudeCodeProviderAdapter(UsageProviderAdapter):
    provider_id = "claude_code"
    provider_name = "Anthropic"
    display_label = "Claude Code"

    def check_availability(self) -> ProviderAvailability:
        statusline_exists = STATUSLINE_LATEST.exists()
        log_root = Path(self.cfg.get("claude_log_dir") or DEFAULT_CLAUDE_LOG_DIR).expanduser()
        if statusline_exists:
            return ProviderAvailability(True, "Claude Code statusline", "Statusline capture file is available.", True)
        if has_jsonl_files(log_root):
            return ProviderAvailability(True, "Claude Code local logs", "Local Claude Code logs are available for estimates.", True)
        return ProviderAvailability(False, "Claude Code", "No Claude Code usage data found.", False)

    def latest_usage_snapshot(self) -> UsageRecord:
        record = read_statusline_record()
        self.error_state = record.error
        return record

    def import_history(self) -> Dict[str, UsageTotals]:
        return scan_usage(self.cfg)

def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", str(DEFAULT_CODEX_HOME))).expanduser()

def find_codex_command() -> Optional[str]:
    # Prefer Windows cmd/exe shims so PowerShell execution policy does not block availability checks.
    for name in ("codex.cmd", "codex.exe", "codex"):
        found = shutil.which(name)
        if found:
            return found
    return None

class CodexCliProviderAdapter(UsageProviderAdapter):
    provider_id = "openai_codex_cli"
    provider_name = "OpenAI"
    display_label = "OpenAI Codex CLI"
    availability_only = True

    def __init__(self, cfg: Dict[str, Any]):
        super().__init__(cfg)
        self.last_version: Optional[str] = None

    def check_availability(self) -> ProviderAvailability:
        cmd = find_codex_command()
        home = codex_home()
        config_path = home / "config.toml"
        if not cmd:
            self.error_state = "Codex CLI is not on PATH."
            return ProviderAvailability(False, "Codex CLI", self.error_state, False)
        try:
            result = subprocess.run([cmd, "--version"], capture_output=True, text=True, timeout=5, check=False)
        except Exception as e:
            self.error_state = f"Codex CLI version check failed: {e}"
            return ProviderAvailability(False, "Codex CLI", self.error_state, False)
        version = (result.stdout or result.stderr).strip().splitlines()[0] if (result.stdout or result.stderr).strip() else "unknown version"
        self.last_version = version
        if result.returncode != 0:
            self.error_state = f"Codex CLI version check exited with {result.returncode}."
            return ProviderAvailability(False, "Codex CLI", self.error_state, False)
        config_note = "config present" if config_path.exists() else "config not found"
        self.error_state = None
        return ProviderAvailability(True, "Codex CLI", f"{version}; {config_note}; usage unavailable without opt-in instrumentation.", False)

    def latest_usage_snapshot(self) -> UsageRecord:
        availability = self.check_availability()
        message = "Codex CLI usage tracking is availability-only. Exact local usage is not exposed by a safe supported local source yet."
        if not availability.available and availability.message:
            message = availability.message
        self.error_state = message
        return UsageRecord(
            provider_name=self.provider_name,
            timestamp=datetime.now().astimezone(),
            source="Codex CLI availability",
            error=message,
        )

def available_provider_adapters(cfg: Dict[str, Any]) -> Dict[str, UsageProviderAdapter]:
    return {
        ClaudeCodeProviderAdapter.provider_id: ClaudeCodeProviderAdapter(cfg),
        CodexCliProviderAdapter.provider_id: CodexCliProviderAdapter(cfg),
    }

def visible_provider_adapters(providers: Dict[str, UsageProviderAdapter]) -> Dict[str, UsageProviderAdapter]:
    return {
        provider_id: provider
        for provider_id, provider in providers.items()
        if not provider.availability_only and provider.check_availability().has_data
    }

def make_icon(angle: int = 0, session_pct: float = 0.0):
    if Image is None: return None
    img = Image.new("RGBA", (64,64), (0,0,0,0)); d = ImageDraw.Draw(img)
    d.ellipse((2,2,62,62), fill=(95,58,162,28))
    d.ellipse((7,7,57,57), fill=(44,36,56,255), outline=(172,132,255,255), width=2)
    # small rotating signal motif, not a provider logo
    r=18; cx=cy=32; a=math.radians(angle)
    x=cx+math.cos(a)*r; y=cy+math.sin(a)*r
    d.arc((16,16,48,48), start=angle, end=angle+110, fill=(255,220,130,230), width=4)
    d.ellipse((x-4,y-4,x+4,y+4), fill=(255,220,130,255))
    d.line((24,34,31,25,40,38), fill=(255,255,255,230), width=3)
    # bottom mini usage bar
    d.rectangle((10,52,54,56), outline=(220,220,220,180))
    d.rectangle((11,53,11+int(42*max(0,min(100,session_pct))/100),55), fill=(255,220,130,255))
    return img

class App:
    def __init__(self):
        self.config = load_config(); self.q = queue.Queue(); self.root = tk.Tk(); self.root.title(APP_NAME); self.root.geometry("760x860")
        self.colors = THEMES[resolved_theme_name(self.config.get("theme_mode"))]
        self._configure_ttk_theme()
        self.providers = available_provider_adapters(self.config)
        self.visible_providers = visible_provider_adapters(self.providers)
        self.provider: Optional[UsageProviderAdapter] = next(iter(self.visible_providers.values()), None)
        self.root.protocol("WM_DELETE_WINDOW", self.hide_window)
        self.labels: Dict[str, tk.StringVar] = {}; self.status = tk.StringVar(); self.rate_label = tk.StringVar(value="Loading usage data...")
        self.state_label = tk.StringVar(value="Loading")
        self.panel_window = None; self.widget_window = None; self.panel_vars = {}; self.panel_bars = {}; self.last_rate = RateLimitUsage(); self.last_totals = {k: UsageTotals() for k in ["session","today","week","all"]}
        self.last_burn = {"session": BurnRateProjection(), "week": BurnRateProjection()}
        self.last_graph_rows: List[Dict[str, Any]] = []
        self.last_spikes: List[UsageSpike] = []
        self._refreshing = False; self.icon = None; self.spin_angle = 0; self.app_state = "loading"
        self._build_ui(); self._set_provider_sections_visible(bool(self.provider)); self._start_tray(); self.refresh(); self.root.after(500, self._poll); self.root.after(int(self.config.get("refresh_seconds",10))*1000, self._scheduled)
        if self.config.get("show_desktop_widget", True): self.show_desktop_widget()
        if self.config.get("start_minimized") and self.icon: self.root.withdraw()
    def _theme_mode(self) -> str:
        mode = normalized_theme_mode(self.config.get("theme_mode"))
        self.config["theme_mode"] = mode
        return mode
    def _refresh_theme_colors(self):
        self.colors = THEMES[resolved_theme_name(self._theme_mode())]
    def _configure_ttk_theme(self):
        c = self.colors
        self.root.configure(bg=c["bg"])
        style = ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except Exception:
            pass
        style.configure(".", background=c["bg"], foreground=c["text"], fieldbackground=c["surface"])
        style.configure("TFrame", background=c["bg"])
        style.configure("TLabel", background=c["bg"], foreground=c["text"])
        style.configure("TLabelframe", background=c["bg"], foreground=c["text"], bordercolor=c["border"])
        style.configure("TLabelframe.Label", background=c["bg"], foreground=c["text"])
        style.configure("TButton", background=c["button_bg"], foreground=c["text"], bordercolor=c["border"])
        style.map("TButton", background=[("active", c["button_active"])], foreground=[("disabled", c["muted"])])
        style.configure("TCheckbutton", background=c["bg"], foreground=c["text"])
        style.map("TCheckbutton", background=[("active", c["bg"])], foreground=[("disabled", c["muted"])])
        style.configure("TEntry", fieldbackground=c["surface"], foreground=c["text"], insertcolor=c["text"])
        style.configure("TCombobox", fieldbackground=c["surface"], background=c["button_bg"], foreground=c["text"], arrowcolor=c["text"])
        style.map("TCombobox", fieldbackground=[("readonly", c["surface"])], foreground=[("readonly", c["text"])])
        style.configure("Treeview", background=c["surface"], fieldbackground=c["surface"], foreground=c["text"], bordercolor=c["border"])
        style.configure("Treeview.Heading", background=c["button_bg"], foreground=c["text"])
        style.map("Treeview", background=[("selected", c["accent"])], foreground=[("selected", "#ffffff")])
        style.configure("Horizontal.TProgressbar", background=c["warn"], troughcolor=c["panel"], bordercolor=c["border"], lightcolor=c["warn"], darkcolor=c["warn"])
    def _apply_theme(self):
        self._refresh_theme_colors()
        self._configure_ttk_theme()
        if hasattr(self, "graph_canvases"):
            for canvas in self.graph_canvases.values():
                canvas.configure(bg=self.colors["surface"])
        if self.widget_window and self.widget_window.winfo_exists():
            self._apply_widget_theme()
        self._draw_all_graphs()
    def _build_ui(self):
        ttk.Label(self.root, text=APP_NAME, font=("Segoe UI", 16, "bold")).pack(anchor="w", padx=12, pady=(12,4))
        ttk.Label(self.root, text="Local-first AI coding-agent usage telemetry with tray and floating widget views.", wraplength=610).pack(anchor="w", padx=12)
        ttk.Label(self.root, textvariable=self.state_label, font=("Segoe UI", 9, "bold")).pack(anchor="w", padx=12, pady=(6,0))
        self.no_provider_label = ttk.Label(self.root, text="Paused: no provider usage data found yet. Providers without local usage data are hidden.", wraplength=610)
        self.api_frame = ttk.LabelFrame(self.root, text="Provider usage limits") ; self.api_frame.pack(fill="x", padx=12, pady=10)
        ttk.Label(self.api_frame, textvariable=self.rate_label, font=("Segoe UI", 11, "bold"), justify="left").pack(anchor="w", padx=10, pady=8)
        self.graph_frame = ttk.LabelFrame(self.root, text="Rolling 5-hour graphs")
        self.graph_frame.pack(fill="x", padx=12, pady=4)
        self.graph_canvases: Dict[str, tk.Canvas] = {}
        graph_grid = ttk.Frame(self.graph_frame); graph_grid.pack(fill="x", padx=8, pady=8)
        for idx, key in enumerate(["session", "velocity", "burn", "io"]):
            canvas = tk.Canvas(graph_grid, height=105, bg=self.colors["surface"], highlightthickness=0)
            canvas.grid(row=idx // 2, column=idx % 2, sticky="ew", padx=4, pady=4)
            canvas.bind("<Configure>", lambda e: self._draw_all_graphs())
            self.graph_canvases[key] = canvas
        graph_grid.columnconfigure(0, weight=1); graph_grid.columnconfigure(1, weight=1)
        self.timeline_frame = ttk.LabelFrame(self.root, text="Session Timeline")
        self.timeline_frame.pack(fill="x", padx=12, pady=4)
        columns = ("timestamp", "tokens", "split", "pct")
        self.timeline_tree = ttk.Treeview(self.timeline_frame, columns=columns, show="headings", height=5)
        self.timeline_tree.heading("timestamp", text="Timestamp")
        self.timeline_tree.heading("tokens", text="Estimated tokens")
        self.timeline_tree.heading("split", text="Input / Output")
        self.timeline_tree.heading("pct", text="Usage increase")
        self.timeline_tree.column("timestamp", width=155, anchor="w")
        self.timeline_tree.column("tokens", width=135, anchor="e")
        self.timeline_tree.column("split", width=160, anchor="e")
        self.timeline_tree.column("pct", width=120, anchor="e")
        self.timeline_tree.pack(fill="x", padx=8, pady=8)
        self.local_totals_frame = ttk.LabelFrame(self.root, text="Local token totals fallback") ; self.local_totals_frame.pack(fill="both", expand=True, padx=12, pady=4)
        for k in ["session", "today", "week", "all"]:
            self.labels[k] = tk.StringVar(value="Scanning...")
            ttk.Label(self.local_totals_frame, text=k.title(), font=("Segoe UI", 10, "bold")).pack(anchor="w", padx=10, pady=(8,0))
            ttk.Label(self.local_totals_frame, textvariable=self.labels[k]).pack(anchor="w", padx=10)
        ttk.Label(self.root, textvariable=self.status).pack(anchor="w", padx=12, pady=4)
        btn = ttk.Frame(self.root); btn.pack(fill="x", padx=12, pady=10)
        ttk.Button(btn, text="Refresh", command=self.refresh).pack(side="left")
        ttk.Button(btn, text="Settings", command=self.settings).pack(side="left", padx=6)
        ttk.Button(btn, text="Show Widget", command=self.show_desktop_widget).pack(side="left")
        ttk.Button(btn, text="Open Provider Usage Page", command=lambda:webbrowser.open("https://claude.ai/settings/usage")).pack(side="left", padx=6)
        ttk.Button(btn, text="Open Debug Log", command=lambda: os.startfile(str(DEBUG_LOG)) if DEBUG_LOG.exists() else messagebox.showinfo("Debug log", str(DEBUG_LOG))).pack(side="left", padx=6)
    def _set_provider_sections_visible(self, visible: bool):
        frames = [self.api_frame, self.graph_frame, self.timeline_frame, self.local_totals_frame]
        if visible:
            if self.no_provider_label.winfo_ismapped():
                self.no_provider_label.pack_forget()
            for frame in frames:
                if not frame.winfo_ismapped():
                    frame.pack(fill="x" if frame is not self.local_totals_frame else "both", expand=(frame is self.local_totals_frame), padx=12, pady=4)
        else:
            for frame in frames:
                if frame.winfo_ismapped():
                    frame.pack_forget()
            if not self.no_provider_label.winfo_ismapped():
                self.no_provider_label.pack(anchor="w", padx=12, pady=10)
    def _start_tray(self):
        if pystray is None:
            log("pystray/Pillow unavailable; no tray icon")
            return
        def open_panel(icon=None, item=None): self.root.after(0, self.toggle_panel)
        def open_app(icon=None, item=None): self.root.after(0, self.show_window)
        def open_widget(icon=None, item=None): self.root.after(0, self.show_desktop_widget)
        def quit_app(icon=None, item=None): self.root.after(0, self.quit)
        menu = pystray.Menu(
            pystray.MenuItem("Usage summary", open_panel, default=True),
            pystray.MenuItem("Open app", open_app),
            pystray.MenuItem("Show desktop widget", open_widget),
            pystray.MenuItem("Quit", quit_app),
        )
        self.icon = pystray.Icon("simple_ai_usage_monitor", make_icon(), APP_NAME, menu)
        self.icon.run_detached()
        log("pystray icon started")
    def _tokens_for_pct(self, t): return t.total_with_cache if self.config.get("include_cache_tokens") else t.visible_tokens
    def refresh(self):
        if self._refreshing: return
        self._refreshing=True; self.app_state="loading"; self._update_state_text(); self._start_spin(); threading.Thread(target=self._scan_thread, daemon=True).start()
    def _start_spin(self):
        self.spin_until = time.time() + 1.4
        self._spin_tick()
    def _spin_tick(self):
        if getattr(self, "spin_until", 0) > time.time():
            self.spin_angle = (self.spin_angle + 18) % 360
            self._update_widget_logo(spinning=True)
            if self.icon:
                sp,_,_,_,_ = self._effective(); self.icon.icon = make_icon(self.spin_angle, sp)
            self.root.after(70, self._spin_tick)
        else:
            self._update_widget_logo(spinning=False)
    def _scan_thread(self):
        try:
            for provider in self.providers.values():
                provider.cfg = self.config
            self.visible_providers = visible_provider_adapters(self.providers)
            self.provider = next(iter(self.visible_providers.values()), None)
            if self.provider is None:
                log("no provider usage data found; hiding provider sections")
                totals = {k: UsageTotals() for k in ["session","today","week","all"]}
                record = UsageRecord(
                    provider_name="",
                    timestamp=datetime.now().astimezone(),
                    source="no provider data",
                    error="No provider usage data found.",
                )
                self.q.put((RateLimitUsage.from_record(record), totals, {"session": BurnRateProjection(reason="no provider data"), "week": BurnRateProjection(reason="no provider data")}, [], []))
                return
            self.provider.cfg = self.config
            availability = self.provider.check_availability()
            if not availability.available:
                log(f"{self.provider.display_label} unavailable: {availability.message}")
            snapshot = self.provider.collect_usage_snapshot()
            record, totals = snapshot.record, snapshot.totals
            append_usage_snapshot(record, totals, self.config)
            rate = RateLimitUsage.from_record(record)
            history = query_usage_last_7_days()
            graph_rows = query_usage_last_5_hours()
            burn = self._calculate_burn(rate, history)
            spikes = detect_usage_spikes(graph_rows, bool(self.config.get("include_cache_tokens")))
            self.q.put((rate, totals, burn, graph_rows, spikes))
        except Exception as e:
            log(f"refresh failed: {e!r}")
            totals = {k: UsageTotals() for k in ["session","today","week","all"]}
            record = usage_record_error(str(e))
            append_usage_snapshot(record, totals, self.config)
            self.q.put((RateLimitUsage.from_record(record), totals, {"session": BurnRateProjection(reason="not enough data"), "week": BurnRateProjection(reason="not enough data")}, [], []))
    def _poll(self):
        try:
            while True:
                item = self.q.get_nowait(); self._refreshing=False
                if len(item) == 2:
                    r,t = item; burn = {"session": BurnRateProjection(), "week": BurnRateProjection()}; graph_rows = []; spikes = []
                elif len(item) == 3:
                    r,t,burn = item; graph_rows = []; spikes = []
                elif len(item) == 4:
                    r,t,burn,graph_rows = item
                    spikes = []
                else:
                    r,t,burn,graph_rows,spikes = item
                self._update(r,t,burn,graph_rows,spikes)
        except queue.Empty: pass
        self.root.after(500, self._poll)
    def _scheduled(self):
        if self._theme_mode() == "system":
            self._apply_theme()
        self.refresh(); self.root.after(max(1,int(self.config.get("refresh_seconds",10)))*1000, self._scheduled)
    def _effective(self):
        r = self.last_rate
        sp = r.session_pct if r.session_pct is not None else pct(self._tokens_for_pct(self.last_totals["session"]), int(self.config.get("session_budget_tokens",0)))
        wp = r.weekly_pct if r.weekly_pct is not None else pct(self._tokens_for_pct(self.last_totals["week"]), int(self.config.get("weekly_budget_tokens",0)))
        return max(0,min(100,float(sp))), max(0,min(100,float(wp))), countdown(r.session_reset), countdown(r.weekly_reset), r.source if not r.error else "local estimate"
    def _state_text(self) -> str:
        labels = {
            "loading": "Loading: refreshing usage data",
            "paused": "Paused: no provider data available",
            "error": "Error: using safe fallback estimates",
            "ready": "Live: usage data available",
        }
        return labels.get(self.app_state, "Loading: refreshing usage data")
    def _update_state_text(self):
        self.state_label.set(self._state_text())
        if hasattr(self, "widget_vars"):
            self.widget_vars["state"].set(self._state_text())
    def _calculate_burn(self, rate: RateLimitUsage, history: List[Dict[str, Any]]) -> Dict[str, BurnRateProjection]:
        include_cache = bool(self.config.get("include_cache_tokens"))
        return {
            "session": calculate_burn_rate(history, "session", "session_usage_pct", rate.session_pct, rate.session_reset, include_cache),
            "week": calculate_burn_rate(history, "week", "weekly_usage_pct", rate.weekly_pct, rate.weekly_reset, include_cache),
        }
    def _burn_summary(self) -> str:
        s = self.last_burn.get("session", BurnRateProjection())
        w = self.last_burn.get("week", BurnRateProjection())
        return (
            f"Burn: {fmt_rate(s.rate_per_minute, '/min')} ({fmt_rate(s.rate_per_hour, '/hr')}) | "
            f"session limit in {fmt_duration(s.time_until_limit, s.reason)}\n"
            f"Weekly pace: {fmt_rate(w.pct_per_hour, '%/hr')} | weekly limit in {fmt_duration(w.time_until_limit, w.reason)}"
        )
    def _forecast_lines(self) -> List[str]:
        s = self.last_burn.get("session", BurnRateProjection())
        w = self.last_burn.get("week", BurnRateProjection())
        lines: List[str] = []
        if s.time_until_limit is not None:
            lines.append(f"At current usage, session limit in {fmt_forecast_duration(s.time_until_limit)}")
        if w.time_until_limit is not None:
            lines.append(f"At current usage, weekly limit in {fmt_forecast_duration(w.time_until_limit, weekly=True)}")
        return lines or ["Not enough recent data yet"]
    def _forecast_summary(self) -> str:
        return "\n".join(self._forecast_lines())
    def _draw_chart_base(self, c: tk.Canvas, title: str, y_labels: Tuple[str, str]) -> Tuple[int, int, int, int]:
        width = max(1, c.winfo_width())
        height = max(1, c.winfo_height())
        c.delete("all")
        pad_left, pad_right, pad_top, pad_bottom = 40, 12, 22, 22
        plot_w = max(1, width - pad_left - pad_right)
        plot_h = max(1, height - pad_top - pad_bottom)
        left, top = pad_left, pad_top
        right, bottom = pad_left + plot_w, pad_top + plot_h
        colors = self.colors
        c.create_rectangle(left, top, right, bottom, outline=colors["border"], fill=colors["surface"])
        c.create_text(left, 10, text=title, fill=colors["text"], anchor="w", font=("Segoe UI", 8, "bold"))
        c.create_text(8, top, text=y_labels[1], fill=colors["muted"], anchor="w", font=("Segoe UI", 7))
        c.create_text(8, bottom, text=y_labels[0], fill=colors["muted"], anchor="w", font=("Segoe UI", 7))
        c.create_line(left, top, right, top, fill=colors["grid"])
        c.create_line(left, bottom, right, bottom, fill=colors["grid"])
        c.create_text(left, height - 9, text="-5h", fill=colors["muted"], anchor="w", font=("Segoe UI", 7))
        c.create_text(right, height - 9, text="now", fill=colors["muted"], anchor="e", font=("Segoe UI", 7))
        return left, top, right, bottom
    def _draw_empty_chart(self, c: tk.Canvas, title: str):
        width = max(1, c.winfo_width()); height = max(1, c.winfo_height())
        left, top, right, bottom = self._draw_chart_base(c, title, ("0", ""))
        c.create_text((left + right) / 2, (top + bottom) / 2, text="Not enough recent data yet", fill=self.colors["subtle"], font=("Segoe UI", 8))
    def _draw_line_graph(self, key: str, title: str, points: List[Tuple[datetime, float]], color: str, suffix: str = "", fixed_max: Optional[float] = None):
        c = self.graph_canvases.get(key)
        if not c: return
        now = datetime.now().astimezone()
        start = now - timedelta(hours=5)
        points = [(ts, max(0.0, value)) for ts, value in points if ts >= start]
        if len(points) < 2:
            self._draw_empty_chart(c, title)
            return
        max_value = fixed_max if fixed_max is not None else max(value for _, value in points)
        max_value = max(1.0, max_value)
        left, top, right, bottom = self._draw_chart_base(c, title, ("0", f"{max_value:,.0f}{suffix}"))
        plot_w = max(1, right - left); plot_h = max(1, bottom - top)
        window_seconds = max(1, (now - start).total_seconds())
        coords: List[Tuple[float, float]] = []
        for ts, value in points:
            x = left + ((ts - start).total_seconds() / window_seconds) * plot_w
            y = bottom - (min(value, max_value) / max_value) * plot_h
            coords.append((x, y))
        for a, b in zip(coords, coords[1:]):
            c.create_line(a[0], a[1], b[0], b[1], fill=color, width=2)
        current_x, current_y = coords[-1]
        c.create_oval(current_x - 5, current_y - 5, current_x + 5, current_y + 5, fill=self.colors["surface"], outline=color, width=2)
        c.create_text(max(left, current_x - 4), max(10, current_y - 12), text=f"{points[-1][1]:,.1f}{suffix}", fill=self.colors["strong_text"], anchor="e", font=("Segoe UI", 8, "bold"))
    def _draw_dual_line_graph(self, key: str, title: str, first: List[Tuple[datetime, float]], second: List[Tuple[datetime, float]], first_label: str, second_label: str):
        c = self.graph_canvases.get(key)
        if not c: return
        now = datetime.now().astimezone()
        start = now - timedelta(hours=5)
        first = [(ts, max(0.0, value)) for ts, value in first if ts >= start]
        second = [(ts, max(0.0, value)) for ts, value in second if ts >= start]
        if len(first) < 2 and len(second) < 2:
            self._draw_empty_chart(c, title)
            return
        max_value = max([1.0] + [v for _, v in first] + [v for _, v in second])
        left, top, right, bottom = self._draw_chart_base(c, title, ("0", f"{max_value:,.0f}"))
        plot_w = max(1, right - left); plot_h = max(1, bottom - top)
        window_seconds = max(1, (now - start).total_seconds())
        def draw_series(series: List[Tuple[datetime, float]], color: str):
            coords: List[Tuple[float, float]] = []
            for ts, value in series:
                x = left + ((ts - start).total_seconds() / window_seconds) * plot_w
                y = bottom - (min(value, max_value) / max_value) * plot_h
                coords.append((x, y))
            for a, b in zip(coords, coords[1:]):
                c.create_line(a[0], a[1], b[0], b[1], fill=color, width=2)
            if coords:
                x, y = coords[-1]
                c.create_oval(x - 4, y - 4, x + 4, y + 4, fill=self.colors["surface"], outline=color, width=2)
        draw_series(first, self.colors["series_blue"])
        draw_series(second, self.colors["warn"])
        c.create_text(right, 10, text=f"{first_label} / {second_label}", fill=self.colors["subtle"], anchor="e", font=("Segoe UI", 7))
    def _session_pct_points(self) -> List[Tuple[datetime, float]]:
        return history_points(self.last_graph_rows, lambda row: normalize_pct(row.get("session_usage_pct")))
    def _velocity_points(self) -> List[Tuple[datetime, float]]:
        totals = history_points(self.last_graph_rows, lambda row: history_token_total(row, "session", bool(self.config.get("include_cache_tokens"))))
        points: List[Tuple[datetime, float]] = []
        for (prev_ts, prev_value), (ts, value) in zip(totals, totals[1:]):
            elapsed_hours = (ts - prev_ts).total_seconds() / 3600
            if elapsed_hours > 0:
                points.append((ts, max(0.0, value - prev_value) / elapsed_hours))
        return points
    def _burn_trend_points(self) -> List[Tuple[datetime, float]]:
        pct_points = self._session_pct_points()
        points: List[Tuple[datetime, float]] = []
        for (prev_ts, prev_value), (ts, value) in zip(pct_points, pct_points[1:]):
            elapsed_hours = (ts - prev_ts).total_seconds() / 3600
            if elapsed_hours > 0:
                points.append((ts, max(0.0, value - prev_value) / elapsed_hours))
        return points
    def _input_output_points(self) -> Tuple[List[Tuple[datetime, float]], List[Tuple[datetime, float]]]:
        def input_value(row: Dict[str, Any]) -> Optional[int]:
            totals = row.get("totals")
            if isinstance(totals, dict) and isinstance(totals.get("session"), dict):
                return to_int(totals["session"].get("input_tokens"))
            return to_int(row.get("input_tokens"))
        def output_value(row: Dict[str, Any]) -> Optional[int]:
            totals = row.get("totals")
            if isinstance(totals, dict) and isinstance(totals.get("session"), dict):
                return to_int(totals["session"].get("output_tokens"))
            return to_int(row.get("output_tokens"))
        return history_points(self.last_graph_rows, input_value), history_points(self.last_graph_rows, output_value)
    def _draw_all_graphs(self):
        if not hasattr(self, "graph_canvases"): return
        input_points, output_points = self._input_output_points()
        self._draw_line_graph("session", "Session usage", [(ts, min(100.0, value)) for ts, value in self._session_pct_points()], self.colors["warn"], "%", 100.0)
        self._draw_line_graph("velocity", "Hourly token velocity", self._velocity_points(), self.colors["series_blue"], "/hr")
        self._draw_line_graph("burn", "Burn-rate trend", self._burn_trend_points(), self.colors["series_purple"], "%/hr")
        self._draw_dual_line_graph("io", "Input vs output totals", input_points, output_points, "input", "output")
    def _format_spike_split(self, spike: UsageSpike) -> str:
        if spike.input_increase is None and spike.output_increase is None:
            return "n/a"
        return f"{fmt(spike.input_increase or 0)} / {fmt(spike.output_increase or 0)}"
    def _update_timeline(self):
        if not hasattr(self, "timeline_tree"): return
        self.timeline_tree.delete(*self.timeline_tree.get_children())
        if not self.last_spikes:
            self.timeline_tree.insert("", "end", values=("No spikes detected yet", "", "", ""))
            return
        for spike in self.last_spikes:
            pct_text = "n/a" if spike.pct_increase is None else f"+{spike.pct_increase:.1f}%"
            self.timeline_tree.insert(
                "",
                "end",
                values=(
                    spike.timestamp.astimezone().strftime("%Y-%m-%d %H:%M:%S"),
                    f"+{fmt(spike.token_increase)}",
                    self._format_spike_split(spike),
                    pct_text,
                ),
            )
    def _update(self, r, totals, burn, graph_rows, spikes):
        self.last_rate, self.last_totals, self.last_burn, self.last_graph_rows, self.last_spikes = r, totals, burn, graph_rows, spikes
        self._set_provider_sections_visible(bool(self.provider))
        self.app_state = "paused" if self.provider is None else "error" if r.error else "ready"
        self._update_state_text()
        sp, wp, sr, wr, src = self._effective()
        if self.provider is None:
            self.rate_label.set("Paused\nNo provider usage data found yet. Configure a local provider source or wait for the next status update.")
            self.status.set(f"Updated {datetime.now().strftime('%H:%M:%S')} | Paused | No provider usage data found")
            if self.icon:
                self.icon.title = f"{APP_NAME}\nPaused: no provider data"
                self.icon.icon = make_icon(self.spin_angle, sp)
            if self.panel_window and self.panel_window.winfo_exists(): self._update_panel()
            if self.widget_window and self.widget_window.winfo_exists(): self._update_widget()
            return
        if r.error:
            self.rate_label.set(f"Error\nProvider data unavailable: {r.error}\nFallback: Session {sp:.1f}% | Week {wp:.1f}%\n{self._forecast_summary()}")
        else:
            self.rate_label.set(f"Session / 5-hour limit: {sp:.1f}% used - resets in {sr}\nWeekly / 7-day limit: {wp:.1f}% used - resets in {wr}\n{self._forecast_summary()}\nSource: {src}")
        for k,t in totals.items():
            self.labels[k].set(f"In: {fmt(t.input_tokens)} | Out: {fmt(t.output_tokens)} | Cache: {fmt(t.cache_creation_input_tokens+t.cache_read_input_tokens)} | Requests: {fmt(t.requests)}")
        self.status.set(f"Updated {datetime.now().strftime('%H:%M:%S')} | Tray: {'started' if self.icon else 'not available'} | Statusline file: {STATUSLINE_LATEST}")
        self._draw_all_graphs()
        self._update_timeline()
        if self.icon:
            self.icon.title = f"{APP_NAME}\nSession {sp:.1f}% resets {sr}\nWeek {wp:.1f}% resets {wr}"
            self.icon.icon = make_icon(self.spin_angle, sp)
        if self.panel_window and self.panel_window.winfo_exists(): self._update_panel()
        if self.widget_window and self.widget_window.winfo_exists(): self._update_widget()
    def show_panel(self):
        w = tk.Toplevel(self.root); self.panel_window = w; w.title("Usage Summary"); w.resizable(False,False); w.attributes("-topmost", True); w.configure(bg=self.colors["bg"], padx=14,pady=12)
        ttk.Label(w, text=APP_NAME, font=("Segoe UI", 13, "bold")).pack(anchor="w")
        self.panel_vars["state"] = tk.StringVar(value=self._state_text()); ttk.Label(w,textvariable=self.panel_vars["state"],font=("Segoe UI",8,"bold")).pack(anchor="w")
        def sec(key,title):
            f=ttk.LabelFrame(w,text=title); f.pack(fill="x",pady=5)
            self.panel_vars[key]=tk.StringVar(value="—"); self.panel_vars[key+"_reset"]=tk.StringVar(value="—")
            ttk.Label(f,textvariable=self.panel_vars[key],font=("Segoe UI",18,"bold")).pack(anchor="w",padx=10,pady=(6,0))
            b=ttk.Progressbar(f,orient="horizontal",mode="determinate",maximum=100,length=290); b.pack(fill="x",padx=10,pady=5); self.panel_bars[key]=b
            ttk.Label(f,textvariable=self.panel_vars[key+"_reset"]).pack(anchor="w",padx=10,pady=(0,8))
        sec("session","Session / 5-hour limit"); sec("week","Weekly / 7-day limit")
        self.panel_vars["updated"] = tk.StringVar(value=""); ttk.Label(w,textvariable=self.panel_vars["updated"],font=("Segoe UI",8)).pack(anchor="w")
        w.update_idletasks(); x=max(0,w.winfo_screenwidth()-w.winfo_width()-24); y=max(0,w.winfo_screenheight()-w.winfo_height()-64); w.geometry(f"+{x}+{y}")
        w.bind("<Button-1>", lambda e:self.show_window()); w.protocol("WM_DELETE_WINDOW", self.close_panel); self._update_panel()
    def _update_panel(self):
        sp,wp,sr,wr,src = self._effective()
        self.panel_vars["session"].set(f"{sp:.1f}% used"); self.panel_vars["session_reset"].set(f"Resets in: {sr}")
        self.panel_vars["week"].set(f"{wp:.1f}% used"); self.panel_vars["week_reset"].set(f"Resets in: {wr}")
        if "state" in self.panel_vars: self.panel_vars["state"].set(self._state_text())
        self.panel_vars["updated"].set(f"Updated {datetime.now().strftime('%H:%M:%S')} • {src} • click to open app")
        self.panel_bars["session"]["value"] = sp; self.panel_bars["week"]["value"] = wp
    def toggle_panel(self):
        if self.panel_window and self.panel_window.winfo_exists(): self.close_panel()
        else: self.show_panel()
    def close_panel(self):
        if self.panel_window and self.panel_window.winfo_exists(): self.panel_window.destroy()
        self.panel_window=None
    def _widget_mode(self) -> str:
        mode = normalized_widget_mode(self.config.get("widget_display_mode"))
        self.config["widget_display_mode"] = mode
        return mode
    def show_desktop_widget(self):
        if self.widget_window and self.widget_window.winfo_exists():
            self._apply_widget_mode()
            self.widget_window.deiconify(); self.widget_window.lift(); return
        w = tk.Toplevel(self.root); self.widget_window = w; w.title("Usage Widget"); w.resizable(False, False); w.attributes("-topmost", True)
        c = self.colors
        w.configure(bg=c["surface"], padx=10, pady=8)
        glow = tk.Canvas(w, height=8, bg=c["surface"], highlightthickness=0); glow.pack(fill="x", pady=(0,5))
        self.widget_glow_canvas = glow
        top = tk.Frame(w, bg=c["surface"]); top.pack(fill="x")
        self.logo_canvas = tk.Canvas(top, width=38, height=38, bg=c["surface"], highlightthickness=0); self.logo_canvas.pack(side="left", padx=(0,8))
        text = tk.Frame(top, bg=c["surface"]); text.pack(side="left")
        self.widget_title = tk.Label(text, text="SAIUM", fg=c["text"], bg=c["surface"], font=("Segoe UI", 10, "bold")); self.widget_title.pack(anchor="w")
        self.widget_updated = tk.Label(text, text="refreshing…", fg=c["muted"], bg=c["surface"], font=("Segoe UI", 8)); self.widget_updated.pack(anchor="w")
        body = tk.Frame(w, bg=c["surface"]); body.pack(fill="x", pady=(6,0))
        self.widget_vars = {k: tk.StringVar(value="-") for k in ["session","session_reset","week","week_reset","forecast_session","forecast_week","minimal_status","state"]}
        self.widget_vars["state"].set(self._state_text())
        self.widget_rows = {}
        self.widget_reset_labels = {}
        def row(title, var, reset_var):
            f = tk.Frame(body, bg=c["surface"]); f.pack(fill="x", pady=2)
            tk.Label(f, text=title, fg=c["subtle"], bg=c["surface"], font=("Segoe UI", 8, "bold"), width=8, anchor="w").pack(side="left")
            tk.Label(f, textvariable=var, fg=c["strong_text"], bg=c["surface"], font=("Segoe UI", 11, "bold"), width=8, anchor="w").pack(side="left")
            reset_label = tk.Label(f, textvariable=reset_var, fg=c["muted"], bg=c["surface"], font=("Segoe UI", 8), anchor="w")
            reset_label.pack(side="left")
            return f, reset_label
        self.widget_rows["session"], self.widget_reset_labels["session"] = row("Session", self.widget_vars["session"], self.widget_vars["session_reset"])
        self.widget_rows["week"], self.widget_reset_labels["week"] = row("Weekly", self.widget_vars["week"], self.widget_vars["week_reset"])
        state = tk.Frame(w, bg=c["surface"]); state.pack(fill="x", pady=(6,0))
        tk.Label(state, textvariable=self.widget_vars["state"], fg=c["muted"], bg=c["surface"], font=("Segoe UI", 8, "bold"), anchor="w").pack(anchor="w")
        forecast = tk.Frame(w, bg=c["surface"]); forecast.pack(fill="x", pady=(4,0))
        tk.Label(forecast, textvariable=self.widget_vars["forecast_session"], fg=c["text"], bg=c["surface"], font=("Segoe UI", 8), anchor="w").pack(anchor="w")
        tk.Label(forecast, textvariable=self.widget_vars["forecast_week"], fg=c["text"], bg=c["surface"], font=("Segoe UI", 8), anchor="w").pack(anchor="w")
        minimal = tk.Frame(w, bg=c["surface"])
        tk.Label(minimal, textvariable=self.widget_vars["minimal_status"], fg=c["strong_text"], bg=c["surface"], font=("Segoe UI", 11, "bold"), anchor="w").pack(anchor="w")
        self.widget_sections = {"text": text, "body": body, "state": state, "forecast": forecast, "minimal": minimal}
        w.update_idletasks(); x=14; y=max(0,w.winfo_screenheight()-w.winfo_height()-74); w.geometry(f"+{x}+{y}")
        for widget in [w, self.widget_glow_canvas, top, text, body, state, forecast, minimal, self.logo_canvas]: widget.bind("<Double-Button-1>", lambda e:self.show_window())
        self._update_widget()
    def _apply_widget_theme(self):
        if not self.widget_window or not self.widget_window.winfo_exists(): return
        c = self.colors
        def apply(widget):
            if isinstance(widget, (tk.Toplevel, tk.Frame)):
                widget.configure(bg=c["surface"])
            elif isinstance(widget, tk.Canvas):
                widget.configure(bg=c["surface"])
            elif isinstance(widget, tk.Label):
                widget.configure(bg=c["surface"], fg=c["text"])
            for child in widget.winfo_children():
                apply(child)
        apply(self.widget_window)
        if hasattr(self, "widget_title"):
            self.widget_title.configure(fg=c["text"], bg=c["surface"])
        if hasattr(self, "widget_updated"):
            self.widget_updated.configure(fg=c["muted"], bg=c["surface"])
        if hasattr(self, "widget_glow_canvas"):
            self.widget_glow_canvas.configure(bg=c["surface"])
        for label in getattr(self, "widget_reset_labels", {}).values():
            label.configure(fg=c["muted"], bg=c["surface"])
        self._draw_widget_glow()
        self._update_widget_logo()
    def _apply_widget_mode(self):
        if not self.widget_window or not self.widget_window.winfo_exists() or not hasattr(self, "widget_sections"): return
        mode = self._widget_mode()
        text = self.widget_sections["text"]
        body = self.widget_sections["body"]
        state = self.widget_sections["state"]
        forecast = self.widget_sections["forecast"]
        minimal = self.widget_sections["minimal"]
        self.widget_window.title(f"Usage Widget ({mode.title()})")
        if mode == "minimal":
            if text.winfo_ismapped(): text.pack_forget()
            if body.winfo_ismapped(): body.pack_forget()
            if state.winfo_ismapped(): state.pack_forget()
            if forecast.winfo_ismapped(): forecast.pack_forget()
            if not minimal.winfo_ismapped(): minimal.pack(fill="x", pady=(6,0))
        else:
            if minimal.winfo_ismapped(): minimal.pack_forget()
            if not text.winfo_ismapped(): text.pack(side="left")
            if not body.winfo_ismapped(): body.pack(fill="x", pady=(6,0))
            if not state.winfo_ismapped(): state.pack(fill="x", pady=(6,0))
            if mode == "full":
                for label in self.widget_reset_labels.values():
                    if not label.winfo_ismapped(): label.pack(side="left")
                if not forecast.winfo_ismapped(): forecast.pack(fill="x", pady=(6,0))
                if not self.widget_updated.winfo_ismapped(): self.widget_updated.pack(anchor="w")
            else:
                for label in self.widget_reset_labels.values():
                    if label.winfo_ismapped(): label.pack_forget()
                if forecast.winfo_ismapped(): forecast.pack_forget()
                if self.widget_updated.winfo_ismapped(): self.widget_updated.pack_forget()
        self.widget_window.update_idletasks()
        x = self.widget_window.winfo_x()
        y = max(0, self.widget_window.winfo_screenheight() - self.widget_window.winfo_height() - 74)
        self.widget_window.geometry(f"+{x}+{y}")
    def _update_widget_logo(self, spinning=False):
        if not hasattr(self, "logo_canvas") or not self.logo_canvas.winfo_exists(): return
        colors = self.colors
        self._draw_widget_glow()
        c = self.logo_canvas; c.delete("all"); cx=cy=19
        c.create_oval(2,2,36,36, fill=colors["glow"], outline="")
        c.create_oval(5,5,33,33, fill=colors["accent_bg"], outline=colors["accent"], width=2)
        a = math.radians(self.spin_angle); x=cx+math.cos(a)*10; y=cy+math.sin(a)*10
        c.create_arc(9,9,29,29, start=self.spin_angle, extent=110, style="arc", outline=colors["warn"], width=3)
        if spinning:
            c.create_oval(x-3,y-3,x+3,y+3, fill=colors["warn"], outline="")
        c.create_line(13,21,18,14,25,23, fill=colors["strong_text"], width=2, smooth=True)
    def _draw_widget_glow(self):
        if not hasattr(self, "widget_glow_canvas") or not self.widget_glow_canvas.winfo_exists(): return
        c = self.widget_glow_canvas
        colors = self.colors
        width = max(1, c.winfo_width())
        c.delete("all")
        c.create_rectangle(0, 0, width, 8, fill=colors["surface"], outline="")
        c.create_line(10, 4, width - 10, 4, fill=colors["glow"], width=4)
        c.create_line(18, 4, width - 18, 4, fill=colors["accent"], width=1)
    def _update_widget(self):
        sp,wp,sr,wr,src = self._effective()
        self.widget_vars["session"].set(f"{sp:.0f}%")
        self.widget_vars["session_reset"].set(f"resets {sr}")
        self.widget_vars["week"].set(f"{wp:.0f}%")
        self.widget_vars["week_reset"].set(f"resets {wr}")
        self.widget_vars["minimal_status"].set(f"Session {sp:.0f}% | Weekly {wp:.0f}%")
        self.widget_vars["state"].set(self._state_text())
        lines = self._forecast_lines()
        self.widget_vars["forecast_session"].set(lines[0])
        self.widget_vars["forecast_week"].set(lines[1] if len(lines) > 1 else "")
        self.widget_updated.config(text=f"updated {datetime.now().strftime('%H:%M:%S')}")
        self._apply_widget_mode()
        self._update_widget_logo()
    def show_window(self): self.close_panel(); self.root.deiconify(); self.root.lift(); self.root.focus_force()
    def hide_window(self):
        if self.icon: self.root.withdraw()
        else: self.quit()
    def settings(self):
        w=tk.Toplevel(self.root); w.title("Settings"); w.geometry("670x525"); fields={}
        w.configure(bg=self.colors["bg"])
        items=[("refresh_seconds","Refresh seconds"),("claude_log_dir","Claude log folder"),("session_budget_tokens","Local fallback session budget tokens"),("weekly_budget_tokens","Local fallback weekly budget tokens"),("session_hours","Local fallback session window hours")]
        for i,(k,label) in enumerate(items):
            ttk.Label(w,text=label).grid(row=i,column=0,sticky="w",padx=12,pady=8); v=tk.StringVar(value=str(self.config.get(k,""))); fields[k]=v; ttk.Entry(w,textvariable=v,width=58).grid(row=i,column=1,sticky="ew",padx=12,pady=8)
        start=tk.BooleanVar(value=bool(self.config.get("start_minimized",False))); cache=tk.BooleanVar(value=bool(self.config.get("include_cache_tokens",False))); widget=tk.BooleanVar(value=bool(self.config.get("show_desktop_widget",True)))
        widget_mode=tk.StringVar(value=self._widget_mode())
        theme_mode=tk.StringVar(value=self._theme_mode())
        ttk.Label(w,text="Widget display mode").grid(row=5,column=0,sticky="w",padx=12,pady=8)
        ttk.Combobox(w,textvariable=widget_mode,values=WIDGET_DISPLAY_MODES,state="readonly",width=18).grid(row=5,column=1,sticky="w",padx=12,pady=8)
        ttk.Label(w,text="Theme").grid(row=6,column=0,sticky="w",padx=12,pady=8)
        ttk.Combobox(w,textvariable=theme_mode,values=THEME_MODES,state="readonly",width=18).grid(row=6,column=1,sticky="w",padx=12,pady=8)
        ttk.Checkbutton(w,text="Start minimized to tray",variable=start).grid(row=7,column=0,columnspan=2,sticky="w",padx=12,pady=8)
        ttk.Checkbutton(w,text="Show floating desktop widget on startup",variable=widget).grid(row=8,column=0,columnspan=2,sticky="w",padx=12,pady=8)
        ttk.Checkbutton(w,text="Include cache tokens in local estimates",variable=cache).grid(row=9,column=0,columnspan=2,sticky="w",padx=12,pady=8)
        ttk.Label(w,text=f"Config: {CONFIG_PATH}",wraplength=630).grid(row=10,column=0,columnspan=2,sticky="w",padx=12,pady=8)
        def save():
            for k,v in fields.items():
                val=v.get().strip()
                if k != "claude_log_dir":
                    try: val=int(float(val))
                    except Exception: messagebox.showerror("Invalid setting", f"{k} must be a number"); return
                    if k=="refresh_seconds" and val < 1: messagebox.showerror("Invalid setting", "Refresh must be at least 1 second"); return
                self.config[k]=val
            self.config["start_minimized"]=bool(start.get()); self.config["include_cache_tokens"]=bool(cache.get()); self.config["show_desktop_widget"]=bool(widget.get()); self.config["widget_display_mode"]=normalized_widget_mode(widget_mode.get()); self.config["theme_mode"]=normalized_theme_mode(theme_mode.get()); save_config(self.config); w.destroy(); self._apply_theme(); self._apply_widget_mode(); self.refresh()
        ttk.Button(w,text="Save",command=save).grid(row=11,column=1,sticky="e",padx=12,pady=12)
    def quit(self):
        try:
            if self.icon: self.icon.stop()
        except Exception: pass
        self.root.destroy()
    def run(self): self.root.mainloop()

if __name__ == "__main__":
    log("App starting v6")
    App().run()
