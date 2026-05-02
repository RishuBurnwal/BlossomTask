import json
import os
import sys
import io
import requests
import csv
import re
import argparse
from difflib import SequenceMatcher
from pathlib import Path
from datetime import datetime
from typing import Optional, Tuple
from urllib.parse import unquote, urlparse
from runtime_config import get_date_key, get_now_iso as runtime_now_iso, load_root_env

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

ACTIVE_MODEL = os.getenv("ACTIVE_MODEL", os.getenv("PERPLEXITY_MODEL", "sonar-pro"))
PERPLEXITY_MODEL = os.getenv("PERPLEXITY_MODEL", "sonar-pro")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-search-preview")

# ── Optional openpyxl for Excel output ──────────────────────────────────────
try:
    import openpyxl
    OPENPYXL_AVAILABLE = True
except ImportError:
    OPENPYXL_AVAILABLE = False

# ── Constants ────────────────────────────────────────────────────────────────
PERPLEXITY_URL  = "https://api.perplexity.ai/chat/completions"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"
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
FOUND_CSV_PATH        = OUTPUT_DIR / "Funeral_data_found.csv"
FOUND_EXCEL_PATH      = OUTPUT_DIR / "Funeral_data_found.xlsx"
CUSTOMER_CSV_PATH     = OUTPUT_DIR / "Funeral_data_customer.csv"
CUSTOMER_EXCEL_PATH   = OUTPUT_DIR / "Funeral_data_customer.xlsx"
NOT_FOUND_CSV_PATH    = OUTPUT_DIR / "Funeral_data_not_found.csv"
NOT_FOUND_EXCEL_PATH  = OUTPUT_DIR / "Funeral_data_not_found.xlsx"
REVIEW_CSV_PATH       = OUTPUT_DIR / "Funeral_data_review.csv"
REVIEW_EXCEL_PATH     = OUTPUT_DIR / "Funeral_data_review.xlsx"
PAYLOAD_PATH          = OUTPUT_DIR / "payload.json"
LOGS_PATH             = OUTPUT_DIR / "logs.txt"
RUN_GUARD_PATH        = OUTPUT_DIR / "run_state.json"
ERROR_REPORT_PATH     = OUTPUT_DIR / "runtime_error_report.json"
CONCURRENT_RUN_EXIT_CODE = 75


def _run_date_key() -> str:
    """Return YYYY-MM-DD for date-wise output partitioning."""
    return get_date_key()


def get_date_wise_csv_path(date_key: Optional[str] = None) -> Path:
    """Return date-partitioned CSV path for today's processed rows."""
    key = date_key or _run_date_key()
    return DATE_WISE_DIR / key / "Funeral_data.csv"


def get_date_wise_output_path(filename: str, date_key: Optional[str] = None) -> Path:
    """Return a file path inside the date-wise folder for the given date."""
    key = date_key or _run_date_key()
    return DATE_WISE_DIR / key / filename


def get_date_wise_log_path(date_key: Optional[str] = None) -> Path:
    """Return date-partitioned processed-id log path."""
    key = date_key or _run_date_key()
    return LOGS_BY_DATE_DIR / f"processed_{key}.txt"


