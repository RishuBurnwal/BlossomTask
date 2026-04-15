import unittest
from datetime import datetime

from terminal_runner import (
    ScriptRunResult,
    TerminalPipelineRunner,
    determine_start_index,
    format_duration_label,
    parse_schedule_input,
    parse_processed_count,
    total_duration_seconds,
)


class _FakeStore:
    def __init__(self, checkpoint=None):
        self.checkpoint = checkpoint or {
            "last_successful_script": None,
            "completed_scripts": [],
            "updated_at": None,
        }
        self.last_state = None
        self.last_log = None
        self.summary = None
        self.control = {"stop_requested": False, "reason": None}

    def load_checkpoint(self):
        return dict(self.checkpoint)

    def save_checkpoint(self, script_id, completed_scripts):
        self.checkpoint = {
            "last_successful_script": script_id,
            "completed_scripts": list(completed_scripts),
            "updated_at": "now",
        }

    def reset_checkpoint(self):
        self.checkpoint = {
            "last_successful_script": None,
            "completed_scripts": [],
            "updated_at": "now",
        }

    def save_state(self, payload):
        self.last_state = dict(payload)

    def save_summary(self, payload):
        self.summary = dict(payload)

    def log_event(self, event):
        self.last_log = dict(event)

    def load_control(self):
        return dict(self.control)

    def save_control(self, payload):
        self.control = dict(payload)

    def clear_stop_request(self):
        self.control["stop_requested"] = False


class TerminalRunnerTests(unittest.TestCase):
    def test_determine_start_index_continue(self):
        sequence = ["get-task", "get-order-inquiry", "funeral-finder"]
        self.assertEqual(determine_start_index(sequence, "get-task", "continue"), 1)

    def test_determine_start_index_fresh(self):
        sequence = ["get-task", "get-order-inquiry"]
        self.assertEqual(determine_start_index(sequence, "get-task", "fresh"), 0)

    def test_determine_start_index_missing_checkpoint(self):
        sequence = ["get-task", "get-order-inquiry"]
        self.assertEqual(determine_start_index(sequence, "unknown", "continue"), 0)

    def test_parse_schedule_input_minutes(self):
        plan = parse_schedule_input("30")
        self.assertEqual(plan["kind"], "interval")
        self.assertEqual(plan["minutes"], 30)

    def test_parse_schedule_input_cron_interval(self):
        plan = parse_schedule_input("*/15 * * * *")
        self.assertEqual(plan["kind"], "interval")
        self.assertEqual(plan["minutes"], 15)

    def test_parse_schedule_input_daily_time(self):
        now = datetime(2026, 4, 2, 12, 0, 0)
        plan = parse_schedule_input("23:30")
        self.assertEqual(plan["kind"], "daily")
        self.assertEqual(plan["hour"], 23)
        self.assertEqual(plan["minute"], 30)

    def test_parse_schedule_input_invalid(self):
        with self.assertRaises(ValueError):
            parse_schedule_input("every-time")

    def test_parse_processed_count(self):
        self.assertEqual(parse_processed_count("Processed 42 records"), 42)
        self.assertEqual(parse_processed_count("processed so far: 7"), 7)
        self.assertIsNone(parse_processed_count("no metrics here"))

    def test_format_duration_label(self):
        self.assertEqual(format_duration_label(None), "n/a")
        self.assertEqual(format_duration_label(0), "0s")
        self.assertEqual(format_duration_label(7), "7s")
        self.assertEqual(format_duration_label(125), "2m 5s")

    def test_total_duration_seconds(self):
        self.assertIsNone(total_duration_seconds([]))
        self.assertIsNone(total_duration_seconds([{"script_id": "a"}]))
        self.assertEqual(
            total_duration_seconds(
                [
                    {"script_id": "a", "duration_sec": 10},
                    {"script_id": "b", "duration_sec": 5},
                    {"script_id": "c", "duration_sec": None},
                ]
            ),
            15,
        )

    def test_run_script_with_retry_stops_after_max(self):
        runner = TerminalPipelineRunner(input_fn=lambda _x: "1", sleep_fn=lambda _x: None)
        runner.store = _FakeStore()

        calls = {"count": 0}

        def _always_fail(_script_id, _updater_mode, _reverify_source, _force):
            calls["count"] += 1
            return ScriptRunResult(
                script_id="get-task",
                success=False,
                exit_code=1,
                processed_count=None,
                attempts=1,
                error_reason="boom",
            )

        runner._run_single_script = _always_fail
        result = runner._run_script_with_retry("get-task", "complete", "both", False, {"run_mode": "single"})
        self.assertFalse(result.success)
        self.assertEqual(result.attempts, 3)
        self.assertEqual(calls["count"], 3)

    def test_execute_once_returns_interrupted_status(self):
        runner = TerminalPipelineRunner(input_fn=lambda _x: "1", sleep_fn=lambda _x: None)
        runner.store = _FakeStore()

        def _interrupt_result(_script_id, _updater_mode, _reverify_source, _force):
            return ScriptRunResult(
                script_id="get-task",
                success=False,
                exit_code=130,
                processed_count=None,
                attempts=1,
                error_reason="Interrupted",
                interrupted=True,
            )

        runner._run_single_script = _interrupt_result
        result = runner._execute_once(
            start_mode="fresh",
            run_mode="single",
            sequence=["get-task"],
            updater_mode="complete",
            reverify_source="both",
            cycle=1,
        )
        self.assertEqual(result["status"], "stopped")

    def test_execute_once_noop_checkpoint_sets_success_state(self):
        checkpoint = {
            "last_successful_script": "closing-task",
            "completed_scripts": ["get-task", "get-order-inquiry", "funeral-finder", "updater", "closing-task"],
            "updated_at": "now",
        }
        runner = TerminalPipelineRunner(input_fn=lambda _x: "1", sleep_fn=lambda _x: None)
        fake_store = _FakeStore(checkpoint=checkpoint)
        runner.store = fake_store

        result = runner._execute_once(
            start_mode="continue",
            run_mode="single",
            sequence=["get-task", "get-order-inquiry", "funeral-finder", "updater", "closing-task"],
            updater_mode="complete",
            reverify_source="both",
            cycle=2,
        )

        self.assertEqual(result["status"], "success")
        self.assertEqual(fake_store.last_state.get("status"), "success")

    def test_external_stop_request_marks_runner_stopped(self):
        runner = TerminalPipelineRunner(input_fn=lambda _x: "1", sleep_fn=lambda _x: None)
        fake_store = _FakeStore()
        fake_store.control = {"stop_requested": True, "reason": "UI stop"}
        runner.store = fake_store

        runner._sync_external_stop_request()

        self.assertTrue(runner.stop_requested)
        self.assertEqual(runner.interruption_reason, "UI stop")


if __name__ == "__main__":
    unittest.main()
