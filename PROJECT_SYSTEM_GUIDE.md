# BlossomTask System Guide

Last updated: 2026-05-02

## What This Project Is

BlossomTask is a funeral-order automation system. It takes open tasks from the business system, enriches them into detailed order data, searches for obituary and funeral information, re-checks weak matches, writes the final status back downstream, and closes completed tasks.

In short:

- it reduces manual funeral-order research work
- it classifies records into meaningful business statuses
- it gives operators a dashboard, schedule controls, previews, logs, and admin tools

## Why It Exists

This project exists to solve a practical operations problem:

- open work arrives as tasks
- each task must be turned into an order-level research workflow
- funeral data can be found, partially found, customer-provided, missing, or uncertain
- downstream systems must be updated consistently
- tasks should only close after the data pipeline has finished correctly

Without this system, teams would have to:

- fetch tasks manually
- search obituaries manually
- decide record quality manually
- re-check uncertain cases manually
- update the business system manually
- close tasks manually

## Core Features

### Main workflow features

- fetch open tasks
- fetch order inquiry details
- funeral/obituary lookup
- re-verification of weak records
- downstream update preparation and posting
- task closing

### Runtime features

- full manual pipeline run
- scheduled pipeline run
- cooldown-after-completion scheduling
- live run preview
- real script-level log viewing
- per-script force run for newest order inquiry data

### Admin features

- login/logout
- logout everywhere
- clear other sessions
- create users
- delete users
- reset passwords
- session timeout control
- timezone control
- Google Drive sync settings

### Data visibility features

- data viewer
- run summary cards
- pipeline preview
- alerts and error visibility
- daily and overall status breakdown
- cross-file comparison by order id

## High-Level Architecture

### 1. CLI and operator entry

Main files:

- `main.py`
- `terminal_runner.py`

Purpose:

- start the UI
- run the pipeline
- manage system setup
- manage access controls
- run project update verification

### 2. Backend API and scheduler

Main area:

- `backend/`

Purpose:

- expose REST endpoints for UI
- launch script jobs
- track pipeline jobs
- manage schedules
- store runtime state
- manage login/session/admin settings

### 3. Frontend dashboard

Main area:

- `src/`

Purpose:

- show the current health of the system
- trigger scripts and pipeline runs
- show live progress and logs
- manage schedules and admin settings
- browse outputs

### 4. Python pipeline scripts

Main area:

- `Scripts/`

Purpose:

- do the real business processing step by step

## Full Workflow

### Stage 1: `GetTask.py`

What it does:

- fetches open tasks from the CRM/API
- writes task data to `Scripts/outputs/GetTask/`
- stamps `last_processed_at`

Why it matters:

- this is the starting point of the whole workflow

### Stage 2: `GetOrderInquiry.py`

What it does:

- reads task rows from stage 1
- fetches order-level details for each task
- writes enriched records to `Scripts/outputs/GetOrderInquiry/`
- stamps `last_processed_at`

Why it matters:

- downstream processing depends on real order-level fields coming from here

### Stage 3: `Funeral_Finder.py`

What it does:

- reads inquiry data
- searches for obituary/funeral details
- classifies each row into status buckets
- writes unified and per-status outputs

Possible outcomes:

- `Found`
- `Review`
- `NotFound`
- `Customer`

Special rule:

- if outside sources do not confirm service timing, but `ord_instruct` contains usable schedule information, the system may normalize that data and save it as `Customer`

### Stage 4: `reverify.py`

What it does:

- revisits `NotFound` and `Review` rows
- applies alternate search strategies
- can improve classification

Important:

- it should not behave like a completely separate pipeline
- it is a corrective stage after Funeral Finder, not a replacement for it

### Stage 5: `Updater.py`

What it does:

- reads output from the funeral-processing stage
- prepares downstream payloads
- posts workflow results back to the business system

Modes:

- `complete`
- `found_only`
- `not_found`
- `review`

### Stage 6: `ClosingTask.py`

What it does:

- closes tasks for records that are ready

Important:

- this must happen only after earlier stages are finished and trustworthy

## Status Meaning

### `Found`

Use when:

- outside evidence is strong enough
- the record is suitable for normal downstream success handling

### `Review`

Use when:

- the result is partial, uncertain, conflicting, or requires manual review

### `NotFound`

Use when:

- the system could not find trustworthy funeral/obituary confirmation
- no usable customer-provided fallback can safely promote it to `Customer`

### `Customer`

Use when:

- external sources do not confirm the schedule
- customer-provided instructions contain usable funeral schedule details
- the schedule is normalized from `ord_instruct`

Meaning:

- this is customer-provided timing, not independently confirmed outside evidence

## Manual Pipeline vs Scheduled Pipeline

### Manual pipeline

Triggered from:

- dashboard full pipeline button
- CLI pipeline command

Purpose:

- run the entire sequence once

### Scheduled pipeline

Triggered from:

- backend schedule records managed through the UI

Purpose:

- automatically run the same pipeline sequence without operator intervention

Critical rule:

- scheduled pipeline must use the same true sequence as manual pipeline
- cron must not start until the operator has explicitly chosen:
  - whether Reverify should run
  - which scheduled model should be used

