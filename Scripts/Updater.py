import json
import os
import sys
import io
import csv
import argparse
import re
from pathlib import Path
from runtime_config import load_root_env
from datetime import datetime
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError

try:
    import requests
except ImportError:
    requests = None

# Ensure UTF-8 output for Windows terminals with line-buffered flushing.
# Guard against test runners that may provide a closed or non-standard stdout.
def _configure_windows_stdout_utf8() -> None:
    if os.name != "nt":
        return
    stdout = getattr(sys, "stdout", None)
    if stdout is None or getattr(stdout, "closed", False):
        return
    try:
        if hasattr(stdout, "reconfigure"):
            stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
            return
        buffer = getattr(stdout, "buffer", None)
        if buffer is None or getattr(buffer, "closed", False):
            return
        sys.stdout = io.TextIOWrapper(buffer, encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:
        # Keep original stdout if wrapping is unsupported in this environment.
        return


_configure_windows_stdout_utf8()

# ── Optional openpyxl for Excel output ──────────────────────────────────────
try:
    import openpyxl
    OPENPYXL_AVAILABLE = True
except ImportError:
    OPENPYXL_AVAILABLE = False

# ── Constants ────────────────────────────────────────────────────────────────
TIMEOUT_SECONDS     = 30
RATE_LIMIT_DELAY    = 0.5
SCRIPT_NAME         = "Updater"
SCRIPTS_DIR         = Path(__file__).resolve().parent
OUTPUT_DIR          = SCRIPTS_DIR / "outputs" / SCRIPT_NAME

# Input: reads from Funeral_Finder output
INPUT_CSV = SCRIPTS_DIR / "outputs" / "Funeral_Finder" / "Funeral_data.csv"
INPUT_NOT_FOUND_CSV = SCRIPTS_DIR / "outputs" / "Funeral_Finder" / "Funeral_data_not_found.csv"
INPUT_REVIEW_CSV = SCRIPTS_DIR / "outputs" / "Funeral_Finder" / "Funeral_data_review.csv"

# Valid run modes
VALID_MODES = ["complete", "found_only", "not_found", "review"]
DEFAULT_MODE = "complete"

# Output file paths
CSV_PATH     = OUTPUT_DIR / "data.csv"
EXCEL_PATH   = OUTPUT_DIR / "data.xlsx"
PAYLOAD_PATH = OUTPUT_DIR / "payload.json"
LOGS_PATH    = OUTPUT_DIR / "logs.txt"

# Default API endpoint
DEFAULT_API_URL = "http://ordstatus.tfdash.info:8061/api/createcomm"

# Canonical column order for output CSV/Excel
FIELDNAMES = [
    "order_id", "task_id", "ship_name",
    "trResult", "trEndDate", "trText", "frType",
    "response_status_code", "response_body",
    "upload_status", "last_processed_at",
]

CSV_READ_ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")

# Static payload fields (same for every request)
STATIC_PAYLOAD = {
    "fremail": "",
    "trsubject": "Funeral AI Lookup",
    "frphoneday": "",
    "tophoneeve": "",
    "frnameid": "FuneralAI",
    "trType": "",
    "trAction": "Lookup",
    "trUrgent": 1,
    "trPriority": 5,
    "trOpen": 1,
    "trdirection": "in",
    "trGroup": "",
    "toType": "Us",
    "price": "0.00",
    "trAddress": "",
}


# ── Helpers ──────────────────────────────────────────────────────────────────

def load_dotenv_file(path=None):
    """Load environment variables from the root .env file."""
    load_root_env(Path(path) if path is not None else None)


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"[{SCRIPT_NAME}] Missing required env var: {name}")
    return value


def get_now_iso() -> str:
    return datetime.now().isoformat()


def _safe_str(val) -> str:
    """Safely convert a value to a stripped string, handling None."""
    if val is None:
        return ""
    return str(val).strip()


