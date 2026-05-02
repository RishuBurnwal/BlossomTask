# 🤖 CODEX_FIX_PROMPT — Complete Auto-Fix Instructions for BlossomTask
> **Paste this entire prompt into Codex/Claude Code.** It will fix all issues step-by-step with verification.
> **Version:** 2.0.0 | **Updated:** 2026-05-02

---

## CONTEXT FOR AI

You are working on **BlossomTask**, a funeral flowers company automation pipeline. The project:
- Fetches open CRM tasks (orders where someone needs a funeral flower arrangement)
- Enriches orders with customer/shipping data
- Uses Perplexity AI to search obituaries for service dates/funeral homes
- Uploads findings to CRM
- Closes tasks automatically

The pipeline has serious bugs. Fix them in EXACTLY the order listed below. After each fix, run the specified verification command. DO NOT move to the next fix until verification passes.

**Repository root is your working directory.** All paths are relative to repo root.

---

## ROLE
You are a senior software engineer implementing a verified, step-by-step fix plan for the BlossomTask funeral order automation pipeline. Work through **one fix at a time**, verify it before moving to the next, and update all relevant files including PROJECT_AUDIT, PROJECT_SYSTEM_GUIDE, PROJECT_TODO, and README.md after each verified fix.

## REPOSITORY
https://github.com/RishuBurnwal/BlossomTask  
Working directory: project root

## CRITICAL CONTEXT
This is a production system for a funeral flowers company. Wrong behavior means:
- Orders are missed → flowers never arrive for funerals
- Orders are duplicated → wrong data sent to CRM multiple times  
- Pipeline silently "succeeds" but does nothing → company wastes hours investigating manually

**The system currently appears to run but is processing ZERO actual orders on every cycle after the first.**

---

## CONFIRMED PRODUCTION FAILURES (from live jobs.json log)

```
1. Reverify: "Another run with same config is active since 2026-05-01T05:18:28...skipping"
   → reverify processed 0 records; returned exit code 0 (FAKE SUCCESS)

2. Updater: "Pre-filtered 203 already-processed order IDs from logs.txt → 0 orders"
   → Updater processed 0 records; 203 orders permanently stuck in logs.txt

3. ClosingTask: "Pre-filtered 77 already-processed order IDs from logs.txt → 0 tasks"
   → ClosingTask closed 0 tasks; permanently stuck
```

---

## 🔴 FIX 1: reverify.py — Add Processed Order ID Tracking (Prevent Duplicate Processing)

### Problem
`Scripts/reverify.py` processes ALL records every time it runs. It has no `logs.txt` file to track which order_ids were already processed. This causes duplicate CRM uploads.

### What To Do

**Step 1:** Open `Scripts/reverify.py`. Find where it reads the input CSV files (not_found and review records). Add this code at the TOP of the main function (before the loop):

```python
import os

# Idempotency guard — track processed order IDs
REVERIFY_LOG_PATH = os.path.join(os.path.dirname(__file__), "outputs", "Funeral_Finder", "reverify_logs.txt")
os.makedirs(os.path.dirname(REVERIFY_LOG_PATH), exist_ok=True)

# Load already-processed order IDs
_reverify_processed = set()
if os.path.exists(REVERIFY_LOG_PATH) and "--force" not in sys.argv:
    with open(REVERIFY_LOG_PATH, "r", encoding="utf-8") as _f:
        _reverify_processed = set(line.strip() for line in _f if line.strip())

print(f"[Reverify] Loaded {len(_reverify_processed)} already-processed order IDs from logs")
```

**Step 2:** In the loop that processes each record, add a skip check:
```python
order_id = str(row.get("order_id", "")).strip()
if order_id in _reverify_processed:
    print(f"[Reverify] Skipping already-processed order_id: {order_id}")
    continue
```

**Step 3:** After successfully processing each record, add:
```python
_reverify_processed.add(order_id)
with open(REVERIFY_LOG_PATH, "a", encoding="utf-8") as _log:
    _log.write(order_id + "\n")
```

