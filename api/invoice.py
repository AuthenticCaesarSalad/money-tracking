"""Vercel Python function for invoice photo extraction."""

import base64
import binascii
import json
import os
import re
import uuid
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
PARSER_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free"
VISION_MODEL = "nvidia/nemotron-3.5-super-vl:free"
STORAGE_BUCKET = "invoice-images"
MAX_BODY_BYTES = 4_000_000
MAX_IMAGE_BYTES = 3_000_000
ALLOWED_CATEGORIES = ("Makanan", "Transportasi", "Tagihan", "Lainnya")
DATA_URL_RE = re.compile(r"^data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$")


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def decode_image(data_url):
    if not isinstance(data_url, str):
        raise ApiError("Foto invoice tidak ditemukan.")

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
        raise ApiError("Penyimpanan invoice belum dikonfigurasi di Vercel.", 503)

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
            raise ApiError("AI tidak menghasilkan data invoice terstruktur.", 502) from error

    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise ApiError("AI tidak menghasilkan data invoice.", 502)
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
        raise ApiError("Data invoice dari AI tidak dapat dibaca.", 502) from error


def normalize_expense(data):
    if not isinstance(data, dict) or data.get("valid") is not True:
        raise ApiError("Foto tidak terlihat seperti invoice yang dapat dibaca.", 422)

    try:
        amount = round(float(data.get("amount", 0)))
    except (TypeError, ValueError) as error:
        raise ApiError("Nominal invoice tidak dapat dibaca.", 422) from error
    if amount <= 0:
        raise ApiError("Nominal invoice tidak ditemukan.", 422)

    transaction_date = str(data.get("transaction_date", ""))
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", transaction_date):
        raise ApiError("Tanggal invoice tidak dapat dibaca.", 422)
    try:
        date.fromisoformat(transaction_date)
    except ValueError as error:
        raise ApiError("Tanggal invoice tidak dapat dibaca.", 422) from error

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
                            "Transcribe this invoice or receipt accurately. Include merchant, date, "
                            "grand total, currency, invoice number, and visible purchased items. "
                            "Do not guess unreadable text. Return plain text only."
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
                "description": "Return the normalized expense fields extracted from the invoice.",
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
                    "Convert invoice transcription into one Indonesian expense. Use the grand total, "
                    "not subtotal or change. Categories: Makanan for food/drink; Transportasi for "
                    "transport/fuel/parking; Tagihan for utilities/subscriptions; otherwise Lainnya. "
                    "Set valid=false when the merchant, positive grand total, or invoice date is "
                    "missing. description should contain merchant and useful invoice detail."
                ),
            },
            {
                "role": "user",
                "content": f"Today is {date.today().isoformat()}.\n\nInvoice transcription:\n{vision_text[:12000]}",
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
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY_BYTES:
                raise ApiError("Ukuran permintaan foto terlalu besar.", 413)
            if "application/json" not in self.headers.get("Content-Type", ""):
                raise ApiError("Content-Type harus application/json.", 415)

            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ApiError("Data permintaan tidak valid.") from error

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
        except Exception as error:  # pragma: no cover - final server boundary
            print(f"Unexpected invoice API error: {error}")
            self.send_json(500, {"error": "Terjadi kesalahan internal saat memproses invoice."})
