# 📖 PROJECT_SYSTEM_GUIDE.md — BlossomTask Architecture & Operations Guide [MERGED]
> **Version:** 2.0.0 MERGED | **Last Updated:** 2026-05-02
> **Purpose:** Complete system understanding for development, operations, and future contributions

---

## 🎯 What This System Does (Plain English)

A funeral flowers company receives online orders. Each order has a "ship_name" (the recipient — usually someone who died or the funeral home). Employees used to manually Google every order to find:
- Is this person actually deceased?
- What funeral home is handling the service?
- When is the service date/time?

**BlossomTask automates this entirely.** It runs on a schedule, pulls open tasks from the CRM, uses AI (Perplexity) to search for obituaries, classifies results, and uploads findings back to CRM — then closes the task. The company just reviews flagged/uncertain cases.

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ENTRY POINTS (3 ways to run)                                               │
│                                                                              │
│  [A] python main.py --terminal-runner   → terminal_runner.py               │
│  [B] node backend/server.js             → backend cron                     │
│  [C] Docker: docker compose up          → docker-entrypoint.sh             │
└──────────────┬──────────────────────┬───────────────────────────────────────┘
               │                      │
    ┌──────────▼──────────┐  ┌────────▼──────────────────────────────────────┐
    │  terminal_runner.py  │  │  backend/server.js (Express.js :8787)        │
    │                      │  │                                               │
    │  - Checkpoint/resume │  │  - REST API for UI                           │
    │  - Lock management   │  │  - node-cron scheduler                       │
    │  - Retry logic       │  │  - Job state management                      │
    │  - Scheduled loops   │  │  - File browser API                          │
    └──────────┬──────────┘  └───────────────────────────────────────────────┘
               │
    ┌──────────▼──────────────────────────────────────────────────────────────┐
    │  PIPELINE (5+1 stages executed sequentially)                            │
    │                                                                          │
    │  Stage 1: GetTask.py          → Fetch open CRM tasks                   │
    │  Stage 2: GetOrderInquiry.py  → Enrich with shipping/customer data      │
    │  Stage 3: Funeral_Finder.py   → AI obituary search (Perplexity)        │
    │  Stage 3b: reverify.py        → Re-check not_found/review records      │
    │  Stage 4: Updater.py          → Upload results to CRM                  │
    │  Stage 5: ClosingTask.py      → Close CRM tasks with notes             │
    └──────────┬──────────────────────────────────────────────────────────────┘
               │
    ┌──────────▼──────────────────────────────────────────────────────────────┐
    │  EXTERNAL SERVICES                                                       │
    │                                                                          │
    │  CRM API: http://ordstatus.tfdash.info:8061/api/                       │
    │  Perplexity AI: sonar-pro model                                         │
    │  OpenAI: gpt-4o-search-preview (fallback/reverify)                     │
    └─────────────────────────────────────────────────────────────────────────┘
```

---

## 📁 Complete File Map

```
BlossomTask/
├── main.py                    # CLI launcher + auth management
├── terminal_runner.py         # Pipeline orchestrator with scheduling
│
├── Scripts/
│   ├── GetTask.py             # Stage 1: CRM task fetcher
│   ├── GetOrderInquiry.py     # Stage 2: Order enrichment
│   ├── Funeral_Finder.py      # Stage 3: AI obituary search
│   ├── reverify.py            # Stage 3b: Re-verification
│   ├── Updater.py             # Stage 4: CRM uploader
│   ├── ClosingTask.py         # Stage 5: Task closer
│   └── .env                   # Python scripts config
│
├── Scripts/outputs/           # Pipeline data outputs
│   ├── GetTask/              # Stage 1 outputs
│   ├── GetOrderInquiry/      # Stage 2 outputs
│   ├── Funeral_Finder/       # Stage 3 outputs (including reverify logs)
│   ├── Updater/              # Stage 4 outputs
│   └── ClosingTask/          # Stage 5 outputs
│
├── backend/
│   ├── server.js              # Express.js API server
│   ├── lib/
│   │   ├── scripts.js         # Script catalog
│   │   ├── files.js           # File browser operations
│   │   ├── storage.js         # JSON persistence
│   │   └── pipeline-runtime.js # Pipeline execution
│   └── data/
│       ├── jobs.json
│       ├── schedules.json
│       ├── blossomtask.sqlite
│       └── run_history_logs.jsonl
│
├── src/                       # React frontend
│   └── components/
│       ├── DashboardHeader.tsx
│       ├── ScriptPanel.tsx
│       ├── DataViewer.tsx
│       └── CompareSection.tsx
│
├── pipeline_state.json        # Current pipeline run state [RUNTIME]
├── pipeline_checkpoint.json   # Last successful script [RUNTIME]
├── pipeline_running.lock      # Global pipeline lock [RUNTIME]
│
├── Dockerfile
├── docker-compose.yml
├── docker-compose.prod.yml    # Production config (after BUG-007 fix)
├── requirements.txt
├── package.json
└── .env                       # Root environment config
```

---

## 🔄 Data Flow (Detailed Order Journey)

```
CRM Open Task → GetTask.py → GetOrderInquiry.py → Funeral_Finder.py 
  → reverify.py → Updater.py → ClosingTask.py → Task Complete ✅