**Step 4:** Add `import sys` at the top if not already present.

### Verification
```bash
# Run reverify first time — should process all records
python Scripts/reverify.py

# Check that reverify_logs.txt was created with order IDs
cat Scripts/outputs/Funeral_Finder/reverify_logs.txt

# Run reverify SECOND time — should process ZERO records (all skipped)
python Scripts/reverify.py
# Expected output: "[Reverify] Skipping already-processed order_id: ..." for all records
# Expected: "Processed 0 new records" or similar
```

**STOP HERE. Do not proceed to Fix 2 until verification passes.**

---

## 🔴 FIX 2: terminal_runner.py — Fix Scheduled Mode Force-Flag Abuse

### Problem
In scheduled mode, `terminal_runner.py` automatically sets `start_mode = "fresh"` for every cycle after the first. This causes `--force` to be passed to ALL scripts (including Funeral_Finder and reverify), making them reprocess ALL records every cycle — wasting Perplexity API credits and creating duplicates.

### What To Do

**Step 1:** Open `terminal_runner.py`. Find the `_run_loop()` method. Locate this exact code block:

```python
if run_mode == "scheduled" and cycle > 1:
    # Scheduled runs should execute a fresh full cycle, not remain stuck at checkpoint end.
    start_mode = "fresh"
```

**Step 2:** REPLACE it with:
```python
if run_mode == "scheduled" and cycle > 1:
    # Scheduled cycles use "continue" mode — only process NEW records not in logs.txt
    # Scripts use their own logs.txt for idempotency — do NOT force re-run
    # Only reset checkpoint so all scripts run again, but without --force flag
    start_mode = "continue"
    self.store.reset_checkpoint()  # Allow all scripts to run again, but scripts skip processed IDs
```

**Step 3:** In `_execute_once()`, find the line:
```python
force=(start_mode == "fresh"),
```
Confirm this still correctly passes `--force` ONLY when user explicitly chose "fresh" start mode. With the above change, scheduled cycles will now have `start_mode = "continue"` so `force=False`.

**Step 4:** Also update the comment in `_run_loop()` just before the changed block:
```python
# Note: Each pipeline script maintains its own logs.txt for idempotency.
# Scheduled mode resets checkpoint so all scripts run, but scripts skip
# already-processed order_ids via their individual logs.txt files.
# --force is NEVER automatically set in scheduled mode.
```

### Verification
```bash
# Start terminal runner in scheduled mode (use 1-minute interval for testing)
python terminal_runner.py
# Select: [2] Scheduled
# Select interval: 1 (1 minute)

# After first cycle completes, wait for second cycle to start
# In second cycle output, confirm Funeral_Finder shows:
# "Skipping X already-processed order IDs" NOT "Processing all records"
# Also confirm: NO "--force" flag in subprocess command output

# Check pipeline_logs.jsonl for start_mode of cycle 2:
python -c "
import json
with open('pipeline_logs.jsonl') as f:
    for line in f:
        e = json.loads(line)
        if e.get('event') == 'run_started' and e.get('cycle', 0) > 1:
            print('Cycle 2 start_mode:', e.get('start_mode'))
            break
"
# Expected: Cycle 2 start_mode: continue (NOT fresh)
```

**STOP HERE. Verify before proceeding.**

---

## 🔴 FIX 3: terminal_runner.py — Fix Stale "running" State

### Problem
If Python crashes mid-pipeline, `pipeline_state.json` stays as `"status": "running"` forever. The UI shows "Pipeline Running" even though nothing is running. New runs may be blocked.

### What To Do

**Step 1:** Open `terminal_runner.py`. In the `run()` method of `TerminalPipelineRunner`, add a startup check at the VERY BEGINNING (before asking user for start_mode):

```python
def run(self) -> int:
    print("\n=== BlossomTask Terminal Pipeline Runner ===")
    
    # STARTUP: Detect and fix stale "running" state from crashed previous run
    self._recover_stale_state()
    
    start_mode = self._ask_start_mode()
    # ... rest of method unchanged
```

