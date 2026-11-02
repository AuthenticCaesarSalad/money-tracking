"""Vercel Python function for receipt photo extraction."""

import base64
import binascii
import json
import os
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
PARSER_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free"
VISION_MODEL = "nvidia/nemotron-3.5-super-vl:free"
STORAGE_BUCKET = "invoice-images"
MAX_BODY_BYTES = 4_000_000
MAX_IMAGE_BYTES = 3_000_000
ALLOWED_CATEGORIES = ("Makanan", "Transportasi", "Tagihan", "Lainnya")
DATA_URL_RE = re.compile(r"^data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$")
MONTHS = {
    "jan": 1,
    "januari": 1,
    "january": 1,
    "feb": 2,
    "februari": 2,
    "february": 2,
    "mar": 3,
    "maret": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "mei": 5,
    "may": 5,
    "jun": 6,
    "juni": 6,
    "june": 6,
    "jul": 7,
    "juli": 7,
    "july": 7,
    "agu": 8,
    "agt": 8,
    "agustus": 8,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "okt": 10,
    "oktober": 10,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "des": 12,
    "desember": 12,
    "dec": 12,
    "december": 12,
}


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class NoReceiptRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Keep server credentials and passwords on the configured origin only.
receipt_urlopen = build_opener(NoReceiptRedirect).open


def receipt_request_json(url, service_key, message, payload=None):
    request = Request(
        url,
        data=None if payload is None else json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {service_key}",
            "apikey": service_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="GET" if payload is None else "POST",
    )
    try:
        with receipt_urlopen(request, timeout=25) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, OSError, UnicodeDecodeError, ValueError) as error:
        if isinstance(error, HTTPError):
            error.close()
        raise ApiError(message, 502) from None


def receipt_uuid(value):
    if not isinstance(value, str) or len(value) != 36:
        raise ValueError("invalid UUID")
    canonical = str(uuid.UUID(value))
    if value.lower() != canonical:
        raise ValueError("invalid UUID")
    return canonical


def normalize_signed_url(value, supabase_url, object_path):
    message = "Tautan struk tidak dapat dibuat."
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 8192
        or any(ord(char) <= 32 for char in value)
        or "\\" in value
    ):
        raise ApiError(message, 502)
    try:
        parts = urlsplit(value)
        origin = urlsplit(supabase_url)
        expected_path = f"/storage/v1/object/sign/{STORAGE_BUCKET}/{object_path}"
        if not parts.scheme and not parts.netloc:
            if parts.path not in (expected_path, expected_path.removeprefix("/storage/v1")):
                raise ValueError("unexpected signed path")
        elif parts.scheme != "https" or parts.netloc != origin.netloc or parts.path != expected_path:
            raise ValueError("unexpected signed origin or path")
        query = parse_qs(parts.query, strict_parsing=True)
        if parts.fragment or set(query) != {"token"} or len(query["token"]) != 1:
            raise ValueError("invalid signing token")
        return urlunsplit(("https", origin.netloc, expected_path, urlencode({"token": query["token"][0]}), ""))
    except ValueError as error:
        raise ApiError(message, 502) from error