def _read_csv_dict_rows(csv_path: Path) -> tuple[list[str], list[dict], str]:
    last_error = None
    for encoding in CSV_READ_ENCODINGS:
        try:
            with open(csv_path, "r", newline="", encoding=encoding) as f:
                reader = csv.DictReader(f)
                fieldnames = [_safe_str(field) for field in (reader.fieldnames or []) if _safe_str(field)]
                rows = list(reader)
            return fieldnames, rows, encoding
        except UnicodeDecodeError as exc:
            last_error = exc
            continue
    if last_error:
        raise last_error
    return [], [], CSV_READ_ENCODINGS[0]


def _parse_sort_datetime(value: str) -> datetime:
    text = _safe_str(value)
    if not text:
        return datetime.min
    normalized = text.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
            try:
                return datetime.strptime(text, fmt)
            except ValueError:
                continue
    return datetime.min


def _latest_row_sort_key(row: dict) -> tuple[datetime, datetime, datetime, str]:
    return (
        _parse_sort_datetime(row.get("last_processed_at")),
        _parse_sort_datetime(row.get("updated_at")),
        _parse_sort_datetime(row.get("created_at")),
        _safe_str(row.get("order_id")),
    )


def _normalize_date_for_crm(raw_value: str) -> str:
    """Return YYYY-MM-DD for CRM payloads, accepting common AI/customer formats."""
    value = _safe_str(raw_value)
    if not value:
        return ""

    cleaned = re.sub(
        r"(?i)\b(mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(r(s(day)?)?)?|fri(day)?|sat(urday)?|sun(day)?)\b",
        " ",
        value,
    )
    cleaned = re.sub(r"\s+", " ", cleaned.replace(",", " ")).strip()
    current_year = datetime.now().year
    candidates = [cleaned]
    for pattern in [
        r"\b\d{4}-\d{2}-\d{2}\b",
        r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b",
        r"\b\d{1,2}[/-]\d{1,2}\b",
        r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:\s+\d{2,4})\b",
        r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b",
    ]:
        candidates.extend(re.findall(pattern, cleaned, re.IGNORECASE))

    seen = set()
    for candidate in candidates:
        candidate = _safe_str(candidate)
        if not candidate or candidate.lower() in seen:
            continue
        seen.add(candidate.lower())
        if re.fullmatch(r"\d{1,2}[/-]\d{1,2}", candidate):
            candidate = f"{candidate}/{current_year}"
        elif re.fullmatch(
            r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}",
            candidate,
            re.IGNORECASE,
        ):
            candidate = f"{candidate} {current_year}"
        for fmt in (
            "%Y-%m-%d",
            "%m/%d/%Y",
            "%m/%d/%y",
            "%m-%d-%Y",
            "%m-%d-%y",
            "%B %d %Y",
            "%b %d %Y",
        ):
            try:
                return datetime.strptime(candidate, fmt).date().isoformat()
            except ValueError:
                continue
    return ""


def _normalize_time_for_crm(raw_value: str) -> str:
    """Return HH:mm 24-hour time. For ranges, use the start time only."""
    value = _safe_str(raw_value)
    if not value:
        return ""
    normalized = re.sub(r"(?i)\b([ap])\.?\s*m\.?\b", r"\1m", value)

    ampm_match = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b", normalized, re.IGNORECASE)
    if ampm_match:
        hour = int(ampm_match.group(1))
        minute = int(ampm_match.group(2) or 0)
        marker = ampm_match.group(3).lower()
        if 1 <= hour <= 12 and 0 <= minute <= 59:
            if marker == "pm" and hour != 12:
                hour += 12
            if marker == "am" and hour == 12:
                hour = 0
            return f"{hour:02d}:{minute:02d}"

    hour24_match = re.search(r"\b([01]?\d|2[0-3]):([0-5]\d)\b", normalized)
    if hour24_match:
        return f"{int(hour24_match.group(1)):02d}:{int(hour24_match.group(2)):02d}"

    return ""