**Step 2:** Add the recovery method to the class:

```python
def _recover_stale_state(self) -> None:
    """On startup, detect stale 'running' state from a crashed previous run and reset it."""
    try:
        state = self.store._safe_read_json(STATE_FILE, {})
        if str(state.get("status", "")).lower() != "running":
            return
        
        # Check if the previous owner PID is still alive
        # We write our own PID to state when we start, but previous crash won't have it
        # So any leftover "running" state at startup = stale
        print("[Runner] WARNING: Found stale 'running' state from previous session.")
        print("[Runner] Resetting to 'failed' status (previous run likely crashed).")
        
        self.store.save_state({
            **state,
            "status": "failed",
            "reason": "Recovered from stale running state on startup — previous run likely crashed",
        })
        self.store.log_event({
            "event": "stale_state_recovered",
            "previous_status": "running",
            "recovered_to": "failed",
        })
    except Exception as exc:
        print(f"[Runner] Could not check/recover state: {exc}")
```

**Step 3:** Wrap the main execution body in `_execute_once()` with try/finally:

Find the `_execute_once()` method. After `self.store.save_state({"status": "running", **run_context})`, find the main for-loop block and wrap it:

```python
try:
    for script_id in sequence[start_index:]:
        # ... existing loop code unchanged ...
    
    self.store.save_state({"status": "success", **run_context})
    # ... rest of success return
    
except Exception as exc:
    # Unexpected crash — write failed state so UI doesn't show "running"
    self.store.save_state({
        "status": "failed",
        "reason": f"Unexpected error: {exc}",
        **run_context,
    })
    self.store.log_event({
        "event": "unexpected_crash",
        "error": str(exc),
        **run_context,
    })
    raise  # Re-raise so caller sees the exception
```

### Verification
```bash
# Test 1: Normal crash recovery
# 1. Start a pipeline run
python terminal_runner.py  # Start fresh, single run

# 2. While running, hard-kill the process (in another terminal):
pkill -f terminal_runner.py  # or kill -9 <pid>

# 3. Check state shows "failed" (not "running"):
python -c "import json; s=json.load(open('pipeline_state.json')); print('Status:', s['status'])"
# Expected: Status: failed  OR  (with new recovery) will be fixed on next startup

# 4. Start runner again — confirm startup message appears:
python terminal_runner.py
# Expected: "[Runner] WARNING: Found stale 'running' state..."
# Expected: "[Runner] Resetting to 'failed' status..."

# Test 2: Normal successful run still works
python terminal_runner.py  # Run through completion
python -c "import json; print(json.load(open('pipeline_state.json'))['status'])"
# Expected: success
```

**STOP HERE. Verify before proceeding.**

---

## 🔴 FIX 4: terminal_runner.py + backend/server.js — Unify Cron Entry Point

### Problem
Backend cron (`node-cron` in `server.js`) and `terminal_runner.py` are two completely separate systems that both try to run the pipeline. This causes double execution, lock conflicts, and inconsistent state tracking.

### What To Do

**Step 1:** Add a `--once` flag to `terminal_runner.py`. In the `if __name__ == "__main__":` block at the bottom:

```python
if __name__ == "__main__":
    import argparse as _argparse
    _parser = _argparse.ArgumentParser()
    _parser.add_argument("--once", action="store_true", help="Run one pipeline cycle and exit (for cron use)")
    _parser.add_argument("--mode", default="continue", choices=["fresh", "continue"], help="Start mode for --once")
    _args, _ = _parser.parse_known_args()
    
    if _args.once:
        # Non-interactive single run for backend cron
        runner = TerminalPipelineRunner()
        runner._recover_stale_state()
        result = runner._execute_once(
            start_mode=_args.mode,
            run_mode="scheduled",
            sequence=list(PIPELINE_SEQUENCE),
            updater_mode="complete",
            reverify_source="both",
            cycle=1,
        )
        raise SystemExit(0 if result["status"] == "success" else 1)
    else:
        raise SystemExit(run_terminal_pipeline())
```

