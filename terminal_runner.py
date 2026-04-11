#!/usr/bin/env python3
"""Terminal orchestration runner for BlossomTask pipeline.

This module adds an interactive, resumable, interruption-safe terminal runner
without changing core business logic inside existing Scripts/*.py files.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
import traceback
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Dict, List, Optional

ROOT = Path(__file__).resolve().parent
SCRIPTS_DIR = ROOT / "Scripts"

CHECKPOINT_FILE = ROOT / "pipeline_checkpoint.json"
STATE_FILE = ROOT / "pipeline_state.json"
SUMMARY_FILE = ROOT / "pipeline_last_summary.json"
LOG_FILE = ROOT / "pipeline_logs.jsonl"

PIPELINE_SEQUENCE = [
    "get-task",
    "get-order-inquiry",
    "funeral-finder",
    "reverify",
    "updater",
    "closing-task",
]

SCRIPT_CONFIG: Dict[str, Dict[str, str]] = {
    "get-task": {"name": "GetTask", "file": str(SCRIPTS_DIR / "GetTask.py")},
    "get-order-inquiry": {"name": "GetOrderInquiry", "file": str(SCRIPTS_DIR / "GetOrderInquiry.py")},
    "funeral-finder": {"name": "Funeral_Finder", "file": str(SCRIPTS_DIR / "Funeral_Finder.py")},
    "reverify": {"name": "Reverify", "file": str(SCRIPTS_DIR / "reverify.py")},
    "updater": {"name": "Updater", "file": str(SCRIPTS_DIR / "Updater.py")},
    "closing-task": {"name": "ClosingTask", "file": str(SCRIPTS_DIR / "ClosingTask.py")},
}

UPDATER_MODES = ["complete", "found_only", "not_found", "review"]
MAX_RETRIES = 3


@dataclass
class ScriptRunResult:
    script_id: str
    success: bool
    exit_code: int
    processed_count: Optional[int]
    attempts: int
    error_reason: Optional[str] = None
    interrupted: bool = False
    duration_sec: Optional[int] = None


class RuntimeStore:
    """File-based state store for checkpoint, runtime state, and structured logs."""

    @staticmethod
    def _safe_read_json(path: Path, default: dict) -> dict:
        if not path.exists():
            return dict(default)
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return dict(default)

    @staticmethod
    def _write_json(path: Path, payload: dict) -> None:
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def load_checkpoint(self) -> dict:
        return self._safe_read_json(
            CHECKPOINT_FILE,
            {"last_successful_script": None, "completed_scripts": [], "updated_at": None},
        )

    def save_checkpoint(self, script_id: str, completed_scripts: List[str]) -> None:
        payload = {
            "last_successful_script": script_id,
            "completed_scripts": completed_scripts,
            "updated_at": now_iso(),
        }
        self._write_json(CHECKPOINT_FILE, payload)

    def reset_checkpoint(self) -> None:
        payload = {"last_successful_script": None, "completed_scripts": [], "updated_at": now_iso()}
        self._write_json(CHECKPOINT_FILE, payload)

    def save_state(self, payload: dict) -> None:
        content = dict(payload)
        content["updated_at"] = now_iso()
        self._write_json(STATE_FILE, content)

    def save_summary(self, payload: dict) -> None:
        self._write_json(SUMMARY_FILE, payload)

    def log_event(self, event: dict) -> None:
        entry = {"timestamp": now_iso(), **event}
        with LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=True) + "\n")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def format_duration_label(seconds: Optional[int]) -> str:
    if seconds is None:
        return "n/a"
    total = max(0, int(seconds))
    if total < 60:
        return f"{total}s"
    minutes = total // 60
    rem = total % 60
    return f"{minutes}m {rem}s"


def total_duration_seconds(script_results: List[dict]) -> Optional[int]:
    values = [item.get("duration_sec") for item in script_results if item.get("duration_sec") is not None]
    if not values:
        return None
    return int(sum(values))


def parse_processed_count(line: str) -> Optional[int]:
    patterns = [
        r"processed\s+so\s+far\s*:\s*(\d+)",
        r"Processed\s+(\d+)\s+records",
        r"processed\s*:\s*(\d+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, line, flags=re.IGNORECASE)
        if match:
            return int(match.group(1))
    return None


def determine_start_index(sequence: List[str], last_successful_script: Optional[str], start_mode: str) -> int:
    if start_mode != "continue":
        return 0
    if not last_successful_script:
        return 0
    try:
        return sequence.index(last_successful_script) + 1
    except ValueError:
        return 0


def parse_schedule_input(raw: str) -> dict:
    text = raw.strip()

    if text.isdigit():
        minutes = int(text)
        if minutes <= 0:
            raise ValueError("Interval minutes must be greater than 0")
        return {"kind": "interval", "minutes": minutes}

    cron_match = re.fullmatch(r"\*/(\d+)\s+\*\s+\*\s+\*\s+\*", text)
    if cron_match:
        minutes = int(cron_match.group(1))
        if minutes <= 0:
            raise ValueError("Cron interval must be greater than 0")
        return {"kind": "interval", "minutes": minutes}

    hhmm_match = re.fullmatch(r"([01]?\d|2[0-3]):([0-5]\d)", text)
    if hhmm_match:
        return {"kind": "daily", "hour": int(hhmm_match.group(1)), "minute": int(hhmm_match.group(2))}

    raise ValueError("Unsupported schedule format")


def next_run_at(plan: dict, now: Optional[datetime] = None) -> datetime:
    current = now or datetime.now().astimezone()
    if plan["kind"] == "interval":
        return current + timedelta(minutes=plan["minutes"])

    target = current.replace(hour=plan["hour"], minute=plan["minute"], second=0, microsecond=0)
    if target <= current:
        target = target + timedelta(days=1)
    return target


class TerminalPipelineRunner:
    def __init__(
        self,
        input_fn: Callable[[str], str] = input,
        sleep_fn: Callable[[float], None] = time.sleep,
    ) -> None:
        self.input = input_fn
        self.sleep = sleep_fn
        self.store = RuntimeStore()
        self.stop_requested = False
        self.interruption_reason: Optional[str] = None
        self._install_signal_handlers()

    def _install_signal_handlers(self) -> None:
        def _handle(signum, _frame):
            self.stop_requested = True
            self.interruption_reason = f"Signal interrupt ({signum})"

        signal.signal(signal.SIGINT, _handle)
        if hasattr(signal, "SIGTERM"):
            signal.signal(signal.SIGTERM, _handle)

    def run(self) -> int:
        print("\n=== BlossomTask Terminal Pipeline Runner ===")
        start_mode = self._ask_start_mode()
        run_mode = self._ask_run_mode()
        execution_mode = self._ask_execution_mode()

        sequence = self._resolve_sequence(execution_mode)
        updater_mode = self._ask_updater_mode(sequence)
        reverify_source = self._ask_reverify_source(sequence)

        schedule_plan = None
        if run_mode == "scheduled":
            schedule_plan = self._ask_schedule_plan()

        return self._run_loop(start_mode, run_mode, sequence, updater_mode, reverify_source, schedule_plan)

    def _ask_start_mode(self) -> str:
        while True:
            choice = self.input("Start mode: [1] Fresh start, [2] Continue from last checkpoint: ").strip()
            if choice == "1":
                return "fresh"
            if choice == "2":
                return "continue"
            print("Please choose 1 or 2.")

    def _ask_run_mode(self) -> str:
        while True:
            choice = self.input("Run type: [1] Single run, [2] Scheduled/cron run: ").strip()
            if choice == "1":
                return "single"
            if choice == "2":
                return "scheduled"
            print("Please choose 1 or 2.")

    def _ask_execution_mode(self) -> str:
        while True:
            choice = self.input("Execution: [1] Complete pipeline, [2] Manual script-by-script debug: ").strip()
            if choice == "1":
                return "complete"
            if choice == "2":
                return "manual"
            print("Please choose 1 or 2.")

    def _resolve_sequence(self, execution_mode: str) -> List[str]:
        if execution_mode == "complete":
            return list(PIPELINE_SEQUENCE)

        print("\nSelect scripts for debug run (comma-separated indexes):")
        for idx, script_id in enumerate(PIPELINE_SEQUENCE, start=1):
            print(f"  [{idx}] {SCRIPT_CONFIG[script_id]['name']} ({script_id})")

        while True:
            raw = self.input("Choose scripts (example: 1,3,5): ").strip()
            if not raw:
                print("Selection cannot be empty.")
                continue
            try:
                indexes = [int(part.strip()) for part in raw.split(",")]
            except ValueError:
                print("Invalid selection. Use comma-separated numbers.")
                continue
            selected: List[str] = []
            valid = True
            for index in indexes:
                if index < 1 or index > len(PIPELINE_SEQUENCE):
                    valid = False
                    break
                selected.append(PIPELINE_SEQUENCE[index - 1])
            if not valid:
                print("One or more indexes are out of range.")
                continue
            deduped = []
            for script_id in selected:
                if script_id not in deduped:
                    deduped.append(script_id)
            return deduped

    def _ask_updater_mode(self, sequence: List[str]) -> str:
        if "updater" not in sequence:
            return "complete"

        print("\nUpdater preference (for Updater.py):")
        for idx, mode in enumerate(UPDATER_MODES, start=1):
            print(f"  [{idx}] {mode}")
        while True:
            choice = self.input("Select updater mode [1-4]: ").strip()
            if choice in {"1", "2", "3", "4"}:
                return UPDATER_MODES[int(choice) - 1]
            print("Please select a valid option 1-4.")

    def _ask_reverify_source(self, sequence: List[str]) -> str:
        if "reverify" not in sequence:
            return "both"

        print("\nReverify source preference:")
        choices = ["both", "not_found", "review"]
        for idx, source in enumerate(choices, start=1):
            print(f"  [{idx}] {source}")
        while True:
            choice = self.input("Select reverify source [1-3]: ").strip()
            if choice in {"1", "2", "3"}:
                return choices[int(choice) - 1]
            print("Please select a valid option 1-3.")

    def _ask_schedule_plan(self) -> dict:
        print("\nSchedule input examples:")
        print("  30                -> every 30 minutes")
        print("  */45 * * * *      -> every 45 minutes")
        print("  23:15             -> once daily at 23:15 local time")
        while True:
            raw = self.input("Enter interval or custom cron timing: ").strip()
            try:
                return parse_schedule_input(raw)
            except ValueError as exc:
                print(f"Invalid schedule: {exc}")

    def _run_loop(
        self,
        start_mode: str,
        run_mode: str,
        sequence: List[str],
        updater_mode: str,
        reverify_source: str,
        schedule_plan: Optional[dict],
    ) -> int:
        cycle = 0
        while True:
            cycle += 1
            if self.stop_requested:
                self._flush_interrupt_state(run_mode, sequence, updater_mode, reverify_source, cycle)
                return 130

            result = self._execute_once(start_mode, run_mode, sequence, updater_mode, reverify_source, cycle)
            result_total_duration = total_duration_seconds(result.get("script_results", []))
            result["total_duration_sec"] = result_total_duration
            self.store.save_summary(result)
            self.store.log_event(
                {
                    "event": "run_cycle_summary",
                    "cycle": cycle,
                    "status": result.get("status"),
                    "total_duration_sec": result_total_duration,
                    "script_count": len(result.get("script_results", [])),
                }
            )
            self._print_run_summary(result)

            if result["status"] == "interrupted":
                return 130

            if result["status"] != "success":
                return 1

            if run_mode != "scheduled":
                return 0

            assert schedule_plan is not None
            print("Waiting for next run")
            next_time = next_run_at(schedule_plan)
            self._countdown_until(next_time)

            # After first cycle, continue mode is more useful than forcing reset.
            start_mode = "continue"

    def _execute_once(
        self,
        start_mode: str,
        run_mode: str,
        sequence: List[str],
        updater_mode: str,
        reverify_source: str,
        cycle: int,
    ) -> dict:
        checkpoint = self.store.load_checkpoint()
        if start_mode == "fresh":
            self.store.reset_checkpoint()
            checkpoint = self.store.load_checkpoint()

        start_index = determine_start_index(sequence, checkpoint.get("last_successful_script"), start_mode)
        completed = list(checkpoint.get("completed_scripts") or [])

        run_context = {
            "run_mode": run_mode,
            "execution_mode": "complete" if sequence == PIPELINE_SEQUENCE else "manual",
            "start_mode": start_mode,
            "updater_mode": updater_mode,
            "reverify_source": reverify_source,
            "cycle": cycle,
            "sequence": sequence,
            "start_index": start_index,
        }
        self.store.save_state({"status": "running", **run_context})
        self.store.log_event({"event": "run_started", **run_context})

        print(f"\nRunning {'complete pipeline' if sequence == PIPELINE_SEQUENCE else 'manual pipeline'}")
        script_results: List[dict] = []

        if start_index >= len(sequence):
            print("All scripts already completed in checkpoint. Nothing to run.")
            self.store.save_state({"status": "success", "reason": "Nothing to run", **run_context})
            self.store.log_event({"event": "run_completed", "reason": "nothing_to_run", **run_context})
            return {
                "status": "success",
                "message": "No remaining scripts to run",
                "script_results": script_results,
                "run_context": run_context,
                "next_scheduled_time": None,
            }

        for script_id in sequence[start_index:]:
            if self.stop_requested:
                self._flush_interrupt_state(run_mode, sequence, updater_mode, reverify_source, cycle)
                return {
                    "status": "interrupted",
                    "message": "Interrupted by user",
                    "script_results": script_results,
                    "run_context": run_context,
                    "next_scheduled_time": None,
                }

            print(f"Executing script {script_id}")
            self.store.log_event({
                "event": "script_started",
                "script": script_id,
                "step": sequence.index(script_id) + 1,
                "total_steps": len(sequence),
                **run_context,
            })

            success_result = self._run_script_with_retry(
                script_id=script_id,
                updater_mode=updater_mode,
                reverify_source=reverify_source,
                force=(start_mode == "fresh"),
                run_context=run_context,
            )
            script_results.append({
                "script_id": success_result.script_id,
                "status": "success" if success_result.success else "failed",
                "exit_code": success_result.exit_code,
                "processed_count": success_result.processed_count,
                "attempts": success_result.attempts,
                "error_reason": success_result.error_reason,
                "duration_sec": success_result.duration_sec,
            })

            if not success_result.success:
                if success_result.interrupted:
                    self._flush_interrupt_state(run_mode, sequence, updater_mode, reverify_source, cycle)
                    return {
                        "status": "interrupted",
                        "message": "Interrupted by user",
                        "script_results": script_results,
                        "run_context": run_context,
                        "next_scheduled_time": None,
                    }

                message = (
                    "Graceful exit: script failed after retries | "
                    f"script={script_id} | retries={success_result.attempts} | "
                    f"last_successful={completed[-1] if completed else 'none'}"
                )
                self.store.save_state({"status": "failed", "reason": message, **run_context})
                self.store.log_event({
                    "event": "run_failed",
                    "script": script_id,
                    "reason": success_result.error_reason,
                    "retries": success_result.attempts,
                    "last_successful_script": completed[-1] if completed else None,
                    **run_context,
                })
                return {
                    "status": "failed",
                    "message": message,
                    "script_results": script_results,
                    "run_context": run_context,
                    "next_scheduled_time": None,
                }

            completed.append(script_id)
            self.store.save_checkpoint(script_id, completed)
            self.store.log_event({
                "event": "script_completed",
                "script": script_id,
                "processed_count": success_result.processed_count,
                "attempts": success_result.attempts,
                "duration_sec": success_result.duration_sec,
                **run_context,
            })
            print(f"Script {script_id} completed")
            if success_result.processed_count is not None:
                print(f"Processed {success_result.processed_count} records")
            if success_result.duration_sec is not None:
                print(f"Duration: {format_duration_label(success_result.duration_sec)}")

        self.store.save_state({"status": "success", **run_context})
        self.store.log_event({"event": "run_completed", **run_context})
        return {
            "status": "success",
            "message": "Pipeline completed successfully",
            "script_results": script_results,
            "run_context": run_context,
            "next_scheduled_time": None,
        }

    def _run_script_with_retry(self, script_id: str, updater_mode: str, reverify_source: str, force: bool, run_context: dict) -> ScriptRunResult:
        last_error: Optional[str] = None
        for attempt in range(1, MAX_RETRIES + 1):
            result = self._run_single_script(script_id, updater_mode, reverify_source, force)
            if result.interrupted:
                result.attempts = attempt
                return result
            if result.success:
                result.attempts = attempt
                return result
            last_error = result.error_reason
            self.store.log_event({
                "event": "script_retry",
                "script": script_id,
                "attempt": attempt,
                "reason": last_error,
                **run_context,
            })
            if attempt < MAX_RETRIES:
                print(f"Retry {attempt}/{MAX_RETRIES - 1} for script {script_id}")

        return ScriptRunResult(
            script_id=script_id,
            success=False,
            exit_code=1,
            processed_count=None,
            attempts=MAX_RETRIES,
            error_reason=last_error or "Unknown failure",
        )

    def _run_single_script(self, script_id: str, updater_mode: str, reverify_source: str, force: bool) -> ScriptRunResult:
        config = SCRIPT_CONFIG[script_id]
        cmd = [sys.executable, config["file"]]

        if force:
            cmd.append("--force")
        if script_id == "updater":
            cmd.extend(["--mode", updater_mode])
        if script_id == "reverify":
            cmd.extend(["--source", reverify_source])

        env = os.environ.copy()
        if script_id == "updater":
            env["RUN_MODE"] = updater_mode
        if script_id == "reverify":
            env["RUN_MODE"] = reverify_source

        started = time.monotonic()

        processed_count: Optional[int] = None
        try:
            process = subprocess.Popen(
                cmd,
                cwd=str(ROOT),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )

            assert process.stdout is not None
            for raw_line in process.stdout:
                line = raw_line.rstrip("\n")
                if line:
                    print(f"[{config['name']}] {line}")
                    parsed = parse_processed_count(line)
                    if parsed is not None:
                        processed_count = parsed
                if self.stop_requested and process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                    break

            exit_code = process.wait()
            if self.stop_requested:
                elapsed = int(time.monotonic() - started)
                return ScriptRunResult(
                    script_id=script_id,
                    success=False,
                    exit_code=exit_code,
                    processed_count=processed_count,
                    attempts=1,
                    error_reason=self.interruption_reason or "Interrupted by user",
                    interrupted=True,
                    duration_sec=elapsed,
                )
            if exit_code == 0:
                elapsed = int(time.monotonic() - started)
                return ScriptRunResult(
                    script_id=script_id,
                    success=True,
                    exit_code=0,
                    processed_count=processed_count,
                    attempts=1,
                    duration_sec=elapsed,
                )

            elapsed = int(time.monotonic() - started)
            return ScriptRunResult(
                script_id=script_id,
                success=False,
                exit_code=exit_code,
                processed_count=processed_count,
                attempts=1,
                error_reason=f"Exit code {exit_code}",
                duration_sec=elapsed,
            )
        except Exception as exc:
            elapsed = int(time.monotonic() - started)
            return ScriptRunResult(
                script_id=script_id,
                success=False,
                exit_code=1,
                processed_count=processed_count,
                attempts=1,
                error_reason=f"{exc}: {traceback.format_exc(limit=2)}",
                duration_sec=elapsed,
            )

    def _countdown_until(self, target_time: datetime) -> None:
        while True:
            if self.stop_requested:
                return
            now = datetime.now().astimezone()
            remaining = int((target_time - now).total_seconds())
            if remaining <= 0:
                print("\nStarting next scheduled run now.")
                return
            hh = remaining // 3600
            mm = (remaining % 3600) // 60
            ss = remaining % 60
            local_target = target_time.strftime("%Y-%m-%d %H:%M:%S %Z")
            print(
                f"\rNext run in {hh:02d}:{mm:02d}:{ss:02d} | at local time {local_target}",
                end="",
                flush=True,
            )
            self.sleep(1)

    def _print_run_summary(self, result: dict) -> None:
        print("\n\nRun summary")
        print(f"Status: {result['status']}")
        print(f"Message: {result['message']}")
        print(f"Total duration: {format_duration_label(result.get('total_duration_sec'))}")
        print("Per-script summary:")
        for item in result.get("script_results", []):
            print(
                f"- {item['script_id']}: {item['status']} | "
                f"attempts={item['attempts']} | "
                f"processed={item['processed_count'] if item['processed_count'] is not None else 'n/a'} | "
                f"duration={format_duration_label(item.get('duration_sec'))}"
            )

    def _flush_interrupt_state(self, run_mode: str, sequence: List[str], updater_mode: str, reverify_source: str, cycle: int) -> None:
        message = self.interruption_reason or "Interrupted by user"
        self.store.save_state(
            {
                "status": "interrupted",
                "reason": message,
                "run_mode": run_mode,
                "sequence": sequence,
                "updater_mode": updater_mode,
                "reverify_source": reverify_source,
                "cycle": cycle,
            }
        )
        self.store.log_event(
            {
                "event": "interrupted",
                "reason": message,
                "run_mode": run_mode,
                "sequence": sequence,
                "updater_mode": updater_mode,
                "reverify_source": reverify_source,
                "cycle": cycle,
            }
        )
        print(f"\n{message}")


def run_terminal_pipeline() -> int:
    runner = TerminalPipelineRunner()
    try:
        return runner.run()
    except KeyboardInterrupt:
        runner.stop_requested = True
        runner.interruption_reason = "Interrupted by user"
        runner._flush_interrupt_state("unknown", PIPELINE_SEQUENCE, "complete", "both", 0)
        return 130


if __name__ == "__main__":
    raise SystemExit(run_terminal_pipeline())
