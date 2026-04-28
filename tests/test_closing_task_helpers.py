import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "Scripts"))

import ClosingTask  # noqa: E402, N813


def _write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    fieldnames = sorted({key for row in rows for key in row})
    with open(path, "w", newline="", encoding="utf-8") as file_handle:
        writer = csv.DictWriter(file_handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def test_load_updater_data_requires_exact_found_match(tmp_path: Path, monkeypatch):
    input_csv = tmp_path / "updater.csv"
    _write_csv(
        input_csv,
        [
            {"order_id": "1", "upload_status": "SUCCESS", "trResult": "Found"},
            {"order_id": "2", "upload_status": "SUCCESS", "trResult": "NotFound"},
            {"order_id": "3", "upload_status": "SUCCESS", "trResult": "notfound"},
            {"order_id": "4", "upload_status": "SUCCESS", "trResult": "Review"},
        ],
    )

    monkeypatch.setattr(ClosingTask, "INPUT_CSV", input_csv)

    rows = ClosingTask.load_updater_data()

    assert [row["order_id"] for row in rows] == ["1"]


def test_load_updater_data_accepts_match_status_found(tmp_path: Path, monkeypatch):
    input_csv = tmp_path / "updater.csv"
    _write_csv(
        input_csv,
        [
            {"order_id": "1", "upload_status": "SUCCESS", "match_status": "Found", "trResult": ""},
            {"order_id": "2", "upload_status": "SUCCESS", "match_status": "Review", "trResult": "Review"},
        ],
    )

    monkeypatch.setattr(ClosingTask, "INPUT_CSV", input_csv)

    rows = ClosingTask.load_updater_data()

    assert [row["order_id"] for row in rows] == ["1"]
