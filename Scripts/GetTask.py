<<<<<<< HEAD
import csv
import json
import os
from pathlib import Path

import requests

TIMEOUT_SECONDS = 60


def load_dotenv_file(path=".env"):
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


def _required_env(name):
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def _to_json_text(data):
    """Convert values for CSV cells without dropping nested data."""
    if isinstance(data, (dict, list)):
        return json.dumps(data, ensure_ascii=False)
    return data


def _normalize_for_csv(payload):
    """
    Return a list of row dicts suitable for csv.DictWriter.
    Adds a __raw_json column per row so no content is lost in CSV export.
    """
    if isinstance(payload, list):
        rows = []
        for item in payload:
            if isinstance(item, dict):
                row = {k: _to_json_text(v) for k, v in item.items()}
                row["__raw_json"] = json.dumps(item, ensure_ascii=False)
                rows.append(row)
            else:
                rows.append(
                    {
                        "value": _to_json_text(item),
                        "__raw_json": json.dumps(item, ensure_ascii=False),
                    }
                )
        return rows

    if isinstance(payload, dict):
        row = {k: _to_json_text(v) for k, v in payload.items()}
        row["__raw_json"] = json.dumps(payload, ensure_ascii=False)
        return [row]

    return [
        {
            "value": _to_json_text(payload),
            "__raw_json": json.dumps(payload, ensure_ascii=False),
        }
    ]


def _normalized_url(raw_url):
    """Fix known malformed endpoint pattern from copied API URL."""
    return raw_url.replace(":8061api/", ":8061/api/")


def _load_existing_ord_ids(csv_path):
    """Load existing ord_ID values from cumulative CSV."""
    if not csv_path.exists():
        return set()

    existing = set()
    with csv_path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            value = str(row.get("ord_ID") or "").strip()
            if value:
                existing.add(value)
    return existing


def _dedupe_by_ord_id(payload, existing_ord_ids):
    """Return (new_records, total_received, duplicates_skipped)."""
    if not isinstance(payload, list):
        return payload, 1, 0

    total_received = len(payload)
    duplicates_skipped = 0
    new_records = []

    for item in payload:
        if not isinstance(item, dict):
            new_records.append(item)
            continue

        ord_id = str(item.get("ord_ID") or "").strip()
        if ord_id and ord_id in existing_ord_ids:
            duplicates_skipped += 1
            continue

        if ord_id:
            existing_ord_ids.add(ord_id)
        new_records.append(item)

    return new_records, total_received, duplicates_skipped


def _append_jsonl(jsonl_path, records):
    if not isinstance(records, list) or not records:
        return
    with jsonl_path.open("a", encoding="utf-8") as f:
        for item in records:
            f.write(json.dumps(item, ensure_ascii=False))
            f.write("\n")


def _append_json_array(json_path, records):
    if not isinstance(records, list) or not records:
        return

    existing = []
    if json_path.exists():
        try:
            with json_path.open("r", encoding="utf-8") as f:
                parsed = json.load(f)
            if isinstance(parsed, list):
                existing = parsed
        except Exception:
            existing = []

    existing.extend(records)
    with json_path.open("w", encoding="utf-8") as f:
        json.dump(existing, f, ensure_ascii=False, indent=2)


def _write_log(log_path, total_received, new_count, duplicates_skipped):
    line = (
        f"total_received={total_received} | "
        f"new_appended={new_count} | "
        f"duplicates_skipped={duplicates_skipped}\n"
    )
    with log_path.open("a", encoding="utf-8") as f:
        f.write(line)


