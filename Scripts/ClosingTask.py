import csv
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Set

import requests
from Updater import _build_tr_text, _clean, _match_score, _resolved_status

SCRIPT_DIR = Path(__file__).resolve().parent
ENV_PATH = SCRIPT_DIR / ".env"
DEFAULT_INPUT = SCRIPT_DIR / "outputs" / "Updater" / "updater_payloads.jsonl"
LOG_DIR = SCRIPT_DIR / "outputs" / "ClosingTask"
PROCESSED_LOG = LOG_DIR / "closing_task_processed.log"
RUN_LOG_PATH = LOG_DIR / "closing_task_run.log"
PAYLOAD_LOG_PATH = LOG_DIR / "closing_task_payloads.jsonl"
CSV_LOG_PATH = LOG_DIR / "closing_task_payloads.csv"


def _parse_env_file(path: Path) -> Dict[str, str]:
    if not path.exists():
        return {}
    env_map: Dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        env_map[key.strip()] = value.strip()
    return env_map


def _env(key: str, default: str = "") -> str:
    env_map = _parse_env_file(ENV_PATH)
    return os.getenv(key) or env_map.get(key, default)


def _required_env(key: str) -> str:
    value = _env(key)
    if not value:
        raise SystemExit(f"Missing required env var: {key}")
    return value


def _load_processed_ids(path: Path) -> Set[str]:
    if not path.exists():
        return set()
    return {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}


def _append_processed_id(path: Path, ord_id: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(f"{ord_id}\n")


def _append_run_log(message: str) -> None:
    RUN_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.utcnow().isoformat()
    with RUN_LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(f"[{timestamp}] {message}\n")


def _append_payload_log(payload: Dict[str, str]) -> None:
    PAYLOAD_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with PAYLOAD_LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")


def _append_csv_log(payload: Dict[str, str]) -> None:
    CSV_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    headers = ["ord_id", "trSubject", "toNameID", "trText"]
    write_header = not CSV_LOG_PATH.exists()
    with CSV_LOG_PATH.open("a", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        if write_header:
            writer.writeheader()
        writer.writerow({key: payload.get(key, "") for key in headers})


def _build_close_text(row: Dict[str, str]) -> str:
    # Use trResult from updater payloads as the closing note
    tr_result = _clean(row.get("trResult"))
    if tr_result:
        return tr_result

    status = _resolved_status(row)
    score = _match_score(row)
    notes = _build_tr_text(row)

    parts = [f"Status={status}"]
    if score and score != "N/A":
        parts.append(f"Match Score={score}")
    if notes and notes != "N/A":
        parts.append(f"Notes: {notes}")

    return "; ".join(parts)


def _load_records(path: Path) -> List[Dict[str, str]]:
    if not path.exists():
        raise SystemExit(f"File not found: {path}")

    if path.suffix.lower() == ".jsonl":
        rows: List[Dict[str, str]] = []
        with path.open(encoding="utf-8") as f:
            for line in f:
                text = line.strip()
                if not text:
                    continue
                try:
                    obj = json.loads(text)
                    if isinstance(obj, dict):
                        rows.append(obj.get("payload", obj))
                except json.JSONDecodeError:
                    continue
        return rows

    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8") as csvfile:
            return list(csv.DictReader(csvfile))

    raise SystemExit(f"Unsupported input format: {path.suffix}")


def process_closing_tasks():
    api_url = _required_env("API_URL_CLOSE_TASK")
    api_key_header = _required_env("API_KEY_HEADER")
    api_key_value = _required_env("API_KEY_VALUE")
    tr_subject = _env("TASK_SUBJECT", "Verify and Pull Down Times")
    to_name_id = _env("TASK_TO_NAME_ID", "FuneralAI Perplexity")
    dry_run_flag = _env("CLOSE_TASK_DRY_RUN", "true").lower() == "true"

    input_setting = _env("CLOSE_TASK_INPUT_CSV")
    csv_path = Path(input_setting) if input_setting else DEFAULT_INPUT
    if not csv_path.is_absolute():
        csv_path = SCRIPT_DIR / csv_path

    rows = _load_records(csv_path)
    processed_ids = _load_processed_ids(PROCESSED_LOG)
    seen_this_run: Set[str] = set()
    attempted = 0
    closed = 0

    for row in rows:
        ord_id = _clean(row.get("ord_id"))
        if not ord_id:
            continue
        if ord_id in processed_ids or ord_id in seen_this_run:
            continue

        seen_this_run.add(ord_id)
        attempted += 1

        tr_text = _build_close_text(row)
        payload = {
            "ord_id": ord_id,
            "trSubject": tr_subject,
            "toNameID": to_name_id,
            "trText": tr_text,
        }

        headers = {"Content-Type": "application/json", api_key_header: api_key_value}

        if dry_run_flag:
            print(json.dumps(payload, ensure_ascii=False))
            _append_payload_log(payload)
            _append_csv_log(payload)
            _append_run_log(f"DRY_RUN saved CloseTask payload for ord_id={ord_id}")
            _append_processed_id(PROCESSED_LOG, ord_id)
            closed += 1
            continue

        try:
            response = requests.post(api_url, json=payload, headers=headers, timeout=30)
            print(ord_id, response.status_code, response.text)
            _append_payload_log(payload)
            _append_csv_log(payload)
            _append_run_log(f"POST CloseTask ord_id={ord_id} status={response.status_code}")
            if response.ok:
                _append_processed_id(PROCESSED_LOG, ord_id)
                closed += 1
        except Exception as exc:
            print(f"Error closing ord_id={ord_id}: {exc}")
            _append_run_log(f"ERROR ord_id={ord_id} err={exc}")

    summary = f"CloseTask finished: attempted={attempted}, closed={closed}, dry_run={dry_run_flag}"
    print(summary)
    _append_run_log(summary)


if __name__ == "__main__":
    process_closing_tasks()
