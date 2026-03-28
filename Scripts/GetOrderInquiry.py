<<<<<<< HEAD
import csv
import json
import os
from pathlib import Path
from datetime import datetime, timezone

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


def _resolve_path(raw_value, default_value):
    value = (raw_value or default_value or "").strip()
    path = Path(value)
    return path


def _normalize_order_inquiry_base(url):
    cleaned = url.strip().rstrip("/")
    if cleaned.split("/")[-1].isdigit():
        return "/".join(cleaned.split("/")[:-1])
    return cleaned


def _extract_order_id(item):
    if not isinstance(item, dict):
        return ""
    candidate = item.get("ord_ID")
    if candidate in (None, ""):
        candidate = item.get("ord_id")
    return str(candidate or "").strip()


def _load_order_ids_from_source(source_path):
    suffix = source_path.suffix.lower()
    seen = set()
    unique_ids = []
    duplicates_in_source = 0

    if suffix == ".csv":
        with source_path.open("r", newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                order_id = _extract_order_id(row)
                if not order_id:
                    continue
                if order_id in seen:
                    duplicates_in_source += 1
                    continue
                seen.add(order_id)
                unique_ids.append(order_id)
    elif suffix == ".json":
        with source_path.open("r", encoding="utf-8") as f:
            payload = json.load(f)
        records = payload if isinstance(payload, list) else [payload]
        for item in records:
            order_id = _extract_order_id(item)
            if not order_id:
                continue
            if order_id in seen:
                duplicates_in_source += 1
                continue
            seen.add(order_id)
            unique_ids.append(order_id)
    else:
        raise SystemExit("ORDER_INQUIRY_SOURCE_PATH must be a .csv or .json file")

    return unique_ids, duplicates_in_source


def _load_existing_order_ids(csv_path):
    if not csv_path.exists():
        return set()
    existing = set()
    with csv_path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            order_id = _extract_order_id(row)
            if order_id:
                existing.add(order_id)
    return existing


def _to_json_text(data):
    if isinstance(data, (dict, list)):
        return json.dumps(data, ensure_ascii=False)
    return data


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


def _append_json_array(json_path, records):
    if not records:
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


def _write_log(log_path, line):
    with log_path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def _utc_now_iso():
    return datetime.now(timezone.utc).isoformat()


def _print_clean_record_preview(order_id, payload):
    if not isinstance(payload, dict):
        print(f"ord_ID: {order_id}")
        print(f"payload_type: {type(payload).__name__}")
        return

    print(f"ord_ID: {order_id}")
    print(f"status: {payload.get('fStatus', 'unknown')}")
    print(f"ship_name: {payload.get('ship_Name', '')}")
    print(f"ship_city: {payload.get('ship_City', '')}")
    print(f"ship_state: {payload.get('ship_State', '')}")
    print(f"ship_zip: {payload.get('ship_Zip', '')}")
    print(f"occasion: {payload.get('ord_Occasion', '')}")


def main():
    load_dotenv_file()

    api_base = _normalize_order_inquiry_base(_required_env("API_URL_ORDER_INQUIRY"))
    api_key_header = _required_env("API_KEY_HEADER")
    api_key_value = _required_env("API_KEY_VALUE")

    source_path = _resolve_path(os.getenv("ORDER_INQUIRY_SOURCE_PATH"), "outputs/GetTask/Tasks_OrderID.csv")
    csv_path = _resolve_path(os.getenv("ORDER_INQUIRY_OUTPUT_CSV"), "outputs/GetOrderInquiry/OrderInquiry.csv")
    json_path = _resolve_path(os.getenv("ORDER_INQUIRY_OUTPUT_JSON"), "outputs/GetOrderInquiry/OrderInquiry.json")
    log_path = _resolve_path(os.getenv("ORDER_INQUIRY_OUTPUT_LOG"), "outputs/GetOrderInquiry/OrderInquiry.log")

    if not source_path.exists():
        raise SystemExit(f"Source file not found: {source_path}")

    csv_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    order_ids, source_duplicates = _load_order_ids_from_source(source_path)
    existing_output_ids = _load_existing_order_ids(csv_path)

    headers = {api_key_header: api_key_value}
    show_raw = os.getenv("ORDER_INQUIRY_SHOW_RAW", "false").strip().lower() in {"1", "true", "yes", "y"}

    print("OrderInquiry Base URL:", api_base)
    print("Source file:", str(source_path))
    print("Request Headers:")
    print(json.dumps(headers, indent=2))

    processed = 0
    skipped_existing = 0
    failed = 0
    interrupted = False
    total_records_received = 0
    new_records_appended = 0

    try:
        for order_id in order_ids:
            if order_id in existing_output_ids:
                skipped_existing += 1
                continue

            request_url = f"{api_base}/{order_id}"
            try:
                response = requests.get(request_url, headers=headers, timeout=TIMEOUT_SECONDS)
            except requests.exceptions.RequestException as exc:
                failed += 1
                _write_log(
                    log_path,
                    f"{_utc_now_iso()} | status=EXCEPTION | ord_ID={order_id} | url={request_url} | error={exc}",
                )
                continue

            if response.status_code >= 400:
                failed += 1
                _write_log(
                    log_path,
                    f"{_utc_now_iso()} | status={response.status_code} | ord_ID={order_id} | url={request_url}",
                )
                continue

            try:
                payload = response.json()
            except json.JSONDecodeError:
                payload = response.text

            print(f"\n--- Order Inquiry Success ---")
            print(f"http_status: {response.status_code}")
            if isinstance(payload, dict):
                _print_clean_record_preview(order_id, payload)
            elif isinstance(payload, list) and payload and isinstance(payload[0], dict):
                _print_clean_record_preview(order_id, payload[0])
            else:
                print(f"ord_ID: {order_id}")
                print(f"payload_type: {type(payload).__name__}")

            if show_raw:
                print("raw_response:")
                print(response.text)

            records = payload if isinstance(payload, list) else [payload]
            total_records_received += len(records)
            rows = []
            normalized_records = []
            for item in records:
                if isinstance(item, dict):
                    if not _extract_order_id(item):
                        item["ord_ID"] = order_id
                    normalized_records.append(item)

                    row = {k: _to_json_text(v) for k, v in item.items()}
                    row["__raw_json"] = json.dumps(item, ensure_ascii=False)
                    rows.append(row)
                else:
                    normalized_records.append({"ord_ID": order_id, "value": item})
                    rows.append(
                        {
                            "ord_ID": order_id,
                            "value": _to_json_text(item),
                            "__raw_json": json.dumps(item, ensure_ascii=False),
                        }
                    )

            _append_json_array(json_path, normalized_records)
            _append_csv(csv_path, rows)
            _write_log(
                log_path,
                f"{_utc_now_iso()} | status={response.status_code} | ord_ID={order_id} | url={request_url}",
            )
            existing_output_ids.add(order_id)
            processed += 1
            new_records_appended += len(normalized_records)
    except KeyboardInterrupt:
        interrupted = True
        print("\nSafe exit: process interrupted by user (Ctrl+C).")
        _write_log(log_path, f"{_utc_now_iso()} | status=INTERRUPTED_BY_USER")

    _write_log(
        log_path,
        (
            f"{_utc_now_iso()} | summary | source_total={len(order_ids)} | source_duplicates={source_duplicates} | "
            f"skipped_existing={skipped_existing} | processed={processed} | failed={failed} | interrupted={interrupted}"
        ),
    )

    duplicate_records_skipped = source_duplicates + skipped_existing

    print("\nRun summary:")
    print(f"Total records received: {total_records_received}")
    print(f"New records appended: {new_records_appended}")
    print(f"Duplicate records skipped: {duplicate_records_skipped}")

    print("\nDetailed summary:")
    print(f"Source order IDs: {len(order_ids)}")
    print(f"Duplicate IDs in source skipped: {source_duplicates}")
    print(f"Already in output skipped: {skipped_existing}")
    print(f"Processed: {processed}")
    print(f"Failed: {failed}")
    print(f"Interrupted: {interrupted}")

    print("\nSaved files:")
    print(str(csv_path))
    print(str(json_path))
    print(str(log_path))


if __name__ == "__main__":
    main()
=======
import csv
import json
import os
from pathlib import Path
from datetime import datetime, timezone

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


def _resolve_path(raw_value, default_value):
    value = (raw_value or default_value or "").strip()
    path = Path(value)
    return path


def _normalize_order_inquiry_base(url):
    cleaned = url.strip().rstrip("/")
    if cleaned.split("/")[-1].isdigit():
        return "/".join(cleaned.split("/")[:-1])
    return cleaned


def _extract_order_id(item):
    if not isinstance(item, dict):
        return ""
    candidate = item.get("ord_ID")
    if candidate in (None, ""):
        candidate = item.get("ord_id")
    return str(candidate or "").strip()


def _load_order_ids_from_source(source_path):
    suffix = source_path.suffix.lower()
    seen = set()
    unique_ids = []
    duplicates_in_source = 0

    if suffix == ".csv":
        with source_path.open("r", newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                order_id = _extract_order_id(row)
                if not order_id:
                    continue
                if order_id in seen:
                    duplicates_in_source += 1
                    continue
                seen.add(order_id)
                unique_ids.append(order_id)
    elif suffix == ".json":
        with source_path.open("r", encoding="utf-8") as f:
            payload = json.load(f)
        records = payload if isinstance(payload, list) else [payload]
        for item in records:
            order_id = _extract_order_id(item)
            if not order_id:
                continue
            if order_id in seen:
                duplicates_in_source += 1
                continue
            seen.add(order_id)
            unique_ids.append(order_id)
    else:
        raise SystemExit("ORDER_INQUIRY_SOURCE_PATH must be a .csv or .json file")

    return unique_ids, duplicates_in_source


def _load_existing_order_ids(csv_path):
    if not csv_path.exists():
        return set()
    existing = set()
    with csv_path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            order_id = _extract_order_id(row)
            if order_id:
                existing.add(order_id)
    return existing


def _to_json_text(data):
    if isinstance(data, (dict, list)):
        return json.dumps(data, ensure_ascii=False)
    return data


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


def _append_json_array(json_path, records):
    if not records:
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


def _write_log(log_path, line):
    with log_path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def _utc_now_iso():
    return datetime.now(timezone.utc).isoformat()


def _print_clean_record_preview(order_id, payload):
    if not isinstance(payload, dict):
        print(f"ord_ID: {order_id}")
        print(f"payload_type: {type(payload).__name__}")
        return

    print(f"ord_ID: {order_id}")
    print(f"status: {payload.get('fStatus', 'unknown')}")
    print(f"ship_name: {payload.get('ship_Name', '')}")
    print(f"ship_city: {payload.get('ship_City', '')}")
    print(f"ship_state: {payload.get('ship_State', '')}")
    print(f"ship_zip: {payload.get('ship_Zip', '')}")
    print(f"occasion: {payload.get('ord_Occasion', '')}")


def main():
    load_dotenv_file()

    api_base = _normalize_order_inquiry_base(_required_env("API_URL_ORDER_INQUIRY"))
    api_key_header = _required_env("API_KEY_HEADER")
    api_key_value = _required_env("API_KEY_VALUE")

    source_path = _resolve_path(os.getenv("ORDER_INQUIRY_SOURCE_PATH"), "outputs/GetTask/Tasks_OrderID.csv")
    csv_path = _resolve_path(os.getenv("ORDER_INQUIRY_OUTPUT_CSV"), "outputs/GetOrderInquiry/OrderInquiry.csv")
    json_path = _resolve_path(os.getenv("ORDER_INQUIRY_OUTPUT_JSON"), "outputs/GetOrderInquiry/OrderInquiry.json")
    log_path = _resolve_path(os.getenv("ORDER_INQUIRY_OUTPUT_LOG"), "outputs/GetOrderInquiry/OrderInquiry.log")

    if not source_path.exists():
        raise SystemExit(f"Source file not found: {source_path}")

    csv_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    order_ids, source_duplicates = _load_order_ids_from_source(source_path)
    existing_output_ids = _load_existing_order_ids(csv_path)

    headers = {api_key_header: api_key_value}
    show_raw = os.getenv("ORDER_INQUIRY_SHOW_RAW", "false").strip().lower() in {"1", "true", "yes", "y"}

    print("OrderInquiry Base URL:", api_base)
    print("Source file:", str(source_path))
    print("Request Headers:")
    print(json.dumps(headers, indent=2))

    processed = 0
    skipped_existing = 0
    failed = 0
    interrupted = False
    total_records_received = 0
    new_records_appended = 0

    try:
        for order_id in order_ids:
            if order_id in existing_output_ids:
                skipped_existing += 1
                continue

            request_url = f"{api_base}/{order_id}"
            try:
                response = requests.get(request_url, headers=headers, timeout=TIMEOUT_SECONDS)
            except requests.exceptions.RequestException as exc:
                failed += 1
                _write_log(
                    log_path,
                    f"{_utc_now_iso()} | status=EXCEPTION | ord_ID={order_id} | url={request_url} | error={exc}",
                )
                continue

            if response.status_code >= 400:
                failed += 1
                _write_log(
                    log_path,
                    f"{_utc_now_iso()} | status={response.status_code} | ord_ID={order_id} | url={request_url}",
                )
                continue

            try:
                payload = response.json()
            except json.JSONDecodeError:
                payload = response.text

            print(f"\n--- Order Inquiry Success ---")
            print(f"http_status: {response.status_code}")
            if isinstance(payload, dict):
                _print_clean_record_preview(order_id, payload)
            elif isinstance(payload, list) and payload and isinstance(payload[0], dict):
                _print_clean_record_preview(order_id, payload[0])
            else:
                print(f"ord_ID: {order_id}")
                print(f"payload_type: {type(payload).__name__}")

            if show_raw:
                print("raw_response:")
                print(response.text)

            records = payload if isinstance(payload, list) else [payload]
            total_records_received += len(records)
            rows = []
            normalized_records = []
            for item in records:
                if isinstance(item, dict):
                    if not _extract_order_id(item):
                        item["ord_ID"] = order_id
                    normalized_records.append(item)

                    row = {k: _to_json_text(v) for k, v in item.items()}
                    row["__raw_json"] = json.dumps(item, ensure_ascii=False)
                    rows.append(row)
                else:
                    normalized_records.append({"ord_ID": order_id, "value": item})
                    rows.append(
                        {
                            "ord_ID": order_id,
                            "value": _to_json_text(item),
                            "__raw_json": json.dumps(item, ensure_ascii=False),
                        }
                    )

            _append_json_array(json_path, normalized_records)
            _append_csv(csv_path, rows)
            _write_log(
                log_path,
                f"{_utc_now_iso()} | status={response.status_code} | ord_ID={order_id} | url={request_url}",
            )
            existing_output_ids.add(order_id)
            processed += 1
            new_records_appended += len(normalized_records)
    except KeyboardInterrupt:
        interrupted = True
        print("\nSafe exit: process interrupted by user (Ctrl+C).")
        _write_log(log_path, f"{_utc_now_iso()} | status=INTERRUPTED_BY_USER")

    _write_log(
        log_path,
        (
            f"{_utc_now_iso()} | summary | source_total={len(order_ids)} | source_duplicates={source_duplicates} | "
            f"skipped_existing={skipped_existing} | processed={processed} | failed={failed} | interrupted={interrupted}"
        ),
    )

    duplicate_records_skipped = source_duplicates + skipped_existing

    print("\nRun summary:")
    print(f"Total records received: {total_records_received}")
    print(f"New records appended: {new_records_appended}")
    print(f"Duplicate records skipped: {duplicate_records_skipped}")

    print("\nDetailed summary:")
    print(f"Source order IDs: {len(order_ids)}")
    print(f"Duplicate IDs in source skipped: {source_duplicates}")
    print(f"Already in output skipped: {skipped_existing}")
    print(f"Processed: {processed}")
    print(f"Failed: {failed}")
    print(f"Interrupted: {interrupted}")

    print("\nSaved files:")
    print(str(csv_path))
    print(str(json_path))
    print(str(log_path))


if __name__ == "__main__":
    main()
>>>>>>> ac78c6fd6892d49e2932651256c992372a8fedeb
