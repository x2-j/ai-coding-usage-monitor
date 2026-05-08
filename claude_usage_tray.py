from __future__ import annotations

import json, os, queue, threading, time, math, webbrowser
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import tkinter as tk
from tkinter import ttk, messagebox

try:
    import pystray
    from PIL import Image, ImageDraw
except Exception:
    pystray = None
    Image = None
    ImageDraw = None

APP_NAME = "Claude Code Usage Tray"
CONFIG_DIR = Path(os.environ.get("APPDATA", str(Path.home()))) / "ClaudeCodeUsageTray"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_PATH = CONFIG_DIR / "config.json"
STATUSLINE_LATEST = CONFIG_DIR / "statusline_latest.json"
USAGE_HISTORY_PATH = CONFIG_DIR / "usage_history.jsonl"
DEBUG_LOG = CONFIG_DIR / "debug.log"
DEFAULT_CLAUDE_LOG_DIR = Path.home() / ".claude" / "projects"
USAGE_HISTORY_SCHEMA_VERSION = 1

DEFAULT_CONFIG = {
    "claude_log_dir": str(DEFAULT_CLAUDE_LOG_DIR),
    "refresh_seconds": 10,
    "session_hours": 5,
    "session_budget_tokens": 1000000,
    "weekly_budget_tokens": 10000000,
    "include_cache_tokens": False,
    "start_minimized": False,
    "show_desktop_widget": True,
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
class BurnRateProjection:
    rate_per_minute: Optional[float] = None
    rate_per_hour: Optional[float] = None
    pct_per_hour: Optional[float] = None
    time_until_limit: Optional[timedelta] = None
    reason: Optional[str] = None

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

def make_icon(angle: int = 0, session_pct: float = 0.0):
    if Image is None: return None
    img = Image.new("RGBA", (64,64), (0,0,0,0)); d = ImageDraw.Draw(img)
    d.ellipse((4,4,60,60), fill=(44,36,56,255), outline=(172,132,255,255), width=3)
    # small rotating arc/dot motif, not official logo
    r=18; cx=cy=32; a=math.radians(angle)
    x=cx+math.cos(a)*r; y=cy+math.sin(a)*r
    d.ellipse((x-5,y-5,x+5,y+5), fill=(255,220,130,255))
    d.text((22,19), "C", fill=(255,255,255,255))
    # bottom mini usage bar
    d.rectangle((10,52,54,56), outline=(220,220,220,180))
    d.rectangle((11,53,11+int(42*max(0,min(100,session_pct))/100),55), fill=(255,220,130,255))
    return img

class App:
    def __init__(self):
        self.config = load_config(); self.q = queue.Queue(); self.root = tk.Tk(); self.root.title(APP_NAME); self.root.geometry("760x760")
        self.root.protocol("WM_DELETE_WINDOW", self.hide_window)
        self.labels: Dict[str, tk.StringVar] = {}; self.status = tk.StringVar(); self.rate_label = tk.StringVar(value="Loading...")
        self.panel_window = None; self.widget_window = None; self.panel_vars = {}; self.panel_bars = {}; self.last_rate = RateLimitUsage(); self.last_totals = {k: UsageTotals() for k in ["session","today","week","all"]}
        self.last_burn = {"session": BurnRateProjection(), "week": BurnRateProjection()}
        self.last_graph_rows: List[Dict[str, Any]] = []
        self._refreshing = False; self.icon = None; self.spin_angle = 0
        self._build_ui(); self._start_tray(); self.refresh(); self.root.after(500, self._poll); self.root.after(int(self.config.get("refresh_seconds",10))*1000, self._scheduled)
        if self.config.get("show_desktop_widget", True): self.show_desktop_widget()
        if self.config.get("start_minimized") and self.icon: self.root.withdraw()
    def _build_ui(self):
        ttk.Label(self.root, text="Claude Code Usage", font=("Segoe UI", 16, "bold")).pack(anchor="w", padx=12, pady=(12,4))
        ttk.Label(self.root, text="v6 restores the working pystray icon and reads Claude Code statusline data when available. The compact desktop widget is a floating window, not an official Windows Widgets-board app.", wraplength=610).pack(anchor="w", padx=12)
        api = ttk.LabelFrame(self.root, text="Exact Claude Code limits") ; api.pack(fill="x", padx=12, pady=10)
        ttk.Label(api, textvariable=self.rate_label, font=("Segoe UI", 11, "bold"), justify="left").pack(anchor="w", padx=10, pady=8)
        graph = ttk.LabelFrame(self.root, text="Rolling 5-hour graphs")
        graph.pack(fill="x", padx=12, pady=4)
        self.graph_canvases: Dict[str, tk.Canvas] = {}
        graph_grid = ttk.Frame(graph); graph_grid.pack(fill="x", padx=8, pady=8)
        for idx, key in enumerate(["session", "velocity", "burn", "io"]):
            canvas = tk.Canvas(graph_grid, height=105, bg="#202124", highlightthickness=0)
            canvas.grid(row=idx // 2, column=idx % 2, sticky="ew", padx=4, pady=4)
            canvas.bind("<Configure>", lambda e: self._draw_all_graphs())
            self.graph_canvases[key] = canvas
        graph_grid.columnconfigure(0, weight=1); graph_grid.columnconfigure(1, weight=1)
        loc = ttk.LabelFrame(self.root, text="Local token totals fallback") ; loc.pack(fill="both", expand=True, padx=12, pady=4)
        for k in ["session", "today", "week", "all"]:
            self.labels[k] = tk.StringVar(value="Scanning...")
            ttk.Label(loc, text=k.title(), font=("Segoe UI", 10, "bold")).pack(anchor="w", padx=10, pady=(8,0))
            ttk.Label(loc, textvariable=self.labels[k]).pack(anchor="w", padx=10)
        ttk.Label(self.root, textvariable=self.status).pack(anchor="w", padx=12, pady=4)
        btn = ttk.Frame(self.root); btn.pack(fill="x", padx=12, pady=10)
        ttk.Button(btn, text="Refresh", command=self.refresh).pack(side="left")
        ttk.Button(btn, text="Settings", command=self.settings).pack(side="left", padx=6)
        ttk.Button(btn, text="Show Widget", command=self.show_desktop_widget).pack(side="left")
        ttk.Button(btn, text="Open Usage Page", command=lambda:webbrowser.open("https://claude.ai/settings/usage")).pack(side="left", padx=6)
        ttk.Button(btn, text="Open Debug Log", command=lambda: os.startfile(str(DEBUG_LOG)) if DEBUG_LOG.exists() else messagebox.showinfo("Debug log", str(DEBUG_LOG))).pack(side="left", padx=6)
    def _start_tray(self):
        if pystray is None:
            log("pystray/Pillow unavailable; no tray icon")
            return
        def open_panel(icon=None, item=None): self.root.after(0, self.toggle_panel)
        def open_app(icon=None, item=None): self.root.after(0, self.show_window)
        def open_widget(icon=None, item=None): self.root.after(0, self.show_desktop_widget)
        def quit_app(icon=None, item=None): self.root.after(0, self.quit)
        menu = pystray.Menu(
            pystray.MenuItem("Usage panel", open_panel, default=True),
            pystray.MenuItem("Open app", open_app),
            pystray.MenuItem("Show desktop widget", open_widget),
            pystray.MenuItem("Quit", quit_app),
        )
        self.icon = pystray.Icon("claude_code_usage_tray", make_icon(), APP_NAME, menu)
        self.icon.run_detached()
        log("pystray icon started")
    def _tokens_for_pct(self, t): return t.total_with_cache if self.config.get("include_cache_tokens") else t.visible_tokens
    def refresh(self):
        if self._refreshing: return
        self._refreshing=True; self._start_spin(); threading.Thread(target=self._scan_thread, daemon=True).start()
    def _start_spin(self):
        self.spin_until = time.time() + 1.2
        self._spin_tick()
    def _spin_tick(self):
        if getattr(self, "spin_until", 0) > time.time():
            self.spin_angle = (self.spin_angle + 45) % 360
            self._update_widget_logo(spinning=True)
            if self.icon:
                sp,_,_,_,_ = self._effective(); self.icon.icon = make_icon(self.spin_angle, sp)
            self.root.after(120, self._spin_tick)
        else:
            self._update_widget_logo(spinning=False)
    def _scan_thread(self):
        try:
            record = read_statusline_record()
            totals = scan_usage(self.config)
            append_usage_snapshot(record, totals, self.config)
            rate = RateLimitUsage.from_record(record)
            history = query_usage_last_7_days()
            graph_rows = query_usage_last_5_hours()
            burn = self._calculate_burn(rate, history)
            self.q.put((rate, totals, burn, graph_rows))
        except Exception as e:
            log(f"refresh failed: {e!r}")
            totals = {k: UsageTotals() for k in ["session","today","week","all"]}
            record = usage_record_error(str(e))
            append_usage_snapshot(record, totals, self.config)
            self.q.put((RateLimitUsage.from_record(record), totals, {"session": BurnRateProjection(reason="not enough data"), "week": BurnRateProjection(reason="not enough data")}, []))
    def _poll(self):
        try:
            while True:
                item = self.q.get_nowait(); self._refreshing=False
                if len(item) == 2:
                    r,t = item; burn = {"session": BurnRateProjection(), "week": BurnRateProjection()}; graph_rows = []
                elif len(item) == 3:
                    r,t,burn = item; graph_rows = []
                else:
                    r,t,burn,graph_rows = item
                self._update(r,t,burn,graph_rows)
        except queue.Empty: pass
        self.root.after(500, self._poll)
    def _scheduled(self):
        self.refresh(); self.root.after(max(1,int(self.config.get("refresh_seconds",10)))*1000, self._scheduled)
    def _effective(self):
        r = self.last_rate
        sp = r.session_pct if r.session_pct is not None else pct(self._tokens_for_pct(self.last_totals["session"]), int(self.config.get("session_budget_tokens",0)))
        wp = r.weekly_pct if r.weekly_pct is not None else pct(self._tokens_for_pct(self.last_totals["week"]), int(self.config.get("weekly_budget_tokens",0)))
        return max(0,min(100,float(sp))), max(0,min(100,float(wp))), countdown(r.session_reset), countdown(r.weekly_reset), r.source if not r.error else "local estimate"
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
        c.create_rectangle(left, top, right, bottom, outline="#3a3d42", fill="#202124")
        c.create_text(left, 10, text=title, fill="#f4f4f4", anchor="w", font=("Segoe UI", 8, "bold"))
        c.create_text(8, top, text=y_labels[1], fill="#b8b8b8", anchor="w", font=("Segoe UI", 7))
        c.create_text(8, bottom, text=y_labels[0], fill="#b8b8b8", anchor="w", font=("Segoe UI", 7))
        c.create_line(left, top, right, top, fill="#34373d")
        c.create_line(left, bottom, right, bottom, fill="#34373d")
        c.create_text(left, height - 9, text="-5h", fill="#b8b8b8", anchor="w", font=("Segoe UI", 7))
        c.create_text(right, height - 9, text="now", fill="#b8b8b8", anchor="e", font=("Segoe UI", 7))
        return left, top, right, bottom
    def _draw_empty_chart(self, c: tk.Canvas, title: str):
        width = max(1, c.winfo_width()); height = max(1, c.winfo_height())
        left, top, right, bottom = self._draw_chart_base(c, title, ("0", ""))
        c.create_text((left + right) / 2, (top + bottom) / 2, text="Not enough recent data yet", fill="#d6d6d6", font=("Segoe UI", 8))
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
        c.create_oval(current_x - 5, current_y - 5, current_x + 5, current_y + 5, fill="#ffffff", outline=color, width=2)
        c.create_text(max(left, current_x - 4), max(10, current_y - 12), text=f"{points[-1][1]:,.1f}{suffix}", fill="#ffffff", anchor="e", font=("Segoe UI", 8, "bold"))
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
                c.create_oval(x - 4, y - 4, x + 4, y + 4, fill="#ffffff", outline=color, width=2)
        draw_series(first, "#8bd3ff")
        draw_series(second, "#ffd97a")
        c.create_text(right, 10, text=f"{first_label} / {second_label}", fill="#d6d6d6", anchor="e", font=("Segoe UI", 7))
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
        self._draw_line_graph("session", "Session usage", [(ts, min(100.0, value)) for ts, value in self._session_pct_points()], "#ffd97a", "%", 100.0)
        self._draw_line_graph("velocity", "Hourly token velocity", self._velocity_points(), "#8bd3ff", "/hr")
        self._draw_line_graph("burn", "Burn-rate trend", self._burn_trend_points(), "#d9a7ff", "%/hr")
        self._draw_dual_line_graph("io", "Input vs output totals", input_points, output_points, "input", "output")
    def _update(self, r, totals, burn, graph_rows):
        self.last_rate, self.last_totals, self.last_burn, self.last_graph_rows = r, totals, burn, graph_rows
        sp, wp, sr, wr, src = self._effective()
        if r.error:
            self.rate_label.set(f"Exact statusline data unavailable\n{r.error}\nFallback: Session {sp:.1f}% | Week {wp:.1f}%\n{self._forecast_summary()}")
        else:
            self.rate_label.set(f"Session / 5-hour limit: {sp:.1f}% used - resets in {sr}\nWeekly / 7-day limit: {wp:.1f}% used - resets in {wr}\n{self._forecast_summary()}\nSource: {src}")
        for k,t in totals.items():
            self.labels[k].set(f"In: {fmt(t.input_tokens)} | Out: {fmt(t.output_tokens)} | Cache: {fmt(t.cache_creation_input_tokens+t.cache_read_input_tokens)} | Requests: {fmt(t.requests)}")
        self.status.set(f"Updated {datetime.now().strftime('%H:%M:%S')} | Tray: {'started' if self.icon else 'not available'} | Statusline file: {STATUSLINE_LATEST}")
        self._draw_all_graphs()
        if self.icon:
            self.icon.title = f"Claude Code Usage\nSession {sp:.1f}% resets {sr}\nWeek {wp:.1f}% resets {wr}"
            self.icon.icon = make_icon(self.spin_angle, sp)
        if self.panel_window and self.panel_window.winfo_exists(): self._update_panel()
        if self.widget_window and self.widget_window.winfo_exists(): self._update_widget()
    def show_panel(self):
        w = tk.Toplevel(self.root); self.panel_window = w; w.title("Claude Usage"); w.resizable(False,False); w.attributes("-topmost", True); w.configure(padx=14,pady=12)
        ttk.Label(w, text="Claude Code Usage", font=("Segoe UI", 13, "bold")).pack(anchor="w")
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
        self.panel_vars["updated"].set(f"Updated {datetime.now().strftime('%H:%M:%S')} • {src} • click to open app")
        self.panel_bars["session"]["value"] = sp; self.panel_bars["week"]["value"] = wp
    def toggle_panel(self):
        if self.panel_window and self.panel_window.winfo_exists(): self.close_panel()
        else: self.show_panel()
    def close_panel(self):
        if self.panel_window and self.panel_window.winfo_exists(): self.panel_window.destroy()
        self.panel_window=None
    def show_desktop_widget(self):
        if self.widget_window and self.widget_window.winfo_exists():
            self.widget_window.deiconify(); self.widget_window.lift(); return
        w = tk.Toplevel(self.root); self.widget_window = w; w.title("Claude Widget"); w.resizable(False, False); w.attributes("-topmost", True)
        w.configure(bg="#202124", padx=10, pady=8)
        top = tk.Frame(w, bg="#202124"); top.pack(fill="x")
        self.logo_canvas = tk.Canvas(top, width=38, height=38, bg="#202124", highlightthickness=0); self.logo_canvas.pack(side="left", padx=(0,8))
        text = tk.Frame(top, bg="#202124"); text.pack(side="left")
        self.widget_title = tk.Label(text, text="Claude Code", fg="#f4f4f4", bg="#202124", font=("Segoe UI", 10, "bold")); self.widget_title.pack(anchor="w")
        self.widget_updated = tk.Label(text, text="refreshing…", fg="#b8b8b8", bg="#202124", font=("Segoe UI", 8)); self.widget_updated.pack(anchor="w")
        body = tk.Frame(w, bg="#202124"); body.pack(fill="x", pady=(6,0))
        self.widget_vars = {k: tk.StringVar(value="—") for k in ["session","session_reset","week","week_reset","forecast_session","forecast_week"]}
        def row(title, var, reset_var):
            f = tk.Frame(body, bg="#202124"); f.pack(fill="x", pady=2)
            tk.Label(f, text=title, fg="#d6d6d6", bg="#202124", font=("Segoe UI", 8, "bold"), width=8, anchor="w").pack(side="left")
            tk.Label(f, textvariable=var, fg="#ffffff", bg="#202124", font=("Segoe UI", 11, "bold"), width=8, anchor="w").pack(side="left")
            tk.Label(f, textvariable=reset_var, fg="#b8b8b8", bg="#202124", font=("Segoe UI", 8), anchor="w").pack(side="left")
        row("Session", self.widget_vars["session"], self.widget_vars["session_reset"])
        row("Weekly", self.widget_vars["week"], self.widget_vars["week_reset"])
        forecast = tk.Frame(w, bg="#202124"); forecast.pack(fill="x", pady=(6,0))
        tk.Label(forecast, textvariable=self.widget_vars["forecast_session"], fg="#f4f4f4", bg="#202124", font=("Segoe UI", 8), anchor="w").pack(anchor="w")
        tk.Label(forecast, textvariable=self.widget_vars["forecast_week"], fg="#f4f4f4", bg="#202124", font=("Segoe UI", 8), anchor="w").pack(anchor="w")
        w.update_idletasks(); x=14; y=max(0,w.winfo_screenheight()-w.winfo_height()-74); w.geometry(f"+{x}+{y}")
        for widget in [w, top, text, body, forecast, self.logo_canvas]: widget.bind("<Double-Button-1>", lambda e:self.show_window())
        self._update_widget()
    def _update_widget_logo(self, spinning=False):
        if not hasattr(self, "logo_canvas") or not self.logo_canvas.winfo_exists(): return
        c = self.logo_canvas; c.delete("all"); cx=cy=19; c.create_oval(3,3,35,35, fill="#2b2438", outline="#ac84ff", width=2)
        a = math.radians(self.spin_angle); x=cx+math.cos(a)*10; y=cy+math.sin(a)*10
        c.create_oval(x-4,y-4,x+4,y+4, fill="#ffd97a", outline="")
        c.create_text(cx, cy, text="C", fill="white", font=("Segoe UI", 13, "bold"))
    def _update_widget(self):
        sp,wp,sr,wr,src = self._effective()
        self.widget_vars["session"].set(f"{sp:.0f}%")
        self.widget_vars["session_reset"].set(f"resets {sr}")
        self.widget_vars["week"].set(f"{wp:.0f}%")
        self.widget_vars["week_reset"].set(f"resets {wr}")
        lines = self._forecast_lines()
        self.widget_vars["forecast_session"].set(lines[0])
        self.widget_vars["forecast_week"].set(lines[1] if len(lines) > 1 else "")
        self.widget_updated.config(text=f"updated {datetime.now().strftime('%H:%M:%S')}")
        self._update_widget_logo()
    def show_window(self): self.close_panel(); self.root.deiconify(); self.root.lift(); self.root.focus_force()
    def hide_window(self):
        if self.icon: self.root.withdraw()
        else: self.quit()
    def settings(self):
        w=tk.Toplevel(self.root); w.title("Settings"); w.geometry("670x440"); fields={}
        items=[("refresh_seconds","Refresh seconds"),("claude_log_dir","Claude log folder"),("session_budget_tokens","Local fallback session budget tokens"),("weekly_budget_tokens","Local fallback weekly budget tokens"),("session_hours","Local fallback session window hours")]
        for i,(k,label) in enumerate(items):
            ttk.Label(w,text=label).grid(row=i,column=0,sticky="w",padx=12,pady=8); v=tk.StringVar(value=str(self.config.get(k,""))); fields[k]=v; ttk.Entry(w,textvariable=v,width=58).grid(row=i,column=1,sticky="ew",padx=12,pady=8)
        start=tk.BooleanVar(value=bool(self.config.get("start_minimized",False))); cache=tk.BooleanVar(value=bool(self.config.get("include_cache_tokens",False))); widget=tk.BooleanVar(value=bool(self.config.get("show_desktop_widget",True)))
        ttk.Checkbutton(w,text="Start minimized to tray",variable=start).grid(row=6,column=0,columnspan=2,sticky="w",padx=12,pady=8)
        ttk.Checkbutton(w,text="Show floating desktop widget on startup",variable=widget).grid(row=7,column=0,columnspan=2,sticky="w",padx=12,pady=8)
        ttk.Checkbutton(w,text="Include cache tokens in local estimates",variable=cache).grid(row=8,column=0,columnspan=2,sticky="w",padx=12,pady=8)
        ttk.Label(w,text=f"Config: {CONFIG_PATH}",wraplength=630).grid(row=9,column=0,columnspan=2,sticky="w",padx=12,pady=8)
        def save():
            for k,v in fields.items():
                val=v.get().strip()
                if k != "claude_log_dir":
                    try: val=int(float(val))
                    except Exception: messagebox.showerror("Invalid setting", f"{k} must be a number"); return
                    if k=="refresh_seconds" and val < 1: messagebox.showerror("Invalid setting", "Refresh must be at least 1 second"); return
                self.config[k]=val
            self.config["start_minimized"]=bool(start.get()); self.config["include_cache_tokens"]=bool(cache.get()); self.config["show_desktop_widget"]=bool(widget.get()); save_config(self.config); w.destroy(); self.refresh()
        ttk.Button(w,text="Save",command=save).grid(row=10,column=1,sticky="e",padx=12,pady=12)
    def quit(self):
        try:
            if self.icon: self.icon.stop()
        except Exception: pass
        self.root.destroy()
    def run(self): self.root.mainloop()

if __name__ == "__main__":
    log("App starting v6")
    App().run()
