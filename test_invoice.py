import base64
import unittest
from datetime import UTC, date, datetime, timedelta, timezone
from unittest.mock import patch

from api.invoice import (
    ApiError,
    decode_image,
    extract_json,
    normalize_expense,
    normalize_receipt_date,
)


class InvoiceApiTests(unittest.TestCase):
    def test_decodes_valid_jpeg_data_url(self):
        image = b"\xff\xd8\xffinvoice"
        data_url = "data:image/jpeg;base64," + base64.b64encode(image).decode()
        self.assertEqual(decode_image(data_url), (image, "image/jpeg"))

    def test_rejects_mismatched_image_signature(self):
        data_url = "data:image/png;base64," + base64.b64encode(b"not-png").decode()
        with self.assertRaises(ApiError):
            decode_image(data_url)

    def test_extracts_fenced_json(self):
        self.assertEqual(extract_json('```json\n{"valid": true}\n```'), {"valid": True})

    def test_normalizes_expense(self):
        result = normalize_expense(
            {
                "valid": True,
                "amount": 12500.4,
                "category": "Makanan",
                "transaction_date": "2026-10-30",
                "description": "  Toko   Bayu  ",
            }
        )
        self.assertEqual(result["amount"], 12500)
        self.assertEqual(result["description"], "Toko Bayu")
        self.assertEqual(result["type"], "expense")

    def test_normalizes_receipt_date_formats(self):
        cases = {
            "2024-08-17": "2024-08-17",
            "2024-08-17T14:30:00+07:00": "2024-08-17",
            "17/08/2024": "2024-08-17",
            "17-08-24": "2024-08-17",
            "17.08.2024": "2024-08-17",
            "5/4/2024": "2024-04-05",
            "17 Agustus 2024": "2024-08-17",
            "17 Agt 24": "2024-08-17",
            "Oktober 30, 2024": "2024-10-30",
            "30 December 2024": "2024-12-30",
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(normalize_receipt_date(value, date(2026, 10, 30)), expected)

    def test_normalizes_leap_day(self):
        self.assertEqual(
            normalize_receipt_date("29/02/2024", date(2026, 10, 30)),
            "2024-02-29",
        )

    def test_rejects_malformed_iso_tails(self):
        values = (
            "2024-08-17Tnot-a-time",
            "2024-08-17T99:99:99",
            "2024-08-17 due 2024-09-01",
            "2024-08-17T",
            "2024-08-17T14:60:00",
            "2024-08-17T14:30:60",
            "2024-08-17T14:30:00+99:00",
            "2024-08-17T14:30:00Z trailing text",
        )
        for value in values:
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_receipt_date(value, date(2024, 8, 17))

    def test_normalizes_complete_iso_timestamps_without_converting_date(self):
        values = (
            "2024-08-17T14:30:00",
            "2024-08-17t14:30:00",
            "2024-08-17 14:30:00",
            "2024-08-17T14:30:00Z",
            "2024-08-17T14:30:00.123456Z",
            "2024-08-17T00:30:00+14:00",
            "2024-08-17T23:30:00-07:00",
        )
        for value in values:
            with self.subTest(value=value):
                self.assertEqual(normalize_receipt_date(value, date(2024, 8, 17)), "2024-08-17")

    def test_maps_two_digit_year_boundary(self):
        for year, expected_year in (("00", 2000), ("68", 2068), ("69", 1969), ("99", 1999)):
            for value in (f"17/08/{year}", f"17 Agustus {year}"):
                with self.subTest(value=value):
                    self.assertEqual(
                        normalize_receipt_date(value, date(2068, 8, 17)),
                        f"{expected_year}-08-17",
                    )
        for value in ("17/08/68", "17 Agustus 68"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_receipt_date(value, date(2026, 10, 30))

    def test_default_today_rolls_over_at_wib_midnight(self):
        cases = (
            (datetime(2024, 8, 16, 16, 59, 59, tzinfo=UTC), "2024-08-16", "2024-08-17"),
            (datetime(2024, 8, 16, 17, 0, 0, tzinfo=UTC), "2024-08-17", "2024-08-18"),
        )
        for instant, today, tomorrow in cases:
            with self.subTest(instant=instant), patch("api.invoice.datetime", wraps=datetime) as clock:
                clock.now.side_effect = lambda tz, instant=instant: instant.astimezone(tz)
                self.assertEqual(normalize_receipt_date(today), today)
                with self.assertRaises(ValueError):
                    normalize_receipt_date(tomorrow)
                clock.now.assert_called_with(timezone(timedelta(hours=7)))

    def test_rejects_invalid_or_future_receipt_dates(self):
        values = (
            "31/02/2024",
            "29/02/2023",
            "2023-02-29T14:30:00Z",
            "2026-10-31",
            "2026-10-31T00:00:00+14:00",
            "",
            None,
            "unknown",
            "12 Foo 2024",
            "17/08",
            "17 Agustus",
            "2024-08",
        )
        for value in values:
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_receipt_date(value, date(2026, 10, 30))


if __name__ == "__main__":
    unittest.main()
