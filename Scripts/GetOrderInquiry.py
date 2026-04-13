import json
import os
import sys
import io
import csv
import argparse
from pathlib import Path
from datetime import datetime

# Ensure UTF-8 output for Windows terminals
if os.name == 'nt':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

import requests

# ── Optional openpyxl ────────────────────────────────────────────────────────
try:
    import openpyxl
    OPENPYXL_AVAILABLE = True
except ImportError:
    OPENPYXL_AVAILABLE = False

# ── Constants ────────────────────────────────────────────────────────────────
TIMEOUT_SECONDS = 120
SCRIPT_NAME     = "GetOrderInquiry"
SCRIPTS_DIR     = Path(__file__).resolve().parent
OUTPUT_DIR      = SCRIPTS_DIR / "outputs" / SCRIPT_NAME

# Input: reads order IDs from GetTask's output
GETTASK_CSV     = SCRIPTS_DIR / "outputs" / "GetTask" / "data.csv"

# Output file paths
CSV_PATH     = OUTPUT_DIR / "data.csv"
EXCEL_PATH   = OUTPUT_DIR / "data.xlsx"
PAYLOAD_PATH = OUTPUT_DIR / "payload.json"   # combined payload of all orders
LOGS_PATH    = OUTPUT_DIR / "logs.txt"
QUERY_PATH   = OUTPUT_DIR / "query.txt"

# Canonical column order for CSV/Excel
FIELDNAMES = [
    "order_id", "task_id",
    "ship_name", "ship_city", "ship_state", "ship_zip",
    "last_processed_at"
]

# Fields to exclude from saving to CSV/Excel
EXCLUDE_FIELDS = {
    "source_status", "subject", "fstatus", "pmt_holder_name", "pmt_status",
    "ord_time", "emp_id", "ord_form_type", "bill_name_last", "bill_name_first",
    "bill_phone_day", "bill_phone_eve", "bill_city", "bill_state", "bill_zip",
    "bill_country", "bill_email", "amt_subtotal", "amt_tax", "amt_sh",
    "amt_sh2", "amt_sh4", "amt_d1", "amt_discount", "amt_total", "pmt_promo",
    "log_result", "florist_notes", "tags", "ship_timezone", "local_time_now",
    "target_time", "ord_type", "earliestdatechange", "tracking_id", "expedited_time"
}


# ── Helpers ──────────────────────────────────────────────────────────────────

def load_dotenv_file(path=None):
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


def _normalize_api_base(url: str) -> str:
    """Strip trailing slash and any trailing numeric segment (order ID placeholder)."""
    cleaned = url.strip().rstrip("/")
    if cleaned.split("/")[-1].isdigit():
        cleaned = "/".join(cleaned.split("/")[:-1])
    return cleaned


# ── logs.txt helpers ─────────────────────────────────────────────────────────

def load_logged_ids() -> set:
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
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOGS_PATH, "a", encoding="utf-8") as f:
        f.write(order_id + "\n")


# ── Input reader ─────────────────────────────────────────────────────────────