## Cron and Cooldown Rules

BlossomTask scheduling is intentionally strict.

### The correct rule

If the schedule says `N` minutes or `N` seconds:

1. run the full pipeline
2. wait until the full pipeline completes
3. start the cooldown timer
4. after the cooldown expires, trigger the next full pipeline

### What must never happen

- no second pipeline while the first one is still active
- no overlapping script execution
- no next run based only on wall clock if the previous pipeline is still executing
- no cron enable/trigger on missing required schedule config

## Force Run Latest Data

Available only for:

- `Funeral_Finder`
- `reverify`

How it works:

- the operator chooses a latest-count window
- the system selects the newest `GetOrderInquiry` rows using `last_processed_at`
- only those latest rows are reprocessed

Why it exists:

- operators sometimes need to quickly reprocess the latest inquiry data without rerunning the whole historical dataset

## Cron Configuration Rules

Before cron can be enabled safely:

1. the interval must be set
2. the operator must choose whether Reverify is included
3. if Reverify is included, the operator must choose its source
4. the operator must choose the scheduled model

If any of those are missing:

- the schedule should not run
- the UI should show that config is incomplete

## Live Preview and Run Summary

### Pipeline Preview

Shows:

- active pipeline
- active step
- live elapsed time
- current progress
- latest live output

### Run Summary

Shows:

- each script card
- latest job status
- logs
- per-script controls

Important:

- preview and progress should reflect real runtime state, not fake timers

## Dashboard Sections

### Order stats

Shows:

- daily status breakdown
- overall run summary
- count and percentage bars

### Live validation

Shows:

- validation-style counts for major result groups

### Alerts

Shows:

- job failures
- runtime tracebacks
- pipeline-level issues

### Data viewer

Shows:

- output files directly from the current runtime state

### Cross-check

Shows:

- same order across outputs for investigation

### Admin control room

Shows:

- user creation
- session settings
- timezone settings
- sync settings
- users list
- sessions list

## Admin Rules

- new user creation must remain visible and readable
- admin sections should expand and collapse cleanly
- session cleanup actions must be explicit
- logout and revoke actions should not silently fail

## Authentication and Session Handling

The backend supports:

- login
- current-session validation
- logout
- logout all sessions
- revoke one session
- revoke all sessions for a selected user
- purge inactive sessions

Session behavior:

- session TTL is configurable
- active sessions are extended through normal authenticated use

## Outputs and Runtime Files

Main output folders:

- `Scripts/outputs/GetTask/`
- `Scripts/outputs/GetOrderInquiry/`
- `Scripts/outputs/Funeral_Finder/`
- `Scripts/outputs/Updater/`
- `Scripts/outputs/ClosingTask/`

Main backend state files:

- `backend/data/jobs.json`
- `backend/data/schedules.json`
- `backend/data/run_history_logs.jsonl`
- `backend/data/pipeline_error_report.json`
- `backend/data/funeral_fix_report.json`

Main root runtime files:

- `pipeline_checkpoint.json`
- `pipeline_state.json`
- `pipeline_last_summary.json`
- `pipeline_logs.jsonl`

## Project Update Manager

Accessible from:

- `main.py --project-update`
- interactive menu option `[13]`

Purpose:

- verify the git remote
- fetch latest remote state
- fast-forward pull when safe
- run repository integrity checks
- build a tracked-file SHA256 manifest

Remote URL configured:

- `https://github.com/RishuBurnwal/BlossomTask`

Safety behavior:

- dirty worktrees are blocked by default
- diverged branches are not auto-merged
- fast-forward only

## Strict Rules That Must Always Be Followed

1. No script may overlap another script in the same pipeline run.
2. Pipeline order must remain sequential.
3. A later stage must not start before the earlier stage finishes.
4. Cron must trigger the real pipeline, not a shortcut path.
5. Cooldown starts after pipeline completion, not before.
6. A guard-blocked script must fail the pipeline, not silently pass it.
7. `Updater` must not push rows that were not actually processed correctly upstream.
8. `ClosingTask` must never close tasks on bad or incomplete workflow state.
9. Customer-provided schedule data must remain clearly marked as `Customer`.
10. UI progress and preview must reflect real runtime state.

## Recommended Daily Operator Workflow

1. Check alerts first.
2. Check pipeline preview or run summary.
3. Review daily or overall status breakdown.
4. Use force run only for targeted newest-row reprocessing.
5. Review `Review` and `NotFound` behavior before downstream pushes if something looks unusual.
6. Use admin tools only when session/user settings need changes.

## If Something Goes Wrong

Start in this order:

1. check the alert card
2. inspect the active script logs
3. inspect `backend/data/pipeline_error_report.json`
4. inspect the relevant output folder
5. confirm whether a run guard blocked a stage
6. confirm whether downstream stages were correctly stopped

## Source of Truth

For human operators:

- `PROJECT_SYSTEM_GUIDE.md`

For engineering audit and risk review:

- `PROJECT_AUDIT.md`

For agent maintenance rules:

- `Master Prompt.md`
