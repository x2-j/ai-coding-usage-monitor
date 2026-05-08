from __future__ import annotations
import json, os, sys
from datetime import datetime, timezone
from pathlib import Path

config_dir = Path(os.environ.get("APPDATA", str(Path.home()))) / "ClaudeCodeUsageTray"
config_dir.mkdir(parents=True, exist_ok=True)
latest = config_dir / "statusline_latest.json"
try:
    raw_text = sys.stdin.read()
    data = json.loads(raw_text) if raw_text.strip() else {}
    latest.write_text(json.dumps({"captured_at": datetime.now(timezone.utc).isoformat(), "raw": data}, indent=2), encoding="utf-8")
    rl = data.get("rate_limits") or {}
    five = rl.get("five_hour") or rl.get("session") or {}
    seven = rl.get("seven_day") or rl.get("weekly") or {}
    sp = five.get("used_percentage", five.get("utilization", 0)) if isinstance(five, dict) else 0
    wp = seven.get("used_percentage", seven.get("utilization", 0)) if isinstance(seven, dict) else 0
    print(f"Claude usage: 5h {float(sp):.0f}% | 7d {float(wp):.0f}%")
except Exception as e:
    try: (config_dir / "statusline_error.log").write_text(repr(e), encoding="utf-8")
    except Exception: pass
    print("Claude usage: statusline capture error")
