# 🌸 BlossomTask — Funeral Order Automation Pipeline [MERGED]

[![Version](https://img.shields.io/badge/version-2.0.1-blue?style=flat-square)](.)
[![Python](https://img.shields.io/badge/python-3.10+-green?style=flat-square&logo=python)](.)
[![Node.js](https://img.shields.io/badge/node-18+-green?style=flat-square&logo=node.js)](.)
[![Docker](https://img.shields.io/badge/docker-ready-blue?style=flat-square&logo=docker)](.)
[![Status](https://img.shields.io/badge/status-production--hardened-brightgreen?style=flat-square)](.)

> **What this does:** A funeral flowers company automation tool. Every incoming flower order needs to know — is the recipient deceased? What funeral home? What date/time? BlossomTask automates this by fetching open CRM tasks, using AI to search obituaries, and uploading findings back — so your team only reviews uncertain cases.

---

## 📖 Table of Contents
- [Overview](#overview)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Production Deployment](#production-deployment)
- [Pipeline Workflow](#pipeline-workflow)
- [Cron & Scheduling](#cron--scheduling)
- [Environment Configuration](#environment-configuration)
- [Security Notes](#security-notes)
- [Idempotency System](#idempotency-system)
- [Troubleshooting](#troubleshooting)
- [API Reference](#api-reference)

---

## Overview

BlossomTask is a production-ready automation pipeline for funeral flower order processing. It:

1. **Fetches** open CRM tasks with subject "Verify and Pull Down Times"
2. **Enriches** each task with customer shipping details
3. **Searches** for obituaries using Perplexity AI (`sonar-pro`)
4. **Re-verifies** uncertain records with an additional AI pass
5. **Uploads** structured results back to CRM
6. **Closes** completed tasks with detailed notes

The system runs on a configurable schedule and is designed for **24/7 unattended operation**.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Entry Points                                               │
│                                                              │
│  [A] python main.py --terminal-runner  (recommended)        │
│  [B] Dashboard UI  → backend cron → terminal_runner.py      │
│  [C] docker compose -f docker-compose.prod.yml up           │
└──────────────────────┬──────────────────────────────────────┘
                       │
           ┌───────────▼────────────┐
           │  terminal_runner.py    │  ← Single source of truth for scheduling
           │  - Checkpointing       │
           │  - Lock management     │
           │  - Retry logic (3x)    │
           │  - Cron loop           │
           └───────────┬────────────┘
                       │
    ┌──────────────────▼──────────────────────────────────────┐
    │  Pipeline (6 stages)                                    │
    │                                                          │
    │  1. GetTask          → Fetch open CRM tasks             │
    │  2. GetOrderInquiry  → Enrich with customer data        │
    │  3. Funeral_Finder   → AI obituary search               │
    │  3b. reverify        → Re-check uncertain records       │
    │  4. Updater          → Upload results to CRM            │
    │  5. ClosingTask      → Close CRM tasks                  │
    └─────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites
| Requirement | Minimum | Check |
|-------------|---------|-------|
| Python | 3.10+ | `python --version` |
| Node.js | 18+ | `node --version` |
| npm | 8+ | `npm --version` |

### Installation

```bash
# 1. Clone
git clone <repository-url>
cd BlossomTask

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys and CRM URL

# 3. Install dependencies
pip install -r requirements.txt
npm install

# 4. Run health check
python main.py --health
```

### First Run

```bash
# Interactive menu
python main.py

# Or: Launch dashboard UI
python main.py --ui

# Or: Run pipeline directly
python main.py --terminal-runner
```

---

## Production Deployment

### Docker (Recommended for Production)

```bash
# Production mode (builds static files, no dev server)
docker compose -f docker-compose.prod.yml up --build -d

# Frontend: http://localhost:8080
# Backend:  http://localhost:8787
# Logs:     docker compose -f docker-compose.prod.yml logs -f app
```

### Server (Non-Docker)

```bash
# One-click server setup (installs deps, builds frontend, starts backend)
python main.py
# Select option [10] "One-Click Server Setup"

# Or manually:
npm run build
node backend/server.js &
```

> ⚠️ **Development mode** (`docker compose up` without prod file) runs Vite dev server. **Do not use in production.**

---

## Pipeline Workflow

```
Stage 1: GetTask.py
  Input:  CRM API /api/TaskOpened
  Output: Scripts/outputs/GetTask/data.csv
  Notes:  Skips orders already in ClosingTask/logs.txt (fully completed)

Stage 2: GetOrderInquiry.py
  Input:  GetTask/data.csv → CRM API /api/orderinquiry
  Output: Scripts/outputs/GetOrderInquiry/data.csv
  Notes:  Skips order_ids already in its logs.txt

Stage 3: Funeral_Finder.py
  Input:  GetOrderInquiry/data.csv
  Output: Funeral_data.csv, Funeral_data_not_found.csv, Funeral_data_review.csv
  Notes:  Uses Perplexity AI. Skips order_ids in logs.txt. Respects --force flag.
  Classification:
    Found (≥75% confidence) → direct upload
    NotFound → reverify pass
    Review   → reverify pass, then human check if still uncertain

Stage 3b: reverify.py
  Input:  Funeral_data_not_found.csv + Funeral_data_review.csv
  Output: Updates Funeral_data.csv with re-verified results
  Notes:  Has its own reverify_logs.txt — never processes same order_id twice

Stage 4: Updater.py
  Input:  Funeral_data.csv (mode: complete/found_only/not_found/review)
  Output: Scripts/outputs/Updater/data.csv
  Notes:  Skips order_ids in its logs.txt

Stage 5: ClosingTask.py
  Input:  Updater/data.csv
  Output: Scripts/outputs/ClosingTask/data.csv
  Notes:  Skips order_ids in its logs.txt. Task closed in CRM = no re-processing.
```

---

## Cron & Scheduling

### How Scheduling Works

The Dashboard UI lets you create cron schedules. When a schedule fires:

```
backend/server.js (node-cron)
  └── spawns → terminal_runner.py --once --mode=continue
        └── runs one complete pipeline cycle
        └── skips already-processed records (via logs.txt)
        └── updates pipeline_state.json
        └── exits when done
```

On next cron interval, the same process repeats. The system only processes **new** orders — orders already in `logs.txt` are skipped automatically.

### Manual Scheduling via Terminal Runner

```bash
python terminal_runner.py
# Select: [2] Scheduled run
# Enter interval: 30 (every 30 minutes), */15 * * * * (cron syntax), or 23:15 (daily time)
```

### Stop a Running Pipeline

```bash
# From terminal
Ctrl+C

# Or write to control file (for remote stop)
echo '{"stop_requested": true, "reason": "Manual stop by ops"}' > pipeline_control.json
```

### Schedule Expressions
| Format | Example | Meaning |
|--------|---------|---------|
| Minutes | `30` | Every 30 minutes |
| Cron | `*/15 * * * *` | Every 15 minutes |
| Daily time | `23:15` | Once daily at 23:15 local |

---

## Environment Configuration

```bash
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `PERPLEXITY_API_KEY` | ✅ | Perplexity AI API key (`pplx-...`) |
| `OPENAI_API_KEY` | ✅ | OpenAI API key (`sk-proj-...`) |
| `API_KEY_VALUE` | ✅ | CRM API key |
| `API_URL_TASK_OPENED` | ✅ | CRM task fetch endpoint |
| `API_URL_CLOSE_TASK` | ✅ | CRM task close endpoint |
| `API_URL_ORDER_INQUIRY` | ✅ | CRM order inquiry endpoint |
| `API_URL_CREATE_COMM` | ✅ | CRM communication create endpoint |
| `CLOSE_TASK_DRY_RUN` | — | Set `false` in production (default: `true`) |
| `FUNERAL_MAX_ROWS` | — | Max rows per Funeral_Finder run (`0` = all) |
| `BLOSSOMTASK_ADMIN_PASSWORD` | — | Admin password (auto-generated if blank) |

---

## Security Notes

### First Boot
On first startup with no database, an admin account is auto-created. The credentials are:
- Displayed in the terminal
- Saved to `backend/data/INITIAL_CREDENTIALS.txt`

**⚠️ Delete `INITIAL_CREDENTIALS.txt` immediately after your first login.**

### API Keys
- Never commit `.env` files (they're in `.gitignore`)
- The CRM API uses HTTP — ensure your network is trusted or use a VPN
- All passwords are hashed with PBKDF2-SHA256 (120,000 iterations)

### Session Management
- Sessions expire after 480 minutes by default (configurable)
- Changing a user's password immediately revokes all their active sessions
- Role-based access: `admin` (full access) | `user` (dashboard only)

---

## Idempotency System

Every pipeline script maintains a `logs_by_date/logs_YYYY-MM-DD.txt` file of processed `order_id` values. **A script will never process the same order_id twice in one day** (unless `--force` is explicitly used).

| Script | Log File | Tracks |
|--------|----------|--------|
| GetTask | `GetTask/logs_by_date/logs_YYYY-MM-DD.txt` | Fetched task order_ids |
| GetOrderInquiry | `GetOrderInquiry/logs_by_date/logs_YYYY-MM-DD.txt` | Enriched order_ids |
| Funeral_Finder | `Funeral_Finder/logs_by_date/logs_YYYY-MM-DD.txt` | AI-searched order_ids |
| reverify | `Funeral_Finder/reverify_logs_by_date/reverify_logs_YYYY-MM-DD.txt` | Re-verified order_ids |
| Updater | `Updater/logs_by_date/logs_YYYY-MM-DD.txt` | Uploaded order_ids |
| ClosingTask | `ClosingTask/logs_by_date/logs_YYYY-MM-DD.txt` | Closed order_ids |

**Same-day Idempotency:** Running the pipeline twice on the same day skips already-processed orders ✅  
**Next-day Fresh Start:** On a new day, all orders are eligible for processing again ✅

**To reset and reprocess everything:**
```bash
# Delete all daily logs (use with caution!)
find Scripts/outputs -name "logs_by_date" -type d -exec rm -rf {} \;
```

**To force a single script:**
```bash
python Scripts/Funeral_Finder.py --force
```

---

## Troubleshooting

### Pipeline Shows "Running" After Server Restart
The system automatically recovers stale state. Just restart `terminal_runner.py` and it will detect and reset the stale status.

### reverify.py Processes Same Orders Repeatedly
Ensure `Scripts/outputs/Funeral_Finder/reverify_logs_by_date/` exists with today's file. If missing, it means daily rotation isn't working — check the reverify_logs.txt location.

### Perplexity API Bills Are Too High
This usually means `--force` is being passed on scheduled cycles. Check that `terminal_runner.py` is NOT auto-setting `start_mode = "fresh"` on cycle > 1.

### Common Issues
| Problem | Solution |
|---------|----------|
| `ModuleNotFoundError` | Run `pip install -r requirements.txt` |
| Port already in use | `python main.py` → option [4] to change ports |
| Docker build fails | Ensure Docker Desktop is running |
| Empty pipeline output | Run `python main.py --health` to check config |
| All schedules disabled | Enable at least one schedule in Dashboard UI |
| Admin password lost | Check `backend/data/INITIAL_CREDENTIALS.txt` |

---

## API Reference

Backend REST API on port `8787`:

### Pipeline
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/pipeline/status` | GET | Current pipeline state |
| `/api/jobs/run-pipeline` | POST | Trigger full pipeline |
| `/api/jobs/run-script` | POST | Run single script |
| `/api/jobs/:id` | GET | Get job details + logs |
| `/api/jobs/:id/cancel` | POST | Cancel running job |

### Schedules
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/schedules` | GET | List all schedules |
| `/api/schedules` | POST | Create schedule |
| `/api/schedules/:id` | PATCH | Update schedule |
| `/api/schedules/:id/trigger` | POST | Trigger now |

### Data
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/files/tree` | GET | Browse output files |
| `/api/files/content` | GET | Read file content |
| `/api/compare/order-id` | POST | Compare order across stages |

---

## Output Directory Structure

```
Scripts/outputs/
├── GetTask/           data.csv, logs_by_date/, logs.txt (legacy)
├── GetOrderInquiry/   data.csv, logs_by_date/, logs.txt (legacy)
├── Funeral_Finder/    Funeral_data*.csv, logs_by_date/, 
│                      reverify_logs_by_date/, run_state.json
├── Updater/           data.csv, logs_by_date/, logs.txt
└── ClosingTask/       data.csv, logs_by_date/, logs.txt
```

---

## Development

```bash
# Run tests
npm test
pytest tests/

# Run a specific pipeline stage
python main.py --stage funeral-finder

# Dry run (no CRM updates)
python main.py --pipeline --dry-run --no-preflight
```

---

*Built for a funeral flowers company. Automates what used to take hours per day.*  
*MERGED version combining all README variations — 2026-05-02*

---

## Overview

BlossomTask is a production-ready automation pipeline for funeral flower order processing. It:

1. **Fetches** open CRM tasks with subject "Verify and Pull Down Times"
2. **Enriches** each task with customer shipping details
3. **Searches** for obituaries using Perplexity AI (`sonar-pro`)
4. **Re-verifies** uncertain records with an additional AI pass
5. **Uploads** structured results back to CRM
6. **Closes** completed tasks with detailed notes

The system runs on a configurable schedule and is designed for **24/7 unattended operation**.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Entry Points                                               │
│                                                              │
│  [A] python main.py --terminal-runner  (recommended)        │
│  [B] Dashboard UI  → backend cron → terminal_runner.py      │
│  [C] docker compose -f docker-compose.prod.yml up           │
└──────────────────────┬──────────────────────────────────────┘
                       │
           ┌───────────▼────────────┐
           │  terminal_runner.py    │  ← Single source of truth for scheduling
           │  - Checkpointing       │
           │  - Lock management     │
           │  - Retry logic (3x)    │
           │  - Cron loop           │
           └───────────┬────────────┘
                       │
    ┌──────────────────▼──────────────────────────────────────┐
    │  Pipeline (6 stages)                                    │
    │                                                          │
    │  1. GetTask          → Fetch open CRM tasks             │
    │  2. GetOrderInquiry  → Enrich with customer data        │
    │  3. Funeral_Finder   → AI obituary search               │
    │  3b. reverify        → Re-check uncertain records       │
    │  4. Updater          → Upload results to CRM            │
    │  5. ClosingTask      → Close CRM tasks                  │
    └─────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites
| Requirement | Minimum | Check |
|-------------|---------|-------|
| Python | 3.10+ | `python --version` |
| Node.js | 18+ | `node --version` |
| npm | 8+ | `npm --version` |

### Installation

```bash
# 1. Clone
git clone <repository-url>
cd BlossomTask

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys and CRM URL

# 3. Install dependencies
pip install -r requirements.txt
npm install

# 4. Run health check
python main.py --health
```

### First Run

```bash
# Interactive menu
python main.py

# Or: Launch dashboard UI
python main.py --ui

# Or: Run pipeline directly
python main.py --terminal-runner
```

---

## Production Deployment

### Docker (Recommended for Production)

```bash
# Production mode (builds static files, no dev server)
docker compose -f docker-compose.prod.yml up --build -d

# Frontend: http://localhost:8080
# Backend:  http://localhost:8787
# Logs:     docker compose -f docker-compose.prod.yml logs -f app
```

### Server (Non-Docker)

```bash
# One-click server setup (installs deps, builds frontend, starts backend)
python main.py
# Select option [10] "One-Click Server Setup"

# Or manually:
npm run build
node backend/server.js &
```

> ⚠️ **Development mode** (`docker compose up` without prod file) runs Vite dev server. **Do not use in production.**

---

## Pipeline Workflow

```
Stage 1: GetTask.py
  Input:  CRM API /api/TaskOpened
  Output: Scripts/outputs/GetTask/data.csv
  Notes:  Skips orders already in ClosingTask/logs.txt (fully completed)

Stage 2: GetOrderInquiry.py
  Input:  GetTask/data.csv → CRM API /api/orderinquiry
  Output: Scripts/outputs/GetOrderInquiry/data.csv
  Notes:  Skips order_ids already in its logs.txt

Stage 3: Funeral_Finder.py
  Input:  GetOrderInquiry/data.csv
  Output: Funeral_data.csv, Funeral_data_not_found.csv, Funeral_data_review.csv
  Notes:  Uses Perplexity AI. Skips order_ids in logs.txt. Respects --force flag.
  Classification:
    Found (≥75% confidence) → direct upload
    NotFound → reverify pass
    Review   → reverify pass, then human check if still uncertain

Stage 3b: reverify.py
  Input:  Funeral_data_not_found.csv + Funeral_data_review.csv
  Output: Updates Funeral_data.csv with re-verified results
  Notes:  Has its own reverify_logs.txt — never processes same order_id twice

Stage 4: Updater.py
  Input:  Funeral_data.csv (mode: complete/found_only/not_found/review)
  Output: Scripts/outputs/Updater/data.csv
  Notes:  Skips order_ids in its logs.txt

Stage 5: ClosingTask.py
  Input:  Updater/data.csv
  Output: Scripts/outputs/ClosingTask/data.csv
  Notes:  Skips order_ids in its logs.txt. Task closed in CRM = no re-processing.
```

---

## Cron & Scheduling

### How Scheduling Works

The Dashboard UI lets you create cron schedules. When a schedule fires:

```
backend/server.js (node-cron)
  └── spawns → terminal_runner.py --once --mode=continue
        └── runs one complete pipeline cycle
        └── skips already-processed records (via logs.txt)
        └── updates pipeline_state.json
        └── exits when done
```

On next cron interval, the same process repeats. The system only processes **new** orders — orders already in `logs.txt` are skipped automatically.

### Manual Scheduling via Terminal Runner

```bash
python terminal_runner.py
# Select: [2] Scheduled run
# Enter interval: 30 (every 30 minutes), */15 * * * * (cron syntax), or 23:15 (daily time)
```

### Stop a Running Pipeline

```bash
# From terminal
Ctrl+C

# Or write to control file (for remote stop)
echo '{"stop_requested": true, "reason": "Manual stop by ops"}' > pipeline_control.json
```

### Schedule Expressions
| Format | Example | Meaning |
|--------|---------|---------|
| Minutes | `30` | Every 30 minutes |
| Cron | `*/15 * * * *` | Every 15 minutes |
| Daily time | `23:15` | Once daily at 23:15 local |

---

## Environment Configuration

```bash
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `PERPLEXITY_API_KEY` | ✅ | Perplexity AI API key (`pplx-...`) |
| `OPENAI_API_KEY` | ✅ | OpenAI API key (`sk-proj-...`) |
| `API_KEY_VALUE` | ✅ | CRM API key |
| `API_URL_TASK_OPENED` | ✅ | CRM task fetch endpoint |
| `API_URL_CLOSE_TASK` | ✅ | CRM task close endpoint |
| `API_URL_ORDER_INQUIRY` | ✅ | CRM order inquiry endpoint |
| `API_URL_CREATE_COMM` | ✅ | CRM communication create endpoint |
| `CLOSE_TASK_DRY_RUN` | — | Set `false` in production (default: `true`) |
| `FUNERAL_MAX_ROWS` | — | Max rows per Funeral_Finder run (`0` = all) |
| `BLOSSOMTASK_ADMIN_PASSWORD` | — | Admin password (auto-generated if blank) |

---

## Security Notes

### First Boot
On first startup with no database, an admin account is auto-created. The credentials are:
- Displayed in the terminal
- Saved to `backend/data/INITIAL_CREDENTIALS.txt`

**⚠️ Delete `INITIAL_CREDENTIALS.txt` immediately after your first login.**

### API Keys
- Never commit `.env` files (they're in `.gitignore`)
- The CRM API uses HTTP — ensure your network is trusted or use a VPN
- All passwords are hashed with PBKDF2-SHA256 (120,000 iterations)

### Session Management
- Sessions expire after 480 minutes by default (configurable)
- Changing a user's password immediately revokes all their active sessions
- Role-based access: `admin` (full access) | `user` (dashboard only)

---

## Idempotency System

Every pipeline script maintains a `logs.txt` file of processed `order_id` values. **A script will never process the same order_id twice** (unless `--force` is explicitly used).

| Script | Log File | Tracks |
|--------|----------|--------|
| GetTask | `GetTask/logs.txt` | Fetched task order_ids |
| GetOrderInquiry | `GetOrderInquiry/logs.txt` | Enriched order_ids |
| Funeral_Finder | `Funeral_Finder/logs.txt` | AI-searched order_ids |
| reverify | `Funeral_Finder/reverify_logs.txt` | Re-verified order_ids |
| Updater | `Updater/logs.txt` | Uploaded order_ids |
| ClosingTask | `ClosingTask/logs.txt` | Closed order_ids |

**To reset and reprocess everything:**
```bash
# Delete all logs (use with caution!)
find Scripts/outputs -name "logs.txt" -delete
rm -f Scripts/outputs/Funeral_Finder/reverify_logs.txt
```

**To force a single script:**
```bash
python Scripts/Funeral_Finder.py --force
```

---

## Troubleshooting

### Pipeline Shows "Running" After Server Restart
The system automatically recovers stale state. Just restart `terminal_runner.py` and it will detect and reset the stale status.

### reverify.py Processes Same Orders Repeatedly
Ensure `Scripts/outputs/Funeral_Finder/reverify_logs.txt` exists and contains processed order_ids. If missing, it means reverify hasn't been updated to include idempotency — see `PROJECT_AUDIT.md` BUG-003.

### Perplexity API Bills Are Too High
This usually means `--force` is being passed on scheduled cycles. Check that `terminal_runner.py` is NOT auto-setting `start_mode = "fresh"` on cycle > 1.

### Common Issues
| Problem | Solution |
|---------|----------|
| `ModuleNotFoundError` | Run `pip install -r requirements.txt` |
| Port already in use | `python main.py` → option [4] to change ports |
| Docker build fails | Ensure Docker Desktop is running |
| Empty pipeline output | Run `python main.py --health` to check config |
| All schedules disabled | Enable at least one schedule in Dashboard UI |
| Admin password lost | Check `backend/data/INITIAL_CREDENTIALS.txt` |

---

## API Reference

Backend REST API on port `8787`:

### Pipeline
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/pipeline/status` | GET | Current pipeline state |
| `/api/jobs/run-pipeline` | POST | Trigger full pipeline |
| `/api/jobs/run-script` | POST | Run single script |
| `/api/jobs/:id` | GET | Get job details + logs |
| `/api/jobs/:id/cancel` | POST | Cancel running job |

### Schedules
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/schedules` | GET | List all schedules |
| `/api/schedules` | POST | Create schedule |
| `/api/schedules/:id` | PATCH | Update schedule |
| `/api/schedules/:id/trigger` | POST | Trigger now |

### Data
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/files/tree` | GET | Browse output files |
| `/api/files/content` | GET | Read file content |
| `/api/compare/order-id` | POST | Compare order across stages |

---

## Output Directory Structure

```
Scripts/outputs/
├── GetTask/           data.csv, logs.txt, payload.json
├── GetOrderInquiry/   data.csv, logs.txt
├── Funeral_Finder/    Funeral_data.csv, Funeral_data_not_found.csv,
│                      Funeral_data_review.csv, logs.txt, reverify_logs.txt
├── Updater/           data.csv, logs.txt
└── ClosingTask/       data.csv, logs.txt
```

---

*Built for a funeral flowers company. Automates what used to take hours per day.*