**Step 2:** Open `backend/server.js`. Find the cron job handler (where `node-cron` fires the pipeline). Replace the direct script-spawning logic with a call to `terminal_runner.py --once`:

```javascript
// Find the cron schedule trigger function in server.js
// Replace the pipeline execution block with:

async function runPipelineViaCron(scheduleId) {
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
  const terminalRunnerPath = path.join(__dirname, '..', 'terminal_runner.py');
  
  // Check if pipeline is already running via state file
  const stateFile = path.join(__dirname, '..', 'pipeline_state.json');
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state.status === 'running') {
      console.log(`[Cron:${scheduleId}] Pipeline already running, skipping this cycle`);
      return;
    }
  } catch (e) { /* state file not found — proceed */ }
  
  console.log(`[Cron:${scheduleId}] Triggering pipeline via terminal_runner.py --once`);
  
  const proc = spawn(pythonBin, [terminalRunnerPath, '--once', '--mode=continue'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'pipe',
    env: { ...process.env }
  });
  
  proc.stdout.on('data', (data) => console.log(`[Pipeline] ${data.toString().trim()}`));
  proc.stderr.on('data', (data) => console.error(`[Pipeline:ERR] ${data.toString().trim()}`));
  
  proc.on('exit', (code) => {
    console.log(`[Cron:${scheduleId}] Pipeline finished with exit code: ${code}`);
  });
}
```

**Step 3:** Make sure `const { spawn } = require('child_process');` and `const fs = require('fs');` are imported at top of server.js if not already.

### Verification
```bash
# Test 1: --once flag works
python terminal_runner.py --once --mode=continue
# Expected: Runs one pipeline cycle non-interactively and exits
# Check: pipeline_state.json shows success or failed (not running after exit)

# Test 2: Backend cron uses terminal_runner
# Start backend server
node backend/server.js &

# Create a test schedule (1 minute interval) via API:
curl -X POST http://localhost:8787/api/schedules \
  -H "Content-Type: application/json" \
  -d '{"name": "test", "cron": "* * * * *", "enabled": true}'

# Wait 1 minute, check logs for "[Cron:...] Triggering pipeline via terminal_runner.py --once"
# And NOT the old direct spawning pattern

# Test 3: Double-trigger protection
# Trigger pipeline manually + have cron also fire — second one should skip
curl -X POST http://localhost:8787/api/schedules/{id}/trigger
sleep 2
curl -X POST http://localhost:8787/api/schedules/{id}/trigger
# Second trigger: check log for "Pipeline already running, skipping this cycle"
```

**STOP HERE. Verify before proceeding.**

---

## 🟠 FIX 5: main.py — Fix Session Revocation on Password Change

### Problem
When a user's password is changed via Access Control Manager, the UI says "All active sessions revoked" but the code does NOT actually revoke sessions. Old sessions remain valid — a security vulnerability.

### What To Do

**Step 1:** Open `main.py`. Find `_update_user_password()` function. Add session revocation:

```python
def _update_user_password(conn, username, password):
    normalized_username = str(username or "").strip().lower()
    if not normalized_username:
        raise ValueError("username is required")
    if not str(password or "").strip():
        raise ValueError("password is required")
    row = conn.execute("SELECT id FROM users WHERE username = ?", (normalized_username,)).fetchone()
    if row is None:
        raise ValueError("user not found")
    timestamp = _utc_now_iso()
    # Revoke all active sessions BEFORE changing password
    conn.execute(
        "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
        (timestamp, row["id"]),
    )
    # Now update password
    conn.execute(
        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
        (_hash_password(password), timestamp, row["id"]),
    )
    conn.commit()
```