def _normalize_datetime_pair(date_value: str, time_value: str) -> tuple[str, str]:
    return _normalize_date_for_crm(date_value), _normalize_time_for_crm(time_value)


def _datetime_sort_value(date_value: str, time_value: str) -> datetime | None:
    if not date_value or not time_value:
        return None
    try:
        return datetime.strptime(f"{date_value} {time_value}", "%Y-%m-%d %H:%M")
    except ValueError:
        return None


def _normalize_status_title(value: str) -> str:
    status = _safe_str(value).lower()
    if status in {"found", "customer", "review"}:
        return status.title()
    if status in {"notfound", "not_found", "not found"}:
        return "NotFound"
    return "NotFound"


def _confidence_label(value) -> str:
    try:
        score = float(value or 0)
    except (TypeError, ValueError):
        score = 0
    if score >= 85:
        return "High"
    if score >= 70:
        return "Medium"
    return "Low"


def _format_display_date(raw_value: str) -> str:
    normalized = _normalize_date_for_crm(raw_value)
    if not normalized:
        return "N/A"
    try:
        return datetime.strptime(normalized, "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return normalized


def _format_display_time(raw_value: str) -> str:
    normalized = _normalize_time_for_crm(raw_value)
    if not normalized:
        return "N/A"
    try:
        return datetime.strptime(normalized, "%H:%M").strftime("%I:%M %p").lstrip("0")
    except ValueError:
        return normalized


def _clean_inline_text(value: str, fallback: str = "N/A") -> str:
    text = re.sub(r"\s+", " ", _safe_str(value)).strip()
    return text or fallback


def _pick_primary_source_url(value: str) -> str:
    urls = [item.strip() for item in re.split(r"\s*\|\s*|\s*,\s*", _safe_str(value)) if item.strip()]
    deep_urls = [url for url in urls if "obitu" in url.lower() or "legacy.com" in url.lower() or "dignitymemorial.com" in url.lower()]
    return (deep_urls[0] if deep_urls else (urls[0] if urls else "N/A"))


def _build_structured_notes(order: dict, match_status: str, source_url: str) -> str:
    date_status = _safe_str(order.get("date_verification_status")).lower()
    source_freshness = _safe_str(order.get("source_freshness_status")).lower()
    venue_alignment = _safe_str(order.get("venue_alignment_status")).lower()

    if match_status == "Found":
        if source_url != "N/A":
            return "Verified obituary/detail source matched the order timing and funeral details."
        return "Verified funeral timing and location matched the requested order details."
    if match_status == "Customer":
        return "Service schedule came from customer instructions because no trustworthy obituary/detail source confirmed it."
    if match_status == "Review":
        if source_freshness in {"backdated", "stale"}:
            return "Review required because the source timing appears stale or backdated for this order."
        if date_status == "mismatch":
            return "Review required because the source timing conflicts with the customer instructions."
        if venue_alignment == "conflict":
            return "Review required because the source venue conflicts with the recipient or care-of details."
        return "Review required because the available source, date, or venue evidence is incomplete."
    return "No trustworthy obituary/detail source or usable service schedule was found."


def _build_address_block(order: dict) -> str:
    funeral_address = _clean_inline_text(order.get("funeral_address"), "")
    funeral_phone = _clean_inline_text(order.get("funeral_phone"), "")
    lines = ["Address", "Funeral Home:"]
    lines.append(funeral_address or "N/A")
    lines.append(f"Phone: {funeral_phone or 'N/A'}")
    return "\n".join(lines)


def _build_special_instruction_block(section_label: str, date_value: str, time_value: str, location_value: str) -> str:
    return f"{section_label}:\n{_format_display_date(date_value)} | {_format_display_time(time_value)} | {_clean_inline_text(location_value)}"


def _choose_service_datetime(order: dict) -> tuple[str, str, str]:
    """Pick CRM datetime using service -> visitation -> delivery -> ceremony priority."""
    candidates = [
        ("service", order.get("service_date"), order.get("service_time")),
        ("visitation", order.get("visitation_date"), order.get("visitation_time")),
        ("delivery", order.get("delivery_recommendation_date"), order.get("delivery_recommendation_time")),
        ("ceremony", order.get("ceremony_date"), order.get("ceremony_time")),
    ]
    for source, date_value, time_value in candidates:
        service_date, service_time = _normalize_datetime_pair(date_value, time_value)
        if service_date and service_time:
            customer_date, customer_time = _normalize_datetime_pair(
                order.get("delivery_recommendation_date"),
                order.get("delivery_recommendation_time"),
            )
            selected_dt = _datetime_sort_value(service_date, service_time)
            customer_dt = _datetime_sort_value(customer_date, customer_time)
            if source != "delivery" and selected_dt and customer_dt and selected_dt > customer_dt:
                return customer_date, customer_time, "customer"
            return service_date, service_time, source
    return "", "", "none"


# ── logs.txt helpers ─────────────────────────────────────────────────────────

def load_logged_ids() -> set:
    """
    Read logs.txt and return a set of already-processed order IDs.
    If the file does not exist, return an empty set (process everything).
    """
    if not LOGS_PATH.exists():
        return set()
    ids = set()
    with open(LOGS_PATH, "r", encoding="utf-8") as f:
        for line in f:
            oid = line.strip()
            if oid:
                ids.add(oid)
    return ids


def append_logged_id(order_id: str):
    """Append a single order ID to logs.txt."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOGS_PATH, "a", encoding="utf-8") as f:
        f.write(order_id + "\n")


# ── Input reader ─────────────────────────────────────────────────────────────

def _resolve_run_mode() -> str:
    """
    Determine the run mode from environment or CLI args.
    Supported modes: complete, found_only, not_found, review
    """
    mode = os.getenv("RUN_MODE", "").strip().lower()
    if mode in VALID_MODES:
        return mode
    return DEFAULT_MODE


def load_funeral_data(run_mode: str = "complete") -> list:
    """
    Read processed records from Funeral_Finder output.
    De-duplicates by order_id (keeps first occurrence).

    run_mode controls which records are included:
      - 'complete'   : All records from Funeral_data.csv (default)
      - 'found_only' : Only records with match_status == 'Found'
      - 'not_found'  : Only records from Funeral_data_not_found.csv
                       (or match_status == 'NotFound')
      - 'review'     : Only records from Funeral_data_review.csv
                       (or match_status == 'Review')
    """
    # Pick the correct input file based on mode
    input_override = _safe_str(os.getenv("UPDATER_INPUT_CSV"))
    if input_override:
        source_csv = Path(input_override)
    elif run_mode == "not_found" and INPUT_NOT_FOUND_CSV.exists():
        source_csv = INPUT_NOT_FOUND_CSV
    elif run_mode == "review" and INPUT_REVIEW_CSV.exists():
        source_csv = INPUT_REVIEW_CSV
    else:
        source_csv = INPUT_CSV

    if not source_csv.exists():
        print(f"[{SCRIPT_NAME}] ERROR: Input CSV not found: {source_csv}")
        print(f"[{SCRIPT_NAME}]   → Run Funeral_Finder.py first.")
        return []

    _, rows, encoding_used = _read_csv_dict_rows(source_csv)
    if encoding_used not in {"utf-8-sig", "utf-8"}:
        print(f"[{SCRIPT_NAME}] INFO: Read {source_csv.name} using {encoding_used} fallback")

    latest_rows = {}
    for row in rows:
        oid = _safe_str(row.get("order_id"))
        if not oid:
            continue

        # Apply status filter for found_only mode from the main CSV
        if run_mode == "found_only":
            status = _safe_str(row.get("match_status")).lower()
            if status != "found":
                continue
        elif run_mode == "not_found" and source_csv == INPUT_CSV:
            status = _safe_str(row.get("match_status")).lower()
            if status != "notfound" and status != "not_found" and status != "not found":
                continue
        elif run_mode == "review" and source_csv == INPUT_CSV:
            status = _safe_str(row.get("match_status")).lower()
            if status != "review":
                continue

        existing = latest_rows.get(oid)
        if existing is None or _latest_row_sort_key(row) >= _latest_row_sort_key(existing):
            latest_rows[oid] = row

    return sorted(latest_rows.values(), key=_latest_row_sort_key, reverse=True)


def filter_orders_by_logged_ids(orders: list, logged_ids: set[str]) -> tuple[list, int]:
    filtered_orders = []
    skipped_count = 0
    for order in orders:
        order_id = _safe_str(order.get("order_id"))
        if order_id and order_id in logged_ids:
            skipped_count += 1
            continue
        filtered_orders.append(order)
    return filtered_orders, skipped_count


# ── Payload builder ──────────────────────────────────────────────────────────

def build_payload(order: dict) -> dict:
    """
    Build the API payload from a Funeral_Finder output record.
    Only trResult, trEndDate, trText, frType vary per order.
    """
    order_id = _safe_str(order.get("order_id"))
    match_status = _normalize_status_title(order.get("match_status"))

    # trEndDate is updated only when a valid date+time pair exists.
    service_date, service_time, datetime_source = _choose_service_datetime(order)
    if service_date and service_time:
        tr_end_date = f"{service_date} {service_time}"
    else:
        tr_end_date = ""

    # trResult should follow the verified pipeline status, not the datetime fallback source.
    if match_status == "Found":
        tr_result = "Found"
    elif match_status == "Customer":
        tr_result = "Customer"
    elif match_status == "Review":
        tr_result = "Review"
    else:
        tr_result = "NotFound"

    matched_name = _clean_inline_text(order.get("matched_name") or order.get("ship_name"))
    funeral_home = _clean_inline_text(order.get("funeral_home_name"))
    source_url = _pick_primary_source_url(order.get("source_urls"))
    notes = _build_structured_notes(order, tr_result, source_url)
    confidence = _confidence_label(order.get("AI Accuracy Score") or order.get("ai_accuracy_score"))
    visitation_date = _safe_str(order.get("visitation_date"))
    visitation_time = _safe_str(order.get("visitation_time"))
    visitation_location = _clean_inline_text(order.get("funeral_home_name") or order.get("delivery_recommendation_location"))
    service_location = _clean_inline_text(order.get("delivery_recommendation_location") or order.get("funeral_home_name"))

    note_lines = [
        "Funeral AI",
        f"Result: {tr_result}",
        f"Confidence: {confidence}",
        "",
        f"Deceased Name: {matched_name}",
        "",
        f"Funeral Home / Church Name: {funeral_home}",
        "",
        _build_address_block(order),
        "",
        "Viewing / Visitation",
        f"Date: {_format_display_date(visitation_date)}",
        f"Time: {_format_display_time(visitation_time)}",
        f"Location: {_clean_inline_text(visitation_location)}",
        "",
        "Service Time / Celebration of Life / Calling Hours",
        f"Date: {_format_display_date(service_date)}",
        f"Time: {_format_display_time(service_time)}",
        f"Location: {_clean_inline_text(service_location)}",
        "",
        f"Notes: {notes}",
        "",
        f"Source: {source_url}",
        "",
        "SPECIAL INSTRUCTION NOTES",
        _build_special_instruction_block(
            "Viewing / Visitation",
            visitation_date,
            visitation_time,
            visitation_location,
        ),
        "",
        _build_special_instruction_block(
            "Service Time / Celebration of Life / Calling Hours",
            service_date,
            service_time,
            service_location,
        ),
    ]

    tr_text = "\n".join(note_lines)

    # frType: leave blank as per user instruction
    fr_type = ""

    # Build final payload
    payload = dict(STATIC_PAYLOAD)
    payload["ord_id"] = order_id
    payload["trResult"] = tr_result
    payload["trEndDate"] = tr_end_date
    payload["trText"] = tr_text
    payload["frType"] = fr_type

    return payload


# ── Output writers ───────────────────────────────────────────────────────────

def save_one_record_to_csv(record: dict):
    """Append a single record to data.csv immediately."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    file_exists = CSV_PATH.exists()

    all_keys = list(FIELDNAMES)
    for k in record:
        if k not in all_keys:
            all_keys.append(k)

    with open(CSV_PATH, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=all_keys, extrasaction="ignore")
        if not file_exists:
            writer.writeheader()
        writer.writerow(record)


def rebuild_excel_from_csv():
    """Rebuild data.xlsx from the current data.csv."""
    if not OPENPYXL_AVAILABLE or not CSV_PATH.exists():
        return
    fieldnames, all_rows, encoding_used = _read_csv_dict_rows(CSV_PATH)
    if not fieldnames:
        fieldnames = list(FIELDNAMES)
    if encoding_used not in {"utf-8-sig", "utf-8"}:
        print(f"[{SCRIPT_NAME}] INFO: Rebuilt Excel from {CSV_PATH.name} using {encoding_used} fallback")

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = f"{SCRIPT_NAME} Data"
    ws.append(list(fieldnames))
    for row in all_rows:
        ws.append([row.get(col, "") for col in fieldnames])
    wb.save(EXCEL_PATH)
    print(f"  📊 Excel updated: {len(all_rows)} rows total")


def append_to_payload_json(order_id: str, payload_data: dict):
    """Append/update one order's payload into the combined payload.json."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    all_payloads = {}
    if PAYLOAD_PATH.exists():
        try:
            with open(PAYLOAD_PATH, "r", encoding="utf-8") as f:
                all_payloads = json.load(f)
        except (json.JSONDecodeError, ValueError):
            all_payloads = {}
    all_payloads[order_id] = payload_data
    with open(PAYLOAD_PATH, "w", encoding="utf-8") as f:
        json.dump(all_payloads, f, indent=2, ensure_ascii=False)


def post_json(api_url: str, headers: dict, payload: dict):
    """POST JSON using requests when available, otherwise stdlib urllib."""
    if requests is not None:
        return requests.post(
            api_url,
            headers=headers,
            json=payload,
            timeout=TIMEOUT_SECONDS,
        )

    data = json.dumps(payload).encode("utf-8")
    request_headers = dict(headers)
    request_headers.setdefault("Content-Type", "application/json")
    req = urllib_request.Request(api_url, data=data, headers=request_headers, method="POST")
    try:
        with urllib_request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8", errors="replace")
            return type("HttpResponse", (), {
                "status_code": response.status,
                "text": body,
                "ok": 200 <= response.status < 300,
            })()
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        return type("HttpResponse", (), {
            "status_code": error.code,
            "text": body,
            "ok": False,
        })()
    except URLError as error:
        raise RuntimeError(str(error.reason)) from error


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    import time

    parser = argparse.ArgumentParser(description=f"{SCRIPT_NAME} – send funeral data to CRM API")
    parser.add_argument("--force", action="store_true",
                        help="Ignore logs.txt and reprocess all order IDs")
    parser.add_argument("--dry-run", action="store_true",
                        help="Do not send to CRM, only simulate")
    parser.add_argument("--limit", type=int, default=0,
                        help="Cap how many orders to process (0 = unlimited)")
    parser.add_argument("--no-delay", action="store_true",
                        help="Disable rate limiting delay between requests")
    parser.add_argument("--mode", type=str, default="",
                        choices=[""] + VALID_MODES,
                        help="File source mode: complete, found_only, not_found, review")
    args = parser.parse_args()

    load_dotenv_file()

    # API setup
    api_url = os.getenv("API_URL_UPDATE_COMM", DEFAULT_API_URL).strip()
    api_key_header = _required_env("API_KEY_HEADER")
    api_key_value  = _required_env("API_KEY_VALUE")
    headers = {api_key_header: api_key_value, "Content-Type": "application/json"}

    # ── Determine run mode ────────────────────────────────────────────────────
    run_mode = args.mode if args.mode else _resolve_run_mode()
    print(f"[{SCRIPT_NAME}] Run mode: {run_mode}")

    # ── 1. Load orders from Funeral_Finder output ────────────────────────────
    orders = load_funeral_data(run_mode)
    if not orders:
        print(f"[{SCRIPT_NAME}] No orders to process for mode '{run_mode}'.")
        return

    mode_labels = {
        "complete": "ALL records",
        "found_only": "Found only",
        "not_found": "Not Found only",
        "review": "Review only",
    }

    print(f"\n┌─────────────────────────────────────────────────────────┐")
    print(f"│  INPUT SUMMARY                                          │")
    print(f"│  Orders loaded (de-duped) : {len(orders):<29}│")
    print(f"│  Filter mode              : {mode_labels.get(run_mode, run_mode):<29}│")
    print(f"│  API endpoint             : {api_url[:29]:<29}│")
    print(f"└─────────────────────────────────────────────────────────┘")

    if args.dry_run:
        print(f"[{SCRIPT_NAME}] ⚡ DRY RUN MODE – no requests will be sent")

    # ── 2. Load already-processed IDs from logs.txt ──────────────────────────
    logged_ids = set() if args.force else load_logged_ids()
    if logged_ids:
        print(f"[{SCRIPT_NAME}] Loaded {len(logged_ids)} already-processed IDs from logs.txt")
    elif not LOGS_PATH.exists():
        print(f"[{SCRIPT_NAME}] logs.txt not found – will process all orders")
    else:
        print(f"[{SCRIPT_NAME}] logs.txt exists but is empty – will process all orders")

    if args.force:
        print(f"[{SCRIPT_NAME}] --force enabled – reprocessing ALL orders")

    pre_skipped = 0
    if not args.force:
        filtered_orders = []
        for order in orders:
            order_id = _safe_str(order.get("order_id"))
            if order_id and order_id in logged_ids:
                pre_skipped += 1
                continue
            filtered_orders.append(order)
        orders = filtered_orders
        if pre_skipped:
            print(f"[{SCRIPT_NAME}] Pre-filtered {pre_skipped} already-processed order IDs from logs.txt")

    # ── 3. Process each order ────────────────────────────────────────────────
    new_count     = 0
    skipped_count = 0
    success_count = 0
    error_count   = 0
    total         = len(orders)
    skipped_count += pre_skipped

    print(f"\n{'═'*60}")
    print(f"  📤 LIVE PROCESSING  –  {total} orders")
    print(f"{'═'*60}\n")

    for idx, order in enumerate(orders, start=1):
        order_id  = _safe_str(order.get("order_id"))
        ship_name = _safe_str(order.get("ship_name"))
        match_status = _safe_str(order.get("match_status"))

        status_icon = {"Found": "✅", "NotFound": "❌", "Review": "⚠️"}.get(match_status, "❓")

        print(f"[{idx}/{total}] {'─'*45}")
        print(f"  Order ID : {order_id}")
        print(f"  Name     : {ship_name}")
        print(f"  Status   : {status_icon} {match_status}")

        # Limit check
        if args.limit > 0 and new_count >= args.limit:
            print(f"\n[{SCRIPT_NAME}] Reached --limit={args.limit}; stopping early.")
            break

        # Build payload
        payload = build_payload(order)

        # Show the variable fields
        print(f"  📋 Payload:")
        print(f"     ord_id    : {payload['ord_id']}")
        print(f"     trResult  : {payload['trResult']}")
        print(f"     trEndDate : {payload['trEndDate'] or '(none)'}")
        tr_text_preview = payload['trText'][:120] + "..." if len(payload['trText']) > 120 else payload['trText']
        print(f"     trText    : {tr_text_preview or '(none)'}")
        print(f"     frType    : {payload['frType'] or '(blank)'}")

        # Send request or dry-run
        response_status_code = ""
        response_body = ""
        upload_status = ""

        if args.dry_run:
            print(f"  🧪 DRY RUN – not sending")
            upload_status = "DRY_RUN"
            response_status_code = "DRY_RUN"
            response_body = "DRY_RUN"
            success_count += 1
        else:
            print(f"  → Sending to API...")
            try:
                resp = post_json(api_url, headers, payload)
                response_status_code = str(resp.status_code)
                response_body = resp.text[:500]

                print(f"  📥 Response: {response_status_code}")

                if resp.ok:
                    upload_status = "SUCCESS"
                    success_count += 1
                    print(f"  ✅ SUCCESS")
                    # Show response body preview
                    if response_body:
                        body_preview = response_body[:150] + "..." if len(response_body) > 150 else response_body
                        print(f"     Server: {body_preview}")
                else:
                    upload_status = f"FAILED_{response_status_code}"
                    error_count += 1
                    print(f"  ❌ FAILED: HTTP {response_status_code}")
                    if response_body:
                        print(f"     Server: {response_body[:200]}")

            except Exception as e:
                upload_status = "ERROR"
                response_status_code = "ERROR"
                response_body = str(e)
                error_count += 1
                print(f"  ❌ REQUEST ERROR: {e}")

        # ── IMMEDIATE SAVE: record to CSV + Excel ────────────────────────
        record = {
            "order_id":             order_id,
            "task_id":              _safe_str(order.get("task_id")),
            "ship_name":            ship_name,
            "trResult":             payload["trResult"],
            "trEndDate":            payload["trEndDate"],
            "trText":               payload["trText"],
            "frType":               payload["frType"],
            "response_status_code": response_status_code,
            "response_body":        response_body,
            "upload_status":        upload_status,
            "last_processed_at":    get_now_iso(),
        }

        save_one_record_to_csv(record)
        rebuild_excel_from_csv()
        print(f"  📁 Saved to data.csv & .xlsx")

        # ── Save payload (sent + server response) ────────────────────────
        append_to_payload_json(order_id, {
            "sent_payload": payload,
            "response_status_code": response_status_code,
            "response_body": response_body,
            "upload_status": upload_status,
            "timestamp": get_now_iso(),
        })

        # ── Update logs.txt ──────────────────────────────────────────────
        append_logged_id(order_id)
        logged_ids.add(order_id)
        new_count += 1

        print(f"  ✓ DONE  (processed so far: {new_count})")

        # Rate limiting
        if not args.no_delay and not args.dry_run:
            time.sleep(RATE_LIMIT_DELAY)

    # ── Summary ──────────────────────────────────────────────────────────────
    print(f"\n{'═'*60}")
    print(f"  📊 TASK COMPLETION SUMMARY")
    print(f"{'═'*60}")
    print(f"  ✅ Success    : {success_count}")
    print(f"  💥 Errors     : {error_count}")
    print(f"  ⏭️  Skipped    : {skipped_count}")
    print(f"{'─'*60}")
    print(f"  📁 Total      : {total}")
    print(f"  🆕 Processed  : {new_count}")
    print(f"{'═'*60}")
    print(
        f"[{SCRIPT_NAME}] RUN SUMMARY | "
        f"Success={success_count} | Errors={error_count} | Skipped={skipped_count} | "
        f"Total={total} | Processed={new_count} | Mode={run_mode}"
    )

    print(f"\n[{SCRIPT_NAME}] Output folder : {OUTPUT_DIR}")
    print(f"[{SCRIPT_NAME}] Files created :")
    for fp in [CSV_PATH, EXCEL_PATH, PAYLOAD_PATH, LOGS_PATH]:
        mark = "✓" if fp.exists() else "✗"
        print(f"  {mark}  {fp.name}")


if __name__ == "__main__":
    main()
