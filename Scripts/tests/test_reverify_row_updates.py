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


def test_upsert_record_uses_row_number_when_order_id_changed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
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
    assert [row["order_id"] for row in rows] == ["A", "B-UPDATED", "C"]
    assert rows[1]["funeral_home_name"] == "Bravo Updated"


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