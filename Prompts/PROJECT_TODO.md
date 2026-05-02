# ✅ PROJECT_TODO.md — BlossomTask Fix Tracker [MERGED]
> **Priority Order:** Based on production impact + data integrity risk
> **Status Legend:** 🔴 Blocked | 🟡 In Progress | ✅ Done | ⬜ Not Started
> **Version:** 2.0.0 MERGED | **Last Updated:** 2026-05-02

---

## PHASE 1 — Data Integrity Fixes (DO THESE FIRST — Production Blockers)

### P1-1: Fix reverify.py Over-Processing (BUG-003)
- **File:** `Scripts/reverify.py`
- **Priority:** CRITICAL — fixes duplicate CRM uploads
- **Status:** ⬜ Not Started
- [ ] Add `REVERIFY_LOGS = "Scripts/outputs/Funeral_Finder/reverify_logs.txt"`
- [ ] On startup, load processed order_ids from reverify_logs.txt into a set
- [ ] Before processing each order, check `if order_id in processed_ids: continue`
- [ ] After processing, append order_id to reverify_logs.txt
- [ ] Test: Run reverify twice, confirm second run processes 0 records
- [ ] Verify: Check CRM for duplicate uploads — should have none

### P1-2: Fix Funeral_Finder --force on Scheduled Cycles (BUG-004)
- **File:** `terminal_runner.py` — `_run_loop()` and `_execute_once()`
- **Priority:** CRITICAL — prevents wasted Perplexity API calls
- **Status:** ⬜ Not Started
- [ ] Change scheduled cycle logic: remove auto `start_mode = "fresh"` on cycle > 1
- [ ] Scheduled cycles should use `start_mode = "continue"` by default
- [ ] `force=True` (which triggers --force) must ONLY be set when user explicitly chose "Fresh Start" mode
- [ ] Update `_execute_once()`: change `force=(start_mode == "fresh")` to be preserved across cycles
- [ ] Test: Run in scheduled mode, confirm Funeral_Finder skips already-processed orders on cycle 2
- [ ] Verify: Perplexity API call count stays low on second cycle

### P1-3: Fix Stale "running" State (BUG-001)
- **File:** `terminal_runner.py` — `_execute_once()`
- **Priority:** CRITICAL — fixes "pipeline stuck running" UI bug
- **Status:** ⬜ Not Started
- [ ] Wrap `_execute_once()` body in `try/finally`
- [ ] In `finally` block: if status is still "running", write `status: "failed"`
- [ ] Also wrap `_run_loop()` at top level in try/finally
- [ ] Add startup check in `terminal_runner.py`: on `run()`, read existing state — if "running" and PID in state is dead, reset to "failed"
- [ ] Test: Kill python process mid-run, restart, confirm status shows "failed" not "running"
- [ ] Also test: normal successful run still shows "success"

### P1-4: Fix Cron-Pipeline Integration (BUG-002)
- **File:** `backend/server.js`, `terminal_runner.py`
- **Priority:** CRITICAL — cron jobs must reliably re-trigger pipeline
- **Status:** ⬜ Not Started
- [ ] Decision: Choose ONE approach:
  - **RECOMMENDED:** Backend cron calls `terminal_runner.py` via subprocess with `--once` flag
  - Alternative: Document that terminal_runner.py is the ONLY scheduler to use
- [ ] Add `--once` flag to `terminal_runner.py` that runs single cycle then exits
- [ ] Update `backend/server.js` cron handler to spawn `terminal_runner.py --once --mode=continue`
- [ ] Remove duplicate pipeline execution from `server.js` direct script calls (use terminal_runner as single entry)
- [ ] Test: Create a 1-minute cron in UI, observe it fires via terminal_runner correctly
- [ ] Test: Confirm pipeline_state.json updated correctly after each cron-triggered run

---

## PHASE 2 — Security Fixes

