import base64
import unittest
from datetime import date

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

    def test_rejects_invalid_or_future_receipt_dates(self):
        values = (
            "31/02/2024",
            "29/02/2023",
            "2026-10-31",
            "",
            None,
            "unknown",
            "12 Foo 2024",
        )
        for value in values:
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_receipt_date(value, date(2026, 10, 30))


if __name__ == "__main__":
    unittest.main()