def _append_csv(csv_path, rows):
    if not rows:
        return

    file_exists = csv_path.exists()
    if file_exists:
        with csv_path.open("r", newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            header = next(reader, None)
        fieldnames = header or list(rows[0].keys())
    else:
        fieldnames = []
        for row in rows:
            for key in row.keys():
                if key not in fieldnames:
                    fieldnames.append(key)

    with csv_path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        if not file_exists:
            writer.writeheader()
        writer.writerows(rows)


def main():
    load_dotenv_file()

    raw_api_url = _required_env("API_URL_TASK_OPENED")
    task_subject = _required_env("TASK_SUBJECT")
    api_key_header = _required_env("API_KEY_HEADER")
    api_key_value = _required_env("API_KEY_VALUE")

    headers = {api_key_header: api_key_value}
    request_url = _normalized_url(raw_api_url).split("?")[0]
    params = {"trsubject": task_subject}

    print("Request URL:", request_url)
    print("Request Params:")
    print(json.dumps(params, indent=2))
    print("Request Headers:")
    print(json.dumps(headers, indent=2))

    response = requests.get(
        request_url,
        params=params,
        headers=headers,
        timeout=TIMEOUT_SECONDS,
    )

    print("\nHTTP Status:", response.status_code)
    print("Final Request URL Sent:", response.url)
    print("\nRaw API Response (exact text):")
    print(response.text)

    response.raise_for_status()

    cumulative_csv_path = Path(os.getenv("TASK_OPENED_OUTPUT_CSV", "outputs/GetTask/Tasks_OrderID.csv").strip())
    cumulative_json_path = Path(os.getenv("TASK_OPENED_OUTPUT_JSON", "outputs/GetTask/Tasks_OrderID.json").strip())
    log_path = Path(os.getenv("TASK_OPENED_OUTPUT_LOG", "outputs/GetTask/Tasks_OrderID.log").strip())

    cumulative_csv_path.parent.mkdir(parents=True, exist_ok=True)
    cumulative_json_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        payload = response.json()
    except json.JSONDecodeError:
        payload = response.text

    existing_ord_ids = _load_existing_ord_ids(cumulative_csv_path)
    deduped_payload, total_received, duplicates_skipped = _dedupe_by_ord_id(payload, existing_ord_ids)

    new_count = len(deduped_payload) if isinstance(deduped_payload, list) else (1 if deduped_payload else 0)

    print("\nFormatted API Response (line-by-line):")
    if isinstance(deduped_payload, (list, dict)):
        print(json.dumps(deduped_payload, indent=2, ensure_ascii=False))
    else:
        print(deduped_payload)

    rows = _normalize_for_csv(deduped_payload)

    if isinstance(deduped_payload, list) and deduped_payload:
        _append_json_array(cumulative_json_path, deduped_payload)
    if rows:
        _append_csv(cumulative_csv_path, rows)

    _write_log(log_path, total_received, new_count, duplicates_skipped)

    print("\nRun summary:")
    print(f"Total records received: {total_received}")
    print(f"New records appended: {new_count}")
    print(f"Duplicate records skipped: {duplicates_skipped}")

    print("\nSaved files:")
    print(str(cumulative_csv_path))
    print(str(cumulative_json_path))
    print(str(log_path))


if __name__ == "__main__":
    main()
=======
import csv
import json
import os
from pathlib import Path

import requests

TIMEOUT_SECONDS = 60


def load_dotenv_file(path=".env"):
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


def _required_env(name):
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def _to_json_text(data):
    """Convert values for CSV cells without dropping nested data."""
    if isinstance(data, (dict, list)):
        return json.dumps(data, ensure_ascii=False)
    return data


def _normalize_for_csv(payload):
    """
    Return a list of row dicts suitable for csv.DictWriter.
    Adds a __raw_json column per row so no content is lost in CSV export.
    """
    if isinstance(payload, list):
        rows = []
        for item in payload:
            if isinstance(item, dict):
                row = {k: _to_json_text(v) for k, v in item.items()}
                row["__raw_json"] = json.dumps(item, ensure_ascii=False)
                rows.append(row)
            else:
                rows.append(
                    {
                        "value": _to_json_text(item),
                        "__raw_json": json.dumps(item, ensure_ascii=False),
                    }
                )
        return rows

    if isinstance(payload, dict):
        row = {k: _to_json_text(v) for k, v in payload.items()}
        row["__raw_json"] = json.dumps(payload, ensure_ascii=False)
        return [row]

    return [
        {
            "value": _to_json_text(payload),
            "__raw_json": json.dumps(payload, ensure_ascii=False),
        }
    ]


def _normalized_url(raw_url):
    """Fix known malformed endpoint pattern from copied API URL."""
    return raw_url.replace(":8061api/", ":8061/api/")


def _load_existing_ord_ids(csv_path):
    """Load existing ord_ID values from cumulative CSV."""
    if not csv_path.exists():
        return set()

    existing = set()
    with csv_path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            value = str(row.get("ord_ID") or "").strip()
            if value:
                existing.add(value)
    return existing


def _dedupe_by_ord_id(payload, existing_ord_ids):
    """Return (new_records, total_received, duplicates_skipped)."""
    if not isinstance(payload, list):
        return payload, 1, 0

    total_received = len(payload)
    duplicates_skipped = 0
    new_records = []

    for item in payload:
        if not isinstance(item, dict):
            new_records.append(item)
            continue

        ord_id = str(item.get("ord_ID") or "").strip()
        if ord_id and ord_id in existing_ord_ids:
            duplicates_skipped += 1
            continue

        if ord_id:
            existing_ord_ids.add(ord_id)
        new_records.append(item)

    return new_records, total_received, duplicates_skipped


def _append_jsonl(jsonl_path, records):
    if not isinstance(records, list) or not records:
        return
    with jsonl_path.open("a", encoding="utf-8") as f:
        for item in records:
            f.write(json.dumps(item, ensure_ascii=False))
            f.write("\n")


def _append_json_array(json_path, records):
    if not isinstance(records, list) or not records:
        return

    existing = []
    if json_path.exists():
        try:
            with json_path.open("r", encoding="utf-8") as f:
                parsed = json.load(f)
            if isinstance(parsed, list):
                existing = parsed
        except Exception:
            existing = []

    existing.extend(records)
    with json_path.open("w", encoding="utf-8") as f:
        json.dump(existing, f, ensure_ascii=False, indent=2)


def _write_log(log_path, total_received, new_count, duplicates_skipped):
    line = (
        f"total_received={total_received} | "
        f"new_appended={new_count} | "
        f"duplicates_skipped={duplicates_skipped}\n"
    )
    with log_path.open("a", encoding="utf-8") as f:
        f.write(line)


def _append_csv(csv_path, rows):
    if not rows:
        return

    file_exists = csv_path.exists()
    if file_exists:
        with csv_path.open("r", newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            header = next(reader, None)
        fieldnames = header or list(rows[0].keys())
    else:
        fieldnames = []
        for row in rows:
            for key in row.keys():
                if key not in fieldnames:
                    fieldnames.append(key)

    with csv_path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        if not file_exists:
            writer.writeheader()
        writer.writerows(rows)


def main():
    load_dotenv_file()

    raw_api_url = _required_env("API_URL_TASK_OPENED")
    task_subject = _required_env("TASK_SUBJECT")
    api_key_header = _required_env("API_KEY_HEADER")
    api_key_value = _required_env("API_KEY_VALUE")

    headers = {api_key_header: api_key_value}
    request_url = _normalized_url(raw_api_url).split("?")[0]
    params = {"trsubject": task_subject}

    print("Request URL:", request_url)
    print("Request Params:")
    print(json.dumps(params, indent=2))
    print("Request Headers:")
    print(json.dumps(headers, indent=2))

    response = requests.get(
        request_url,
        params=params,
        headers=headers,
        timeout=TIMEOUT_SECONDS,
    )

    print("\nHTTP Status:", response.status_code)
    print("Final Request URL Sent:", response.url)
    print("\nRaw API Response (exact text):")
    print(response.text)

    response.raise_for_status()

    cumulative_csv_path = Path(os.getenv("TASK_OPENED_OUTPUT_CSV", "outputs/GetTask/Tasks_OrderID.csv").strip())
    cumulative_json_path = Path(os.getenv("TASK_OPENED_OUTPUT_JSON", "outputs/GetTask/Tasks_OrderID.json").strip())
    log_path = Path(os.getenv("TASK_OPENED_OUTPUT_LOG", "outputs/GetTask/Tasks_OrderID.log").strip())

    cumulative_csv_path.parent.mkdir(parents=True, exist_ok=True)
    cumulative_json_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        payload = response.json()
    except json.JSONDecodeError:
        payload = response.text

    existing_ord_ids = _load_existing_ord_ids(cumulative_csv_path)
    deduped_payload, total_received, duplicates_skipped = _dedupe_by_ord_id(payload, existing_ord_ids)

    new_count = len(deduped_payload) if isinstance(deduped_payload, list) else (1 if deduped_payload else 0)

    print("\nFormatted API Response (line-by-line):")
    if isinstance(deduped_payload, (list, dict)):
        print(json.dumps(deduped_payload, indent=2, ensure_ascii=False))
    else:
        print(deduped_payload)

    rows = _normalize_for_csv(deduped_payload)

    if isinstance(deduped_payload, list) and deduped_payload:
        _append_json_array(cumulative_json_path, deduped_payload)
    if rows:
        _append_csv(cumulative_csv_path, rows)

    _write_log(log_path, total_received, new_count, duplicates_skipped)

    print("\nRun summary:")
    print(f"Total records received: {total_received}")
    print(f"New records appended: {new_count}")
    print(f"Duplicate records skipped: {duplicates_skipped}")

    print("\nSaved files:")
    print(str(cumulative_csv_path))
    print(str(cumulative_json_path))
    print(str(log_path))


if __name__ == "__main__":
    main()
>>>>>>> ac78c6fd6892d49e2932651256c992372a8fedeb
