from __future__ import annotations

import csv
import difflib
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import requests

try:
    from openpyxl import Workbook
    from openpyxl.styles import PatternFill
except Exception:
    Workbook = None
    PatternFill = None

C_RESET = "\033[0m"
C_RED = "\033[31m"
C_GREEN = "\033[32m"
C_YELLOW = "\033[33m"
C_CYAN = "\033[36m"

REQUEST_TIMEOUT = 90
PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions"
DEFAULT_PROMPT_TEMPLATE_PATH = "prompts/funeral_search_template.md"
PREFERRED_DOMAINS = ["echovita.com", "dignitymemorial.com"]
DOMAIN_STATUS_EXTRA = ["hennesseyfh.com", "sunsetlawn.chapelofthechimes.com"]

REQUIRED_RESULT_FIELDS = [
    "first_name",
    "last_name",
    "city",
    "state",
    "zip",
    "funeral_home_name",
    "phone_number",
    "funeral_date",
    "funeral_time",
]

SERVICE_EVENT_FIELDS = [
    "prayer_service_date",
    "prayer_service_time",
    "visitation_date",
    "visitation_time",
    "celebration_of_life_date",
    "celebration_of_life_time",
]

EXTRA_RESULT_FIELDS = [
    "full_name",
    "obituary_url",
    "funeral_name",
    "venue_type",
    "service_location_name",
    "service_location_address",
    "cemetery_name",
    "verification_notes",
    "notes",
    "source_list",
    "status",
    "confidence_score",
    "_ai_accuracy_percent",
    "service_entries",
] + SERVICE_EVENT_FIELDS

MAIN_PASS_MIN_ACCURACY = 80
REVIEW_PROMOTE_MIN_ACCURACY = 75
LOW_DATA_MAX_ACCURACY = 50

BASE_OUTPUT_FIELDS = [
    "ord_id",
    "ship_name",
    "ship_care_of",
    "ship_address",
    "ship_address_unit",
    "ship_city",
    "ship_state",
    "ship_zip",
    "ship_country",
    "ship_phone_day",
    "ord_occasion",
    "ord_message",
    "ord_instruct",
]

UNWANTED_OUTPUT_COLUMNS = {
    "ord_status",
    "ord_form_type",
    "bill_name_last",
    "bill_name_first",
    "bill_phone_day",
    "bill_city",
    "bill_zip",
    "bill_country",
    "bill_email",
    "amt_subtotal",
    "amt_tax",
    "amt_sh",
    "amt_sh2",
    "amt_sh4",
    "amt_d1",
    "amt_discount",
    "amt_total",
    "tags",
    "ship_timezone",
    "local_time_now",
    "target_time",
    "itemlist",
    "ord_type",
    "earliestdatechange",
    "raw_json",
    "_row_number",
    "_raw",
}


def should_drop_output_key(key: str) -> bool:
    if key in UNWANTED_OUTPUT_COLUMNS:
        return True
    if str(key).startswith("ai_"):
        return True
    return False


def load_dotenv_file(path: str = ".env") -> None:
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def load_prompt_template() -> str:
    template_path = Path(os.getenv("FUNERAL_PROMPT_TEMPLATE", DEFAULT_PROMPT_TEMPLATE_PATH).strip())
    if not template_path.exists():
        raise SystemExit(f"Prompt template file not found: {template_path}")
    return template_path.read_text(encoding="utf-8")


def render_prompt_template(template_text: str, prompt_payload: Dict[str, Any]) -> str:
    details_json = json.dumps(prompt_payload, ensure_ascii=False, indent=2)
    if "[INSERT PROMPT/Details HERE]" in template_text:
        return template_text.replace("[INSERT PROMPT/Details HERE]", details_json)
    if "{{INPUT_DETAILS}}" in template_text:
        return template_text.replace("{{INPUT_DETAILS}}", details_json)
    return f"{template_text.strip()}\n\nInput Details:\n{details_json}"


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_header(value: Any) -> str:
    text = str(value or "").strip().lower()
    return "".join(ch if ch.isalnum() else "_" for ch in text).strip("_")


def header_aliases() -> Dict[str, str]:
    return {
        "ord_id": "ord_id",
        "ship_name": "ship_name",
        "ship_care_of": "ship_care_of",
        "ship_address": "ship_address",
        "ship_address_unit": "ship_address_unit",
        "ship_city": "ship_city",
        "ship_state": "ship_state",
        "ship_zip": "ship_zip",
        "ship_country": "ship_country",
        "ship_phone_day": "ship_phone_day",
        "ord_occasion": "ord_occasion",
        "ord_message": "ord_message",
        "ord_instruct": "ord_instruct",
    }


def read_input_rows_csv(csv_path: Path, max_rows: int = 0) -> List[Dict[str, str]]:
    aliases = header_aliases()
    rows: List[Dict[str, str]] = []
    with csv_path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for idx, row in enumerate(reader, start=2):
            item: Dict[str, str] = {}
            for raw_key, raw_value in row.items():
                key = aliases.get(normalize_header(raw_key), normalize_header(raw_key))
                value = "" if raw_value is None else str(raw_value).strip()
                if value:
                    item[key] = value
            item["_row_number"] = str(idx)
            item["_raw"] = json.dumps(row, ensure_ascii=False)
            rows.append(item)
            if max_rows > 0 and len(rows) >= max_rows:
                break
    return rows


def read_input_rows_json(json_path: Path, max_rows: int = 0) -> List[Dict[str, str]]:
    aliases = header_aliases()
    rows: List[Dict[str, str]] = []

    with json_path.open("r", encoding="utf-8") as f:
        payload = json.load(f)

    records = payload if isinstance(payload, list) else [payload]
    for idx, record in enumerate(records, start=2):
        if not isinstance(record, dict):
            continue

        item: Dict[str, str] = {}
        for raw_key, raw_value in record.items():
            key = aliases.get(normalize_header(raw_key), normalize_header(raw_key))
            value = "" if raw_value is None else str(raw_value).strip()
            if value:
                item[key] = value

        item["_row_number"] = str(idx)
        item["_raw"] = json.dumps(record, ensure_ascii=False)
        rows.append(item)

        if max_rows > 0 and len(rows) >= max_rows:
            break

    return rows


def read_input_rows(input_path: Path, max_rows: int = 0) -> List[Dict[str, str]]:
    suffix = input_path.suffix.lower()
    if suffix == ".csv":
        return read_input_rows_csv(input_path, max_rows=max_rows)
    if suffix == ".json":
        return read_input_rows_json(input_path, max_rows=max_rows)
    raise SystemExit("FUNERAL_INPUT_CSV must point to a .csv or .json file")


def _safe_int(value: Any) -> Optional[int]:
    try:
        if value in (None, ""):
            return None
        return int(str(value).strip())
    except Exception:
        return None


def split_first_last_name(full_name: str) -> Tuple[Optional[str], Optional[str]]:
    parts = [p for p in re.split(r"\s+", full_name.strip()) if p]
    if not parts:
        return None, None
    if len(parts) == 1:
        return parts[0], None
    return parts[0], parts[-1]


def _name_token(value: str) -> str:
    return re.sub(r"[^a-z]", "", str(value or "").lower())


def _first_name_close(expected: str, actual: str) -> bool:
    if not expected or not actual:
        return False
    if expected == actual:
        return True
    ratio = difflib.SequenceMatcher(None, expected, actual).ratio()
    return ratio >= 0.78


