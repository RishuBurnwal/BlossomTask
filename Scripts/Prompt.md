# BlossomTask — Reverify Integration Task

## MEMORY / CONTEXT (read before touching any file)

Project: BlossomTask — 5-stage funeral order automation pipeline
Stack: Python scripts (Scripts/) + Express backend (backend/) + React frontend (src/)
Existing pipeline stages: GetTask → GetOrderInquiry → Funeral_Finder → Updater → ClosingTask
Backend script registry: backend/lib/scripts.js (defines scriptId, label, path, options for each script)
Frontend script cards: src/components/ScriptPanel.tsx (renders each script as a UI card)
Backend API entry: backend/server.js (handles /api/jobs/run-script, /api/jobs/run-pipeline)
Pipeline runner config: terminal_runner.py + main.py (CLI orchestration)

## TASK SUMMARY

Two things need to be done:
1. Replace Scripts/Funeral_Finder.py with fixed version (3 bug fixes — exact code given below)
2. Register Scripts/reverify.py as a new Stage 3.5 in backend, frontend, CLI pipeline, and terminal runner

## STRICT RULES — READ BEFORE CODING

- Touch ONLY the files listed in each sub-task. No others.
- Do not refactor unrelated code. Do not rename variables. Do not reformat.
- After every file edit, re-read the file and confirm the change is correct.
- Run `python -c "import ast; ast.parse(open('Scripts/Funeral_Finder.py').read()); print('OK')"` after editing Funeral_Finder.py
- Run the UI (npm run dev + node backend/server.js) and CLI (python reverify.py --limit 1 --force) to verify before marking done.
- If any step fails, fix it before moving to the next.

---

## SUB-TASK 1 — Fix Scripts/Funeral_Finder.py

ONLY edit: Scripts/Funeral_Finder.py
DO NOT touch: any other file in this sub-task

### Fix A — Replace _extract_json_from_text() (currently lines ~95–103)

Remove the entire existing function and replace with:
```python
def _extract_json_from_text(text: str) -> dict:
    """Robust JSON extractor — 3 strategies, returns largest valid object."""
    if not text:
        return {}
    # Strategy 1: largest valid JSON object
    best = {}
    for match in re.finditer(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}", text, re.DOTALL):
        try:
            candidate = json.loads(match.group(0))
            if len(candidate) > len(best):
                best = candidate
        except (json.JSONDecodeError, ValueError):
            pass
    if best:
        return best
    # Strategy 2: first { to last }
    start = text.find("{")
    end   = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except (json.JSONDecodeError, ValueError):
            pass
    # Strategy 3: markdown code blocks
    for pattern in [r"```json\s*(.*?)```", r"```\s*(.*?)```"]:
        m = re.search(pattern, text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(1).strip())
            except (json.JSONDecodeError, ValueError):
                pass
    return {}
```

### Fix B — Replace status + score block inside parse_ai_response() (currently lines ~285–300)

Find this exact block:
```python
    # Normalize status
    raw_status = _safe_str(ai_data.get("status") or ai_data.get("Status") or "Review")
    status_lower = raw_status.lower()
    if status_lower in ("found", "matched"):
        match_status = "Found"
    elif status_lower in ("notfound", "not_found", "not found", "mismatched"):
        match_status = "NotFound"
    else:
        match_status = "Review"

    # Accuracy score
    score = ai_data.get("AI Accuracy Score") or ai_data.get("ai_accuracy_score") or ai_data.get("confidence_score") or 0
    try:
        score = float(str(score).replace("%", "").strip())
    except (ValueError, TypeError):
        score = 0
```