### P2-1: Fix Session Revocation on Password Change (BUG-011)
- **File:** `main.py` — `_update_user_password()`
- **Priority:** HIGH
- **Status:** ⬜ Not Started
- [ ] Add SQL: `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`
- [ ] Run this BEFORE updating password_hash
- [ ] Test: Login → change password → try old session → confirm 401/redirect
- [ ] Verify: `blossomtask.sqlite` sessions table has `revoked_at` populated

### P2-2: Add API Rate Limiting (BUG-012)
- **File:** `backend/server.js`
- **Priority:** HIGH
- **Status:** ⬜ Not Started
- [ ] `npm install express-rate-limit`
- [ ] Add to package.json dependencies
- [ ] Pipeline endpoints: 10 req/min limit
- [ ] Auth endpoints: 5 req/min limit
- [ ] File endpoints: 30 req/min limit
- [ ] Test: Hit pipeline endpoint 11 times/min, confirm 429 response
- [ ] Test: Normal usage still works fine

### P2-3: Save Admin Credentials on First Boot (BUG-009)
- **File:** `main.py` — `_seed_default_admin()`
- **Priority:** HIGH
- **Status:** ⬜ Not Started
- [ ] Write generated password to `backend/data/INITIAL_CREDENTIALS.txt`
- [ ] Include warning in file: "DELETE THIS FILE AFTER FIRST LOGIN"
- [ ] Print large visible banner on terminal if file still exists
- [ ] Ensure file permissions are restrictive (chmod 600 on Linux)
- [ ] Test: Delete database, restart, confirm file created with correct credentials
- [ ] Test: Login with saved credentials works

### P2-4: Sanitize API Keys from Logs (BUG-019)
- **File:** All `Scripts/*.py`
- **Priority:** MEDIUM
- **Status:** ⬜ Not Started
- [ ] Create `Scripts/utils/log_sanitizer.py` utility
- [ ] Pattern: redact `Bearer [a-zA-Z0-9-]{20,}` and `pplx-[a-zA-Z0-9]+`
- [ ] Apply to all script log output functions
- [ ] Test: Trigger an API error, check logs.txt — no keys visible

---

## PHASE 3 — Reliability Fixes

### P3-1: Fix Non-Atomic JSON Writes (BUG-010)
- **File:** `backend/lib/storage.js`, `terminal_runner.py` — `RuntimeStore`
- **Priority:** HIGH
- **Status:** ⬜ Not Started
- [ ] Pattern: write to `file.json.tmp` → `fs.renameSync(tmp, file.json)`
- [ ] Apply to: `jobs.json`, `schedules.json` in Node.js
- [ ] Apply to: `pipeline_state.json`, `pipeline_checkpoint.json` in Python
- [ ] Test: Kill process during write, confirm file not corrupted

### P3-2: Add CRM API Retry Logic (BUG-018)
- **File:** `Scripts/GetTask.py`, `Scripts/GetOrderInquiry.py`, `Scripts/Updater.py`, `Scripts/ClosingTask.py`
- **Priority:** MEDIUM
- **Status:** ⬜ Not Started
- [ ] Create `Scripts/utils/api_client.py` with retry decorator
- [ ] Exponential backoff: attempt 1 (0s wait), attempt 2 (5s), attempt 3 (15s), attempt 4 (30s)
- [ ] Retry on: connection timeout, 5xx HTTP status, connection refused
- [ ] Do NOT retry on: 4xx (bad request, auth failure)
- [ ] Import and use in all CRM-calling scripts
- [ ] Test: Simulate CRM timeout, confirm retry fires then succeeds

### P3-3: Add CSV Schema Validation (BUG-020)
- **File:** All pipeline scripts
- **Priority:** MEDIUM
- **Status:** ⬜ Not Started
- [ ] Create `Scripts/utils/schema_validator.py`
- [ ] Define expected schemas for each stage's input CSV
- [ ] Validate at script startup before processing any rows
- [ ] Fail with clear error message if schema mismatch
- [ ] Test: Remove a column from input CSV, confirm clear error (not silent NaN)