def view_receipt(payload):
    if set(payload) - {"action", "transaction_id", "username", "password"}:
        raise ApiError("Data permintaan struk tidak valid.")
    try:
        transaction_id = receipt_uuid(payload.get("transaction_id"))
    except ValueError as error:
        raise ApiError("ID transaksi tidak valid.") from error
    username, password = payload.get("username"), payload.get("password")
    if (
        not isinstance(username, str)
        or not 1 <= len(username) <= 256
        or not username.strip()
        or not isinstance(password, str)
        or not 1 <= len(password) <= 1024
    ):
        raise ApiError("Nama pengguna dan kata sandi tidak valid.")

    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    try:
        origin = urlsplit(supabase_url)
        if (
            not service_key
            or origin.scheme != "https"
            or not origin.hostname
            or origin.username is not None
            or origin.password is not None
            or origin.port == 0
            or origin.path
            or origin.query
            or origin.fragment
            or "\\" in supabase_url
            or any(ord(char) <= 32 for char in supabase_url)
        ):
            raise ValueError("invalid Supabase configuration")
    except ValueError as error:
        raise ApiError("Penyimpanan struk belum dikonfigurasi dengan benar.", 503) from error

    login_message = "Verifikasi pengguna tidak dapat diproses."
    users = receipt_request_json(
        f"{supabase_url}/rest/v1/rpc/login_user",
        service_key,
        login_message,
        {"p_username": username, "p_password": password},
    )
    if users == []:
        raise ApiError("Nama pengguna atau kata sandi salah.", 401)
    if not isinstance(users, list) or len(users) != 1 or not isinstance(users[0], dict):
        raise ApiError(login_message, 502)
    try:
        user_id = receipt_uuid(users[0].get("id"))
    except ValueError as error:
        raise ApiError(login_message, 502) from error

    rows = receipt_request_json(
        f"{supabase_url}/rest/v1/transactions?" + urlencode({
            "select": "receipt_path", "id": f"eq.{transaction_id}",
            "user_id": f"eq.{user_id}", "limit": "1",
        }),
        service_key,
        "Data struk tidak dapat diambil.",
    )
    if not isinstance(rows, list) or len(rows) > 1 or (rows and not isinstance(rows[0], dict)):
        raise ApiError("Data struk tidak dapat diambil.", 502)
    object_path = rows[0].get("receipt_path") if rows else None
    unavailable = "Struk tidak tersedia."
    if not isinstance(object_path, str):
        raise ApiError(unavailable, 404)
    # RLS permits ownership rewrites, so the stored photo's UUID must also match.
    match = re.fullmatch(
        re.escape(user_id) + r"/([0-9]{8}T[0-9]{6}Z)-[0-9a-f]{32}\.(?:jpg|png|webp)",
        object_path,
    )
    if not match:
        raise ApiError(unavailable, 404)
    try:
        datetime.strptime(match[1], "%Y%m%dT%H%M%SZ")
    except ValueError as error:
        raise ApiError(unavailable, 404) from error

    signing_message = "Tautan struk tidak dapat dibuat."
    result = receipt_request_json(
        f"{supabase_url}/storage/v1/object/sign/{STORAGE_BUCKET}/{object_path}",
        service_key,
        signing_message,
        {"expiresIn": 60},
    )
    if not isinstance(result, dict) or "error" in result:
        raise ApiError(signing_message, 502)
    signed_url = normalize_signed_url(result.get("signedURL") or result.get("signedUrl"), supabase_url, object_path)
    return {"signed_url": signed_url, "expires_in": 60}


def decode_image(data_url):
    if not isinstance(data_url, str):
        raise ApiError("Foto struk tidak ditemukan.")

    match = DATA_URL_RE.fullmatch(data_url)
    if not match:
        raise ApiError("Format foto harus JPEG, PNG, atau WebP.")

    mime_type, encoded = match.groups()
    try:
        image = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ApiError("Data foto tidak valid.") from error

    if not image or len(image) > MAX_IMAGE_BYTES:
        raise ApiError("Ukuran foto maksimal 3 MB.", 413)

    signatures = {
        "image/jpeg": image.startswith(b"\xff\xd8\xff"),
        "image/png": image.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/webp": image.startswith(b"RIFF") and image[8:12] == b"WEBP",
    }
    if not signatures[mime_type]:
        raise ApiError("Isi foto tidak sesuai dengan format file.")

    return image, mime_type


def validate_user_id(value):
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError) as error:
        raise ApiError("Sesi pengguna tidak valid.", 401) from error


def request_json(url, payload, headers, timeout=25):
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        try:
            message = json.loads(detail).get("error", {}).get("message") or detail
        except json.JSONDecodeError:
            message = detail
        raise ApiError(f"Layanan AI menolak permintaan: {message[:300]}", 502) from error
    except (URLError, TimeoutError) as error:
        raise ApiError("Layanan eksternal tidak dapat dihubungi.", 502) from error


