<p align="center">
  <strong>🌸 BlossomTask</strong><br/>
  <em>Funeral Order Automation Pipeline</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.0.0-blue?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/python-3.10+-green?style=flat-square&logo=python" alt="Python" />
  <img src="https://img.shields.io/badge/node-18+-green?style=flat-square&logo=node.js" alt="Node.js" />
  <img src="https://img.shields.io/badge/react-18-blue?style=flat-square&logo=react" alt="React" />
  <img src="https://img.shields.io/badge/docker-ready-blue?style=flat-square&logo=docker" alt="Docker" />
  <img src="https://img.shields.io/badge/license-proprietary-red?style=flat-square" alt="License" />
</p>

---

# 📖 Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Version History](#version-history)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Running the Application](#running-the-application)
- [Pipeline Workflow](#pipeline-workflow)
- [Component Details](#component-details)
- [API Reference](#api-reference)
- [Docker Deployment](#docker-deployment)
- [Environment Configuration](#environment-configuration)
- [Output Files & Directory Structure](#output-files--directory-structure)
- [Dashboard UI Guide](#dashboard-ui-guide)
- [Business Logic & Routing Rules](#business-logic--routing-rules)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

---

## Overview

**BlossomTask** is a production-ready, idempotent automation pipeline designed to process funeral orders end-to-end. It fetches open tasks from a CRM system, enriches them with order inquiry data, uses **Perplexity AI** (`sonar-pro`) to find obituary and funeral details, prepares structured payloads for CRM upload, and closes the processed tasks — all while providing a modern **React-based dashboard** for monitoring, scheduling, and data exploration.

The system is designed to be **resumable and safe**: every stage tracks progress via log files, so re-running the pipeline only processes new records. This makes it reliable for production environments where partial failures can naturally occur.

---

## Key Features

| Feature | Description |
|---------|-------------|
| 🔄 **Idempotent Pipeline** | Every stage tracks processed order IDs in `logs.txt`. Re-running skips already-processed records automatically. |
| 🤖 **AI-Powered Enrichment** | Uses Perplexity AI (`sonar-pro`) for high-accuracy funeral/obituary data lookup and classification. |
| 🖥️ **Full-Stack Dashboard** | React + TypeScript frontend with real-time script execution monitoring, log streaming, and data comparison. |
| ⏰ **Cron Scheduling** | Built-in cron scheduler for automated pipeline execution at configurable intervals. |
| 🐳 **Docker Ready** | One-command deployment with Docker Compose — includes Python, Node.js, and all dependencies. |
| 📊 **Data Explorer** | Browse output files (CSV, JSON, XLSX) directly from the dashboard UI with searchable tables. |
| 🔍 **Order Comparison** | Compare the same order across all pipeline stages to track data transformations. |
| 🎯 **File Mode Support** | Updater supports 4 run modes: `complete`, `found_only`, `not_found`, `review` for targeted processing. |
| 🛡️ **Preflight Checks** | Automated verification of script files, environment variables, and output directories before pipeline execution. |
| 🔌 **Platform-Aware** | Automatically detects Python binary and adapts process control for Windows, Linux, and macOS. |

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                        main.py (CLI Launcher)                  │
│  Interactive menu • Pipeline orchestrator • Docker launcher    │
└────────────┬───────────────────┬───────────────────────────────┘
             │                   │
    ┌────────▼───────┐  ┌───────▼────────────────────────────────┐
    │  Python Scripts │  │      Full-Stack Dashboard              │
    │  (Scripts/)     │  │                                        │
    │                 │  │  ┌──────────┐ proxy  ┌──────────────┐ │
    │  • GetTask      │  │  │ Vite     │ ────►  │ Express.js   │ │
    │  • GetOrderInq. │  │  │ React 18 │ :8080  │ Node.js API  │ │
    │  • Funeral_Find.│  │  │ TypeScript│        │ :8787        │ │
    │  • Updater      │◄─┤  │ Shadcn UI│        │ Cron Engine  │ │
    │  • ClosingTask  │  │  └──────────┘        └──────────────┘ │
    └────────┬────────┘  └───────────────────────────────────────┘
             │
    ┌────────▼────────┐
    │  External APIs   │
    │  • CRM (8061)    │
    │  • Perplexity AI │
    │  • OpenAI        │
    └─────────────────┘
```

---

## Tech Stack

### Backend

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| API Server | Express.js | 4.21+ | REST API, job orchestration, cron scheduling |
| Runtime | Node.js | 18+ | Server runtime |
| Scheduler | node-cron | 3.x | Cron-based pipeline automation |
| Storage | JSON files | — | Job state, schedules, run history |

### Frontend

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| Framework | React | 18.3 | UI component library |
| Build Tool | Vite | 5.4 | Fast dev server and bundler |
| Language | TypeScript | 5.8 | Type safety |
| UI Library | shadcn/ui | latest | Beautiful, accessible components |
| Styling | Tailwind CSS | 3.4 | Utility-first CSS |
| Data Fetching | TanStack Query | 5.x | Server state management |
| Charts | Recharts | 2.x | Data visualization |
| Icons | Lucide React | 0.462 | Icon library |

### Python Pipeline

| Component | Library | Purpose |
|-----------|---------|---------|
| HTTP Client | requests | CRM API communication |
| Data Processing | pandas | CSV/DataFrame operations |
| Excel Output | openpyxl | XLSX file generation |
| Config | python-dotenv | Environment variable loading |
| AI Search | Perplexity API | Obituary/funeral lookup |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| **2.0.0** | 2026-04 | Interactive CLI launcher, Docker deployment, pipeline status endpoint, platform-aware Python, file mode support for Updater, real terminal log viewer, comprehensive dashboard |
| **1.0.0** | 2025-12 | Initial release — 5-stage pipeline, basic dashboard UI |

---

## Prerequisites

| Requirement | Minimum Version | Check Command |
|-------------|-----------------|---------------|
| **Python** | 3.10+ | `python --version` |
| **Node.js** | 18+ | `node --version` |
| **npm** | 8+ | `npm --version` |
| **Docker** *(optional)* | 20+ | `docker --version` |

### Required API Keys (in `.env`)

- **Perplexity API Key** — For AI-powered funeral data lookup
- **OpenAI API Key** — For supplementary AI processing
- **CRM API Key** — For task/order management (`X-VCAppApiKey`)

---

## Installation

### Quick Start (Recommended)

```bash
# 1. Clone the repository
git clone <repository-url>
cd BlossomTask

# 2. Run the interactive installer
python main.py
# → Select option [6] "Install Dependencies"
# → Select option [3] "Install ALL (Python + Node.js)"
```

### Manual Installation

```bash
# Install Python dependencies
pip install -r requirements.txt

# Install Node.js dependencies
npm install

# Copy and configure environment variables
cp .env.example .env
# Edit .env with your API keys and configuration
```

### Docker Installation

```bash
# Build and start everything with one command
docker compose up --build

# Frontend: http://localhost:8080
# Backend:  http://localhost:8787
```

---

## Running the Application

### Interactive Menu (Default)

```bash
python main.py
```

This opens the professional interactive menu with options:

| Option | Description |
|--------|-------------|
| `[1]` Launch Dashboard UI | Start both frontend and backend, open browser |
| `[2]` Run Full Pipeline | Execute all 5 stages sequentially |
| `[3]` Configure & Run Pipeline | Choose stages, dry-run, force mode |
| `[4]` Port Configuration | Custom ports, single-server mode |
| `[5]` Run with Docker | Build and start Docker containers |
| `[6]` Install Dependencies | List and install Python + Node.js deps |
| `[7]` System Health Check | Verify all prerequisites and configuration |
| `[8]` View Output Files | Browse pipeline output directory |

### CLI Flags

```bash
# Launch dashboard UI directly
python main.py --ui

# Launch on custom ports
python main.py --ui --frontend-port 3000 --backend-port 9000

# Run full pipeline
python main.py --pipeline

# Run specific stage with limits
python main.py --stage search --limit 10

# Dry-run mode (no CRM changes)
python main.py --pipeline --dry-run --limit 5

# Force re-processing
python main.py --pipeline --force

# Docker deployment
python main.py --docker

# Install all dependencies
python main.py --install

# System health check
python main.py --health
```

### Manual Server Start

```bash
# Terminal 1: Start backend
node backend/server.js

# Terminal 2: Start frontend
npm run dev

# Or start both at once
npm run dev:full
```

---

## Pipeline Workflow

The pipeline consists of 5 sequential stages that process funeral orders from task creation to completion:

```
Stage 1          Stage 2           Stage 3           Stage 4         Stage 5
┌──────────┐    ┌──────────────┐  ┌───────────────┐  ┌──────────┐  ┌────────────┐
│ GetTask  │ ─► │GetOrderInq.  │─►│Funeral_Finder │─►│ Updater  │─►│ClosingTask │
│          │    │              │  │               │  │          │  │            │
│ Fetch    │    │ Enrich with  │  │ AI-powered    │  │ Upload   │  │ Close CRM  │
│ open     │    │ shipping &   │  │ obituary      │  │ results  │  │ tasks with │
│ CRM tasks│    │ customer     │  │ lookup &      │  │ to CRM   │  │ detailed   │
│          │    │ details      │  │ classification│  │          │  │ notes      │
└──────────┘    └──────────────┘  └───────────────┘  └──────────┘  └────────────┘
  📥 Fetch        📋 Enrich         🔍 Search          📤 Upload     ✅ Close
```

### Stage Details

#### 1. GetTask (`GetTask.py`)
- **Input**: CRM API (`/api/TaskOpened`)
- **Output**: `Scripts/outputs/GetTask/data.csv`
- **Purpose**: Fetches all open tasks with subject "Verify and Pull Down Times"
- **Features**: Pagination support, immediate CSV/Excel save per record

#### 2. GetOrderInquiry (`GetOrderInquiry.py`)
- **Input**: `GetTask/data.csv` → CRM API (`/api/orderinquiry`)
- **Output**: `Scripts/outputs/GetOrderInquiry/data.csv`
- **Purpose**: Enriches task records with shipping address, customer details

#### 3. Funeral_Finder (`Funeral_Finder.py`)
- **Input**: `GetOrderInquiry/data.csv`
- **Output**: `Scripts/outputs/Funeral_Finder/Funeral_data.csv`
- **Purpose**: Uses Perplexity AI to search for obituaries and funeral home details
- **Modes**: `batch` (automatic) or `interactive` (manual confirmation)
- **Classification**: Routes results to `Found`, `NotFound`, or `Review`

#### 4. Updater (`Updater.py`)
- **Input**: `Funeral_Finder/Funeral_data.csv`
- **Output**: `Scripts/outputs/Updater/data.csv`
- **Purpose**: Builds structured CRM payloads and uploads via `/api/createcomm`
- **File Modes**: `complete`, `found_only`, `not_found`, `review`

#### 5. ClosingTask (`ClosingTask.py`)
- **Input**: `Updater/data.csv` (or pipeline payloads)
- **Output**: `Scripts/outputs/ClosingTask/data.csv`
- **Purpose**: Closes processed CRM tasks with detailed notes

---

## Component Details

### Python Scripts (`Scripts/`)

| File | Size | Description |
|------|------|-------------|
| `GetTask.py` | ~16 KB | CRM task fetcher with pagination, deduplication, and immediate output |
| `GetOrderInquiry.py` | ~14 KB | Order detail enrichment from CRM API |
| `Funeral_Finder.py` | ~25 KB | AI-powered funeral data lookup with batch/interactive modes |
| `Updater.py` | ~22 KB | Payload builder and CRM uploader with 4 file mode options |
| `ClosingTask.py` | ~17 KB | Task closure with detailed CRM notes |
| `.env` | ~2.5 KB | Script-specific environment configuration |

### Backend (`backend/`)

| File | Description |
|------|-------------|
| `server.js` | Express.js API server — job management, pipeline orchestration, cron scheduling, file browsing |
| `lib/scripts.js` | Script catalog — defines all 5 pipeline scripts with IDs, options, and file paths |
| `lib/files.js` | File operations — directory tree listing, CSV/JSON parsing, output path resolution |
| `lib/compare.js` | Data comparison — cross-reference order data across pipeline stage outputs |
| `lib/storage.js` | JSON persistence — `jobs.json` and `schedules.json` management |

### Frontend (`src/`)

| File | Description |
|------|-------------|
| `components/DashboardHeader.tsx` | Main header — pipeline status, cron controls, schedule management, run history |
| `components/ScriptPanel.tsx` | Script execution cards — run/stop buttons, terminal log viewer, progress bar, updater mode selector |
| `components/DataViewer.tsx` | Data table viewer — browse CSV/JSON output files with search |
| `components/CompareSection.tsx` | Order comparison — diff view of the same order across all pipeline stages |
| `components/ViewOptionsModal.tsx` | File selection modal for data viewing |
| `lib/api.ts` | API client — typed fetch wrappers for all backend endpoints |
| `lib/types.ts` | TypeScript type definitions — `Job`, `ScriptConfig`, `PipelineStatus`, etc. |
| `contexts/ThemeContext.tsx` | Theme management — dark/light mode with darkness level slider |

### Docker Files

| File | Description |
|------|-------------|
| `Dockerfile` | Multi-layer build — Node.js 18 base, Python 3 + venv, pip install, npm install |
| `docker-compose.yml` | Service definition — ports 8080/8787, volume mounts, healthcheck |
| `docker-entrypoint.sh` | Container startup — creates directories, launches backend + frontend, graceful shutdown |

---

## API Reference

The backend provides a REST API on port `8787`:

### Health & Status

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Server health check (`{ ok: true }`) |
| `/api/preflight` | GET | Full environment verification report |
| `/api/pipeline/status` | GET | Pipeline state (`idle`, `running`, `disabled`) |

### Script Execution

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/api/scripts` | GET | — | List all available scripts with options |
| `/api/jobs/run-script` | POST | `{ scriptId, option? }` | Run a single script |
| `/api/jobs/run-pipeline` | POST | `{ sequence? }` | Run the full pipeline |
| `/api/jobs` | GET | — | List all jobs |
| `/api/jobs/:id` | GET | — | Get job details + logs |
| `/api/jobs/:id/cancel` | POST | — | Cancel a running job |
| `/api/jobs` | DELETE | — | Clear all job history |

### Schedule Management

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/api/schedules` | GET | — | List all cron schedules |
| `/api/schedules` | POST | `{ name, cron, enabled? }` | Create a new schedule |
| `/api/schedules/:id` | PATCH | `{ name?, cron?, enabled? }` | Update a schedule |
| `/api/schedules/:id` | DELETE | — | Delete a schedule |
| `/api/schedules/:id/trigger` | POST | — | Manually trigger a schedule |
| `/api/schedules/:id/history` | GET | — | Get run history for a schedule |

### Data & Files

| Endpoint | Method | Query/Body | Description |
|----------|--------|------------|-------------|
| `/api/data/datasets` | GET | `limit?` | Get default datasets with summaries |
| `/api/files/tree` | GET | `path, recursive?` | Browse output directory tree |
| `/api/files/content` | GET | `path, limit?` | Read file content (CSV/JSON parsed) |
| `/api/compare/order-id` | POST | `{ orderId, files[] }` | Compare order across files |
| `/api/config/outputs-root` | GET | — | Get absolute outputs directory path |

---

## Docker Deployment

### Quick Start

```bash
# Build and run
docker compose up --build

# Run in background
docker compose up --build -d

# Stop
docker compose down

# View logs
docker compose logs -f app
```

### Docker Architecture

```
┌──────────────────────────────────────────┐
│  Docker Container                        │
│                                          │
│  ┌─────────────┐   ┌─────────────────┐  │
│  │ Python 3    │   │ Node.js 18      │  │
│  │ (venv)      │   │                 │  │
│  │ Scripts/*.py│   │ Backend :8787   │  │
│  └─────────────┘   │ Frontend :8080  │  │
│                     └─────────────────┘  │
│                                          │
│  Ports: 8080 (UI), 8787 (API)           │
│  Volume: .:/app (live reload)           │
│  Healthcheck: /api/health (30s)         │
└──────────────────────────────────────────┘
```

### `docker-compose.yml` Reference

```yaml
services:
  app:
    build: .
    ports:
      - "8080:8080"   # Frontend (Vite)
      - "8787:8787"   # Backend (Express)
    volumes:
      - .:/app         # Live code reload
      - /app/node_modules
    env_file:
      - .env
    environment:
      - NODE_ENV=development
      - PYTHONUNBUFFERED=1
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8787/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
```

---

## Environment Configuration

### Root `.env` (Project Root)

```ini
# AI API Keys
PERPLEXITY_API_KEY=pplx-...
OPENAI_API_KEY=sk-proj-...

# CRM Authentication
API_KEY_HEADER=X-VCAppApiKey
API_KEY_VALUE=your-api-key

# CRM Endpoints
API_URL_TASK_OPENED=http://ordstatus.tfdash.info:8061/api/TaskOpened/...
API_URL_CLOSE_TASK=http://ordstatus.tfdash.info:8061/api/CloseTask
API_URL_ORDER_INQUIRY=http://ordstatus.tfdash.info:8061/api/orderinquiry/...

# Pipeline Configuration
TASK_SUBJECT=Verify and Pull Down Times
LOOKUP_MAX_ROWS=1
FUNERAL_MAX_ROWS=0
CLOSE_TASK_DRY_RUN=true
```

### Scripts `.env` (`Scripts/.env`)

Same format as root `.env`. Python scripts load from this file automatically. The backend server reads this file for preflight checks.

> **Important**: Both `.env` files are listed in `.gitignore` and should never be committed. Copy them from a secure source or create from the template above.

---

## Output Files & Directory Structure

```
Scripts/outputs/
├── GetTask/
│   ├── data.csv         # Fetched tasks (order_id, task_id, status)
│   ├── data.xlsx        # Excel version (auto-generated)
│   ├── payload.json     # Raw server response
│   ├── logs.txt         # Processed order IDs
│   └── query.txt        # Exact API request details
│
├── GetOrderInquiry/
│   ├── data.csv         # Enriched order details
│   ├── data.xlsx
│   ├── payload.json
│   └── logs.txt
│
├── Funeral_Finder/
│   ├── Funeral_data.csv           # All results
│   ├── Funeral_data.jsonl         # JSONL format
│   ├── Funeral_data_needs_review.csv  # Review-flagged records
│   ├── Funeral_data_low_data.csv      # Low-data records
│   ├── Funeral_data_error.csv         # Error records
│   └── Funeral_checkpoint.json        # Resume checkpoint
│
├── Updater/
│   ├── data.csv         # Upload results + response codes
│   ├── data.xlsx
│   ├── payload.json     # All sent payloads + responses
│   └── logs.txt
│
└── ClosingTask/
    ├── data.csv
    ├── data.xlsx
    ├── payload.json
    └── logs.txt
```

### Backend Data

```
backend/data/
├── jobs.json              # Job state (last 200 jobs)
├── schedules.json         # Cron schedule configurations
└── run_history_logs.jsonl # Full run history log
```

---

## Dashboard UI Guide

### Script Panels
Each of the 5 pipeline scripts has a dedicated card showing:
- **Status badge**: Idle / Running / Done / Failed
- **Run/Stop button**: Execute or cancel the script
- **Terminal viewer**: Real-time log output with syntax colorization
- **Progress bar**: Animated progress percentage
- **Elapsed time**: Live timer while running, total duration after completion
- **Mode selector**: Updater shows file source dropdown (Complete/Found Only/Not Found/Review)

### Header Controls
- **Pipeline Status**: Real-time indicator — Running (blue pulse), Idle (green), All Disabled (gray)
- **Cron Mode**: Default (30-min) or Custom interval
- **Run Full Pipeline**: One-click execution of all 5 stages
- **Updater Mode**: Select which file source the Updater uses in the pipeline
- **Preflight Check**: Verify environment before running
- **Theme Controls**: Dark/Light mode with darkness level slider

### Schedule Management
- Create, edit, and delete cron schedules
- Enable/disable schedules (auto-cancels running pipelines on disable)
- Manual trigger for any schedule
- Run history with log inspection

### Data Explorer
- Browse output files in a tree view
- View CSV/JSON data in searchable tables
- Compare the same order ID across all pipeline stages

---

## Business Logic & Routing Rules

| Category | Criteria | Action |
|----------|----------|--------|
| **Found** (matched) | Confidence ≥ 75%, identity confirmed | Upload with service details |
| **Not Found** | No obituary found or clear mismatch | Upload as NotFound |
| **Review** | Ambiguous results, low confidence | Flag for human review |
| **Unmatched** | Clear wrong-person match | Re-queue for manual check |

### Canonical Record Schema

Every record flowing through the pipeline includes these fields:

```
order_id, task_id, ship_name, ship_city, ship_state, ship_zip,
funeral_home_name, service_date, service_time, best_event_type,
match_score, match_status, crm_upload_status, task_close_status,
last_processed_at
```

---

## Troubleshooting

### Common Issues

| Problem | Solution |
|---------|----------|
| `python3: command not found` | On Windows, use `python` instead. The app auto-detects the correct binary. |
| `node backend/server.js` fails | Ensure `npm install` was run successfully. Check that port 8787 is free. |
| `CORS errors in browser` | Always access the frontend via Vite dev server (port 8080), which proxies API requests. |
| `ModuleNotFoundError: requests` | Run `pip install -r requirements.txt` to install Python dependencies. |
| Port already in use | Use custom ports: `python main.py --ui --frontend-port 3001 --backend-port 9001` |
| Docker build fails | Ensure Docker Desktop is running. Check `docker --version`. |
| Scripts hang or timeout | Check CRM API availability. Verify `.env` URLs include proper `/api/` path. |
| Empty pipeline output | Run preflight check (`python main.py --health`) to verify `.env` configuration. |

### Checking Logs

```bash
# Backend logs
# Logs are printed to stdout when running server.js

# Script execution logs
ls Scripts/outputs/*/logs.txt

# Dashboard log viewer
# Click the "Logs" button on any script panel in the UI

# Docker logs
docker compose logs -f app
```

### Health Check

```bash
# From the CLI
python main.py --health

# From the API
curl http://localhost:8787/api/health
curl http://localhost:8787/api/preflight
```

---

## FAQ

### General

**Q: What does BlossomTask do?**
A: BlossomTask automates the process of looking up funeral/obituary information for flower delivery orders. It fetches open tasks from a CRM, enriches them with customer data, uses AI to find service dates and funeral home details, then uploads the results back to the CRM.

**Q: Is the pipeline safe to re-run?**
A: Yes! Every stage is idempotent. Previously processed orders are tracked in `logs.txt` and automatically skipped on re-runs. Use `--force` to override this behavior.

**Q: What AI services does it use?**
A: Primarily **Perplexity AI** (`sonar-pro` model) for web-based obituary searches. OpenAI is available as a fallback for supplementary processing.

### Running

**Q: How do I just launch the UI?**
A: Run `python main.py` and select option `[1]`, or directly run `python main.py --ui`.

**Q: Can I run a single stage instead of the full pipeline?**
A: Yes. Use `python main.py --stage search` or the interactive menu option `[3]` to select individual stages.

**Q: How do I run in dry-run mode?**
A: Use `python main.py --pipeline --dry-run`. This simulates CRM uploads without actually sending any data.

**Q: What are the Updater file modes?**
A: The Updater can process different subsets of data:
- `complete` — All records from Funeral_Finder output
- `found_only` — Only records where match_status = "Found"
- `not_found` — Only records where match_status = "NotFound"
- `review` — Only records that need human review

### Docker

**Q: How do I run with Docker?**
A: Run `docker compose up --build`. The UI will be at `http://localhost:8080`.

**Q: Can I use Docker in production?**
A: The included Docker setup is optimized for development (volume mounts, dev server). For production, modify the Dockerfile to build the Vite frontend and serve static files.

**Q: Do I need Docker installed?**
A: No, Docker is optional. You can run everything natively with Python 3.10+ and Node.js 18+.

### Troubleshooting

**Q: The dashboard shows "All Disabled" — what does that mean?**
A: This means no cron schedules are enabled. Create or enable a schedule in the dashboard header to start automated runs.

**Q: Scripts fail with "Missing required env var"**
A: Check that both `.env` files exist (`root/.env` and `Scripts/.env`) and contain all required API keys and URLs.

**Q: How do I clear all processed data and start fresh?**
A: Delete the contents of `Scripts/outputs/*/logs.txt` to reset processing state, or use the `--force` flag.

**Q: Port 8080 or 8787 is already in use**
A: Use custom ports via the interactive menu (option `[4]`) or CLI flags: `--frontend-port 3000 --backend-port 9000`.

---

<p align="center">
  <em>Built with ❤️ by the BlossomTask team</em>
</p>
