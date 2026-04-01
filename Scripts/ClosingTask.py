import json
import os
import sys
import io
import csv
import argparse
import time
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
TIMEOUT_SECONDS  = 30
RATE_LIMIT_DELAY = 0.5
SCRIPT_NAME      = "ClosingTask"
SCRIPTS_DIR      = Path(__file__).resolve().parent
OUTPUT_DIR       = SCRIPTS_DIR / "outputs" / SCRIPT_NAME

# Input: reads from Updater output (successfully sent orders)
INPUT_CSV = SCRIPTS_DIR / "outputs" / "Updater" / "data.csv"

# Output file paths
CSV_PATH     = OUTPUT_DIR / "data.csv"
EXCEL_PATH   = OUTPUT_DIR / "data.xlsx"
PAYLOAD_PATH = OUTPUT_DIR / "payload.json"
LOGS_PATH    = OUTPUT_DIR / "logs.txt"

# Canonical column order for output CSV/Excel
FIELDNAMES = [
    "order_id", "task_id", "ship_name",
    "trResult", "close_reason",
    "trSubject", "toNameID", "trText",
    "response_status_code", "response_body",
    "upload_status", "last_processed_at",
]


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

def load_updater_data() -> list:
    """
    Read processed records from Updater/data.csv.
    De-duplicates by order_id (keeps first occurrence).
    Only includes orders with upload_status == SUCCESS.
    """
    if not INPUT_CSV.exists():
        print(f"[{SCRIPT_NAME}] ERROR: Input CSV not found: {INPUT_CSV}")
        print(f"[{SCRIPT_NAME}]   → Run Updater.py first.")
        return []

    orders = []
    seen_ids = set()

    with open(INPUT_CSV, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            oid = _safe_str(row.get("order_id"))
            if not oid or oid in seen_ids:
                continue

            upload_status = _safe_str(row.get("upload_status"))
            if upload_status != "SUCCESS":
                continue

            seen_ids.add(oid)
            orders.append(row)

    return orders


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
    parser = argparse.ArgumentParser(description=f"{SCRIPT_NAME} – close CRM tasks after update")
    parser.add_argument("--force", action="store_true",
                        help="Ignore logs.txt and reprocess all order IDs")
    parser.add_argument("--dry-run", action="store_true",
                        help="Do not send to CRM, only simulate")
    parser.add_argument("--limit", type=int, default=0,
                        help="Cap how many orders to process (0 = unlimited)")
    parser.add_argument("--no-delay", action="store_true",
                        help="Disable rate limiting delay between requests")
    args = parser.parse_args()

    load_dotenv_file()

    run_mode = os.getenv("RUN_MODE", "").strip().lower()
    run_mode_dry = run_mode in {"dry", "dry-run", "dry_run", "preview", "test"}
    run_mode_live = run_mode in {"live", "send", "production", "prod"}

    # API setup
    api_url        = _required_env("API_URL_CLOSE_TASK")
    api_key_header = _required_env("API_KEY_HEADER")
    api_key_value  = _required_env("API_KEY_VALUE")
    tr_subject     = os.getenv("TASK_SUBJECT", "Verify and Pull Down Times").strip()
    to_name_id     = os.getenv("TASK_TO_NAME_ID", "FuneralAI Perplexity").strip()
    headers        = {api_key_header: api_key_value, "Content-Type": "application/json"}

    # Keep dry-run explicit via RUN_MODE or --dry-run only.
    env_dry_run = os.getenv("CLOSE_TASK_DRY_RUN", "false").strip().lower() == "true"
    if run_mode_live:
        args.dry_run = False
        print(f"[{SCRIPT_NAME}] RUN_MODE={run_mode} – live mode enabled")
    elif run_mode_dry:
        args.dry_run = True
        print(f"[{SCRIPT_NAME}] RUN_MODE={run_mode} – dry-run mode enabled")
    elif env_dry_run and not args.dry_run:
        print(f"[{SCRIPT_NAME}] CLOSE_TASK_DRY_RUN=true ignored (use RUN_MODE=dry or --dry-run)")

    # ── 1. Load orders from Updater output ───────────────────────────────────
    orders = load_updater_data()
    if not orders:
        print(f"[{SCRIPT_NAME}] No orders to process.")
        return

    print(f"\n┌─────────────────────────────────────────────────────────┐")
    print(f"│  INPUT SUMMARY                                          │")
    print(f"│  Orders loaded (de-duped) : {len(orders):<29}│")
    print(f"│  Source file              : Updater/data.csv             │")
    print(f"│  API endpoint             : {api_url[:29]:<29}│")
    print(f"│  Task Subject             : {tr_subject[:29]:<29}│")
    print(f"│  To Name ID               : {to_name_id[:29]:<29}│")
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
    print(f"  🔒 LIVE PROCESSING  –  {total} tasks to close")
    print(f"{'═'*60}\n")

    for idx, order in enumerate(orders, start=1):
        order_id  = _safe_str(order.get("order_id"))
        task_id   = _safe_str(order.get("task_id"))
        ship_name = _safe_str(order.get("ship_name"))
        tr_result = _safe_str(order.get("trResult"))

        # Determine close reason
        if tr_result == "Found":
            close_reason = "FOUND"
        elif tr_result == "NotFound":
            close_reason = "NOT_FOUND"
        else:
            close_reason = "REVIEW_REQUIRED"

        status_icon = {"FOUND": "✅", "NOT_FOUND": "❌", "REVIEW_REQUIRED": "⚠️"}.get(close_reason, "❓")

        print(f"[{idx}/{total}] {'─'*45}")
        print(f"  Order ID : {order_id}")
        print(f"  Task  ID : {task_id or '(none)'}")
        print(f"  Name     : {ship_name}")
        print(f"  Reason   : {status_icon} {close_reason}")

        # Skip check
        if order_id in logged_ids and not args.force:
            print(f"  ⏭  SKIP – already in logs.txt")
            skipped_count += 1
            continue

        # Limit check
        if args.limit > 0 and new_count >= args.limit:
            print(f"\n[{SCRIPT_NAME}] Reached --limit={args.limit}; stopping early.")
            break

        # Build close payload
        tr_text_note = _safe_str(order.get("trText"))
        close_text = f"Automated Close: {close_reason}"
        if tr_text_note:
            # Truncate to reasonable length for close note
            note_preview = tr_text_note[:300] if len(tr_text_note) > 300 else tr_text_note
            close_text += f" | {note_preview}"

        payload = {
            "ord_id": order_id,
            "trSubject": tr_subject,
            "toNameID": to_name_id,
            "trText": close_text,
        }

        print(f"  📋 Payload:")
        print(f"     ord_id    : {payload['ord_id']}")
        print(f"     trSubject : {payload['trSubject']}")
        print(f"     toNameID  : {payload['toNameID']}")
        close_preview = close_text[:100] + "..." if len(close_text) > 100 else close_text
        print(f"     trText    : {close_preview}")

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
            print(f"  → Sending CloseTask to API...")
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
                    print(f"  ✅ CLOSED")
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
            "task_id":              task_id,
            "ship_name":            ship_name,
            "trResult":             tr_result,
            "close_reason":         close_reason,
            "trSubject":            payload["trSubject"],
            "toNameID":             payload["toNameID"],
            "trText":               payload["trText"],
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
    print(f"  ✅ Closed     : {success_count}")
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