def save_image(image, mime_type, user_id):
    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not supabase_url or not service_key:
        raise ApiError("Penyimpanan struk belum dikonfigurasi di Vercel.", 503)

    extension = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}[mime_type]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    object_path = f"{user_id}/{stamp}-{uuid.uuid4().hex}.{extension}"
    url = f"{supabase_url}/storage/v1/object/{STORAGE_BUCKET}/{quote(object_path, safe='/')}"
    request = Request(
        url,
        data=image,
        headers={
            "Authorization": f"Bearer {service_key}",
            "apikey": service_key,
            "Content-Type": mime_type,
            "x-upsert": "false",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=30):
            return object_path
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise ApiError(f"Foto gagal disimpan: {detail[:250]}", 502) from error
    except (URLError, TimeoutError) as error:
        raise ApiError("Penyimpanan foto tidak dapat dihubungi.", 502) from error


def openrouter_chat(model, messages, tools=None, tool_choice=None):
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        raise ApiError("OpenRouter belum dikonfigurasi di Vercel.", 503)

    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0,
        "max_tokens": 1200,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = tool_choice or "required"

    result = request_json(
        OPENROUTER_URL,
        payload,
        {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://uang.projek-bayu.my.id",
            "X-Title": "Keuangan Pribadi AI Camera",
        },
    )
    try:
        message = result["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as error:
        raise ApiError("Respons AI tidak lengkap.", 502) from error

    if tools:
        try:
            return message["tool_calls"][0]["function"]["arguments"]
        except (KeyError, IndexError, TypeError) as error:
            raise ApiError("AI tidak menghasilkan data struk terstruktur.", 502) from error

    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise ApiError("AI tidak menghasilkan data struk.", 502)
    return content.strip()


def extract_json(text):
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ApiError("AI mengembalikan format data yang tidak valid.", 502)
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError as error:
        raise ApiError("Data struk dari AI tidak dapat dibaca.", 502) from error


def normalize_receipt_date(value, today=None):
    """Return a supported receipt date as ISO, rejecting invalid or future dates."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("missing receipt date")

    value = value.strip()
    today = today or datetime.now(timezone(timedelta(hours=7))).date()
    parts = None

    iso_match = re.match(r"^(\d{4})-(\d{2})-(\d{2})(?:$|[Tt\s])", value)
    if iso_match:
        parsed_iso = datetime.fromisoformat(value)
        parts = (parsed_iso.year, parsed_iso.month, parsed_iso.day)
    else:
        numeric_match = re.fullmatch(r"(\d{1,2})([/.-])(\d{1,2})\2(\d{2}|\d{4})", value)
        if numeric_match:
            day, _, month, year = numeric_match.groups()
            year = int(year)
            parts = (
                year + (2000 if year < 69 else 1900) if year < 100 else year,
                int(month),
                int(day),
            )
        else:
            day_first = re.fullmatch(
                r"(\d{1,2})\s+([A-Za-z]+)\s*,?\s*(\d{2}|\d{4})", value
            )
            month_first = re.fullmatch(
                r"([A-Za-z]+)\s+(\d{1,2})\s*,?\s*(\d{2}|\d{4})", value
            )
            if day_first:
                day, month_name, year = day_first.groups()
            elif month_first:
                month_name, day, year = month_first.groups()
            else:
                raise ValueError("unknown receipt date format")
            month = MONTHS.get(month_name.lower())
            if month is None:
                raise ValueError("unknown receipt month")
            year = int(year)
            parts = (
                year + (2000 if year < 69 else 1900) if year < 100 else year,
                month,
                int(day),
            )

    parsed = date(*parts)
    if parsed > today:
        raise ValueError("future receipt date")
    return parsed.isoformat()


def normalize_expense(data):
    if not isinstance(data, dict) or data.get("valid") is not True:
        raise ApiError("Foto tidak terlihat seperti struk yang dapat dibaca.", 422)

    try:
        amount = round(float(data.get("amount", 0)))
    except (TypeError, ValueError) as error:
        raise ApiError("Nominal struk tidak dapat dibaca.", 422) from error
    if amount <= 0:
        raise ApiError("Nominal struk tidak ditemukan.", 422)

    try:
        transaction_date = normalize_receipt_date(data.get("transaction_date"))
    except (TypeError, ValueError) as error:
        raise ApiError("Tanggal struk tidak dapat dibaca.", 422) from error

    category = data.get("category")
    if category not in ALLOWED_CATEGORIES:
        category = "Lainnya"

    description = " ".join(str(data.get("description", "")).split())[:120]
    return {
        "type": "expense",
        "amount": amount,
        "category": category,
        "transaction_date": transaction_date,
        "description": description,
    }


def analyze_invoice(data_url):
    vision_text = openrouter_chat(
        VISION_MODEL,
        [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "Transcribe this Indonesian struk/bukti transaksi (receipt or proof of "
                            "transaction) accurately. "
                            "Recognize retail/shop receipts, restaurant/cafe receipts, fuel receipts, "
                            "parking/toll/transport tickets, utility/service bills with payment proof, "
                            "e-commerce receipts, digital payment receipts, invoices/faktur, and "
                            "handwritten receipts. Transcribe every visible date with its printed label, "
                            "the merchant/payee/provider, final total actually paid, currency, reference "
                            "number, and useful visible items. Never guess unreadable text. Return plain text only."
                        ),
                    },
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
    )

    tools = [
        {
            "type": "function",
            "function": {
                "name": "record_expense",
                "description": "Return the normalized expense fields extracted from the receipt.",
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "valid": {"type": "boolean"},
                        "amount": {"type": "integer", "minimum": 0},
                        "category": {"type": "string", "enum": list(ALLOWED_CATEGORIES)},
                        "transaction_date": {"type": "string"},
                        "description": {"type": "string", "maxLength": 120},
                    },
                    "required": [
                        "valid",
                        "amount",
                        "category",
                        "transaction_date",
                        "description",
                    ],
                },
            },
        }
    ]
    parsed_text = openrouter_chat(
        PARSER_MODEL,
        [
            {
                "role": "system",
                "content": (
                    "Convert the struk/bukti transaksi (receipt or proof-of-transaction) transcription "
                    "into one Indonesian expense. "
                    "Accept a merchant, payee, provider, or operator as the counterparty. Choose the final "
                    "amount actually paid, never a subtotal, tax-only amount, balance, or change. Choose the "
                    "transaction, payment, or purchase date, never a due or expiry date; use an issue/print "
                    "date only when it clearly represents the transaction time. Interpret ambiguous numeric "
                    "dates day-first as used in Indonesia. Return transaction_date strictly as ISO YYYY-MM-DD. "
                    "Never invent a date or default a missing date to today. Categories: Makanan for food/drink; "
                    "Transportasi for transport/fuel/parking; Tagihan for utilities/subscriptions; otherwise "
                    "Lainnya. Set valid=false when the counterparty, positive final paid amount, or valid "
                    "transaction date is missing. description should contain the counterparty and useful detail."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Today in WIB is {datetime.now(timezone(timedelta(hours=7))).date().isoformat()} "
                    "(only for rejecting future dates, never as a fallback).\n\n"
                    f"Receipt transcription:\n{vision_text[:12000]}"
                ),
            },
        ],
        tools,
        {"type": "function", "function": {"name": "record_expense"}},
    )
    return normalize_expense(extract_json(parsed_text))


class handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        saved_path = None
        try:
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError as error:
                raise ApiError("Data permintaan tidak valid.") from error
            if length <= 0 or length > MAX_BODY_BYTES:
                raise ApiError("Ukuran permintaan foto terlalu besar.", 413)
            if "application/json" not in self.headers.get("Content-Type", ""):
                raise ApiError("Content-Type harus application/json.", 415)

            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ApiError("Data permintaan tidak valid.") from error

            if not isinstance(payload, dict):
                raise ApiError("Data permintaan harus berupa objek JSON.")
            if "action" in payload:
                if payload["action"] != "view_receipt":
                    raise ApiError("Aksi permintaan tidak valid.")
                self.send_json(200, view_receipt(payload))
                return

            user_id = validate_user_id(payload.get("user_id"))
            data_url = payload.get("image")
            image, mime_type = decode_image(data_url)
            saved_path = save_image(image, mime_type, user_id)
            expense = analyze_invoice(data_url)
            self.send_json(200, {"expense": expense, "saved_path": saved_path})
        except ApiError as error:
            response = {"error": str(error)}
            if saved_path:
                response["saved_path"] = saved_path
            self.send_json(error.status, response)
        except Exception:  # noqa: BLE001 - final boundary must not expose exception details
            print("Unexpected receipt API error")
            self.send_json(500, {"error": "Terjadi kesalahan internal saat memproses struk."})
