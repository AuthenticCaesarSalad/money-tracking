import base64
import unittest

from api.invoice import ApiError, decode_image, extract_json, normalize_expense


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


if __name__ == "__main__":
    unittest.main()
