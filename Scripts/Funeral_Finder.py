import json
import os
import sys
import io
import csv
import re
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
PERPLEXITY_URL  = "https://api.perplexity.ai/chat/completions"
TIMEOUT_SECONDS = 120
SCRIPT_NAME     = "Funeral_Finder"
SCRIPTS_DIR     = Path(__file__).resolve().parent
OUTPUT_DIR      = SCRIPTS_DIR / "outputs" / SCRIPT_NAME

# Input: reads from GetOrderInquiry output
INPUT_CSV = SCRIPTS_DIR / "outputs" / "GetOrderInquiry" / "data.csv"

# Prompt template
DEFAULT_PROMPT_TEMPLATE = SCRIPTS_DIR / "prompts" / "funeral_search_template.md"

# Output file paths
CSV_PATH              = OUTPUT_DIR / "Funeral_data.csv"
EXCEL_PATH            = OUTPUT_DIR / "Funeral_data.xlsx"
NOT_FOUND_CSV_PATH    = OUTPUT_DIR / "Funeral_data_not_found.csv"
NOT_FOUND_EXCEL_PATH  = OUTPUT_DIR / "Funeral_data_not_found.xlsx"
REVIEW_CSV_PATH       = OUTPUT_DIR / "Funeral_data_review.csv"
REVIEW_EXCEL_PATH     = OUTPUT_DIR / "Funeral_data_review.xlsx"
PAYLOAD_PATH          = OUTPUT_DIR / "payload.json"
LOGS_PATH             = OUTPUT_DIR / "logs.txt"