```

**Daily Reset Behavior:**
- Each script uses a date-keyed log file: `logs_by_date/logs_YYYY-MM-DD.txt`
- Same-day idempotency: already-processed orders are skipped
- Next-day processing: new orders are picked up automatically
- `--force` bypasses all skip logic (explicit user action only)

---

## 🕐 Cron / Scheduling Architecture

### Backend Scheduler (node-cron) + terminal_runner.py
- Backend creates schedules in `schedules.json`
- On each trigger, backend spawns: `python terminal_runner.py --once --mode=continue`
- terminal_runner handles locks, state, retries, and status updates
- `pipeline_state.json` is updated after each run

### Terminal Runner (CLI, for manual use)
- `python terminal_runner.py` provides interactive scheduling
- Supports minute intervals, cron syntax, or daily times
- Checkpoint/resume capability for failed runs

### Critical Rule
- Both systems must use the SAME `pipeline_running.lock` mutex
- Never run both simultaneously — they'll create race conditions

---

## 🔒 Security Model

### Authentication
- SQLite: `backend/data/blossomtask.sqlite`
- PBKDF2-SHA256 password hashing (120,000 iterations) ✅
- Session tokens with expiry (default 480 minutes) ✅
- Role-based: `admin` | `user` ✅
- **⚠️ Session NOT revoked on password change (BUG-011 — NEEDS FIX)**

### API Security
- CRM API key in `X-VCAppApiKey` header
- **⚠️ CRM URL uses HTTP not HTTPS (BUG-008 — NEEDS FIX)**
- **⚠️ No rate limiting (BUG-012 — NEEDS FIX)**

---

## 🐳 Docker Deployment

### Development
```bash
docker compose up --build
# Frontend: http://localhost:8080 (Vite dev server)
# Backend:  http://localhost:8787
```

### Production (After BUG-007 Fix)
```bash
docker compose -f docker-compose.prod.yml up --build -d
# Frontend: http://localhost:8080 (static files)
# Backend:  http://localhost:8787
```

---

## 📊 Idempotency System

Each script maintains `logs_by_date/logs_YYYY-MM-DD.txt` to prevent duplicate processing:

```python
processed_ids = load_daily_logs()  # Load today's file only
for order in orders:
    if order_id in processed_ids:
        continue  # Skip — already processed today
    process(order)
    processed_ids.add(order_id)
    append_to_daily_log(order_id)
