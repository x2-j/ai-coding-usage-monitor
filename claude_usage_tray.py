from __future__ import annotations

import json, os, queue, threading, time, math, webbrowser
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

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
DEBUG_LOG = CONFIG_DIR / "debug.log"
DEFAULT_CLAUDE_LOG_DIR = Path.home() / ".claude" / "projects"

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
        self.config = load_config(); self.q = queue.Queue(); self.root = tk.Tk(); self.root.title(APP_NAME); self.root.geometry("650x560")
        self.root.protocol("WM_DELETE_WINDOW", self.hide_window)
        self.labels: Dict[str, tk.StringVar] = {}; self.status = tk.StringVar(); self.rate_label = tk.StringVar(value="Loading...")
        self.panel_window = None; self.widget_window = None; self.panel_vars = {}; self.panel_bars = {}; self.last_rate = RateLimitUsage(); self.last_totals = {k: UsageTotals() for k in ["session","today","week","all"]}
        self._refreshing = False; self.icon = None; self.spin_angle = 0
        self._build_ui(); self._start_tray(); self.refresh(); self.root.after(500, self._poll); self.root.after(int(self.config.get("refresh_seconds",10))*1000, self._scheduled)
        if self.config.get("show_desktop_widget", True): self.show_desktop_widget()
        if self.config.get("start_minimized") and self.icon: self.root.withdraw()
    def _build_ui(self):
        ttk.Label(self.root, text="Claude Code Usage", font=("Segoe UI", 16, "bold")).pack(anchor="w", padx=12, pady=(12,4))
        ttk.Label(self.root, text="v6 restores the working pystray icon and reads Claude Code statusline data when available. The compact desktop widget is a floating window, not an official Windows Widgets-board app.", wraplength=610).pack(anchor="w", padx=12)
        api = ttk.LabelFrame(self.root, text="Exact Claude Code limits") ; api.pack(fill="x", padx=12, pady=10)
        ttk.Label(api, textvariable=self.rate_label, font=("Segoe UI", 11, "bold"), justify="left").pack(anchor="w", padx=10, pady=8)
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
        try: self.q.put((read_statusline_usage(), scan_usage(self.config)))
        except Exception as e: log(f"refresh failed: {e!r}"); self.q.put((RateLimitUsage(error=str(e)), {k: UsageTotals() for k in ["session","today","week","all"]}))
    def _poll(self):
        try:
            while True:
                r,t = self.q.get_nowait(); self._refreshing=False; self._update(r,t)
        except queue.Empty: pass
        self.root.after(500, self._poll)
    def _scheduled(self):
        self.refresh(); self.root.after(max(1,int(self.config.get("refresh_seconds",10)))*1000, self._scheduled)
    def _effective(self):
        r = self.last_rate
        sp = r.session_pct if r.session_pct is not None else pct(self._tokens_for_pct(self.last_totals["session"]), int(self.config.get("session_budget_tokens",0)))
        wp = r.weekly_pct if r.weekly_pct is not None else pct(self._tokens_for_pct(self.last_totals["week"]), int(self.config.get("weekly_budget_tokens",0)))
        return max(0,min(100,float(sp))), max(0,min(100,float(wp))), countdown(r.session_reset), countdown(r.weekly_reset), r.source if not r.error else "local estimate"
    def _update(self, r, totals):
        self.last_rate, self.last_totals = r, totals
        sp, wp, sr, wr, src = self._effective()
        if r.error:
            self.rate_label.set(f"Exact statusline data unavailable\n{r.error}\nFallback: Session {sp:.1f}% | Week {wp:.1f}%")
        else:
            self.rate_label.set(f"Session / 5-hour limit: {sp:.1f}% used — resets in {sr}\nWeekly / 7-day limit: {wp:.1f}% used — resets in {wr}\nSource: {src}")
        for k,t in totals.items():
            self.labels[k].set(f"In: {fmt(t.input_tokens)} | Out: {fmt(t.output_tokens)} | Cache: {fmt(t.cache_creation_input_tokens+t.cache_read_input_tokens)} | Requests: {fmt(t.requests)}")
        self.status.set(f"Updated {datetime.now().strftime('%H:%M:%S')} | Tray: {'started' if self.icon else 'not available'} | Statusline file: {STATUSLINE_LATEST}")
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
        self.widget_vars = {k: tk.StringVar(value="—") for k in ["session","session_reset","week","week_reset"]}
        def row(title, var, reset_var):
            f = tk.Frame(body, bg="#202124"); f.pack(fill="x", pady=2)
            tk.Label(f, text=title, fg="#d6d6d6", bg="#202124", font=("Segoe UI", 8, "bold"), width=8, anchor="w").pack(side="left")
            tk.Label(f, textvariable=var, fg="#ffffff", bg="#202124", font=("Segoe UI", 11, "bold"), width=8, anchor="w").pack(side="left")
            tk.Label(f, textvariable=reset_var, fg="#b8b8b8", bg="#202124", font=("Segoe UI", 8), anchor="w").pack(side="left")
        row("Session", self.widget_vars["session"], self.widget_vars["session_reset"])
        row("Weekly", self.widget_vars["week"], self.widget_vars["week_reset"])
        w.update_idletasks(); x=14; y=max(0,w.winfo_screenheight()-w.winfo_height()-74); w.geometry(f"+{x}+{y}")
        for widget in [w, top, text, body, self.logo_canvas]: widget.bind("<Double-Button-1>", lambda e:self.show_window())
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
