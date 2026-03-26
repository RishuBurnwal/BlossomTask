import csv
import json
from pathlib import Path
from typing import Dict, Set
from datetime import datetime

import requests

SCRIPT_DIR = Path(__file__).resolve().parent
CSV_PATH = SCRIPT_DIR / "outputs" / "Funeral_Finder" / "Funeral_data.csv"
UPDATER_DIR = SCRIPT_DIR / "outputs" / "Updater"
LOG_PATH = UPDATER_DIR / "updater_processed.log"
RUN_LOG_PATH = UPDATER_DIR / "updater_run.log"
PAYLOAD_LOG_PATH = UPDATER_DIR / "updater_payloads.jsonl"
CSV_LOG_PATH = UPDATER_DIR / "updater_payloads.csv"

API_URL = "http://ordstatus.tfdash.info:8061/api/createcomm"
API_KEY_HEADER = "X-VCAppApiKey"
API_KEY_VALUE = ""
DRY_RUN = True


def _clean(value):
    return str(value or "").strip()


def _normalize(value):
    text = _clean(value)
    if not text or text.lower() in {"unknown", "not_available", "not available", "n/a", "na"}:
        return "N/A"
    return text


def _first_non_empty(*values):
    for value in values:
        text = _normalize(value)
        if text and text != "N/A":
            return text
    return "N/A"


def _join_non_empty(parts, sep=" "):
    filtered = [_normalize(part) for part in parts if _normalize(part) and _normalize(part) != "N/A"]
    return sep.join(filtered) if filtered else "N/A"


def _pick_primary_url(row: Dict[str, str]) -> str:
    source_urls = _clean(row.get("pplx_source_urls"))
    if source_urls:
        first = source_urls.split("|")[0].strip()
        if first:
            return first
    return _first_non_empty(row.get("pplx_obituary_url"))


def _build_tr_text(row: Dict[str, str]) -> str:
    return _first_non_empty(row.get("pplx_notes"), row.get("pplx_verification_notes"))


def _build_fr_type(row: Dict[str, str]) -> str:
    primary_url = _pick_primary_url(row)
    venue_type = _first_non_empty(row.get("pplx_venue_type"))
    location_name = _first_non_empty(row.get("pplx_service_location_name"), row.get("pplx_funeral_home_name"))
    parts = []
    if primary_url and primary_url != "N/A":
        parts.append(primary_url)
    parts.append(venue_type if venue_type != "N/A" else "unknown")
    parts.append(location_name if location_name != "N/A" else "unknown")
    return ":".join(parts)


def _build_tr_end_date(row: Dict[str, str]) -> str:
    seg1 = _join_non_empty([row.get("pplx_funeral_date"), row.get("pplx_funeral_time")], sep=" ")
    seg2 = _join_non_empty([row.get("pplx_visitation_date"), row.get("pplx_visitation_time")], sep=" ")
    segments = [s for s in [seg1, seg2] if s and s != "N/A"]
    return " | ".join(segments) if segments else "N/A"


def _build_tr_address(row: Dict[str, str]) -> str:
    city_state_zip = _join_non_empty([row.get("pplx_city"), row.get("pplx_state"), row.get("pplx_zip")], sep=", ")
    phone = _normalize(row.get("pplx_phone_number"))
    location_address = _normalize(row.get("pplx_service_location_address"))
    parts = [p for p in [city_state_zip, _normalize(row.get("pplx_funeral_home_name")), phone, location_address] if p and p != "N/A"]
    return " | ".join(parts) if parts else "N/A"


def _match_score(row: Dict[str, str]) -> str:
    return _first_non_empty(row.get("pplx__ai_accuracy_percent"), row.get("pplx_ai_accuracy_percent"))


def _status(row: Dict[str, str]) -> str:
    return _first_non_empty(row.get("perplexity_status"), row.get("pplx_status"))


def _parse_score(value: str):
    text = _clean(value).replace("%", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _resolved_status(row: Dict[str, str]) -> str:
    base_status = _status(row)
    score_value = _parse_score(_match_score(row))

    if score_value is None:
        return base_status
    if score_value < 50:
        return "unmatched"
    if score_value < 75:
        return "needs_review"
    if base_status in {"mismatched"}:
        return base_status
    return "matched"


def _load_processed_ids(path: Path) -> Set[str]:
    if not path.exists():
        return set()
    with path.open("r", encoding="utf-8") as f:
        return {line.strip() for line in f if line.strip()}


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
    headers = [
        "ord_id",
        "trResult",
        "trText",
        "frType",
        "trEndDate",
        "trAddress",
    ]
    write_header = not CSV_LOG_PATH.exists()
    with CSV_LOG_PATH.open("a", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        if write_header:
            writer.writeheader()
        writer.writerow({key: payload.get(key, "") for key in headers})


def process_file():
    if not CSV_PATH.exists():
        message = f"Updater input not found, skipping: {CSV_PATH}"
        print(message)
        _append_run_log(message)
        return

    processed_ids = _load_processed_ids(LOG_PATH)
    seen_this_run: Set[str] = set()
    processed_count = 0
    skipped_count = 0

    with CSV_PATH.open(newline="", encoding="utf-8") as csvfile:
        reader = csv.DictReader(csvfile)
        for row in reader:
            ord_id = _clean(row.get("ord_id"))
            if not ord_id:
                continue
            if ord_id in processed_ids or ord_id in seen_this_run:
                skipped_count += 1
                continue

            seen_this_run.add(ord_id)

            payload = {
                "ord_id": ord_id,
                "fremail": "",
                "trsubject": "Funeral AI Lookup",
                "frphoneday": "",
                "tophoneeve": "",
                "frnameid": "FuneralAI",
                "trType": "NOTE",
                "trAction": "Lookup",
                "trUrgent": 1,
                "trPriority": 5,
                "trOpen": 1,
                "trText": _build_tr_text(row),
                "trdirection": "in",
                "trGroup": "",
                "frType": _build_fr_type(row),
                "toType": "Us",
                "price": "0.00",
                "trEndDate": _build_tr_end_date(row),
                "trAddress": _build_tr_address(row),
                "trResult": f"Found + Match Score {_match_score(row)} | Status {_resolved_status(row)}",
            }

            headers = {
                "Content-Type": "application/json",
                API_KEY_HEADER: API_KEY_VALUE,
            }

            if DRY_RUN:
                print(json.dumps(payload, ensure_ascii=False))
                _append_payload_log(payload)
                _append_csv_log(payload)
                _append_run_log(f"DRY_RUN saved payload for ord_id={ord_id}")
                _append_processed_id(LOG_PATH, ord_id)
                processed_count += 1
                continue

            try:
                response = requests.post(API_URL, json=payload, headers=headers, timeout=30)
                print(payload["ord_id"], response.status_code, response.text)
                _append_payload_log(payload)
                _append_csv_log(payload)
                _append_run_log(f"POST ord_id={ord_id} status={response.status_code}")
                if response.ok:
                    _append_processed_id(LOG_PATH, ord_id)
                    processed_count += 1
            except Exception as exc:
                print(f"Error posting ord_id={ord_id}: {exc}")
                _append_run_log(f"ERROR ord_id={ord_id} err={exc}")

    summary = f"Updater finished: processed={processed_count}, skipped={skipped_count}, dry_run={DRY_RUN}"
    print(summary)
    _append_run_log(summary)


if __name__ == "__main__":
    process_file()