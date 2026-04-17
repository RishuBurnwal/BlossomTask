import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from copy import deepcopy


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "Scripts"
for path in (ROOT, SCRIPTS_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import ClosingTask  # noqa: E402
import Funeral_Finder  # noqa: E402
import reverify  # noqa: E402
import Updater  # noqa: E402


def _write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    fieldnames = sorted({key for row in rows for key in row})
    with open(path, "w", newline="", encoding="utf-8") as file_handle:
        writer = csv.DictWriter(file_handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


class PipelineRequirementTests(unittest.TestCase):
    def test_funeral_finder_business_rules_promote_found_when_order_instructions_have_schedule(self):
        order = {
            "ord_instruct": "Viewing Friday 6:00 PM at St Mary's Church",
            "ship_care_of": "",
            "ship_address": "",
        }
        parsed = {
            "match_status": "NotFound",
            "ai_accuracy_score": 10,
            "special_instructions": "",
            "notes": "",
        }

        adjusted = Funeral_Finder._apply_business_rules(order, parsed)

        self.assertEqual(adjusted["match_status"], "Found")
        self.assertGreaterEqual(adjusted["ai_accuracy_score"], 75)
        self.assertIn("Customer-provided schedule", adjusted["special_instructions"])

    def test_funeral_finder_business_rules_downgrade_found_for_non_funeral_destination(self):
        order = {
            "ord_instruct": "Deliver to home address",
            "ship_care_of": "",
            "ship_address": "123 Main St Home Apt 2",
        }
        parsed = {
            "match_status": "Found",
            "ai_accuracy_score": 91,
            "service_date": "2026-04-20",
            "service_time": "11:00 AM",
            "visitation_date": "",
            "visitation_time": "",
            "special_instructions": "Service: Apr 20 11:00 AM",
            "notes": "",
        }

        adjusted = Funeral_Finder._apply_business_rules(order, parsed)

        self.assertEqual(adjusted["match_status"], "Review")
        self.assertIn("non-funeral location", adjusted["notes"])

    def test_funeral_finder_business_rules_keep_found_for_unknown_destination_when_schedule_exists(self):
        order = {
            "ord_instruct": "Service Tuesday 3:00 PM",
            "ship_care_of": "",
            "ship_address": "",
        }
        parsed = {
            "match_status": "Review",
            "ai_accuracy_score": 62,
            "special_instructions": "",
            "notes": "",
        }

        adjusted = Funeral_Finder._apply_business_rules(order, parsed)

        self.assertEqual(adjusted["match_status"], "Found")

    def test_reverify_uses_six_strategies(self):
        record = {
            "ship_name": "John Doe",
            "ship_city": "Boston",
            "ship_state": "MA",
            "ship_care_of": "",
            "ord_instruct": "",
        }

        strategies = reverify.get_strategy_order(record)

        self.assertEqual(len(strategies), 6)
        self.assertEqual(
            [name for name, _ in strategies],
            ["original", "normalized_city", "expanded_nickname", "state_only", "care_of", "ord_instruct"],
        )

    def test_reverify_process_record_runs_all_six_attempts_when_limit_is_six(self):
        record = {
            "ship_name": "John Doe",
            "ship_city": "Boston",
            "ship_state": "MA",
            "ship_care_of": "Funeral Home",
            "ord_instruct": "Service Friday 11:00 AM",
        }

        with patch.object(reverify, "query_perplexity") as mocked_query:
            mocked_query.side_effect = [
                (
                    "{}",
                    {
                        "match_status": "Review",
                        "ai_accuracy_score": 40,
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
                        "notes": "",
                    },
                    {"model": "sonar-pro"},
                )
                for _ in range(6)
            ]

            result = reverify.process_record("fake-key", deepcopy(record), max_attempts=6)

        self.assertEqual(len(result["attempts"]), 6)
        self.assertEqual(mocked_query.call_count, 6)

    def test_funeral_finder_parse_ai_response_uses_visitation_fallback(self):
        ai_text = json.dumps(
            {
                "funeral_home_name": "Alpha Home",
                "funeral_date": "",
                "funeral_time": "",
                "visitation_date": "2026-04-20",
                "visitation_time": "11:00 AM",
                "delivery_recommendation_date": "",
                "delivery_recommendation_time": "",
                "status": "Found",
                "AI Accuracy Score": 91,
                "source_urls": ["https://example.com/obit"],
                "notes": "verified",
            }
        )

        parsed = Funeral_Finder.parse_ai_response(ai_text)

        self.assertEqual(parsed["service_date"], "2026-04-20")
        self.assertEqual(parsed["service_time"], "11:00 AM")

    def test_reverify_parse_ai_response_without_datetime_pair_is_not_found(self):
        ai_text = json.dumps(
            {
                "funeral_home_name": "Beta Home",
                "funeral_date": "",
                "funeral_time": "",
                "visitation_date": "",
                "visitation_time": "",
                "delivery_recommendation_date": "2026-04-22",
                "delivery_recommendation_time": "02:15 PM",
                "status": "Found",
                "AI Accuracy Score": 72,
                "source_urls": ["https://example.com/service"],
                "notes": "fallback needed",
            }
        )

        parsed = reverify.parse_ai_response(ai_text)

        self.assertEqual(parsed["service_date"], "")
        self.assertEqual(parsed["service_time"], "")
        self.assertEqual(parsed["match_status"], "NotFound")

    def test_updater_build_payload_does_not_use_delivery_for_tr_end_date(self):
        order = {
            "order_id": "5001",
            "match_status": "Found",
            "service_date": "",
            "service_time": "",
            "visitation_date": "",
            "visitation_time": "",
            "delivery_recommendation_date": "2026-04-22",
            "delivery_recommendation_time": "02:15 PM",
            "ship_name": "Gamma Doe",
            "funeral_home_name": "Gamma Home",
            "notes": "needs delivery fallback",
            "source_urls": "https://example.com/obit",
        }

        payload = Updater.build_payload(order)

        self.assertEqual(payload["trEndDate"], "")
        self.assertEqual(payload["trResult"], "NotFound")
        self.assertIn("Deliver By: 2026-04-22 02:15 PM", payload["trText"])
        self.assertIn("Sources: https://example.com/obit", payload["trText"])

    def test_reverify_update_record_keeps_single_note_source(self):
        record = {"notes": "main-note", "order_id": "100", "match_status": "Review"}
        result = {"notes": "reverify-note", "match_status": "Found", "ai_accuracy_score": 88}

        updated = reverify.update_record_for_result(record, result, "review")

        self.assertEqual(updated["notes"], "reverify-note")
        self.assertNotIn("main-note |", updated["notes"])

    def test_reverify_apply_business_rules_forces_not_found_without_datetime_pair(self):
        record = {
            "ord_instruct": "",
            "ship_care_of": "",
            "ship_address": "",
        }
        parsed = {
            "match_status": "Review",
            "ai_accuracy_score": 80,
            "service_date": "",
            "service_time": "",
            "visitation_date": "",
            "visitation_time": "",
            "special_instructions": "",
            "notes": "",
        }

        adjusted = reverify.apply_business_rules(record, parsed)

        self.assertEqual(adjusted["match_status"], "NotFound")

    def test_reverify_parse_ai_response_keeps_ceremony_fields(self):
        ai_text = json.dumps(
            {
                "funeral_home_name": "Ceremony Home",
                "funeral_date": "",
                "funeral_time": "",
                "visitation_date": "",
                "visitation_time": "",
                "ceremony_date": "2026-05-01",
                "ceremony_time": "03:00 PM",
                "status": "Found",
                "AI Accuracy Score": 88,
                "source_urls": ["https://example.com/ceremony"],
                "notes": "ceremony found",
            }
        )

        parsed = reverify.parse_ai_response(ai_text)

        self.assertEqual(parsed["ceremony_date"], "2026-05-01")
        self.assertEqual(parsed["ceremony_time"], "03:00 PM")
        self.assertEqual(parsed["match_status"], "Found")

    def test_closing_task_filters_logged_ids_after_loading(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            input_csv = temp_path / "updater_input.csv"
            logs_file = temp_path / "closing_logs.txt"
            _write_csv(
                input_csv,
                [
                    {"order_id": "A", "upload_status": "SUCCESS", "status": "Found", "trResult": "Found"},
                    {"order_id": "B", "upload_status": "SUCCESS", "status": "Review", "trResult": "Review"},
                    {"order_id": "C", "upload_status": "FAILED", "status": "Found", "trResult": "Found"},
                    {"order_id": "D", "upload_status": "SUCCESS", "status": "Found", "trResult": "Found"},
                ],
            )
            logs_file.write_text("A\n", encoding="utf-8")

            with patch.object(ClosingTask, "INPUT_CSV", input_csv):
                with patch.object(ClosingTask, "LOGS_PATH", logs_file):
                    orders = ClosingTask.load_updater_data()
                    logged_ids = ClosingTask.load_logged_ids()
                    filtered_orders, skipped = ClosingTask.filter_orders_by_logged_ids(orders, logged_ids)

        self.assertEqual([order["order_id"] for order in orders], ["A", "D"])
        self.assertEqual(logged_ids, {"A"})
        self.assertEqual(skipped, 1)
        self.assertEqual([order["order_id"] for order in filtered_orders], ["D"])

    def test_updater_filters_logged_ids_after_loading(self):
        orders = [
            {"order_id": "A", "match_status": "Found"},
            {"order_id": "B", "match_status": "Found"},
            {"order_id": "C", "match_status": "Review"},
        ]

        filtered_orders, skipped = Updater.filter_orders_by_logged_ids(orders, {"B"})

        self.assertEqual(skipped, 1)
        self.assertEqual([order["order_id"] for order in filtered_orders], ["A", "C"])

    def test_reverify_filters_logged_ids_after_loading(self):
        rows = [
            {"order_id": "A", "match_status": "NotFound"},
            {"order_id": "B", "match_status": "Review"},
            {"order_id": "C", "match_status": "NotFound"},
        ]

        filtered_rows, skipped = reverify.filter_records_by_logged_ids(rows, {"A", "C"})

        self.assertEqual(skipped, 2)
        self.assertEqual([row["order_id"] for row in filtered_rows], ["B"])

    def test_reverify_filters_logged_ids_when_order_id_has_trailing_decimal(self):
        rows = [
            {"order_id": "12345.0", "match_status": "NotFound"},
            {"order_id": "12346", "match_status": "Review"},
        ]

        filtered_rows, skipped = reverify.filter_records_by_logged_ids(rows, {"12345"})

        self.assertEqual(skipped, 1)
        self.assertEqual([row["order_id"] for row in filtered_rows], ["12346"])

    def test_reverify_normalize_service_datetime_prefers_service_then_visitation_then_ceremony(self):
        self.assertEqual(
            reverify._normalize_service_datetime("2026-04-20", "10:00 AM", "2026-04-21", "11:00 AM", "2026-04-23", "01:00 PM"),
            ("2026-04-20", "10:00 AM", "service"),
        )
        self.assertEqual(
            reverify._normalize_service_datetime("", "", "2026-04-21", "11:00 AM", "2026-04-23", "01:00 PM"),
            ("2026-04-21", "11:00 AM", "visitation"),
        )
        self.assertEqual(
            reverify._normalize_service_datetime("", "", "", "", "2026-04-23", "01:00 PM"),
            ("2026-04-23", "01:00 PM", "ceremony"),
        )


if __name__ == "__main__":
    unittest.main()