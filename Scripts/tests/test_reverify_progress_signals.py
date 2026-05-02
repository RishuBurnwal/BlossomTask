from __future__ import annotations

import io
import sys
from contextlib import redirect_stdout
from pathlib import Path

import pytest


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import reverify  # noqa: E402


def test_main_emits_numeric_progress_signals(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    source_files = {
        "not_found": tmp_path / "not_found.csv",
        "review": tmp_path / "review.csv",
    }
    payload_path = tmp_path / "payload.json"

    monkeypatch.setattr(reverify, "SOURCE_FILES", source_files)
    monkeypatch.setattr(reverify, "PAYLOAD_PATH", payload_path)
    monkeypatch.setattr(reverify, "MAIN_CSV_PATH", tmp_path / "main.csv")
    monkeypatch.setattr(reverify, "MAIN_EXCEL_PATH", tmp_path / "main.xlsx")
    monkeypatch.setattr(reverify, "CUSTOMER_CSV_PATH", tmp_path / "customer.csv")
    monkeypatch.setattr(reverify, "CUSTOMER_EXCEL_PATH", tmp_path / "customer.xlsx")
    monkeypatch.setattr(reverify, "FOUND_CSV_PATH", tmp_path / "found.csv")
    monkeypatch.setattr(reverify, "FOUND_EXCEL_PATH", tmp_path / "found.xlsx")
    monkeypatch.setattr(reverify, "NOT_FOUND_EXCEL_PATH", tmp_path / "not_found.xlsx")
    monkeypatch.setattr(reverify, "REVIEW_EXCEL_PATH", tmp_path / "review.xlsx")

    monkeypatch.setattr(reverify, "load_dotenv_file", lambda: None)
    monkeypatch.setattr(reverify, "_run_date_key", lambda: "2099-01-01")
    monkeypatch.setattr(reverify, "ensure_reverify_log_files", lambda run_date_key: tmp_path / "daily.log")
    monkeypatch.setattr(reverify, "_load_error_report", lambda: None)
    monkeypatch.setattr(reverify, "load_run_guard", lambda: {})
    monkeypatch.setattr(reverify, "_run_guard_key", lambda: "test-guard")
    monkeypatch.setattr(reverify, "save_run_guard", lambda payload: None)
    monkeypatch.setattr(reverify, "load_logged_ids", lambda: set())
    monkeypatch.setattr(reverify, "load_latest_inquiry_order_ids", lambda latest_count: set())
    monkeypatch.setattr(
        reverify,
        "load_records",
        lambda path: [{"order_id": "A-100", "_source_row_number": 1, "ship_name": "Test Person"}] if path == source_files["review"] else [],
    )
    monkeypatch.setattr(
        reverify,
        "process_record",
        lambda record, max_attempts=1: {
            "match_status": "Found",
            "ai_accuracy_score": 91,
            "notes": "verified",
            "_business_rules_applied": True,
            "attempts": [],
        },
    )
    monkeypatch.setattr(
        reverify,
        "update_record_for_result",
        lambda record, result, source_name: {
            **record,
            "order_id": record["order_id"],
            "match_status": "Found",
            "ai_accuracy_score": 91,
            "notes": "verified",
        },
    )
    monkeypatch.setattr(reverify, "_coerce_row_number", lambda value: 1)
    monkeypatch.setattr(reverify, "append_main_record", lambda *args, **kwargs: None)
    monkeypatch.setattr(reverify, "upsert_record", lambda *args, **kwargs: None)
    monkeypatch.setattr(reverify, "get_date_wise_output_path", lambda *args, **kwargs: tmp_path / "date.csv")
    monkeypatch.setattr(reverify, "remove_record_from_all_date_wise", lambda *args, **kwargs: None)
    monkeypatch.setattr(reverify, "remove_record", lambda *args, **kwargs: None)
    monkeypatch.setattr(reverify, "save_record_to_status_outputs", lambda *args, **kwargs: None)
    monkeypatch.setattr(reverify, "append_logged_id", lambda *args, **kwargs: None)
    monkeypatch.setattr(reverify, "append_reverify_daily_log", lambda *args, **kwargs: None)
    monkeypatch.setattr(reverify, "rebuild_excel_from_csv", lambda *args, **kwargs: None)
    monkeypatch.setattr(reverify, "get_now_iso", lambda: "2026-05-02T00:00:00+05:30")

    monkeypatch.setattr(sys, "argv", ["reverify.py", "--source", "review", "--limit", "1"])
    stdout = io.StringIO()
    with redirect_stdout(stdout):
        reverify.main()

    output = stdout.getvalue()
    assert "REVERIFY_TOTAL|1" in output
    assert "REVERIFY_PROGRESS|1|1" in output
