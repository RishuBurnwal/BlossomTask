import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "Scripts"))

import Updater  # noqa: N813


class UpdaterPayloadTests(unittest.TestCase):
    def test_choose_service_datetime_uses_visitation_when_service_missing(self):
        order = {
            "service_date": "",
            "service_time": "",
            "visitation_date": "2026-04-20",
            "visitation_time": "11:00 AM",
            "delivery_recommendation_date": "2026-04-21",
            "delivery_recommendation_time": "09:00 AM",
        }
        date_value, time_value, source = Updater._choose_service_datetime(order)
        self.assertEqual(date_value, "2026-04-20")
        self.assertEqual(time_value, "11:00 AM")
        self.assertEqual(source, "visitation")

    def test_build_payload_includes_notes_and_sources_in_trtext(self):
        order = {
            "order_id": "1001",
            "match_status": "Found",
            "service_date": "",
            "service_time": "",
            "visitation_date": "2026-04-20",
            "visitation_time": "11:00 AM",
            "delivery_recommendation_date": "",
            "delivery_recommendation_time": "",
            "ship_name": "John Doe",
            "funeral_home_name": "ABC Home",
            "notes": "verified obituary",
            "source_urls": "https://example.com/obit | https://example.com/fh",
            "special_instructions": "Ring bell",
            "delivery_recommendation_location": "Main Hall",
        }

        payload = Updater.build_payload(order)

        self.assertEqual(payload["trEndDate"], "2026-04-20 11:00 AM")
        self.assertIn("Notes: verified obituary", payload["trText"])
        self.assertIn("Sources: https://example.com/obit | https://example.com/fh", payload["trText"])
        self.assertIn("Service datetime fallback used: visitation", payload["trText"])

    def test_build_payload_does_not_use_delivery_datetime_when_service_and_visitation_missing(self):
        order = {
            "order_id": "1002",
            "match_status": "Found",
            "service_date": "",
            "service_time": "",
            "visitation_date": "",
            "visitation_time": "",
            "delivery_recommendation_date": "2026-04-22",
            "delivery_recommendation_time": "02:15 PM",
            "ship_name": "Jane Doe",
            "notes": "delivery fallback",
            "source_urls": "https://example.com/delivery",
        }

        payload = Updater.build_payload(order)

        self.assertEqual(payload["trEndDate"], "")
        self.assertEqual(payload["trResult"], "NotFound")
        self.assertIn("Deliver By: 2026-04-22 02:15 PM", payload["trText"])
        self.assertIn("Sources: https://example.com/delivery", payload["trText"])

    def test_build_payload_uses_ceremony_datetime_when_available(self):
        order = {
            "order_id": "1003",
            "match_status": "Found",
            "service_date": "",
            "service_time": "",
            "visitation_date": "",
            "visitation_time": "",
            "ceremony_date": "2026-04-23",
            "ceremony_time": "01:30 PM",
            "delivery_recommendation_date": "2026-04-22",
            "delivery_recommendation_time": "02:15 PM",
            "ship_name": "Ceremony Doe",
            "source_urls": "https://example.com/ceremony",
        }

        payload = Updater.build_payload(order)

        self.assertEqual(payload["trEndDate"], "2026-04-23 01:30 PM")
        self.assertEqual(payload["trResult"], "Found")
        self.assertIn("Service datetime fallback used: ceremony", payload["trText"])


if __name__ == "__main__":
    unittest.main()