Replace with:
```python
    # Status — check all key name variants AI might return
    raw_status = _safe_str(
        ai_data.get("status")       or ai_data.get("Status")      or
        ai_data.get("STATUS")       or ai_data.get("match_status") or
        ai_data.get("Match Status") or ai_data.get("result")      or ""
    )
    status_lower = raw_status.lower().strip()
    if status_lower in ("found", "matched", "yes", "confirmed"):
        match_status = "Found"
    elif status_lower in ("notfound", "not_found", "not found", "mismatched", "no", "none"):
        match_status = "NotFound"
    elif status_lower in ("review", "needs_review", "needs review", "uncertain", "unverified"):
        match_status = "Review"
    else:
        has_data = bool(
            ai_data.get("funeral_home_name") or ai_data.get("Funeral home name (optional)") or
            ai_data.get("funeral_date")      or ai_data.get("Funeral date") or
            ai_data.get("service_date")
        )
        match_status = "Review" if has_data else "NotFound"

    # Score — check all key name variants
    score = (
        ai_data.get("AI Accuracy Score")  or ai_data.get("ai_accuracy_score") or
        ai_data.get("Accuracy Score")     or ai_data.get("accuracy_score")    or
        ai_data.get("confidence_score")   or ai_data.get("Confidence Score")  or
        ai_data.get("score")              or ai_data.get("Score")             or 0
    )
    try:
        score = float(str(score).replace("%", "").strip())
    except (ValueError, TypeError):
        score = 0

    # Score-based correction: if score>=75 but status resolution landed on Review, upgrade to Found
    if match_status == "Review" and score >= 75:
        match_status = "Found"
```

Verify after edit: `python -c "import ast; ast.parse(open('Scripts/Funeral_Finder.py').read()); print('Syntax OK')"`

---

## SUB-TASK 2 — Create Scripts/reverify.py

Create new file Scripts/reverify.py. This script:
- Reads Scripts/outputs/Funeral_Finder/Funeral_data_not_found.csv and Funeral_data_review.csv
- Re-queries Perplexity AI (sonar-pro) with 6 query strategies per record (original, normalized city, expanded nickname, state-only, care_of, ord_instruct)
- If Found: appends to Funeral_data.csv (main), removes from source file
- If Review (from not_found): moves to review file
- If NotFound: updates notes in source file
- Maintains Scripts/outputs/Funeral_Finder/reverify_logs.txt for idempotency
- CLI args: --source [both|not_found|review], --force, --limit N
- Loads .env from Scripts/.env (same as Funeral_Finder.py)
- Uses same FIELDNAMES as Funeral_Finder.py
- Uses the improved _extract_json_from_text() (3-strategy version from Fix A above)
- Uses the improved parse_ai_response() status/score logic (from Fix B above)

The reverify_payload.json goes to Scripts/outputs/Funeral_Finder/reverify_payload.json

Verify: `python -c "import ast; ast.parse(open('Scripts/reverify.py').read()); print('Syntax OK')"`

---

## SUB-TASK 3 — Register reverify in backend/lib/scripts.js

ONLY edit: backend/lib/scripts.js
DO NOT touch: server.js, files.js, compare.js, storage.js

Open backend/lib/scripts.js and find the scripts array. It currently has 5 entries (GetTask, GetOrderInquiry, Funeral_Finder, Updater, ClosingTask). Add reverify as entry after Funeral_Finder, using the exact same shape as the other entries. Example of existing shape:
```js
{
  id: "funeral_finder",
  label: "Funeral Finder",
  path: "Scripts/Funeral_Finder.py",
  description: "...",
  options: [...]   // if this field exists on others, match pattern
}
```

Add:
```js
{
  id: "reverify",
  label: "Reverify (Stage 3.5)",
  path: "Scripts/reverify.py",
  description: "Re-verify NotFound and Review records using multi-strategy Perplexity queries",
  options: [
    { value: "both",      label: "Both (Not Found + Review)" },
    { value: "not_found", label: "Not Found Only" },
    { value: "review",    label: "Review Only" },
  ]
}
```

If the existing scripts use a different field structure (args, flags, etc.), match that exact structure — do not invent new fields.