### P3-4: Fix Updater Silent Fail on Missing File (BUG-015)
- **File:** `terminal_runner.py` or `Scripts/Updater.py`
- **Priority:** MEDIUM
- **Status:** ⬜ Not Started
- [ ] Before calling Updater, check if target input file exists and has >0 data rows
- [ ] If no file: log "Skipping Updater — no records for mode X" and advance checkpoint
- [ ] If file empty: same skip behavior
- [ ] Test: Run with `--mode not_found` when no not-found records exist

---

## PHASE 4 — Infrastructure / DevOps

### P4-1: Docker Production Config (BUG-007)
- **File:** New `docker-compose.prod.yml`, `Dockerfile`
- **Priority:** HIGH
- **Status:** ⬜ Not Started
- [ ] Create `docker-compose.prod.yml`:
  - `NODE_ENV=production`
  - No volume mount for live code
  - Run `npm run build` in Dockerfile build stage
  - Express serves built static files
- [ ] Add multi-stage Dockerfile (build stage + runtime stage)
- [ ] Update `docker-entrypoint.sh` for production mode
- [ ] Test: `docker compose -f docker-compose.prod.yml up --build`
- [ ] Confirm: Vite dev server NOT running in container

### P4-2: Fix Docker Healthcheck (BUG-017)
- **File:** `docker-compose.yml`
- **Priority:** MEDIUM
- **Status:** ⬜ Not Started
- [ ] Change healthcheck to verify both ports
- [ ] Or: backend health endpoint also checks that frontend is reachable
- [ ] Test: Kill frontend only, confirm container reports unhealthy

### P4-3: Create .env.example (BUG-025)
- **File:** New `.env.example`
- **Priority:** LOW
- **Status:** ⬜ Not Started
- [ ] Create `.env.example` with all required keys (placeholder values)
- [ ] Add to repository (not gitignored)
- [ ] Update README installation steps
- [ ] Test: Fresh clone, `cp .env.example .env`, fill values, run preflight

---

## PHASE 5 — Feature Completions

### P5-1: GetTask Incremental Logic (BUG-005)
- **File:** `Scripts/GetTask.py`
- **Priority:** HIGH (data integrity)
- **Status:** ⬜ Not Started
- [ ] Before adding order to output, check ClosingTask/logs.txt
- [ ] If order_id appears in ClosingTask logs → already fully processed → skip
- [ ] This prevents re-feeding closed orders back into pipeline
- [ ] Test: Manually add an order_id to ClosingTask/logs.txt, run GetTask, confirm it's excluded

### P5-2: Integrate graphify out Folder (BUG-024)
- **File:** `backend/lib/files.js`
- **Priority:** LOW
- **Status:** ⬜ Not Started
- [ ] Identify exact path of `graphify out` folder
- [ ] Add to file browser allowed directories in `backend/lib/files.js`
- [ ] Add to UI dropdown in DataViewer
- [ ] Test: Access graphify files via dashboard

### P5-3: Frontend Job Staleness Handling (BUG-016)
- **File:** `src/components/ScriptPanel.tsx`, `backend/server.js`
- **Priority:** MEDIUM
- **Status:** ⬜ Not Started
- [ ] Backend: on startup, scan jobs.json for "running" jobs → mark as "failed" with reason "Server restarted"
- [ ] Frontend: show "stale" badge for jobs running >2 hours
- [ ] Add auto-refresh with 30s polling for running jobs
- [ ] Test: Start a job, kill server, restart, confirm job shows "failed"

---

## 📊 Progress Summary

| Phase | Total Tasks | Done | In Progress | Blocked |
|-------|-------------|------|-------------|---------|
| Phase 1 — Data Integrity | 4 | 0 | 0 | 0 |
| Phase 2 — Security | 4 | 0 | 0 | 0 |
| Phase 3 — Reliability | 4 | 0 | 0 | 0 |
| Phase 4 — Infrastructure | 3 | 0 | 0 | 0 |
| Phase 5 — Features | 3 | 0 | 0 | 0 |
| **Total** | **18** | **0** | **0** | **0** |

---

