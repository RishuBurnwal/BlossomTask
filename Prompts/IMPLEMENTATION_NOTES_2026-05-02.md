# Implementation Notes - 2026-05-02

## Completed in this pass

- `terminal_runner.py`
  - Added atomic JSON writes for runner state files.
  - Added stale `running` state recovery on startup and for `--once` runs.
  - Added `owner_pid`/`owner_run_id` to `pipeline_state.json` writes.
  - Changed scheduled cycles after the first to reset checkpoint but keep `start_mode=continue`, so `--force` is not automatically passed.
  - Added non-interactive `--once --mode=continue` support for backend cron.

- `backend/server.js`
  - Added in-memory rate limiting for auth, pipeline trigger, schedule trigger, and file APIs.
  - Changed scheduled pipeline execution to spawn `terminal_runner.py --once --mode=continue`.
  - Added terminal-runner state awareness before schedule triggers.
  - Fixed duplicate function declarations that prevented `node --check` from passing.

- `main.py`
  - Password changes now revoke active sessions before updating `password_hash`.
  - Auto-generated first admin credentials are saved to `backend/data/INITIAL_CREDENTIALS.txt`.
  - Startup warns if the initial credentials file still exists.

- `Scripts/GetTask.py`
  - Added ClosingTask log checks so already-closed order IDs are excluded from new GetTask output unless `--force` is used.

- `.env.example`
  - Added the missing example environment file referenced by README and prompt docs.

## Existing behavior confirmed

- `Scripts/reverify.py` already has `reverify_logs.txt`, daily reverify logs, `--force` handling, skip filtering, and per-record append behavior. No duplicate idempotency implementation was added.

## Verification run

- `python -c "import ast ..."` syntax checks passed for:
  - `terminal_runner.py`
  - `main.py`
  - `Scripts/GetTask.py`
  - `Scripts/reverify.py`
- `node --check backend/server.js` passed.
- `python terminal_runner.py --help` showed the new `--once` options.
- Runner atomic write smoke test passed inside the workspace.
- Stale `pipeline_state.json` recovery test reset a fake dead `running` state to `failed`.
- Session revocation smoke test created a temporary user/session and confirmed `revoked_at` is set after password change.

## Not fully exercised here

- Full live pipeline execution was not run because it can call CRM and AI providers.
- Backend schedule firing was not live-tested against a running server in this pass.
