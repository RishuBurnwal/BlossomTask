from __future__ import annotations

import json
import sys
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import Funeral_Finder as finder  # noqa: E402


def _base_order(**overrides):
    base = {
        "ship_name": "Betty Lou Woodfield",
        "ship_city": "Okmulgee",
        "ship_state": "OK",
        "ship_zip": "74447",
        "ship_care_of": "McClendon-Winters Funeral Home",
        "ship_address": "303 E 7th St",
        "ord_instruct": "",
    }
    base.update(overrides)
    return base


def _base_parsed(**overrides):
    base = {
        "matched_name": "",
        "funeral_home_name": "",
        "funeral_address": "",
        "funeral_phone": "",
        "service_type": "",
        "service_date": "",
        "service_time": "",
        "visitation_date": "",
        "visitation_time": "",
        "ceremony_date": "",
        "ceremony_time": "",
        "delivery_recommendation_date": "",
        "delivery_recommendation_time": "",
        "delivery_recommendation_location": "",
        "special_instructions": "",
        "name_match_status": "",
        "date_verification_status": "",
        "date_verification_notes": "",
        "match_status": "Review",
        "ai_accuracy_score": 60.0,
        "source_urls": "",
        "notes": "",
    }
    base.update(overrides)
    return base


def test_parse_ai_response_keeps_exact_url_with_fragment():
    payload = {
        "matched_name": "Betty Lou Woodfield",
        "status": "Found",
        "service_date": "2026-04-16",
        "service_time": "11:00 AM",
        "source_urls": [
            "https://mcclendon-winters.com/obituaries/betty-woodfield/#/TributeWall"
        ],
    }

    parsed = finder.parse_ai_response(json.dumps(payload))

    assert "https://mcclendon-winters.com/obituaries/betty-woodfield/#/TributeWall" in parsed["source_urls"]


def test_parse_ai_response_accepts_www_url_without_scheme():
    payload = {
        "matched_name": "Amy Nagy",
        "status": "Found",
        "service_date": "2026-04-23",
        "service_time": "6:00 PM",
        "source_urls": [
            "www.legacy.com/us/obituaries/butlereagle/name/amy-nagy-obituary?id=61296576"
        ],
    }

    parsed = finder.parse_ai_response(json.dumps(payload))

    assert "https://www.legacy.com/us/obituaries/butlereagle/name/amy-nagy-obituary?id=61296576" in parsed["source_urls"]


def test_apply_business_rules_marks_found_for_fuzzy_name_with_url_and_datetime():
    order = _base_order(ship_name="Lou Alliano")
    parsed = _base_parsed(
        matched_name="Louis John Alliano",
        funeral_home_name="Thompson Funeral Chappel",
        service_date="2026-04-24",
        service_time="10:00 AM",
        source_urls="https://dignitymemorial.com/obituaries/goodyear-az/louis-alliano-12812070",
        match_status="Review",
    )

    adjusted = finder._apply_business_rules(order, parsed)

    assert adjusted["match_status"] == "Found"
    assert adjusted["name_match_status"] in {"minor", "fuzzy", "exact"}


def test_apply_business_rules_notfound_only_when_no_evidence_exists():
    order = _base_order(ship_care_of="", ship_address="")
    parsed = _base_parsed(match_status="NotFound")

    adjusted = finder._apply_business_rules(order, parsed)

    assert adjusted["match_status"] == "NotFound"


def test_apply_business_rules_review_when_name_mismatch_with_some_evidence():
    order = _base_order(ship_name="Timothy Fisher")
    parsed = _base_parsed(
        matched_name="Michael Johnson",
        source_urls="https://example.com/obituaries/michael-johnson",
        service_date="2026-04-14",
        match_status="Found",
    )

    adjusted = finder._apply_business_rules(order, parsed)

    assert adjusted["match_status"] == "Review"


def test_apply_business_rules_marks_customer_when_only_order_instructions_confirm_schedule():
    order = _base_order(
        ship_name="Betty Lou Woodfield",
        ship_care_of="",
        ship_address="",
        ord_instruct="Funeral service on May 2 at 11:00 AM",
    )
    parsed = _base_parsed(
        matched_name="Betty Lou Woodfield",
        match_status="Review",
        source_urls="",
    )

    adjusted = finder._apply_business_rules(order, parsed)

    assert adjusted["match_status"] == "Customer"
    assert "Customer:" in adjusted["notes"]


def test_apply_business_rules_formats_customer_instruction_schedule_fields():
    expected_year = finder.get_now_iso()[:4]
    order = _base_order(
        ship_name="Betty Lou Woodfield",
        ship_care_of="",
        ship_address="",
        ord_instruct="Viewing on May 2 at 11:00 AM at the chapel",
    )
    parsed = _base_parsed(
        matched_name="",
        match_status="NotFound",
        source_urls="",
        special_instructions="",
    )

    adjusted = finder._apply_business_rules(order, parsed)

    assert adjusted["match_status"] == "Customer"
    assert adjusted["visitation_date"] == f"{expected_year}-05-02"
    assert adjusted["visitation_time"] == "11:00 AM"
    assert "customer instructions" in adjusted["special_instructions"].lower()


def test_normalize_order_id_trims_float_suffix():
    assert finder._normalize_order_id("5454134.0") == "5454134"


def test_build_prompt_replaces_insert_row_content_marker():
    order = {
        "ship_name": "Dale Boyce",
        "ship_city": "Odessa",
        "ship_state": "ON",
        "ship_zip": "K0H2H0",
        "ship_care_of": "Payne Funeral Home",
        "ship_address": "",
        "ship_address_unit": "",
        "ship_country": "USA",
        "ord_instruct": "",
    }
    template = "Header\n[INSERT ROW/CONTENT]\nFooter"

    prompt = finder.build_prompt(order, template)

    assert "[INSERT ROW/CONTENT]" not in prompt
    assert "Name: Dale Boyce" in prompt
