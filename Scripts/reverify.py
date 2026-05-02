#!/usr/bin/env python3
"""Re-verify Funeral Finder output records with multi-strategy dual-provider queries."""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
from difflib import SequenceMatcher
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional, Tuple, Union
from urllib.parse import unquote, urlparse

import requests
from runtime_config import get_date_key, get_now_iso as runtime_now_iso, load_root_env

PERPLEXITY_MODEL = os.getenv("PERPLEXITY_MODEL", "sonar-pro")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-search-preview")
REVERIFY_DEFAULT_PROVIDER = os.getenv("REVERIFY_DEFAULT_PROVIDER", "perplexity")

try:
    import openpyxl
    OPENPYXL_AVAILABLE = True
except ImportError:
    OPENPYXL_AVAILABLE = False

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

PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"
TIMEOUT_SECONDS = 120
SCRIPT_NAME = "Reverify"
SCRIPTS_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = SCRIPTS_DIR / "outputs" / "Funeral_Finder"
DATE_WISE_DIR = OUTPUT_DIR / "date_wise"
DEFAULT_PROMPT_TEMPLATE = SCRIPTS_DIR / "prompts" / "funeral_search_template.md"
INPUT_CSV = SCRIPTS_DIR / "outputs" / "GetOrderInquiry" / "data.csv"
GET_ORDER_INQUIRY_LOGS_PATH = SCRIPTS_DIR / "outputs" / "GetOrderInquiry" / "logs.txt"

SOURCE_FILES = {
    "not_found": OUTPUT_DIR / "Funeral_data_not_found.csv",
    "review": OUTPUT_DIR / "Funeral_data_review.csv",
}
MAIN_CSV_PATH = OUTPUT_DIR / "Funeral_data.csv"
MAIN_EXCEL_PATH = OUTPUT_DIR / "Funeral_data.xlsx"
FOUND_CSV_PATH = OUTPUT_DIR / "Funeral_data_found.csv"
FOUND_EXCEL_PATH = OUTPUT_DIR / "Funeral_data_found.xlsx"
CUSTOMER_CSV_PATH = OUTPUT_DIR / "Funeral_data_customer.csv"
CUSTOMER_EXCEL_PATH = OUTPUT_DIR / "Funeral_data_customer.xlsx"
NOT_FOUND_EXCEL_PATH = OUTPUT_DIR / "Funeral_data_not_found.xlsx"
REVIEW_EXCEL_PATH = OUTPUT_DIR / "Funeral_data_review.xlsx"
PAYLOAD_PATH = OUTPUT_DIR / "reverify_payload.json"
LOGS_PATH = OUTPUT_DIR / "reverify_logs.txt"
RUN_GUARD_PATH = OUTPUT_DIR / "reverify_run_state.json"
REVERIFY_LOGS_BY_DATE_DIR = OUTPUT_DIR / "reverify_logs_by_date"
ERROR_REPORT_PATH = OUTPUT_DIR / "reverify_error_report.json"
CONCURRENT_RUN_EXIT_CODE = 75

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

ROW_IDENTITY_FIELDS = [
    "ship_name",
    "ship_city",
    "ship_state",
    "ship_zip",
    "ship_care_of",
    "ship_address",
    "ship_address_unit",
    "ship_country",
    "ord_instruct",
]

FORCE_OVERWRITE_FIELDS = {
    "matched_name",
    "name_match_status",
    "date_verification_status",
    "date_verification_notes",
    "match_status",
    "ai_accuracy_score",
    "last_processed_at",
    "notes",
}


def normalize_match_status(value: str) -> str:
    normalized = _safe_str(value).strip().lower()
    if normalized in {"customer", "customer_defined", "customer-defined", "customer provided", "customer-provided", "instruction_only", "instruction-only"}:
        return "Customer"
    if normalized in {"found", "matched", "yes", "confirmed"}:
        return "Found"
    if normalized in {"review", "needs_review", "needs review", "uncertain", "unverified"}:
        return "Review"
    return "NotFound"


def _run_date_key() -> str:
    """Return YYYY-MM-DD for date-wise reverify storage."""
    return get_date_key()


def get_date_wise_output_path(filename: str, date_key: Optional[str] = None) -> Path:
    """Return the requested file path inside the date-wise folder."""
    key = date_key or _run_date_key()
    return DATE_WISE_DIR / key / filename


def load_dotenv_file(path=None):
    load_root_env(Path(path) if path is not None else None)


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"[{SCRIPT_NAME}] Missing required env var: {name}")
    return value


def _is_openai_model(model_name: str) -> bool:
    normalized = _safe_str(model_name).lower()
    return normalized.startswith("gpt-") or normalized.startswith("o")


def _normalize_reverify_provider(provider: Optional[str] = None) -> str:
    normalized = _safe_str(provider or REVERIFY_DEFAULT_PROVIDER).lower()
    return "openai" if normalized == "openai" else "perplexity"


def _provider_order() -> list[str]:
    primary = _normalize_reverify_provider()
    secondary = "openai" if primary == "perplexity" else "perplexity"
    return [primary, secondary]


def get_now_iso() -> str:
    return runtime_now_iso()


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


def _load_prompt_template() -> str:
    template_path = Path(os.getenv("FUNERAL_PROMPT_TEMPLATE", str(DEFAULT_PROMPT_TEMPLATE)))
    if not template_path.exists():
        return ""
    return template_path.read_text(encoding="utf-8")


def _partial_timing_note(service_date: str, service_time: str, visitation_date: str, visitation_time: str, ceremony_date: str, ceremony_time: str) -> str:
    dates_present = any(_safe_str(value) for value in [service_date, visitation_date, ceremony_date])
    times_present = any(_safe_str(value) for value in [service_time, visitation_time, ceremony_time])
    has_datetime_pair = bool((service_date and service_time) or (visitation_date and visitation_time) or (ceremony_date and ceremony_time))
    if has_datetime_pair:
        return ""
    if dates_present and not times_present:
        return "date-only"
    if times_present and not dates_present:
        return "time-only"
    if dates_present or times_present:
        return "partial-datetime"
    return ""


def get_reverify_daily_log_path(date_key: Optional[str] = None) -> Path:
    """Return daily processed log file path for reverify."""
    key = date_key or _run_date_key()
    return REVERIFY_LOGS_BY_DATE_DIR / f"reverify_processed_{key}.txt"