## 🔗 Cross-References
- Full bug details: `PROJECT_AUDIT.md`
- Architecture understanding: `PROJECT_SYSTEM_GUIDE.md`
- Auto-fix prompt for Codex: `CODEX_FIX_PROMPT.md`

---

*MERGED from multiple TODO versions: 2026-05-02*

### P1-1: Fix reverify.py Over-Processing (BUG-003)
- **File:** `Scripts/reverify.py`
- **Priority:** CRITICAL — fixes duplicate CRM uploads
- **Status:** ⬜ Not Started
- [ ] Add `REVERIFY_LOGS = "Scripts/outputs/Funeral_Finder/reverify_logs.txt"`
- [ ] On startup, load processed order_ids from reverify_logs.txt into a set
- [ ] Before processing each order, check `if order_id in processed_ids: continue`
- [ ] After processing, append order_id to reverify_logs.txt
- [ ] Test: Run reverify twice, confirm second run processes 0 records
- [ ] Verify: Check CRM for duplicate uploads — should have none

### P1-2: Fix Funeral_Finder --force on Scheduled Cycles (BUG-004)
- **File:** `terminal_runner.py` — `_run_loop()` and `_execute_once()`
- **Priority:** CRITICAL — prevents wasted Perplexity API calls
- **Status:** ⬜ Not Started
- [ ] Change scheduled cycle logic: remove auto `start_mode = "fresh"` on cycle > 1
- [ ] Scheduled cycles should use `start_mode = "continue"` by default
- [ ] `force=True` (which triggers --force) must ONLY be set when user explicitly chose "Fresh Start" mode
- [ ] Update `_execute_once()`: change `force=(start_mode == "fresh")` to be preserved across cycles
- [ ] Test: Run in scheduled mode, confirm Funeral_Finder skips already-processed orders on cycle 2
- [ ] Verify: Perplexity API call count stays low on second cycle

### P1-3: Fix Stale "running" State (BUG-001)
- **File:** `terminal_runner.py` — `_execute_once()`
- **Priority:** CRITICAL — fixes "pipeline stuck running" UI bug
- **Status:** ⬜ Not Started
- [ ] Wrap `_execute_once()` body in `try/finally`
- [ ] In `finally` block: if status is still "running", write `status: "failed"`
- [ ] Also wrap `_run_loop()` at top level in try/finally
- [ ] Add startup check in `terminal_runner.py`: on `run()`, read existing state — if "running" and PID in state is dead, reset to "failed"
- [ ] Test: Kill python process mid-run, restart, confirm status shows "failed" not "running"
- [ ] Also test: normal successful run still shows "success"

### P1-4: Fix Cron-Pipeline Integration (BUG-002)
- **File:** `backend/server.js`, `terminal_runner.py`
- **Priority:** CRITICAL — cron jobs must reliably re-trigger pipeline
- **Status:** ⬜ Not Started
- [ ] Decision: Choose ONE approach:
  - **RECOMMENDED:** Backend cron calls `terminal_runner.py` via subprocess with `--once` flag
  - Alternative: Document that terminal_runner.py is the ONLY scheduler to use
- [ ] Add `--once` flag to `terminal_runner.py` that runs single cycle then exits
- [ ] Update `backend/server.js` cron handler to spawn `terminal_runner.py --once --mode=continue`
- [ ] Remove duplicate pipeline execution from `server.js` direct script calls (use terminal_runner as single entry)
- [ ] Test: Create a 1-minute cron in UI, observe it fires via terminal_runner correctly
- [ ] Test: Confirm pipeline_state.json updated correctly after each cron-triggered run

---

## PHASE 2 — Security Fixes

### P2-1: Fix Session Revocation on Password Change (BUG-011)
- **File:** `main.py` — `_update_user_password()`
- **Priority:** HIGH
- **Status:** ⬜ Not Started
- [ ] Add SQL: `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`
- [ ] Run this BEFORE updating password_hash
- [ ] Test: Login → change password → try old session → confirm 401/redirect
- [ ] Verify: `blossomtask.sqlite` sessions table has `revoked_at` populated

