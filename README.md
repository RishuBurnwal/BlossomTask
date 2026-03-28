# BlossomTask

BlossomTask is a full-stack pipeline dashboard for processing funeral-order workflows end-to-end:

- fetch open tasks
- enrich with order inquiry data
- run AI-assisted funeral data lookup
- generate updater payloads
- close tasks
- schedule everything with cron

It includes:

- a React + Vite + TypeScript frontend dashboard
- a Node/Express backend orchestrator with cron scheduling
- Python automation scripts for each pipeline stage

---

## 1) Tech Stack

### Frontend

- React 18 + TypeScript
- Vite (dev server on port `8080`)
- TanStack Query (`@tanstack/react-query`) for polling + mutation workflows
- React Router (`/` + fallback `*`)
- Tailwind CSS + shadcn/ui + Radix UI primitives
- Lucide icons
- Sonner + shadcn toasts

### Backend

- Node.js + Express
- `node-cron` for schedule automation
- `cors` + JSON API
- Child-process execution of Python scripts
- Local JSON persistence under `backend/data/`

### Automation Layer

- Python scripts in `Scripts/`
- `requests`, CSV/JSON/JSONL processing
- Optional Excel output support via `openpyxl` (in `Funeral_Finder.py`)

### Testing / QA

- Vitest (`npm run test`)
- Playwright config scaffold (`playwright.config.ts`)

---

## 2) Repository Structure

### Core app

- `src/` — React frontend
- `backend/server.js` — API + scheduler + process runner
- `backend/lib/` — compare/files/scripts/storage modules
- `backend/data/jobs.json` — run/job history
- `backend/data/schedules.json` — cron schedule persistence
- `Scripts/` — Python pipeline scripts + outputs
- `main.py` — launcher + integration verifier for UI/backend stack

### Important outputs

- `Scripts/outputs/GetTask/`
- `Scripts/outputs/GetOrderInquiry/`
- `Scripts/outputs/Funeral_Finder/`
- `Scripts/outputs/Updater/`
- `Scripts/outputs/ClosingTask/`

---

## 3) End-to-End Pipeline

Pipeline order is fixed in backend orchestration:

1. `get-task`
2. `get-order-inquiry`
3. `funeral-finder` (default option: `batch`)
4. `updater`
5. `closing-task`

Backend constant: `PIPELINE_ORDER = ["get-task", "get-order-inquiry", "funeral-finder", "updater", "closing-task"]`.

### Stage details

#### 3.1 GetTask (`Scripts/GetTask.py`)

- Calls task-opened API using `TASK_SUBJECT`
- Deduplicates by `ord_ID` before append
- Appends cumulative:
	- `outputs/GetTask/Tasks_OrderID.csv`
	- `outputs/GetTask/Tasks_OrderID.json`
	- `outputs/GetTask/Tasks_OrderID.log`
- Keeps a `__raw_json` column to preserve nested payload fidelity

Required env:

- `API_URL_TASK_OPENED`
- `TASK_SUBJECT`
- `API_KEY_HEADER`
- `API_KEY_VALUE`

#### 3.2 GetOrderInquiry (`Scripts/GetOrderInquiry.py`)

- Reads source order IDs from CSV/JSON (default source is GetTask output)
- Skips already-exported order IDs
- Calls order inquiry endpoint per order
- Appends cumulative:
	- `outputs/GetOrderInquiry/OrderInquiry.csv`
	- `outputs/GetOrderInquiry/OrderInquiry.json`
	- `outputs/GetOrderInquiry/OrderInquiry.log`

Required env:

- `API_URL_ORDER_INQUIRY`
- `API_KEY_HEADER`
- `API_KEY_VALUE`

#### 3.3 Funeral Finder (`Scripts/Funeral_Finder.py`)

- AI-assisted obituary/funeral lookup via Perplexity
- Input dedupe by `ord_id`
- Checkpointed processing
- Name-match guard (first/last-name consistency)
- Confidence scoring and status normalization
- Run modes:
	- `batch` (default from backend)
	- `interactive`
- Writes canonical output files:
	- `outputs/Funeral_Finder/Funeral_data.csv`
	- `outputs/Funeral_Finder/Funeral_data.jsonl`
	- `outputs/Funeral_Finder/Funeral_data.xlsx`
	- `outputs/Funeral_Finder/Funeral_checkpoint.json`

Required env:

- `PERPLEXITY_API_KEY`

#### 3.4 Updater (`Scripts/Updater.py`)

- Reads `Funeral_data.csv`
- Builds communication payload for each order
- Computes `trResult` from match score + resolved status
- Default behavior is dry-run (`DRY_RUN = True` in script)
- Writes logs/output payloads:
	- `outputs/Updater/updater_payloads.jsonl`
	- `outputs/Updater/updater_payloads.csv`
	- `outputs/Updater/updater_processed.log`
	- `outputs/Updater/updater_run.log`

