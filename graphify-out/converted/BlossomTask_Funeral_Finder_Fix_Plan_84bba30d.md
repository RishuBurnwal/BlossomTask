<!-- converted from BlossomTask_Funeral_Finder_Fix_Plan.docx -->


🌸  BlossomTask — Funeral_Finder
Root Cause Analysis, Fix Plan & Reverify Strategy
April 2026  •  Scripts/Funeral_Finder.py  +  Scripts/reverify.py

## 1.  Document Overview & Scope
This document covers exactly two files that require changes: Funeral_Finder.py (bug fixes) and reverify.py (new script). No other file in the BlossomTask project should be touched.


## 2.  Problem Statement
When Funeral_Finder.py queries the Perplexity AI API (sonar-pro model) to find obituary/funeral data, a large number of valid records are being incorrectly classified as NotFound or Review. When the same records are manually searched, the data is found immediately. This confirms the data exists — the bug is in how the script processes the AI's response, not in Perplexity's search capability.
### What is Observed
- Script runs → many records land in Funeral_data_not_found.csv or Funeral_data_review.csv
- Same records searched manually → obituary and funeral details found easily
- Main Funeral_data.csv (Found) contains far fewer records than expected
### Impact
- Updater.py receives incomplete data → fewer CRM updates
- ClosingTask.py closes fewer tasks → pipeline incomplete
- Unnecessary manual work required to fix AI classification errors


## 3.  Root Cause Analysis — Funeral_Finder.py
Four distinct bugs were identified by reading the source code. Each one independently causes valid records to be misclassified.
### Bug 1 — Default Status Hardcoded to 'Review'  [Line 286]
This is the most impactful bug. The status fallback is hardcoded to 'Review' instead of attempting to infer status from other available data.
# CURRENT CODE  (Line 286)
raw_status = _safe_str(ai_data.get('status') or ai_data.get('Status') or 'Review')
# ↑ If JSON parse fails for ANY reason → immediately 'Review'
# ↑ If AI returns status key with unexpected casing → 'Review'
# ↑ If AI response has extra wrapper text → JSON fails → 'Review'
Root Cause: If _extract_json_from_text() fails to extract JSON (for any reason), ai_data becomes an empty dict {}. The .get('status') returns None, and the or 'Review' fallback fires — setting every failed parse as 'Review' permanently.

### Bug 2 — JSON Extractor Only Finds First Match  [Line 97]
The regex used to extract JSON from AI response text is too simple. It finds the first {…} it encounters — but Perplexity's responses often contain inline curly braces in explanatory text before the actual data object.
# CURRENT CODE  (Line 97)
match = re.search(r'\{.*\}', text, re.DOTALL)
# ↑ Finds FIRST { } block — could be '{name}' in explanation text
# ↑ If that small block parses as JSON → wrong data extracted
# ↑ If it fails → ai_data = {} → Bug 1 fires → 'Review'
# ↑ Markdown code blocks (```json...```) are NOT handled
Example of how Perplexity responds: "Based on available sources, I found information about {the deceased}. Here is the structured data: { \"status\": \"Found\", ...}". The regex picks up {the deceased} first → JSON parse fails → ai_data is empty → Review.

### Bug 3 — Status Key Lookup Missing Case Variants  [Line 286-293]
The prompt template (funeral_search_template.md) asks AI to return Status as a plain-text label like 'Found'. But the JSON parser only checks for lowercase 'status' and 'Status'. If the AI returns other variants, they are missed.
# CURRENT CODE — checked keys:
ai_data.get('status') or ai_data.get('Status')
# Missing: 'STATUS', 'match_status', 'Match Status', 'result', etc.
# Prompt template uses 'Status' label — AI sometimes returns the
# field name differently in JSON vs the template field name

### Bug 4 — Score Parser Extracts Wrong Key Names  [Line 296]
The prompt template explicitly labels the score field 'AI Accuracy Score'. But the parser checks several other key names and the score ends up as 0 when the key doesn't match exactly — which then provides no signal to override a bad status classification.
# CURRENT CODE  (Line 296)
score = ai_data.get('AI Accuracy Score') or ai_data.get('ai_accuracy_score')
or ai_data.get('confidence_score') or 0
# Missing: 'Accuracy Score', 'accuracy_score', 'score', 'Score'
# Also: score is never used to CORRECT a wrong status
# If score=90 but status parse failed → still saved as 'Review'


## 4.  Fixes Required — Funeral_Finder.py
Only 3 functions inside Funeral_Finder.py need to be modified. The rest of the file — file paths, CSV writing, Excel rebuilding, prompt building, argument parsing, main loop — all remain completely unchanged.

### Fix 4.1 — Replace _extract_json_from_text()
Replace the single-regex approach with a 3-strategy extractor that finds the largest valid JSON object, handles markdown code blocks, and falls back gracefully.
# ─── REPLACE ENTIRE _extract_json_from_text() with this ───
def _extract_json_from_text(text: str) -> dict:
"""Robust JSON extractor: tries 3 strategies, returns largest valid object."""
if not text:
return {}

