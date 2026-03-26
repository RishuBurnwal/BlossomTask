# Funeral/Obituary Lookup System v2

An automated system for searching funeral and obituary information using AI and web search, with intelligent confidence-based routing to separate high-confidence matches from records requiring manual review.

## 📋 Project Overview

This system automates the process of finding funeral service details, obituary information, and related dates for deceased individuals. It:

1. **Reads funeral records** from CSV files (containing names, locations, and service info)
2. **Searches the web** using Perplexity AI for matching obituary and funeral service information
3. **Verifies matches** by comparing AI results with input data and checking URL credibility
4. **Calculates confidence scores** (0-100%) based on data completeness and URL verification
5. **Routes records** to appropriate output files based on confidence level:
   - **Main** (≥90% confidence + matched) → High-confidence verified matches
   - **Needs Review** (<90% confidence or mismatched data) → Requires manual verification
   - **Low Data** (sparse information + <95% confidence) → Incomplete results

## 🎯 Use Cases

- **Funeral Home Verification**: Verify obituary and service details for order processing
- **Genealogy Research**: Locate funeral service records and dates
- **Death Records Processing**: Automated lookup for deceased individual information
- **Batch Processing**: Process multiple funeral records efficiently with confidence-based sorting

## 🔧 Key Features

### 1. **Multi-Source Search**
- Searches priority funeral/obituary websites first (Legacy.com, Dignity Memorial, Find a Grave, etc.)
- Falls back to broad web search if priority sites don't have information
- Collects multiple sources for cross-verification

### 2. **Intelligent Confidence Scoring**
- AI-generated confidence scores (0-100%)
- Fallback calculation based on source URL count
- Capped at 35% for name mismatches (automatic downgrade)
- Score stored in Excel for visibility and sorting

### 3. **Automatic Name-Match Guard**
- Validates last name: must match exactly
- Validates first name: fuzzy matching (≥0.78 similarity ratio)
- Automatically downgrades mismatched records to "needs_review"

### 4. **Three-Way Output Routing**
- **MAIN**: Ready for use (≥90% accuracy + matched status)
- **NEEDS_REVIEW**: Manual review required (<90% accuracy or mismatched)
- **LOW_DATA**: Missing >5 critical fields + <95% accuracy

### 5. **Duplicate Prevention**
- Input dedupe: Collapses duplicate rows by order_id before processing
- Upsert logic: Reprocessing same order_id = update, not append
- Startup cleanup: Removes historical duplicates from output files
- Cross-file dedup: Record removed from opposite file when routing changes

### 6. **Multi-Format Output**
- **CSV** format for spreadsheet import/processing
- **JSONL** format for programmatic access (one JSON object per line)
- **XLSX** (Excel) format with:
  - Green highlight on matching URLs
  - Frozen header row
  - Auto-filter enabled
  - Accuracy percentage visible in column

## 📁 Project Structure

```
obituary_worker_v2/
├── README.md                           # This file
├── Funeral_Finder.py                   # Main processing engine
├── GetOrderInquiry.py                  # Order data fetching
├── GetTask.py                          # Task/row sourcing
├── requirements.txt                    # Python dependencies
├── .env                                # Configuration (API keys, paths)
├── .env.example                        # Example configuration
├── Dockerfile                          # Container build
├── prompts/
│   └── funeral_search_template.md      # AI instruction template
├── outputs/
│   ├── Funeral_data.csv                # Main output (CSV)
│   ├── Funeral_data.jsonl              # Main output (JSONL)
│   ├── Funeral_data.xlsx               # Main output (Excel)
│   ├── Funeral_data_needs_review.csv   # Review output (CSV)
│   ├── Funeral_data_needs_review.jsonl # Review output (JSONL)
│   ├── Funeral_data_needs_review.xlsx  # Review output (Excel)
│   ├── Funeral_data_low_data.csv       # Low-data output (CSV)
│   ├── Funeral_data_low_data.jsonl     # Low-data output (JSONL)
│   └── Funeral_data_low_data.xlsx      # Low-data output (Excel)
├── SOLUTION_SUMMARY.md                 # High-accuracy routing fixes
├── FIXES_SUMMARY.md                    # Technical change documentation
├── test_high_accuracy.py               # Routing logic unit tests
├── excel_preview.py                    # Example output visualization
└── __pycache__/                        # Cached bytecode (auto-generated)
```

