import csv
import json
import random
from pathlib import Path

import requests

import Funeral_Finder as ff

PERPLEXITY_MODEL = ff.os.getenv("PERPLEXITY_MODEL", "sonar-pro")


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = Path(__file__).resolve().parent
INPUT_CSV = SCRIPTS_DIR / "outputs" / "GetOrderInquiry" / "data.csv"
OUTPUT_JSON = SCRIPTS_DIR / "outputs" / "Funeral_Finder" / "random_check_5.json"


def load_orders() -> list[dict]:
    if not INPUT_CSV.exists():
        raise FileNotFoundError(f"Input CSV not found: {INPUT_CSV}")

    seen = set()
    rows: list[dict] = []
    with open(INPUT_CSV, "r", newline="", encoding="utf-8") as file_handle:
        reader = csv.DictReader(file_handle)
        for row in reader:
            order_id = ff._safe_str(row.get("order_id"))
            if not order_id or order_id in seen:
                continue
            seen.add(order_id)
            rows.append(
                {
                    "order_id": order_id,
                    "task_id": ff._safe_str(row.get("task_id")),
                    "ship_name": ff._safe_str(row.get("ship_name")),
                    "ship_city": ff._safe_str(row.get("ship_city")),
                    "ship_state": ff._safe_str(row.get("ship_state")),
                    "ship_zip": ff._safe_str(row.get("ship_zip")),
                    "ship_care_of": ff._safe_str(row.get("ship_care_of")),
                    "ship_address": ff._safe_str(row.get("ship_address")),
                    "ship_address_unit": ff._safe_str(row.get("ship_address_unit")),
                    "ship_country": ff._safe_str(row.get("ship_country")),
                    "ord_instruct": ff._safe_str(row.get("ord_instruct")),
                }
            )
    return rows


def load_template() -> str:
    template_path = Path(ff.os.getenv("FUNERAL_PROMPT_TEMPLATE", str(ff.DEFAULT_PROMPT_TEMPLATE)))
    if template_path.exists():
        return template_path.read_text(encoding="utf-8")
    return ""


def run() -> None:
    ff.load_dotenv_file()
    api_key = ff._required_env("PERPLEXITY_API_KEY")
    template = load_template()

    all_orders = load_orders()
    if len(all_orders) < 5:
        raise RuntimeError(f"Need at least 5 rows, found {len(all_orders)}")

    sampled = random.sample(all_orders, 5)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    results = []

    print("\\nRunning 5 random obituary searches (one-by-one):")
    for idx, order in enumerate(sampled, start=1):
        print(f"\\n[{idx}/5] order_id={order['order_id']} name={order['ship_name']} city={order['ship_city']}, {order['ship_state']}")
        prompt = ff.build_prompt(order, template)
        payload = {
            "model": PERPLEXITY_MODEL,
            "messages": [
                {"role": "system", "content": ff.SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
        }

        entry = {
            "row": order,
            "request": {"model": PERPLEXITY_MODEL},
        }

        try:
            response = requests.post(
                ff.PERPLEXITY_URL,
                headers=headers,
                json=payload,
                timeout=ff.TIMEOUT_SECONDS,
            )
            entry["http_status"] = response.status_code
            if response.status_code >= 400:
                entry["error"] = response.text[:800]
                print(f"  API error: {response.status_code}")
            else:
                resp_json = response.json()
                ai_text = resp_json.get("choices", [{}])[0].get("message", {}).get("content", "")
                parsed = ff.parse_ai_response(ai_text)
                merged_urls = ff._normalize_url_list(parsed.get("source_urls"), ff._collect_response_urls(resp_json, ai_text))
                if merged_urls:
                    parsed["source_urls"] = " | ".join(merged_urls)
                final = ff._apply_business_rules(order, parsed)
                entry["result"] = {
                    "match_status": final.get("match_status"),
                    "ai_accuracy_score": final.get("ai_accuracy_score"),
                    "matched_name": final.get("matched_name"),
                    "funeral_home_name": final.get("funeral_home_name"),
                    "service_date": final.get("service_date"),
                    "service_time": final.get("service_time"),
                    "visitation_date": final.get("visitation_date"),
                    "visitation_time": final.get("visitation_time"),
                    "source_urls": final.get("source_urls"),
                    "notes": final.get("notes"),
                    "name_match_status": final.get("name_match_status"),
                    "date_verification_status": final.get("date_verification_status"),
                }
                print(
                    f"  -> {final.get('match_status')} | score={final.get('ai_accuracy_score')} | "
                    f"home={ff._safe_str(final.get('funeral_home_name'))[:50]}"
                )
        except Exception as exc:  # noqa: BLE001
            entry["error"] = str(exc)
            print(f"  Request error: {exc}")

        results.append(entry)

    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_JSON.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")

    print("\\nCompleted random 5-row run.")
    print(f"Saved: {OUTPUT_JSON}")


if __name__ == "__main__":
    run()