def ensure_reverify_log_files(date_key: Optional[str] = None) -> Path:
    """Ensure global and date-wise reverify log files exist."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    REVERIFY_LOGS_BY_DATE_DIR.mkdir(parents=True, exist_ok=True)
    get_date_wise_output_path("Funeral_data.csv", date_key).parent.mkdir(parents=True, exist_ok=True)

    if not LOGS_PATH.exists():
        LOGS_PATH.write_text("", encoding="utf-8")

    daily_log_path = get_reverify_daily_log_path(date_key)
    if not daily_log_path.exists():
        daily_log_path.write_text("", encoding="utf-8")
    return daily_log_path


def append_reverify_daily_log(order_id: str, status: str, source_name: str, date_key: Optional[str] = None):
    """Write timestamped reverify processing audit entries per day."""
    normalized_order_id = _normalize_order_id(order_id)
    if not normalized_order_id:
        return
    daily_log_path = get_reverify_daily_log_path(date_key)
    REVERIFY_LOGS_BY_DATE_DIR.mkdir(parents=True, exist_ok=True)
    with open(daily_log_path, "a", encoding="utf-8") as f:
        f.write(
            f"{get_now_iso()}\t{normalized_order_id}\t{_safe_str(status)}\t{_safe_str(source_name)}\n"
        )


def _safe_str(val) -> str:
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


def _normalize_order_id(value) -> str:
    order_id = _safe_str(value)
    if not order_id:
        return ""
    # Some CSV writers coerce numeric IDs to floats (e.g., 12345.0).
    if re.fullmatch(r"\d+\.0+", order_id):
        return order_id.split(".", 1)[0]
    return order_id


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
                    year_prefix = f"{current_year}/"
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


def _evaluate_date_verification(record: dict, parsed: dict) -> tuple[str, str]:
    parsed_date_values = _unique_non_empty(
        [
            _safe_str(parsed.get("service_date")),
            _safe_str(parsed.get("visitation_date")),
            _safe_str(parsed.get("ceremony_date")),
        ]
    )
    parsed_dates = _unique_non_empty([_parse_date_candidate(value) for value in parsed_date_values])
    if has_schedule_hint(parsed.get("special_instructions")):
        parsed_dates = _unique_non_empty([*parsed_dates, *_extract_dates_from_text(parsed.get("special_instructions"))])
    instruction_dates = _extract_dates_from_text(record.get("ord_instruct"))

    if instruction_dates and parsed_dates:
        if any(parsed_date in instruction_dates for parsed_date in parsed_dates):
            return "verified", f"Date verified against order instructions: {', '.join(parsed_dates)}"
        return "mismatch", f"Date mismatch: instructions={', '.join(instruction_dates)} source={', '.join(parsed_dates)}"

    if parsed_date_values and not parsed_dates:
        return "invalid", f"Date requires review: unable to normalize source date value(s) {', '.join(parsed_date_values)}"

    if parsed_dates:
        return "source_only", f"Date verified from source only: {', '.join(parsed_dates)}"

    if instruction_dates and has_schedule_hint(record.get("ord_instruct")):
        return "instruction_only", f"Date verified from order instructions: {', '.join(instruction_dates)}"

    if has_schedule_hint(record.get("ord_instruct")):
        return "instruction_only", "Schedule verified from order instructions without a fully normalized date"

    return "missing", "Date verification missing: no valid service date identified"


def _extract_json_from_text(text: str) -> dict:
    """Robust JSON extractor — use raw_decode to handle nested objects."""
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

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except (json.JSONDecodeError, ValueError):
            pass

    for pattern in [r"```json\s*(.*?)```", r"```\s*(.*?)```"]:
        match = re.search(pattern, text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(1).strip())
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


def parse_ai_response(ai_text: str) -> dict:
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
        # Unknown status should stay review-first to avoid false NotFound.
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
    notes_value = _safe_str(ai_data.get("notes") or ai_data.get("Summary") or ai_data.get("Status Justification"))

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

    has_datetime_pair = bool((service_date and service_time) or (visitation_date and visitation_time) or (ceremony_date and ceremony_time))
    timing_note = _partial_timing_note(service_date, service_time, visitation_date, visitation_time, ceremony_date, ceremony_time)
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
        notes_value = append_note(notes_value, timing_note)
    else:
        if evidence_count >= 1 or has_sources or funeral_home_name or funeral_address or funeral_phone or service_type:
            match_status = "Review"
            score = min(max(score, 55.0), 69.0)
        else:
            match_status = "NotFound"
            score = min(score, 49.0)

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


def load_logged_ids() -> set:
    if not LOGS_PATH.exists():
        return set()
    ids = set()
    with open(LOGS_PATH, "r", encoding="utf-8") as f:
        for line in f:
            oid = _normalize_order_id(line)
            if oid:
                ids.add(oid)
    return ids


def append_logged_id(order_id: str):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    normalized_order_id = _normalize_order_id(order_id)
    if not normalized_order_id:
        return
    with open(LOGS_PATH, "a", encoding="utf-8") as f:
        f.write(normalized_order_id + "\n")


def load_records(csv_path: Path) -> list:
    if not csv_path.exists():
        return []
    _, loaded_rows, encoding_used = _read_csv_dict_rows(csv_path)
    if encoding_used not in {"utf-8-sig", "utf-8"}:
        print(f"[{SCRIPT_NAME}] INFO: Read {csv_path.name} using {encoding_used} fallback")
    rows = []
    seen = set()
    for row_index, row in enumerate(loaded_rows, start=1):
        order_id = _normalize_order_id(row.get("order_id"))
        if not order_id or order_id in seen:
            continue
        seen.add(order_id)
        normalized_row = {field: _safe_str(row.get(field)) for field in FIELDNAMES}
        normalized_row["order_id"] = order_id
        normalized_row["_source_row_number"] = row_index
        rows.append(normalized_row)
    return rows


def load_latest_inquiry_order_ids(latest_count: int) -> set[str]:
    if latest_count <= 0 or not INPUT_CSV.exists():
        return set()
    _, rows, encoding_used = _read_csv_dict_rows(INPUT_CSV)
    if encoding_used not in {"utf-8-sig", "utf-8"}:
        print(f"[{SCRIPT_NAME}] INFO: Read {INPUT_CSV.name} using {encoding_used} fallback")

    normalized = []
    for row in rows:
        order_id = _normalize_order_id(row.get("order_id"))
        if not order_id:
            continue
        normalized.append({
            "order_id": order_id,
            "last_processed_at": _safe_str(row.get("last_processed_at")),
        })

    normalized.sort(
        key=lambda entry: _parse_iso_datetime(entry.get("last_processed_at")) or datetime.min,
        reverse=True,
    )
    latest_order_ids = []
    seen = set()
    for entry in normalized:
        order_id = entry["order_id"]
        if order_id in seen:
            continue
        seen.add(order_id)
        latest_order_ids.append(order_id)
        if len(latest_order_ids) >= latest_count:
            break
    return set(latest_order_ids)


def infer_latest_inquiry_batch_count() -> int:
    if not GET_ORDER_INQUIRY_LOGS_PATH.exists():
        return 0
    try:
        log_lines = GET_ORDER_INQUIRY_LOGS_PATH.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return 0

    for line in reversed(log_lines):
        saved_match = re.search(r"(?i)\bDONE\s*--\s*Saved:\s*(\d+)\b", line)
        if saved_match:
            return int(saved_match.group(1))
        compact_match = re.search(r"(?i)\bSaved:\s*(\d+)\s*\|\s*Skipped:", line)
        if compact_match:
            return int(compact_match.group(1))
    return 0


def filter_records_by_logged_ids(rows: list, logged_ids: set[str]) -> tuple[list, int]:
    filtered_rows = []
    skipped_count = 0
    for row in rows:
        order_id = _normalize_order_id(row.get("order_id"))
        if order_id and order_id in logged_ids:
            skipped_count += 1
            continue
        filtered_rows.append(row)
    return filtered_rows, skipped_count


def write_records(csv_path: Path, rows: list):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({field: _safe_str(row.get(field)) for field in FIELDNAMES})


def _coerce_row_number(value) -> Optional[int]:
    try:
        row_number = int(str(value).strip())
    except (AttributeError, TypeError, ValueError):
        return None
    return row_number if row_number > 0 else None


def _rows_share_identity(existing_row: dict, record: dict) -> bool:
    matched_fields = 0
    compared_fields = 0
    for field in ROW_IDENTITY_FIELDS:
        existing_value = _safe_str(existing_row.get(field))
        incoming_value = _safe_str(record.get(field))
        if not existing_value or not incoming_value:
            continue
        compared_fields += 1
        if existing_value != incoming_value:
            return False
        matched_fields += 1
    return matched_fields >= 2


def upsert_record(csv_path: Path, record: dict, row_number: Optional[int] = None):
    rows = load_records(csv_path)
    order_id = _normalize_order_id(record.get("order_id"))
    row_index_by_order_id = None

    for index, row in enumerate(rows):
        current_order_id = _normalize_order_id(row.get("order_id"))
        if current_order_id == order_id and row_index_by_order_id is None:
            row_index_by_order_id = index

    cleaned_record = {field: _safe_str(record.get(field)) for field in FIELDNAMES}
    cleaned_record["order_id"] = order_id
    if row_index_by_order_id is not None:
        next_rows = list(rows)
        merged_row = dict(next_rows[row_index_by_order_id])
        for key, value in cleaned_record.items():
            if key == "order_id" or key in FORCE_OVERWRITE_FIELDS or _safe_str(value):
                merged_row[key] = value
        next_rows[row_index_by_order_id] = merged_row
    else:
        next_rows = [*rows, cleaned_record]

    write_records(csv_path, next_rows)


def remove_record(csv_path: Path, order_id: str):
    rows = load_records(csv_path)
    normalized_target_order_id = _normalize_order_id(order_id)
    filtered = [
        row
        for row in rows
        if _normalize_order_id(row.get("order_id")) != normalized_target_order_id
    ]
    write_records(csv_path, filtered)


def remove_record_from_all_date_wise(order_id: str):
    if not DATE_WISE_DIR.exists():
        return
    filenames = [
        "Funeral_data.csv",
        "Funeral_data_customer.csv",
        "Funeral_data_found.csv",
        "Funeral_data_not_found.csv",
        "Funeral_data_review.csv",
    ]
    for date_dir in DATE_WISE_DIR.iterdir():
        if not date_dir.is_dir():
            continue
        for filename in filenames:
            remove_record(date_dir / filename, order_id)


def _run_guard_key() -> str:
    return datetime.now().date().isoformat()


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


def rebuild_excel_from_csv(csv_path: Path, excel_path: Path, sheet_name: str) -> None:
    if not OPENPYXL_AVAILABLE or not csv_path.exists():
        return
    excel_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fieldnames, rows, encoding_used = _read_csv_dict_rows(csv_path)
        if not fieldnames:
            fieldnames = list(FIELDNAMES)
        if encoding_used not in {"utf-8-sig", "utf-8"}:
            print(f"[{SCRIPT_NAME}] INFO: Rebuilt {excel_path.name} from {csv_path.name} using {encoding_used} fallback")

        workbook = openpyxl.Workbook()
        worksheet = workbook.active
        worksheet.title = sheet_name[:31] or "Sheet1"
        worksheet.append(list(fieldnames))
        for row in rows:
            worksheet.append([_safe_str(row.get(col, "")) for col in fieldnames])

        temp_excel_path = excel_path.with_name(f"{excel_path.stem}.tmp{excel_path.suffix}")
        workbook.save(temp_excel_path)
        temp_excel_path.replace(excel_path)
        _resolve_error_report(
            "excel_rebuild",
            {"csv_path": str(csv_path), "excel_path": str(excel_path), "rows": len(rows)},
        )
    except Exception as exc:
        _record_error_report(
            "excel_rebuild",
            str(exc),
            {"csv_path": str(csv_path), "excel_path": str(excel_path), "sheet_name": sheet_name},
        )
        print(f"[{SCRIPT_NAME}] WARNING: Excel rebuild skipped for {excel_path.name}: {exc}")


def append_main_record(record: dict, row_number: Optional[int] = None):
    upsert_record(MAIN_CSV_PATH, record, row_number=row_number)


def save_record_to_status_outputs(record: dict, status: str, date_key: Optional[str] = None):
    normalized_status = normalize_match_status(status)
    if normalized_status == "Customer":
        upsert_record(CUSTOMER_CSV_PATH, record)
        upsert_record(get_date_wise_output_path("Funeral_data_customer.csv", date_key), record)
        return

    if normalized_status == "Found":
        upsert_record(FOUND_CSV_PATH, record)
        upsert_record(get_date_wise_output_path("Funeral_data_found.csv", date_key), record)
        return

    if normalized_status == "Review":
        upsert_record(SOURCE_FILES["review"], record)
        upsert_record(get_date_wise_output_path("Funeral_data_review.csv", date_key), record)
        return

    upsert_record(SOURCE_FILES["not_found"], record)
    upsert_record(get_date_wise_output_path("Funeral_data_not_found.csv", date_key), record)


def append_note(existing: str, note: str) -> str:
    existing = _safe_str(existing)
    note = _safe_str(note)
    if not existing:
        return note
    if note in existing:
        return existing
    return f"{existing} | {note}"


def has_schedule_hint(text: str) -> bool:
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
    if not has_schedule_hint(instruction_text):
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


def destination_type(record: dict) -> str:
    destination_text = " ".join(
        [
            _safe_str(record.get("ship_care_of")),
            _safe_str(record.get("ship_address")),
            _safe_str(record.get("ord_instruct")),
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


def apply_business_rules(record: dict, parsed: dict) -> dict:
    adjusted = dict(parsed)
    notes = _safe_str(adjusted.get("notes"))
    customer_instructions = _safe_str(record.get("ord_instruct"))
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
    inferred_name = _infer_matched_name_from_sources(record.get("ship_name"), source_urls)
    current_name_status, _ = _classify_name_match(record.get("ship_name"), adjusted.get("matched_name"))
    inferred_name_status, _ = _classify_name_match(record.get("ship_name"), inferred_name)
    if _name_status_rank(inferred_name_status) > _name_status_rank(current_name_status):
        adjusted["matched_name"] = inferred_name

    has_obituary_url = any(_is_obituary_like_url(url) for url in source_urls)
    has_legacy_source = any("legacy.com" in str(url).lower() for url in source_urls)
    has_external_source_evidence = bool(source_urls or original_venue_evidence or original_timing_evidence)
    has_source_evidence = bool(
        _safe_str(adjusted.get("funeral_home_name"))
        or _safe_str(adjusted.get("funeral_address"))
        or _safe_str(adjusted.get("funeral_phone"))
        or _safe_str(adjusted.get("service_type"))
        or source_urls
    )

    if instruction_schedule:
        if not _safe_str(adjusted.get("matched_name")):
            adjusted["matched_name"] = _clean_ship_name_for_prompt(record.get("ship_name")) or "customer-provided schedule"

    name_match_status, name_match_note = _classify_name_match(
        record.get("ship_name"),
        adjusted.get("matched_name"),
    )
    if instruction_schedule and name_match_status in {"missing", "mismatch"} and not has_source_evidence:
        name_match_status = "exact"
        adjusted_name = _clean_ship_name_for_prompt(record.get("ship_name")) or "customer-provided schedule"
        name_match_note = f"Name verified from order instructions: {adjusted_name}"
        adjusted["matched_name"] = adjusted_name
    adjusted["name_match_status"] = name_match_status
    notes = append_note(notes, name_match_note)

    date_verification_status, date_verification_note = _evaluate_date_verification(record, adjusted)
    adjusted["date_verification_status"] = date_verification_status
    adjusted["date_verification_notes"] = date_verification_note
    notes = append_note(notes, date_verification_note)

    score = float(adjusted.get("ai_accuracy_score") or 0)
    instruction_has_schedule = bool(instruction_schedule)
    has_schedule_text = has_schedule_hint(adjusted.get("special_instructions"))
    has_confirmed_identity = name_match_status in {"exact", "minor", "fuzzy"}
    has_identity_anchor = has_confirmed_identity or instruction_has_schedule
    has_person_level_evidence = has_confirmed_identity or has_obituary_url or instruction_has_schedule

    if name_match_status == "mismatch" and (has_source_evidence or has_any_timing or instruction_has_schedule):
        adjusted["match_status"] = "Review"
        adjusted["ai_accuracy_score"] = min(max(score, 60.0), 84.0)
        notes = append_note(notes, "Review: source identity does not cleanly match requested deceased")
    elif date_verification_status == "mismatch":
        adjusted["match_status"] = "Review"
        adjusted["ai_accuracy_score"] = min(max(score, 60.0), 84.0)
        notes = append_note(notes, "Review: source date conflicts with customer instructions")
    elif (
        instruction_schedule
        and not has_external_source_evidence
        and date_verification_status in {"verified", "instruction_only"}
        and name_match_status in {"exact", "minor", "fuzzy"}
    ):
        adjusted["match_status"] = "Customer"
        adjusted["ai_accuracy_score"] = max(score, 72.0)
        notes = append_note(notes, "Customer: schedule normalized from order instructions because outside sources did not confirm it")
    elif date_verification_status in {"verified", "source_only"} and name_match_status in {"exact", "minor", "fuzzy"}:
        adjusted["match_status"] = "Found"
        adjusted["ai_accuracy_score"] = max(score, 85.0 if date_verification_status == "verified" else 80.0)
    elif date_verification_status == "instruction_only" and name_match_status in {"exact", "minor", "fuzzy"}:
        adjusted["match_status"] = "Customer"
        adjusted["ai_accuracy_score"] = max(score, 72.0)
        notes = append_note(notes, "Customer: schedule verified from order instructions because no reliable outside source was found")
    elif date_verification_status == "invalid":
        adjusted["match_status"] = "Review"
        adjusted["ai_accuracy_score"] = min(max(score, 55.0), 84.0)
    elif not has_person_level_evidence:
        adjusted["match_status"] = "NotFound"
        adjusted["ai_accuracy_score"] = min(score, 49.0)
        notes = append_note(notes, "NotFound: no valid obituary or person-level identity confirmation")
    elif not has_identity_anchor and has_source_evidence and not has_any_timing:
        adjusted["match_status"] = "NotFound"
        adjusted["ai_accuracy_score"] = min(score, 49.0)
        notes = append_note(notes, "NotFound: venue-level evidence exists but no valid person match was confirmed")
    elif has_obituary_url or has_legacy_source or has_source_evidence or has_any_timing or instruction_has_schedule or has_schedule_text:
        adjusted["match_status"] = "Review"
        adjusted["ai_accuracy_score"] = min(max(score, 55.0), 84.0)
        if has_obituary_url:
            notes = append_note(notes, "Review: obituary source found but validation is incomplete")
        elif has_source_evidence:
            notes = append_note(notes, "Review: venue or source evidence found but complete validation is pending")
    else:
        adjusted["match_status"] = "NotFound"
        adjusted["ai_accuracy_score"] = min(score, 49.0)
        notes = append_note(notes, "NotFound: no matching obituary, venue, or verified schedule evidence")

    if destination_type(record) == "non_funeral" and (adjusted.get("match_status") == "Found" or has_source_evidence or instruction_has_schedule or has_any_timing):
        adjusted["match_status"] = "Review"
        adjusted["ai_accuracy_score"] = min(float(adjusted.get("ai_accuracy_score") or 0), 84.0)
        notes = append_note(notes, "Review required: destination appears non-funeral location")

    if has_datetime_pair and adjusted.get("match_status") == "Review" and name_match_status in {"exact", "minor", "fuzzy"} and date_verification_status != "mismatch":
        adjusted["match_status"] = "Found"
        adjusted["ai_accuracy_score"] = max(float(adjusted.get("ai_accuracy_score") or 0), 85.0)

    adjusted["notes"] = notes
    return adjusted


def normalize_city(city: str) -> str:
    cleaned = re.sub(r"\s+", " ", _safe_str(city)).strip()
    cleaned = re.sub(r"[^A-Za-z0-9 ,.'-]", "", cleaned)
    return cleaned


NICKNAME_MAP = {
    "bill": "William",
    "bob": "Robert",
    "bobby": "Robert",
    "jim": "James",
    "jimmy": "James",
    "joe": "Joseph",
    "joey": "Joseph",
    "johnny": "John",
    "kate": "Katherine",
    "kathy": "Katherine",
    "liz": "Elizabeth",
    "beth": "Elizabeth",
    "mike": "Michael",
    "mickey": "Michael",
    "matt": "Matthew",
    "pat": "Patrick",
    "rick": "Richard",
    "rich": "Richard",
    "tom": "Thomas",
    "dick": "Richard",
    "sue": "Susan",
}


def expand_nickname(name: str) -> str:
    text = re.sub(r"\s+", " ", _safe_str(name)).strip()
    if not text:
        return text
    parts = text.split(" ")
    first = re.sub(r"[^A-Za-z]", "", parts[0]).lower()
    replacement = NICKNAME_MAP.get(first)
    if replacement:
        parts[0] = replacement
    return " ".join(parts)


def build_prompt(record: dict, strategy: str) -> str:
    lines = [f"Strategy: {strategy}", f"Name: {_clean_ship_name_for_prompt(record.get('ship_name', ''))}"]
    city = record.get("ship_city", "")
    state = record.get("ship_state", "")
    if strategy == "normalized_city":
        city = normalize_city(city)
    lines.append(f"City: {city}")
    if state:
        lines.append(f"State: {state}")
    if strategy == "state_only":
        lines.append(f"State-only search focus: {state}")
    if strategy == "expanded_nickname":
        lines.append(f"Expanded name: {expand_nickname(record.get('ship_name', ''))}")
    if record.get("ship_care_of"):
        lines.append(f"Care Of: {record.get('ship_care_of')}")
    if record.get("ord_instruct"):
        lines.append(f"Order Instructions: {record.get('ord_instruct')}")
    if strategy == "care_of" and record.get("ship_care_of"):
        lines.append(f"Primary clue: {record.get('ship_care_of')}")
    if strategy == "ord_instruct" and record.get("ord_instruct"):
        lines.append(f"Primary clue: {record.get('ord_instruct')}")

    context_block = "\n".join(line for line in lines if line)
    prompt_body = (
        "Search for funeral and memorial service details using the specific strategy below. "
        "Return valid JSON with keys: matched_name, funeral_home_name, funeral_address, funeral_phone, "
        "service_type, funeral_date, funeral_time, visitation_date, visitation_time, "
        "ceremony_date, ceremony_time, "
        "delivery_recommendation_date, delivery_recommendation_time, "
        "delivery_recommendation_location, special_instructions, "
        "status (Customer/Found/NotFound/Review), AI Accuracy Score (0-100 confidence for that status), source_urls (list), notes. "
        "Scoring guidance: 85-100 exact match with source URL and concrete service details; 70-84 strong match with URL and partial details; "
        "50-69 partial/uncertain; 0-49 weak or no reliable match. No source URL means score should usually be <=65 unless identity evidence is strong. "
        "For very common names without unique identifiers, keep score below 60. "
        "Always return the exact obituary or memorial permalink you relied on when one exists; do not return only a funeral-home directory or homepage if a deeper obituary URL is available. "
        "Return matched_name exactly as found on the obituary, funeral page, or customer-provided schedule you relied on. "
        "Set Customer when the only trustworthy timing evidence comes from customer order instructions and outside sources do not confirm the service details. "
        "If outside sources do not confirm the schedule but ord_instruct contains a usable funeral, memorial, visitation, viewing, burial, or ceremony schedule, normalize that customer-provided schedule into structured JSON fields and set status=Customer. "
        "When using ord_instruct fallback, preserve the requested person as matched_name, format the best available schedule fields, and explain in notes that the schedule came from customer instructions. "
        "Set Found when matched_name aligns with the input person and at least one valid date OR time exists in funeral/service, visitation, or ceremony fields together with identity confirmation (name + funeral home OR name + source URL). "
        "Set Review, not NotFound, for date-only/time-only evidence with identity confirmation. "
        "Set Review when names or dates conflict between source evidence and customer instructions. "
        "Set NotFound only when timing evidence is absent and identity confirmation is weak or missing. "
        "Do not use delivery recommendation fields as service datetime fallback.\n\n"
        f"{context_block}"
    )
    return prompt_body


def get_strategy_order(record: dict) -> list:
    strategy_names = [
        "original",
        "normalized_city",
        "expanded_nickname",
        "state_only",
        "care_of",
        "ord_instruct",
    ]
    return [(name, build_prompt(record, name)) for name in strategy_names]


def _build_search_api_request(provider: str, prompt: str, api_key_override: Optional[str] = None) -> Tuple[str, Dict, Dict]:
    normalized_provider = _normalize_reverify_provider(provider)
    model_name = OPENAI_MODEL if normalized_provider == "openai" else PERPLEXITY_MODEL
    system_content = (
        "You are an assistant that finds funeral and memorial service details. "
        "Return your findings in valid JSON format with these keys: matched_name, funeral_home_name, "
        "funeral_address, funeral_phone, service_type, funeral_date, funeral_time, "
        "visitation_date, visitation_time, ceremony_date, ceremony_time, delivery_recommendation_date, "
        "delivery_recommendation_time, delivery_recommendation_location, "
        "special_instructions, status (Customer/Found/NotFound/Review), AI Accuracy Score (0-100 confidence for status), "
        "source_urls (list), notes. Scoring guidance: 85-100 exact match with source URL and concrete service details; "
        "70-84 strong match with URL and partial details; 50-69 partial/uncertain; 0-49 weak or no reliable match. "
        "No source URL means score should usually be <=65 unless identity evidence is strong. For very common names without unique identifiers, keep score below 60. "
        "Always return the exact obituary or memorial permalink you relied on when one exists; do not return only a funeral-home directory or homepage if a deeper obituary URL is available. "
        "Return matched_name exactly as found on the obituary, funeral page, or customer-provided schedule you relied on. "
        "Set Customer when the only trustworthy timing evidence comes from customer order instructions and outside sources do not confirm the service details. "
        "If outside sources do not confirm the schedule but ord_instruct contains a usable funeral, memorial, visitation, viewing, burial, or ceremony schedule, normalize that customer-provided schedule into structured JSON fields and set status=Customer. "
        "When using ord_instruct fallback, preserve the requested person as matched_name, format the best available schedule fields, and explain in notes that the schedule came from customer instructions. "
        "Set Found when matched_name aligns with the input person and at least one valid date OR time exists in funeral/service, visitation, or ceremony fields together with identity confirmation (name + funeral home OR name + source URL). "
        "Set Review, not NotFound, for date-only/time-only evidence with identity confirmation. "
        "Set Review when names or dates conflict between source evidence and customer instructions. "
        "Set NotFound only when timing evidence is absent and identity confirmation is weak or missing. "
        "Do not use delivery recommendation fields as service datetime fallback."
    )
    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": system_content},
            {"role": "user", "content": prompt},
        ],
    }

    if normalized_provider == "openai":
        api_key = _safe_str(api_key_override) or _required_env("OPENAI_API_KEY")
        if "search" in model_name.lower():
            payload["web_search_options"] = {"search_context_size": "high"}
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        return OPENAI_URL, headers, payload

    api_key = _safe_str(api_key_override) or _required_env("PERPLEXITY_API_KEY")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    return PERPLEXITY_URL, headers, payload


def query_provider(provider: str, api_key: Optional[str] = None, prompt: Optional[str] = None) -> Tuple[str, Dict, Dict]:
    api_key_override = None
    if prompt is None:
        prompt_text = _safe_str(api_key)
    else:
        api_key_override = _safe_str(api_key)
        prompt_text = prompt

    request_url, headers, api_payload = _build_search_api_request(provider, prompt_text, api_key_override)

    response = requests.post(
        request_url,
        headers=headers,
        json=api_payload,
        timeout=TIMEOUT_SECONDS,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"API ERROR: {response.status_code} {response.text[:200]}")

    resp_json = response.json()
    ai_text = resp_json.get("choices", [{}])[0].get("message", {}).get("content", "")
    parsed = parse_ai_response(ai_text)
    merged_urls = _normalize_url_list(parsed.get("source_urls"), _collect_response_urls(resp_json, ai_text))
    if merged_urls:
        parsed["source_urls"] = " | ".join(merged_urls)
    return ai_text, parsed, api_payload


def query_perplexity(api_key: Optional[str] = None, prompt: Optional[str] = None) -> Tuple[str, Dict, Dict]:
    return query_provider(_normalize_reverify_provider(), api_key, prompt)


STATUS_PRIORITY = {
    "NotFound": 0,
    "Review": 1,
    "Customer": 2,
    "Found": 3,
}


def _result_sort_key(result: dict) -> tuple[int, float, int, int]:
    status = normalize_match_status(result.get("match_status") or "NotFound")
    score = float(result.get("ai_accuracy_score") or 0)
    source_count = len(_normalize_url_list(result.get("source_urls")))
    timing_count = sum(
        1
        for key in ("service_date", "service_time", "visitation_date", "visitation_time", "ceremony_date", "ceremony_time")
        if _safe_str(result.get(key))
    )
    return (
        STATUS_PRIORITY.get(status, 0),
        score,
        source_count,
        timing_count,
    )


def should_stop_reverify_attempts(result: Optional[dict]) -> bool:
    if not result:
        return False

    status = normalize_match_status(result.get("match_status") or "NotFound")
    score = float(result.get("ai_accuracy_score") or 0)
    source_urls = _normalize_url_list(result.get("source_urls"))
    has_source_evidence = bool(
        source_urls
        or _safe_str(result.get("funeral_home_name"))
        or _safe_str(result.get("funeral_address"))
        or _safe_str(result.get("funeral_phone"))
    )
    has_timing = any(
        _safe_str(result.get(key))
        for key in (
            "service_date",
            "service_time",
            "visitation_date",
            "visitation_time",
            "ceremony_date",
            "ceremony_time",
        )
    )
    date_status = _safe_str(result.get("date_verification_status")).lower()

    if status == "Found" and has_source_evidence and has_timing and score >= 85:
        return True
    if status == "Customer" and score >= 72 and date_status == "instruction_only":
        return True
    if status == "Review" and score >= 82 and (has_source_evidence or has_timing or date_status in {"mismatch", "invalid"}):
        return True
    return False


def process_record(api_key: Optional[Union[str, dict]] = None, record: Optional[dict] = None, max_attempts: int = 1) -> dict:
    api_key_override = None
    if record is None and isinstance(api_key, dict):
        record = api_key
        api_key = None
    elif record is None:
        record = {}
    else:
        api_key_override = _safe_str(api_key)

    strategies = get_strategy_order(record)
    attempt_limit = max(1, min(int(max_attempts or len(strategies)), len(strategies)))
    template_text = _load_prompt_template()
    attempts = []
    best = None
    provider_order = _provider_order()

    for strategy_name, _ in strategies[:attempt_limit]:
        prompt = build_prompt(record, strategy_name)
        if template_text:
            prompt = f"{template_text}\n\n{prompt}"
        strategy_best = None

        for provider_name in provider_order:
            try:
                if api_key_override:
                    ai_text, parsed, payload = query_provider(provider_name, api_key_override, prompt)
                else:
                    ai_text, parsed, payload = query_provider(provider_name, prompt)
                candidate = apply_business_rules(record, parsed)
                candidate["_strategy"] = strategy_name
                candidate["_provider"] = provider_name
                candidate["_business_rules_applied"] = True

                attempts.append({
                    "strategy": strategy_name,
                    "provider": provider_name,
                    "prompt": prompt,
                    "raw_ai_response": ai_text,
                    "parsed_result": candidate,
                    "sent": payload,
                })

                if strategy_best is None or _result_sort_key(candidate) > _result_sort_key(strategy_best):
                    strategy_best = candidate
            except Exception as exc:
                attempts.append({
                    "strategy": strategy_name,
                    "provider": provider_name,
                    "prompt": prompt,
                    "error": str(exc),
                })

        if strategy_best is not None and (best is None or _result_sort_key(strategy_best) > _result_sort_key(best)):
            best = strategy_best.copy()

        if should_stop_reverify_attempts(best):
            best["notes"] = append_note(
                best.get("notes"),
                f"reverified via strategy={strategy_name} provider={_safe_str(best.get('_provider'))}",
            )
            break

    if best is None:
        best = {
            "match_status": "NotFound",
            "ai_accuracy_score": 0,
            "notes": "NotFound: multi-strategy reverify search failed to find a valid person or obituary",
            "funeral_home_name": "",
            "funeral_address": "",
            "funeral_phone": "",
            "service_type": "",
            "service_date": "",
            "service_time": "",
            "visitation_date": "",
            "visitation_time": "",
            "ceremony_date": "",
            "ceremony_time": "",
            "delivery_recommendation_date": "",
            "delivery_recommendation_time": "",
            "delivery_recommendation_location": "",
            "special_instructions": "",
            "source_urls": "",
        }

    best["attempts"] = attempts
    return best


def update_record_for_result(record: dict, result: dict, source_name: str) -> dict:
    now = get_now_iso()
    updated = dict(record)
    for key, value in result.items():
        if key in FIELDNAMES and (key in FORCE_OVERWRITE_FIELDS or _safe_str(value)):
            updated[key] = value
    updated["last_processed_at"] = now

    status = normalize_match_status(result.get("match_status", "NotFound"))
    strategy_name = _safe_str(result.get("_strategy"))
    provider_name = _safe_str(result.get("_provider"))
    notes = _safe_str(result.get("notes"))
    if strategy_name:
        provider_suffix = f" provider={provider_name}" if provider_name else ""
        notes = append_note(notes, f"reverified via strategy={strategy_name}{provider_suffix}")
    updated["notes"] = notes
    updated["ai_accuracy_score"] = result.get("ai_accuracy_score", 0)
    updated["match_status"] = status
    return updated


def main():
    parser = argparse.ArgumentParser(description="Re-verify Funeral Finder output records")
    parser.add_argument("--source", choices=["both", "not_found", "review"], default=os.getenv("RUN_MODE", "both"),
                        help="Which source files to process")
    parser.add_argument("--force", action="store_true",
                        help="Ignore reverify_logs.txt and reprocess all order IDs")
    parser.add_argument("--limit", type=int, default=0,
                        help="Cap how many records to process (0 = unlimited)")
    parser.add_argument("--attempts", type=int, default=4,
                        help="How many strategies to try per record (1-6).")
    parser.add_argument("--latest-count", type=int, default=0,
                        help="Force reprocess only the newest N GetOrderInquiry rows by last_processed_at")
    args = parser.parse_args()

    load_dotenv_file()
    run_date_key = _run_date_key()
    latest_count = int(args.latest_count or 0)
    if latest_count <= 0 and not args.force:
        inferred_latest_count = infer_latest_inquiry_batch_count()
        if inferred_latest_count > 0:
            latest_count = inferred_latest_count
            print(f"[{SCRIPT_NAME}] Inferred latest-count={latest_count} from GetOrderInquiry logs")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    reverify_daily_log_path = ensure_reverify_log_files(run_date_key)
    previous_error_report = _load_error_report()
    if previous_error_report and not previous_error_report.get("resolved_at"):
        print(
            f"[{SCRIPT_NAME}] Previous error report loaded: "
            f"{_safe_str(previous_error_report.get('stage'))} -> {_safe_str(previous_error_report.get('message'))}"
        )
    run_guard = load_run_guard()
    current_guard_key = _run_guard_key()
    run_started_at = get_now_iso()
    if run_guard.get("run_key") == current_guard_key and run_guard.get("status") == "running":
        same_config = (
            _safe_str(run_guard.get("source")) == _safe_str(args.source)
            and int(run_guard.get("limit") or 0) == int(args.limit or 0)
            and bool(run_guard.get("force")) == bool(args.force)
            and int(run_guard.get("attempts") or 0) == int(args.attempts or 0)
            and int(run_guard.get("latest_count") or 0) == latest_count
        )
        guard_is_fresh = False
        started_at_text = _safe_str(run_guard.get("started_at"))
        started_dt = _parse_iso_datetime(started_at_text)
        if started_dt:
            current_dt = datetime.now(started_dt.tzinfo) if started_dt.tzinfo else datetime.now()
            age_seconds = (current_dt - started_dt).total_seconds()
            guard_is_fresh = age_seconds < 3 * 60 * 60
        guard_process_active = _is_process_active(run_guard.get("pid"))

        if same_config and guard_is_fresh and guard_process_active and not args.force:
            print(
                f"[{SCRIPT_NAME}] Another run with same config is active since {started_at_text}; "
                "skipping to avoid concurrent file updates."
            )
            raise SystemExit(CONCURRENT_RUN_EXIT_CODE)

        print(f"[{SCRIPT_NAME}] Previous run marker detected; proceeding with current run.")

    save_run_guard({
        "run_key": current_guard_key,
        "status": "running",
        "source": args.source,
        "attempts": args.attempts,
        "force": bool(args.force),
        "limit": args.limit,
        "latest_count": latest_count,
        "started_at": run_started_at,
        "pid": os.getpid(),
    })

    logged_ids = set() if args.force else load_logged_ids()
    processed = 0
    skipped_logged = 0
    customer_count = 0
    found_count = 0
    review_count = 0
    not_found_count = 0
    updated_main_count = 0

    source_order = ["not_found", "review"] if args.source == "both" else [args.source]
    source_rows = {name: load_records(path) for name, path in SOURCE_FILES.items()}

    if latest_count > 0:
        latest_order_ids = load_latest_inquiry_order_ids(latest_count)
        if latest_order_ids:
            for source_name in source_order:
                before = len(source_rows.get(source_name, []))
                source_rows[source_name] = [
                    row for row in source_rows.get(source_name, [])
                    if _normalize_order_id(row.get("order_id")) in latest_order_ids
                ]
                filtered = before - len(source_rows[source_name])
                if filtered > 0:
                    print(f"[{SCRIPT_NAME}] Latest-count filter removed {filtered} older rows from {source_name}")
            print(f"[{SCRIPT_NAME}] Latest window enabled – newest {latest_count} GetOrderInquiry rows will be reprocessed")
        else:
            print(f"[{SCRIPT_NAME}] Latest-count filter requested, but no GetOrderInquiry rows were available; skipping to avoid processing the full backlog")
            for source_name in source_order:
                source_rows[source_name] = []

    if not args.force:
        for source_name in source_order:
            rows = source_rows.get(source_name, [])
            filtered_rows, skipped_here = filter_records_by_logged_ids(rows, logged_ids)
            source_rows[source_name] = filtered_rows
            if skipped_here:
                skipped_logged += skipped_here
                print(f"[{SCRIPT_NAME}] Pre-filtered {skipped_here} already-processed IDs from {source_name}")

    progress_total = sum(len(source_rows.get(source_name, [])) for source_name in source_order)
    if args.limit > 0:
        progress_total = min(progress_total, int(args.limit))
    progress_total = max(0, int(progress_total))
    progress_completed = 0
    if progress_total > 0:
        print(f"REVERIFY_TOTAL|{progress_total}")

    stop_due_to_limit = False

    for source_name in source_order:
        source_path = SOURCE_FILES[source_name]
        rows = source_rows.get(source_name, [])
        if not rows:
            continue

        print(f"[{SCRIPT_NAME}] Processing {source_name} records from {source_path.name}")
        for row in rows:
            order_id = _normalize_order_id(row.get("order_id"))
            if not order_id:
                continue
            if order_id in logged_ids and not args.force:
                print(f"[{SCRIPT_NAME}] SKIP {order_id} (already logged)")
                skipped_logged += 1
                if progress_total > 0:
                    progress_completed = min(progress_total, progress_completed + 1)
                    print(f"REVERIFY_PROGRESS|{progress_completed}|{progress_total}")
                continue
            if args.limit > 0 and processed >= args.limit:
                print(f"[{SCRIPT_NAME}] Reached --limit={args.limit}; stopping early.")
                stop_due_to_limit = True
                break

            print(f"[{SCRIPT_NAME}] Checking {order_id} [{source_name}]")
            result = process_record(row, max_attempts=args.attempts)
            if not result.get("_business_rules_applied"):
                result = apply_business_rules(row, result)
            status = normalize_match_status(result.get("match_status", "NotFound"))
            updated = update_record_for_result(row, result, source_name)
            source_row_number = _coerce_row_number(row.get("_source_row_number"))

            # Keep the main file as the canonical superset of all processed records.
            append_main_record(updated, row_number=source_row_number)
            upsert_record(get_date_wise_output_path("Funeral_data.csv", run_date_key), updated)
            updated_main_count += 1

            payload_entry = {
                "source": source_name,
                "order_id": order_id,
                "original_record": row,
                "result": updated,
                "attempts": result.get("attempts", []),
                "timestamp": get_now_iso(),
            }
            if PAYLOAD_PATH.exists():
                try:
                    existing_payload = json.loads(PAYLOAD_PATH.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, ValueError):
                    existing_payload = {}
            else:
                existing_payload = {}
            existing_payload[order_id] = payload_entry
            PAYLOAD_PATH.write_text(json.dumps(existing_payload, indent=2, ensure_ascii=False), encoding="utf-8")
            remove_record_from_all_date_wise(order_id)

            if status == "Customer":
                remove_record(SOURCE_FILES["review"], order_id)
                remove_record(SOURCE_FILES["not_found"], order_id)
                remove_record(FOUND_CSV_PATH, order_id)
                save_record_to_status_outputs(updated, status, run_date_key)
                customer_count += 1
                print(f"[{SCRIPT_NAME}] CUSTOMER {order_id} -> moved to customer CSV")
            elif status == "Found":
                remove_record(source_path, order_id)
                other_source = "review" if source_name == "not_found" else "not_found"
                remove_record(SOURCE_FILES[other_source], order_id)
                remove_record(CUSTOMER_CSV_PATH, order_id)
                save_record_to_status_outputs(updated, status, run_date_key)
                found_count += 1
                print(f"[{SCRIPT_NAME}] FOUND {order_id} -> moved to main + found CSV")
            elif status == "Review":
                remove_record(SOURCE_FILES["not_found"], order_id)
                remove_record(FOUND_CSV_PATH, order_id)
                remove_record(CUSTOMER_CSV_PATH, order_id)
                save_record_to_status_outputs(updated, status, run_date_key)
                review_count += 1
                print(f"[{SCRIPT_NAME}] REVIEW {order_id} -> moved to review CSV")
            else:
                remove_record(SOURCE_FILES["review"], order_id)
                remove_record(FOUND_CSV_PATH, order_id)
                remove_record(CUSTOMER_CSV_PATH, order_id)
                save_record_to_status_outputs(updated, status, run_date_key)
                not_found_count += 1
                print(f"[{SCRIPT_NAME}] NOT FOUND {order_id} -> moved to not_found CSV")

            append_logged_id(order_id)
            append_reverify_daily_log(order_id, status, source_name, run_date_key)
            logged_ids.add(order_id)
            processed += 1
            if progress_total > 0:
                progress_completed = min(progress_total, progress_completed + 1)
                print(f"REVERIFY_PROGRESS|{progress_completed}|{progress_total}")

        if stop_due_to_limit:
            break

    print(f"[{SCRIPT_NAME}] Completed. Processed {processed} record(s).")
    save_run_guard({
        "run_key": current_guard_key,
        "status": "completed",
        "source": args.source,
        "force": bool(args.force),
        "limit": args.limit,
        "latest_count": latest_count,
        "started_at": run_started_at,
        "finished_at": get_now_iso(),
        "pid": os.getpid(),
        "processed": processed,
    })
    rebuild_excel_from_csv(MAIN_CSV_PATH, MAIN_EXCEL_PATH, "Funeral Data")
    rebuild_excel_from_csv(CUSTOMER_CSV_PATH, CUSTOMER_EXCEL_PATH, "Customer")
    rebuild_excel_from_csv(FOUND_CSV_PATH, FOUND_EXCEL_PATH, "Found")
    rebuild_excel_from_csv(SOURCE_FILES["not_found"], NOT_FOUND_EXCEL_PATH, "Not Found")
    rebuild_excel_from_csv(SOURCE_FILES["review"], REVIEW_EXCEL_PATH, "Review")
    print(
        f"[{SCRIPT_NAME}] RUN SUMMARY | "
        f"Customer={customer_count} | Found={found_count} | Review={review_count} | NotFound={not_found_count} | "
        f"UpdatedMain={updated_main_count} | SkippedLogged={skipped_logged}"
    )
    print(f"[{SCRIPT_NAME}] Reverify logs file: {LOGS_PATH}")
    print(f"[{SCRIPT_NAME}] Reverify date-wise log: {reverify_daily_log_path}")


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