## 🚀 Getting Started

### Prerequisites
- Python 3.8 or higher
- Perplexity API key (for web search)
- Input CSV file with order/funeral data

### Installation

```bash
# 1. Clone or download the project
cd obituary_worker_v2

# 2. Create virtual environment
python -m venv .venv
source .venv/bin/activate          # macOS/Linux
# or
.venv\Scripts\activate             # Windows PowerShell

# 3. Install dependencies
pip install -r requirements.txt

# 4. Configure environment
cp .env.example .env
# Edit .env and add your API keys
```

### Configuration (.env file)

```
# API Keys (REQUIRED)
PERPLEXITY_API_KEY=your-perplexity-key-here

# Input/Output Paths
INPUT_CSV_PATH=./inputs/orders.csv
INPUT_CSV_ENCODING=utf-8

# Main Output (High Confidence)
FUNERAL_OUTPUT_CSV=outputs/Funeral_data.csv
FUNERAL_OUTPUT_JSONL=outputs/Funeral_data.jsonl
FUNERAL_OUTPUT_XLSX=outputs/Funeral_data.xlsx

# Review Output (Low Confidence / Mismatched)
FUNERAL_REVIEW_OUTPUT_CSV=outputs/Funeral_data_needs_review.csv
FUNERAL_REVIEW_OUTPUT_JSONL=outputs/Funeral_data_needs_review.jsonl
FUNERAL_REVIEW_OUTPUT_XLSX=outputs/Funeral_data_needs_review.xlsx

# Low-Data Output (Sparse Information)
FUNERAL_LOW_DATA_OUTPUT_CSV=outputs/Funeral_data_low_data.csv
FUNERAL_LOW_DATA_OUTPUT_JSONL=outputs/Funeral_data_low_data.jsonl
FUNERAL_LOW_DATA_OUTPUT_XLSX=outputs/Funeral_data_low_data.xlsx

# Thresholds
MAIN_PASS_MIN_ACCURACY=90              # Minimum accuracy for MAIN output
LOW_DATA_MAX_ACCURACY=50               # Low-data detection threshold
```

## 💻 How to Run

### Option 1: Manual Single Run
```bash
python Funeral_Finder.py
```

### Option 2: Interactive Mode (Review Each Record)
```bash
python Funeral_Finder.py
# When prompted, select mode "2" for interactive review
```

### Option 3: Batch Processing
```bash
# Process all rows non-interactively
python Funeral_Finder.py
# Select mode "1" for automatic batch processing
```

### Option 4: Test High-Accuracy Routing
```bash
python test_high_accuracy.py
# Runs 8 verification tests on routing logic
```

### Option 5: Preview Excel Output Format
```bash
python excel_preview.py
# Shows what data will appear in Excel files
```

## 📊 Input CSV Format

Your input CSV should contain:
```
ord_id,ship_name,ship_city,ship_state,ship_zip,ship_phone_day,ship_care_of,ord_occasion,ord_Message,ord_Instruct
123456,John Doe,Los Angeles,CA,90001,323-555-0001,Smith Funeral Home,Death,Funeral on Friday,Service at 10am
234567,Jane Smith,Denver,CO,80202,303-555-0002,,Death,Saturday viewing,,
```

**Key Columns**:
- `ord_id`: Unique order identifier
- `ship_name`: Deceased person's name
- `ship_city`, `ship_state`, `ship_zip`: Location information
- `ship_phone_day`: Contact phone
- `ship_care_of`: Associated funeral home or business
- `ord_occasion`: Event type (usually "Death")
- `ord_Message`: Task notes/details
- `ord_Instruct`: Task instructions (NOT sent to AI for search)

