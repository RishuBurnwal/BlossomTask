from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

ROOT_DIR = Path(__file__).resolve().parents[1]
ROOT_ENV_FILE = ROOT_DIR / ".env"
DEFAULT_TIMEZONE = "UTC"


def load_root_env(path: Optional[Path] = None) -> None:
    env_path = Path(path or ROOT_ENV_FILE)
    if not env_path.exists():
        return
    with open(env_path, "r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def get_configured_timezone() -> str:
    configured = str(os.getenv("BLOSSOM_TIMEZONE", "")).strip() or DEFAULT_TIMEZONE
    try:
        ZoneInfo(configured)
    except Exception:
        return DEFAULT_TIMEZONE
    return configured


def get_now() -> datetime:
    return datetime.now(ZoneInfo(get_configured_timezone()))


def get_now_iso() -> str:
    return get_now().isoformat()


def get_date_key() -> str:
    return get_now().date().isoformat()
