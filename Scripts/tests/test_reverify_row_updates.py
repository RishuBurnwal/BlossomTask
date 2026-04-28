from __future__ import annotations

import csv
import sys
from pathlib import Path

import pytest


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import reverify  # noqa: E402


def _write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    fieldnames = sorted({key for row in rows for key in row})
    with open(path, "w", newline="", encoding="utf-8") as file_handle:
        writer = csv.DictWriter(file_handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def _read_csv(path: Path) -> list[dict[str, str]]:
    with open(path, "r", newline="", encoding="utf-8") as file_handle:
        return list(csv.DictReader(file_handle))


def test_load_records_preserves_source_row_number(tmp_path: Path):
    csv_path = tmp_path / "source.csv"
    _write_csv(
        csv_path,
        [
            {"order_id": "A", "match_status": "Review"},
            {"order_id": "B", "match_status": "NotFound"},
        ],
    )

    records = reverify.load_records(csv_path)

    assert [record["_source_row_number"] for record in records] == [1, 2]


def test_upsert_record_replaces_matching_row_by_row_number(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    csv_path = tmp_path / "main.csv"
    _write_csv(
        csv_path,
        [
            {"order_id": "A", "funeral_home_name": "Alpha", "match_status": "Review"},
            {"order_id": "B", "funeral_home_name": "Bravo", "match_status": "Review"},
            {"order_id": "C", "funeral_home_name": "Charlie", "match_status": "Review"},
        ],
    )

    monkeypatch.setattr(reverify, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(reverify, "MAIN_CSV_PATH", csv_path)

    reverify.upsert_record(
        csv_path,
        {
            "order_id": "B",
            "funeral_home_name": "Bravo Updated",
            "match_status": "Found",
            "notes": "verified",
        },
        row_number=2,
    )

    rows = _read_csv(csv_path)
    assert [row["order_id"] for row in rows] == ["A", "B", "C"]
    assert rows[1]["funeral_home_name"] == "Bravo Updated"
    assert rows[1]["match_status"] == "Found"


def test_upsert_record_falls_back_to_order_id_when_row_number_is_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    csv_path = tmp_path / "main.csv"
    _write_csv(
        csv_path,
        [
            {"order_id": "A", "funeral_home_name": "Alpha"},
            {"order_id": "B", "funeral_home_name": "Bravo"},
        ],
    )

    monkeypatch.setattr(reverify, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(reverify, "MAIN_CSV_PATH", csv_path)

    reverify.upsert_record(
        csv_path,
        {"order_id": "B", "funeral_home_name": "Bravo Updated"},
        row_number=99,
    )

    rows = _read_csv(csv_path)
    assert [row["funeral_home_name"] for row in rows] == ["Alpha", "Bravo Updated"]


def test_upsert_record_ignores_mismatched_row_number_when_order_id_differs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    csv_path = tmp_path / "main.csv"
    _write_csv(
        csv_path,
        [
            {"order_id": "A", "funeral_home_name": "Alpha"},
            {"order_id": "C", "funeral_home_name": "Charlie"},
            {"order_id": "B", "funeral_home_name": "Bravo"},
        ],
    )

    monkeypatch.setattr(reverify, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(reverify, "MAIN_CSV_PATH", csv_path)

    reverify.upsert_record(
        csv_path,
        {"order_id": "B", "funeral_home_name": "Bravo Updated"},
        row_number=2,
    )

    rows = _read_csv(csv_path)
    assert [row["order_id"] for row in rows] == ["A", "C", "B"]
    assert rows[1]["funeral_home_name"] == "Charlie"
    assert rows[2]["funeral_home_name"] == "Bravo Updated"


def test_upsert_record_appends_when_order_id_changes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    csv_path = tmp_path / "main.csv"
    _write_csv(
        csv_path,
        [
            {"order_id": "A", "funeral_home_name": "Alpha", "ship_city": "Austin", "ship_state": "TX"},
            {"order_id": "B", "funeral_home_name": "Bravo", "ship_city": "Dallas", "ship_state": "TX"},
            {"order_id": "C", "funeral_home_name": "Charlie", "ship_city": "Houston", "ship_state": "TX"},
        ],
    )

    monkeypatch.setattr(reverify, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(reverify, "MAIN_CSV_PATH", csv_path)

    reverify.upsert_record(
        csv_path,
        {"order_id": "B-UPDATED", "funeral_home_name": "Bravo Updated", "ship_city": "Dallas", "ship_state": "TX"},
        row_number=2,
    )

    rows = _read_csv(csv_path)
    assert [row["order_id"] for row in rows] == ["A", "B", "C", "B-UPDATED"]
    assert rows[3]["funeral_home_name"] == "Bravo Updated"


def test_extract_json_from_text_handles_nested_objects():
    text = (
        "Here is the answer: "
        '{"outer": {"inner": {"value": 42}}, "status": "Found", "source_urls": ["https://example.com"]}'
    )

    parsed = reverify._extract_json_from_text(text)

    assert parsed["outer"]["inner"]["value"] == 42
    assert parsed["status"] == "Found"


def test_upsert_record_appends_when_row_number_hits_unrelated_row(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    csv_path = tmp_path / "main.csv"
    _write_csv(
        csv_path,
        [
            {"order_id": "A", "funeral_home_name": "Alpha", "ship_city": "Austin"},
            {"order_id": "C", "funeral_home_name": "Charlie", "ship_city": "Dallas"},
        ],
    )

    monkeypatch.setattr(reverify, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(reverify, "MAIN_CSV_PATH", csv_path)

    reverify.upsert_record(
        csv_path,
        {"order_id": "D", "funeral_home_name": "Delta", "ship_city": "Houston"},
        row_number=2,
    )

    rows = _read_csv(csv_path)
    assert [row["order_id"] for row in rows] == ["A", "C", "D"]
    assert rows[1]["funeral_home_name"] == "Charlie"
    assert rows[2]["funeral_home_name"] == "Delta"


def test_upsert_record_appends_when_target_row_is_sparse(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    csv_path = tmp_path / "main.csv"
    _write_csv(
        csv_path,
        [
            {"order_id": "A", "funeral_home_name": "Alpha", "ship_city": "Austin"},
            {"order_id": "", "funeral_home_name": "", "ship_city": ""},
        ],
    )

    monkeypatch.setattr(reverify, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(reverify, "MAIN_CSV_PATH", csv_path)

    reverify.upsert_record(
        csv_path,
        {"order_id": "B", "funeral_home_name": "Bravo", "ship_city": "Boston"},
        row_number=2,
    )

    rows = _read_csv(csv_path)
    assert [row["order_id"] for row in rows] == ["A", "B"]
    assert rows[0]["funeral_home_name"] == "Alpha"
    assert rows[1]["funeral_home_name"] == "Bravo"


def test_upsert_record_keeps_existing_non_empty_values(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    csv_path = tmp_path / "main.csv"
    _write_csv(
        csv_path,
        [
            {
                "order_id": "A",
                "funeral_home_name": "Fisher & Sons",
                "funeral_address": "123 Main St",
                "source_urls": "https://legacy.example/obit",
                "match_status": "Review",
            },
        ],
    )

    monkeypatch.setattr(reverify, "OUTPUT_DIR", tmp_path)
    monkeypatch.setattr(reverify, "MAIN_CSV_PATH", csv_path)

    reverify.upsert_record(
        csv_path,
        {
            "order_id": "A",
            "funeral_home_name": "",
            "funeral_address": "",
            "source_urls": "",
            "match_status": "Found",
            "ai_accuracy_score": 91,
            "notes": "reverified via strategy=care_of",
        },
        row_number=1,
    )

    rows = _read_csv(csv_path)
    assert rows[0]["funeral_home_name"] == "Fisher & Sons"
    assert rows[0]["funeral_address"] == "123 Main St"
    assert rows[0]["source_urls"] == "https://legacy.example/obit"
    assert rows[0]["match_status"] == "Found"
    assert rows[0]["ai_accuracy_score"] == "91"


def test_update_record_for_result_keeps_existing_non_empty_values():
    record = {
        "order_id": "A",
        "funeral_home_name": "Fisher & Sons",
        "funeral_address": "123 Main St",
        "source_urls": "https://legacy.example/obit",
        "match_status": "Review",
        "notes": "original note",
    }
    result = {
        "funeral_home_name": "",
        "funeral_address": "",
        "source_urls": "",
        "match_status": "Found",
        "ai_accuracy_score": 91,
        "notes": "reverified via strategy=care_of",
    }

    updated = reverify.update_record_for_result(record, result, "review")

    assert updated["funeral_home_name"] == "Fisher & Sons"
    assert updated["funeral_address"] == "123 Main St"
    assert updated["source_urls"] == "https://legacy.example/obit"
    assert updated["match_status"] == "Found"
    assert updated["ai_accuracy_score"] == 91
    assert updated["notes"] == "reverified via strategy=care_of"


def test_update_record_for_result_always_overwrites_notes_and_status_fields():
    record = {
        "order_id": "A",
        "funeral_home_name": "Fisher & Sons",
        "notes": "old note",
        "match_status": "Review",
        "ai_accuracy_score": "77",
    }
    result = {
        "funeral_home_name": "",
        "notes": "",
        "match_status": "NotFound",
        "ai_accuracy_score": 0,
    }

    updated = reverify.update_record_for_result(record, result, "review")

    assert updated["funeral_home_name"] == "Fisher & Sons"
    assert updated["notes"] == ""
    assert updated["match_status"] == "NotFound"
    assert updated["ai_accuracy_score"] == 0