### P2-2: Add API Rate Limiting (BUG-012)
- **File:** `backend/server.js`
- **Priority:** HIGH
- **Status:** ⬜ Not Started
- [ ] `npm install express-rate-limit`
- [ ] Add to package.json dependencies
- [ ] Pipeline endpoints: 10 req/min limit
- [ ] Auth endpoints: 5 req/min limit
- [ ] File endpoints: 30 req/min limit
- [ ] Test: Hit pipeline endpoint 11 times/min, confirm 429 response
- [ ] Test: Normal usage still works fine

### P2-3: Save Admin Credentials on First Boot (BUG-009)
- **File:** `main.py` — `_seed_default_admin()`
- **Priority:** HIGH
- **Status:** ⬜ Not Started
- [ ] Write generated password to `backend/data/INITIAL_CREDENTIALS.txt`
- [ ] Include warning in file: "DELETE THIS FILE AFTER FIRST LOGIN"
- [ ] Print large visible banner on terminal if file still exists
- [ ] Ensure file permissions are restrictive (chmod 600 on Linux)
- [ ] Test: Delete database, restart, confirm file created with correct credentials
- [ ] Test: Login with saved credentials works

### P2-4: Sanitize API Keys from Logs (BUG-019)
- **File:** All `Scripts/*.py`
- **Priority:** MEDIUM
- **Status:** ⬜ Not Started
- [ ] Create `Scripts/utils/log_sanitizer.py` utility
- [ ] Pattern: redact `Bearer [a-zA-Z0-9-]{20,}` and `pplx-[a-zA-Z0-9]+`
- [ ] Apply to all script log output functions
- [ ] Test: Trigger an API error, check logs.txt — no keys visible

---

## PHASE 3 — Reliability Fixes

### P3-1: Fix Non-Atomic JSON Writes (BUG-010)
- **File:** `backend/lib/storage.js`, `terminal_runner.py` — `RuntimeStore`
- **Priority:** HIGH
- **Status:** ⬜ Not Started
- [ ] Pattern: write to `file.json.tmp` → `fs.renameSync(tmp, file.json)`
- [ ] Apply to: `jobs.json`, `schedules.json` in Node.js
- [ ] Apply to: `pipeline_state.json`, `pipeline_checkpoint.json` in Python
- [ ] Test: Kill process during write, confirm file not corrupted

### P3-2: Add CRM API Retry Logic (BUG-018)
- **File:** `Scripts/GetTask.py`, `Scripts/GetOrderInquiry.py`, `Scripts/Updater.py`, `Scripts/ClosingTask.py`
- **Priority:** MEDIUM
- **Status:** ⬜ Not Started
- [ ] Create `Scripts/utils/api_client.py` with retry decorator
- [ ] Exponential backoff: attempt 1 (0s wait), attempt 2 (5s), attempt 3 (15s), attempt 4 (30s)
- [ ] Retry on: connection timeout, 5xx HTTP status, connection refused
- [ ] Do NOT retry on: 4xx (bad request, auth failure)
- [ ] Import and use in all CRM-calling scripts
- [ ] Test: Simulate CRM timeout, confirm retry fires then succeeds

### P3-3: Add CSV Schema Validation (BUG-020)
- **File:** All pipeline scripts
- **Priority:** MEDIUM
- **Status:** ⬜ Not Started
- [ ] Create `Scripts/utils/schema_validator.py`
- [ ] Define expected schemas for each stage's input CSV
- [ ] Validate at script startup before processing any rows
- [ ] Fail with clear error message if schema mismatch
- [ ] Test: Remove a column from input CSV, confirm clear error (not silent NaN)

### P3-4: Fix Updater Silent Fail on Missing File (BUG-015)
- **File:** `terminal_runner.py` or `Scripts/Updater.py`
- **Priority:** MEDIUM
- **Status:** ⬜ Not Started
- [ ] Before calling Updater, check if target input file exists and has >0 data rows
- [ ] If no file: log "Skipping Updater — no records for mode X" and advance checkpoint
- [ ] If file empty: same skip behavior
- [ ] Test: Run with `--mode not_found` when no not-found records exist