def load_order_ids_from_gettask() -> list:
    """Read order_id + task_id rows from GetTask's data.csv."""
    if not GETTASK_CSV.exists():
        print(f"[{SCRIPT_NAME}] ERROR: GetTask output not found: {GETTASK_CSV}")
        print(f"[{SCRIPT_NAME}]   → Run GetTask.py first.")
        return None
    rows = []
    with open(GETTASK_CSV, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            oid = str(row.get("order_id", "")).strip()
            if oid:
                rows.append({
                    "order_id": oid,
                    "task_id":  str(row.get("task_id", "")).strip(),
                    "source_status": str(row.get("source_status", "")).strip(),
                    "subject": str(row.get("subject", "")).strip(),
                })
    return rows


# ── Output writers ───────────────────────────────────────────────────────────

def save_one_record_to_csv(record: dict):
    """Append a single record to data.csv immediately."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    file_exists = CSV_PATH.exists()

    all_keys = list(FIELDNAMES)
    for k in record:
        if k not in all_keys and k not in EXCLUDE_FIELDS:
            all_keys.append(k)

    # Filter the record to only include allowed keys
    filtered_record = {k: v for k, v in record.items() if k in all_keys}

    with open(CSV_PATH, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=all_keys, extrasaction="ignore")
        if not file_exists:
            writer.writeheader()
        writer.writerow(filtered_record)


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


def append_to_payload_json(order_id: str, payload: dict):
    """Append/update one order's raw payload into the combined payload.json."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    all_payloads = {}
    if PAYLOAD_PATH.exists():
        try:
            with open(PAYLOAD_PATH, "r", encoding="utf-8") as f:
                all_payloads = json.load(f)
        except (json.JSONDecodeError, ValueError):
            all_payloads = {}
    all_payloads[order_id] = payload
    with open(PAYLOAD_PATH, "w", encoding="utf-8") as f:
        json.dump(all_payloads, f, indent=2, ensure_ascii=False)


def save_query_txt(order_id: str, request_url: str, actual_url: str, headers: dict):
    """Save/update query.txt with the latest request details."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(QUERY_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write(f"Last updated at : {get_now_iso()}\n")
        f.write(f"Last order ID   : {order_id}\n")
        f.write("\n")
        f.write("=== REQUEST URL (base template) ===\n")
        f.write(f"{request_url}\n")
        f.write("\n")
        f.write("=== FULL URL SENT TO SERVER ===\n")
        f.write(f"{actual_url}\n")
        f.write("\n")
        f.write("=== HEADERS SENT ===\n")
        for k, v in headers.items():
            f.write(f"  {k}: {v}\n")


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description=f"{SCRIPT_NAME} – fetch order details")
    parser.add_argument("--force", action="store_true",
                        help="Ignore logs.txt and reprocess all order IDs")
    parser.add_argument("--limit", type=int, default=0,
                        help="Cap how many orders to process (0 = unlimited)")
    args = parser.parse_args()

    load_dotenv_file()

    api_base       = _normalize_api_base(_required_env("API_URL_ORDER_INQUIRY"))
    api_key_header = _required_env("API_KEY_HEADER")
    api_key_value  = _required_env("API_KEY_VALUE")
    headers        = {api_key_header: api_key_value, "Accept": "application/json"}

    # -- 1. Load order IDs from GetTask output --------------------------------
    order_rows = load_order_ids_from_gettask()
    if order_rows is None:
        raise SystemExit(f"[{SCRIPT_NAME}] Cannot continue without GetTask output.")
    if not order_rows:
        print(f"[{SCRIPT_NAME}] No order IDs found in {GETTASK_CSV.name}; nothing to process.")
        return

    print(f"[{SCRIPT_NAME}] API base : {api_base}")
    print(f"+" + "-"*57 + "+")
    print(f"|  INPUT SUMMARY                                          |")
    print(f"|  Orders loaded from GetTask : {len(order_rows):<28}|")
    print(f"+" + "-"*57 + "+")
    print()

    # -- 2. Load already-processed IDs ----------------------------------------
    logged_ids = set() if args.force else load_logged_ids()
    if logged_ids:
        print(f"[{SCRIPT_NAME}] Loaded {len(logged_ids)} already-processed IDs from logs.txt")
    elif not LOGS_PATH.exists():
        print(f"[{SCRIPT_NAME}] logs.txt not found – will process all orders")
    else:
        print(f"[{SCRIPT_NAME}] logs.txt exists but is empty – will process all orders")

    # -- 3. Process each order -------------------------------------------------
    new_count     = 0
    skipped_count = 0
    error_count   = 0
    total         = len(order_rows)

    print(f"\n" + "="*60)
    print(f"  LIVE PROCESSING  –  {total} orders")
    print("="*60 + "\n")

    for idx, row in enumerate(order_rows, start=1):
        order_id = row["order_id"]
        task_id  = row.get("task_id", "")

        print(f"[{idx}/{total}] {'-'*37}")
        print(f"  Order ID : {order_id}")
        print(f"  Task  ID : {task_id or '(none)'}")

        if order_id in logged_ids and not args.force:
            print(f"  >> SKIP - already in logs.txt")
            skipped_count += 1
            continue

        request_url = f"{api_base}/{order_id}"
        print(f"  -> GET {request_url}")

        try:
            resp = requests.get(request_url, headers=headers, timeout=TIMEOUT_SECONDS)
            resp.raise_for_status()
            actual_url = resp.url
            payload    = resp.json()
        except Exception as e:
            print(f"  [!] ERROR: {e}")
            error_count += 1
            # Still mark query.txt with last attempted URL
            save_query_txt(order_id, f"{api_base}/<order_id>",
                           request_url, headers)
            continue

        # -- Show server response fields ----------------------------------
        print(f"  -- Result Details (Filtered) --------------------")
        for k, v in payload.items():
            snake = k.replace(" ", "_").lower()
            if snake not in EXCLUDE_FIELDS:
                # Truncate long values for terminal display
                display_val = str(v)
                if len(display_val) > 100:
                    display_val = display_val[:97] + "..."
                print(f"    {k:20}: {display_val}")

        # -- Build record -------------------------------------------------
        record = {
            "order_id":          order_id,
            "task_id":           task_id,
            "ship_name":         payload.get("ship_Name", ""),
            "ship_city":         payload.get("ship_City", ""),
            "ship_state":        payload.get("ship_State", ""),
            "ship_zip":          payload.get("ship_Zip", ""),
            "last_processed_at": get_now_iso(),
        }

        # Carry over any extra fields from server
        for k, v in payload.items():
            snake = k.replace(" ", "_").lower()
            if snake not in record and snake not in EXCLUDE_FIELDS:
                record[snake] = v

        # -- Immediate save -----------------------------------------------
        save_one_record_to_csv(record)
        rebuild_excel_from_csv()
        append_to_payload_json(order_id, payload)
        save_query_txt(order_id, f"{api_base}/<order_id>", actual_url, headers)
        append_logged_id(order_id)
        logged_ids.add(order_id)
        new_count += 1

        print(f"  [OK] SAVED to CSV & Excel  (total saved so far: {new_count})")

        if args.limit > 0 and new_count >= args.limit:
            print(f"\n[{SCRIPT_NAME}] Reached --limit={args.limit}; stopping early.")
            break

    # -- Summary ---------------------------------------------------------------
    print(f"\n" + "="*60)
    print(f"  DONE  --  Saved: {new_count}  |  Skipped: {skipped_count}  |  Errors: {error_count}")
    print("="*60)
    print(f"\n[{SCRIPT_NAME}] Output folder : {OUTPUT_DIR}")
    print(f"[{SCRIPT_NAME}] Files created :")
    for fp in [CSV_PATH, EXCEL_PATH, PAYLOAD_PATH, LOGS_PATH, QUERY_PATH]:
        mark = "[OK]" if fp.exists() else "[--]"
        print(f"  {mark}  {fp.name}")


if __name__ == "__main__":
    main()
