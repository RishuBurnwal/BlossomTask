import json
import os
import sys
import io
import requests
import csv
import re
import argparse
from pathlib import Path
from datetime import datetime
from urllib.parse import urlparse

# Ensure UTF-8 output for Windows terminals with line-buffered flushing
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
        # Keep original stdout if wrapping is unsupported.
        return

_configure_windows_stdout_utf8()

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
DATE_WISE_DIR   = OUTPUT_DIR / "date_wise"
LOGS_BY_DATE_DIR = OUTPUT_DIR / "logs_by_date"

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


def _run_date_key() -> str:
    """Return YYYY-MM-DD for date-wise output partitioning."""
    return datetime.now().date().isoformat()


def get_date_wise_csv_path(date_key: str | None = None) -> Path:
    """Return date-partitioned CSV path for today's processed rows."""
    key = date_key or _run_date_key()
    return DATE_WISE_DIR / f"Funeral_data_{key}.csv"


def get_date_wise_log_path(date_key: str | None = None) -> Path:
    """Return date-partitioned processed-id log path."""
    key = date_key or _run_date_key()
    return LOGS_BY_DATE_DIR / f"processed_{key}.txt"


def ensure_log_files(date_key: str | None = None) -> tuple[Path, Path]:
    """Create base log files so skip logic and audit files always exist."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    DATE_WISE_DIR.mkdir(parents=True, exist_ok=True)
    LOGS_BY_DATE_DIR.mkdir(parents=True, exist_ok=True)

    if not LOGS_PATH.exists():
        LOGS_PATH.write_text("", encoding="utf-8")

    daily_log_path = get_date_wise_log_path(date_key)
    if not daily_log_path.exists():
        daily_log_path.write_text("", encoding="utf-8")

    return LOGS_PATH, daily_log_path


def append_date_wise_processed_log(order_id: str, status: str, date_key: str | None = None):
    """Append timestamped processing entries in date-wise log files."""
    normalized_id = _safe_str(order_id)
    if not normalized_id:
        return
    daily_log_path = get_date_wise_log_path(date_key)
    LOGS_BY_DATE_DIR.mkdir(parents=True, exist_ok=True)
    with open(daily_log_path, "a", encoding="utf-8") as f:
        f.write(f"{get_now_iso()}\t{normalized_id}\t{_safe_str(status)}\n")

SYSTEM_PROMPT = (
    "You are an assistant that finds funeral and memorial service details. Return valid JSON with these keys: "
    "funeral_home_name, funeral_address, funeral_phone, service_type, funeral_date, funeral_time, visitation_date, "
    "visitation_time, ceremony_date, ceremony_time, delivery_recommendation_date, delivery_recommendation_time, "
    "delivery_recommendation_location, special_instructions, status (Found/NotFound/Review), AI Accuracy Score (0-100 confidence for status), source_urls (list), notes. "
    "Scoring guidance: 85-100 exact match with source URL and concrete service details; 70-84 strong match with URL and partial details; "
    "50-69 partial/uncertain; 0-49 weak or no reliable match. No source URL means score must be <=50. "
    "For very common names without unique identifiers, keep score below 60. "
    "Set Found when at least one valid date+time pair exists in funeral/service, visitation, or ceremony fields. "
    "Set NotFound when no valid date+time pair exists in those fields. "
    "Do not use delivery recommendation fields as service datetime fallback."
)

# Canonical column order for CSV/Excel output
FIELDNAMES = [
    "order_id", "task_id", "ship_name", "ship_city", "ship_state", "ship_zip",
    "ship_care_of", "ship_address", "ship_address_unit", "ship_country",
    "ord_instruct",
    "funeral_home_name", "funeral_address", "funeral_phone",
    "service_type", "service_date", "service_time",
    "visitation_date", "visitation_time",
    "ceremony_date", "ceremony_time",
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
    """Robust JSON extractor — use raw_decode so nested objects are handled safely."""
    if not text:
        return {}

    best = {}
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", text):
        try:
            candidate, _ = decoder.raw_decode(text[match.start():])
            if isinstance(candidate, dict) and len(candidate) > len(best):
                best = candidate
        except (json.JSONDecodeError, ValueError, TypeError):
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


def _normalize_service_datetime(
    service_date: str,
    service_time: str,
    visitation_date: str,
    visitation_time: str,
    ceremony_date: str,
    ceremony_time: str,
) -> tuple[str, str, str]:
    """Normalize canonical service datetime using service/visitation/ceremony pairs only."""
    if service_date and service_time:
        return service_date, service_time, "service"
    if visitation_date and visitation_time:
        return visitation_date, visitation_time, "visitation"
    if ceremony_date and ceremony_time:
        return ceremony_date, ceremony_time, "ceremony"
    return service_date, service_time, "none"


def _append_unique_note(base: str, note: str) -> str:
    base_text = _safe_str(base)
    note_text = _safe_str(note)
    if not note_text:
        return base_text
    if note_text in base_text:
        return base_text
    return f"{base_text} | {note_text}".strip(" |")


def _has_schedule_hint(text: str) -> bool:
    value = _safe_str(text).lower()
    if not value:
        return False
    has_event_keyword = any(
        keyword in value
        for keyword in ["service", "funeral", "memorial", "visitation", "viewing", "wake", "burial"]
    )
    has_time_or_date = bool(
        re.search(r"\b\d{1,2}:\d{2}\s*(am|pm)\b", value)
        or re.search(r"\b\d{1,2}\s*(am|pm)\b", value)
        or re.search(r"\b(mon|tue|wed|thu|fri|sat|sun)\b", value)
        or re.search(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b", value)
        or re.search(r"\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b", value)
    )
    return has_event_keyword and has_time_or_date


def _destination_type(order: dict) -> str:
    destination_text = " ".join(
        [
            _safe_str(order.get("ship_care_of")),
            _safe_str(order.get("ship_address")),
            _safe_str(order.get("ord_instruct")),
        ]
    ).lower()
    if not destination_text:
        return "unknown"
    if any(
        keyword in destination_text
        for keyword in [
            "funeral",
            "funeral home",
            "church",
            "chapel",
            "cemetery",
            "mortuary",
            "cremation",
            "crematory",
            "community center",
            "memorial",
            "celebration of life",
        ]
    ):
        return "funeral"
    if any(keyword in destination_text for keyword in ["p.o. box", "po box", "apartment", "apt", "office", "home"]):
        return "non_funeral"
    return "unknown"


def _apply_business_rules(order: dict, parsed: dict) -> dict:
    adjusted = dict(parsed)
    notes = _safe_str(adjusted.get("notes"))
    customer_instructions = _safe_str(order.get("ord_instruct"))

    has_datetime_pair = bool(
        (_safe_str(adjusted.get("service_date")) and _safe_str(adjusted.get("service_time")))
        or (_safe_str(adjusted.get("visitation_date")) and _safe_str(adjusted.get("visitation_time")))
        or (_safe_str(adjusted.get("ceremony_date")) and _safe_str(adjusted.get("ceremony_time")))
    )

    if has_datetime_pair and adjusted.get("match_status") in {"NotFound", "Review"}:
        adjusted["match_status"] = "Found"
        adjusted["ai_accuracy_score"] = max(float(adjusted.get("ai_accuracy_score") or 0), 70.0)

    if not has_datetime_pair and adjusted.get("match_status") != "NotFound":
        adjusted["match_status"] = "NotFound"
        adjusted["ai_accuracy_score"] = min(float(adjusted.get("ai_accuracy_score") or 0), 49.0)
        notes = _append_unique_note(notes, "NotFound: no valid service/visitation/ceremony datetime pair")

    if _has_schedule_hint(customer_instructions):
        if not _safe_str(adjusted.get("special_instructions")):
            adjusted["special_instructions"] = f"Customer-provided schedule: {customer_instructions}"[:1000]
        elif customer_instructions not in _safe_str(adjusted.get("special_instructions")):
            adjusted["special_instructions"] = (
                f"{adjusted['special_instructions']} | Customer-provided schedule: {customer_instructions}"
            )[:1000]

        if adjusted.get("match_status") in {"NotFound", "Review"}:
            adjusted["match_status"] = "Found"
            adjusted["ai_accuracy_score"] = max(float(adjusted.get("ai_accuracy_score") or 0), 75.0)
            notes = _append_unique_note(notes, "Found via existing order instructions with schedule")

    if adjusted.get("match_status") == "Found" and _destination_type(order) == "non_funeral":
        adjusted["match_status"] = "Review"
        notes = _append_unique_note(notes, "Review required: destination appears non-funeral location")

    adjusted["notes"] = notes
    return adjusted


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
    """Build user prompt from template (if present) plus normalized order context."""
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
    normalized_template = _safe_str(template_text)
    if normalized_template:
        placeholder_markers = [
            "[INSERT CASE DATA HERE]",
            "{{INPUT_CONTEXT}}",
            "<<INPUT_CONTEXT>>",
            "[INPUT CONTEXT]",
        ]
        for marker in placeholder_markers:
            if marker in normalized_template:
                return normalized_template.replace(marker, context_block)
        return f"{normalized_template}\n\nINPUT CONTEXT\n{context_block}"
    return context_block


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

    funeral_home_name = _safe_str(ai_data.get("funeral_home_name") or ai_data.get("Funeral home name (optional)"))
    funeral_address = _safe_str(ai_data.get("funeral_address") or ai_data.get("Service location"))
    funeral_phone = _safe_str(ai_data.get("funeral_phone") or ai_data.get("Phone number"))
    service_type = _safe_str(ai_data.get("service_type") or ai_data.get("Venue type"))
    service_date = _safe_str(ai_data.get("funeral_date") or ai_data.get("Funeral date") or ai_data.get("service_date"))
    service_time = _safe_str(ai_data.get("funeral_time") or ai_data.get("Funeral time") or ai_data.get("service_time"))
    visitation_date = _safe_str(ai_data.get("visitation_date") or ai_data.get("Visitation date"))
    visitation_time = _safe_str(ai_data.get("visitation_time") or ai_data.get("Visitation time"))
    ceremony_date = _safe_str(ai_data.get("ceremony_date") or ai_data.get("Ceremony date"))
    ceremony_time = _safe_str(ai_data.get("ceremony_time") or ai_data.get("Ceremony time"))
    delivery_recommendation_date = _safe_str(ai_data.get("delivery_recommendation_date") or ai_data.get("OPTIMAL DELIVERY DATE"))
    delivery_recommendation_time = _safe_str(ai_data.get("delivery_recommendation_time") or ai_data.get("OPTIMAL DELIVERY TIME"))
    delivery_recommendation_location = _safe_str(ai_data.get("delivery_recommendation_location") or ai_data.get("DELIVER TO"))
    special_instructions = _safe_str(ai_data.get("special_instructions") or ai_data.get("SPECIAL INSTRUCTIONS"))

    service_date, service_time, fallback_source = _normalize_service_datetime(
        service_date,
        service_time,
        visitation_date,
        visitation_time,
        ceremony_date,
        ceremony_time,
    )

    si_parts = []
    if special_instructions:
        si_parts.append(special_instructions)
    if visitation_date or visitation_time:
        viewing_bits = [bit for bit in [visitation_date, visitation_time] if bit]
        viewing_line = f"Viewing/Visitation: {' '.join(viewing_bits)}".strip()
        if viewing_line and viewing_line.lower() not in special_instructions.lower():
            si_parts.append(viewing_line)
    if service_date or service_time:
        service_bits = [bit for bit in [service_date, service_time] if bit]
        service_line = f"Service: {' '.join(service_bits)}".strip()
        if service_line and service_line.lower() not in " | ".join(si_parts).lower():
            si_parts.append(service_line)
    if ceremony_date or ceremony_time:
        ceremony_bits = [bit for bit in [ceremony_date, ceremony_time] if bit]
        ceremony_line = f"Ceremony: {' '.join(ceremony_bits)}".strip()
        if ceremony_line and ceremony_line.lower() not in " | ".join(si_parts).lower():
            si_parts.append(ceremony_line)
    special_instructions = " | ".join(part for part in si_parts if part)

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
        has_data = bool(
            funeral_home_name or service_date or service_time or funeral_address or
            funeral_phone or service_type or visitation_date or visitation_time or
            ai_data.get("source_urls") or ai_data.get("Source URLs")
        )
        match_status = "Review" if has_data else "NotFound"

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
    score = max(0.0, min(100.0, score))

    urls = ai_data.get("source_urls") or ai_data.get("Source URLs") or []
    if isinstance(urls, list):
        raw_url_text = " | ".join(str(u) for u in urls if u)
    else:
        raw_url_text = _safe_str(urls)

    url_candidates = re.findall(r"https?://[^\s|]+", raw_url_text, re.IGNORECASE)
    valid_urls = []
    for candidate in url_candidates:
        normalized = candidate.rstrip(".,;:!?)\"]'")
        parsed = urlparse(normalized)
        if parsed.scheme in ("http", "https") and parsed.netloc:
            valid_urls.append(normalized)
    source_urls = " | ".join(valid_urls)

    has_sources = bool(valid_urls)
    if not has_sources and score > 50:
        score = 50.0

    evidence_values = [
        funeral_home_name,
        funeral_address,
        funeral_phone,
        service_type,
        service_date,
        service_time,
        visitation_date,
        visitation_time,
    ]
    invalid_markers = {"", "unknown", "na", "none", "null", "notfound"}

    def _normalized_marker(value: str) -> str:
        raw = _safe_str(value).lower().strip()
        return re.sub(r"[^a-z0-9]+", "", raw)

    evidence_count = sum(1 for value in evidence_values if _normalized_marker(value) not in invalid_markers)

    # Primary decision comes from AI status; score only gates ambiguous transitions.
    if match_status == "Found":
        if not (score >= 70 and evidence_count >= 2 and has_sources):
            if evidence_count >= 2:
                match_status = "Review"
            else:
                match_status = "NotFound"
    elif match_status == "Review":
        if score >= 85 and evidence_count >= 3 and has_sources:
            match_status = "Found"
        elif evidence_count >= 1 or has_sources:
            match_status = "Review"
        else:
            match_status = "NotFound"
    elif match_status == "NotFound":
        if evidence_count >= 2 and score >= 50:
            match_status = "Review"

    has_datetime_pair = bool((service_date and service_time) or (visitation_date and visitation_time) or (ceremony_date and ceremony_time))
    if has_datetime_pair:
        if match_status in {"NotFound", "Review"}:
            match_status = "Found"
        score = max(score, 70.0)
    else:
        match_status = "NotFound"
        score = min(score, 49.0)

    notes_value = _safe_str(ai_data.get("notes") or ai_data.get("Summary") or ai_data.get("Status Justification"))
    if fallback_source in {"visitation", "ceremony"}:
        notes_value = f"{notes_value} | service datetime fallback={fallback_source}".strip(" |")

    return {
        "funeral_home_name": funeral_home_name,
        "funeral_address": funeral_address,
        "funeral_phone": funeral_phone,
        "service_type": service_type,
        "service_date": service_date,
        "service_time": service_time,
        "visitation_date": visitation_date,
        "visitation_time": visitation_time,
        "ceremony_date": ceremony_date,
        "ceremony_time": ceremony_time,
        "delivery_recommendation_date": delivery_recommendation_date,
        "delivery_recommendation_time": delivery_recommendation_time,
        "delivery_recommendation_location": delivery_recommendation_location,
        "special_instructions": special_instructions,
        "match_status": match_status,
        "ai_accuracy_score": score,
        "source_urls": source_urls,
        "notes": notes_value,
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
    run_date_key = _run_date_key()
    date_wise_csv_path = get_date_wise_csv_path(run_date_key)
    _, date_wise_log_path = ensure_log_files(run_date_key)

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
                {"role": "system", "content": "You are an assistant that finds funeral and memorial service details. Return your findings in valid JSON format with these keys: funeral_home_name, funeral_address, funeral_phone, service_type, funeral_date, funeral_time, visitation_date, visitation_time, ceremony_date, ceremony_time, delivery_recommendation_date, delivery_recommendation_time, delivery_recommendation_location, special_instructions, status (Found/NotFound/Review), AI Accuracy Score (0-100 confidence for status), source_urls (list), notes. Scoring guidance: 85-100 exact match with source URL and concrete service details; 70-84 strong match with URL and partial details; 50-69 partial/uncertain; 0-49 weak or no reliable match. No source URL means score must be <=50. For very common names without unique identifiers, keep score below 60. Set Found when at least one valid date+time pair exists in funeral/service, visitation, or ceremony fields. Set NotFound when no valid date+time pair exists in those fields. Do not use delivery recommendation fields as service datetime fallback."},
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

        # Parse AI response and enforce local business rules from review findings.
        parsed = parse_ai_response(ai_text)
        parsed = _apply_business_rules(order, parsed)

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

        # ── DATE-WISE SAVE: Append into today's partition file ─────────
        save_one_record_to_csv(date_wise_csv_path, record)
        print(f"  📁 Date-wise appended: {date_wise_csv_path.name}")

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
        append_date_wise_processed_log(order_id, status, run_date_key)
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
             REVIEW_CSV_PATH, REVIEW_EXCEL_PATH, PAYLOAD_PATH, LOGS_PATH,
             date_wise_csv_path, date_wise_log_path]:
        mark = "✓" if fp.exists() else "✗"
        print(f"  {mark}  {fp.name}")


if __name__ == "__main__":
    main()