## 📤 Output Format

### Main Output Columns (CSV/Excel)
```
ord_id                          Order ID
ship_name                       Input deceased name
ship_city                       Input city
pplx_first_name                 AI-found first name
pplx_last_name                  AI-found last name
pplx_city                       AI-found city
pplx_state                      AI-found state
pplx_zip                        AI-found ZIP
pplx_funeral_home_name          AI-found funeral home
pplx_phone_number               AI-found phone
pplx_funeral_date               AI-found funeral date (YYYY-MM-DD)
pplx_funeral_time               AI-found funeral time (HH:MM)
pplx_ai_accuracy_percent        Confidence score (0-100) ← NEW!
pplx_status                     Status (matched/mismatched/needs_review)
pplx_notes                      Summary notes from AI
pplx_source_urls                URLs where data was found
processed_at_utc                Processing timestamp
pplx_status                     Perplexity status (matched/needs_review/unmatched)
perplexity_status               Duplicate of Perplexity status for convenience

Note: All records now write to a single consolidated output file; separate needs-review/low-data files are no longer produced.
```

### Routing Decision Rules

| Condition | Destination |
|-----------|-------------|
| Status=matched AND Accuracy≥90% | **MAIN** ✅ |
| Status=matched AND Accuracy<90% | NEEDS_REVIEW ⚠️ |
| Status=mismatched | NEEDS_REVIEW ⚠️ |
| Status=needs_review | NEEDS_REVIEW ⚠️ |
| Missing >5 fields AND Accuracy<95% | LOW_DATA 📋 |

## 🔍 Processing Workflow

```
┌─────────────────┐
│   Input CSV     │
│   (orders)      │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  1. Dedupe by ord_id                │
│     (collapse duplicates)           │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  2. Build search context            │
│     (name, location, dates)         │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  3. Call Perplexity API             │
│     (web search + AI extraction)    │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  4. Name Match Guard                │
│     (validate last + first name)    │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  5. Calculate Confidence Score      │
│     (0-100% accuracy)               │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  6. Classify Route                  │
│     (main/needs_review/low_data)    │
└────────┬────────────────────────────┘
         │
         ├─────────────┬──────────────┬──────────────┐
         │             │              │              │
         ▼             ▼              ▼              ▼
    ┌────────┐  ┌────────────┐  ┌──────────┐  ┌────────┐
    │  MAIN  │  │NEEDS_REVIEW│  │LOW_DATA  │  │  LOG   │
    │ (High  │  │(Low or     │  │(Sparse)  │  │(Track) │
    │Confid.)│  │Mismatched) │  │          │  │        │
    └────────┘  └────────────┘  └──────────┘  └────────┘
```

## 🎯 Output Routing Examples

### Example 1: High Confidence Match ✅
```
Status: matched
Accuracy: 95%
Route: MAIN
├─ Output File: Funeral_data.csv
├─ Excel Column: pplx_ai_accuracy_percent = 95
└─ Ready for use
```

### Example 2: Low Confidence Match ⚠️
```
Status: matched
Accuracy: 75%
Route: NEEDS_REVIEW
├─ Output File: Funeral_data_needs_review.csv
├─ Notes: "Phone number mismatch"
└─ Requires manual review
```

### Example 3: Name Mismatch 🔴
```
Status: mismatched
Accuracy: 35% (capped due to name mismatch)
Route: NEEDS_REVIEW
├─ Output File: Funeral_data_needs_review.csv
├─ Notes: "First name mismatch: Bob vs Robert"
└─ High confidence but wrong person
```

### Example 4: Sparse Data 📋
```
Status: matched
Accuracy: 50%
Missing Fields: 4
Route: LOW_DATA
├─ Output File: Funeral_data_low_data.csv
├─ Issue: "Only found funeral date, missing time/location"
└─ Incomplete but useful information
```

