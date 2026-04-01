import json
import os
import sys
import io
import csv
import argparse
from pathlib import Path
from datetime import datetime

import requests

# Ensure UTF-8 output for Windows terminals with line-buffered flushing
if os.name == 'nt':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)

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
    """Load a .env file from the Scripts directory (or given path)."""
    if path is None:
        path = SCRIPTS_DIR / ".env"
    path = Path(path)
    if not path.exists():
        return
    with open(path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key   = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


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
    if run_mode == "not_found" and INPUT_NOT_FOUND_CSV.exists():
        source_csv = INPUT_NOT_FOUND_CSV
    elif run_mode == "review" and INPUT_REVIEW_CSV.exists():
        source_csv = INPUT_REVIEW_CSV
    else:
        source_csv = INPUT_CSV

    if not source_csv.exists():
        print(f"[{SCRIPT_NAME}] ERROR: Input CSV not found: {source_csv}")
        print(f"[{SCRIPT_NAME}]   → Run Funeral_Finder.py first.")
        return []

    orders = []
    seen_ids = set()

    with open(source_csv, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            oid = _safe_str(row.get("order_id"))
            if not oid or oid in seen_ids:
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

            seen_ids.add(oid)
            orders.append(row)

    return orders


# ── Payload builder ──────────────────────────────────────────────────────────

def build_payload(order: dict) -> dict:
    """
    Build the API payload from a Funeral_Finder output record.
    Only trResult, trEndDate, trText, frType vary per order.
    """
    order_id = _safe_str(order.get("order_id"))
    match_status = _safe_str(order.get("match_status"))

    # trResult: Found / NotFound / Review
    tr_result = match_status if match_status in ("Found", "NotFound", "Review") else "Review"

    # trEndDate: service date + time from Funeral_Finder output
    service_date = _safe_str(order.get("service_date"))
    service_time = _safe_str(order.get("service_time"))
    if service_date and service_time:
        tr_end_date = f"{service_date} {service_time}"
    elif service_date:
        tr_end_date = service_date
    else:
        tr_end_date = ""

    # trText: Notes (combination of key findings)
    note_parts = []
    ship_name = _safe_str(order.get("ship_name"))
    funeral_home = _safe_str(order.get("funeral_home_name"))
    notes = _safe_str(order.get("notes"))
    special = _safe_str(order.get("special_instructions"))
    delivery_date = _safe_str(order.get("delivery_recommendation_date"))
    delivery_time = _safe_str(order.get("delivery_recommendation_time"))
    delivery_loc = _safe_str(order.get("delivery_recommendation_location"))

    if ship_name:
        note_parts.append(f"{ship_name}")
    if funeral_home:
        note_parts.append(f"Funeral Home: {funeral_home}")
    if service_date:
        svc = f"Service: {service_date}"
        if service_time:
            svc += f" {service_time}"
        note_parts.append(svc)
    if delivery_date:
        dlv = f"Deliver By: {delivery_date}"
        if delivery_time:
            dlv += f" {delivery_time}"
        note_parts.append(dlv)
    if delivery_loc:
        note_parts.append(f"Deliver To: {delivery_loc}")
    if special:
        note_parts.append(f"Instructions: {special}")
    if notes:
        note_parts.append(f"Notes: {notes}")

    tr_text = " | ".join(note_parts) if note_parts else ""

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
    with open(CSV_PATH, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or FIELDNAMES
        all_rows = list(reader)

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

    # ── 3. Process each order ────────────────────────────────────────────────
    new_count     = 0
    skipped_count = 0
    success_count = 0
    error_count   = 0
    total         = len(orders)

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

        # Skip check
        if order_id in logged_ids and not args.force:
            print(f"  ⏭  SKIP – already in logs.txt")
            skipped_count += 1
            continue

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
                resp = requests.post(
                    api_url,
                    headers=headers,
                    json=payload,
                    timeout=TIMEOUT_SECONDS
                )
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

    print(f"\n[{SCRIPT_NAME}] Output folder : {OUTPUT_DIR}")
    print(f"[{SCRIPT_NAME}] Files created :")
    for fp in [CSV_PATH, EXCEL_PATH, PAYLOAD_PATH, LOGS_PATH]:
        mark = "✓" if fp.exists() else "✗"
        print(f"  {mark}  {fp.name}")


if __name__ == "__main__":
    main()