import base64
import io
import json
import unittest
from datetime import UTC, date, datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

from api.invoice import (
    MAX_BODY_BYTES,
    PARSER_MODEL,
    VISION_MODEL,
    ApiError,
    NoReceiptRedirect,
    analyze_invoice,
    decode_image,
    extract_json,
    handler,
    normalize_expense,
    normalize_receipt_date,
    save_image,
    view_receipt,
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


class ReceiptViewTests(unittest.TestCase):
    origin = "https://example.supabase.co"
    user_id = "12345678-1234-4234-8234-123456789abc"
    other_id = "87654321-4321-4321-8321-cba987654321"
    transaction_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    object_path = f"{user_id}/20261102T023000Z-{'a' * 32}.jpg"
    signing_path = f"/storage/v1/object/sign/invoice-images/{object_path}"
    token = "signed.token-123"

    def setUp(self):
        environment = patch.dict("os.environ", {
            "SUPABASE_URL": self.origin,
            "SUPABASE_SERVICE_ROLE_KEY": "server-only-key",
        })
        environment.start()
        self.addCleanup(environment.stop)
        network = patch("api.invoice.receipt_urlopen")
        self.urlopen = network.start()
        self.addCleanup(network.stop)
        self.payload = {
            "action": "view_receipt", "transaction_id": self.transaction_id,
            "username": "Bayu", "password": "  exact password  ",
        }

    def response(self, data):
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = json.dumps(data).encode()
        return response

    def responses(self, *data):
        self.urlopen.reset_mock()
        self.urlopen.side_effect = [self.response(value) for value in data]

    def test_owned_receipt_uses_verified_credentials_and_60_second_signing(self):
        self.responses(
            [{"id": self.user_id.upper(), "username": "Bayu"}],
            [{"receipt_path": self.object_path}],
            {"signedURL": self.signing_path.removeprefix("/storage/v1") + f"?token={self.token}"},
        )
        payload = {**self.payload, "transaction_id": self.transaction_id.upper()}
        result = view_receipt(payload)
        self.assertEqual(result, {
            "signed_url": self.origin + self.signing_path + f"?token={self.token}",
            "expires_in": 60,
        })
        requests = [call.args[0] for call in self.urlopen.call_args_list]
        self.assertEqual(len(requests), 3)
        login, lookup, signing = requests
        self.assertEqual(login.full_url, self.origin + "/rest/v1/rpc/login_user")
        self.assertEqual(login.get_method(), "POST")
        self.assertEqual(json.loads(login.data), {
            "p_username": "Bayu", "p_password": self.payload["password"],
        })
        self.assertEqual(lookup.get_method(), "GET")
        self.assertIsNone(lookup.data)
        self.assertEqual(urlsplit(lookup.full_url).path, "/rest/v1/transactions")
        self.assertEqual(parse_qs(urlsplit(lookup.full_url).query), {
            "select": ["receipt_path"], "id": [f"eq.{self.transaction_id}"],
            "user_id": [f"eq.{self.user_id}"], "limit": ["1"],
        })
        self.assertEqual(signing.full_url, self.origin + self.signing_path)
        self.assertEqual(signing.get_method(), "POST")
        self.assertEqual(json.loads(signing.data), {"expiresIn": 60})
        for request in requests:
            self.assertEqual(request.get_header("Authorization"), "Bearer server-only-key")
            self.assertEqual(request.get_header("Apikey"), "server-only-key")
            self.assertEqual(request.get_header("Content-type"), "application/json")
            self.assertEqual(request.get_header("Accept"), "application/json")
        for call in self.urlopen.call_args_list:
            self.assertEqual(call.kwargs, {"timeout": 25})

    def test_supports_supabase_signed_url_keys_formats_and_scanner_extensions(self):
        for extension in ("jpg", "png", "webp"):
            object_path = self.object_path.rsplit(".", 1)[0] + "." + extension
            signing_path = f"/storage/v1/object/sign/invoice-images/{object_path}"
            for key in ("signedURL", "signedUrl"):
                for prefix in ("", self.origin, "short"):
                    with self.subTest(extension=extension, key=key, prefix=prefix):
                        path = signing_path.removeprefix("/storage/v1") if prefix == "short" else prefix + signing_path
                        self.responses(
                            [{"id": self.user_id}], [{"receipt_path": object_path}],
                            {key: path + f"?token={self.token}"},
                        )
                        self.assertEqual(view_receipt(self.payload)["signed_url"], self.origin + signing_path + f"?token={self.token}")

    def test_wrong_credentials_stop_before_lookup_or_signing(self):
        self.responses([])
        with self.assertRaises(ApiError) as caught:
            view_receipt(self.payload)
        self.assertEqual(caught.exception.status, 401)
        self.assertEqual(str(caught.exception), "Nama pengguna atau kata sandi salah.")
        self.assertEqual(self.urlopen.call_count, 1)

    def test_rejects_forged_localstorage_id_and_all_client_paths_early(self):
        for key, value in (("user_id", self.other_id), ("userId", self.user_id),
                           ("path", self.object_path), ("receipt_path", self.object_path),
                           ("bucket", "invoice-images"), ("image", "ignored")):
            with self.subTest(key=key), self.assertRaises(ApiError) as caught:
                view_receipt({**self.payload, key: value})
            self.assertEqual(caught.exception.status, 400)
        self.urlopen.assert_not_called()

    def test_invalid_uuids_and_credential_types_or_bounds_are_rejected_early(self):
        invalid = (
            ("transaction_id", None), ("transaction_id", 123),
            ("transaction_id", "not-a-uuid"), ("transaction_id", self.transaction_id.replace("-", "")),
            ("transaction_id", "{" + self.transaction_id + "}"),
            ("transaction_id", self.transaction_id + "&user_id=eq." + self.other_id),
            ("username", None), ("username", 1), ("username", []),
            ("username", ""), ("username", "  "), ("username", "x" * 257),
            ("password", None), ("password", False), ("password", {}),
            ("password", ""), ("password", "x" * 1025),
        )
        for key, value in invalid:
            with self.subTest(key=key, value=value), self.assertRaises(ApiError) as caught:
                view_receipt({**self.payload, key: value})
            self.assertEqual(caught.exception.status, 400)
        self.urlopen.assert_not_called()

    def test_missing_foreign_null_and_invalid_paths_are_uniformly_unavailable(self):
        invalid_paths = (
            None, "", 42, {}, [], self.object_path.replace(self.user_id, self.other_id),
            self.object_path.replace(self.user_id, self.user_id.upper()),
            "invoice-images/" + self.object_path, "/" + self.object_path,
            "https://evil.example/" + self.object_path, "//evil.example/" + self.object_path,
            self.object_path.replace("/", "/../"), self.object_path.replace("/", "/./"),
            self.object_path.replace("/", "//"), self.object_path.replace("/", "/extra/"),
            self.object_path.replace("/", "\\"), self.object_path.replace("/", "%2f"),
            self.object_path.replace("/", "/%2e%2e/"), self.object_path.replace("/", "/%252e%252e/"),
            self.object_path + "?token=attacker", self.object_path + "#fragment",
            self.object_path + "\n", self.object_path + "\x00", self.object_path + ".png",
            self.object_path.replace("a" * 32, "a" * 31),
            self.object_path.replace("a" * 32, "A" * 32),
            self.object_path.replace("20261102", "20260230"),
            self.object_path.replace("023000Z", "253000Z"),
            self.object_path.replace("2026", "\uff12\uff10\uff12\uff16"),
            self.object_path.replace(".jpg", ".jpeg"), self.object_path.replace(".jpg", ".JPG"),
        )
        rows = [[], [{}]] + [[{"receipt_path": path}] for path in invalid_paths]
        for row in rows:
            with self.subTest(row=row):
                # A rewritten transaction user_id cannot authorize a foreign photo prefix.
                self.responses([{"id": self.user_id}], row)
                with self.assertRaises(ApiError) as caught:
                    view_receipt(self.payload)
                self.assertEqual(caught.exception.status, 404)
                self.assertEqual(str(caught.exception), "Struk tidak tersedia.")
                self.assertEqual(self.urlopen.call_count, 2)

    def test_malformed_rpc_results_fail_closed(self):
        results = (None, {}, {"error": "private detail"}, "private detail", [None], [{}],
                   [{"id": None}], [{"id": "invalid"}], [{"id": 123}],
                   [{"id": self.user_id}, {"id": self.other_id}])
        for result in results:
            with self.subTest(result=result):
                self.responses(result)
                with self.assertRaises(ApiError) as caught:
                    view_receipt(self.payload)
                self.assertEqual(caught.exception.status, 502)
                self.assertEqual(str(caught.exception), "Verifikasi pengguna tidak dapat diproses.")
                self.assertEqual(self.urlopen.call_count, 1)

    def test_malformed_transaction_results_never_sign(self):
        for result in (None, {}, "private detail", [None], [42], [{}, {}], {"error": "private detail"}):
            with self.subTest(result=result):
                self.responses([{"id": self.user_id}], result)
                with self.assertRaises(ApiError) as caught:
                    view_receipt(self.payload)
                self.assertEqual(caught.exception.status, 502)
                self.assertEqual(str(caught.exception), "Data struk tidak dapat diambil.")
                self.assertEqual(self.urlopen.call_count, 2)

    def test_malformed_storage_results_and_unsafe_signed_urls_fail_closed(self):
        urls = (
            None, 42, {}, "", "https://evil.example" + self.signing_path + "?token=secret",
            "http://example.supabase.co" + self.signing_path + "?token=secret",
            "https://example.supabase.co.evil.example" + self.signing_path + "?token=secret",
            "https://secret@example.supabase.co" + self.signing_path + "?token=secret",
            "https://example.supabase.co:443" + self.signing_path + "?token=secret",
            "//evil.example" + self.signing_path + "?token=secret",
            self.origin + self.signing_path.replace(self.user_id, self.other_id) + "?token=secret",
            self.signing_path.replace("invoice-images", "other-bucket") + "?token=secret",
            self.signing_path.replace("/sign/", "/public/") + "?token=secret",
            self.signing_path.replace("/sign/", "/sign/../sign/") + "?token=secret",
            self.signing_path.replace("/sign/", "/sign/%2e%2e/sign/") + "?token=secret",
            self.signing_path.replace("/sign/", "/sign%2f") + "?token=secret",
            self.signing_path + "?token=secret#fragment",
            self.signing_path + "?token=one&token=two", self.signing_path + "?token=",
            self.signing_path + "?redirect=https://evil.example", self.signing_path,
            self.signing_path + "?token=secret&redirect=https://evil.example",
            "\n" + self.signing_path + "?token=secret",
            self.signing_path + "?token=secret\\evil", "x" * 8193,
        )
        results = [None, [], "private detail", {}, {"error": "private detail"},
                   {"error": "private detail", "signedURL": self.signing_path + "?token=secret"}]
        results += [{"signedURL": value} for value in urls]
        for result in results:
            with self.subTest(result=result):
                self.responses([{"id": self.user_id}], [{"receipt_path": self.object_path}], result)
                with self.assertRaises(ApiError) as caught:
                    view_receipt(self.payload)
                self.assertEqual(caught.exception.status, 502)
                self.assertEqual(str(caught.exception), "Tautan struk tidak dapat dibuat.")

    def test_upstream_http_network_and_json_errors_have_only_safe_stage_messages(self):
        prefix = [[{"id": self.user_id}], [{"receipt_path": self.object_path}]]
        messages = ("Verifikasi pengguna tidak dapat diproses.", "Data struk tidak dapat diambil.", "Tautan struk tidak dapat dibuat.")
        for stage, message in enumerate(messages):
            for failure in ("http", "redirect", "network", "timeout", "os", "json", "utf8"):
                with self.subTest(stage=stage, failure=failure):
                    secret = f"{self.payload['password']} server-only-key signed-url private-detail"
                    raw = io.BytesIO(secret.encode())
                    errors = {"network": URLError, "timeout": TimeoutError, "os": OSError}
                    if failure in ("http", "redirect"):
                        code = 500 if failure == "http" else 302
                        bad_response = HTTPError(self.origin, code, secret, {"Location": "https://evil.example"}, raw)
                        bad_response.read = MagicMock()
                    elif failure in errors:
                        bad_response = errors[failure](secret)
                    else:
                        bad_response = self.response(None)
                        bad_response.read.return_value = secret.encode() if failure == "json" else b"\xff"
                    self.urlopen.reset_mock()
                    self.urlopen.side_effect = [self.response(data) for data in prefix[:stage]] + [bad_response]
                    with patch("builtins.print") as log, self.assertRaises(ApiError) as caught:
                        view_receipt(self.payload)
                    self.assertEqual(caught.exception.status, 502)
                    self.assertEqual(str(caught.exception), message)
                    self.assertIsNone(caught.exception.__cause__)
                    self.assertTrue(caught.exception.__suppress_context__)
                    self.assertEqual(self.urlopen.call_count, stage + 1)
                    if failure in ("http", "redirect"):
                        bad_response.read.assert_not_called()
                        self.assertTrue(raw.closed)
                    else:
                        self.assertEqual(raw.tell(), 0)
                    log.assert_not_called()

    def test_misconfigured_supabase_origin_or_key_fails_before_network(self):
        urls = ("", "http://example.supabase.co", "https://", "https://user:pass@example.supabase.co",
                self.origin + "/rest/v1", self.origin + "?secret=x", self.origin + "#fragment",
                self.origin + "\\evil", self.origin + "\n", self.origin + ":bad")
        for url in urls:
            with self.subTest(url=url), patch.dict("os.environ", {"SUPABASE_URL": url}), self.assertRaises(ApiError) as caught:
                view_receipt(self.payload)
            self.assertEqual(caught.exception.status, 503)
        with patch.dict("os.environ", {"SUPABASE_SERVICE_ROLE_KEY": ""}), self.assertRaises(ApiError) as caught:
            view_receipt(self.payload)
        self.assertEqual(caught.exception.status, 503)
        self.urlopen.assert_not_called()

    def test_receipt_opener_blocks_redirects_instead_of_forwarding_secrets(self):
        redirect = NoReceiptRedirect()
        self.assertIsNone(redirect.redirect_request(None, None, 302, "redirect", {}, "https://evil.example"))
        self.assertIsNone(redirect.redirect_request(None, None, 307, "redirect", {}, self.origin + "/elsewhere"))


class InvoiceHandlerTests(unittest.TestCase):
    user_id = ReceiptViewTests.user_id
    image = b"\xff\xd8\xffinvoice"
    data_url = "data:image/jpeg;base64," + base64.b64encode(image).decode()

    def post(self, payload, content_type="application/json", length=None, raw=None):
        body = json.dumps(payload).encode() if raw is None else raw
        request = handler.__new__(handler)
        request.headers = {"Content-Type": content_type, "Content-Length": str(len(body)) if length is None else length}
        request.rfile, request.wfile = io.BytesIO(body), io.BytesIO()
        request.send_response = MagicMock()
        request.send_header = MagicMock()
        request.end_headers = MagicMock()
        request.do_POST()
        status = request.send_response.call_args.args[0]
        response = json.loads(request.wfile.getvalue())
        request.send_header.assert_any_call("Cache-Control", "no-store")
        request.send_header.assert_any_call("Content-Type", "application/json; charset=utf-8")
        request.send_header.assert_any_call("Content-Length", str(len(request.wfile.getvalue())))
        return status, response

    def test_scan_action_omission_preserves_success_response(self):
        expense = {"type": "expense", "amount": 12000, "transaction_date": "2024-08-17"}
        with patch("api.invoice.save_image", return_value="original/saved-path.jpg") as save, patch("api.invoice.analyze_invoice", return_value=expense) as analyze, patch("api.invoice.view_receipt") as view:
            self.assertEqual(self.post({"user_id": self.user_id, "image": self.data_url}),
                             (200, {"expense": expense, "saved_path": "original/saved-path.jpg"}))
        save.assert_called_once_with(self.image, "image/jpeg", self.user_id)
        analyze.assert_called_once_with(self.data_url)
        view.assert_not_called()

    def test_scan_ai_failure_keeps_saved_path(self):
        with patch("api.invoice.save_image", return_value="original/saved-path.jpg"), patch("api.invoice.analyze_invoice", side_effect=ApiError("Tanggal struk tidak dapat dibaca.", 422)):
            self.assertEqual(self.post({"user_id": self.user_id, "image": self.data_url}),
                             (422, {"error": "Tanggal struk tidak dapat dibaca.", "saved_path": "original/saved-path.jpg"}))

    def test_scan_storage_failure_has_no_saved_path_and_does_not_analyze(self):
        with patch("api.invoice.save_image", side_effect=ApiError("Storage unavailable", 502)), patch("api.invoice.analyze_invoice") as analyze:
            self.assertEqual(self.post({"user_id": self.user_id, "image": self.data_url}), (502, {"error": "Storage unavailable"}))
        analyze.assert_not_called()

    def test_view_branch_does_not_scan_and_uses_no_store(self):
        payload = {"action": "view_receipt", "transaction_id": ReceiptViewTests.transaction_id, "username": "Bayu", "password": "secret"}
        result = {"signed_url": "https://example.supabase.co/storage/v1/object/sign/path?token=secret", "expires_in": 60}
        with patch("api.invoice.view_receipt", return_value=result) as view, patch("api.invoice.save_image") as save, patch("api.invoice.analyze_invoice") as analyze:
            self.assertEqual(self.post(payload), (200, result))
        view.assert_called_once_with(payload)
        save.assert_not_called()
        analyze.assert_not_called()

    def test_view_api_failure_is_safe_and_no_store(self):
        with patch("api.invoice.view_receipt", side_effect=ApiError("Struk tidak tersedia.", 404)):
            self.assertEqual(self.post({"action": "view_receipt"}), (404, {"error": "Struk tidak tersedia."}))

    def test_unknown_actions_and_non_object_json_fail_before_any_work(self):
        payloads = [[], None, "string", 42, True]
        payloads += [{"action": action, "user_id": self.user_id, "image": self.data_url}
                     for action in ("scan", "other", None, 0, {}, [])]
        with patch("api.invoice.view_receipt") as view, patch("api.invoice.save_image") as save:
            for payload in payloads:
                with self.subTest(payload=payload):
                    status, result = self.post(payload)
                    self.assertEqual(status, 400)
                    self.assertEqual(set(result), {"error"})
        view.assert_not_called()
        save.assert_not_called()

    def test_bad_json_headers_and_body_bounds_fail_safely(self):
        cases = (
            ({"raw": b"{"}, 400), ({"raw": b"\xff"}, 400),
            ({"length": "not-an-integer"}, 400), ({"length": "0"}, 413),
            ({"length": "-1"}, 413), ({"length": str(MAX_BODY_BYTES + 1)}, 413),
            ({"content_type": "text/plain"}, 415),
        )
        for kwargs, expected in cases:
            with self.subTest(kwargs=kwargs):
                status, result = self.post({}, **kwargs)
                self.assertEqual(status, expected)
                self.assertEqual(set(result), {"error"})

    def test_unexpected_errors_do_not_log_password_key_url_or_response(self):
        secret = "password server-key https://example.supabase.co/?token=secret raw-response"
        with patch("api.invoice.view_receipt", side_effect=RuntimeError(secret)), patch("builtins.print") as log:
            status, result = self.post({"action": "view_receipt", "password": secret})
        self.assertEqual(status, 500)
        self.assertNotIn(secret, json.dumps(result))
        log.assert_called_once_with("Unexpected receipt API error")

    def test_scanner_storage_request_preserves_private_bucket_and_exact_saved_path(self):
        with patch.dict("os.environ", {"SUPABASE_URL": ReceiptViewTests.origin, "SUPABASE_SERVICE_ROLE_KEY": "server-key"}), patch("api.invoice.urlopen") as urlopen, patch("api.invoice.uuid.uuid4") as random_id:
            random_id.return_value.hex = "b" * 32
            object_path = save_image(self.image, "image/jpeg", self.user_id)
        self.assertRegex(object_path, rf"^{self.user_id}/[0-9]{{8}}T[0-9]{{6}}Z-{'b' * 32}\.jpg$")
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, ReceiptViewTests.origin + "/storage/v1/object/invoice-images/" + object_path)
        self.assertEqual(request.data, self.image)
        self.assertEqual(request.get_header("Authorization"), "Bearer server-key")
        self.assertEqual(request.get_header("Apikey"), "server-key")
        self.assertEqual(request.get_header("Content-type"), "image/jpeg")
        self.assertEqual(request.get_header("X-upsert"), "false")

    def test_scanner_preserves_models_and_date_extraction(self):
        expense = {"valid": True, "amount": 12500, "category": "Makanan", "transaction_date": "17/08/2024", "description": "Toko Bayu"}
        with patch("api.invoice.openrouter_chat", side_effect=["receipt text", json.dumps(expense)]) as chat:
            result = analyze_invoice(self.data_url)
        self.assertEqual(result["transaction_date"], "2024-08-17")
        self.assertEqual(chat.call_args_list[0].args[0], VISION_MODEL)
        self.assertEqual(chat.call_args_list[1].args[0], PARSER_MODEL)
        self.assertEqual(chat.call_args_list[0].args[1][0]["content"][1]["image_url"]["url"], self.data_url)


if __name__ == "__main__":
    unittest.main()
