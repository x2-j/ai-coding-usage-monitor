from __future__ import annotations
import json, os, shutil
from datetime import datetime
from pathlib import Path

root = Path.home() / ".claude"
root.mkdir(parents=True, exist_ok=True)
settings = root / "settings.json"
script = Path(__file__).resolve().parent / "statusline_capture.py"
python = Path(__file__).resolve().parent / ".venv" / "Scripts" / "python.exe"
cmd = f'"{python}" "{script}"'
if settings.exists():
    backup = settings.with_suffix(f".backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
    shutil.copy2(settings, backup)
    try: data = json.loads(settings.read_text(encoding="utf-8"))
    except Exception: data = {}
else:
    backup = None; data = {}
data["statusLine"] = {"type": "command", "command": cmd, "padding": 1, "refreshInterval": 10}
settings.write_text(json.dumps(data, indent=2), encoding="utf-8")
print("Claude Code statusLine installed.")
print(f"Settings: {settings}")
if backup: print(f"Backup:   {backup}")
print("Now restart Claude Code or send a new message. The tray app will read the captured statusline data.")