## 🧪 Testing

### Unit Tests
```bash
# Test high-accuracy routing logic
python test_high_accuracy.py

# Expected output: ✓ All 8 tests passed
```

### Configuration Verification
Make sure to test your setup:
1. Verify API keys work
2. Verify input CSV exists and is readable
3. Verify output directory is writable
4. Process a single test row before batch processing

## ⚙️ Key Constants

```python
MAIN_PASS_MIN_ACCURACY = 90        # Min accuracy for MAIN file
LOW_DATA_MAX_ACCURACY = 50         # Threshold for low-data detection
NAME_MATCH_FUZZY_RATIO = 0.78      # First-name similarity threshold
MISMATCHED_MAX_ACCURACY = 35       # Cap if name doesn't match
```

## 📋 Thresholds & Rules

| Rule | Behavior |
|------|----------|
| Last Name Match | Must be exact match |
| First Name Match | SequenceMatcher ratio ≥0.78 |
| Accuracy Score | Calculated from data completeness + confirmation |
| ≥90% + Matched | Routes to MAIN output |
| <90% or Mismatched | Routes to NEEDS_REVIEW |
| >5 Missing + <95% | Routes to LOW_DATA |
| High Score Override | 95%+ always goes to MAIN, regardless of missing fields |

## 🐛 Troubleshooting

### Issue: "All records going to needs_review"
**Cause**: Low confidence scores or missed matches
**Solution**: Check Perplexity API results manually; verify input data accuracy

### Issue: "Missing records/no output"
**Cause**: Input CSV encoding or path issues
**Solution**: Verify INPUT_CSV_PATH in .env; check encoding matches

### Issue: "Excel file not generated"
**Cause**: openpyxl library missing
**Solution**: `pip install openpyxl`

### Issue: "API rate limit errors"
**Cause**: Too many requests to Perplexity
**Solution**: Add delays between requests or batch smaller sets

### Issue: "High accuracy scores still in needs_review"
**Fixed in v2.0.1**: Updated routing logic to respect 90%+ accuracy
- Now: 90%+ goes to MAIN
- Score visible in Excel: `pplx_ai_accuracy_percent` column

## 📝 Recent Updates (v2.0.1)

✅ **Added**: Accuracy score exported to Excel (`pplx_ai_accuracy_percent`)
✅ **Fixed**: 90%+ accuracy records now route to MAIN (not needs_review)
✅ **Fixed**: 95%+ accuracy bypasses missing-field penalties
✅ **Improved**: Console output shows [status | accuracy] → FILE routing
✅ **Added**: Test suite for routing logic verification (8/8 tests passing)

See [SOLUTION_SUMMARY.md](SOLUTION_SUMMARY.md) for detailed fix documentation.

## 📚 Documentation Files

- **SOLUTION_SUMMARY.md** - High-accuracy routing fixes and improvements
- **FIXES_SUMMARY.md** - Technical change documentation
- **test_high_accuracy.py** - Routing logic verification tests
- **excel_preview.py** - Preview of Excel output format

## 🤝 Contributing

When making changes:
1. Test with `python test_high_accuracy.py`
2. Verify compilation: `py -m py_compile Funeral_Finder.py`
3. Document changes in comments
4. Update README if adding new features

## 📞 Support

For issues or questions:
1. Check the troubleshooting section
2. Review SOLUTION_SUMMARY.md for recent fixes
3. Verify .env configuration matches requirements
4. Run test files to validate routing logic

## 📄 License

[Add your license here]

---

**Last Updated**: March 26, 2026
**Version**: 2.0.1 (High-accuracy routing fixes, Excel score export)
- needs_review
- missing `ord_ID`
- API failure
- ambiguous result

## Security
The Perplexity key previously pasted in chat should be treated as exposed. Replace it before deployment.