# Strategy 1: Find the LARGEST valid JSON object (not just first)
best = {}
for match in re.finditer(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text, re.DOTALL):
try:
candidate = json.loads(match.group(0))
if len(candidate) > len(best):
best = candidate
except (json.JSONDecodeError, ValueError):
pass
if best:
return best

# Strategy 2: Extract between first { and last }
start = text.find('{')
end   = text.rfind('}')
if start != -1 and end != -1 and end > start:
try:
return json.loads(text[start:end + 1])
except (json.JSONDecodeError, ValueError):
pass

# Strategy 3: Markdown code blocks (```json ... ```)
for pattern in [r'```json\s*(.*?)```', r'```\s*(.*?)```']:
m = re.search(pattern, text, re.DOTALL)
if m:
try:
return json.loads(m.group(1).strip())
except (json.JSONDecodeError, ValueError):
pass
return {}

### Fix 4.2 — Fix parse_ai_response() Status & Score Logic
Two specific changes inside parse_ai_response():
- Expand status key lookup to cover all variants the AI might return
- Expand score key lookup to cover all variants
- Add logic: if score >= 75 and status resolved to 'Review', upgrade to 'Found'
- Add logic: if JSON parsed but no status key at all AND funeral data present → 'Review' not 'NotFound'

# ─── REPLACE lines 285–300 inside parse_ai_response() ───

# ── Status: check ALL possible key names AI might use ──
raw_status = _safe_str(
ai_data.get('status') or ai_data.get('Status') or
ai_data.get('STATUS') or ai_data.get('match_status') or
ai_data.get('Match Status') or ai_data.get('result') or ''
)
status_lower = raw_status.lower().strip()
if status_lower in ('found', 'matched', 'yes', 'confirmed'):
match_status = 'Found'
elif status_lower in ('notfound', 'not_found', 'not found',
'mismatched', 'no', 'none'):
match_status = 'NotFound'
elif status_lower in ('review', 'needs_review', 'needs review',
'uncertain', 'unverified'):
match_status = 'Review'
else:
# No status key found — infer from data presence
has_data = bool(
ai_data.get('funeral_home_name') or ai_data.get('Funeral home name (optional)')
or ai_data.get('funeral_date') or ai_data.get('Funeral date')
or ai_data.get('service_date')
)
match_status = 'Review' if has_data else 'NotFound'

# ── Score: check ALL possible key names ──
score = (
ai_data.get('AI Accuracy Score') or ai_data.get('ai_accuracy_score') or
ai_data.get('Accuracy Score')    or ai_data.get('accuracy_score')    or
ai_data.get('confidence_score')  or ai_data.get('Confidence Score')  or
ai_data.get('score')             or ai_data.get('Score')             or 0
)
try:
score = float(str(score).replace('%', '').strip())
except (ValueError, TypeError):
score = 0

# ── Score-based status correction ──
# If AI gave high confidence score but status resolution failed,
# trust the score and upgrade Review → Found
if match_status == 'Review' and score >= 75:
match_status = 'Found'


## 5.  Prompt Template Analysis — funeral_search_template.md
The prompt template file is read-only — do NOT modify it. It is only analyzed here to understand why the AI response key names differ from what the parser expects.
### Key Mismatch Between Template Output Format and Parser Expectations
The template asks the AI to return plain-text fields (not JSON). The AI then converts these to JSON itself, which causes key name inconsistency:
The fix in Section 4.2 resolves the Status and Score mismatch. All other fields are already handled correctly.


## 6.  New Script — reverify.py
This is a completely new file to be created at Scripts/reverify.py. It re-processes records that Funeral_Finder incorrectly classified. It does NOT modify Funeral_Finder.py in any way.
### Purpose
- Read Funeral_data_not_found.csv and Funeral_data_review.csv
- Re-query Perplexity AI using smarter, multi-strategy search queries per record
- For Found results: append to main Funeral_data.csv, remove from source file
- For Review results: update record in-place with better data found
- For NotFound results: update notes field, keep in source file
- Maintain reverify_logs.txt so records are not processed twice

### Multi-Strategy Query Logic
For each record, up to 6 query strategies are tried in order. Script stops at the first 'Found' result:

### File Routing Logic

### Usage
# Place file at: Scripts/reverify.py

python reverify.py                     # Process both not_found + review
python reverify.py --source not_found  # Only re-verify not_found records
python reverify.py --source review     # Only re-verify review records
python reverify.py --limit 10          # Test run — max 10 records
python reverify.py --force             # Ignore reverify_logs.txt

### Files Created by reverify.py


## 7.  Pipeline Integration
reverify.py fits between Stage 3 (Funeral_Finder) and Stage 4 (Updater) as an optional Stage 3.5. It is safe to run multiple times. The full recommended flow is:
When to run reverify.py: After Funeral_Finder completes, if not_found.csv or review.csv have records. Can be re-run safely — already-verified IDs are skipped via reverify_logs.txt.


