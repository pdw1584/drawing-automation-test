from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent.parent
STATIC_ROOT = ROOT / "dist" if (ROOT / "dist" / "index.html").is_file() else ROOT
MAX_UPLOAD = int(os.environ.get("DRAWING_AUTOMATION_MAX_UPLOAD", "0"))
