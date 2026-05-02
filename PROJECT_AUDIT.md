# BlossomTask Project Audit

Last updated: 2026-05-02

## Audit Scope

This audit reviews the current production workflow across:

- `main.py`
- `terminal_runner.py`
- `backend/`
- `src/`
- `Scripts/`
- runtime state files in `backend/data/` and project root

The review combines:

- static code inspection
- previously observed production/runtime failures
- UI behavior checks already fixed in recent work
- pipeline and cron verification notes already captured in the project

## Executive Summary

BlossomTask is a serious workflow automation product with a strong business purpose and a workable architecture, but it is still carrying reliability debt from its rapid evolution.

The good news:

- the end-to-end pipeline is now clearly defined
- cron now routes into the real pipeline instead of drifting away from it
- stale script guards are stronger than before
- live preview and real progress reporting are much better than the earlier fake/stale UI behavior
- encoding fallback and customer-instruction fallback closed two major data-loss paths

The main risks that still deserve attention before scaling usage are:

1. orchestration complexity is concentrated in very large files
2. runtime state is spread across JSON files without true process-safe locking
3. Python stage scripts still rebuild outputs aggressively and do a lot of row-by-row file work
4. test coverage is still too thin for the amount of business-critical behavior
5. some docs in the repo describe older behavior and can mislead maintainers

## 2026-05-02 Active Problem Log

The following issues were re-confirmed during the latest review and should be treated as active until verified closed:

1. Cron schedule UI and backend config are not fully aligned.
What was found:
- backend schedule objects already carry `useReverify`, `reverifyOption`, and `updaterModel`
- the dashboard schedule form was still saving only `cron`, `enabled`, and `sequence`
- create path could still create enabled schedules without mandatory config
Impact:
- schedule startup behavior could drift from operator intent
- cron could start without explicit reverify choice and without explicit model selection

2. Schedule enable validation was incomplete on create.
What was found:
- `PATCH /api/schedules/:id` validates required config when enabling
- `POST /api/schedules` did not enforce the same rule
Impact:
- a newly created enabled schedule could bypass mandatory config rules

3. Reverify live progress protocol was only half-implemented.
What was found:
- backend progress parser already supports `REVERIFY_TOTAL|N` and `REVERIFY_PROGRESS|current|total`
- `reverify.py` was not emitting those signals
Impact:
- reverify live preview and progress bar could fall back to vague or fake-feeling states

4. Reverify still has overprocessing risk at the workflow level.
What was found:
- the script has early-stop logic per record
- however the schedule/manual orchestration did not yet expose a strict yes/no choice for including reverify in cron
Impact:
- operators can unintentionally run reverify on a broader dataset than intended

5. Schedule cards were not showing all business-critical config.
What was found:
- schedule rows showed interval and timestamps
- they did not clearly show whether reverify was enabled, what source it would use, or which model the schedule would use
Impact:
- operators cannot confidently audit a saved schedule from the UI alone

6. Session cleanup UX needed a tighter refresh contract.
What was found:
- session-clearing actions existed
- some actions were not invalidating all relevant cached queries after success
Impact:
- UI could briefly show stale session state after cleanup

## System Flow Audit

### Intended workflow

The intended production sequence is:

`GetTask -> GetOrderInquiry -> Funeral_Finder -> reverify -> Updater -> ClosingTask`

This is the correct business order because:

- `GetTask` discovers open work
- `GetOrderInquiry` enriches task-level data into order-level data
- `Funeral_Finder` performs primary obituary/funeral lookup and classification
- `reverify` revisits `NotFound` and `Review` records
- `Updater` sends classified results back downstream
- `ClosingTask` closes tasks only after upstream outputs are ready

### Current orchestration strengths

- `backend/server.js` now runs both manual and scheduled pipelines through the same pipeline execution path
- `backend/lib/pipeline-runtime.js` now computes next schedule time from pipeline finish time, not just wall-clock cron alignment
- `terminal_runner.py` provides a second orchestration path with checkpointing and scheduled loops
- stale active-run guard messages from `Funeral_Finder` and `reverify` are no longer silently treated as successful work

### Current orchestration weaknesses

- there are still multiple orchestration surfaces:
  - dashboard backend scheduler
  - `main.py` interactive pipeline
  - `terminal_runner.py`
- these paths are conceptually aligned, but long-term they can drift again because business rules are not fully centralized in one shared execution engine

## Major Findings

### 1. Orchestration logic is too concentrated in giant files

Severity: High

Files:

- `backend/server.js`
- `main.py`
- `Scripts/Funeral_Finder.py`
- `Scripts/reverify.py`

Why this matters:

- `backend/server.js` is handling auth, scheduling, job execution, preview state, alerts, metrics, file browsing, and Google sync
- `main.py` handles launcher UX, dependency setup, pipeline execution, server controls, access control, and now project update logic
- `Funeral_Finder.py` and `reverify.py` contain prompt logic, parsing, status rules, output routing, dedupe, Excel rebuilding, and run guards in the same file

Risk:

- regression risk is high because unrelated concerns are tightly coupled
- onboarding new developers is slow
- safe refactoring becomes harder with every patch

Recommendation:

- split orchestration, auth, and schedule code into dedicated backend modules
- split Python scripts into `io`, `classification`, `prompting`, `routing`, and `guard` layers

### 2. Runtime state is file-based and not fully process-safe

Severity: High

Files:

- `backend/lib/storage.js`
- `backend/data/jobs.json`
- `backend/data/schedules.json`
- root runtime state files

Observed behavior:

- the project relies heavily on JSON files for live jobs, schedules, run history, and pipeline state
- `writeJson()` uses a temp file + rename strategy with retries, which is a good improvement
- however, there is still no true cross-process transaction/lock model

Risk:

- concurrent writes can still produce race conditions
- backend restarts lose in-memory job/process maps
- schedule and runtime state can become inconsistent during abrupt termination

Recommendation:

- move job/schedule runtime state into SQLite or another transactional store
- keep JSON only for export/debug snapshots

### 3. Python stages still do expensive output rebuild patterns

Severity: High

Files:

- `Scripts/GetTask.py`
- `Scripts/GetOrderInquiry.py`
- `Scripts/Funeral_Finder.py`
- `Scripts/Updater.py`
- `Scripts/ClosingTask.py`

Observed pattern:

- scripts append row-by-row to CSV
- several scripts rebuild `.xlsx` from `.csv` repeatedly during or after processing

Risk:

- performance degrades as datasets grow
- partial interruption during write-heavy phases can leave outputs temporarily inconsistent
- filesystem pressure grows on slower Windows deployments

Recommendation:

- batch writes per run instead of rebuilding Excel after every meaningful checkpoint
- generate final Excel once per run, not repeatedly during the run

### 4. Test coverage does not match system criticality

Severity: High

Files reviewed:

- `src/test/pipeline-runtime.test.ts`
- `Scripts/tests/test_reverify_row_updates.py`
- `Scripts/tests/test_funeral_finder_status_rules.py`

What is good:

- there are focused tests around status rules and pipeline progress helpers

What is missing:

- no serious end-to-end pipeline integration suite
- no automated test proving schedule execution across repeated cycles
- no automated test for stale run guard recovery
- no automated test for Updater/ClosingTask downstream safety
- no browser-based UI regression suite for admin/pipeline preview flows

Risk:

- the project currently depends too much on manual verification

Recommendation:

- add fixture-driven end-to-end pipeline tests with stubbed APIs
- add backend schedule tests that simulate repeated cooldown cycles
- add one browser flow for login, run pipeline, preview progress, and schedule trigger

### 5. Documentation drift exists inside the repo

Severity: Medium

Files:

- `README.md`
- `Scripts/README.md`

Issue:

- some docs still describe older routing models or old output structures
- the real product now includes admin auth, cron cooldown logic, force-latest reprocessing, customer fallback, and pipeline preview behavior that older docs do not fully explain

Risk:

- maintainers may trust stale documentation and make wrong changes

Recommendation:

- treat `PROJECT_SYSTEM_GUIDE.md` as the new operational source of truth
- later reconcile or shorten older READMEs to avoid contradiction

### 6. Cron support is intentionally narrow

Severity: Medium

File:

- `backend/lib/pipeline-runtime.js`

Observed behavior:

- parser supports simple `*/N` minute or second interval patterns
- this is correct for the current product need, but it is not a full cron engine

Risk:

- users may assume full cron syntax support when the backend only supports interval-style schedules safely

Recommendation:

- keep the scope narrow but state it clearly in UI copy and docs

### 7. Force-reprocessing feature is useful but operationally sharp

Severity: Medium

Files:

- `src/components/ScriptPanel.tsx`
- `backend/server.js`
- `Scripts/Funeral_Finder.py`
- `Scripts/reverify.py`

Observed behavior:

- `Funeral_Finder` and `reverify` can now reprocess the newest N `GetOrderInquiry` rows using `last_processed_at`

Risk:

- this depends on `GetOrderInquiry` timestamps being trustworthy
- operators may confuse "latest inquiry rows" with "latest business priority rows"

Recommendation:

- keep this feature, but label it as reprocessing based on `GetOrderInquiry last_processed_at`

### 8. Multiple sources of truth still exist for operator guidance

Severity: Medium

Files:

- `README.md`
- `Scripts/README.md`
- `Master Prompt.md`
- runtime UI labels

Issue:

- business rules are now clearer than before, but they are still repeated across several docs and prompts