def apply_name_match_guard(result: Dict[str, Any], input_row: Dict[str, str], provider: str) -> Dict[str, Any]:
    expected_first, expected_last = split_first_last_name((input_row.get("ship_name") or "").strip())
    expected_first = _name_token(expected_first or "")
    expected_last = _name_token(expected_last or "")

    actual_first = _name_token(str(result.get("first_name") or ""))
    actual_last = _name_token(str(result.get("last_name") or ""))

    if (not actual_first or not actual_last) and result.get("full_name"):
        full_first, full_last = split_first_last_name(str(result.get("full_name") or ""))
        actual_first = actual_first or _name_token(full_first or "")
        actual_last = actual_last or _name_token(full_last or "")

    # If we cannot reliably compare names, keep the result but mark as unknown match-state.
    if not expected_first or not expected_last or not actual_first or not actual_last:
        result["_name_match"] = None
        return result

    is_match = (expected_last == actual_last) and _first_name_close(expected_first, actual_first)
    result["_name_match"] = is_match

    if is_match:
        return result

    result["status"] = "mismatched"
    result["_ai_accuracy_percent"] = min(int(result.get("_ai_accuracy_percent") or 0), 35)
    try:
        score = float(result.get("confidence_score") or 0.0)
    except Exception:
        score = 0.0
    result["confidence_score"] = min(score, 0.35)
    prior_notes = str(result.get("verification_notes") or "").strip()
    mismatch_note = (
        f"{provider} name mismatch: expected '{input_row.get('ship_name')}', "
        f"got '{result.get('first_name')} {result.get('last_name')}'."
    )
    result["verification_notes"] = f"{prior_notes} | {mismatch_note}".strip(" |")
    return result


def row_to_worker_context(input_row: Dict[str, str]) -> Dict[str, Any]:
    ship_name = (input_row.get("ship_name") or "").strip()
    ship_care_of = (input_row.get("ship_care_of") or "").strip()
    ship_address = (input_row.get("ship_address") or "").strip()
    ship_address_unit = (input_row.get("ship_address_unit") or "").strip()
    ship_city = (input_row.get("ship_city") or "").strip()
    ship_state = (input_row.get("ship_state") or "").strip()
    ship_zip = (input_row.get("ship_zip") or "").strip()

    # Combined location info goes to AI context as requested.
    address_parts = [ship_address, ship_address_unit, ship_city, ship_state, ship_zip]
    combined_address = ", ".join([p for p in address_parts if p])

    message = (input_row.get("ord_message") or "").strip()
    instruct = (input_row.get("ord_instruct") or "").strip()
    occasion = (input_row.get("ord_occasion") or "").strip()

    notes_blob = "\n".join([
        f"ship_name: {ship_name}",
        f"ship_care_of: {ship_care_of}",
        f"combined_address: {combined_address}",
        f"ship_country: {input_row.get('ship_country', '')}",
        f"ship_phone_day: {input_row.get('ship_phone_day', '')}",
        f"ord_occasion: {occasion}",
        f"ord_message: {message}",
        f"ord_instruct: {instruct}",
    ]).strip()

    first_name, last_name = split_first_last_name(ship_name)

    return {
        "ord_id": _safe_int(input_row.get("ord_id")),
        "task_id": None,
        "task_subject": "Funeral Finder",
        "task_text": notes_blob,
        "card_message": message or notes_blob,
        "customer_notes": instruct or notes_blob,
        "order_occasion": occasion or None,
        "order_status": None,
        "delivery_date": None,
        "deceased_first_name": first_name,
        "deceased_last_name": last_name,
        "deceased_full_name": ship_name or None,
        "delivery_name": ship_name or None,
        "service_location_name": ship_care_of or None,
        "service_location_address": combined_address or None,
        "city": ship_city or None,
        "state": ship_state or None,
        "zip": ship_zip or None,
        "priority_sources": [
            "https://www.echovita.com/",
            "https://www.dignitymemorial.com/",
            "https://sunsetlawn.chapelofthechimes.com/",
            "https://www.hennesseyfh.com/",
        ],
        "is_funeral_like": True,
        "raw_order_fields": {
            "row_number": input_row.get("_row_number"),
            "raw": input_row.get("_raw"),
        },
    }