### Verification
```bash
python -c "
import sqlite3, main, time

# Setup test
conn = main._auth_db_connection()

# Create test user
try:
    main._create_user(conn, 'testuser_revoke', 'password123', 'user')
except: pass

# Get user id
row = conn.execute('SELECT id FROM users WHERE username = ?', ('testuser_revoke',)).fetchone()
user_id = row['id']

# Create fake active session
now = main._utc_now_iso()
conn.execute(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    ('test-session-1', user_id, now, now, now)
)
conn.commit()

# Change password — should revoke sessions
main._update_user_password(conn, 'testuser_revoke', 'newpassword456')

# Check session is revoked
session = conn.execute('SELECT revoked_at FROM sessions WHERE id = ?', ('test-session-1',)).fetchone()
print('Session revoked_at:', session['revoked_at'])
assert session['revoked_at'] is not None, 'FAIL: Session was NOT revoked!'
print('PASS: Session correctly revoked after password change')

# Cleanup
conn.execute('DELETE FROM users WHERE username = ?', ('testuser_revoke',))
conn.commit()
conn.close()
"
```

**STOP HERE. Verify before proceeding.**

---

## 🟠 FIX 6: backend/server.js — Add Rate Limiting

### What To Do

**Step 1:**
```bash
npm install express-rate-limit
```

**Step 2:** Open `backend/server.js`. At the top, add:
```javascript
const rateLimit = require('express-rate-limit');

// Rate limiters
const pipelineLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'Too many pipeline requests. Please wait before retrying.' }
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests.' }
});
```

**Step 3:** Apply limiters to routes:
```javascript
// Apply to pipeline routes
app.use('/api/jobs/run-pipeline', pipelineLimiter);
app.use('/api/jobs/run-script', pipelineLimiter);
app.use('/api/schedules/:id/trigger', pipelineLimiter);

// Apply general limiter to all routes
app.use(generalLimiter);
```

### Verification
```bash
# Start server
node backend/server.js &

# Hit pipeline endpoint 11 times quickly
for i in $(seq 1 11); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8787/api/jobs/run-pipeline \
    -H "Content-Type: application/json" -d '{}'
done
# First 10: should return 200 or 400 (not 429)
# 11th: should return 429
```

**STOP HERE. Verify before proceeding.**

---

## 🟠 FIX 7: main.py — Save Admin Credentials on First Boot

### What To Do

**Step 1:** Open `main.py`. Find `_seed_default_admin()`. After the commit, add:

```python
# Save credentials to file if auto-generated
if not os.getenv("BLOSSOMTASK_ADMIN_PASSWORD"):
    creds_file = AUTH_DB_PATH.parent / "INITIAL_CREDENTIALS.txt"
    creds_content = (
        f"=== BlossomTask Initial Admin Credentials ===\n"
        f"Username: {username.lower()}\n"
        f"Password: {password}\n"
        f"\n"
        f"⚠️  DELETE THIS FILE IMMEDIATELY AFTER FIRST LOGIN!\n"
        f"⚠️  Do not share or commit this file.\n"
        f"Generated: {_utc_now_iso()}\n"
    )
    creds_file.write_text(creds_content, encoding="utf-8")
    # Restrict permissions on Linux/Mac
    try:
        import stat
        creds_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except Exception:
        pass
    print_warn(f"⚠️  Admin credentials saved to: {creds_file}")
    print_warn(f"    Username: {username.lower()}")
    print_warn(f"    DELETE THE FILE after first login!")
```

### Verification
```bash
# Remove database to force re-seeding
rm -f backend/data/blossomtask.sqlite

# Run main.py
python main.py --health

# Check credentials file exists
cat backend/data/INITIAL_CREDENTIALS.txt
# Expected: shows username and password

# Confirm admin can login with those credentials (test via API if auth endpoint exists)
```

**STOP HERE. Verify before proceeding.**

---

## 🟠 FIX 8: backend/lib/storage.js — Atomic JSON Writes

### What To Do

**Step 1:** Open `backend/lib/storage.js`. Find all `fs.writeFileSync(filePath, JSON.stringify(...))` calls.

