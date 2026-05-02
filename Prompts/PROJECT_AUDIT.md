# 📋 PROJECT_AUDIT.md — BlossomTask Complete Bug & Issue Registry [MERGED]
> **Audited by:** Senior Project Analyst (20yr experience perspective)
> **Audit Date:** 2026-05-02 | **Version:** 2.0.0 MERGED
> **Scope:** Full codebase — terminal_runner.py, main.py, backend/server.js, Scripts/*, src/*, docker files
> **Project Purpose:** Funeral flowers company automation — fetch CRM tasks → enrich → AI search obituaries → upload results → close tasks

---

## 🔴 CRITICAL BUGS (Production Blockers)

### BUG-001: Stale "running" State — Pipeline Shows Running When It's Dead
**File:** `pipeline_state.json` (written by `terminal_runner.py`)  
**Severity:** CRITICAL | **Category:** Fake Running / Stale State

**Problem:**
When the pipeline crashes mid-run (Python exception, OOM, power cut, Docker restart), `pipeline_state.json` retains `"status": "running"`. On next startup, the backend/UI reads this stale state and displays "Pipeline Running" even though no process is alive. Users cannot trigger new runs because the system thinks one is already active.

**Root Cause:**
`save_state({"status": "running", ...})` is written at start of `_execute_once()`, but if the process dies without reaching the `save_state({"status": "success"})` at the end, the file is never updated.

**Evidence in code (`terminal_runner.py` ~line 480):**
```python
self.store.save_state({"status": "running", **run_context})
```
No `finally:` block wraps the pipeline execution to guarantee cleanup.

**Fix Required:**
Wrap `_execute_once()` in try/finally. On any uncaught exception, write `status: "failed"` to state file. Additionally, on `backend/server.js` startup, validate PID in state file is alive before trusting `"running"` status.

---

### BUG-002: Cron Job Does NOT Re-trigger Pipeline After Completion
**File:** `backend/server.js` (cron scheduler), `terminal_runner.py`  
**Severity:** CRITICAL | **Category:** Cron/Pipeline Integration Broken

**Problem:**
The backend cron scheduler (`node-cron`) and `terminal_runner.py` are two **separate, disconnected systems**. The backend cron triggers pipeline via HTTP API call to `/api/jobs/run-pipeline`. But `terminal_runner.py` runs as a completely independent subprocess — when its scheduled run completes, it waits for next interval via `_countdown_until()`. These two systems have no shared state mechanism to coordinate re-trigger.

**Specific Issues:**
1. Backend cron fires at its interval but if `terminal_runner.py` is also running in scheduled mode, both try to run simultaneously → lock conflicts
2. When backend cron fires, it calls `/api/jobs/run-pipeline` which spawns scripts directly via `server.js` — completely bypassing `terminal_runner.py`'s checkpoint/state system
3. After `terminal_runner.py` completes a scheduled cycle, it re-enters `_countdown_until()` correctly, but the backend cron independently fires again → DOUBLE EXECUTION
4. `pipeline_state.json` is only written by `terminal_runner.py`, not by backend cron jobs — so the UI status is unreliable for backend-triggered runs

**Fix Required:**
Unify the cron entry point. Either:
- Backend cron calls `terminal_runner.py` as a subprocess (single source of truth)
- OR `terminal_runner.py`'s scheduled loop updates backend-readable state so backend cron defers

---

### BUG-003: reverify.py Over-Processing — Duplicate Order IDs Processed
**File:** `Scripts/reverify.py`  
**Severity:** CRITICAL | **Category:** Data Integrity / Duplicate Processing

**Problem:**
`reverify.py` does NOT maintain its own `logs.txt` (processed ID tracking) like the other scripts (`Funeral_Finder.py`, `Updater.py`, etc.). When called with `--force` (which terminal_runner.py does on `start_mode == "fresh"`), it reprocesses ALL records in `Funeral_data_not_found.csv` and `Funeral_data_review.csv` without checking if those order_ids were already re-verified in a previous run.

**Evidence:**
In `terminal_runner.py` line ~675:
```python
force=(start_mode == "fresh"),
```
This passes `--force` to ALL scripts including reverify, causing complete re-scan every fresh run.

**What Happens:**
- Cycle 1 (fresh): reverify processes order IDs [A, B, C] → uploads to CRM
- Cycle 2 (scheduled, auto-sets fresh): reverify processes [A, B, C] AGAIN → duplicate CRM uploads
- Result: Same funeral home details uploaded 2x, 3x, Nx to CRM

**Fix Required:**
`reverify.py` must implement the same `logs.txt` pattern as other scripts. It should read processed order_ids from its own `Scripts/outputs/Funeral_Finder/reverify_logs.txt` and skip already-processed IDs (unless `--force` is explicitly passed by user, not automatically by scheduler).

---

### BUG-004: Funeral_Finder.py Also Over-Processing on Scheduled Cycles
**File:** `Scripts/Funeral_Finder.py`, `terminal_runner.py`  
**Severity:** CRITICAL | **Category:** Duplicate Processing

**Problem:**
In `terminal_runner.py`, scheduled mode auto-sets `start_mode = "fresh"` for every cycle >1:
```python
if run_mode == "scheduled" and cycle > 1:
    start_mode = "fresh"
```
This means `--force` is passed to Funeral_Finder.py on EVERY scheduled cycle. Funeral_Finder uses `logs.txt` to track processed IDs, but `--force` bypasses this check and reprocesses all rows from `GetOrderInquiry/data.csv`.

**Result:** Every 30 minutes (or whatever cron interval), Funeral_Finder calls Perplexity AI for ALL orders again, not just new ones. This causes:
- Wasted Perplexity API credits (costs real money)
- Duplicate entries in `Funeral_data.csv`
- Inflated API usage bills

**Fix Required:**
Scheduled mode should NOT auto-set `start_mode = "fresh"`. It should use `"continue"` or a smart mode that only processes NEW orders (order_ids not in logs.txt). `--force` should ONLY be passed when user explicitly chooses "Fresh Start" mode.

---

### BUG-005: GetTask.py Fetches ALL Open Tasks Every Run — No Incremental Logic
**File:** `Scripts/GetTask.py`  
**Severity:** HIGH | **Category:** Duplicate Processing / Data Integrity

**Problem:**
GetTask.py fetches ALL open tasks from CRM each run and writes them to `data.csv`, overwriting the previous file. If a task was already processed (Funeral_Finder found it, Updater uploaded, ClosingTask closed it), but the CRM task-close API call failed or was delayed — the task remains "open" in CRM and GetTask fetches it again next cycle, feeding it through the entire pipeline again.

**Fix Required:**
GetTask.py should maintain a `processed_order_ids.txt` and exclude any order_id that appears in `ClosingTask/logs.txt` (successfully closed). Cross-reference with downstream logs before adding to output.

---

### BUG-006: pipeline_state.json Status "running" Check in Backend — Race Condition
**File:** `backend/server.js`  
**Severity:** HIGH | **Category:** Race Condition / Fake Running

**Problem:**
When `/api/jobs/run-pipeline` is called, server.js reads `pipeline_state.json` to check if pipeline is running. But between the read and the new pipeline process spawn, another HTTP request can pass the check and also spawn — creating two concurrent pipeline processes writing to the same CSV files simultaneously.

**Fix Required:**
Use a file-based mutex (write PID to lock file before spawning, check and cleanup on startup).

---

## 🟠 HIGH SEVERITY BUGS

### BUG-007: Docker Production Config Uses Development Mode
**File:** `docker-compose.yml`, `Dockerfile`  
**Severity:** HIGH | **Category:** Production Readiness

**Problem:**
`docker-compose.yml` sets `NODE_ENV=development` and mounts live code (`.:/app` volume). In production this means:
- Vite dev server runs instead of built static files
- Source maps are exposed
- Hot module replacement is enabled (unnecessary overhead)
- Any file change on host immediately affects running container

**Fix Required:**
Add a `docker-compose.prod.yml` that sets `NODE_ENV=production`, runs `npm run build` during image build, and serves static files via the Express server instead of Vite dev server.

---

### BUG-008: .env Files Committed Risk / No Validation on Startup
**File:** `main.py`, `.gitignore`  
**Severity:** HIGH | **Category:** Security

**Problem:**
1. No runtime validation that `.env` values are non-empty before pipeline starts. A blank `PERPLEXITY_API_KEY=` passes preflight but causes API failures mid-pipeline.
2. The CRM URL (`http://ordstatus.tfdash.info:8061/api/...`) is plaintext HTTP — all API keys sent unencrypted over network.
3. `Scripts/.env` and root `.env` are separate files — they can become out of sync silently.

**Fix Required:**
- Add strict preflight validation: check each required key is non-empty
- Enforce HTTPS for CRM API or document the network security assumptions
- Merge to single `.env` with a clear loading hierarchy

---

### BUG-009: Admin Password Not Shown on First Boot (Bootstrap Bug)
**File:** `main.py` — `_seed_default_admin()` function  
**Severity:** HIGH | **Category:** Security / UX

**Problem:**
When no admin user exists, `_seed_default_admin()` creates one with a random password via `secrets.token_urlsafe(18)`. The password is printed ONCE via `print_warn(...)`, but only to the terminal — not saved anywhere accessible. If this runs inside Docker where logs scroll past, the admin password is lost forever.

**Fix Required:**
Write the generated credentials to a secure file (e.g., `backend/data/INITIAL_CREDENTIALS.txt`) with a warning to delete after first login. Also display prominently at startup.

---

### BUG-010: Backend Cron Schedule Persisted in JSON — Not Atomic
**File:** `backend/lib/storage.js`, `backend/data/schedules.json`  
**Severity:** HIGH | **Category:** Data Integrity / Race Condition

**Problem:**
`schedules.json` is read and written using non-atomic file I/O. If the server crashes during a write (mid-JSON), the file becomes corrupt and all schedules are lost. No backup/recovery mechanism exists.

**Fix Required:**
Use write-to-temp-then-rename pattern (atomic write) for all JSON state files, or migrate to SQLite (already used for auth — extend it for schedules).

---

### BUG-011: Session Password Change Does NOT Revoke Active Sessions
**File:** `main.py` — `_update_user_password()` function  
**Severity:** HIGH | **Category:** Security

**Problem:**
The function says in UI: `"All active sessions for this user have been revoked"` — but the actual implementation only updates `password_hash`. It does NOT execute any SQL to set `revoked_at` on existing sessions for that user. This is a **displayed lie** — sessions remain valid after password change.

**Evidence:**
```python
def _update_user_password(conn, username, password):
    # ...
    conn.execute(
        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
        (hash_password(password), timestamp, row["id"]),
    )
    conn.commit()
    # ← NO session revocation here!
```

**Fix Required:**
Add: `conn.execute("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", (timestamp, row["id"]))`

---

### BUG-012: No Rate Limiting on Backend API Endpoints
**File:** `backend/server.js`  
**Severity:** HIGH | **Category:** Security

**Problem:**
The REST API has no rate limiting. An attacker can:
- Hammer `/api/jobs/run-pipeline` to trigger hundreds of concurrent pipelines
- Brute-force login endpoint (if auth is added)
- Exhaust Perplexity API quota via bulk `/api/jobs/run-script` calls

**Fix Required:**
Add `express-rate-limit` middleware. At minimum: 10 req/min for pipeline endpoints, 5 req/min for auth endpoints.

---

## 🟡 MEDIUM SEVERITY BUGS

### BUG-013: pipeline_checkpoint.json Not Cleared on Fresh Scheduled Run (Race)
### BUG-014: parse_processed_count() Only Reads Last Line Match  
### BUG-015: Updater.py File Mode Not Validated Against Actual File Existence
### BUG-016: Frontend Shows Stale Job Status — No Real-time Polling Sync
### BUG-017: Docker Healthcheck Tests Backend Only — Frontend Can Be Dead
### BUG-018: No Retry on CRM API Timeout — Single Request Failure Kills Stage
### BUG-019: Perplexity API Key Exposed in Script Logs
### BUG-020: Output CSV Files Have No Schema Validation

*[See PROJECT_AUDIT.md full section for complete details on each]*

---

## 🟢 LOW SEVERITY / CODE QUALITY ISSUES

### BUG-021 through BUG-025: Minor code quality and documentation issues
*[See PROJECT_AUDIT.md for details]*

---

## 📊 AUDIT SUMMARY TABLE

| ID | Severity | Category | File | Status |
|----|----------|----------|------|--------|
| BUG-001 | 🔴 CRITICAL | Stale Running State | terminal_runner.py | OPEN |
| BUG-002 | 🔴 CRITICAL | Cron-Pipeline Disconnect | server.js + terminal_runner.py | OPEN |
| BUG-003 | 🔴 CRITICAL | reverify.py Over-Processing | Scripts/reverify.py | OPEN |
| BUG-004 | 🔴 CRITICAL | Funeral_Finder Force Re-run | terminal_runner.py | OPEN |
| BUG-005 | 🔴 CRITICAL | GetTask No Incremental Logic | Scripts/GetTask.py | OPEN |
| BUG-006 | 🟠 HIGH | Pipeline Race Condition | backend/server.js | OPEN |
| BUG-007 | 🟠 HIGH | Docker Dev Mode in Production | docker-compose.yml | OPEN |
| BUG-008 | 🟠 HIGH | .env Security / Validation | main.py | OPEN |
| BUG-009 | 🟠 HIGH | Admin Password Lost on Boot | main.py | OPEN |
| BUG-010 | 🟠 HIGH | Non-Atomic JSON Writes | backend/lib/storage.js | OPEN |
| BUG-011 | 🟠 HIGH | Session Not Revoked on PW Change | main.py | OPEN |
| BUG-012 | 🟠 HIGH | No API Rate Limiting | backend/server.js | OPEN |
| BUG-013 through BUG-025 | 🟡-🟢 | Various | Various | OPEN |

**Total Issues: 25**
- 🔴 Critical: 5
- 🟠 High: 7
- 🟡 Medium: 8
- 🟢 Low: 5

---

*Audit completed: 2026-05-02 | Status: OPEN — fixes pending*  
*MERGED from multiple audit versions: 2026-05-02*

---

### BUG-001: Stale "running" State — Pipeline Shows Running When It's Dead
**File:** `pipeline_state.json` (written by `terminal_runner.py`)
**Severity:** CRITICAL
**Category:** Fake Running / Stale State

**Problem:**
When the pipeline crashes mid-run (Python exception, OOM, power cut, Docker restart), `pipeline_state.json` retains `"status": "running"`. On next startup, the backend/UI reads this stale state and displays "Pipeline Running" even though no process is alive. Users cannot trigger new runs because the system thinks one is already active.

**Root Cause:**
`save_state({"status": "running", ...})` is written at start of `_execute_once()`, but if the process dies without reaching the `save_state({"status": "success"})` at the end, the file is never updated.

**Evidence in code (`terminal_runner.py` ~line 480):**
```python
self.store.save_state({"status": "running", **run_context})
```
No `finally:` block wraps the pipeline execution to guarantee cleanup.

**Fix Required:**
Wrap `_execute_once()` in try/finally. On any uncaught exception, write `status: "failed"` to state file. Additionally, on `backend/server.js` startup, validate PID in state file is alive before trusting `"running"` status.

---

### BUG-002: Cron Job Does NOT Re-trigger Pipeline After Completion
**File:** `backend/server.js` (cron scheduler), `terminal_runner.py`
**Severity:** CRITICAL
**Category:** Cron/Pipeline Integration Broken

**Problem:**
The backend cron scheduler (`node-cron`) and `terminal_runner.py` are two **separate, disconnected systems**. The backend cron triggers pipeline via HTTP API call to `/api/jobs/run-pipeline`. But `terminal_runner.py` runs as a completely independent subprocess — when its scheduled run completes, it waits for next interval via `_countdown_until()`. These two systems have no shared state mechanism to coordinate re-trigger.

**Specific Issues:**
1. Backend cron fires at its interval but if `terminal_runner.py` is also running in scheduled mode, both try to run simultaneously → lock conflicts
2. When backend cron fires, it calls `/api/jobs/run-pipeline` which spawns scripts directly via `server.js` — completely bypassing `terminal_runner.py`'s checkpoint/state system
3. After `terminal_runner.py` completes a scheduled cycle, it re-enters `_countdown_until()` correctly, but the backend cron independently fires again → DOUBLE EXECUTION
4. `pipeline_state.json` is only written by `terminal_runner.py`, not by backend cron jobs — so the UI status is unreliable for backend-triggered runs

**Fix Required:**
Unify the cron entry point. Either:
- Backend cron calls `terminal_runner.py` as a subprocess (single source of truth)
- OR `terminal_runner.py`'s scheduled loop updates backend-readable state so backend cron defers

---

### BUG-003: reverify.py Over-Processing — Duplicate Order IDs Processed
**File:** `Scripts/reverify.py`
**Severity:** CRITICAL
**Category:** Data Integrity / Duplicate Processing

**Problem:**
`reverify.py` does NOT maintain its own `logs.txt` (processed ID tracking) like the other scripts (`Funeral_Finder.py`, `Updater.py`, etc.). When called with `--force` (which terminal_runner.py does on `start_mode == "fresh"`), it reprocesses ALL records in `Funeral_data_not_found.csv` and `Funeral_data_review.csv` without checking if those order_ids were already re-verified in a previous run.

**Evidence:**
In `terminal_runner.py` line ~675:
```python
force=(start_mode == "fresh"),
```
This passes `--force` to ALL scripts including reverify, causing complete re-scan every fresh run.

**What Happens:**
- Cycle 1 (fresh): reverify processes order IDs [A, B, C] → uploads to CRM
- Cycle 2 (scheduled, auto-sets fresh): reverify processes [A, B, C] AGAIN → duplicate CRM uploads
- Result: Same funeral home details uploaded 2x, 3x, Nx to CRM

**Fix Required:**
`reverify.py` must implement the same `logs.txt` pattern as other scripts. It should read processed order_ids from its own `Scripts/outputs/reverify/logs.txt` and skip already-processed IDs (unless `--force` is explicitly passed by user, not automatically by scheduler).

---

### BUG-004: Funeral_Finder.py Also Over-Processing on Scheduled Cycles
**File:** `Scripts/Funeral_Finder.py`, `terminal_runner.py`
**Severity:** CRITICAL  
**Category:** Duplicate Processing

**Problem:**
In `terminal_runner.py`, scheduled mode auto-sets `start_mode = "fresh"` for every cycle >1:
```python
if run_mode == "scheduled" and cycle > 1:
    start_mode = "fresh"
```
This means `--force` is passed to Funeral_Finder.py on EVERY scheduled cycle. Funeral_Finder uses `logs.txt` to track processed IDs, but `--force` bypasses this check and reprocesses all rows from `GetOrderInquiry/data.csv`.

**Result:** Every 30 minutes (or whatever cron interval), Funeral_Finder calls Perplexity AI for ALL orders again, not just new ones. This causes:
- Wasted Perplexity API credits (costs real money)
- Duplicate entries in `Funeral_data.csv`
- Inflated API usage bills

**Fix Required:**
Scheduled mode should NOT auto-set `start_mode = "fresh"`. It should use `"continue"` or a smart mode that only processes NEW orders (order_ids not in logs.txt). `--force` should ONLY be passed when user explicitly chooses "Fresh Start" mode.

---

### BUG-005: GetTask.py Fetches ALL Open Tasks Every Run — No Incremental Logic
**File:** `Scripts/GetTask.py`
**Severity:** HIGH
**Category:** Duplicate Processing / Data Integrity

**Problem:**
GetTask.py fetches ALL open tasks from CRM each run and writes them to `data.csv`, overwriting the previous file. If a task was already processed (Funeral_Finder found it, Updater uploaded, ClosingTask closed it), but the CRM task-close API call failed or was delayed — the task remains "open" in CRM and GetTask fetches it again next cycle, feeding it through the entire pipeline again.

**Fix Required:**
GetTask.py should maintain a `processed_order_ids.txt` and exclude any order_id that appears in `ClosingTask/logs.txt` (successfully closed). Cross-reference with downstream logs before adding to output.

---

### BUG-006: pipeline_state.json Status "running" Check in Backend — Race Condition
**File:** `backend/server.js`
**Severity:** HIGH
**Category:** Race Condition / Fake Running

**Problem:**
When `/api/jobs/run-pipeline` is called, server.js reads `pipeline_state.json` to check if pipeline is running. But between the read and the new pipeline process spawn, another HTTP request can pass the check and also spawn — creating two concurrent pipeline processes writing to the same CSV files simultaneously.

**Fix Required:**
Use a file-based mutex (write PID to lock file before spawning, check and cleanup on startup).

---

## 🟠 HIGH SEVERITY BUGS

---

### BUG-007: Docker Production Config Uses Development Mode
**File:** `docker-compose.yml`, `Dockerfile`
**Severity:** HIGH
**Category:** Production Readiness

**Problem:**
`docker-compose.yml` sets `NODE_ENV=development` and mounts live code (`.:/app` volume). In production this means:
- Vite dev server runs instead of built static files
- Source maps are exposed
- Hot module replacement is enabled (unnecessary overhead)
- Any file change on host immediately affects running container

**Fix Required:**
Add a `docker-compose.prod.yml` that sets `NODE_ENV=production`, runs `npm run build` during image build, and serves static files via the Express server instead of Vite dev server.

---

### BUG-008: .env Files Committed Risk / No Validation on Startup
**File:** `main.py`, `.gitignore`
**Severity:** HIGH
**Category:** Security

**Problem:**
1. No runtime validation that `.env` values are non-empty before pipeline starts. A blank `PERPLEXITY_API_KEY=` passes preflight but causes API failures mid-pipeline.
2. The CRM URL (`http://ordstatus.tfdash.info:8061/api/...`) is plaintext HTTP — all API keys sent unencrypted over network.
3. `Scripts/.env` and root `.env` are separate files — they can become out of sync silently.

**Fix Required:**
- Add strict preflight validation: check each required key is non-empty
- Enforce HTTPS for CRM API or document the network security assumptions
- Merge to single `.env` with a clear loading hierarchy

---

### BUG-009: Admin Password Not Shown on First Boot (Bootstrap Bug)
**File:** `main.py` — `_seed_default_admin()` function
**Severity:** HIGH
**Category:** Security / UX

**Problem:**
When no admin user exists, `_seed_default_admin()` creates one with a random password via `secrets.token_urlsafe(18)`. The password is printed ONCE via `print_warn(...)`, but only to the terminal — not saved anywhere accessible. If this runs inside Docker where logs scroll past, the admin password is lost forever.

**Fix Required:**
Write the generated credentials to a secure file (e.g., `backend/data/INITIAL_CREDENTIALS.txt`) with a warning to delete after first login. Also display prominently at startup.

---

### BUG-010: Backend Cron Schedule Persisted in JSON — Not Atomic
**File:** `backend/lib/storage.js`, `backend/data/schedules.json`
**Severity:** HIGH  
**Category:** Data Integrity / Race Condition

**Problem:**
`schedules.json` is read and written using non-atomic file I/O. If the server crashes during a write (mid-JSON), the file becomes corrupt and all schedules are lost. No backup/recovery mechanism exists.

**Fix Required:**
Use write-to-temp-then-rename pattern (atomic write) for all JSON state files, or migrate to SQLite (already used for auth — extend it for schedules).

---

### BUG-011: Session Password Change Does NOT Revoke Active Sessions
**File:** `main.py` — `_update_user_password()` function
**Severity:** HIGH
**Category:** Security

**Problem:**
The function says in UI: `"All active sessions for this user have been revoked"` — but the actual implementation only updates `password_hash`. It does NOT execute any SQL to set `revoked_at` on existing sessions for that user. This is a **displayed lie** — sessions remain valid after password change.

**Evidence:**
```python
def _update_user_password(conn, username, password):
    # ...
    conn.execute(
        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
        (hash_password(password), timestamp, row["id"]),
    )
    conn.commit()
    # ← NO session revocation here!
```

**Fix Required:**
Add: `conn.execute("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", (timestamp, row["id"]))`

---

### BUG-012: No Rate Limiting on Backend API Endpoints
**File:** `backend/server.js`
**Severity:** HIGH
**Category:** Security

**Problem:**
The REST API has no rate limiting. An attacker can:
- Hammer `/api/jobs/run-pipeline` to trigger hundreds of concurrent pipelines
- Brute-force login endpoint (if auth is added)
- Exhaust Perplexity API quota via bulk `/api/jobs/run-script` calls

**Fix Required:**
Add `express-rate-limit` middleware. At minimum: 10 req/min for pipeline endpoints, 5 req/min for auth endpoints.

---

## 🟡 MEDIUM SEVERITY BUGS

---

### BUG-013: pipeline_checkpoint.json Not Cleared on Fresh Scheduled Run (Race)
**File:** `terminal_runner.py` — `_execute_once()`
**Severity:** MEDIUM
**Category:** State Management

**Problem:**
Scheduled cycle 2+ sets `start_mode = "fresh"` and calls `reset_checkpoint()`. But between `reset_checkpoint()` and `_clear_cycle_locks()`, if the previous cycle's locks are still being released, `_acquire_script_lock()` may fail for the first script of the new cycle.

**Fix Required:**
Add a small sleep or explicit lock-wait after `_clear_cycle_locks()` before starting script execution in fresh mode.

---

### BUG-014: parse_processed_count() Only Reads Last Line Match
**File:** `terminal_runner.py` — `parse_processed_count()`
**Severity:** MEDIUM
**Category:** Logic Error

**Problem:**
The function scans stdout line by line and overwrites `processed_count` on every match. If a script prints intermediate counts (`"Processed 5 records"`, then later `"Processed 10 records"`), only the last value is stored. But if a script prints count early and then prints error lines, the count may be outdated.

The regex patterns are also fragile — they use loose `\s*:\s*` matching but don't handle tab-separated output or JSON log lines.

**Fix Required:**
Track max or final count, and add JSON log line parsing support.

---

### BUG-015: Updater.py File Mode Not Validated Against Actual File Existence
**File:** `terminal_runner.py`, `Scripts/Updater.py`
**Severity:** MEDIUM
**Category:** Silent Failure

**Problem:**
When Updater is called with `--mode not_found`, it looks for `Funeral_data_not_found.csv`. If Funeral_Finder found everything (no not-found records), this file doesn't exist. Updater silently exits with code 0 (no error), checkpoint advances, but nothing was actually uploaded.

**Fix Required:**
Before calling Updater, check if the target file exists and has rows. If not, skip Updater with an explicit "No records to upload for this mode" log, not a fake success.

---

### BUG-016: Frontend Shows Stale Job Status — No Real-time Polling Sync
**File:** `src/lib/api.ts`, `src/components/ScriptPanel.tsx`
**Severity:** MEDIUM
**Category:** UI/UX — Fake Data Display

**Problem:**
The frontend polls `/api/jobs/:id` for status updates. But if the backend server restarts while a job is running, the job ID is lost from in-memory state (`jobs.json` may not capture mid-run state). The UI continues showing "Running" with the spinner indefinitely.

**Fix Required:**
On backend restart, scan all jobs in `jobs.json` with status `"running"` and mark them `"failed"` (since the process is gone). Also add a job staleness timeout — if a job has been "running" for >2 hours without a log update, mark as timed-out.

---

### BUG-017: Docker Healthcheck Tests Backend Only — Frontend Can Be Dead
**File:** `docker-compose.yml`
**Severity:** MEDIUM
**Category:** Operations

**Problem:**
```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8787/api/health"]
```
Only backend health is checked. Frontend (Vite on 8080) can be completely down and Docker reports the container as healthy.

**Fix Required:**
Add frontend health check or change to a combined check that verifies both ports.

---

### BUG-018: No Retry on CRM API Timeout — Single Request Failure Kills Stage
**File:** `Scripts/GetTask.py`, `Scripts/GetOrderInquiry.py`
**Severity:** MEDIUM
**Category:** Reliability

**Problem:**
CRM API (`ordstatus.tfdash.info:8061`) calls have no retry logic. A single network timeout or 5xx from CRM causes the entire script to fail. In a production funeral business environment, CRM downtime would halt all order processing.

**Fix Required:**
Implement exponential backoff retry (3 attempts, 5s/15s/30s delays) on all CRM API calls.

---

### BUG-019: Perplexity API Key Exposed in Script Logs
**File:** `Scripts/Funeral_Finder.py` (inferred from architecture)
**Severity:** MEDIUM
**Category:** Security

**Problem:**
API requests to Perplexity often include headers in debug/error output. If `Funeral_Finder.py` logs request headers on error (common pattern), the `Authorization: Bearer pplx-...` key appears in `logs.txt` which is served via `/api/files/content` endpoint — readable by any authenticated user.

**Fix Required:**
Sanitize all log output to redact Authorization headers and API key values. Add a log sanitizer utility.

---

### BUG-020: Output CSV Files Have No Schema Validation
**File:** All pipeline scripts
**Severity:** MEDIUM
**Category:** Data Integrity

**Problem:**
Scripts read the previous stage's CSV output and assume all required columns exist. If a column name changes (e.g., a typo fix), all downstream scripts silently receive `NaN`/empty values for that column and continue processing with fake data.

**Fix Required:**
Add a CSV schema validator at the start of each script. Define expected columns and dtypes. Fail loudly if schema doesn't match.

---

## 🟢 LOW SEVERITY / CODE QUALITY ISSUES

---

### BUG-021: `_ensure_setting()` Has UPSERT Logic Bug
**File:** `main.py`
**Severity:** LOW
**Category:** Logic

**Problem:**
`_ensure_setting()` does an INSERT if key doesn't exist, else UPDATE. But the function is called in `_auth_db_connection()` every time a connection is made. This means every startup re-writes the `default_model` setting to the same value — unnecessary DB writes.

**Fix Required:**
Check if value has changed before updating.

---

### BUG-022: `_resolve_sequence()` Allows Duplicate Script Selection
**File:** `terminal_runner.py`
**Severity:** LOW
**Category:** UX

**Problem:**
The deduplication logic removes duplicates but does so silently — user doesn't know their input `1,3,3,5` became `1,3,5`. Should print a notice.

---

### BUG-023: No Timeout on `_countdown_until()` Blocking Loop
**File:** `terminal_runner.py`
**Severity:** LOW
**Category:** Resource Management

**Problem:**
`_countdown_until()` polls every 1 second forever. No maximum wait time. If scheduled interval is `1440` (daily), the thread blocks for 24 hours. If signal handling fails (Windows quirk), Ctrl+C may not be caught.

**Fix Required:**
Add max sleep chunk of 60 seconds with explicit stop-request check.

---

### BUG-024: Missing `graphify out` / Analytics Folder Integration
**File:** Project root
**Severity:** LOW
**Category:** Feature Gap

**Problem:**
You mentioned a `graphify out` folder. This appears to be a data visualization/reporting output directory. It is NOT referenced in any pipeline script, not included in the dashboard's file browser, and not documented in README. This means graphical reports generated here are inaccessible from the UI.

**Fix Required:**
Register `graphify out` as an additional output directory in `backend/lib/files.js` and include it in the data explorer dropdown.

---

### BUG-025: README Documents `.env.example` That Doesn't Exist
**File:** `README.md`
**Severity:** LOW
**Category:** Documentation

**Problem:**
README instructs: `cp .env.example .env` — but `.env.example` is not present in the repository. New deployments will fail at this step.

**Fix Required:**
Create `.env.example` with all required keys (values empty or placeholder), commit to repo.

---

## 📊 AUDIT SUMMARY TABLE

| ID | Severity | Category | File | Status |
|----|----------|----------|------|--------|
| BUG-001 | 🔴 CRITICAL | Stale Running State | terminal_runner.py | OPEN |
| BUG-002 | 🔴 CRITICAL | Cron-Pipeline Disconnect | server.js + terminal_runner.py | OPEN |
| BUG-003 | 🔴 CRITICAL | reverify.py Over-Processing | Scripts/reverify.py | OPEN |
| BUG-004 | 🔴 CRITICAL | Funeral_Finder Force Re-run | terminal_runner.py | OPEN |
| BUG-005 | 🔴 CRITICAL | GetTask No Incremental Logic | Scripts/GetTask.py | OPEN |
| BUG-006 | 🟠 HIGH | Pipeline Race Condition | backend/server.js | OPEN |
| BUG-007 | 🟠 HIGH | Docker Dev Mode in Production | docker-compose.yml | OPEN |
| BUG-008 | 🟠 HIGH | .env Security / Validation | main.py | OPEN |
| BUG-009 | 🟠 HIGH | Admin Password Lost on Boot | main.py | OPEN |
| BUG-010 | 🟠 HIGH | Non-Atomic JSON Writes | backend/lib/storage.js | OPEN |
| BUG-011 | 🟠 HIGH | Session Not Revoked on PW Change | main.py | OPEN |
| BUG-012 | 🟠 HIGH | No API Rate Limiting | backend/server.js | OPEN |
| BUG-013 | 🟡 MEDIUM | Checkpoint Race on Fresh Run | terminal_runner.py | OPEN |
| BUG-014 | 🟡 MEDIUM | Fragile Processed Count Parse | terminal_runner.py | OPEN |
| BUG-015 | 🟡 MEDIUM | Updater Silent Fail on Missing File | Updater.py | OPEN |
| BUG-016 | 🟡 MEDIUM | Frontend Stale Job Status | src/components/ScriptPanel.tsx | OPEN |
| BUG-017 | 🟡 MEDIUM | Docker Partial Healthcheck | docker-compose.yml | OPEN |
| BUG-018 | 🟡 MEDIUM | No CRM API Retry | Scripts/*.py | OPEN |
| BUG-019 | 🟡 MEDIUM | API Key in Logs | Scripts/Funeral_Finder.py | OPEN |
| BUG-020 | 🟡 MEDIUM | No CSV Schema Validation | All pipeline scripts | OPEN |
| BUG-021 | 🟢 LOW | UPSERT Logic Waste | main.py | OPEN |
| BUG-022 | 🟢 LOW | Silent Dedup in Sequence | terminal_runner.py | OPEN |
| BUG-023 | 🟢 LOW | Countdown Loop No Max Chunk | terminal_runner.py | OPEN |
| BUG-024 | 🟢 LOW | graphify out Not Integrated | backend/lib/files.js | OPEN |
| BUG-025 | 🟢 LOW | .env.example Missing | README.md | OPEN |

**Total Issues: 25**
- 🔴 Critical: 5
- 🟠 High: 7
- 🟡 Medium: 8
- 🟢 Low: 5