def _extract_json_object(text: str) -> Dict[str, Any]:
    content = (text or "").strip()
    if not content:
        return {}

    if content.startswith("```"):
        content = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", content)
        content = re.sub(r"\s*```$", "", content).strip()

    try:
        parsed = json.loads(content)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        pass

    match = re.search(r"\{[\s\S]*\}", content)
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _parse_labeled_response(text: str) -> Dict[str, Any]:
    content = (text or "").strip()
    if not content:
        return {}

    def _grab(label: str) -> str:
        m = re.search(rf"(?im)^\s*{re.escape(label)}\s*:\s*(.+)$", content)
        return (m.group(1).strip() if m else "")

    parsed: Dict[str, Any] = {
        "first_name": _grab("First Name"),
        "last_name": _grab("Last Name"),
        "city": _grab("City"),
        "state": _grab("State"),
        "zip": _grab("ZIP"),
        "funeral_home_name": _grab("Funeral home name (optional)"),
        "phone_number": _grab("Phone number"),
        "funeral_date": _grab("Funeral date"),
        "funeral_time": _grab("Funeral time"),
        "venue_type": _grab("Venue type"),
        "service_location_name": _grab("Service location"),
        "status": _grab("Status") or _grab("Verification status"),
        "notes": _grab("Notes"),
    }

    score_raw = _grab("AI Accuracy Score")
    score_match = re.search(r"(\d+(?:\.\d+)?)", score_raw)
    if score_match:
        parsed["_ai_accuracy_percent"] = score_match.group(1)
        parsed["confidence_score"] = str(float(score_match.group(1)) / 100.0)

    services_section = ""
    services_match = re.search(
        r"=====\s*Multiple Services\s*\(if available\)\s*=====(.*?)(?:=====\s*Source URLs\s*=====|$)",
        content,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if services_match:
        services_section = services_match.group(1).strip()

    service_entries: List[Dict[str, str]] = []
    if services_section:
        blocks = re.findall(
            r"(?ims)(?:^\s*\d+\.\s*)?([^\n:][^\n]*)\n\s*Date\s*:\s*([^\n]+)\n\s*Time\s*:\s*([^\n]+)",
            services_section,
        )
        for name, date, time in blocks:
            entry = {
                "service_type": name.strip(),
                "date": date.strip(),
                "time": time.strip(),
            }
            service_entries.append(entry)

            lower = name.strip().lower()
            if "prayer" in lower:
                parsed["prayer_service_date"] = entry["date"]
                parsed["prayer_service_time"] = entry["time"]
            elif "visitation" in lower:
                parsed["visitation_date"] = entry["date"]
                parsed["visitation_time"] = entry["time"]
            elif "celebration" in lower or "funeral service" in lower or "funeral" in lower:
                parsed["celebration_of_life_date"] = entry["date"]
                parsed["celebration_of_life_time"] = entry["time"]

    if service_entries:
        parsed["service_entries"] = service_entries

    notes_section_match = re.search(
        r"=====?\s*Notes\s*=====?\s*(.*?)(?:=====?\s*Source URLs\s*=====?|=====?\s*Domain Search Status\s*=====?|$)",
        content,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if notes_section_match:
        notes_text = notes_section_match.group(1).strip()
        if notes_text and not parsed.get("notes"):
            parsed["notes"] = notes_text

    if not parsed.get("notes"):
        trailing_note = re.search(r"(?im)^\s*Brief Note\s*:\s*(.+)$", content)
        if trailing_note:
            parsed["notes"] = trailing_note.group(1).strip()

    parsed["source_list"] = _urls_from_text(content)
    return parsed


def _extract_date_time_fallback(text: str) -> Tuple[Optional[str], Optional[str]]:
    content = (text or "").strip()
    if not content:
        return None, None

    date_match = re.search(
        r"\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b",
        content,
        flags=re.IGNORECASE,
    )
    time_match = re.search(
        r"\b\d{1,2}:?\d{0,2}\s*(?:am|pm|a\.m\.|p\.m\.)\s*(?:-|to)?\s*\d{0,2}:?\d{0,2}\s*(?:am|pm|a\.m\.|p\.m\.)?\b",
        content,
        flags=re.IGNORECASE,
    )

    return (
        date_match.group(0).strip() if date_match else None,
        time_match.group(0).strip() if time_match else None,
    )


def _normalize_confidence(confidence_raw: Any, fallback_ratio: float) -> Tuple[float, int]:
    """Return confidence ratio (0-1) and percent (0-100) from mixed model formats."""
    try:
        value = float(confidence_raw)
    except Exception:
        value = fallback_ratio

    if value <= 1.0:
        ratio = value
    elif value <= 100.0:
        ratio = value / 100.0
    else:
        ratio = 1.0

    ratio = max(0.0, min(1.0, ratio))
    percent = int(round(ratio * 100))
    percent = max(0, min(100, percent))
    return ratio, percent


def call_perplexity_worker_v2(api_key: str, input_row: Dict[str, str], model: str, template_text: str) -> Dict[str, Any]:
    context = row_to_worker_context(input_row)

    prompt_payload = {
        "ship_Name": input_row.get("ship_name"),
        "ship_Care_Of": input_row.get("ship_care_of"),
        "ship_Address": input_row.get("ship_address"),
        "ship_Address_Unit": input_row.get("ship_address_unit"),
        "ship_City": input_row.get("ship_city"),
        "ship_State": input_row.get("ship_state"),
        "ship_Zip": input_row.get("ship_zip"),
        "ship_Country": input_row.get("ship_country"),
        "ship_Phone_Day": input_row.get("ship_phone_day"),
        "ord_Occasion": input_row.get("ord_occasion"),
        "priority_sources": context.get("priority_sources", []),
    }

    rendered_template = render_prompt_template(template_text, prompt_payload)

    pplx_payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Find funeral/obituary details and return ONLY valid JSON with keys: "
                    "first_name,last_name,city,state,zip,funeral_home_name,phone_number,funeral_date,funeral_time,"
                    "full_name,obituary_url,funeral_name,venue_type,service_location_name,service_location_address,"
                    "cemetery_name,verification_notes,source_list,status,confidence_score,"
                    "prayer_service_date,prayer_service_time,visitation_date,visitation_time,"
                    "celebration_of_life_date,celebration_of_life_time,notes. "
                    "Status must be one of matched,mismatched,needs_review. "
                    "Before writing notes/status/accuracy, verify URLs and query parameters relevance to the same person."
                ),
            },
            {
                "role": "user",
                "content": rendered_template,
            },
        ],
        "temperature": 0.1,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    res = requests.post(PERPLEXITY_URL, headers=headers, json=pplx_payload, timeout=REQUEST_TIMEOUT)
    if res.status_code >= 400:
        raise RuntimeError(f"Perplexity request failed: HTTP {res.status_code}")

    raw_response = res.json()
    choice_text = (
        ((raw_response.get("choices") or [{}])[0].get("message") or {}).get("content")
        if isinstance(raw_response, dict)
        else ""
    )
    response_text = choice_text if isinstance(choice_text, str) else ""
    parsed = _extract_json_object(response_text)
    labeled = _parse_labeled_response(response_text)

    # Merge text-template fields as fallback when strict JSON is missing/incomplete.
    if labeled:
        for k, v in labeled.items():
            if k not in parsed or parsed.get(k) in (None, "", [], {}, "UNKNOWN", "NOT_AVAILABLE"):
                parsed[k] = v

    normalized = normalize_result_fields(parsed)

    source_urls = [u for u in (parsed.get("source_list") or []) if isinstance(u, str)] if isinstance(parsed, dict) else []
    citations = filter_source_urls(raw_response.get("citations") or []) if isinstance(raw_response, dict) else []
    source_urls = filter_source_urls(source_urls + citations)

    confidence_raw = parsed.get("confidence_score") if isinstance(parsed, dict) else None
    fallback_ratio = max(0.0, min(1.0, len(source_urls) / 5.0))
    confidence_score, confidence_percent = _normalize_confidence(confidence_raw, fallback_ratio)

    fallback_first, fallback_last = split_first_last_name((input_row.get("ship_name") or "").strip())
    fallback_date, fallback_time = _extract_date_time_fallback(
        "\n".join(
            [
                str(input_row.get("ord_instruct") or ""),
                str(input_row.get("ord_message") or ""),
            ]
        )
    )

    first_name = normalized.get("first_name")
    if first_name in {None, "", "UNKNOWN"} and fallback_first:
        first_name = fallback_first

    last_name = normalized.get("last_name")
    if last_name in {None, "", "UNKNOWN"} and fallback_last:
        last_name = fallback_last

    funeral_date = normalized.get("funeral_date")
    if funeral_date in {None, "", "UNKNOWN", "NOT_AVAILABLE"} and fallback_date:
        funeral_date = fallback_date

    funeral_time = normalized.get("funeral_time")
    if funeral_time in {None, "", "UNKNOWN", "NOT_AVAILABLE"} and fallback_time:
        funeral_time = fallback_time

    out: Dict[str, Any] = {
        "first_name": first_name or "UNKNOWN",
        "last_name": last_name or "UNKNOWN",
        "city": normalized.get("city") or input_row.get("ship_city") or "UNKNOWN",
        "state": normalized.get("state") or input_row.get("ship_state") or "UNKNOWN",
        "zip": normalized.get("zip") or input_row.get("ship_zip") or "UNKNOWN",
        "funeral_home_name": normalized.get("funeral_home_name") or input_row.get("ship_care_of") or "NOT_AVAILABLE",
        "phone_number": normalized.get("phone_number") or input_row.get("ship_phone_day") or "UNKNOWN",
        "full_name": parsed.get("full_name") if isinstance(parsed, dict) else input_row.get("ship_name"),
        "obituary_url": parsed.get("obituary_url") if isinstance(parsed, dict) else None,
        "funeral_name": parsed.get("funeral_name") if isinstance(parsed, dict) else None,
        "funeral_date": funeral_date or "UNKNOWN",
        "funeral_time": funeral_time or "UNKNOWN",
        "venue_type": parsed.get("venue_type") if isinstance(parsed, dict) else None,
        "service_location_name": parsed.get("service_location_name") if isinstance(parsed, dict) else None,
        "service_location_address": parsed.get("service_location_address") if isinstance(parsed, dict) else None,
        "cemetery_name": parsed.get("cemetery_name") if isinstance(parsed, dict) else None,
        "verification_notes": parsed.get("verification_notes") if isinstance(parsed, dict) else None,
        "notes": parsed.get("notes") if isinstance(parsed, dict) else None,
        "source_list": source_urls,
        "status": (parsed.get("status") if isinstance(parsed, dict) else None) or "needs_review",
        "confidence_score": confidence_score,
        "service_entries": parsed.get("service_entries") if isinstance(parsed, dict) else [],
    }
    for field in SERVICE_EVENT_FIELDS:
        value = parsed.get(field) if isinstance(parsed, dict) else None
        out[field] = (str(value).strip() if value is not None else "") or "NOT_AVAILABLE"
    out["_ai_accuracy_percent"] = confidence_percent
    out["_meta"] = {
        "provider": "perplexity-direct",
        "citations": citations,
        "search_result_urls": filter_source_urls(
            [
                item.get("url")
                for item in (raw_response.get("search_results") or [])
                if isinstance(item, dict) and isinstance(item.get("url"), str)
            ]
        ),
    }
    return apply_name_match_guard(out, input_row, provider="Perplexity")