```

**Daily Reset:**
- Tomorrow's file doesn't exist yet
- New orders are processed automatically the next day
- This allows re-processing when statuses change

---

## 🔧 Environment Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `PERPLEXITY_API_KEY` | ✅ | Perplexity AI key |
| `OPENAI_API_KEY` | ✅ | OpenAI API key |
| `API_KEY_VALUE` | ✅ | CRM API key |
| `CRM_API_URL` | ✅ | CRM endpoint |
| `BLOSSOMTASK_ADMIN_PASSWORD` | — | Auto-generated if blank |
| `CLOSE_TASK_DRY_RUN` | — | `false` in production |
| `FUNERAL_MAX_ROWS` | — | `0` = all rows |

---

## ✅ What To Do Next

See `PROJECT_TODO.md` for prioritized action items.  
See `PROJECT_AUDIT.md` for complete bug registry.

**Most critical fixes in order:**
1. Fix reverify duplicate processing (BUG-003)
2. Fix stale "running" state (BUG-001)
3. Fix cron-pipeline coordination (BUG-002)
4. Fix scheduled mode force-flag (BUG-004)
5. Fix session revocation (BUG-011)

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ENTRY POINTS (3 ways to run)                                               │
│                                                                              │
│  [A] python main.py --terminal-runner   → terminal_runner.py               │
│  [B] node backend/server.js             → backend cron                     │
│  [C] Docker: docker compose up          → docker-entrypoint.sh             │
└──────────────┬──────────────────────┬───────────────────────────────────────┘
               │                      │
    ┌──────────▼──────────┐  ┌────────▼──────────────────────────────────────┐
    │  terminal_runner.py  │  │  backend/server.js (Express.js :8787)        │
    │                      │  │                                               │
    │  - Checkpoint/resume │  │  - REST API for UI                           │
    │  - Lock management   │  │  - node-cron scheduler                       │
    │  - Retry logic       │  │  - Job state management                      │
    │  - Scheduled loops   │  │  - File browser API                          │
    └──────────┬──────────┘  └───────────────────────────────────────────────┘
               │
    ┌──────────▼──────────────────────────────────────────────────────────────┐
    │  PIPELINE (5+1 stages executed sequentially)                            │
    │                                                                          │
    │  Stage 1: GetTask.py          → Fetch open CRM tasks                   │
    │  Stage 2: GetOrderInquiry.py  → Enrich with shipping/customer data      │
    │  Stage 3: Funeral_Finder.py   → AI obituary search (Perplexity)        │
    │  Stage 3b: reverify.py        → Re-check not_found/review records      │
    │  Stage 4: Updater.py          → Upload results to CRM                  │
    │  Stage 5: ClosingTask.py      → Close CRM tasks with notes             │
    └──────────┬──────────────────────────────────────────────────────────────┘
               │
    ┌──────────▼──────────────────────────────────────────────────────────────┐
    │  EXTERNAL SERVICES                                                       │
    │                                                                          │
    │  CRM API: http://ordstatus.tfdash.info:8061/api/                       │
    │  Perplexity AI: sonar-pro model                                         │
    │  OpenAI: gpt-4o-search-preview (fallback/reverify)                     │
    └─────────────────────────────────────────────────────────────────────────┘
```

---

## 📁 Complete File Map

```
BlossomTask/
├── main.py                    # CLI launcher + auth management (1929 lines)
├── terminal_runner.py         # Pipeline orchestrator with scheduling (903 lines)
│
├── Scripts/
│   ├── GetTask.py             # Stage 1: CRM task fetcher (~16KB)
│   ├── GetOrderInquiry.py     # Stage 2: Order enrichment (~14KB)
│   ├── Funeral_Finder.py      # Stage 3: AI obituary search (~25KB)
│   ├── reverify.py            # Stage 3b: Re-verification of uncertain records
│   ├── Updater.py             # Stage 4: CRM uploader (~22KB)
│   ├── ClosingTask.py         # Stage 5: Task closer (~17KB)
│   └── .env                   # Python scripts config
│
├── Scripts/outputs/           # Pipeline data outputs
│   ├── GetTask/
│   │   ├── data.csv           # All fetched tasks
│   │   ├── data.xlsx
│   │   ├── logs.txt           # Processed order_ids (idempotency guard)
│   │   └── payload.json
│   ├── GetOrderInquiry/
│   │   ├── data.csv
│   │   └── logs.txt
│   ├── Funeral_Finder/
│   │   ├── Funeral_data.csv          # All classified results
│   │   ├── Funeral_data_not_found.csv
│   │   ├── Funeral_data_review.csv
│   │   ├── Funeral_data_error.csv
│   │   ├── Funeral_checkpoint.json   # Resume checkpoint
│   │   ├── logs.txt                  # Processed order_ids
│   │   └── reverify_logs.txt         # Reverify-specific processed IDs [MISSING - BUG-003]
│   ├── Updater/
│   │   ├── data.csv
│   │   └── logs.txt
│   └── ClosingTask/
│       ├── data.csv
│       └── logs.txt
│
├── backend/
│   ├── server.js              # Express.js API server
│   ├── lib/
│   │   ├── scripts.js         # Script catalog definition
│   │   ├── files.js           # File browser operations
│   │   ├── compare.js         # Cross-stage data comparison
│   │   └── storage.js         # JSON persistence (jobs.json, schedules.json)
│   └── data/
│       ├── jobs.json          # Job execution history
│       ├── schedules.json     # Cron schedule configs
│       ├── blossomtask.sqlite # Auth database (users, sessions, settings)
│       └── run_history_logs.jsonl
│
├── src/                       # React frontend
│   ├── components/
│   │   ├── DashboardHeader.tsx    # Pipeline status + cron controls
│   │   ├── ScriptPanel.tsx        # Per-script execution cards
│   │   ├── DataViewer.tsx         # CSV/JSON explorer
│   │   └── CompareSection.tsx     # Cross-stage comparison
│   ├── lib/
│   │   ├── api.ts             # Backend API client
│   │   └── types.ts           # TypeScript types
│   └── contexts/
│       └── ThemeContext.tsx
│
├── pipeline_state.json        # Current pipeline run state [RUNTIME]
├── pipeline_checkpoint.json   # Last successful script + completed list [RUNTIME]
├── pipeline_last_summary.json # Last run summary [RUNTIME]
├── pipeline_logs.jsonl        # Structured event log [RUNTIME]
├── pipeline_control.json      # Stop request channel [RUNTIME]
├── pipeline_locks/            # Per-script lock files [RUNTIME]
│   └── {script_id}.lock
│
├── Dockerfile
├── docker-compose.yml
├── docker-entrypoint.sh
├── requirements.txt
├── package.json
└── .env                       # Root environment config
```