**Step 2:** Replace each with an atomic write function:

```javascript
const fs = require('fs');
const path = require('path');

function atomicWriteJson(filePath, data) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);  // Atomic on POSIX systems
}
```

**Step 3:** Apply same pattern to `terminal_runner.py`'s `RuntimeStore._write_json()`:

```python
@staticmethod
def _write_json(path: Path, payload: dict) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp_path.replace(path)  # Atomic rename on POSIX; best-effort on Windows
```

### Verification
```bash
python -c "
from terminal_runner import RuntimeStore
from pathlib import Path
import json

store = RuntimeStore()
test_path = Path('/tmp/test_atomic.json')

# Write normally
store._write_json(test_path, {'test': 'value', 'count': 42})

# Read back
result = json.loads(test_path.read_text())
assert result['count'] == 42, 'Write failed'
print('PASS: Atomic write works correctly')
test_path.unlink(missing_ok=True)
"
```

---

## 🟡 FIX 9: Scripts/GetTask.py — Skip Already-Closed Orders

### What To Do

**Step 1:** Open `Scripts/GetTask.py`. Find where it builds the list of tasks to process.

**Step 2:** Add cross-reference check against ClosingTask logs:

```python
import os

# Load order_ids that have already been fully closed
CLOSING_LOG_PATH = os.path.join(os.path.dirname(__file__), "outputs", "ClosingTask", "logs.txt")
already_closed = set()
if os.path.exists(CLOSING_LOG_PATH):
    with open(CLOSING_LOG_PATH, "r", encoding="utf-8") as f:
        already_closed = set(line.strip() for line in f if line.strip())

print(f"[GetTask] Excluding {len(already_closed)} already-closed order IDs")

# In the loop that processes fetched tasks, add:
if str(task.get("order_id", "")).strip() in already_closed:
    print(f"[GetTask] Skipping already-closed order: {task['order_id']}")
    continue
```

### Verification
```bash
# Add a test order_id to ClosingTask logs
echo "TEST-ORDER-999" >> Scripts/outputs/ClosingTask/logs.txt

# Run GetTask — if TEST-ORDER-999 appears in CRM tasks, it should be skipped
python Scripts/GetTask.py

# Check GetTask output CSV — TEST-ORDER-999 should NOT appear
python -c "
import pandas as pd
df = pd.read_csv('Scripts/outputs/GetTask/data.csv')
assert 'TEST-ORDER-999' not in df['order_id'].values, 'FAIL: Closed order was re-fetched!'
print('PASS: Already-closed orders correctly excluded')
"
```

---

## 🟡 FIX 10: Docker — Add Production Config + Fix Healthcheck

### Step 1: Create docker-compose.prod.yml
```yaml
# docker-compose.prod.yml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
      target: production
    ports:
      - "8080:8080"
      - "8787:8787"
    env_file:
      - .env
    environment:
      - NODE_ENV=production
      - PYTHONUNBUFFERED=1
    restart: unless-stopped
    healthcheck:
      test: |
        curl -fsS http://localhost:8787/api/health &&
        curl -fsS http://localhost:8080/
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
    volumes:
      - ./Scripts/outputs:/app/Scripts/outputs
      - ./backend/data:/app/backend/data
```

### Step 2: Update Dockerfile for production
```dockerfile
# Add a build stage
FROM node:18-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:18-slim AS production
WORKDIR /app
RUN apt-get update && apt-get install -y python3 python3-pip curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY . .
RUN pip3 install --break-system-packages -r requirements.txt
EXPOSE 8080 8787
CMD ["./docker-entrypoint.sh"]
```

### Verification
```bash
docker compose -f docker-compose.prod.yml up --build -d
# Check health
docker compose -f docker-compose.prod.yml ps
# Expected: app container shows "healthy"

# Confirm Vite dev server is NOT running (only backend + static)
docker compose -f docker-compose.prod.yml exec app curl http://localhost:8080/
# Expected: HTML response (not Vite HMR websocket)
```