def build_output_schema() -> Dict[str, Any]:
    properties = {
        "first_name": {"type": ["string", "null"]},
        "last_name": {"type": ["string", "null"]},
        "city": {"type": ["string", "null"]},
        "state": {"type": ["string", "null"]},
        "zip": {"type": ["string", "null"]},
        "funeral_home_name": {"type": ["string", "null"]},
        "phone_number": {"type": ["string", "null"]},
        "funeral_date": {"type": ["string", "null"]},
        "funeral_time": {"type": ["string", "null"]},
        "prayer_service_date": {"type": ["string", "null"]},
        "prayer_service_time": {"type": ["string", "null"]},
        "visitation_date": {"type": ["string", "null"]},
        "visitation_time": {"type": ["string", "null"]},
        "celebration_of_life_date": {"type": ["string", "null"]},
        "celebration_of_life_time": {"type": ["string", "null"]},
        "source_urls": {"type": ["array", "null"], "items": {"type": "string"}},
    }

    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": list(properties.keys()),
    }


def normalize_result_fields(parsed: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for field in REQUIRED_RESULT_FIELDS:
        val = parsed.get(field)
        text = "" if val is None else str(val).strip()
        if field == "funeral_home_name":
            out[field] = text or "NOT_AVAILABLE"
        else:
            out[field] = text or "UNKNOWN"
    return out


def _urls_from_text(text: str) -> List[str]:
    if not text:
        return []
    pattern = r"https?://[^\s)\]>\"']+"
    return re.findall(pattern, text)


def validate_result(result: Dict[str, Any]) -> Dict[str, Any]:
    missing = []
    for field in ["full_name", "funeral_date", "funeral_time", "funeral_home_name"]:
        value = str(result.get(field) or "").strip()
        if not value or value.upper() in {"UNKNOWN", "NOT_AVAILABLE", "NONE"}:
            missing.append(field)
    if result.get("_name_match") is False:
        missing.append("name_match")
    return {"is_valid": len(missing) == 0, "missing_fields": missing}


def checkpoint_key(row: Dict[str, str]) -> str:
    ord_id = str(row.get("ord_id") or "").strip()
    if ord_id:
        return f"ord:{ord_id}"
    digest = hashlib.sha256((row.get("_raw") or json.dumps(row, sort_keys=True)).encode("utf-8")).hexdigest()
    return f"hash:{digest}"


def load_checkpoint(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {"processed": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("processed"), dict):
            return data
    except Exception:
        pass
    return {"processed": {}}


def save_checkpoint(path: Path, state: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def append_log(path: Path, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def append_csv(path: Path, rows: List[Dict[str, Any]]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    incoming_fieldnames: List[str] = []
    for row in rows:
        for k in row.keys():
            if k not in incoming_fieldnames:
                incoming_fieldnames.append(k)

    if not path.exists():
        with path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=incoming_fieldnames, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
        return

    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        existing_rows = list(reader)
        existing_fieldnames = list(reader.fieldnames or [])

    final_fieldnames = list(existing_fieldnames)
    for name in incoming_fieldnames:
        if name not in final_fieldnames:
            final_fieldnames.append(name)

    # Re-write only when schema changes, otherwise append directly.
    if final_fieldnames != existing_fieldnames:
        with path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=final_fieldnames, extrasaction="ignore")
            writer.writeheader()
            if existing_rows:
                writer.writerows(existing_rows)
            writer.writerows(rows)
        return

    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=final_fieldnames, extrasaction="ignore")
        writer.writerows(rows)


def append_jsonl(path: Path, rows: List[Dict[str, Any]]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _ord_id_value(row: Dict[str, Any]) -> str:
    return str(row.get("ord_id") or "").strip()


def upsert_csv_by_ord_id(path: Path, row: Dict[str, Any]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    incoming = dict(row)
    target_ord_id = _ord_id_value(incoming)

    if not path.exists():
        fieldnames = list(incoming.keys())
        with path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            writer.writerow(incoming)
        return "inserted"

    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        existing_rows = list(reader)
        existing_fieldnames = list(reader.fieldnames or [])

    final_fieldnames = list(existing_fieldnames)
    for key in incoming.keys():
        if key not in final_fieldnames:
            final_fieldnames.append(key)

    action = "inserted"
    updated = False
    if target_ord_id:
        for idx, item in enumerate(existing_rows):
            if _ord_id_value(item) == target_ord_id:
                existing_rows[idx] = {**item, **incoming}
                action = "updated"
                updated = True
                break

    if not updated:
        existing_rows.append(incoming)

    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=final_fieldnames, extrasaction="ignore")
        writer.writeheader()
        if existing_rows:
            writer.writerows(existing_rows)
    return action


def upsert_jsonl_by_ord_id(path: Path, row: Dict[str, Any]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    target_ord_id = _ord_id_value(row)

    records: List[Dict[str, Any]] = []
    if path.exists():
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except Exception:
                    continue
                if isinstance(item, dict):
                    records.append(item)

    action = "inserted"
    updated = False
    if target_ord_id:
        for idx, item in enumerate(records):
            if _ord_id_value(item) == target_ord_id:
                records[idx] = {**item, **row}
                action = "updated"
                updated = True
                break

    if not updated:
        records.append(dict(row))

    with path.open("w", encoding="utf-8") as f:
        for item in records:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
    return action


def remove_ord_id_from_csv(path: Path, ord_id: str) -> bool:
    if not ord_id or not path.exists():
        return False
    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fieldnames = list(reader.fieldnames or [])
    filtered = [r for r in rows if _ord_id_value(r) != ord_id]
    if len(filtered) == len(rows):
        return False
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        if filtered:
            writer.writerows(filtered)
    return True


def remove_ord_id_from_jsonl(path: Path, ord_id: str) -> bool:
    if not ord_id or not path.exists():
        return False
    records: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except Exception:
                continue
            if isinstance(item, dict):
                records.append(item)
    filtered = [r for r in records if _ord_id_value(r) != ord_id]
    if len(filtered) == len(records):
        return False
    with path.open("w", encoding="utf-8") as f:
        for item in filtered:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
    return True


def should_store_in_main(validation: Dict[str, Any], pplx_result: Dict[str, Any]) -> bool:
    try:
        accuracy = int(float(pplx_result.get("_ai_accuracy_percent") or 0))
    except Exception:
        accuracy = 0
    if accuracy < MAIN_PASS_MIN_ACCURACY:
        return False
    if pplx_result.get("_name_match") is False:
        return False
    return True


def normalize_match_status(raw_status: Any, pplx_result: Dict[str, Any], validation: Dict[str, Any]) -> str:
    text = str(raw_status or "").strip().lower().replace("-", "_").replace(" ", "_")
    mapping = {
        "matched": "matched",
        "match": "matched",
        "confirmed": "matched",
        "mismatched": "mismatched",
        "mismatch": "mismatched",
        "not_found": "needs_review",
        "needs_review": "needs_review",
    }
    status = mapping.get(text, "needs_review")

    if pplx_result.get("_name_match") is False:
        return "mismatched"
    if not validation.get("is_valid") and status == "matched":
        return "needs_review"
    return status


def classify_route(merged_row: Dict[str, Any], pplx_result: Dict[str, Any], validation: Dict[str, Any]) -> str:
    status = normalize_match_status(pplx_result.get("status"), pplx_result, validation)
    pplx_result["status"] = status
    merged_row["pplx_status"] = status

    try:
        accuracy = int(float(pplx_result.get("_ai_accuracy_percent") or 0))
    except Exception:
        accuracy = 0

    low_data_fields = [
        "pplx_funeral_home_name",
        "pplx_funeral_date",
        "pplx_funeral_time",
        "pplx_city",
        "pplx_state",
        "pplx_zip",
        "pplx_phone_number",
    ]
    missing_low_data = 0
    for field in low_data_fields:
        value = str(merged_row.get(field) or "").strip().upper()
        if not value or value in {"UNKNOWN", "NOT_AVAILABLE", "NONE", "NULL"}:
            missing_low_data += 1

    pplx_url_count = int(merged_row.get("pplx_source_url_count") or 0)
    is_low_data = (missing_low_data >= 5) or (pplx_url_count == 0 and accuracy <= LOW_DATA_MAX_ACCURACY)

    # Route logic: prioritize high accuracy even if some fields missing.
    # >80 should go to main. >=75 with confidence + usable source evidence can be promoted.
    promotable_review = (
        status in {"needs_review", "matched"}
        and accuracy >= REVIEW_PROMOTE_MIN_ACCURACY
        and pplx_url_count > 0
        and missing_low_data <= 3
        and pplx_result.get("_name_match") is not False
    )

    if status in {"matched", "needs_review"} and accuracy >= MAIN_PASS_MIN_ACCURACY:
        if is_low_data and accuracy < 95:  # Only route to low_data if accuracy < 95%
            return "low_data"
        merged_row["pplx_status"] = "matched"
        pplx_result["status"] = "matched"
        return "main"

    if promotable_review:
        merged_row["pplx_status"] = "matched"
        pplx_result["status"] = "matched"
        return "main"
    
    if is_low_data:
        return "low_data"
    
    return "needs_review"


def drop_unwanted_keys(record: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in record.items() if not should_drop_output_key(k)}


def sanitize_existing_csv(path: Path) -> None:
    if not path.exists():
        return
    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = [drop_unwanted_keys(r) for r in reader]
        fieldnames = [n for n in (reader.fieldnames or []) if not should_drop_output_key(n)]

    if not fieldnames:
        return

    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        if rows:
            writer.writerows(rows)


def sanitize_existing_jsonl(path: Path) -> None:
    if not path.exists():
        return
    cleaned_rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except Exception:
                continue
            if isinstance(item, dict):
                cleaned_rows.append(drop_unwanted_keys(item))

    with path.open("w", encoding="utf-8") as f:
        for item in cleaned_rows:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")


def dedupe_csv_by_ord_id(path: Path) -> None:
    if not path.exists():
        return
    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fieldnames = list(reader.fieldnames or [])
    if not rows or not fieldnames:
        return

    indexed: Dict[str, Dict[str, Any]] = {}
    ordered_no_id: List[Dict[str, Any]] = []
    for row in rows:
        oid = _ord_id_value(row)
        if oid:
            indexed[oid] = row
        else:
            ordered_no_id.append(row)

    final_rows = list(indexed.values()) + ordered_no_id
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(final_rows)


def dedupe_jsonl_by_ord_id(path: Path) -> None:
    if not path.exists():
        return
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except Exception:
                continue
            if isinstance(item, dict):
                rows.append(item)
    if not rows:
        return

    indexed: Dict[str, Dict[str, Any]] = {}
    ordered_no_id: List[Dict[str, Any]] = []
    for row in rows:
        oid = _ord_id_value(row)
        if oid:
            indexed[oid] = row
        else:
            ordered_no_id.append(row)
    final_rows = list(indexed.values()) + ordered_no_id

    with path.open("w", encoding="utf-8") as f:
        for item in final_rows:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")


def _record_accuracy_percent(record: Dict[str, Any]) -> int:
    for key in ("pplx_ai_accuracy_percent", "_ai_accuracy_percent"):
        try:
            value = int(float(record.get(key) or 0))
            return max(0, min(100, value))
        except Exception:
            continue
    return 0


def _record_source_count(record: Dict[str, Any]) -> int:
    try:
        return int(float(record.get("pplx_source_url_count") or 0))
    except Exception:
        return 0


def _should_promote_review_record(record: Dict[str, Any]) -> bool:
    status = str(record.get("pplx_status") or "").strip().lower().replace("-", "_")
    if status == "mismatched":
        return False

    accuracy = _record_accuracy_percent(record)
    if accuracy >= MAIN_PASS_MIN_ACCURACY:
        return True

    if accuracy >= REVIEW_PROMOTE_MIN_ACCURACY and _record_source_count(record) > 0:
        return True

    return False


def promote_review_to_main(
    review_csv: Path,
    review_jsonl: Path,
    output_csv: Path,
    output_jsonl: Path,
    log_path: Path,
) -> int:
    if not review_csv.exists():
        return 0

    with review_csv.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fieldnames = list(reader.fieldnames or [])

    if not rows or not fieldnames:
        return 0

    promoted = 0
    keep_rows: List[Dict[str, Any]] = []
    promoted_ids: set[str] = set()

    for row in rows:
        if _should_promote_review_record(row):
            row["pplx_status"] = "matched"
            upsert_csv_by_ord_id(output_csv, row)
            upsert_jsonl_by_ord_id(output_jsonl, row)
            ord_id = _ord_id_value(row)
            if ord_id:
                promoted_ids.add(ord_id)
            promoted += 1
        else:
            keep_rows.append(row)

    with review_csv.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        if keep_rows:
            writer.writerows(keep_rows)

    if promoted_ids and review_jsonl.exists():
        remove_count = 0
        for ord_id in promoted_ids:
            if remove_ord_id_from_jsonl(review_jsonl, ord_id):
                remove_count += 1
        if remove_count:
            append_log(log_path, f"{_now_utc()} | INFO | promoted_review_records={remove_count} to main")

    if promoted:
        append_log(log_path, f"{_now_utc()} | INFO | promoted_review_records={promoted} to main")

    return promoted


def print_rows_indexed(rows: List[Dict[str, str]]) -> None:
    print("\nAvailable Excel rows (number-wise):")
    for i, row in enumerate(rows, start=1):
        full_name = row.get("ship_name") or "Unknown"
        first, last = split_first_last_name(full_name)
        first = first or ""
        last = last or ""
        city = row.get("ship_city", "")
        state = row.get("ship_state", "")
        zip_code = row.get("ship_zip", "")
        ord_id = row.get("ord_id", "")
        print(
            f"{i}. {first} {last}".strip()
            + f" | Excel row {row.get('_row_number', '?')} | Order {ord_id or '-'} | {city}, {state} {zip_code}".rstrip()
        )


def print_selected_data(row: Dict[str, str]) -> None:
    full_name = row.get("ship_name", "")
    first, last = split_first_last_name(full_name)
    print("\n----- Selected Excel Data -----")
    print(f"Excel row: {row.get('_row_number', '')}")
    print(f"Order ID: {row.get('ord_id', '')}")
    print(f"First Name: {first or ''}")
    print(f"Last Name: {last or ''}")
    print(f"City: {row.get('ship_city', '')}")
    print(f"State: {row.get('ship_state', '')}")
    print(f"ZIP: {row.get('ship_zip', '')}")
    print(f"Funeral home name (optional): {row.get('ship_care_of', '') or row.get('ship_address', '')}")
    print(f"Phone number: {row.get('ship_phone_day', '')}")
    notes = row.get("ord_instruct") or row.get("ord_message") or ""
    if notes:
        print(f"Notes: {notes}")
    print("--------------------------------")


def choose_mode() -> str:
    print(f"\n{C_CYAN}* Choose Search Mode{C_RESET}")
    print("* [1] Search by selecting line number")
    print("* [2] Search one by one (press Enter for next)")
    print("* [3] Complete automatic search")
    while True:
        mode = input("Enter option (1/2/3): ").strip()
        if mode in {"1", "2", "3"}:
            return mode
        print(f"{C_RED}* Invalid option. Choose 1, 2, or 3.{C_RESET}")


def resolve_mode() -> str:
    run_mode = os.getenv("RUN_MODE", "").strip().lower()
    if run_mode == "batch":
        print(f"{C_CYAN}* RUN_MODE=batch detected → automatic search{C_RESET}")
        return "3"
    if run_mode == "interactive":
        return choose_mode()
    if not os.isatty(0):
        print(f"{C_CYAN}* Non-interactive session detected → automatic search{C_RESET}")
        return "3"
    return choose_mode()


def selected_indices_for_mode(rows: List[Dict[str, str]], mode: str) -> List[int]:
    if mode == "3":
        return list(range(len(rows)))
    if mode == "1":
        print_rows_indexed(rows)
        while True:
            raw = input("Enter row number to search: ").strip()
            try:
                idx = int(raw)
                if 1 <= idx <= len(rows):
                    return [idx - 1]
            except ValueError:
                pass
            print(f"{C_RED}* Invalid row number.{C_RESET}")
    return list(range(len(rows)))


def dedupe_rows_by_ord_id(rows: List[Dict[str, str]]) -> tuple[List[Dict[str, str]], int]:
    seen = set()
    unique_rows: List[Dict[str, str]] = []
    duplicates = 0

    for row in rows:
        ord_id = str(row.get("ord_id") or "").strip()
        key = f"ord:{ord_id}" if ord_id else checkpoint_key(row)
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        unique_rows.append(row)

    return unique_rows, duplicates


def filter_source_urls(urls: List[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for url in urls:
        if not isinstance(url, str):
            continue
        value = url.strip()
        if not value.lower().startswith(("http://", "https://")):
            continue
        if value not in seen:
            seen.add(value)
            out.append(value)

    preferred: List[str] = []
    others: List[str] = []
    for url in out:
        domain = _extract_domain(url) or ""
        if any(domain == d or domain.endswith(f".{d}") for d in PREFERRED_DOMAINS):
            preferred.append(url)
        else:
            others.append(url)
    return preferred + others


def estimate_accuracy_percent(result: Dict[str, Any], meta: Dict[str, Any]) -> int:
    total_fields = 6
    filled_fields = 0
    for field in ["first_name", "last_name", "city", "state", "zip", "phone_number"]:
        value = str(result.get(field, "")).strip().upper()
        if value and value != "UNKNOWN":
            filled_fields += 1
    completeness_score = (filled_fields / total_fields) * 80.0
    source_count = len((meta.get("citations") or []) + (meta.get("search_result_urls") or []))
    source_score = min(20.0, source_count * 10.0)
    return int(round(completeness_score + source_score))


def collect_source_urls(result: Dict[str, Any]) -> List[str]:
    meta = result.get("_meta") or {}
    citations = meta.get("citations") or []
    search_urls = meta.get("search_result_urls") or []
    parsed_sources = result.get("source_list") or []

    if isinstance(parsed_sources, str):
        parsed_sources = _urls_from_text(parsed_sources)
    if not isinstance(parsed_sources, list):
        parsed_sources = []

    seen = set()
    out: List[str] = []
    for url in citations + search_urls + parsed_sources:
        if isinstance(url, str) and url.strip() and url not in seen:
            seen.add(url)
            out.append(url)
    return out


def _extract_domain(url: str) -> Optional[str]:
    try:
        host = (urlparse(url).netloc or "").strip().lower()
        if host.startswith("www."):
            host = host[4:]
        return host or None
    except Exception:
        return None


def _domain_present(target: str, domain_values: set[str]) -> bool:
    for value in domain_values:
        if value == target or value.endswith(f".{target}"):
            return True
    return False


def print_domain_status_at_end(pplx_result: Dict[str, Any], max_domains: int = 2) -> None:
    pplx_domains = [_extract_domain(u) for u in collect_source_urls(pplx_result)]
    ordered: List[str] = []
    seen = set()
    for domain in pplx_domains:
        if domain and domain not in seen:
            seen.add(domain)
            ordered.append(domain)

    selected = ordered[:max_domains]
    for domain in DOMAIN_STATUS_EXTRA:
        if domain not in selected:
            selected.append(domain)

    print("\n===== Domain Search Status (Top 2 + Priority) =====")
    if not selected:
        print("NOT_AVAILABLE")
        return

    pplx_set = set([d for d in pplx_domains if d])
    for domain in selected:
        pplx_found = _domain_present(domain, pplx_set)
        print(f"Domain: {domain}")
        print(f"Perplexity -> searched: {'YES' if pplx_found else 'NO'} | data found: {'YES' if pplx_found else 'NO'}")


def print_sources_at_end(pplx_result: Dict[str, Any]) -> None:
    pplx_urls = collect_source_urls(pplx_result)

    print("\n===== Source URLs (Verify Manually) =====")
    print("Perplexity Sources:")
    if pplx_urls:
        for url in pplx_urls:
            print(f"- {url}")
    else:
        print("- NOT_AVAILABLE")

    print_domain_status_at_end(pplx_result, max_domains=2)


def export_highlighted_excel_from_csv(csv_path: Path, xlsx_path: Path, highlight_column: Optional[str] = None) -> bool:
    if Workbook is None or PatternFill is None:
        return False
    if not csv_path.exists():
        return False

    with csv_path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        if not fieldnames:
            return False
        rows = list(reader)

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "results"

    for col_idx, name in enumerate(fieldnames, start=1):
        sheet.cell(row=1, column=col_idx, value=name)

    green_fill = PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid")
    highlight_index = fieldnames.index(highlight_column) + 1 if highlight_column and highlight_column in fieldnames else None

    for row_idx, row in enumerate(rows, start=2):
        for col_idx, name in enumerate(fieldnames, start=1):
            value = row.get(name, "")
            sheet.cell(row=row_idx, column=col_idx, value=value)

        if highlight_index and highlight_column:
            value = str(row.get(highlight_column) or "").strip()
            if value and value.upper() not in {"NOT_AVAILABLE", "NONE", "[]"}:
                sheet.cell(row=row_idx, column=highlight_index).fill = green_fill

    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions

    xlsx_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        workbook.save(xlsx_path)
        return True
    except PermissionError:
        return False
    except OSError:
        return False


def print_result(title: str, input_row: Dict[str, str], result: Dict[str, Any]) -> None:
    row_no = input_row.get("_row_number", "?")
    print(f"\n===== {title} (Excel row {row_no}) =====")
    print(f"First Name: {result.get('first_name') or ''}")
    print(f"Last Name: {result.get('last_name') or ''}")
    print(f"City: {result.get('city') or ''}")
    print(f"State: {result.get('state') or ''}")
    print(f"ZIP: {result.get('zip') or ''}")
    print(f"Funeral home name (optional): {result.get('funeral_home_name') or ''}")
    print(f"Phone number: {result.get('phone_number') or ''}")
    print(f"Funeral date: {result.get('funeral_date') or 'NOT_AVAILABLE'}")
    print(f"Funeral time: {result.get('funeral_time') or 'NOT_AVAILABLE'}")

    prayer_date = str(result.get("prayer_service_date") or "").strip()
    prayer_time = str(result.get("prayer_service_time") or "").strip()
    visitation_date = str(result.get("visitation_date") or "").strip()
    visitation_time = str(result.get("visitation_time") or "").strip()
    celebration_date = str(result.get("celebration_of_life_date") or "").strip()
    celebration_time = str(result.get("celebration_of_life_time") or "").strip()

    def _available(value: str) -> bool:
        return bool(value) and value.upper() not in {"UNKNOWN", "NOT_AVAILABLE", "NONE"}

    service_entries = result.get("service_entries") if isinstance(result.get("service_entries"), list) else []

    if service_entries:
        print("===== Multiple Services (if available) =====")
        for item in service_entries:
            if not isinstance(item, dict):
                continue
            print(f"\n{item.get('service_type', 'Service')}")
            print(f"Date: {item.get('date', 'NOT_AVAILABLE')}")
            print(f"Time: {item.get('time', 'NOT_AVAILABLE')}")
    elif any(
        [
            _available(prayer_date),
            _available(prayer_time),
            _available(visitation_date),
            _available(visitation_time),
            _available(celebration_date),
            _available(celebration_time),
        ]
    ):
        print("Funeral finding details:")
        print("1. Prayer Service")
        print(f"Date: {prayer_date if _available(prayer_date) else 'NOT_AVAILABLE'}")
        print(f"Time: {prayer_time if _available(prayer_time) else 'NOT_AVAILABLE'}")
        print("2. Visitation")
        print(f"Date: {visitation_date if _available(visitation_date) else 'NOT_AVAILABLE'}")
        print(f"Time: {visitation_time if _available(visitation_time) else 'NOT_AVAILABLE'}")
        print("3. Celebration of Life (Main Funeral Service)")
        print(f"Date: {celebration_date if _available(celebration_date) else 'NOT_AVAILABLE'}")
        print(f"Time: {celebration_time if _available(celebration_time) else 'NOT_AVAILABLE'}")
    if result.get("venue_type"):
        print(f"Venue type: {result.get('venue_type')}")
    location_name = str(result.get("service_location_name") or "").strip()
    location_address = str(result.get("service_location_address") or "").strip()
    if location_name and location_address:
        print(f"Service location: {location_name}, {location_address}")
    elif location_name:
        print(f"Service location: {location_name}")
    elif location_address:
        print(f"Service location: {location_address}")
    if result.get("status"):
        print(f"Verification status: {result.get('status')}")
    notes_text = str(result.get("notes") or "").strip()
    if notes_text:
        print(f"Notes: {notes_text}")
    try:
        score_percent = int(float(result.get("_ai_accuracy_percent") or result.get("confidence_score") or 0))
    except Exception:
        score_percent = 0
    score_percent = max(0, min(100, score_percent))
    print(f"AI Accuracy Score: {score_percent}%")


def process_rows(
    rows: List[Dict[str, str]],
    mode: str,
    api_key: str,
    pplx_model: str,
    output_csv: Path,
    output_jsonl: Path,
    output_xlsx: Path,
    review_csv: Path,
    review_jsonl: Path,
    review_xlsx: Path,
    low_data_csv: Path,
    low_data_jsonl: Path,
    low_data_xlsx: Path,
    checkpoint_path: Path,
    log_path: Path,
    template_text: str,
) -> None:
    checkpoint = load_checkpoint(checkpoint_path)
    processed_map = checkpoint.setdefault("processed", {})

    indices = selected_indices_for_mode(rows, mode)

    processed = 0
    skipped = 0
    failed = 0

    for index in indices:
        row = rows[index]
        key = checkpoint_key(row)
        ord_id = row.get("ord_id") or "-"
        line_no = row.get("_row_number") or str(index + 1)

        # In step-by-step and automatic modes, show source row details for visibility
        # even when the row is skipped by checkpoint dedupe.
        if mode in {"2", "3"}:
            print_selected_data(row)

        if key in processed_map:
            force_reprocess = False
            if mode in {"1", "2"}:
                answer = input("* Row already processed in checkpoint. Force reprocess? (y/N): ").strip().lower()
                force_reprocess = answer in {"y", "yes"}

            if not force_reprocess:
                skipped += 1
                print(f"{C_YELLOW}* [SKIP] line={line_no} ord_ID={ord_id} duplicate checkpoint{C_RESET}")
                print(f"{C_YELLOW}* [INFO] Output not shown for this line because it was not reprocessed.{C_RESET}")
                append_log(log_path, f"{_now_utc()} | SKIP | line={line_no} | ord_ID={ord_id} | reason=duplicate_checkpoint")
                if mode == "2":
                    nxt = input("Press Enter for next, q to stop: ").strip().lower()
                    if nxt == "q":
                        break
                continue

        print(f"{C_CYAN}* [SEARCH] line={line_no} ord_ID={ord_id}{C_RESET}")
        if mode == "1":
            print_selected_data(row)

        try:
            pplx_result = call_perplexity_worker_v2(api_key=api_key, input_row=row, model=pplx_model, template_text=template_text)
            validation = validate_result(pplx_result)

            pplx_urls_all = collect_source_urls(pplx_result)

            merged = {k: row.get(k) for k in BASE_OUTPUT_FIELDS}
            for field in REQUIRED_RESULT_FIELDS + EXTRA_RESULT_FIELDS:
                merged[f"pplx_{field}"] = pplx_result.get(field)
            merged["pplx_source_urls"] = " | ".join(pplx_urls_all) if pplx_urls_all else ""
            merged["pplx_source_url_count"] = len(pplx_urls_all)
            merged["ai_validation_ok"] = validation["is_valid"]
            merged["ai_missing_fields"] = ",".join(validation["missing_fields"]) if validation["missing_fields"] else ""
            merged["processed_at_utc"] = _now_utc()
            merged["pplx_ai_accuracy_percent"] = int(float(pplx_result.get("_ai_accuracy_percent") or 0))
            status_value = pplx_result.get("status") or "needs_review"
            merged["pplx_status"] = status_value
            merged["perplexity_status"] = status_value
            merged = drop_unwanted_keys(merged)

            route = classify_route(merged, pplx_result, validation)
            ord_id_value = str(ord_id).strip()

            # Single consolidated output: always write to main CSV/JSONL with status columns
            csv_action = upsert_csv_by_ord_id(output_csv, merged)
            jsonl_action = upsert_jsonl_by_ord_id(output_jsonl, merged)

            processed_map[key] = {
                "ord_id": ord_id,
                "line": line_no,
                "processed_at_utc": merged["processed_at_utc"],
            }
            save_checkpoint(checkpoint_path, checkpoint)

            processed += 1
            marker = "OK" if route == "main" else "WARN"
            color = C_GREEN if route == "main" else C_YELLOW
            try:
                accuracy_percent = int(float(pplx_result.get("_ai_accuracy_percent") or 0))
            except Exception:
                accuracy_percent = 0
            accuracy_percent = max(0, min(100, accuracy_percent))
            route_reason = f"[{pplx_result.get('status', 'unknown')} | {accuracy_percent}% accuracy]"
            print(f"{color}* [{marker}] line={line_no} ord_ID={ord_id} {route_reason} → {route.upper()}{C_RESET}")
            print(f"{color}* [DEBUG] missing={validation['missing_fields']}{C_RESET}")
            print_result("Perplexity Result", row, pplx_result)
            print_sources_at_end(pplx_result)
            append_log(
                log_path,
                (
                    f"{_now_utc()} | {marker} | line={line_no} | ord_ID={ord_id} | "
                    f"validation_ok={validation['is_valid']} | missing={validation['missing_fields']} | "
                    f"route={route} | csv_action={csv_action} | jsonl_action={jsonl_action}"
                ),
            )
        except Exception as exc:
            failed += 1
            print(f"{C_RED}* [ERR] line={line_no} ord_ID={ord_id} error={exc}{C_RESET}")
            append_log(log_path, f"{_now_utc()} | ERR | line={line_no} | ord_ID={ord_id} | error={exc}")

        if mode == "2":
            nxt = input("Press Enter for next, q to stop: ").strip().lower()
            if nxt == "q":
                break

    valid_highlighted = export_highlighted_excel_from_csv(output_csv, output_xlsx)

    print(f"\n{C_CYAN}* ===== Funeral Finder Summary ====={C_RESET}")
    print(f"{C_GREEN}* Processed: {processed}{C_RESET}")
    print(f"{C_YELLOW}* Skipped duplicates: {skipped}{C_RESET}")
    print(f"{C_RED}* Failed: {failed}{C_RESET}")
    print(f"{C_CYAN}* Output CSV: {output_csv}{C_RESET}")
    print(f"{C_CYAN}* Output JSONL: {output_jsonl}{C_RESET}")
    print(f"{C_CYAN}* Output XLSX: {output_xlsx if valid_highlighted else 'NOT_GENERATED'}{C_RESET}")
    print(f"{C_CYAN}* Checkpoint: {checkpoint_path}{C_RESET}")
    print(f"{C_CYAN}* Log: {log_path}{C_RESET}")


def main() -> int:
    load_dotenv_file()
    template_text = load_prompt_template()

    input_source = Path(os.getenv("FUNERAL_INPUT_CSV", os.getenv("GETTASK_CSV_PATH", "outputs/GetOrderInquiry/OrderInquiry.csv")).strip())
    output_csv = Path(os.getenv("FUNERAL_OUTPUT_CSV", os.getenv("LOOKUP_OUTPUT_CSV", "outputs/Funeral_Finder/Funeral_data.csv")).strip())
    output_jsonl = Path(os.getenv("FUNERAL_OUTPUT_JSONL", "outputs/Funeral_Finder/Funeral_data.jsonl").strip())
    output_xlsx = Path(os.getenv("FUNERAL_OUTPUT_XLSX", str(output_csv.with_suffix(".xlsx"))).strip())
    review_csv = Path(
        os.getenv(
            "FUNERAL_REVIEW_OUTPUT_CSV",
            os.getenv("FUNERAL_ERROR_OUTPUT_CSV", "outputs/Funeral_Finder/Funeral_data_needs_review.csv"),
        ).strip()
    )
    review_jsonl = Path(
        os.getenv(
            "FUNERAL_REVIEW_OUTPUT_JSONL",
            os.getenv("FUNERAL_ERROR_OUTPUT_JSONL", "outputs/Funeral_Finder/Funeral_data_needs_review.jsonl"),
        ).strip()
    )
    review_xlsx = Path(
        os.getenv(
            "FUNERAL_REVIEW_OUTPUT_XLSX",
            os.getenv("FUNERAL_ERROR_OUTPUT_XLSX", str(review_csv.with_suffix(".xlsx"))),
        ).strip()
    )
    low_data_csv = Path(os.getenv("FUNERAL_LOW_DATA_OUTPUT_CSV", "outputs/Funeral_Finder/Funeral_data_low_data.csv").strip())
    low_data_jsonl = Path(os.getenv("FUNERAL_LOW_DATA_OUTPUT_JSONL", "outputs/Funeral_Finder/Funeral_data_low_data.jsonl").strip())
    low_data_xlsx = Path(os.getenv("FUNERAL_LOW_DATA_OUTPUT_XLSX", str(low_data_csv.with_suffix(".xlsx"))).strip())
    checkpoint_path = Path(os.getenv("FUNERAL_CHECKPOINT", "outputs/Funeral_Finder/Funeral_checkpoint.json").strip())
    log_path = Path(os.getenv("FUNERAL_LOG_PATH", "outputs/Funeral_Finder/Funeral_Finder.log").strip())

    pplx_api_key = _required_env("PERPLEXITY_API_KEY")
    pplx_model = os.getenv("PPLX_MODEL", "sonar-pro").strip() or "sonar-pro"
    max_rows = int((os.getenv("FUNERAL_MAX_ROWS", "0") or "0").strip())

    if not input_source.exists():
        raise SystemExit(f"Input source not found: {input_source}")

    # Keep old outputs clean by removing known irrelevant columns before new appends.
    sanitize_existing_csv(output_csv)
    sanitize_existing_jsonl(output_jsonl)
    sanitize_existing_csv(review_csv)
    sanitize_existing_jsonl(review_jsonl)
    sanitize_existing_csv(low_data_csv)
    sanitize_existing_jsonl(low_data_jsonl)
    dedupe_csv_by_ord_id(output_csv)
    dedupe_jsonl_by_ord_id(output_jsonl)
    dedupe_csv_by_ord_id(review_csv)
    dedupe_jsonl_by_ord_id(review_jsonl)
    dedupe_csv_by_ord_id(low_data_csv)
    dedupe_jsonl_by_ord_id(low_data_jsonl)

    promoted_count = promote_review_to_main(
        review_csv=review_csv,
        review_jsonl=review_jsonl,
        output_csv=output_csv,
        output_jsonl=output_jsonl,
        log_path=log_path,
    )
    if promoted_count:
        print(f"{C_GREEN}* Promoted {promoted_count} eligible records from needs_review to main output{C_RESET}")

    rows = read_input_rows(input_source, max_rows=max_rows)
    if not rows:
        print(f"{C_YELLOW}* No usable rows found in {input_source}{C_RESET}")
        return 0

    rows, source_duplicate_rows = dedupe_rows_by_ord_id(rows)

    print(f"{C_CYAN}* Input rows loaded: {len(rows)} from {input_source}{C_RESET}")
    if source_duplicate_rows > 0:
        print(f"{C_YELLOW}* Source duplicate rows removed before search: {source_duplicate_rows}{C_RESET}")

    try:
        mode = resolve_mode()
        process_rows(
            rows=rows,
            mode=mode,
            api_key=pplx_api_key,
            pplx_model=pplx_model,
            output_csv=output_csv,
            output_jsonl=output_jsonl,
            output_xlsx=output_xlsx,
            review_csv=review_csv,
            review_jsonl=review_jsonl,
            review_xlsx=review_xlsx,
            low_data_csv=low_data_csv,
            low_data_jsonl=low_data_jsonl,
            low_data_xlsx=low_data_xlsx,
            checkpoint_path=checkpoint_path,
            log_path=log_path,
            template_text=template_text,
        )
    except (KeyboardInterrupt, EOFError):
        print(f"\n{C_YELLOW}* Safe exit: Interrupted by user{C_RESET}")
        append_log(log_path, f"{_now_utc()} | INTERRUPTED_BY_USER")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