#### 3.5 ClosingTask (`Scripts/ClosingTask.py`)

- Reads updater payloads (`.jsonl` default)
- Creates closing-task payload (`trSubject`, `toNameID`, `trText`)
- Supports dry-run via `.env` (`CLOSE_TASK_DRY_RUN`)
- Writes logs/output payloads:
	- `outputs/ClosingTask/closing_task_payloads.jsonl`
	- `outputs/ClosingTask/closing_task_payloads.csv`
	- `outputs/ClosingTask/closing_task_processed.log`
	- `outputs/ClosingTask/closing_task_run.log`

Required env:

- `API_URL_CLOSE_TASK`
- `API_KEY_HEADER`
- `API_KEY_VALUE`

---

## 4) Cron Jobs and Scheduling (Complete)

Scheduling is implemented in `backend/server.js` using `node-cron`.

### 4.1 Persisted schedules

- Schedule definitions stored in `backend/data/schedules.json`
- Jobs stored in `backend/data/jobs.json`
- On backend startup, schedules are re-registered (`resetSchedules()`)

### 4.2 Default cron in current repository state

`backend/data/schedules.json` includes:

- Name: `Default Sequential Pipeline`
- Cron: `*/30 * * * *`
- Enabled: `true`
- Sequence:
	1. `get-task`
	2. `get-order-inquiry`
	3. `funeral-finder` (`batch`)
	4. `updater`
	5. `closing-task`

### 4.3 Schedule behavior rules

- Cron expression validated via `cron.validate(...)`
- Only enabled schedules are registered
- On create/enable transition, backend triggers immediate pipeline run
- Manual trigger endpoint available
- Overlap protection:
	- If same schedule already has running pipeline, next trigger is skipped
	- Skip is recorded as a `cancelled` job with `skippedReason = "previous-run-active"`

### 4.4 Schedule operations available in UI/API

- create schedule
- update schedule (`cron`, `enabled`, `sequence`, metadata)
- enable/disable schedule
- delete schedule
- trigger schedule now
- view schedule-specific run history

---

## 5) Backend Features

### 5.1 Job lifecycle and runtime logs

- Job kinds: `script`, `pipeline`
- Statuses: `queued`, `running`, `success`, `failed`, `cancelled`
- Progress tracking (`0-100`)
- Timestamp tracking (`createdAt`, `startedAt`, `finishedAt`, `updatedAt`)
- Live logs per job (tail in UI)

### 5.2 Script execution engine

- Resolves script metadata from `backend/lib/scripts.js`
- Spawns Python scripts via `child_process.spawn("python3", [...])`
- Injects:
	- `RUN_MODE` (for optioned scripts like `funeral-finder`)
	- `PYTHONUNBUFFERED=1`
- Supports job cancellation (`SIGTERM`)

### 5.3 Preflight checks

`/api/preflight` validates:

- Scripts directory existence
- Presence of all script files in catalog
- `.env` availability
- Required env vars discovered via `_required_env(...)`
- outputs directory availability

### 5.4 File browser and dataset APIs

- Safe path resolution under `Scripts/outputs`
- Recursive and non-recursive file tree APIs
- Content parsers for `csv`, `json`, `jsonl`, and text
- Default dataset summarization (total/matched/needs_review/unmatched/last_processed)

### 5.5 Compare engine

- Compare by Order ID across selected files
- Normalized order matching with digit fallback
- Field-level diff with categories:
	- shipping / perplexity / chatgpt / status / order / other
- Summary count by category

---

## 6) API Endpoints (Complete)

### Health / preflight

- `GET /api/health`
- `GET /api/preflight`

### Script and jobs

- `GET /api/scripts`
- `GET /api/jobs`
- `DELETE /api/jobs`
- `GET /api/jobs/:jobId`
- `POST /api/jobs/run-script`
- `POST /api/jobs/run-pipeline`
- `POST /api/jobs/:jobId/cancel`

### Schedules

- `GET /api/schedules`
- `POST /api/schedules`
- `PATCH /api/schedules/:id`
- `DELETE /api/schedules/:id`
- `POST /api/schedules/:id/trigger`
- `GET /api/schedules/:id/history`

### Files / datasets / compare

- `GET /api/files/tree?path=&recursive=0|1`
- `GET /api/files/content?path=<file>&limit=<n>`
- `GET /api/data/datasets`
- `POST /api/compare/order-id`
- `GET /api/config/outputs-root`

---

## 7) Frontend Features (Complete)

### 7.1 Dashboard Header

Implements:

- pipeline run button (`Run Full Pipeline`)
- preflight check button
- cron mode selector (`default` / `custom`)
- custom interval save (`*/N * * * *`)
- saved schedule list with:
	- edit
	- enable/disable
	- manual trigger
	- delete
