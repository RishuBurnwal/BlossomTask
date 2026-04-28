import csv
import json
import sys
import tempfile
import unittest
from types import SimpleNamespace
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

    def test_funeral_finder_business_rules_accept_fuzzy_name_from_obituary_url(self):
        order = {
            "ship_name": "Lou Alliano",
            "ord_instruct": "",
            "ship_care_of": "Thompson Funeral Chappel",
            "ship_address": "926 S Litchfield Rd",
        }
        parsed = {
            "match_status": "Review",
            "ai_accuracy_score": 68,
            "matched_name": "",
            "funeral_home_name": "Thompson Funeral Chapel",
            "funeral_address": "926 S Litchfield Rd, Goodyear, AZ 85338",
            "funeral_phone": "",
            "service_type": "funeral_home",
            "service_date": "March 24, 2026",
            "service_time": "11:00 AM",
            "visitation_date": "",
            "visitation_time": "",
            "ceremony_date": "",
            "ceremony_time": "",
            "special_instructions": "",
            "source_urls": "https://www.dignitymemorial.com/obituaries/goodyear-az/louis-alliano-12812070",
            "notes": "",
        }

        adjusted = Funeral_Finder._apply_business_rules(order, parsed)

        self.assertEqual(adjusted["matched_name"], "Louis Alliano")
        self.assertIn(adjusted["name_match_status"], {"exact", "fuzzy"})
        self.assertEqual(adjusted["match_status"], "Found")

    def test_reverify_parse_ai_response_keeps_review_when_source_exists_without_timing(self):
        ai_text = json.dumps(
            {
                "matched_name": "",
                "funeral_home_name": "Paul G. Payne Funeral Home",
                "funeral_address": "178 Main Street, Odessa, ON K0H 2H0",
                "funeral_phone": "",
                "service_type": "funeral_home",
                "funeral_date": "",
                "funeral_time": "",
                "visitation_date": "",
                "visitation_time": "",
                "ceremony_date": "",
                "ceremony_time": "",
                "delivery_recommendation_date": "",
                "delivery_recommendation_time": "",
                "delivery_recommendation_location": "",
                "special_instructions": "",
                "status": "NotFound",
                "AI Accuracy Score": 45,
                "source_urls": ["https://paynefuneralhome.com"],
                "notes": "Venue evidence only",
            }
        )

        parsed = reverify.parse_ai_response(ai_text)

        self.assertEqual(parsed["match_status"], "Review")

    def test_reverify_business_rules_mark_not_found_when_no_valid_person_or_obituary(self):
        record = {
            "ship_name": "John Example",
            "ord_instruct": "",
            "ship_care_of": "Generic Funeral Home",
            "ship_address": "",
        }
        parsed = {
            "match_status": "Review",
            "ai_accuracy_score": 61,
            "matched_name": "",
            "funeral_home_name": "Generic Funeral Home",
            "funeral_address": "123 Main St",
            "funeral_phone": "",
            "service_type": "funeral_home",
            "service_date": "",
            "service_time": "",
            "visitation_date": "",
            "visitation_time": "",
            "ceremony_date": "",
            "ceremony_time": "",
            "special_instructions": "",
            "source_urls": "https://genericfuneralhome.example/",
            "notes": "",
        }

        adjusted = reverify.apply_business_rules(record, parsed)

        self.assertEqual(adjusted["match_status"], "NotFound")
        self.assertIn("no valid obituary or person-level identity confirmation", adjusted["notes"])

    def test_reverify_query_perplexity_uses_response_citations_for_exact_urls(self):
        response_payload = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "matched_name": "Amy Nagy",
                                "funeral_home_name": "William F. Young Funeral Home",
                                "funeral_address": "132 Main St., West Sunbury, PA 16061",
                                "service_type": "funeral_home",
                                "funeral_date": "April 23, 2026",
                                "funeral_time": "6:00 PM",
                                "status": "Found",
                                "AI Accuracy Score": 88,
                                "source_urls": [],
                                "notes": "Found obituary page",
                            }
                        )
                    }
                }
            ],
            "citations": [
                "https://www.legacy.com/us/obituaries/butlereagle/name/amy-nagy-obituary?id=61296576"
            ],
        }
        fake_response = SimpleNamespace(status_code=200, json=lambda: response_payload)

        with patch.object(reverify.requests, "post", return_value=fake_response):
            _, parsed, _ = reverify.query_perplexity("fake-key", "prompt")

        self.assertIn("amy-nagy-obituary", parsed["source_urls"])

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

    def test_reverify_process_record_tries_strategies_until_found(self):
        record = {
            "ship_name": "John Doe",
            "ship_city": "Boston",
            "ship_state": "MA",
            "ship_care_of": "Funeral Home",
            "ord_instruct": "Service Friday 11:00 AM",
        }

        def fake_query(_provider, _api_key, prompt):
            if "Strategy: original" in prompt or "Strategy: normalized_city" in prompt:
                return (
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
                        "ceremony_date": "",
                        "ceremony_time": "",
                        "delivery_recommendation_date": "",
                        "delivery_recommendation_time": "",
                        "delivery_recommendation_location": "",
                        "special_instructions": "",
                        "source_urls": "",
                        "notes": "",
                    },
                    {"model": "sonar-pro"},
                )

            return (
                "{}",
                {
                    "match_status": "Found",
                    "ai_accuracy_score": 88,
                    "funeral_home_name": "Alpha Home",
                    "funeral_address": "123 Main St",
                    "funeral_phone": "",
                    "service_type": "",
                    "service_date": "2026-04-20",
                    "service_time": "11:00 AM",
                    "visitation_date": "",
                    "visitation_time": "",
                    "ceremony_date": "",
                    "ceremony_time": "",
                    "delivery_recommendation_date": "",
                    "delivery_recommendation_time": "",
                    "delivery_recommendation_location": "",
                    "special_instructions": "",
                    "source_urls": ["https://example.com/obit"],
                    "notes": "verified",
                },
                {"model": "sonar-pro"},
            )

        with patch.object(reverify, "query_provider", side_effect=fake_query) as mocked_query:
            result = reverify.process_record("fake-key", deepcopy(record), max_attempts=6)

        self.assertEqual(len(result["attempts"]), 6)
        self.assertEqual([attempt["strategy"] for attempt in result["attempts"]], ["original", "original", "normalized_city", "normalized_city", "expanded_nickname", "expanded_nickname"])
        self.assertEqual(mocked_query.call_count, 6)
        self.assertEqual(result["match_status"], "Found")
        self.assertEqual(result["_strategy"], "expanded_nickname")

    def test_reverify_process_record_single_call_failure_returns_fallback(self):
        record = {
            "ship_name": "John Doe",
            "ship_city": "Boston",
            "ship_state": "MA",
            "ship_care_of": "",
            "ord_instruct": "",
        }

        with patch.object(reverify, "query_provider", side_effect=RuntimeError("boom")) as mocked_query:
            result = reverify.process_record("fake-key", deepcopy(record), max_attempts=6)

        self.assertEqual(mocked_query.call_count, 12)
        self.assertEqual(result["match_status"], "Review")
        self.assertEqual(result["ai_accuracy_score"], 0)
        self.assertEqual(result["notes"], "Multi-strategy reverify search failed")
        self.assertEqual(len(result["attempts"]), 12)
        self.assertEqual(result["attempts"][0]["strategy"], "original")
        self.assertEqual(result["attempts"][-1]["strategy"], "ord_instruct")
        self.assertIn("error", result["attempts"][0])

    def test_reverify_main_uses_cli_attempts_and_template_prompt(self):
        row = {
            "order_id": "12345",
            "ship_name": "John Doe",
            "ship_city": "Boston",
            "ship_state": "MA",
            "ship_zip": "02101",
            "ship_care_of": "",
            "ship_address": "",
            "ship_address_unit": "",
            "ship_country": "US",
            "ord_instruct": "",
            "notes": "",
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            not_found_path = temp_path / "Funeral_data_not_found.csv"
            review_path = temp_path / "Funeral_data_review.csv"
            payload_path = temp_path / "reverify_payload.json"

            with patch.object(sys, "argv", ["reverify.py", "--source", "not_found", "--attempts", "6"]), \
                patch.object(reverify, "SOURCE_FILES", {"not_found": not_found_path, "review": review_path}), \
                patch.object(reverify, "PAYLOAD_PATH", payload_path), \
                patch.object(reverify, "MAIN_CSV_PATH", temp_path / "Funeral_data.csv"), \
                patch.object(reverify, "MAIN_EXCEL_PATH", temp_path / "Funeral_data.xlsx"), \
                patch.object(reverify, "NOT_FOUND_EXCEL_PATH", temp_path / "Funeral_data_not_found.xlsx"), \
                patch.object(reverify, "REVIEW_EXCEL_PATH", temp_path / "Funeral_data_review.xlsx"), \
                patch.object(reverify, "load_dotenv_file"), \
                patch.object(reverify, "_required_env", return_value="fake-key"), \
                patch.object(reverify, "load_logged_ids", return_value=set()), \
                patch.object(reverify, "load_records", side_effect=lambda path: [deepcopy(row)] if path == not_found_path else []), \
                patch.object(reverify, "process_record") as mocked_process_record, \
                patch.object(reverify, "apply_business_rules", side_effect=lambda record, result: result), \
                patch.object(reverify, "append_main_record"), \
                patch.object(reverify, "remove_record"), \
                patch.object(reverify, "upsert_record"), \
                patch.object(reverify, "append_logged_id"), \
                patch.object(reverify, "rebuild_excel_from_csv"):

                (temp_path / "funeral_search_template.md").write_text("TEMPLATE HEADER\n[INPUT CONTEXT]", encoding="utf-8")

                mocked_process_record.return_value = {
                    "match_status": "NotFound",
                    "ai_accuracy_score": 0,
                    "notes": "",
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
                    "attempts": [],
                }

                reverify.main()

            self.assertEqual(mocked_process_record.call_count, 1)
            self.assertEqual(mocked_process_record.call_args.kwargs["max_attempts"], 6)

    def test_reverify_process_record_prepends_template_prompt(self):
        record = {
            "ship_name": "John Doe",
            "ship_city": "Boston",
            "ship_state": "MA",
            "ship_care_of": "",
            "ord_instruct": "",
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            template_path = temp_path / "funeral_search_template.md"
            template_path.write_text("TEMPLATE HEADER\n[INPUT CONTEXT]", encoding="utf-8")

            captured_prompt = {}

            def fake_query(_provider, _api_key, prompt):
                captured_prompt["value"] = prompt
                return (
                    "{}",
                    {
                        "match_status": "Found",
                        "ai_accuracy_score": 92,
                        "funeral_home_name": "Alpha Home",
                        "funeral_address": "123 Main St",
                        "funeral_phone": "",
                        "service_type": "",
                        "service_date": "2026-04-20",
                        "service_time": "11:00 AM",
                        "visitation_date": "",
                        "visitation_time": "",
                        "ceremony_date": "",
                        "ceremony_time": "",
                        "delivery_recommendation_date": "",
                        "delivery_recommendation_time": "",
                        "delivery_recommendation_location": "",
                        "special_instructions": "",
                        "source_urls": ["https://example.com/obit"],
                        "notes": "verified",
                    },
                    {"model": "sonar-pro"},
                )

            with patch.object(reverify, "DEFAULT_PROMPT_TEMPLATE", template_path), \
                patch.object(reverify, "query_provider", side_effect=fake_query):
                reverify.process_record("fake-key", deepcopy(record), max_attempts=1)

        self.assertIn("TEMPLATE HEADER", captured_prompt["value"])
        self.assertTrue(captured_prompt["value"].startswith("TEMPLATE HEADER"))

    def test_funeral_finder_build_prompt_cleans_ship_name_for_ai(self):
        order = {
            "ship_name": "c/o The Family of Dr. John Smith",
            "ship_city": "Boston",
            "ship_state": "MA",
            "ship_zip": "02101",
            "ship_care_of": "",
            "ship_address": "",
            "ship_address_unit": "",
            "ship_country": "US",
            "ord_instruct": "",
        }

        prompt = Funeral_Finder.build_prompt(order, "")

        self.assertIn("Name: John Smith", prompt)
        self.assertNotIn("c/o", prompt.lower())

    def test_funeral_finder_system_prompt_supports_partial_timing_with_identity(self):
        prompt = Funeral_Finder.SYSTEM_PROMPT

        self.assertIn("date OR time", prompt)
        self.assertIn("identity confirmation", prompt)
        self.assertIn("Set Review, not NotFound", prompt)

    def test_reverify_build_prompt_supports_partial_timing_with_identity(self):
        record = {
            "ship_name": "John Doe",
            "ship_city": "Boston",
            "ship_state": "MA",
            "ship_care_of": "",
            "ord_instruct": "",
        }

        prompt = reverify.build_prompt(record, "original")

        self.assertIn("date OR time", prompt)
        self.assertIn("identity confirmation", prompt)
        self.assertIn("Set Review, not NotFound", prompt)

    def test_funeral_finder_parse_ai_response_date_only_stays_review(self):
        ai_text = json.dumps(
            {
                "funeral_home_name": "Alpha Home",
                "funeral_date": "2026-04-20",
                "funeral_time": "",
                "visitation_date": "",
                "visitation_time": "",
                "delivery_recommendation_date": "",
                "delivery_recommendation_time": "",
                "status": "Found",
                "AI Accuracy Score": 88,
                "source_urls": ["https://example.com/obit"],
                "notes": "verified",
            }
        )

        parsed = Funeral_Finder.parse_ai_response(ai_text)

        self.assertEqual(parsed["match_status"], "Review")
        self.assertIn("date-only", parsed["notes"])

    def test_funeral_finder_parse_ai_response_found_without_any_timing_becomes_review(self):
        ai_text = json.dumps(
            {
                "funeral_home_name": "Alpha Home",
                "funeral_date": "",
                "funeral_time": "",
                "visitation_date": "",
                "visitation_time": "",
                "ceremony_date": "",
                "ceremony_time": "",
                "status": "Found",
                "AI Accuracy Score": 88,
                "source_urls": ["https://example.com/obit"],
                "notes": "verified",
            }
        )

        parsed = Funeral_Finder.parse_ai_response(ai_text)

        self.assertEqual(parsed["match_status"], "Review")

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

    def test_reverify_parse_ai_response_without_datetime_pair_is_review_with_notes(self):
        ai_text = json.dumps(
            {
                "funeral_home_name": "Beta Home",
                "funeral_date": "",
                "funeral_time": "02:15 PM",
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
        self.assertEqual(parsed["service_time"], "02:15 PM")
        self.assertEqual(parsed["match_status"], "Review")
        self.assertIn("time-only", parsed["notes"])

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

    def test_reverify_apply_business_rules_keeps_review_without_datetime_pair_when_sources_exist(self):
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
            "source_urls": ["https://example.com/obit"],
            "special_instructions": "",
            "notes": "",
        }

        adjusted = reverify.apply_business_rules(record, parsed)

        self.assertEqual(adjusted["match_status"], "Review")

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

    def test_reverify_run_guard_different_attempts_is_not_treated_as_same_config(self):
        row = {
            "order_id": "12345",
            "ship_name": "John Doe",
            "ship_city": "Boston",
            "ship_state": "MA",
            "ship_zip": "02101",
            "ship_care_of": "",
            "ship_address": "",
            "ship_address_unit": "",
            "ship_country": "US",
            "ord_instruct": "",
            "notes": "",
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            not_found_path = temp_path / "Funeral_data_not_found.csv"
            review_path = temp_path / "Funeral_data_review.csv"
            payload_path = temp_path / "reverify_payload.json"
            run_guard_path = temp_path / "reverify_run_state.json"

            run_guard_path.write_text(
                json.dumps(
                    {
                        "run_key": reverify._run_guard_key(),
                        "status": "running",
                        "source": "not_found",
                        "attempts": 1,
                        "force": False,
                        "limit": 0,
                        "started_at": reverify.get_now_iso(),
                    }
                ),
                encoding="utf-8",
            )

            with patch.object(sys, "argv", ["reverify.py", "--source", "not_found", "--attempts", "6"]), \
                patch.object(reverify, "SOURCE_FILES", {"not_found": not_found_path, "review": review_path}), \
                patch.object(reverify, "PAYLOAD_PATH", payload_path), \
                patch.object(reverify, "RUN_GUARD_PATH", run_guard_path), \
                patch.object(reverify, "MAIN_CSV_PATH", temp_path / "Funeral_data.csv"), \
                patch.object(reverify, "MAIN_EXCEL_PATH", temp_path / "Funeral_data.xlsx"), \
                patch.object(reverify, "NOT_FOUND_EXCEL_PATH", temp_path / "Funeral_data_not_found.xlsx"), \
                patch.object(reverify, "REVIEW_EXCEL_PATH", temp_path / "Funeral_data_review.xlsx"), \
                patch.object(reverify, "load_dotenv_file"), \
                patch.object(reverify, "_required_env", return_value="fake-key"), \
                patch.object(reverify, "load_logged_ids", return_value=set()), \
                patch.object(reverify, "load_records", side_effect=lambda path: [deepcopy(row)] if path == not_found_path else []), \
                patch.object(reverify, "process_record") as mocked_process_record, \
                patch.object(reverify, "apply_business_rules", side_effect=lambda record, result: result), \
                patch.object(reverify, "append_main_record"), \
                patch.object(reverify, "remove_record"), \
                patch.object(reverify, "upsert_record"), \
                patch.object(reverify, "append_logged_id"), \
                patch.object(reverify, "rebuild_excel_from_csv"):

                mocked_process_record.return_value = {
                    "match_status": "NotFound",
                    "ai_accuracy_score": 0,
                    "notes": "",
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
                    "attempts": [],
                }

                reverify.main()

            self.assertEqual(mocked_process_record.call_count, 1)

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