---

## 🔄 Data Flow (Detailed)

### Step-by-Step Order Journey

```
CRM Open Task (order_id: "ORD-123", ship_name: "John Smith", ship_city: "Dallas TX")
    │
    ▼ GetTask.py
    Writes to GetTask/data.csv:
    order_id, task_id, subject, ship_name, ship_city...
    Also writes order_id to GetTask/logs.txt
    │
    ▼ GetOrderInquiry.py
    Reads GetTask/data.csv
    Calls CRM /api/orderinquiry for each order_id NOT in its logs.txt
    Enriches with: address, zip, customer_name, phone
    Writes to GetOrderInquiry/data.csv
    │
    ▼ Funeral_Finder.py
    Reads GetOrderInquiry/data.csv
    For each order_id NOT in logs.txt:
      → Query Perplexity: "John Smith Dallas TX obituary funeral home"
      → Parse AI response: funeral_home_name, service_date, service_time
      → Classify: Found (confidence≥75%) | NotFound | Review
    Writes to:
      - Funeral_data.csv (all results)
      - Funeral_data_not_found.csv
      - Funeral_data_review.csv
    │
    ▼ reverify.py (optional stage)
    Reads Funeral_data_not_found.csv AND Funeral_data_review.csv
    Re-queries with different search strategy or OpenAI
    Updates classifications
    │
    ▼ Updater.py
    Reads Funeral_data.csv (or subset based on --mode)
    For each order_id NOT in Updater/logs.txt:
      → Build CRM payload (funeral_home, service_date, match_status)
      → POST to CRM /api/createcomm
    Writes to Updater/data.csv with upload status
    │
    ▼ ClosingTask.py
    Reads Updater/data.csv
    For each order_id NOT in ClosingTask/logs.txt:
      → POST to CRM /api/CloseTask with detailed notes
    Writes to ClosingTask/data.csv
    Order is now complete ✅
```

---

## ⚙️ State Management System

### pipeline_state.json
Tracks current pipeline lifecycle:
```json
{
  "status": "running|success|failed|stopped",
  "run_mode": "single|scheduled",
  "start_mode": "fresh|continue",
  "cycle": 1,
  "sequence": ["get-task", "funeral-finder", ...],
  "updated_at": "2026-05-02T10:30:00+05:30"
}
```
**⚠️ BUG-001:** Can stay as "running" permanently if process crashes.

### pipeline_checkpoint.json
Tracks progress for resume capability:
```json
{
  "last_successful_script": "funeral-finder",
  "completed_scripts": ["get-task", "get-order-inquiry", "funeral-finder"],
  "updated_at": "2026-05-02T10:30:00+05:30"
}
```

### pipeline_control.json
UI → Runner communication channel:
```json
{
  "stop_requested": false,
  "reason": null
}
```
To stop a running pipeline from outside: `echo '{"stop_requested": true, "reason": "Manual stop"}' > pipeline_control.json`

### Script Lock Files (`pipeline_locks/{script_id}.lock`)
Per-script mutex to prevent double execution:
```json
{
  "script_id": "funeral-finder",
  "status": "running|completed|failed|stopped",
  "owner_run_id": "12345-1714643400000",
  "owner_pid": 12345,
  "updated_at": "..."
}
```

---

## 🕐 Cron / Scheduling Architecture

### Two Independent Schedulers (PROBLEM — See BUG-002)