---

## PHASE 4 — Infrastructure / DevOps

### P4-1: Docker Production Config (BUG-007)
- **File:** New `docker-compose.prod.yml`, `Dockerfile`
- **Priority:** HIGH
- **Status:** ⬜ Not Started
- [ ] Create `docker-compose.prod.yml`:
  - `NODE_ENV=production`
  - No volume mount for live code
  - Run `npm run build` in Dockerfile build stage
  - Express serves built static files
- [ ] Add multi-stage Dockerfile (build stage + runtime stage)
- [ ] Update `docker-entrypoint.sh` for production mode
- [ ] Test: `docker compose -f docker-compose.prod.yml up --build`
- [ ] Confirm: Vite dev server NOT running in container

### P4-2: Fix Docker Healthcheck (BUG-017)
- **File:** `docker-compose.yml`
- **Priority:** MEDIUM
- **Status:** ⬜ Not Started
- [ ] Change healthcheck to verify both ports
- [ ] Or: backend health endpoint also checks that frontend is reachable
- [ ] Test: Kill frontend only, confirm container reports unhealthy

### P4-3: Create .env.example (BUG-025)
- **File:** New `.env.example`
- **Priority:** LOW
- **Status:** ⬜ Not Started
- [ ] Create `.env.example` with all required keys (placeholder values)
- [ ] Add to repository (not gitignored)
- [ ] Update README installation steps
- [ ] Test: Fresh clone, `cp .env.example .env`, fill values, run preflight

---

## PHASE 5 — Feature Completions

### P5-1: GetTask Incremental Logic (BUG-005)
- **File:** `Scripts/GetTask.py`
- **Priority:** HIGH (data integrity)
- **Status:** ⬜ Not Started
- [ ] Before adding order to output, check ClosingTask/logs.txt
- [ ] If order_id appears in ClosingTask logs → already fully processed → skip
- [ ] This prevents re-feeding closed orders back into pipeline
- [ ] Test: Manually add an order_id to ClosingTask/logs.txt, run GetTask, confirm it's excluded

### P5-2: Integrate graphify out Folder (BUG-024)
- **File:** `backend/lib/files.js`
- **Priority:** LOW
- **Status:** ⬜ Not Started
- [ ] Identify exact path of `graphify out` folder
- [ ] Add to file browser allowed directories in `backend/lib/files.js`
- [ ] Add to UI dropdown in DataViewer
- [ ] Test: Access graphify files via dashboard

### P5-3: Frontend Job Staleness Handling (BUG-016)
- **File:** `src/components/ScriptPanel.tsx`, `backend/server.js`
- **Priority:** MEDIUM
- **Status:** ⬜ Not Started
- [ ] Backend: on startup, scan jobs.json for "running" jobs → mark as "failed" with reason "Server restarted"
- [ ] Frontend: show "stale" badge for jobs running >2 hours
- [ ] Add auto-refresh with 30s polling for running jobs
- [ ] Test: Start a job, kill server, restart, confirm job shows "failed"

---

## 📊 Progress Summary

| Phase | Total Tasks | Done | In Progress | Blocked |
|-------|-------------|------|-------------|---------|
| Phase 1 — Data Integrity | 4 | 0 | 0 | 0 |
| Phase 2 — Security | 4 | 0 | 0 | 0 |
| Phase 3 — Reliability | 4 | 0 | 0 | 0 |
| Phase 4 — Infrastructure | 3 | 0 | 0 | 0 |
| Phase 5 — Features | 3 | 0 | 0 | 0 |
| **Total** | **18** | **0** | **0** | **0** |

---

## 🔗 Cross-References
- Full bug details: `PROJECT_AUDIT.md`
- Architecture understanding: `PROJECT_SYSTEM_GUIDE.md`
- Auto-fix prompt for Codex: `CODEX_FIX_PROMPT.md`
