#!/usr/bin/env python3
"""Re-verify Funeral Finder output records with multi-strategy Perplexity queries."""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

import requests

if os.name == "nt":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)

PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions"
TIMEOUT_SECONDS = 120
SCRIPT_NAME = "Reverify"
SCRIPTS_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = SCRIPTS_DIR / "outputs" / "Funeral_Finder"

SOURCE_FILES = {
    "not_found": OUTPUT_DIR / "Funeral_data_not_found.csv",
    "review": OUTPUT_DIR / "Funeral_data_review.csv",
}
MAIN_CSV_PATH = OUTPUT_DIR / "Funeral_data.csv"
PAYLOAD_PATH = OUTPUT_DIR / "reverify_payload.json"
LOGS_PATH = OUTPUT_DIR / "reverify_logs.txt"

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
            key = key.strip()
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
    if val is None:
        return ""
    return str(val).strip()


def _extract_json_from_text(text: str) -> dict:
    """Robust JSON extractor — 3 strategies, returns largest valid object."""
    if not text:
        return {}

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
            ai_data.get("funeral_date") or ai_data.get("Funeral date") or
            ai_data.get("service_date") or
            ai_data.get("funeral_time") or ai_data.get("Funeral time") or ai_data.get("service_time") or
            ai_data.get("funeral_address") or ai_data.get("Service location") or
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
        "funeral_home_name": _safe_str(ai_data.get("funeral_home_name") or ai_data.get("Funeral home name (optional)")),
        "funeral_address": _safe_str(ai_data.get("funeral_address") or ai_data.get("Service location")),
        "funeral_phone": _safe_str(ai_data.get("funeral_phone") or ai_data.get("Phone number")),
        "service_type": _safe_str(ai_data.get("service_type") or ai_data.get("Venue type")),
        "service_date": _safe_str(ai_data.get("funeral_date") or ai_data.get("Funeral date")),
        "service_time": _safe_str(ai_data.get("funeral_time") or ai_data.get("Funeral time")),
        "visitation_date": _safe_str(ai_data.get("visitation_date") or ai_data.get("Visitation date")),
        "visitation_time": _safe_str(ai_data.get("visitation_time") or ai_data.get("Visitation time")),
        "delivery_recommendation_date": _safe_str(ai_data.get("delivery_recommendation_date") or ai_data.get("OPTIMAL DELIVERY DATE")),
        "delivery_recommendation_time": _safe_str(ai_data.get("delivery_recommendation_time") or ai_data.get("OPTIMAL DELIVERY TIME")),
        "delivery_recommendation_location": _safe_str(ai_data.get("delivery_recommendation_location") or ai_data.get("DELIVER TO")),
        "special_instructions": _safe_str(ai_data.get("special_instructions") or ai_data.get("SPECIAL INSTRUCTIONS")),
        "match_status": match_status,
        "ai_accuracy_score": score,
        "source_urls": source_urls,
        "notes": _safe_str(ai_data.get("notes") or ai_data.get("Summary") or ai_data.get("Status Justification")),
    }


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


def load_records(csv_path: Path) -> list:
    if not csv_path.exists():
        return []
    with open(csv_path, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = []
        seen = set()
        for row in reader:
            order_id = _safe_str(row.get("order_id"))
            if not order_id or order_id in seen:
                continue
            seen.add(order_id)
            rows.append({field: _safe_str(row.get(field)) for field in FIELDNAMES})
        return rows


def write_records(csv_path: Path, rows: list):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({field: _safe_str(row.get(field)) for field in FIELDNAMES})


def upsert_record(csv_path: Path, record: dict):
    rows = load_records(csv_path)
    order_id = _safe_str(record.get("order_id"))
    replaced = False
    next_rows = []
    for row in rows:
        if _safe_str(row.get("order_id")) == order_id:
            next_rows.append({**row, **record})
            replaced = True
        else:
            next_rows.append(row)
    if not replaced:
        next_rows.append(record)
    write_records(csv_path, next_rows)


def remove_record(csv_path: Path, order_id: str):
    rows = load_records(csv_path)
    filtered = [row for row in rows if _safe_str(row.get("order_id")) != order_id]
    write_records(csv_path, filtered)


def append_main_record(record: dict):
    upsert_record(MAIN_CSV_PATH, record)


def append_note(existing: str, note: str) -> str:
    existing = _safe_str(existing)
    note = _safe_str(note)
    if not existing:
        return note
    if note in existing:
        return existing
    return f"{existing} | {note}"


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
    lines = [f"Strategy: {strategy}", f"Name: {record.get('ship_name', '')}"]
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
    return (
        "Search for funeral and memorial service details using the specific strategy below. "
        "Return valid JSON with keys: funeral_home_name, funeral_address, funeral_phone, "
        "service_type, funeral_date, funeral_time, visitation_date, visitation_time, "
        "delivery_recommendation_date, delivery_recommendation_time, "
        "delivery_recommendation_location, special_instructions, "
        "status (Found/NotFound/Review), AI Accuracy Score (0-100), source_urls (list), notes.\n\n"
        f"{context_block}"
    )


def get_strategy_order(record: dict) -> list:
    strategy_names = ["original"]
    if _safe_str(record.get("ship_care_of")):
        strategy_names.append("care_of")
    else:
        strategy_names.append("normalized_city")

    if _safe_str(record.get("ord_instruct")):
        strategy_names.append("ord_instruct")
    else:
        strategy_names.append("expanded_nickname")

    return [(name, build_prompt(record, name)) for name in strategy_names]


def score_rank(status: str, score: float) -> tuple:
    order = {"Found": 3, "Review": 2, "NotFound": 1}.get(status, 0)
    return order, float(score or 0)


def query_perplexity(api_key: str, prompt: str) -> tuple[str, dict, dict]:
    api_payload = {
        "model": "sonar-pro",
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are an assistant that finds funeral and memorial service details. "
                    "Return your findings in valid JSON format with these keys: funeral_home_name, "
                    "funeral_address, funeral_phone, service_type, funeral_date, funeral_time, "
                    "visitation_date, visitation_time, delivery_recommendation_date, "
                    "delivery_recommendation_time, delivery_recommendation_location, "
                    "special_instructions, status (Found/NotFound/Review), AI Accuracy Score (0-100), "
                    "source_urls (list), notes."
                ),
            },
            {"role": "user", "content": prompt},
        ],
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    response = requests.post(
        PERPLEXITY_URL,
        headers=headers,
        json=api_payload,
        timeout=TIMEOUT_SECONDS,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"API ERROR: {response.status_code} {response.text[:200]}")

    resp_json = response.json()
    ai_text = resp_json.get("choices", [{}])[0].get("message", {}).get("content", "")
    parsed = parse_ai_response(ai_text)
    return ai_text, parsed, api_payload