- schedule-specific run history + expandable logs
- clear run history
- dark/light toggle and darkness-level slider

### 7.2 Script Panels

Each script card supports:

- run script action
- option selection (for scripts with options)
- status indicator (idle/running/success/failed)
- progress bar
- inline runtime terminal logs
- reset action
- output viewer modal

### 7.3 Compare Section

- compare one order ID across two selected files
- file selectors for left/right datasets
- quick order suggestions
- mismatch summary badges by category
- filter mismatches by category
- horizontal/vertical comparison layout
- side-by-side field matrix

### 7.4 Data Viewer

- `Main Data` tab + `All Files` tab
- recursive quick file picker
- directory browser (`root`, breadcrumb, up-navigation)
- view modes:
	- table
	- JSON
	- raw
	- terminal
- terminal source switch:
	- file raw content
	- runtime logs from active jobs
- live refresh toggle
- status summary chip (matched / needs_review / unmatched)

### 7.5 Theme System

- global theme provider
- dark mode class toggle on `<html>`
- darkness intensity CSS variable (`--darkness-level`)

---

## 8) Component Inventory

### 8.1 App/page components

- `src/App.tsx` — root providers, router wiring, global toasts
- `src/pages/Index.tsx` — dashboard composition shell
- `src/pages/NotFound.tsx` — fallback 404 route

### 8.2 Domain components

- `src/components/DashboardHeader.tsx`
- `src/components/ScriptPanel.tsx`
- `src/components/CompareSection.tsx`
- `src/components/DataViewer.tsx`
- `src/components/ViewOptionsModal.tsx`
- `src/components/NavLink.tsx`

### 8.3 UI primitives (`src/components/ui/`)

All reusable UI primitives in this repo:

- `accordion.tsx`
- `alert-dialog.tsx`
- `alert.tsx`
- `aspect-ratio.tsx`
- `avatar.tsx`
- `badge.tsx`
- `breadcrumb.tsx`
- `button.tsx`
- `calendar.tsx`
- `card.tsx`
- `carousel.tsx`
- `chart.tsx`
- `checkbox.tsx`
- `collapsible.tsx`
- `command.tsx`
- `context-menu.tsx`
- `dialog.tsx`
- `drawer.tsx`
- `dropdown-menu.tsx`
- `form.tsx`
- `hover-card.tsx`
- `input-otp.tsx`
- `input.tsx`
- `label.tsx`
- `menubar.tsx`
- `navigation-menu.tsx`
- `pagination.tsx`
- `popover.tsx`
- `progress.tsx`
- `radio-group.tsx`
- `resizable.tsx`
- `scroll-area.tsx`
- `select.tsx`
- `separator.tsx`
- `sheet.tsx`
- `sidebar.tsx`
- `skeleton.tsx`
- `slider.tsx`
- `sonner.tsx`
- `switch.tsx`
- `table.tsx`
- `tabs.tsx`
- `textarea.tsx`
- `toast.tsx`
- `toaster.tsx`
- `toggle-group.tsx`
- `toggle.tsx`
- `tooltip.tsx`

---

## 9) Local Development

### Prerequisites

- Node.js 18+
- npm
- Python 3

### Install dependencies

```bash
npm install
```

### Run frontend + backend together

```bash
npm run dev:full
```

### Run backend only

```bash
npm run backend
```

### Run frontend only

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Test

```bash
npm run test
```

---

## 10) Launcher and Integration Verification

`main.py` supports:

- auto-kill conflicting ports (`8787`, `8080`)
- start backend and Vite frontend
- open browser to UI
- verify integration endpoints

Usage:

```bash
python main.py --ui
python main.py --verify
```

---

## 11) Environment Variables (Minimum Required)

Define in `Scripts/.env`:

- `API_URL_TASK_OPENED`
- `TASK_SUBJECT`
- `API_KEY_HEADER`
- `API_KEY_VALUE`
- `API_URL_ORDER_INQUIRY`
- `PERPLEXITY_API_KEY`
- `API_URL_CLOSE_TASK`

Optional/behavioral:

- `ORDER_INQUIRY_SOURCE_PATH`
- `ORDER_INQUIRY_OUTPUT_CSV`
- `ORDER_INQUIRY_OUTPUT_JSON`
- `ORDER_INQUIRY_OUTPUT_LOG`
- `FUNERAL_PROMPT_TEMPLATE`
- `CLOSE_TASK_INPUT_CSV`
- `CLOSE_TASK_DRY_RUN`

---

## 12) Notes

- The backend API base is proxied through Vite (`/api` -> `http://localhost:8787`).
- Schedule and run history persist in JSON files and are limited/truncated in backend logic for performance.
- By default, `Updater.py` is dry-run unless script constants are changed.
- This repo currently ships with a default enabled 30-minute sequential cron pipeline.