**Scheduler A: terminal_runner.py internal loop**
- User runs: `python main.py --terminal-runner`
- Selects "Scheduled" mode + interval (e.g., 30 min)
- After each pipeline completion, waits in `_countdown_until()` then re-runs
- Manages its own state via `pipeline_state.json`

**Scheduler B: backend/server.js node-cron**
- User creates schedule via Dashboard UI
- `node-cron` fires at configured interval
- Calls internal pipeline execution function directly (via `lib/scripts.js`)
- Does NOT use `terminal_runner.py` at all
- Writes job status to `backend/data/jobs.json`

**⚠️ These two schedulers are NOT coordinated. Running both simultaneously causes conflicts.**

### Correct Architecture (Post-Fix)
Backend cron should call terminal_runner.py as a subprocess:
```javascript
// In server.js cron handler:
const proc = spawn(pythonBin, ['terminal_runner.py', '--once', '--mode=fresh'])
// terminal_runner.py handles locks, state, retries
```

---

## 🔒 Security Model

### Authentication
- SQLite database: `backend/data/blossomtask.sqlite`
- PBKDF2-SHA256 password hashing (120,000 iterations) ✅
- Session tokens with expiry (default 480 minutes) ✅
- Role-based access: `admin` | `user` ✅
- **⚠️ Session not revoked on password change (BUG-011)**

### API Security
- CRM API key in `X-VCAppApiKey` header
- Keys loaded from `.env` files
- **⚠️ CRM URL uses HTTP not HTTPS (BUG-008)**
- **⚠️ No rate limiting on backend endpoints (BUG-012)**

---

## 🐳 Docker Deployment Guide

### Current Setup (Development — DO NOT USE IN PROD AS-IS)
```bash
docker compose up --build
# Frontend: http://localhost:8080 (Vite dev server)
# Backend:  http://localhost:8787 (Express.js)
```

### Production Setup (After BUG-007 Fix)
```bash
docker compose -f docker-compose.prod.yml up --build -d
# Frontend: http://localhost:8080 (static files served by Express)
# Backend:  http://localhost:8787
```

---

## 📊 Idempotency System (How Duplicate Prevention Works)

Each script maintains a `logs.txt` file containing processed `order_id` values. On each run, scripts load this file and skip any order_id already listed.

**Format of logs.txt:**
```
ORD-001
ORD-002
ORD-003
```

**Script behavior:**
```python
processed_ids = set(open('logs.txt').read().splitlines())
for order in orders:
    if order['order_id'] in processed_ids:
        continue  # Skip
    # Process order...
    processed_ids.add(order['order_id'])
    open('logs.txt', 'a').write(order['order_id'] + '\n')
```

**⚠️ `reverify.py` is MISSING this pattern (BUG-003)**
**⚠️ `--force` bypasses all logs.txt checks (BUG-004)**

---

## 🔧 Environment Configuration Reference

### Root `.env` (required)
```env
# AI APIs
PERPLEXITY_API_KEY=pplx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENAI_API_KEY=sk-proj-xxxxxxxx

# CRM
API_KEY_HEADER=X-VCAppApiKey
API_KEY_VALUE=your-crm-api-key

# CRM Endpoints
API_URL_TASK_OPENED=http://ordstatus.tfdash.info:8061/api/TaskOpened/...
API_URL_CLOSE_TASK=http://ordstatus.tfdash.info:8061/api/CloseTask
API_URL_ORDER_INQUIRY=http://ordstatus.tfdash.info:8061/api/orderinquiry/...
API_URL_CREATE_COMM=http://ordstatus.tfdash.info:8061/api/createcomm

# Pipeline Settings
TASK_SUBJECT=Verify and Pull Down Times
FUNERAL_MAX_ROWS=0        # 0 = all rows
CLOSE_TASK_DRY_RUN=true   # SET TO false IN PRODUCTION

# Auth (optional — defaults generated if not set)
BLOSSOMTASK_ADMIN_USERNAME=admin
BLOSSOMTASK_ADMIN_PASSWORD=your-secure-password
SESSION_TTL_MINUTES=480
```

---

## 📝 What To Do Next (Current State)

See `PROJECT_TODO.md` for prioritized action items.
See `PROJECT_AUDIT.md` for complete bug registry.

The most important fixes in order:
1. Fix reverify.py duplicate processing (BUG-003)
2. Fix stale "running" state (BUG-001)  
3. Fix cron-pipeline coordination (BUG-002)
4. Fix scheduled mode force-flag abuse (BUG-004)
5. Fix session revocation (BUG-011)