def ensure_log_files(date_key: Optional[str] = None) -> Tuple[Path, Path]:
    """Create base log files so skip logic and audit files always exist."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    DATE_WISE_DIR.mkdir(parents=True, exist_ok=True)
    LOGS_BY_DATE_DIR.mkdir(parents=True, exist_ok=True)
    get_date_wise_output_path("Funeral_data.csv", date_key).parent.mkdir(parents=True, exist_ok=True)

    if not LOGS_PATH.exists():
        LOGS_PATH.write_text("", encoding="utf-8")

    daily_log_path = get_date_wise_log_path(date_key)
    if not daily_log_path.exists():
        daily_log_path.write_text("", encoding="utf-8")

    return LOGS_PATH, daily_log_path


def append_date_wise_processed_log(order_id: str, status: str, date_key: Optional[str] = None):
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
    "matched_name, funeral_home_name, funeral_address, funeral_phone, service_type, funeral_date, funeral_time, visitation_date, "
    "visitation_time, ceremony_date, ceremony_time, delivery_recommendation_date, delivery_recommendation_time, "
    "delivery_recommendation_location, special_instructions, status (Customer/Found/NotFound/Review), AI Accuracy Score (0-100 confidence for status), source_urls (list), notes. "
    "Scoring guidance: 85-100 exact match with source URL and concrete service details; 70-84 strong match with URL and partial details; "
    "50-69 partial/uncertain; 0-49 weak or no reliable match. No source URL means score should usually be <=65 unless identity evidence is strong. "
    "For very common names without unique identifiers, keep score below 60. "
    "Always return the exact obituary or memorial permalink you relied on when one exists; do not return only a funeral-home directory or homepage if a deeper obituary URL is available. "
    "Return matched_name exactly as found on the obituary, funeral page, or customer-provided schedule you relied on. "
    "Work like an OSINT detective: triangulate obituary pages, funeral-home pages, church/cemetery notices, customer instructions, dates, times, and venue details before deciding. "
    "If the evidence is incomplete, conflicting, or only partially supports the identity, prefer Review. "
    "Use any direct obituary detail URL already supplied by the user as authoritative evidence; do not reclassify it as weak directory evidence. "
    "Set Customer when the only trustworthy timing evidence comes from customer order instructions and outside sources do not confirm the service details. "
    "If outside sources do not confirm the schedule but ord_instruct contains a usable funeral, memorial, visitation, viewing, burial, or ceremony schedule, normalize that customer-provided schedule into structured JSON fields and set status=Customer. "
    "When using ord_instruct fallback, preserve the requested person as matched_name, format the best available schedule fields, and explain in notes that the schedule came from customer instructions. "
    "Set Found when matched_name aligns with the input person and at least one valid date OR time exists in funeral/service, visitation, or ceremony fields together with identity confirmation (name + funeral home OR name + obituary/detail source URL). "
    "If the obituary/detail URL is direct and ord_instruct also confirms the schedule, treat the record as Found even when the name varies slightly or the source page is cross-posted. "
    "Set Review, not NotFound, for date-only/time-only evidence with identity confirmation. "
    "Set Review when names or dates conflict between source evidence and customer instructions. "
    "Set NotFound only when timing evidence is absent and identity confirmation is weak or missing. "
    "Do not use delivery recommendation fields as service datetime fallback."
)


def _clean_ship_name_for_prompt(name: str) -> str:
    cleaned = _safe_str(name)
    patterns = [
        r"^(?:c/o|c-o)\s+",
        r"^(?:the family of)\s+",
        r"^(?:mr|mrs|ms|dr)\.?\s+",
    ]
    changed = True
    while changed and cleaned:
        changed = False
        for pattern in patterns:
            updated = re.sub(pattern, "", cleaned, flags=re.IGNORECASE).strip()
            if updated != cleaned:
                cleaned = updated
                changed = True
    return cleaned

# Canonical column order for CSV/Excel output
FIELDNAMES = [
    "order_id", "task_id", "ship_name", "ship_city", "ship_state", "ship_zip",
    "ship_care_of", "ship_address", "ship_address_unit", "ship_country",
    "ord_instruct",
    "matched_name",
    "funeral_home_name", "funeral_address", "funeral_phone",
    "service_type", "service_date", "service_time",
    "visitation_date", "visitation_time",
    "ceremony_date", "ceremony_time",
    "delivery_recommendation_date", "delivery_recommendation_time",
    "delivery_recommendation_location", "special_instructions",
    "name_match_status", "date_verification_status", "date_verification_notes",
    "match_status", "ai_accuracy_score",
    "source_urls", "notes",
    "last_processed_at",
]

CSV_READ_ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")


def normalize_match_status(value: str) -> str:
    normalized = _safe_str(value).strip().lower()
    if normalized in {"customer", "customer_defined", "customer-defined", "customer provided", "customer-provided", "instruction_only", "instruction-only"}:
        return "Customer"
    if normalized in {"found", "matched", "yes", "confirmed"}:
        return "Found"
    if normalized in {"review", "needs_review", "needs review", "uncertain", "unverified"}:
        return "Review"
    return "NotFound"


# ── Helpers ──────────────────────────────────────────────────────────────────

def load_dotenv_file(path=None):
    """Load environment variables from the root .env file."""
    load_root_env(Path(path) if path is not None else None)


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"[{SCRIPT_NAME}] Missing required env var: {name}")
    return value


def _active_model_name() -> str:
    return _safe_str(ACTIVE_MODEL or PERPLEXITY_MODEL or "sonar-pro") or "sonar-pro"


def _is_openai_model(model_name: str) -> bool:
    normalized = _safe_str(model_name).lower()
    return normalized.startswith("gpt-") or normalized.startswith("o")


def _provider_label(model_name: str) -> str:
    return "OpenAI" if _is_openai_model(model_name) else "Perplexity AI"


def get_now_iso() -> str:
    return runtime_now_iso()


def load_run_guard() -> dict:
    if not RUN_GUARD_PATH.exists():
        return {}
    try:
        return json.loads(RUN_GUARD_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, ValueError):
        return {}


def save_run_guard(payload: dict) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    RUN_GUARD_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _parse_iso_datetime(value: str) -> Optional[datetime]:
    text = _safe_str(value)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _is_process_active(pid_value) -> bool:
    try:
        pid = int(pid_value)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _extract_json_from_text(text: str) -> dict:
    """Robust JSON extractor that tolerates nested objects and wrapper prose."""
    if not text:
        return {}

    # Strategy 1: try decoding from every opening brace and keep the largest dict.
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
    end = text.rfind("}")
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
        "matched name": "matched_name",
        "matched_name": "matched_name",
        "matched deceased name": "matched_name",
        "deceased name": "matched_name",
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


def _load_error_report() -> dict:
    if not ERROR_REPORT_PATH.exists():
        return {}
    try:
        return json.loads(ERROR_REPORT_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, ValueError):
        return {}


def _write_error_report(payload: dict) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    ERROR_REPORT_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _record_error_report(stage: str, message: str, context: Optional[dict] = None) -> None:
    existing = _load_error_report()
    history = list(existing.get("history") or [])[-9:]
    history.append(
        {
            "timestamp": get_now_iso(),
            "stage": _safe_str(stage),
            "message": _safe_str(message),
            "context": context or {},
        }
    )
    _write_error_report(
        {
            "script": SCRIPT_NAME,
            "last_error_at": get_now_iso(),
            "stage": _safe_str(stage),
            "message": _safe_str(message),
            "context": context or {},
            "resolved_at": None,
            "history": history,
        }
    )


def _resolve_error_report(stage: str, context: Optional[dict] = None) -> None:
    existing = _load_error_report()
    if not existing:
        return
    existing["resolved_at"] = get_now_iso()
    existing["resolved_by"] = _safe_str(stage)
    if context:
        existing["resolution_context"] = context
    _write_error_report(existing)


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


def _merge_pipe_text(base: str, addition: str, limit: int = 1000) -> str:
    base_text = _safe_str(base)
    addition_text = _safe_str(addition)
    if not addition_text:
        return base_text[:limit]
    if not base_text:
        return addition_text[:limit]
    if addition_text in base_text:
        return base_text[:limit]
    return f"{base_text} | {addition_text}"[:limit]


def _unique_non_empty(values: list[str]) -> list[str]:
    seen = set()
    unique_values = []
    for value in values:
        normalized = _safe_str(value)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique_values.append(normalized)
    return unique_values


def _normalize_name_tokens(name: str) -> list[str]:
    cleaned = _clean_ship_name_for_prompt(name).lower()
    cleaned = re.sub(r"[^a-z0-9\s'-]+", " ", cleaned)
    return [token for token in cleaned.split() if token]


NAME_STATUS_RANK = {
    "missing": 0,
    "mismatch": 1,
    "fuzzy": 2,
    "minor": 3,
    "exact": 4,
}

NICKNAME_EQUIVALENTS = {
    "bill": "william",
    "billy": "william",
    "bob": "robert",
    "bobby": "robert",
    "jim": "james",
    "jimmy": "james",
    "joe": "joseph",
    "joey": "joseph",
    "johnny": "john",
    "kate": "katherine",
    "kathy": "katherine",
    "liz": "elizabeth",
    "beth": "elizabeth",
    "mike": "michael",
    "mickey": "michael",
    "matt": "matthew",
    "pat": "patrick",
    "rick": "richard",
    "rich": "richard",
    "tom": "thomas",
    "dick": "richard",
    "sue": "susan",
    "lou": "louis",
    "lue": "louis",
}

URL_NAME_SKIP_WORDS = {
    "and",
    "details",
    "funeral",
    "home",
    "homes",
    "location",
    "locations",
    "memorial",
    "memorials",
    "name",
    "obituary",
    "obituaries",
    "print",
    "service",
    "services",
    "tribute",
    "tributewall",
    "wall",
}


def _name_status_rank(status: str) -> int:
    return NAME_STATUS_RANK.get(_safe_str(status).lower(), 0)


def _canonicalize_name_token(token: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "", _safe_str(token).lower())
    return NICKNAME_EQUIVALENTS.get(cleaned, cleaned)


def _token_similarity(left: str, right: str) -> float:
    left_value = _canonicalize_name_token(left)
    right_value = _canonicalize_name_token(right)
    if not left_value or not right_value:
        return 0.0
    if left_value == right_value:
        return 1.0

    ratio = SequenceMatcher(None, left_value, right_value).ratio()
    shorter, longer = sorted([left_value, right_value], key=len)
    if (
        len(shorter) >= 3
        and len(longer) > len(shorter)
        and longer.startswith(shorter)
        and (len(shorter) / len(longer)) >= 0.6
    ):
        ratio = max(ratio, 0.92)
    return ratio


def _name_similarity_metrics(expected_name: str, matched_name: str) -> dict:
    expected_tokens = _normalize_name_tokens(expected_name)
    matched_tokens = _normalize_name_tokens(matched_name)
    expected_canonical = [_canonicalize_name_token(token) for token in expected_tokens]
    matched_canonical = [_canonicalize_name_token(token) for token in matched_tokens]
    shared_tokens = set(expected_canonical) & set(matched_canonical)

    token_scores = []
    for token in expected_canonical:
        if not matched_canonical:
            token_scores.append(0.0)
            continue
        token_scores.append(max(_token_similarity(token, candidate) for candidate in matched_canonical))

    token_score = sum(token_scores) / len(token_scores) if token_scores else 0.0
    overlap_score = len(shared_tokens) / max(len(set(expected_canonical)), 1)
    full_score = SequenceMatcher(
        None,
        " ".join(expected_canonical),
        " ".join(matched_canonical),
    ).ratio() if expected_canonical and matched_canonical else 0.0

    expected_first = expected_canonical[0] if expected_canonical else ""
    expected_last = expected_canonical[-1] if expected_canonical else ""
    matched_first = matched_canonical[0] if matched_canonical else ""
    matched_last = matched_canonical[-1] if matched_canonical else ""

    return {
        "expected_tokens": expected_tokens,
        "matched_tokens": matched_tokens,
        "expected_canonical": expected_canonical,
        "matched_canonical": matched_canonical,
        "shared_token_count": len(shared_tokens),
        "token_score": token_score,
        "overlap_score": overlap_score,
        "similarity_score": max(full_score, (token_score * 0.75) + (overlap_score * 0.25)),
        "expected_first": expected_first,
        "expected_last": expected_last,
        "matched_first": matched_first,
        "matched_last": matched_last,
        "first_similarity": _token_similarity(expected_first, matched_first),
        "last_similarity": _token_similarity(expected_last, matched_last),
        "expected_first_seen_anywhere": bool(expected_first and expected_first in matched_canonical),
    }


def _classify_name_match(expected_name: str, matched_name: str) -> tuple[str, str]:
    metrics = _name_similarity_metrics(expected_name, matched_name)
    expected_tokens = metrics["expected_tokens"]
    matched_tokens = metrics["matched_tokens"]

    if not matched_tokens:
        return "missing", "Name verification pending: matched name not returned"
    if not expected_tokens:
        return "missing", "Name verification pending: input name unavailable"
    if metrics["expected_canonical"] == metrics["matched_canonical"]:
        return "exact", f"Name verified exact: {_safe_str(matched_name)}"

    if metrics["expected_first"] == metrics["matched_first"] and metrics["expected_last"] == metrics["matched_last"]:
        return "minor", f"Name verified with minor variation: {_safe_str(expected_name)} vs {_safe_str(matched_name)}"
    if metrics["expected_last"] == metrics["matched_last"] and metrics["shared_token_count"] >= 2:
        return "minor", f"Name verified with shared family tokens: {_safe_str(expected_name)} vs {_safe_str(matched_name)}"
    if (
        metrics["similarity_score"] >= 0.75
        and metrics["last_similarity"] >= 0.88
        and (
            metrics["first_similarity"] >= 0.72
            or metrics["expected_first_seen_anywhere"]
            or metrics["shared_token_count"] >= 1
        )
    ):
        percent = round(metrics["similarity_score"] * 100, 1)
        return "fuzzy", f"Name verified with fuzzy match ({percent}%): {_safe_str(expected_name)} vs {_safe_str(matched_name)}"

    return "mismatch", f"Name mismatch: {_safe_str(expected_name)} vs {_safe_str(matched_name)}"


def _extract_url_candidates_from_value(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        candidates = re.findall(r"https?://[^\s<>()\"'|]+|www\.[^\s<>()\"'|]+", value, re.IGNORECASE)
        # Also capture markdown-style links where the URL is wrapped in parentheses.
        candidates.extend(
            re.findall(r"\((https?://[^\s<>()\"'|]+|www\.[^\s<>()\"'|]+)\)", value, re.IGNORECASE)
        )
        return candidates
    if isinstance(value, dict):
        urls = []
        for nested_value in value.values():
            urls.extend(_extract_url_candidates_from_value(nested_value))
        return urls
    if isinstance(value, (list, tuple, set)):
        urls = []
        for nested_value in value:
            urls.extend(_extract_url_candidates_from_value(nested_value))
        return urls
    return []


def _normalize_url_list(*values) -> list[str]:
    normalized_urls = []
    for value in values:
        for candidate in _extract_url_candidates_from_value(value):
            normalized = _safe_str(candidate).strip().strip("<>{}[]\"'")
            normalized = normalized.rstrip(".,;:!?)")
            if normalized.lower().startswith("www."):
                normalized = f"https://{normalized}"
            parsed = urlparse(normalized)
            if parsed.scheme in ("http", "https") and parsed.netloc:
                normalized_urls.append(normalized)
    return _unique_non_empty(normalized_urls)


def _collect_response_urls(response_payload: dict, ai_text: str = "") -> list[str]:
    candidates = [_safe_str(ai_text)]
    if isinstance(response_payload, dict):
        for key in (
            "citations",
            "references",
            "search_results",
            "search_results_with_snippets",
            "sources",
            "web_results",
            "web_search_results",
        ):
            if response_payload.get(key):
                candidates.append(response_payload.get(key))
        choices = response_payload.get("choices") or []
        if choices:
            candidates.append(choices[0])
    return _normalize_url_list(*candidates)


def _build_search_api_request(prompt: str) -> tuple[str, str, dict, dict]:
    model_name = _active_model_name()
    if _is_openai_model(model_name):
        api_key = _required_env("OPENAI_API_KEY")
        payload = {
            "model": model_name,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
        }
        if "search" in model_name.lower():
            payload["web_search_options"] = {"search_context_size": "high"}
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        return "OpenAI", OPENAI_URL, headers, payload

    api_key = _required_env("PERPLEXITY_API_KEY")
    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    return "Perplexity AI", PERPLEXITY_URL, headers, payload


def _is_obituary_like_url(url: str) -> bool:
    path = urlparse(_safe_str(url)).path.lower()
    return any(keyword in path for keyword in ("obituary", "obituaries", "tribute", "memorial"))


def _decode_url_name_candidate(segment: str) -> str:
    candidate = unquote(_safe_str(segment))
    if not candidate:
        return ""
    candidate = candidate.split("#", 1)[0].split("?", 1)[0]
    candidate = re.sub(r"\.[a-z0-9]{1,5}$", "", candidate, flags=re.IGNORECASE)
    candidate = candidate.replace("_", " ").replace("-", " ")
    candidate = re.sub(r"\b\d+\b", " ", candidate)
    candidate = re.sub(r"[^a-zA-Z\s']", " ", candidate)
    tokens = [
        token
        for token in candidate.split()
        if token and token.lower() not in URL_NAME_SKIP_WORDS
    ]
    if len(tokens) < 2:
        return ""
    return " ".join(token.title() for token in tokens)


def _url_name_candidates(url: str) -> list[str]:
    path_segments = [segment for segment in urlparse(_safe_str(url)).path.split("/") if segment]
    candidates = []
    for index, segment in enumerate(path_segments):
        decoded = _decode_url_name_candidate(segment)
        if decoded:
            candidates.append(decoded)
        if segment.isdigit() and index + 1 < len(path_segments):
            decoded = _decode_url_name_candidate(path_segments[index + 1])
            if decoded:
                candidates.append(decoded)
    return _unique_non_empty(candidates)


def _infer_matched_name_from_sources(expected_name: str, source_urls: list[str]) -> str:
    best_candidate = ""
    best_rank = 0
    best_score = 0.0

    for url in source_urls:
        if not _is_obituary_like_url(url):
            continue
        for candidate in _url_name_candidates(url):
            status, _ = _classify_name_match(expected_name, candidate)
            metrics = _name_similarity_metrics(expected_name, candidate)
            rank = _name_status_rank(status)
            score = metrics["similarity_score"]
            if rank > best_rank or (rank == best_rank and score > best_score):
                best_candidate = candidate
                best_rank = rank
                best_score = score

    return best_candidate if best_rank >= _name_status_rank("fuzzy") else ""


def _parse_date_candidate(raw_text: str) -> str:
    value = _safe_str(raw_text)
    if not value:
        return ""

    cleaned = re.sub(
        r"(?i)\b(mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(r(s(day)?)?)?|fri(day)?|sat(urday)?|sun(day)?)\b",
        " ",
        value,
    )
    cleaned = re.sub(r"\s+", " ", cleaned.replace(",", " ")).strip()
    direct_candidates = [cleaned]
    current_year = int(get_now_iso()[:4])
    for pattern in [
        r"\b\d{4}-\d{2}-\d{2}\b",
        r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b",
        r"\b\d{1,2}[/-]\d{1,2}\b",
        r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:\s+\d{2,4})\b",
        r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b",
    ]:
        direct_candidates.extend(re.findall(pattern, cleaned, re.IGNORECASE))

    for candidate in _unique_non_empty(direct_candidates):
        candidate_with_year = candidate
        if re.fullmatch(r"\d{1,2}[/-]\d{1,2}", candidate):
            candidate_with_year = f"{candidate}/{current_year}"
        elif re.fullmatch(
            r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}",
            candidate,
            re.IGNORECASE,
        ):
            candidate_with_year = f"{candidate} {current_year}"
        for fmt in (
            "%Y-%m-%d",
            "%m/%d/%Y",
            "%m/%d/%y",
            "%m-%d-%Y",
            "%m-%d-%y",
            "%B %d %Y",
            "%b %d %Y",
            "%m/%d",
            "%m-%d",
            "%B %d",
            "%b %d",
        ):
            try:
                # Always supply a year to avoid Python 3.15 DeprecationWarning for
                # year-less strptime formats like %m/%d, %B %d, etc.
                if "%Y" in fmt:
                    parsed_source = candidate_with_year
                    parsed = datetime.strptime(parsed_source, fmt)
                else:
                    # Prepend current year and adjust the format accordingly
                    year_fmt = f"%Y/{fmt}"
                    parsed_source = f"{current_year}/{candidate}"
                    parsed = datetime.strptime(parsed_source, year_fmt)
                return parsed.date().isoformat()
            except ValueError:
                continue
    return ""


def _extract_dates_from_text(text: str) -> list[str]:
    raw_text = _safe_str(text)
    if not raw_text:
        return []

    candidates = re.findall(
        r"\b\d{4}-\d{2}-\d{2}\b|"
        r"\b\d{1,2}[/-]\d{1,2}\b|"
        r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|"
        r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*|\s+)\d{2,4}\b|"
        r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b",
        raw_text,
        re.IGNORECASE,
    )

    normalized_dates = []
    for candidate in candidates:
        normalized = _parse_date_candidate(candidate)
        if normalized:
            normalized_dates.append(normalized)
    return _unique_non_empty(normalized_dates)


def _evaluate_date_verification(order: dict, parsed: dict) -> tuple[str, str]:
    parsed_date_values = _unique_non_empty(
        [
            _safe_str(parsed.get("service_date")),
            _safe_str(parsed.get("visitation_date")),
            _safe_str(parsed.get("ceremony_date")),
        ]
    )
    parsed_dates = _unique_non_empty([_parse_date_candidate(value) for value in parsed_date_values])
    if _has_schedule_hint(parsed.get("special_instructions")):
        parsed_dates = _unique_non_empty([*parsed_dates, *_extract_dates_from_text(parsed.get("special_instructions"))])
    instruction_dates = _extract_dates_from_text(order.get("ord_instruct"))

    if instruction_dates and parsed_dates:
        if any(parsed_date in instruction_dates for parsed_date in parsed_dates):
            return "verified", f"Date verified against order instructions: {', '.join(parsed_dates)}"
        return "mismatch", f"Date mismatch: instructions={', '.join(instruction_dates)} source={', '.join(parsed_dates)}"

    if parsed_date_values and not parsed_dates:
        return "invalid", f"Date requires review: unable to normalize source date value(s) {', '.join(parsed_date_values)}"

    if parsed_dates:
        return "source_only", f"Date verified from source only: {', '.join(parsed_dates)}"

    if instruction_dates and _has_schedule_hint(order.get("ord_instruct")):
        return "instruction_only", f"Date verified from order instructions: {', '.join(instruction_dates)}"

    if _has_schedule_hint(order.get("ord_instruct")):
        return "instruction_only", "Schedule verified from order instructions without a fully normalized date"

    return "missing", "Date verification missing: no valid service date identified"


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


def _extract_time_from_text(text: str) -> str:
    value = _safe_str(text)
    if not value:
        return ""
    match = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", value, re.IGNORECASE)
    if not match:
        return ""
    hour = int(match.group(1))
    minute = int(match.group(2) or 0)
    if hour < 1 or hour > 12 or minute > 59:
        return ""
    return f"{hour}:{minute:02d} {match.group(3).upper()}"


def _infer_service_type_from_instructions(text: str) -> str:
    value = _safe_str(text).lower()
    if not value:
        return ""
    if any(keyword in value for keyword in ["visitation", "viewing", "wake"]):
        return "visitation"
    if any(keyword in value for keyword in ["burial", "graveside", "interment", "committal", "cemetery"]):
        return "graveside"
    if "celebration of life" in value or "memorial" in value:
        return "memorial"
    if "church" in value or "chapel" in value:
        return "church"
    if "funeral" in value or "service" in value:
        return "funeral"
    return "customer-provided schedule"


def _instruction_schedule_fields(text: str) -> dict:
    instruction_text = _safe_str(text)
    if not _has_schedule_hint(instruction_text):
        return {}

    normalized_dates = _extract_dates_from_text(instruction_text)
    normalized_time = _extract_time_from_text(instruction_text)
    lowered = instruction_text.lower()
    field_prefix = "service"
    field_label = "Service"
    if any(keyword in lowered for keyword in ["visitation", "viewing", "wake"]):
        field_prefix = "visitation"
        field_label = "Visitation"
    elif any(keyword in lowered for keyword in ["ceremony", "burial", "graveside", "interment", "committal"]):
        field_prefix = "ceremony"
        field_label = "Ceremony"

    formatted_bits = []
    if normalized_dates:
        formatted_bits.append(normalized_dates[0])
    if normalized_time:
        formatted_bits.append(normalized_time)

    fields = {
        "service_type": _infer_service_type_from_instructions(instruction_text),
        "special_instructions": (
            f"{field_label} schedule from customer instructions: {' '.join(formatted_bits).strip() or 'timing noted'}"
            f" | Original order instructions: {instruction_text}"
        )[:1000],
    }
    if normalized_dates:
        fields[f"{field_prefix}_date"] = normalized_dates[0]
    if normalized_time:
        fields[f"{field_prefix}_time"] = normalized_time
    return fields


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
    original_venue_evidence = bool(
        _safe_str(parsed.get("funeral_home_name"))
        or _safe_str(parsed.get("funeral_address"))
        or _safe_str(parsed.get("funeral_phone"))
        or _safe_str(parsed.get("service_type"))
    )
    original_timing_evidence = bool(
        _safe_str(parsed.get("service_date"))
        or _safe_str(parsed.get("service_time"))
        or _safe_str(parsed.get("visitation_date"))
        or _safe_str(parsed.get("visitation_time"))
        or _safe_str(parsed.get("ceremony_date"))
        or _safe_str(parsed.get("ceremony_time"))
    )
    instruction_schedule = _instruction_schedule_fields(customer_instructions)

    for field, value in instruction_schedule.items():
        if not value:
            continue
        if field == "special_instructions":
            adjusted["special_instructions"] = _merge_pipe_text(adjusted.get("special_instructions"), value)
            continue
        if not _safe_str(adjusted.get(field)):
            adjusted[field] = value

    has_datetime_pair = bool(
        (_safe_str(adjusted.get("service_date")) and _safe_str(adjusted.get("service_time")))
        or (_safe_str(adjusted.get("visitation_date")) and _safe_str(adjusted.get("visitation_time")))
        or (_safe_str(adjusted.get("ceremony_date")) and _safe_str(adjusted.get("ceremony_time")))
    )
    has_any_timing = bool(
        _safe_str(adjusted.get("service_date"))
        or _safe_str(adjusted.get("service_time"))
        or _safe_str(adjusted.get("visitation_date"))
        or _safe_str(adjusted.get("visitation_time"))
        or _safe_str(adjusted.get("ceremony_date"))
        or _safe_str(adjusted.get("ceremony_time"))
    )

    source_urls = _normalize_url_list(adjusted.get("source_urls"))
    adjusted["source_urls"] = " | ".join(source_urls)
    inferred_name = _infer_matched_name_from_sources(order.get("ship_name"), source_urls)
    current_name_status, _ = _classify_name_match(order.get("ship_name"), adjusted.get("matched_name"))
    inferred_name_status, _ = _classify_name_match(order.get("ship_name"), inferred_name)
    if _name_status_rank(inferred_name_status) > _name_status_rank(current_name_status):
        adjusted["matched_name"] = inferred_name

    has_obituary_url = any(_is_obituary_like_url(url) for url in source_urls)
    has_legacy_source = any("legacy.com" in str(url).lower() for url in source_urls)
    has_valid_source_url = bool(source_urls)
    has_external_source_evidence = bool(has_valid_source_url or original_venue_evidence or original_timing_evidence)
    service_type_normalized = _safe_str(adjusted.get("service_type")).lower()
    has_venue_evidence = bool(
        _safe_str(adjusted.get("funeral_home_name"))
        or _safe_str(adjusted.get("funeral_address"))
        or _safe_str(adjusted.get("funeral_phone"))
        or (service_type_normalized and service_type_normalized not in {"unknown", "other", "none", "na", "n/a", "null"})
    )
    has_date_evidence = bool(
        _safe_str(adjusted.get("service_date"))
        or _safe_str(adjusted.get("visitation_date"))
        or _safe_str(adjusted.get("ceremony_date"))
    )
    has_time_evidence = bool(
        _safe_str(adjusted.get("service_time"))
        or _safe_str(adjusted.get("visitation_time"))
        or _safe_str(adjusted.get("ceremony_time"))
    )
    has_source_evidence = bool(
        has_venue_evidence
        or has_valid_source_url
        or has_date_evidence
        or has_time_evidence
    )

    if instruction_schedule:
        if not _safe_str(adjusted.get("matched_name")):
            adjusted["matched_name"] = _clean_ship_name_for_prompt(order.get("ship_name")) or "customer-provided schedule"

    name_match_status, name_match_note = _classify_name_match(
        order.get("ship_name"),
        adjusted.get("matched_name"),
    )
    if instruction_schedule and name_match_status in {"missing", "mismatch"} and not has_source_evidence:
        name_match_status = "exact"
        adjusted_name = _clean_ship_name_for_prompt(order.get("ship_name")) or "customer-provided schedule"
        name_match_note = f"Name verified from order instructions: {adjusted_name}"
        adjusted["matched_name"] = adjusted_name
    adjusted["name_match_status"] = name_match_status
    notes = _append_unique_note(notes, name_match_note)

    date_verification_status, date_verification_note = _evaluate_date_verification(order, adjusted)
    adjusted["date_verification_status"] = date_verification_status
    adjusted["date_verification_notes"] = date_verification_note
    notes = _append_unique_note(notes, date_verification_note)

    score = float(adjusted.get("ai_accuracy_score") or 0)
    instruction_has_schedule = bool(instruction_schedule)
    has_schedule_text = _has_schedule_hint(adjusted.get("special_instructions"))

    if name_match_status == "mismatch" and (has_source_evidence or has_any_timing or instruction_has_schedule):
        adjusted["match_status"] = "Review"
        adjusted["ai_accuracy_score"] = min(max(score, 60.0), 84.0)
        notes = _append_unique_note(notes, "Review: source identity does not cleanly match requested deceased")
    elif date_verification_status == "mismatch":
        adjusted["match_status"] = "Review"
        adjusted["ai_accuracy_score"] = min(max(score, 60.0), 84.0)
        notes = _append_unique_note(notes, "Review: source date conflicts with customer instructions")
    elif (
        instruction_schedule
        and not has_external_source_evidence
        and date_verification_status in {"verified", "instruction_only"}
        and name_match_status in {"exact", "minor", "fuzzy"}
    ):
        adjusted["match_status"] = "Customer"
        adjusted["ai_accuracy_score"] = max(score, 72.0)
        notes = _append_unique_note(notes, "Customer: schedule normalized from order instructions because outside sources did not confirm it")
    elif (
        name_match_status in {"exact", "minor", "fuzzy"}
        and has_valid_source_url
        and has_date_evidence
        and has_time_evidence
        and date_verification_status != "mismatch"
    ):
        adjusted["match_status"] = "Found"
        adjusted["ai_accuracy_score"] = max(score, 85.0)
    elif (
        name_match_status in {"exact", "minor", "fuzzy"}
        and has_obituary_url
        and has_time_evidence
        and not has_date_evidence
        and date_verification_status in {"missing", "invalid"}
    ):
        adjusted["match_status"] = "Found"
        adjusted["ai_accuracy_score"] = max(score, 75.0)
        notes = _append_unique_note(notes, "Found with time-only evidence from an obituary/detail source URL")
    elif date_verification_status in {"verified", "source_only"} and name_match_status in {"exact", "minor", "fuzzy"}:
        adjusted["match_status"] = "Found"
        adjusted["ai_accuracy_score"] = max(score, 85.0 if date_verification_status == "verified" else 80.0)
    elif date_verification_status == "instruction_only" and name_match_status in {"exact", "minor", "fuzzy"}:
        adjusted["match_status"] = "Customer"
        adjusted["ai_accuracy_score"] = max(score, 72.0)
        notes = _append_unique_note(notes, "Customer: schedule verified from order instructions because no reliable outside source was found")
    elif date_verification_status == "invalid":
        adjusted["match_status"] = "Review"
        adjusted["ai_accuracy_score"] = min(max(score, 55.0), 84.0)
    elif has_obituary_url or has_legacy_source or has_source_evidence or has_any_timing or instruction_has_schedule or has_schedule_text:
        adjusted["match_status"] = "Review"
        adjusted["ai_accuracy_score"] = min(max(score, 55.0), 84.0)
        if has_obituary_url:
            notes = _append_unique_note(notes, "Review: obituary source found but validation is incomplete")
        elif has_source_evidence:
            notes = _append_unique_note(notes, "Review: venue or source evidence found but complete validation is pending")
    else:
        adjusted["match_status"] = "NotFound"
        adjusted["ai_accuracy_score"] = min(score, 49.0)
        notes = _append_unique_note(notes, "NotFound: no valid source URL, no venue evidence, and no date/time schedule evidence")

    destination_kind = _destination_type(order)
    if destination_kind == "non_funeral" and (adjusted.get("match_status") == "Found" or has_source_evidence or instruction_has_schedule or has_any_timing):
        adjusted["match_status"] = "Review"
        adjusted["ai_accuracy_score"] = min(float(adjusted.get("ai_accuracy_score") or 0), 84.0)
        notes = _append_unique_note(notes, "Review required: destination appears non-funeral location")

    if (
        destination_kind != "non_funeral"
        and has_datetime_pair
        and adjusted.get("match_status") == "Review"
        and name_match_status in {"exact", "minor", "fuzzy"}
        and date_verification_status != "mismatch"
    ):
        adjusted["match_status"] = "Found"
        adjusted["ai_accuracy_score"] = max(float(adjusted.get("ai_accuracy_score") or 0), 85.0)

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


def _normalize_order_id(value) -> str:
    order_id = _safe_str(value)
    if not order_id:
        return ""
    # Some CSV exporters coerce numeric order IDs into float-like strings.
    if re.fullmatch(r"\d+\.0+", order_id):
        return order_id.split(".", 1)[0]
    return order_id


def load_order_ids_from_csv(csv_path: Path) -> set:
    if not csv_path.exists():
        return set()
    ids = set()
    _, rows, encoding_used = _read_csv_dict_rows(csv_path)
    if encoding_used not in {"utf-8-sig", "utf-8"}:
        print(f"[{SCRIPT_NAME}] INFO: Read {csv_path.name} using {encoding_used} fallback")
    for row in rows:
        order_id = _normalize_order_id(row.get("order_id"))
        if order_id:
            ids.add(order_id)
    return ids

# ── Input reader ─────────────────────────────────────────────────────────────

def load_orders_from_inquiry(latest_count: int = 0) -> list:
    """
    Read order data from GetOrderInquiry/data.csv.
    Returns list of dicts with the combined column data.
    """
    if not INPUT_CSV.exists():
        print(f"[{SCRIPT_NAME}] ERROR: Input CSV not found: {INPUT_CSV}")
        print(f"[{SCRIPT_NAME}]   → Run GetOrderInquiry.py first.")
        return []

    _, rows, encoding_used = _read_csv_dict_rows(INPUT_CSV)
    if encoding_used not in {"utf-8-sig", "utf-8"}:
        print(f"[{SCRIPT_NAME}] INFO: Read {INPUT_CSV.name} using {encoding_used} fallback")

    normalized_rows = []
    for row in rows:
        oid = _safe_str(row.get("order_id"))
        if not oid:
            continue
        normalized_rows.append({
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
            "last_processed_at": _safe_str(row.get("last_processed_at")),
        })

    normalized_rows.sort(
        key=lambda entry: _parse_iso_datetime(entry.get("last_processed_at")) or datetime.min,
        reverse=True,
    )

    orders = []
    seen_ids = set()
    for row in normalized_rows:
        oid = _safe_str(row.get("order_id"))
        if not oid or oid in seen_ids:
            continue
        seen_ids.add(oid)
        orders.append(row)
        if latest_count > 0 and len(orders) >= latest_count:
            break

    return orders


# ── Prompt builder ───────────────────────────────────────────────────────────

def build_prompt(order: dict, template_text: str) -> str:
    """Build user prompt from template (if present) plus normalized order context."""
    context_lines = []
    context_lines.append(f"Name: {_clean_ship_name_for_prompt(order['ship_name'])}")
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
            "[INSERT ROW/CONTENT]",
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
    csv_path.parent.mkdir(parents=True, exist_ok=True)
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
    excel_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fieldnames, all_rows, encoding_used = _read_csv_dict_rows(csv_path)
        if not fieldnames:
            fieldnames = list(FIELDNAMES)
        if encoding_used not in {"utf-8-sig", "utf-8"}:
            print(f"[{SCRIPT_NAME}] INFO: Rebuilt {excel_path.name} from {csv_path.name} using {encoding_used} fallback")

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = sheet_name[:31] or "Sheet1"
        ws.append(list(fieldnames))
        for row in all_rows:
            ws.append([_safe_str(row.get(col, "")) for col in fieldnames])

        temp_excel_path = excel_path.with_name(f"{excel_path.stem}.tmp{excel_path.suffix}")
        wb.save(temp_excel_path)
        temp_excel_path.replace(excel_path)
        _resolve_error_report(
            "excel_rebuild",
            {"csv_path": str(csv_path), "excel_path": str(excel_path), "rows": len(all_rows)},
        )
    except Exception as exc:
        _record_error_report(
            "excel_rebuild",
            str(exc),
            {"csv_path": str(csv_path), "excel_path": str(excel_path), "sheet_name": sheet_name},
        )
        print(f"[{SCRIPT_NAME}] WARNING: Excel rebuild skipped for {excel_path.name}: {exc}")


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


def save_record_to_status_outputs(record: dict, status: str, date_key: Optional[str] = None) -> None:
    """Persist record into category-specific canonical and date-wise files."""
    normalized_status = normalize_match_status(status)
    if normalized_status == "Customer":
        save_one_record_to_csv(CUSTOMER_CSV_PATH, record)
        rebuild_excel_from_csv(CUSTOMER_CSV_PATH, CUSTOMER_EXCEL_PATH, "Customer")
        save_one_record_to_csv(get_date_wise_output_path("Funeral_data_customer.csv", date_key), record)
        return

    if normalized_status == "Found":
        save_one_record_to_csv(FOUND_CSV_PATH, record)
        rebuild_excel_from_csv(FOUND_CSV_PATH, FOUND_EXCEL_PATH, "Found")
        save_one_record_to_csv(get_date_wise_output_path("Funeral_data_found.csv", date_key), record)
        return

    if normalized_status == "NotFound":
        save_one_record_to_csv(NOT_FOUND_CSV_PATH, record)
        rebuild_excel_from_csv(NOT_FOUND_CSV_PATH, NOT_FOUND_EXCEL_PATH, "Not Found")
        save_one_record_to_csv(get_date_wise_output_path("Funeral_data_not_found.csv", date_key), record)
        return

    if normalized_status == "Review":
        save_one_record_to_csv(REVIEW_CSV_PATH, record)
        rebuild_excel_from_csv(REVIEW_CSV_PATH, REVIEW_EXCEL_PATH, "Review")
        save_one_record_to_csv(get_date_wise_output_path("Funeral_data_review.csv", date_key), record)


# ── AI response parser ──────────────────────────────────────────────────────

def parse_ai_response(ai_text: str) -> dict:
    """Parse Perplexity AI response text into structured fields."""
    ai_data = _extract_json_from_text(ai_text)
    if not ai_data:
        ai_data = _extract_structured_fields_from_text(ai_text)

    matched_name = _safe_str(
        ai_data.get("matched_name")
        or ai_data.get("Matched Name")
        or ai_data.get("matched_deceased_name")
        or ai_data.get("deceased_name")
        or ai_data.get("Deceased Name")
    )
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
    if status_lower:
        match_status = normalize_match_status(status_lower)
    else:
        has_data = bool(
            ai_data.get("funeral_home_name") or ai_data.get("Funeral home name (optional)") or
            ai_data.get("funeral_date")      or ai_data.get("Funeral date") or
            ai_data.get("service_date")
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

    if match_status == "Review" and score >= 75:
        match_status = "Found"

    urls = ai_data.get("source_urls") or ai_data.get("Source URLs") or []
    valid_urls = _normalize_url_list(urls, ai_text)
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
    has_datetime_pair = bool((service_date and service_time) or (visitation_date and visitation_time) or (ceremony_date and ceremony_time))
    notes_value = _safe_str(ai_data.get("notes") or ai_data.get("Summary") or ai_data.get("Status Justification"))

    def _partial_timing_note() -> str:
        dates_present = any(_safe_str(value) for value in [service_date, visitation_date, ceremony_date])
        times_present = any(_safe_str(value) for value in [service_time, visitation_time, ceremony_time])
        if has_datetime_pair:
            return ""
        if dates_present and not times_present:
            return "date-only"
        if times_present and not dates_present:
            return "time-only"
        if dates_present or times_present:
            return "partial-datetime"
        return ""

    timing_note = _partial_timing_note()

    # Primary decision comes from AI status; score only gates ambiguous transitions.
    if match_status == "Found":
        if not (score >= 70 and evidence_count >= 2 and has_sources):
            if evidence_count >= 1 or has_sources or funeral_home_name or funeral_address or funeral_phone or service_type:
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

    name_evidence = bool(_safe_str(matched_name))
    obituary_evidence = any(keyword in url.lower() for url in valid_urls for keyword in ["obituary", "obituaries", "tribute", "memorial"])
    if match_status == "Review" and not name_evidence and not obituary_evidence and not has_datetime_pair:
        match_status = "NotFound"

    if has_datetime_pair:
        if match_status in {"NotFound", "Review"}:
            match_status = "Found"
        score = max(score, 70.0)
    elif timing_note:
        if match_status == "Found" or evidence_count >= 1 or has_sources or funeral_home_name or funeral_address or funeral_phone or service_type:
            match_status = "Review"
            score = max(score, 60.0)
        else:
            match_status = "NotFound"
            score = min(score, 49.0)
        notes_value = _append_unique_note(notes_value, timing_note)
    else:
        if match_status == "Found":
            if evidence_count >= 1 or has_sources or funeral_home_name or funeral_address or funeral_phone or service_type:
                match_status = "Review"
            else:
                match_status = "NotFound"
        elif match_status == "Review" and not (evidence_count >= 1 or has_sources):
            match_status = "NotFound"
        score = min(score, 69.0 if match_status == "Review" else 49.0)
    # NOTE: Do NOT force NotFound here when evidence exists.
    # Let _apply_business_rules() decide based on web sources, venue confirmation, etc.

    if fallback_source in {"visitation", "ceremony"}:
        notes_value = f"{notes_value} | service datetime fallback={fallback_source}".strip(" |")

    return {
        "matched_name": matched_name,
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
        "name_match_status": "",
        "date_verification_status": "",
        "date_verification_notes": "",
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
    parser.add_argument("--reprocess-notfound", action="store_true",
                        help="Reprocess rows that are already in Funeral_data_not_found.csv")
    parser.add_argument("--limit", type=int, default=0,
                        help="Cap how many orders to process (0 = unlimited)")
    parser.add_argument("--latest-count", type=int, default=0,
                        help="Force reprocess only the newest N GetOrderInquiry rows by last_processed_at")
    args = parser.parse_args()

    load_dotenv_file()
    run_guard = load_run_guard()
    run_date_key = _run_date_key()
    if (
        _safe_str(run_guard.get("status")) == "running"
        and _safe_str(run_guard.get("date_key")) == run_date_key
        and not args.force
    ):
        started_at_text = _safe_str(run_guard.get("started_at"))
        started_dt = _parse_iso_datetime(started_at_text)
        guard_is_fresh = False
        if started_dt:
            current_dt = datetime.now(started_dt.tzinfo) if started_dt.tzinfo else datetime.now()
            guard_is_fresh = (current_dt - started_dt).total_seconds() < 3 * 60 * 60
        guard_process_active = _is_process_active(run_guard.get("pid"))
        if guard_is_fresh and guard_process_active:
            print(
                f"[{SCRIPT_NAME}] Another run is already active since {started_at_text}. "
                "Use --force to override."
            )
            raise SystemExit(CONCURRENT_RUN_EXIT_CODE)
        print(
            f"[{SCRIPT_NAME}] Previous run marker was stale; proceeding with current run. "
            f"(started_at={started_at_text or 'unknown'}, pid={_safe_str(run_guard.get('pid')) or 'unknown'})"
        )

    save_run_guard({
        "status": "running",
        "date_key": run_date_key,
        "started_at": get_now_iso(),
        "pid": os.getpid(),
        "force": bool(args.force),
        "limit": int(args.limit or 0),
        "latest_count": int(args.latest_count or 0),
    })

    date_wise_csv_path = get_date_wise_csv_path(run_date_key)
    _, date_wise_log_path = ensure_log_files(run_date_key)
    previous_error_report = _load_error_report()
    if previous_error_report and not previous_error_report.get("resolved_at"):
        print(
            f"[{SCRIPT_NAME}] Previous error report loaded: "
            f"{_safe_str(previous_error_report.get('stage'))} -> {_safe_str(previous_error_report.get('message'))}"
        )

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
    orders = load_orders_from_inquiry(int(args.latest_count or 0))
    if not orders:
        print(f"[{SCRIPT_NAME}] No orders to process.")
        save_run_guard({
            "status": "completed",
            "date_key": run_date_key,
            "started_at": _safe_str(load_run_guard().get("started_at")) or get_now_iso(),
            "finished_at": get_now_iso(),
            "pid": os.getpid(),
            "processed": 0,
            "found": 0,
            "review": 0,
            "not_found": 0,
            "latest_count": int(args.latest_count or 0),
        })
        return

    print(f"\n┌─────────────────────────────────────────────────────────┐")
    print(f"│  INPUT SUMMARY                                          │")
    print(f"│  Orders loaded (de-duped) : {len(orders):<29}│")
    print(f"│  Source file              : GetOrderInquiry/data.csv     │")
    print(f"└─────────────────────────────────────────────────────────┘")
    if args.latest_count:
        print(f"[{SCRIPT_NAME}] Force latest mode enabled – newest {args.latest_count} GetOrderInquiry rows will be reprocessed")

    # ── 2. Load already-processed IDs from logs.txt ──────────────────────────
    logged_ids = set() if args.force else load_logged_ids()
    not_found_ids = load_order_ids_from_csv(NOT_FOUND_CSV_PATH) if args.reprocess_notfound else set()
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
    customer_count = 0
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
        if order_id in logged_ids and not args.force and not (args.reprocess_notfound and order_id in not_found_ids):
            print(f"  ⏭  SKIP – already in logs.txt")
            skipped_count += 1
            continue

        # Limit check
        if args.limit > 0 and new_count >= args.limit:
            print(f"\n[{SCRIPT_NAME}] Reached --limit={args.limit}; stopping early.")
            break

        # Build prompt
        prompt = build_prompt(order, template_text)
        provider_name, request_url, headers, api_payload = _build_search_api_request(prompt)
        print(f"  → Sending to {provider_name} ({api_payload['model']})...")

        try:
            response = requests.post(
                request_url,
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
        merged_urls = _normalize_url_list(parsed.get("source_urls"), _collect_response_urls(resp_json, ai_text))
        if merged_urls:
            parsed["source_urls"] = " | ".join(merged_urls)
        parsed = _apply_business_rules(order, parsed)

        # Show result in terminal
        status = normalize_match_status(parsed["match_status"])
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
        print(f"  📁 Date-wise appended: {date_wise_csv_path.parent.name}\\{date_wise_csv_path.name}")

        # ── CATEGORY FILES: Found / NotFound / Review ────────────────────
        save_record_to_status_outputs(record, status, run_date_key)
        if status == "Customer":
            customer_count += 1
            print("  Also saved to Funeral_data_customer.csv & .xlsx")
        elif status == "NotFound":
            not_found_count += 1
            print(f"  📁 Also saved to Funeral_data_not_found.csv & .xlsx")
        elif status == "Review":
            review_count += 1
            print(f"  📁 Also saved to Funeral_data_review.csv & .xlsx")
        else:
            found_count += 1
            print(f"  📁 Also saved to Funeral_data_found.csv & .xlsx")

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
    print(
        f"[{SCRIPT_NAME}] RUN SUMMARY | "
        f"Customer={customer_count} | Found={found_count} | Review={review_count} | NotFound={not_found_count} | "
        f"Skipped={skipped_count} | Errors={error_count} | Total={total} | Processed={new_count}"
    )

    print(f"\n[{SCRIPT_NAME}] Output folder : {OUTPUT_DIR}")
    print(f"[{SCRIPT_NAME}] Files created :")
    for fp in [CSV_PATH, EXCEL_PATH, FOUND_CSV_PATH, FOUND_EXCEL_PATH, NOT_FOUND_CSV_PATH, NOT_FOUND_EXCEL_PATH,
             REVIEW_CSV_PATH, REVIEW_EXCEL_PATH, PAYLOAD_PATH, LOGS_PATH,
             date_wise_csv_path, date_wise_log_path]:
        mark = "✓" if fp.exists() else "✗"
        print(f"  {mark}  {fp.name}")
    save_run_guard({
        "status": "completed",
        "date_key": run_date_key,
        "started_at": _safe_str(run_guard.get("started_at")) or get_now_iso(),
        "finished_at": get_now_iso(),
        "pid": os.getpid(),
        "processed": new_count,
        "found": found_count,
        "review": review_count,
        "not_found": not_found_count,
        "latest_count": int(args.latest_count or 0),
    })


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as exc:
        try:
            _record_error_report("fatal", str(exc), {"type": exc.__class__.__name__})
        except Exception:
            pass
        try:
            run_guard = load_run_guard()
            if _safe_str(run_guard.get("status")) == "running" and int(run_guard.get("pid") or 0) == os.getpid():
                save_run_guard({
                    **run_guard,
                    "status": "failed",
                    "finished_at": get_now_iso(),
                    "error": str(exc),
                    "pid": os.getpid(),
                })
        except Exception:
            pass
        raise