## 8.  Implementation Checklist
### File 1: Scripts/Funeral_Finder.py
- Replace function _extract_json_from_text() (lines 95–103) with 3-strategy extractor
- Must handle: largest JSON object, first-to-last { }, markdown code blocks
- Replace status key lookup in parse_ai_response() (lines 285–293)
- Must check: status, Status, STATUS, match_status, Match Status, result
- Must handle: found/matched/yes/confirmed → Found
- Must handle: no status key → infer from data presence
- Replace score key lookup in parse_ai_response() (lines 296–300)
- Must check: AI Accuracy Score, ai_accuracy_score, accuracy_score, score, Score
- Add score-based status correction after score is parsed
- If match_status == 'Review' and score >= 75 → upgrade to 'Found'
- All other code in Funeral_Finder.py stays exactly as-is

### File 2: Scripts/reverify.py  (new file)
- Place file at Scripts/reverify.py (same folder as other pipeline scripts)
- Reads from .env in Scripts/ directory (same as Funeral_Finder)
- Supports --source, --force, --limit CLI arguments
- Implements multi-strategy query builder (6 strategies)
- Implements same robust JSON extractor as the fixed Funeral_Finder
- Routes results correctly: Found → main CSV, others → update in-place
- Maintains reverify_logs.txt for idempotency
- Does NOT modify any other script or config file

### Files NOT to Touch
- GetTask.py — no changes
- GetOrderInquiry.py — no changes
- Updater.py — no changes
- ClosingTask.py — no changes
- Scripts/prompts/funeral_search_template.md — no changes
- backend/server.js — no changes
- Any frontend src/ file — no changes
- Any config or docker file — no changes


BlossomTask  •  Internal Technical Document  •  April 2026
Touch only: Funeral_Finder.py (fixes) and reverify.py (new). No other file should be modified.
| File | Action Required |
| --- | --- |
| Scripts/Funeral_Finder.py | BUG FIXES in 3 specific functions — no structural changes |
| Scripts/reverify.py | NEW FILE — create this script from scratch |
| Scripts/prompts/funeral_search_template.md | READ ONLY — referenced to understand prompt format, do NOT edit |
| All other project files | DO NOT TOUCH — no changes needed |
| Function Name | Lines (approx) | Fix Required |
| --- | --- | --- |
| _extract_json_from_text() | 95–103 | Replace with robust multi-strategy extractor |
| parse_ai_response() | 281–326 | Fix status/score key lookup + add score-based status correction |
| [None — new function] | New | Add _normalize_status() helper for clean status resolution |
| Template Field Label | AI JSON Key (actual) | Parser Checks (current) |
| --- | --- | --- |
| Status: [Found/NotFound/Review] | 'Status' or 'status' | Only 'status', 'Status'  ❌ |
| AI Accuracy Score: | 'AI Accuracy Score' | Partially covered  ⚠️ |
| Funeral home name (optional): | 'Funeral home name (optional)' | Covered  ✅ |
| Funeral date: | 'Funeral date' or 'funeral_date' | Covered  ✅ |
| OPTIMAL DELIVERY DATE: | 'OPTIMAL DELIVERY DATE' | Covered  ✅ |
| Status Justification: | 'Status Justification' | Covered in notes  ✅ |
| Strategy | Query Built | When Useful |
| --- | --- | --- |
| original | obituary {name} {city} {state} | Baseline — same as Funeral_Finder |
| normalized_city | obituary {name} {Saint Louis} {state} | When city has St./Ft./Mt. abbreviations |
| expanded_name | obituary {Robert} {city} {state} | When name is a nickname (Bob→Robert) |
| state_only | {name} obituary {state} {year} | When city is wrong or rural area |
| care_of_funeral_home | {name} obituary "{FH Name}" {state} | When ship_care_of has funeral home name |
| ord_instruct | {name} funeral {instruction} {state} | When order instructions have location clues |
| New Status | Action on Main CSV | Action on Source File |
| --- | --- | --- |
| Found | Append record to Funeral_data.csv | Remove order_id from source |
| Review (from not_found) | No change | Remove from not_found, add to review |
| Review (from review) | No change | Update in-place with better data |
| NotFound (confirmed) | No change | Update notes in-place |
| File | Description |
| --- | --- |
| Scripts/outputs/Funeral_Finder/Funeral_data.csv | Found records appended here (main file) |
| Scripts/outputs/Funeral_Finder/Funeral_data_not_found.csv | Updated in-place (found records removed) |
| Scripts/outputs/Funeral_Finder/Funeral_data_review.csv | Updated in-place (found records removed) |
| Scripts/outputs/Funeral_Finder/reverify_logs.txt | NEW — tracks already-verified order IDs |
| Scripts/outputs/Funeral_Finder/reverify_payload.json | NEW — debug log of all re-queries |
| Stage | Script | Output |
| --- | --- | --- |
| 1 | GetTask.py | GetTask/data.csv |
| 2 | GetOrderInquiry.py | GetOrderInquiry/data.csv |
| 3 | Funeral_Finder.py  (fixed) | Funeral_data.csv + not_found + review |
| 3.5  (optional) | reverify.py  (new) | Moves found records to main CSV |
| 4 | Updater.py | CRM upload results |
| 5 | ClosingTask.py | Task closure |