def process_record(api_key: str, record: dict, max_attempts: int = 3) -> dict:
    strategies = get_strategy_order(record)
    attempts = []
    best = None

    for strategy_name, prompt in strategies:
        if len(attempts) >= max_attempts:
            break
        try:
            ai_text, parsed, payload = query_perplexity(api_key, prompt)
            attempts.append({
                "strategy": strategy_name,
                "prompt": prompt,
                "raw_ai_response": ai_text,
                "parsed_result": parsed,
                "sent": payload,
            })
            candidate = parsed.copy()
            candidate["_strategy"] = strategy_name
            if best is None or score_rank(candidate["match_status"], candidate["ai_accuracy_score"]) > score_rank(best["match_status"], best["ai_accuracy_score"]):
                best = candidate
        except Exception as exc:
            attempts.append({
                "strategy": strategy_name,
                "prompt": prompt,
                "error": str(exc),
            })

    if best is None:
        best = {
            "match_status": "Review",
            "ai_accuracy_score": 0,
            "notes": "All reverify strategies failed",
            "funeral_home_name": "",
            "funeral_address": "",
            "funeral_phone": "",
            "service_type": "",
            "service_date": "",
            "service_time": "",
            "visitation_date": "",
            "visitation_time": "",
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
    updated.update({k: v for k, v in result.items() if k in FIELDNAMES})
    updated["last_processed_at"] = now

    status = result.get("match_status", "NotFound")
    note_suffix = f"Reverify {now} [{source_name}] -> {status} ({result.get('_strategy', 'n/a')})"
    updated["notes"] = append_note(record.get("notes", ""), note_suffix)
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
    parser.add_argument("--attempts", type=int, default=3,
                        help="Max API attempts per record (recommended: 2 or 3)")
    args = parser.parse_args()

    if args.attempts < 2:
        raise SystemExit(f"[{SCRIPT_NAME}] --attempts must be in range 2..3")
    if args.attempts > 3:
        print(f"[{SCRIPT_NAME}] --attempts capped at 3 to avoid excessive retries")
        args.attempts = 3

    load_dotenv_file()
    api_key = _required_env("PERPLEXITY_API_KEY")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    logged_ids = set() if args.force else load_logged_ids()
    processed = 0

    source_order = ["not_found", "review"] if args.source == "both" else [args.source]
    source_rows = {name: load_records(path) for name, path in SOURCE_FILES.items()}

    for source_name in source_order:
        source_path = SOURCE_FILES[source_name]
        rows = source_rows.get(source_name, [])
        if not rows:
            continue

        print(f"[{SCRIPT_NAME}] Processing {source_name} records from {source_path.name}")
        for row in rows:
            order_id = _safe_str(row.get("order_id"))
            if not order_id:
                continue
            if order_id in logged_ids and not args.force:
                print(f"[{SCRIPT_NAME}] SKIP {order_id} (already logged)")
                continue
            if args.limit > 0 and processed >= args.limit:
                print(f"[{SCRIPT_NAME}] Reached --limit={args.limit}; stopping early.")
                return

            print(f"[{SCRIPT_NAME}] Checking {order_id} [{source_name}]")
            result = process_record(api_key, row, max_attempts=args.attempts)
            status = result.get("match_status", "NotFound")
            updated = update_record_for_result(row, result, source_name)

            # Keep the main file as the canonical superset of all processed records.
            append_main_record(updated)

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

            if status == "Found":
                remove_record(source_path, order_id)
                other_source = "review" if source_name == "not_found" else "not_found"
                remove_record(SOURCE_FILES[other_source], order_id)
                print(f"[{SCRIPT_NAME}] FOUND {order_id} -> moved to main CSV")
            elif status == "Review":
                remove_record(SOURCE_FILES["not_found"], order_id)
                upsert_record(SOURCE_FILES["review"], updated)
                print(f"[{SCRIPT_NAME}] REVIEW {order_id} -> moved to review CSV")
            else:
                remove_record(SOURCE_FILES["review"], order_id)
                upsert_record(SOURCE_FILES["not_found"], updated)
                print(f"[{SCRIPT_NAME}] NOT FOUND {order_id} -> moved to not_found CSV")

            append_logged_id(order_id)
            logged_ids.add(order_id)
            processed += 1

    print(f"[{SCRIPT_NAME}] Completed. Processed {processed} record(s).")


if __name__ == "__main__":
    main()