# Canonical column order for CSV/Excel output
FIELDNAMES = [
    "order_id", "task_id", "ship_name", "ship_city", "ship_state", "ship_zip",
    "ship_care_of", "ship_address", "ship_address_unit", "ship_country",
    "ord_instruct",
    "funeral_home_name", "funeral_address", "funeral_phone",
    "service_type", "service_date", "service_time",
    "visitation_date", "visitation_time",
    "delivery_recommendation_date", "delivery_recommendation_time",
    "delivery_recommendation_location", "special_instructions",
    "match_status", "ai_accuracy_score",
    "source_urls", "notes",
    "last_processed_at",
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


def _extract_json_from_text(text: str) -> dict:
    """Robust JSON extractor — 3 strategies, returns largest valid object."""
    if not text:
        return {}

    # Strategy 1: largest valid JSON object
    best = {}
    for match in re.finditer(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}", text, re.DOTALL):
        try:
            candidate = json.loads(match.group(0))
            if len(candidate) > len(best):
                best = candidate
        except (json.JSONDecodeError, ValueError):
            pass
    if best:
        return best

    # Strategy 2: first { to last }
    start = text.find("{")
    end   = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except (json.JSONDecodeError, ValueError):
            pass

    # Strategy 3: markdown code blocks
    for pattern in [r"```json\s*(.*?)```", r"```\s*(.*?)```"]:
        m = re.search(pattern, text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(1).strip())
            except (json.JSONDecodeError, ValueError):
                pass

    return {}


def _extract_structured_fields_from_text(text: str) -> dict:
    """Fallback parser for colon-formatted responses when JSON is missing."""
    if not text:
        return {}

    key_aliases = {
        "funeral home name (optional)": "funeral_home_name",
        "funeral home name": "funeral_home_name",
        "funeral_home_name": "funeral_home_name",
        "service location": "funeral_address",
        "funeral_address": "funeral_address",
        "phone number": "funeral_phone",
        "funeral_phone": "funeral_phone",
        "venue type": "service_type",
        "service_type": "service_type",
        "funeral date": "funeral_date",
        "service_date": "service_date",
        "funeral time": "funeral_time",
        "service_time": "service_time",
        "visitation date": "visitation_date",
        "visitation time": "visitation_time",
        "optimal delivery date": "delivery_recommendation_date",
        "optimal delivery time": "delivery_recommendation_time",
        "deliver to": "delivery_recommendation_location",
        "special instructions": "special_instructions",
        "status": "status",
        "ai accuracy score": "AI Accuracy Score",
        "notes": "notes",
        "summary": "Summary",
        "status justification": "Status Justification",
    }

    extracted = {}
    source_urls = []

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        if re.match(r"^[-*]\s+https?://", line, re.IGNORECASE):
            source_urls.append(re.sub(r"^[-*]\s+", "", line))
            continue
        if re.match(r"^https?://", line, re.IGNORECASE):
            source_urls.append(line)
            continue

        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        normalized_key = key.strip().lower()
        mapped_key = key_aliases.get(normalized_key)
        if mapped_key:
            extracted[mapped_key] = value.strip()

    if source_urls:
        extracted["source_urls"] = source_urls

    return extracted


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

def load_orders_from_inquiry() -> list:
    """
    Read order data from GetOrderInquiry/data.csv.
    De-duplicates by order_id (keeps first occurrence).
    Returns list of dicts with the combined column data.
    """
    if not INPUT_CSV.exists():
        print(f"[{SCRIPT_NAME}] ERROR: Input CSV not found: {INPUT_CSV}")
        print(f"[{SCRIPT_NAME}]   → Run GetOrderInquiry.py first.")
        return []

    orders = []
    seen_ids = set()

    with open(INPUT_CSV, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            oid = _safe_str(row.get("order_id"))
            if not oid or oid in seen_ids:
                continue
            seen_ids.add(oid)

            orders.append({
                "order_id":          oid,
                "task_id":           _safe_str(row.get("task_id")),
                "ship_name":         _safe_str(row.get("ship_name")),
                "ship_city":         _safe_str(row.get("ship_city")),
                "ship_state":        _safe_str(row.get("ship_state")),
                "ship_zip":          _safe_str(row.get("ship_zip")),
                "ship_care_of":      _safe_str(row.get("ship_care_of")),
                "ship_address":      _safe_str(row.get("ship_address")),
                "ship_address_unit": _safe_str(row.get("ship_address_unit")),
                "ship_country":      _safe_str(row.get("ship_country")),
                "ord_instruct":      _safe_str(row.get("ord_instruct")),
            })

    return orders


# ── Prompt builder ───────────────────────────────────────────────────────────

def build_prompt(order: dict, template_text: str) -> str:
    """
    Combine columns C,D,E,F,J,K,L,M,U into a context block
    and insert into the prompt template.
    """
    # Build a clear, structured context from the order data
    context_lines = []
    context_lines.append(f"Name: {order['ship_name']}")
    context_lines.append(f"City: {order['ship_city']}")
    context_lines.append(f"State: {order['ship_state']}")
    context_lines.append(f"ZIP: {order['ship_zip']}")

    if order['ship_care_of']:
        context_lines.append(f"Funeral Home / Care Of: {order['ship_care_of']}")
    if order['ship_address']:
        addr = order['ship_address']
        if order['ship_address_unit']:
            addr += f", Unit {order['ship_address_unit']}"
        context_lines.append(f"Address: {addr}")
    if order['ship_country']:
        context_lines.append(f"Country: {order['ship_country']}")
    if order['ord_instruct']:
        context_lines.append(f"Delivery Instructions / Known Details: {order['ord_instruct']}")

    context_block = "\n".join(context_lines)

    # Insert into template
    if template_text and "[INSERT PROMPT/Details HERE]" in template_text:
        prompt = template_text.replace("[INSERT PROMPT/Details HERE]", context_block)
    elif template_text:
        prompt = template_text + "\n\n" + context_block
    else:
        prompt = (
            "Find funeral/memorial service details for this person. "
            "Return JSON with keys: funeral_home_name, funeral_address, funeral_phone, "
            "service_type, funeral_date, funeral_time, visitation_date, visitation_time, "
            "delivery_recommendation_date, delivery_recommendation_time, "
            "delivery_recommendation_location, special_instructions, "
            "status (Found/NotFound/Review), AI Accuracy Score (0-100), "
            "source_urls (list), notes.\n\n"
            f"{context_block}"
        )

    return prompt


# ── Output writers ───────────────────────────────────────────────────────────

def save_one_record_to_csv(csv_path: Path, record: dict):
    """Append a single record to a CSV file immediately."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    file_exists = csv_path.exists()

    all_keys = list(FIELDNAMES)
    for k in record:
        if k not in all_keys:
            all_keys.append(k)

    with open(csv_path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=all_keys, extrasaction="ignore")
        if not file_exists:
            writer.writeheader()
        writer.writerow(record)


def rebuild_excel_from_csv(csv_path: Path, excel_path: Path, sheet_name: str = "Funeral Data"):
    """Rebuild an Excel file from a CSV file (called after each save)."""
    if not OPENPYXL_AVAILABLE or not csv_path.exists():
        return
    with open(csv_path, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or FIELDNAMES
        all_rows = list(reader)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet_name
    ws.append(list(fieldnames))
    for row in all_rows:
        ws.append([row.get(col, "") for col in fieldnames])
    wb.save(excel_path)


def append_to_payload_json(order_id: str, payload: dict):
    """Append/update one order's sent payload into the combined payload.json."""
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


# ── AI response parser ──────────────────────────────────────────────────────

def parse_ai_response(ai_text: str) -> dict:
    """Parse Perplexity AI response text into structured fields."""
    ai_data = _extract_json_from_text(ai_text)
    if not ai_data:
        ai_data = _extract_structured_fields_from_text(ai_text)

    # Status — check all key name variants AI might return
    raw_status = _safe_str(
        ai_data.get("status")       or ai_data.get("Status")      or
        ai_data.get("STATUS")       or ai_data.get("match_status") or
        ai_data.get("Match Status") or ai_data.get("result")      or ""
    )
    status_lower = raw_status.lower().strip()
    if status_lower in ("found", "matched", "yes", "confirmed"):
        match_status = "Found"
    elif status_lower in ("notfound", "not_found", "not found", "mismatched", "no", "none"):
        match_status = "NotFound"
    elif status_lower in ("review", "needs_review", "needs review", "uncertain", "unverified"):
        match_status = "Review"
    else:
        # Unknown status should stay review-first to avoid false NotFound.
        has_data = bool(
            ai_data.get("funeral_home_name") or ai_data.get("Funeral home name (optional)") or
            ai_data.get("funeral_date")      or ai_data.get("Funeral date") or
            ai_data.get("service_date")      or
            ai_data.get("funeral_time")      or ai_data.get("Funeral time") or ai_data.get("service_time") or
            ai_data.get("funeral_address")   or ai_data.get("Service location") or
            ai_data.get("source_urls")       or ai_data.get("Source URLs")
        )
        match_status = "Review" if has_data else "NotFound"

    # Score — check all key name variants
    score = (
        ai_data.get("AI Accuracy Score")  or ai_data.get("ai_accuracy_score") or
        ai_data.get("Accuracy Score")     or ai_data.get("accuracy_score")    or
        ai_data.get("confidence_score")   or ai_data.get("Confidence Score")  or
        ai_data.get("score")              or ai_data.get("Score")             or 0
    )
    try:
        score = float(str(score).replace("%", "").strip())
    except (ValueError, TypeError):
        score = 0

    # Source URLs
    urls = ai_data.get("source_urls") or ai_data.get("Source URLs") or []
    if isinstance(urls, list):
        source_urls = " | ".join(str(u) for u in urls if u)
    else:
        source_urls = _safe_str(urls)

    # Final status override based on required score thresholds.
    if score > 70:
        match_status = "Found"
    elif 50 <= score <= 70:
        has_any_data = bool(
            ai_data.get("funeral_home_name") or ai_data.get("Funeral home name (optional)") or
            ai_data.get("funeral_date") or ai_data.get("Funeral date") or ai_data.get("service_date")
        )
        match_status = "Review" if has_any_data else "NotFound"
    else:
        match_status = "NotFound"

    return {
        "funeral_home_name":              _safe_str(ai_data.get("funeral_home_name") or ai_data.get("Funeral home name (optional)")),
        "funeral_address":                _safe_str(ai_data.get("funeral_address") or ai_data.get("Service location")),
        "funeral_phone":                  _safe_str(ai_data.get("funeral_phone") or ai_data.get("Phone number")),
        "service_type":                   _safe_str(ai_data.get("service_type") or ai_data.get("Venue type")),
        "service_date":                   _safe_str(ai_data.get("funeral_date") or ai_data.get("Funeral date")),
        "service_time":                   _safe_str(ai_data.get("funeral_time") or ai_data.get("Funeral time")),
        "visitation_date":                _safe_str(ai_data.get("visitation_date") or ai_data.get("Visitation date")),
        "visitation_time":                _safe_str(ai_data.get("visitation_time") or ai_data.get("Visitation time")),
        "delivery_recommendation_date":   _safe_str(ai_data.get("delivery_recommendation_date") or ai_data.get("OPTIMAL DELIVERY DATE")),
        "delivery_recommendation_time":   _safe_str(ai_data.get("delivery_recommendation_time") or ai_data.get("OPTIMAL DELIVERY TIME")),
        "delivery_recommendation_location": _safe_str(ai_data.get("delivery_recommendation_location") or ai_data.get("DELIVER TO")),
        "special_instructions":           _safe_str(ai_data.get("special_instructions") or ai_data.get("SPECIAL INSTRUCTIONS")),
        "match_status":                   match_status,
        "ai_accuracy_score":              score,
        "source_urls":                    source_urls,
        "notes":                          _safe_str(ai_data.get("notes") or ai_data.get("Summary") or ai_data.get("Status Justification")),
    }


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description=f"{SCRIPT_NAME} – find funeral details via Perplexity AI")
    parser.add_argument("--force", action="store_true",
                        help="Ignore logs.txt and reprocess all order IDs")
    parser.add_argument("--limit", type=int, default=0,
                        help="Cap how many orders to process (0 = unlimited)")
    args = parser.parse_args()

    load_dotenv_file()

    pplx_api_key = _required_env("PERPLEXITY_API_KEY")

    # Load prompt template
    template_path = Path(os.getenv("FUNERAL_PROMPT_TEMPLATE", str(DEFAULT_PROMPT_TEMPLATE)))
    template_text = ""
    if template_path.exists():
        template_text = template_path.read_text(encoding="utf-8")
        print(f"[{SCRIPT_NAME}] Prompt template loaded: {template_path.name}")
    else:
        print(f"[{SCRIPT_NAME}] WARNING: Prompt template not found: {template_path}")
        print(f"[{SCRIPT_NAME}]   → Using built-in fallback prompt")

    # ── 1. Load orders from GetOrderInquiry output ───────────────────────────
    orders = load_orders_from_inquiry()
    if not orders:
        print(f"[{SCRIPT_NAME}] No orders to process.")
        return

    print(f"\n┌─────────────────────────────────────────────────────────┐")
    print(f"│  INPUT SUMMARY                                          │")
    print(f"│  Orders loaded (de-duped) : {len(orders):<29}│")
    print(f"│  Source file              : GetOrderInquiry/data.csv     │")
    print(f"└─────────────────────────────────────────────────────────┘")

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
    error_count   = 0
    found_count   = 0
    not_found_count = 0
    review_count  = 0
    total         = len(orders)

    print(f"\n{'═'*60}")
    print(f"  🔍 LIVE PROCESSING  –  {total} orders")
    print(f"{'═'*60}\n")

    for idx, order in enumerate(orders, start=1):
        order_id  = order["order_id"]
        ship_name = order["ship_name"]

        print(f"[{idx}/{total}] {'─'*45}")
        print(f"  Order ID  : {order_id}")
        print(f"  Name      : {ship_name}")
        print(f"  Location  : {order['ship_city']}, {order['ship_state']} {order['ship_zip']}")
        if order['ship_care_of']:
            print(f"  Care Of   : {order['ship_care_of']}")

        # Skip check
        if order_id in logged_ids and not args.force:
            print(f"  ⏭  SKIP – already in logs.txt")
            skipped_count += 1
            continue

        # Limit check
        if args.limit > 0 and new_count >= args.limit:
            print(f"\n[{SCRIPT_NAME}] Reached --limit={args.limit}; stopping early.")
            break

        # Build prompt
        prompt = build_prompt(order, template_text)
        print(f"  → Sending to Perplexity AI (sonar-pro)...")

        # Build API payload
        api_payload = {
            "model": "sonar-pro",
            "messages": [
                {"role": "system", "content": "You are an assistant that finds funeral and memorial service details. Return your findings in valid JSON format with these keys: funeral_home_name, funeral_address, funeral_phone, service_type, funeral_date, funeral_time, visitation_date, visitation_time, delivery_recommendation_date, delivery_recommendation_time, delivery_recommendation_location, special_instructions, status (Found/NotFound/Review), AI Accuracy Score (0-100), source_urls (list), notes."},
                {"role": "user", "content": prompt}
            ]
        }

        headers = {
            "Authorization": f"Bearer {pplx_api_key}",
            "Content-Type": "application/json"
        }

        try:
            response = requests.post(
                PERPLEXITY_URL,
                headers=headers,
                json=api_payload,
                timeout=TIMEOUT_SECONDS
            )

            if response.status_code >= 400:
                print(f"  ❌ API ERROR: {response.status_code} {response.text[:200]}")
                error_count += 1
                # Save failed payload to payload.json anyway
                append_to_payload_json(order_id, {
                    "sent": api_payload,
                    "error": f"{response.status_code} {response.text[:500]}",
                    "timestamp": get_now_iso()
                })
                continue

            resp_json = response.json()
            ai_text = resp_json.get("choices", [{}])[0].get("message", {}).get("content", "")

        except Exception as e:
            print(f"  ❌ REQUEST ERROR: {e}")
            error_count += 1
            append_to_payload_json(order_id, {
                "sent": api_payload,
                "error": str(e),
                "timestamp": get_now_iso()
            })
            continue

        # Parse AI response
        parsed = parse_ai_response(ai_text)

        # Show result in terminal
        status = parsed["match_status"]
        score  = parsed["ai_accuracy_score"]
        status_icon = {"Found": "✅", "NotFound": "❌", "Review": "⚠️"}.get(status, "❓")
        print(f"  {status_icon} Status: {status}  |  AI Score: {score}%")

        if parsed["funeral_home_name"]:
            print(f"  🏠 Funeral Home : {parsed['funeral_home_name']}")
        if parsed["service_date"]:
            print(f"  📅 Service Date : {parsed['service_date']} {parsed['service_time']}")
        if parsed["visitation_date"]:
            print(f"  📅 Visitation   : {parsed['visitation_date']} {parsed['visitation_time']}")
        if parsed["delivery_recommendation_date"]:
            print(f"  🚚 Deliver By   : {parsed['delivery_recommendation_date']} {parsed['delivery_recommendation_time']}")
        if parsed["source_urls"]:
            print(f"  🔗 Sources      : {parsed['source_urls'][:100]}")

        # Build record
        record = {
            "order_id":          order_id,
            "task_id":           order["task_id"],
            "ship_name":         order["ship_name"],
            "ship_city":         order["ship_city"],
            "ship_state":        order["ship_state"],
            "ship_zip":          order["ship_zip"],
            "ship_care_of":      order["ship_care_of"],
            "ship_address":      order["ship_address"],
            "ship_address_unit": order["ship_address_unit"],
            "ship_country":      order["ship_country"],
            "ord_instruct":      order["ord_instruct"],
            "last_processed_at": get_now_iso(),
        }
        record.update(parsed)

        # ── IMMEDIATE SAVE: Main CSV + Excel ─────────────────────────────
        save_one_record_to_csv(CSV_PATH, record)
        rebuild_excel_from_csv(CSV_PATH, EXCEL_PATH, "Funeral Data")
        print(f"  📁 Saved to Funeral_data.csv & .xlsx")

        # ── CATEGORY FILES: Not Found / Review ───────────────────────────
        if status == "NotFound":
            save_one_record_to_csv(NOT_FOUND_CSV_PATH, record)
            rebuild_excel_from_csv(NOT_FOUND_CSV_PATH, NOT_FOUND_EXCEL_PATH, "Not Found")
            not_found_count += 1
            print(f"  📁 Also saved to Funeral_data_not_found.csv & .xlsx")
        elif status == "Review":
            save_one_record_to_csv(REVIEW_CSV_PATH, record)
            rebuild_excel_from_csv(REVIEW_CSV_PATH, REVIEW_EXCEL_PATH, "Review")
            review_count += 1
            print(f"  📁 Also saved to Funeral_data_review.csv & .xlsx")
        else:
            found_count += 1

        # ── Save payload (what was sent + raw AI response) ───────────────
        append_to_payload_json(order_id, {
            "sent": {
                "model": api_payload["model"],
                "prompt_context": {
                    "ship_name":    order["ship_name"],
                    "ship_city":    order["ship_city"],
                    "ship_state":   order["ship_state"],
                    "ship_zip":     order["ship_zip"],
                    "ship_care_of": order["ship_care_of"],
                    "ship_address": order["ship_address"],
                    "ord_instruct": order["ord_instruct"],
                },
            },
            "raw_ai_response": ai_text,
            "parsed_result": parsed,
            "timestamp": get_now_iso()
        })

        # ── Update logs.txt ──────────────────────────────────────────────
        append_logged_id(order_id)
        logged_ids.add(order_id)
        new_count += 1

        print(f"  ✓ DONE  (processed so far: {new_count})")

    # ── Summary ──────────────────────────────────────────────────────────────
    print(f"\n{'═'*60}")
    print(f"  📊 TASK COMPLETION SUMMARY")
    print(f"{'═'*60}")
    print(f"  ✅ Found      : {found_count}")
    print(f"  ❌ Not Found  : {not_found_count}")
    print(f"  ⚠️  Review     : {review_count}")
    print(f"  ⏭️  Skipped    : {skipped_count}")
    print(f"  💥 Errors     : {error_count}")
    print(f"{'─'*60}")
    print(f"  📁 Total      : {total}")
    print(f"  🆕 Processed  : {new_count}")
    print(f"{'═'*60}")

    print(f"\n[{SCRIPT_NAME}] Output folder : {OUTPUT_DIR}")
    print(f"[{SCRIPT_NAME}] Files created :")
    for fp in [CSV_PATH, EXCEL_PATH, NOT_FOUND_CSV_PATH, NOT_FOUND_EXCEL_PATH,
               REVIEW_CSV_PATH, REVIEW_EXCEL_PATH, PAYLOAD_PATH, LOGS_PATH]:
        mark = "✓" if fp.exists() else "✗"
        print(f"  {mark}  {fp.name}")


if __name__ == "__main__":
    main()