After edit, restart backend: `node backend/server.js` — confirm no crash and `GET /api/scripts` returns 6 scripts including reverify.

---

## SUB-TASK 4 — Add reverify panel to frontend UI

ONLY edit: src/components/ScriptPanel.tsx (or whichever component renders the script cards — confirm by reading it first)
DO NOT touch: DashboardHeader.tsx, DataViewer.tsx, CompareSection.tsx, api.ts, types.ts

The frontend fetches scripts from GET /api/scripts and renders one ScriptPanel card per script. Since reverify is now returned by the backend, it will auto-appear IF the frontend maps scriptId to options UI correctly.

Check if ScriptPanel.tsx has special-cased logic for specific scriptIds (like "updater") to show a mode dropdown. If yes, add the same for "reverify" using its 3 options (both, not_found, review). The dropdown should pass the selected option as the `option` field in POST /api/jobs/run-script body.

If ScriptPanel.tsx is generic and already handles options from the scripts list without hardcoding — no edit needed. Confirm by running the UI and checking if the Reverify card appears with a dropdown.

After edit, run `npm run dev` and open the dashboard. Confirm:
- Reverify card appears between Funeral Finder and Updater
- Dropdown shows 3 options
- Run button triggers the script and logs stream in the terminal viewer

---

## SUB-TASK 5 — Add reverify to pipeline sequence

ONLY edit: backend/lib/scripts.js (pipeline sequence array, if defined there) OR backend/server.js (only the pipeline sequence definition — no other changes)

Find where the full pipeline sequence is defined. It will look like:
```js
const PIPELINE_SEQUENCE = ["get_task", "get_order_inquiry", "funeral_finder", "updater", "closing_task"];
// or similar
```

Add "reverify" between "funeral_finder" and "updater":
```js
["get_task", "get_order_inquiry", "funeral_finder", "reverify", "updater", "closing_task"]
```

After edit, trigger Run Full Pipeline from UI and confirm reverify runs between Funeral Finder and Updater.

---

## SUB-TASK 6 — Add reverify to terminal_runner.py and main.py

ONLY edit: terminal_runner.py and main.py
DO NOT touch: any Script .py file (other than these two)

In terminal_runner.py:
- Find the SCRIPTS list or equivalent sequence definition
- Add reverify.py entry after Funeral_Finder.py in the same format as existing entries
- reverify supports --source [both|not_found|review] — when user selects reverify in manual mode, ask: "Reverify source? [both/not_found/review]" and pass as --source arg
- reverify also supports --force and --limit — expose these if the runner asks for them for other scripts

In main.py:
- Find where the 5-script pipeline is defined for --pipeline flag (or menu option [2])
- Add reverify.py in the correct position (after Funeral_Finder, before Updater)
- No other changes to main.py

After edit, run: `python main.py --terminal-runner` → select fresh run → complete pipeline → confirm reverify executes between Funeral_Finder and Updater

---

## FINAL VERIFICATION CHECKLIST

Run each of these and confirm all pass before finishing:

[ ] `python -c "import ast; ast.parse(open('Scripts/Funeral_Finder.py').read()); print('OK')"`
[ ] `python -c "import ast; ast.parse(open('Scripts/reverify.py').read()); print('OK')"`
[ ] `node -e "require('./backend/lib/scripts.js'); console.log('OK')"` (or equivalent)
[ ] `node backend/server.js` starts without error
[ ] `GET http://localhost:8787/api/scripts` returns array with reverify entry
[ ] `npm run dev` → dashboard shows Reverify card with dropdown between Funeral Finder and Updater
[ ] Click Run on Reverify card → logs appear in terminal viewer → script completes
[ ] `python main.py --pipeline` → reverify runs in correct sequence position
[ ] `python Scripts/reverify.py --source both --limit 1 --force` runs without import errors

If any check fails, fix it and re-run all checks from the beginning.