---

## 🟢 FIX 11: Create .env.example

### What To Do

Create file `.env.example` in project root:

```env
# ================================
# BlossomTask Environment Variables
# Copy this file to .env and fill in your values
# NEVER commit .env to version control
# ================================

# AI API Keys
PERPLEXITY_API_KEY=pplx-YOUR_KEY_HERE
OPENAI_API_KEY=sk-proj-YOUR_KEY_HERE

# CRM Authentication
API_KEY_HEADER=X-VCAppApiKey
API_KEY_VALUE=YOUR_CRM_API_KEY_HERE

# CRM Endpoints (update with your actual CRM base URL)
API_URL_TASK_OPENED=http://your-crm-host:8061/api/TaskOpened/...
API_URL_CLOSE_TASK=http://your-crm-host:8061/api/CloseTask
API_URL_ORDER_INQUIRY=http://your-crm-host:8061/api/orderinquiry/...
API_URL_CREATE_COMM=http://your-crm-host:8061/api/createcomm

# Pipeline Configuration
TASK_SUBJECT=Verify and Pull Down Times
FUNERAL_MAX_ROWS=0
CLOSE_TASK_DRY_RUN=true

# Admin Authentication (leave blank to auto-generate)
BLOSSOMTASK_ADMIN_USERNAME=admin
BLOSSOMTASK_ADMIN_PASSWORD=

# Session Settings
SESSION_TTL_MINUTES=480
```

---

## ✅ FINAL VERIFICATION CHECKLIST

After all fixes are complete, run this complete verification:

```bash
echo "=== BlossomTask Production Readiness Check ==="

# 1. reverify idempotency
python Scripts/reverify.py
FIRST_RUN_PROCESSED=$(grep -c "order_id" Scripts/outputs/Funeral_Finder/reverify_logs.txt 2>/dev/null || echo 0)
python Scripts/reverify.py  
echo "Reverify double-run test: First=$FIRST_RUN_PROCESSED, second should be 0"

# 2. State recovery
python -c "import json; open('pipeline_state.json','w').write(json.dumps({'status':'running'}))"
python -c "from terminal_runner import TerminalPipelineRunner; r=TerminalPipelineRunner(); r._recover_stale_state(); import json; s=json.load(open('pipeline_state.json')); assert s['status']=='failed', 'FAIL'; print('PASS: Stale state recovered')"

# 3. Session revocation
python -c "
import main, sqlite3
conn = main._auth_db_connection()
try: main._create_user(conn, 'verify_test', 'pass123', 'user')
except: pass
row = conn.execute('SELECT id FROM users WHERE username=?',('verify_test',)).fetchone()
now = main._utc_now_iso()
conn.execute('INSERT INTO sessions (id,user_id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?)',('vsess1',row['id'],now,now,now))
conn.commit()
main._update_user_password(conn,'verify_test','newpass456')
s = conn.execute('SELECT revoked_at FROM sessions WHERE id=?',('vsess1',)).fetchone()
assert s['revoked_at'] is not None, 'FAIL: sessions not revoked'
print('PASS: Sessions revoked on password change')
conn.execute('DELETE FROM users WHERE username=?',('verify_test',))
conn.commit()
"

# 4. .env.example exists
test -f .env.example && echo "PASS: .env.example exists" || echo "FAIL: .env.example missing"

# 5. Rate limiting package installed
node -e "require('express-rate-limit'); console.log('PASS: express-rate-limit installed')"

echo "=== All checks complete ==="
```

---

## 📝 Post-Fix README Updates

After all fixes, update `README.md`:
1. Replace `cp .env.example .env` instruction — now works because file exists
2. Add "Production Deployment" section pointing to `docker-compose.prod.yml`
3. Add "Security Notes" section (HTTPS for production, credentials file warning)
4. Update Architecture diagram to show unified cron → terminal_runner flow
5. Add "Idempotency" section explaining logs.txt in EVERY script including reverify