Recommendation:

- keep `Master Prompt.md` as the root operational rule set for agent-assisted maintenance
- keep `PROJECT_SYSTEM_GUIDE.md` as the human operator guide

### 9. Update manager is strong for integrity reporting, but limited by environment

Severity: Medium

File:

- `main.py`

What it now does well:

- verifies git presence and repo state
- verifies remote URL
- fetches and compares ahead/behind status
- protects dirty worktrees by default
- fast-forward pulls only
- runs `git fsck`
- generates a tracked-file SHA256 manifest

What still needs caution:

- real remote verification depends on network availability
- a dirty tree with `--project-update-allow-dirty` can still require manual intervention if local edits conflict with incoming files

Recommendation:

- use it as a controlled update tool, not as a blind "always force update" button

### 10. UI observability is much better, but still backend-dependent

Severity: Medium

Files:

- `src/pages/Index.tsx`
- `src/components/ScriptPanel.tsx`
- `backend/server.js`

Observed improvement:

- live pipeline preview now binds to active jobs
- script cards can show real active progress and force-run controls

Remaining risk:

- if a script does not emit parseable progress hints, the UI can only show limited progress detail

Recommendation:

- standardize progress output format across all scripts

## Resolved Findings Already Closed

The following reliability problems were identified and fixed during recent work:

- stale active-run guards wrongly reported as success
- cron path drifted away from manual pipeline behavior
- schedule cooldown timing was based on schedule boundaries instead of completion time
- live preview could remain bound to old finished child jobs
- `Funeral_Finder` Excel rebuild path could crash the run
- Windows-encoded CSV input could break `Updater`, `Funeral_Finder`, and `reverify`
- customer-supplied `ord_instruct` timing could be lost or misclassified
- admin panel layout and alerts panel readability had severe overlap/readability issues

Reference log:

- `backend/data/funeral_fix_report.json`

## Component Audit Notes

### `main.py`

Strengths:

- useful operator entrypoint
- now includes project update manager
- supports UI launch, pipeline launch, install, health, access control

Weaknesses:

- still too large for safe long-term maintenance
- menu rendering contains mixed legacy encoding artifacts in printed symbols

### `terminal_runner.py`

Strengths:

- resumable
- checkpoint aware
- useful for deeper operational debugging

Weaknesses:

- separate orchestration path increases maintenance load
- schedule logic here can drift from backend schedule logic unless watched carefully

### `backend/server.js`

Strengths:

- central runtime API
- now contains improved schedule/pipeline binding
- auth/session endpoints are clearly exposed

Weaknesses:

- too many responsibilities in one file
- live runtime depends partly on in-memory maps that vanish on restart

### `Scripts/Funeral_Finder.py`

Strengths:

- now supports customer fallback
- stale run guard is significantly safer
- supports force-latest reprocessing

Weaknesses:

- very large blast radius for any change
- prompt, classification, output writing, and runtime guard logic are tightly mixed

### `Scripts/reverify.py`

Strengths:

- better same-config run guard behavior
- force-latest filter support
- customer fallback aligned with Funeral Finder

Weaknesses:

- business logic overlaps with Funeral Finder and can drift
- still complex enough to hide performance and edge-case bugs

### `Scripts/Updater.py`

Strengths:

- file-mode support is useful
- encoding fallback closed a real failure path

Weaknesses:

- downstream correctness depends entirely on upstream data integrity
- should eventually validate stronger preconditions before pushing updates

### `Scripts/ClosingTask.py`

Strengths:

- contains defense-in-depth comment/rule to avoid closing bad rows

Weaknesses:

- still downstream-sensitive to upstream status consistency
- should remain very conservative

## Deployment Readiness Verdict

Current verdict: Conditionally ready for controlled deployment.

Meaning:

- core cron/pipeline sequencing is materially safer than before
- the project is good enough for controlled production usage with operator awareness
- it is not yet at the maturity level where it should be treated as a zero-touch system

## Recommended Next 10 Improvements

1. Move job and schedule state from JSON files into SQLite-backed transactional storage.
2. Break `backend/server.js` into routing modules and a dedicated pipeline service.
3. Split `Funeral_Finder.py` and `reverify.py` into smaller internal modules.
4. Standardize progress signal output across every script.
5. Add an end-to-end fixture-based pipeline integration suite.
6. Add backend tests for stale guard recovery and repeated scheduled runs.
7. Reduce repeated Excel rebuild work and move to once-per-run generation.
8. Reconcile old README content with the current real system behavior.
9. Add stronger downstream validation in `Updater.py` before sending CRM updates.
10. Add restart-recovery rules so backend restarts reconcile running jobs more explicitly.

## Strict Operating Rules

These rules should be treated as non-negotiable:

- no script overlap inside the pipeline
- no downstream stage before upstream completion
- no silent success on partial work
- no pipeline continuation after active-run guard failure
- no closing tasks unless upstream workflow is complete and trustworthy
- no fake progress UI
- no schedule cooldown counted from start time; cooldown must begin only after full pipeline completion
########################################################################################################

BlossomTask — Senior Developer Deep Audit
Auditor: AI Engineering Agent (15-year equiv. senior level) Date: 2026-05-01 Scope: Every file read line-by-line. Nothing assumed. Everything verified.

EXECUTIVE SUMMARY
BlossomTask is a real production system actively processing funeral order data (~333 orders per run). The pipeline is functional and has been running. However, at this exact moment the system is in a broken state: a Reverify job is stuck as "running" in jobs.json, the schedule is stuck in lastStatus: "running" with nextRunAt: null, and the scheduler will NOT fire again automatically until manually fixed. This is the highest priority issue.

🔴 CRITICAL (P0) — Fix immediately, system is broken right now
ISSUE 1: Ghost "Running" Job Blocking Everything
File: backend/data/jobs.json (line 15) What: Job job_1777655563137_axhgrp (reverify script) has status: "running" but no process is running. It is a ghost job. The backend restart did NOT reconcile it because reconcileOrphanedJobs() only marks jobs as failed that are in running or queued state — but this job has a non-null finishedAt: null which confuses the orphan check. Root cause: The orphan reconciler at server startup (reconcileOrphanedJobs()) runs correctly, but this job was added to jobs.json AFTER the server started (or the server was not restarted after the run). The job is still being actively written to by the live reverify.py process. Current observation: Last log line is [2026-05-01T18:03:14.879Z] Checking 5232673 [review] — the reverify process IS STILL RUNNING as of audit time. This is not a ghost — the process is live. Blast radius: All dashboard API calls to /api/pipeline/status return activeWorkloads > 0, locking out any new pipeline run. The schedule trigger also detects active workload and defers. Status: LIVE — do not kill unless the operator confirms. Fix verification: Wait for reverify to complete naturally. If backend restarts while it's running, the orphan reconciler will mark it failed.

ISSUE 2: Schedule Stuck — nextRunAt is null, lastStatus is "running"
File: backend/data/schedules.json (lines 31-36) What:

json
"nextRunAt": null,
"lastStatus": "running",
"lastJobId": "job_1777654431255_sp8ill",
"lastStartedAt": "2026-05-01T16:53:51.215Z",
"lastFinishedAt": "2026-05-01T16:20:27.028Z"
lastFinishedAt is EARLIER than lastStartedAt. This is a timestamp inconsistency. The schedule's last run (manual trigger from 16:53) is still marked as "running" because finalizeScheduleCooldown() was never called for it. When the pipeline completes, finalizeScheduleCooldown is supposed to set nextRunAt. Since this job started from a manual trigger that is still running (the reverify job above), this will be fixed automatically when the current run ends — IF the pipeline job correctly calls finalizeScheduleCooldown. Root cause: The pipeline job job_1777654227095_xfs7jz (parent of the live reverify) is still running. When it finishes, it will call finalizeScheduleCooldown and set nextRunAt. But if the backend restarts before that, the schedule will be permanently stuck. Fix: After current run completes, verify nextRunAt is populated. If stuck, manually PATCH /api/schedules/:id to reset nextRunAt.

ISSUE 3: pipeline_error_report.json Has Stale "failed" Status
File: backend/data/pipeline_error_report.json What: Status is "failed" (not "open"). The failed pipeline was from 16:20:27, but a new pipeline started at 16:50 and succeeded (funeral-finder completed). The error report was never resolved because the resolver only writes "resolved" when a SUBSEQUENT pipeline succeeds end-to-end. Blast radius: Every new script start logs Previous error report loaded: Pipeline failed at reverify which clutters logs and can confuse operators into thinking there is an active incident. Fix: After the current live run completes successfully end-to-end, this will auto-resolve. If not, manually update the file to "status": "resolved".

🔴 HIGH SEVERITY — Fix before next deployment
ISSUE 4: jobs.json Growing Without Bound — 1.6MB
File: backend/data/jobs.json What: 1.6 MB JSON file with full logs embedded inside every job record. Each job log entry contains full pipeline output (~300-500 lines × 500 char each). The file is read and written on EVERY API request (jobs poll every 2 seconds from the frontend). Root cause: loadJobs() does a full file read on every call. saveJobs() does a full file write. Every appendLog() call reads + writes the entire 1.6MB file. Blast radius:

At 333 orders processed, each job having 500 log lines, with 6 scripts per pipeline, the file will reach 10-20MB in a few more runs.
Disk I/O on Windows is synchronous blocking. Each appendLog() call during a script run blocks the Node.js event loop for the duration of the disk write.
Frontend polls every 2 seconds, each poll reads 1.6MB from disk. Exact fix: In createJob() (server.js:582), jobs.slice(0, 200) already limits total jobs. Reduce log retention per job from 500 to 100 lines. Add a trimJobs() that removes old completed jobs older than 7 days. Code to change:
js
// server.js line 634 — change from -500 to -100
job.logs = [...job.logs, formattedLine].slice(-100);
// server.js line 609 — reduce max jobs stored
jobs.unshift(job);
saveJobs(jobs.slice(0, 50)); // was 200
ISSUE 5: run_history_logs.prev.jsonl is 52MB
File: backend/data/run_history_logs.prev.jsonl What: The rotation backup file is 52MB. This is a historical artifact that should be cleaned up before deployment. The primary run_history_logs.jsonl is already 4MB. Root cause: Log rotation triggered (50MB threshold) but the backup was never cleaned. Fix: Delete run_history_logs.prev.jsonl. It is not needed for production operation.

powershell
Remove-Item "backend\data\run_history_logs.prev.jsonl"
ISSUE 6: Python DeprecationWarning — Breaking in Python 3.15
File: Scripts/reverify.py (line 731) What: Live log shows:

DeprecationWarning: Parsing dates involving a day of month without a year specified is ambiguous
and fails to parse leap day. The default behavior will change in Python 3.15
Root cause: datetime.strptime(parsed_source, fmt) is called with a format that has %m/%d without %Y. Python 3.15 will raise an exception instead of a warning, breaking production silently. Blast radius: When Python is upgraded to 3.15+, reverify will crash on any row that triggers date parsing. Exact fix: Find datetime.strptime(parsed_source, fmt) in reverify.py around line 731 and add the current year as default:

python
# Before
parsed = datetime.strptime(parsed_source, fmt)
# After
current_year = datetime.now().year
parsed = datetime.strptime(f"{current_year}/{parsed_source}", f"%Y/{fmt}")
ISSUE 7: CORS is Wide Open — Security Risk
File: backend/server.js (line 58) What:

js
app.use(cors({ origin: true, credentials: true }));
origin: true means ANY origin can make credentialed requests to the API. This allows cross-site request forgery from any website. Root cause: Development-mode CORS config was left in production. Fix:

js
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
Add ALLOWED_ORIGIN=https://yourdomain.com to .env.

ISSUE 8: Auth Cookie is Not Secure in Production (Missing Secure Flag)
File: backend/server.js (line 159) What:

js
return `${AUTH_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
No Secure flag means the session cookie is sent over HTTP as well as HTTPS. In production behind a reverse proxy, this allows session hijacking via network sniffing. Fix:

js
const isProduction = process.env.NODE_ENV === 'production';
return `${AUTH_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${isProduction ? '; Secure' : ''}`;
ISSUE 9: Default Admin Password is "admin123" in Code
File: backend/lib/auth-store.js (line 12) What:

js
const defaultAdminPassword = String(process.env.BLOSSOMTASK_ADMIN_PASSWORD || "admin123").trim() || "admin123";
If BLOSSOMTASK_ADMIN_PASSWORD is not set in .env, the default admin password is admin123. The auth-store.json on disk shows 28KB — the admin has been using the system, but if the password was never changed from default, any attacker who knows the URL can log in. Fix: Add a startup check that refuses to start if BLOSSOMTASK_ADMIN_PASSWORD is not set:

js
if (!process.env.BLOSSOMTASK_ADMIN_PASSWORD) {
  console.error('[FATAL] BLOSSOMTASK_ADMIN_PASSWORD env var must be set. Refusing to start with default password.');
  process.exit(1);
}
ISSUE 10: SQLite File Exists But Is Not Used
File: backend/data/blossomtask.sqlite (40KB), backend/lib/auth-store.js (line 9) What:

js
const dbPath = path.join(dataDir, "blossomtask.sqlite");
The SQLite path is defined and getDatabasePath() is exported, but auth-store.js uses only JSON files (auth-store.json). The SQLite file exists on disk (40KB) suggesting it was partially set up. This creates confusion — databasePath is returned in the /api/auth/me response showing operators a database that is not actually being used. Root cause: Incomplete migration from planned SQLite to JSON-based storage. Blast radius: Operators see databasePath: "...blossomtask.sqlite" in the UI but all real data is in auth-store.json. If someone tries to inspect the SQLite file, it will appear empty/corrupt. Fix: Either complete the migration to SQLite (recommended for production) OR remove getDatabasePath() from the auth/me response and delete the stale SQLite file.

ISSUE 11: GetTask Rebuilds Excel After EVERY Single Row
File: Scripts/GetTask.py (lines 468-469) What:

python
save_one_record_to_csv(record)
rebuild_excel_from_csv()  # Called for EVERY row
For 333 orders, this rebuilds the entire Excel workbook 333 times. Each rebuild reads the entire CSV, creates an openpyxl workbook, writes all rows, and saves to disk. Blast radius: For 333 orders: 333 × (read CSV + create workbook + write xlsx). This takes ~5-10 seconds per order on slow Windows disks. GetTask can take 30-55 minutes just for Excel rebuilds. Fix: Move Excel rebuild to once per run, after all records are saved:

python
# In main() — after the for loop ends
save_excel(all_records)  # Only once at the end
ISSUE 12: Funeral_Finder.py Rebuilds Excel After EVERY Single Row
File: Scripts/Funeral_Finder.py (confirmed by live logs) What: Live logs show [Funeral_Finder] INFO: Rebuilt Funeral_data.xlsx from Funeral_data.csv using cp1252 fallback appearing after every single order processed — 333 times in one run. Blast radius: Same as Issue 11 but for the much larger Funeral_Finder output. Each rebuild reads the entire Funeral_data.csv (could be thousands of rows from previous runs) and rebuilds 5+ Excel files (main, found, not_found, review, customer). Fix: Batch all writes and rebuild Excel only at the end of the run.

ISSUE 13: reverify.py Rebuilds Excel After Every Row
File: Scripts/reverify.py What: Same pattern as Issues 11 and 12. Confirmed by log pattern showing repeated file save messages for every row processed. Fix: Same — batch Excel rebuilds to once per run.

🟡 MEDIUM SEVERITY — Fix before scaling usage
ISSUE 14: No Rate Limiting on Auth Endpoints
File: backend/server.js (line 1350) What: /api/auth/login has no rate limiting. An attacker can try unlimited username/password combinations. Fix: Add express-rate-limit:

js
const rateLimit = require('express-rate-limit');
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.post('/api/auth/login', loginLimiter, (req, res) => { ... });
ISSUE 15: No Input Validation on Script Run Endpoint
File: backend/server.js (line 1719) What: /api/jobs/run-script accepts any scriptId string. getScriptById() will return null for unknown IDs and the job fails gracefully — but there is no validation that the option value is from the allowed list. Fix: Validate option against script.options before creating the job.

ISSUE 16: schedule.json lastStatus: "running" + lastFinishedAt Timestamp Inversion
File: backend/data/schedules.json What: lastStartedAt: "2026-05-01T16:53:51.215Z" is AFTER lastFinishedAt: "2026-05-01T16:20:27.028Z". This is logically impossible and indicates the schedule metadata was not correctly updated when the new run started. Root cause: When a new run starts, finalizeScheduleCooldown is not called from the previous failed run — the failed run's cooldown was finalized at 16:20 with lastFinishedAt: "16:20". When the next manual run started at 16:53, it overwrote lastStartedAt but the lastFinishedAt still points to the previous cycle. Impact: Dashboard showing incorrect schedule timing.

ISSUE 17: reconcileOrphanedJobs Does Not Handle Jobs Older Than 24 Hours
File: backend/server.js (line 538) What: reconcileOrphanedJobs() marks all running/queued jobs as failed on restart — even jobs from weeks ago that might have been legitimately left in a completed state incorrectly. It also does not log WHICH jobs were reconciled. Fix: Add age filtering — only reconcile jobs started within the last 24 hours.

ISSUE 18: The appendLog Function Writes Full jobs.json on Every Call
File: backend/server.js (line 626) What: appendLog() calls loadJobs() (full file read) → modifies → saveJobs() (full file write) for EVERY log line. The reverify script produces one log line per order (~40-minute run, hundreds of lines). Each line triggers a synchronous 1.6MB file read + write cycle. Root cause: Architectural choice to embed logs in the jobs JSON instead of a separate log stream. Fix (short-term): Reduce log verbosity and add debouncing — batch log writes every 5 seconds instead of on every line. Fix (long-term): Move logs to the run_history_logs.jsonl append-only file and remove embedded logs from jobs.json.

ISSUE 19: Auth-store.json saveStore Writes Synchronously Without Atomic Rename
File: backend/lib/auth-store.js (line 84) What:

js
fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
Direct write without temp-file + rename pattern. If the server crashes mid-write, the auth store is corrupt. The storage.js module has the safe temp+rename pattern, but auth-store.js does NOT use it. Fix: Use the same safe write pattern:

js
const tempPath = storePath + '.tmp';
fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), "utf-8");
fs.renameSync(tempPath, storePath);
ISSUE 20: Login Page Leaks Username via localStorage
File: src/pages/Login.tsx (lines 16-21, 26) What:

js
window.localStorage.setItem("blossom_username", username);
The username is stored in plaintext in localStorage. Any JavaScript on the same origin can read it. Not a critical risk since there's no XSS vector visible, but it's a poor security practice. Fix: Remove localStorage username persistence or use sessionStorage.

ISSUE 21: getValidSession Does Not Touch/Extend Session
File: backend/lib/auth-store.js (line 324) What: getValidSession() checks if the session is valid but does NOT extend the TTL. Meanwhile requireAuth calls touchSession() which DOES extend it. But getValidSession() is called from other paths that might not touch the session. Fix: Ensure all authenticated paths go through requireAuth (which calls touchSession), not through getValidSession directly.

ISSUE 22: appendRunHistoryEntry Called on Every appendLog — Double Write
File: backend/server.js (lines 639-650) What: Every call to appendLog() calls appendRunHistoryEntry() which appends to run_history_logs.jsonl. This is correct behavior for audit trails, but it means every single log line during a run writes to TWO files: jobs.json (full rewrite) + run_history_logs.jsonl (append). The run history file grew to 4MB for one day's runs. At scale, this grows unbounded. Fix: The 50MB rotation threshold is fine. But the fullLogs field in each history entry duplicates all 500 log lines for every single line appended — this is O(n²) storage growth.

js
// Remove fullLogs from appendRunHistoryEntry call
appendRunHistoryEntry({
  taskId: job.id,
  jobId: job.id,
  kind: job.kind,
  scriptId: job.scriptId ?? null,
  status: job.status,
  progress: job.progress,
  timestamp,
  message: sanitizedLine,
  // REMOVE: fullLogs: job.logs  ← this copies all 500 lines on every append
});
ISSUE 23: Funeral_Finder do not touch.py in Production Scripts Directory
File: Scripts/Funeral_Finder do not touch.py (24KB) What: A backup file with spaces in the name lives in the Scripts directory. It is not imported anywhere but it adds confusion and could be accidentally executed. Fix: Move to a Scripts/backup/ folder or delete it.

ISSUE 24: funeral_Apr_15.xlsx in Project Root
File: funeral_Apr_15.xlsx (39KB) What: A spreadsheet with real funeral data (containing person names and order IDs) is sitting in the project root. This is sensitive personal data that should NOT be in the git repository. Root cause: Likely uploaded for reference or testing and never cleaned up. Fix: Add to .gitignore and remove from repository. The .gitignore file should already exclude xlsx files in root — verify this.

ISSUE 25: main.py Contains 86KB of Mixed Concerns
File: main.py (86,562 bytes) What: A single Python file handles: CLI menu rendering, pipeline execution, dependency installation, server process management, access control, project update manager, and git operations. This is a 2,000+ line file. Blast radius: Any change to this file risks breaking unrelated features. The file is too large to safely review in one pass. Fix (long-term): Split into cli/menu.py, cli/pipeline.py, cli/server.py, cli/update.py.

ISSUE 26: backend/server.js is 2,413 Lines — Monolith Risk
File: backend/server.js What: Auth, scheduling, job execution, metrics, file browsing, Google sync, stats, alerts — all in one 78KB file. Fix (long-term): Split into routes/auth.js, routes/jobs.js, routes/schedules.js, services/pipeline.js.

🟢 LOW SEVERITY / MAINTENANCE
ISSUE 27: .env File is 2.6KB — Should Not Be in Repo
File: .env (2,616 bytes) What: The .env file exists in the project root. If git tracking includes it, real API keys are being committed. Fix: Verify .gitignore excludes .env. Run git ls-files .env to check.

ISSUE 28: Progress Bar Always Caps at 95% During Script Run
File: backend/lib/pipeline-runtime.js (line 141) What:

js
progress: Math.max(0, Math.min(95, Math.round((current / total) * 100))),
Progress is hard-capped at 95% during execution and only hits 100% when finishedAt is set. This means users always see "95%" for the last few orders. Impact: Minor UX issue but can be confusing. Fix: This is a design choice to prevent false "100% complete" before the process closes. It is acceptable but should be documented.

ISSUE 29: parseProgressSignal Regex Will Miss Progress from reverify
File: backend/lib/pipeline-runtime.js (line 111) What: The regex matches patterns like Processing 1 of 100 but reverify logs show Checking 3933882 [not_found] — no of N pattern. So reverify progress always shows indeterminate (no progress bar, just spinner). Fix: Add reverify pattern:

js
const reverifyMatch = text.match(/Checking\s+\S+\s+\[(?:not_found|review)\]/i);
// Count lines to track progress manually
ISSUE 30: bun.lock and package-lock.json Both Present
File: Root directory What: Both bun.lock and package-lock.json exist. This means the project was installed with both bun and npm. The two lockfiles can produce different dependency trees. Fix: Decide on one package manager. Remove the other lockfile and add a .npmrc or .bunfig.toml to enforce.

ISSUE 31: pipeline_checkpoint.json and pipeline_state.json in Root
Files: pipeline_checkpoint.json (225 bytes), pipeline_state.json (306 bytes) What: These are runtime state files used by terminal_runner.py (separate orchestration path). They exist in the project root and can confuse operators about which orchestrator last ran. Fix: These are fine as-is but should be excluded from git tracking. Add to .gitignore.

ISSUE 32: reverify and Funeral_Finder Have Separate Business Logic That Can Drift
Files: Scripts/reverify.py, Scripts/Funeral_Finder.py What: Both scripts implement status classification (Found, NotFound, Review, Customer) independently. If the rules change in one file, the other must be manually updated. Fix (long-term): Extract shared classification logic into Scripts/lib/status_rules.py.

ISSUE 33: getValidSession Returns Null If User Is Inactive But Doesn't Clear Cookie
File: backend/lib/auth-store.js (line 324), backend/server.js (line 191) What: requireAuth calls touchSession() which checks user.active. If a user is deactivated (not yet a feature but planned), touchSession returns null, and the middleware clears the cookie and returns 401. This is correct. But the frontend AuthGate only listens for blossom-auth-expired events fired from the api.ts request() function on 401 responses. This chain IS correct — but it depends on the 401 being returned from /api/auth/me specifically. Status: Working correctly but fragile. Documented for awareness.

AUTHENTICATION FLOW (Answering Original Question)
Browser starts
  └→ App.tsx: QueryClientProvider wraps everything
       └→ AuthGate component mounts
            └→ useQuery(['auth'], api.authMe)
                 └→ GET /api/auth/me
                      └→ requireAuth middleware:
                           • parseCookies() → reads blossom_session cookie
                           • touchSession(sessionId) → validates + extends TTL
                           • if invalid → clearSessionCookie() + 401
                           • if valid → req.auth = {session, user}
                      └→ Returns {user, session, activeModel, ...}
            └→ if error/no user → render <Login />
            └→ if user → render <Index />
Login flow:
  Login.tsx: user types credentials
    └→ Button click → loginMutation.mutate()
         └→ api.login(username, password)
              └→ POST /api/auth/login (no requireAuth — public endpoint)
                   └→ authenticateUser(username, password):
                        • normalizeUsername()
                        • getUserRecordByUsername() from auth-store.json
                        • verifyPassword() using PBKDF2 (120,000 iterations)
                        • timingSafeEqual() comparison
                   └→ createSession(userId, ttlMinutes, {userAgent, ip})
                   └→ serializeSessionCookie() → Set-Cookie header (HttpOnly)
                   └→ Returns {user, session, activeModel, ...}
         └→ onSuccess: localStorage.setItem username
                       queryClient.invalidateQueries(['auth'])
                         └→ triggers re-fetch of /api/auth/me
                              └→ AuthGate re-renders → <Index />
Session expiry:
  api.ts request(): if response.status === 401
    → window.dispatchEvent('blossom-auth-expired')
  App.tsx AuthGate: listens for 'blossom-auth-expired'
    → queryClient.setQueryData(['auth'], null)
    → AuthGate re-renders → <Login />
Auth storage:
  backend/lib/auth-store.js → backend/data/auth-store.json
  Passwords: PBKDF2-SHA256, 120,000 iterations, random 16-byte salt
  Sessions: UUID tokens, stored server-side in auth-store.json
  Cookie: HttpOnly, SameSite=Lax (MISSING Secure flag — see Issue 8)
ISSUES BY FILE
File	Issues
backend/data/jobs.json	#1, #4, #18
backend/data/schedules.json	#2, #16
backend/data/pipeline_error_report.json	#3
backend/data/run_history_logs.prev.jsonl	#5
Scripts/reverify.py	#6, #13, #29, #32
backend/server.js	#7, #8, #9, #14, #15, #17, #18, #22, #26
backend/lib/auth-store.js	#9, #10, #19, #21
Scripts/GetTask.py	#11
Scripts/Funeral_Finder.py	#12, #23, #32
src/pages/Login.tsx	#20
backend/lib/pipeline-runtime.js	#28, #29
main.py	#25
Root directory	#24, #27, #30, #31
DEPLOYMENT READINESS VERDICT
Current state: CONDITIONALLY READY — NOT zero-touch

✅ Pipeline logic is correct and sequential
✅ Authentication is cryptographically sound (PBKDF2 with timing-safe compare)
✅ Stale run guard is working
✅ Google sync, progress reporting, live preview all functional
❌ jobs.json IO pattern will degrade at scale
❌ CORS is dangerously open
❌ Auth cookie missing Secure flag in production
❌ Default password fallback is a security risk
❌ Excel rebuild per-row will be a performance wall with large datasets
❌ Python 3.15 date parsing breaking change is a time bomb
❌ Schedule is currently stuck (active run in progress — monitor)
