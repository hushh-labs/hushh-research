"""Gmail receipts connector service for Kai profile.

This service manages:
- OAuth connect/disconnect lifecycle
- encrypted token storage + refresh
- receipt sync runs (manual + scheduled)
- deterministic receipt classification/extraction with optional LLM fallback
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlencode

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from db.connection import get_pool
from db.db_client import get_db

logger = logging.getLogger(__name__)

_GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105
_GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
_GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile"
_GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages"
_GMAIL_HISTORY_URL = "https://gmail.googleapis.com/gmail/v1/users/me/history"
_GMAIL_WATCH_URL = "https://gmail.googleapis.com/gmail/v1/users/me/watch"

_RECEIPT_SUBJECT_RE = re.compile(
    r"\b(receipt|invoice|order(?:\s+confirmation)?|payment|transaction|purchase|paid)\b",
    re.IGNORECASE,
)
_RECEIPT_SNIPPET_RE = re.compile(
    r"\b(thank you for your order|order total|amount paid|receipt|invoice|payment received)\b",
    re.IGNORECASE,
)
_ORDER_ID_RE = re.compile(
    r"\b(?:order|invoice|receipt|transaction)"
    r"(?:\s*(?:id|no|number)\s*[:#-]?\s*|\s*[#:.-]\s*)"
    r"([A-Z0-9-]{4,})\b",
    re.I,
)
_AMOUNT_RE = re.compile(
    r"(?<![A-Z0-9])(?:USD|\$|EUR|€|GBP|£|INR|₹)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)"
)

_MERCHANT_HINTS = {
    "amazon",
    "apple",
    "uber",
    "lyft",
    "walmart",
    "target",
    "bestbuy",
    "airbnb",
    "booking",
    "expedia",
    "netflix",
    "spotify",
    "paypal",
    "stripe",
    "swiggy",
    "zomato",
    "flipkart",
}
_RUN_CANCELED_MESSAGE = "Gmail sync canceled because the connection was disconnected."
_RUN_STALE_MESSAGE = "Gmail sync expired before completion. Please start a new sync."
_RUN_ORPHANED_MESSAGE = "Gmail sync worker stopped before reporting a final status."
_RUN_HISTORY_GAP_MESSAGE = (
    "Gmail history cursor expired. Starting a recovery sync to rebuild the mailbox snapshot."
)
_RUN_MESSAGE_FAILED_LOG_LIMIT = 160


@dataclass
class GmailApiError(RuntimeError):
    message: str
    status_code: int = 500
    payload: dict[str, Any] | None = None

    def __str__(self) -> str:
        return self.message


@dataclass
class ReceiptCandidate:
    gmail_message_id: str
    gmail_thread_id: str | None
    gmail_internal_date: datetime | None
    gmail_history_id: str | None
    labels: list[str]
    subject: str
    snippet: str
    from_name: str | None
    from_email: str | None
    message_id_header: str | None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _utcnow_iso() -> str:
    return _utcnow().isoformat().replace("+00:00", "Z")


def _int_history_id(value: Any) -> int | None:
    text = _clean_text(value)
    if not text.isdigit():
        return None
    try:
        return int(text)
    except Exception:
        return None


def _history_id_text(value: Any) -> str | None:
    numeric = _int_history_id(value)
    if numeric is None:
        return _clean_text(value) or None
    return str(numeric)


def _max_history_id_text(*values: Any) -> str | None:
    best_numeric: int | None = None
    best_text: str | None = None
    for value in values:
        numeric = _int_history_id(value)
        if numeric is not None:
            if best_numeric is None or numeric > best_numeric:
                best_numeric = numeric
                best_text = str(numeric)
            continue
        text = _clean_text(value) or None
        if text and best_text is None:
            best_text = text
    return best_text


def _google_epoch_ms_to_datetime(value: Any) -> datetime | None:
    text = _clean_text(value)
    if not text.isdigit():
        return None
    try:
        return datetime.fromtimestamp(int(text) / 1000.0, tz=timezone.utc)
    except Exception:
        return None


def _clean_text(value: Any, default: str = "") -> str:
    if not isinstance(value, str):
        return default
    text = value.strip()
    return text or default


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on", "enabled"}
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def _parse_iso(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, date):
        dt = datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    else:
        text = _clean_text(value)
        if not text:
            return None
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except Exception:
            try:
                dt = parsedate_to_datetime(text)
            except Exception:
                return None

    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _safe_json_load(raw: str | None) -> dict[str, Any]:
    text = _clean_text(raw)
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _safe_json_obj(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        return _safe_json_load(value)
    return {}


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded.encode("utf-8"))


def _email_domain(email: str | None) -> str | None:
    if not email or "@" not in email:
        return None
    return email.split("@", 1)[1].strip().lower() or None


def _currency_from_symbol(raw: str) -> str:
    if "$" in raw:
        return "USD"
    if "€" in raw:
        return "EUR"
    if "£" in raw:
        return "GBP"
    if "₹" in raw:
        return "INR"
    if "USD" in raw.upper():
        return "USD"
    if "EUR" in raw.upper():
        return "EUR"
    if "GBP" in raw.upper():
        return "GBP"
    if "INR" in raw.upper():
        return "INR"
    return "USD"


class GmailReceiptsService:
    def __init__(self) -> None:
        self._db = None
        self._http_timeout = float(os.getenv("GMAIL_RECEIPT_HTTP_TIMEOUT_SECONDS", "25") or "25")
        self._background_tasks: set[asyncio.Task[Any]] = set()
        self._sync_tasks_by_run_id: dict[str, asyncio.Task[Any]] = {}
        self._schedule_loop_task: asyncio.Task[Any] | None = None

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    def _oauth_client_id(self) -> str:
        return _clean_text(os.getenv("GMAIL_OAUTH_CLIENT_ID"))

    def _oauth_client_secret(self) -> str:
        return _clean_text(os.getenv("GMAIL_OAUTH_CLIENT_SECRET"))

    def _oauth_redirect_uri(self) -> str:
        return _clean_text(os.getenv("GMAIL_OAUTH_REDIRECT_URI"))

    def _state_secret(self) -> str:
        configured = _clean_text(os.getenv("SECRET_KEY"))
        if configured:
            return configured
        if self._allow_local_dev_fallback():
            logger.warning("gmail.receipts.state_secret_local_dev_fallback_enabled")
            return "gmail-receipts-local-dev-secret"
        raise RuntimeError(
            "SECRET_KEY is required for Gmail OAuth state signing. "
            "Set SECRET_KEY or enable GMAIL_ALLOW_LOCAL_DEV_FALLBACK only in local development."
        )

    def _allow_local_dev_fallback(self) -> bool:
        if not _to_bool(os.getenv("GMAIL_ALLOW_LOCAL_DEV_FALLBACK"), False):
            return False
        environment = _clean_text(os.getenv("ENVIRONMENT"), "development").lower()
        return environment in {"development", "dev", "local"}

    def _token_key(self) -> bytes:
        configured = _clean_text(os.getenv("GMAIL_TOKEN_ENCRYPTION_KEY"))
        if configured:
            try:
                decoded = base64.urlsafe_b64decode(configured.encode("utf-8"))
                if len(decoded) in {16, 24, 32}:
                    return decoded
            except Exception:
                pass
            raw = configured.encode("utf-8")
            if len(raw) in {16, 24, 32}:
                return raw
        if self._allow_local_dev_fallback():
            fallback_secret = self._state_secret()
            logger.warning("gmail.receipts.token_key_local_dev_fallback_enabled")
            return hashlib.sha256(f"{fallback_secret}::gmail-token-dev".encode("utf-8")).digest()
        raise RuntimeError(
            "GMAIL_TOKEN_ENCRYPTION_KEY is required for Gmail token storage. "
            "Set a 16/24/32-byte key or enable GMAIL_ALLOW_LOCAL_DEV_FALLBACK only in local development."
        )

    def is_configured(self) -> bool:
        return bool(
            self._oauth_client_id() and self._oauth_client_secret() and self._oauth_redirect_uri()
        )

    def _sync_enabled(self) -> bool:
        return _to_bool(os.getenv("KAI_GMAIL_RECEIPTS_SYNC_ENABLED"), True)

    def _auto_interval_seconds(self) -> int:
        raw = _clean_text(os.getenv("KAI_GMAIL_RECEIPTS_SYNC_LOOP_SECONDS"), "3600")
        try:
            return max(300, int(raw))
        except Exception:
            return 3600

    def _daily_sync_age_hours(self) -> int:
        raw = _clean_text(os.getenv("KAI_GMAIL_RECEIPTS_DAILY_SYNC_HOURS"), "24")
        try:
            return max(6, int(raw))
        except Exception:
            return 24

    def _max_messages_per_sync(self) -> int:
        raw = _clean_text(os.getenv("KAI_GMAIL_RECEIPTS_MAX_MESSAGES_PER_SYNC"), "300")
        try:
            return max(50, min(2000, int(raw)))
        except Exception:
            return 300

    def _metadata_batch_size(self) -> int:
        raw = _clean_text(os.getenv("KAI_GMAIL_RECEIPTS_METADATA_BATCH_SIZE"), "20")
        try:
            return max(5, min(50, int(raw)))
        except Exception:
            return 20

    def _bootstrap_recent_days(self) -> int:
        raw = _clean_text(os.getenv("KAI_GMAIL_RECEIPTS_BOOTSTRAP_RECENT_DAYS"), "30")
        try:
            return max(7, min(120, int(raw)))
        except Exception:
            return 30

    def _full_sync_days(self) -> int:
        raw = _clean_text(os.getenv("KAI_GMAIL_RECEIPTS_FULL_SYNC_DAYS"), "365")
        try:
            return max(self._bootstrap_recent_days(), min(1095, int(raw)))
        except Exception:
            return 365

    def _backfill_chunk_days(self) -> int:
        raw = _clean_text(os.getenv("KAI_GMAIL_RECEIPTS_BACKFILL_CHUNK_DAYS"), "60")
        try:
            return max(14, min(180, int(raw)))
        except Exception:
            return 60

    def _watch_topic_name(self) -> str:
        return _clean_text(os.getenv("GMAIL_PUBSUB_TOPIC_NAME"))

    def _watch_enabled(self) -> bool:
        return bool(self._watch_topic_name())

    def _watch_label_ids(self) -> list[str]:
        raw = _clean_text(os.getenv("GMAIL_PUBSUB_LABEL_IDS"), "CATEGORY_PURCHASES")
        labels = [part.strip() for part in raw.split(",") if part.strip()]
        return labels or ["CATEGORY_PURCHASES"]

    def _watch_renew_before_seconds(self) -> int:
        raw = _clean_text(os.getenv("GMAIL_PUBSUB_RENEW_BEFORE_SECONDS"), "86400")
        try:
            return max(3600, int(raw))
        except Exception:
            return 86400

    def _watch_notification_stale_hours(self) -> int:
        raw = _clean_text(os.getenv("KAI_GMAIL_RECEIPTS_NOTIFICATION_STALE_HOURS"), "24")
        try:
            return max(6, int(raw))
        except Exception:
            return 24

    def _sync_run_stale_ttl_seconds(self) -> int:
        raw = _clean_text(os.getenv("KAI_GMAIL_RECEIPTS_RUN_STALE_TTL_SECONDS"), "900")
        try:
            return max(60, int(raw))
        except Exception:
            return 900

    def _sync_run_activity_at(self, row: dict[str, Any] | None) -> datetime | None:
        if not row:
            return None
        for key in ("updated_at", "started_at", "requested_at", "created_at"):
            parsed = _parse_iso(row.get(key))
            if parsed is not None:
                return parsed
        return None

    def _is_stale_active_run(self, row: dict[str, Any] | None) -> bool:
        activity_at = self._sync_run_activity_at(row)
        if activity_at is None:
            return False
        return (_utcnow() - activity_at).total_seconds() >= self._sync_run_stale_ttl_seconds()

    def _sync_task_for_run(self, run_id: str) -> asyncio.Task[Any] | Any | None:
        task = self._sync_tasks_by_run_id.get(run_id)
        if task is None:
            return None
        done = getattr(task, "done", None)
        if callable(done) and done():
            self._sync_tasks_by_run_id.pop(run_id, None)
        return task

    def _mark_run_terminal(self, *, run_id: str, status: str, error_message: str | None) -> None:
        self.db.execute_raw(
            """
            UPDATE kai_gmail_sync_runs
            SET status = :status,
                error_message = :error_message,
                completed_at = COALESCE(completed_at, NOW()),
                updated_at = NOW()
            WHERE run_id = :run_id
              AND status IN ('queued', 'running')
            """,
            {
                "run_id": run_id,
                "status": status,
                "error_message": error_message,
            },
        )

    def _update_connection_sync_status(
        self,
        *,
        user_id: str,
        status: str,
        error_message: str | None,
    ) -> None:
        self.db.execute_raw(
            """
            UPDATE kai_gmail_connections
            SET last_sync_status = :status,
                last_sync_error = :error_message,
                updated_at = NOW()
            WHERE user_id = :user_id
            """,
            {
                "user_id": user_id,
                "status": status,
                "error_message": error_message,
            },
        )

    async def _recover_active_run_in_tx(self, *, conn: Any, run: dict[str, Any]) -> bool:
        run_id = _clean_text(run.get("run_id"))
        user_id = _clean_text(run.get("user_id"))
        if not run_id or not user_id:
            return False

        task = self._sync_task_for_run(run_id)
        if task is not None:
            done = getattr(task, "done", None)
            if callable(done) and done():
                cancelled = False
                cancelled_fn = getattr(task, "cancelled", None)
                if callable(cancelled_fn):
                    cancelled = bool(cancelled_fn())
                status = "canceled" if cancelled else "failed"
                error_message = _RUN_CANCELED_MESSAGE if cancelled else _RUN_ORPHANED_MESSAGE
                await conn.execute(
                    """
                    UPDATE kai_gmail_sync_runs
                    SET status = $2,
                        error_message = $3,
                        completed_at = COALESCE(completed_at, NOW()),
                        updated_at = NOW()
                    WHERE run_id = $1
                      AND status IN ('queued', 'running')
                    """,
                    run_id,
                    status,
                    error_message,
                )
                if status == "failed":
                    await conn.execute(
                        """
                        UPDATE kai_gmail_connections
                        SET last_sync_status = 'failed',
                            last_sync_error = $2,
                            updated_at = NOW()
                        WHERE user_id = $1
                        """,
                        user_id,
                        error_message,
                    )
                return True
            return False

        if not self._is_stale_active_run(run):
            return False

        await conn.execute(
            """
            UPDATE kai_gmail_sync_runs
            SET status = 'failed',
                error_message = $2,
                completed_at = COALESCE(completed_at, NOW()),
                updated_at = NOW()
            WHERE run_id = $1
              AND status IN ('queued', 'running')
            """,
            run_id,
            _RUN_STALE_MESSAGE,
        )
        await conn.execute(
            """
            UPDATE kai_gmail_connections
            SET last_sync_status = 'failed',
                last_sync_error = $2,
                updated_at = NOW()
            WHERE user_id = $1
            """,
            user_id,
            _RUN_STALE_MESSAGE,
        )
        return True

    def _reconcile_active_runs(self, *, user_id: str, run_id: str | None = None) -> None:
        if not user_id:
            return
        sql = """
            SELECT run_id, user_id, status, requested_at, started_at, completed_at, updated_at
            FROM kai_gmail_sync_runs
            WHERE user_id = :user_id
              AND status IN ('queued', 'running')
        """
        params: dict[str, Any] = {"user_id": user_id}
        if run_id:
            sql += " AND run_id = :run_id"
            params["run_id"] = run_id
        rows = self.db.execute_raw(sql, params).data
        for row in rows:
            current = dict(row)
            current_run_id = _clean_text(current.get("run_id"))
            if not current_run_id:
                continue
            task = self._sync_task_for_run(current_run_id)
            if task is not None:
                done = getattr(task, "done", None)
                if callable(done) and done():
                    cancelled = False
                    cancelled_fn = getattr(task, "cancelled", None)
                    if callable(cancelled_fn):
                        cancelled = bool(cancelled_fn())
                    status = "canceled" if cancelled else "failed"
                    error_message = _RUN_CANCELED_MESSAGE if cancelled else _RUN_ORPHANED_MESSAGE
                    self._mark_run_terminal(
                        run_id=current_run_id,
                        status=status,
                        error_message=error_message,
                    )
                    if status == "failed":
                        self._update_connection_sync_status(
                            user_id=user_id,
                            status="failed",
                            error_message=error_message,
                        )
                continue
            if not self._is_stale_active_run(current):
                continue
            self._mark_run_terminal(
                run_id=current_run_id,
                status="failed",
                error_message=_RUN_STALE_MESSAGE,
            )
            self._update_connection_sync_status(
                user_id=user_id,
                status="failed",
                error_message=_RUN_STALE_MESSAGE,
            )

    def _llm_fallback_enabled(self) -> bool:
        return _to_bool(os.getenv("GMAIL_RECEIPT_LLM_FALLBACK_ENABLED"), False)

    def _llm_model(self) -> str:
        return _clean_text(os.getenv("GMAIL_RECEIPT_LLM_MODEL"), "gemini-2.5-flash-lite")

    def _build_state_token(self, *, user_id: str, redirect_uri: str) -> str:
        payload = {
            "uid": user_id,
            "redirect_uri": redirect_uri,
            "exp": int((_utcnow() + timedelta(minutes=10)).timestamp()),
            "nonce": uuid.uuid4().hex,
        }
        encoded = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
        signature = hmac.new(
            self._state_secret().encode("utf-8"),
            encoded.encode("utf-8"),
            hashlib.sha256,
        ).digest()
        return f"{encoded}.{_b64url_encode(signature)}"

    def _verify_state_token(self, *, state: str, user_id: str, redirect_uri: str) -> dict[str, Any]:
        parts = state.split(".")
        if len(parts) != 2:
            raise GmailApiError("Invalid OAuth state token", status_code=400)
        payload_part, sig_part = parts
        expected = hmac.new(
            self._state_secret().encode("utf-8"),
            payload_part.encode("utf-8"),
            hashlib.sha256,
        ).digest()
        try:
            provided = _b64url_decode(sig_part)
        except Exception as exc:
            raise GmailApiError("Invalid OAuth state signature", status_code=400) from exc
        if not hmac.compare_digest(expected, provided):
            raise GmailApiError("OAuth state verification failed", status_code=400)

        try:
            payload = _safe_json_load(_b64url_decode(payload_part).decode("utf-8"))
        except Exception as exc:
            raise GmailApiError("Invalid OAuth state payload", status_code=400) from exc
        if _clean_text(payload.get("uid")) != user_id:
            raise GmailApiError("OAuth state user mismatch", status_code=403)
        if _clean_text(payload.get("redirect_uri")) != redirect_uri:
            raise GmailApiError("OAuth redirect mismatch", status_code=400)
        exp = int(payload.get("exp") or 0)
        if exp <= int(_utcnow().timestamp()):
            raise GmailApiError("OAuth state expired", status_code=400)
        return payload

    def _encrypt_token(self, token: str) -> dict[str, str]:
        aesgcm = AESGCM(self._token_key())
        nonce = os.urandom(12)
        encrypted = aesgcm.encrypt(nonce, token.encode("utf-8"), None)
        cipher = encrypted[:-16]
        tag = encrypted[-16:]
        return {
            "ciphertext": base64.urlsafe_b64encode(cipher).decode("utf-8"),
            "iv": base64.urlsafe_b64encode(nonce).decode("utf-8"),
            "tag": base64.urlsafe_b64encode(tag).decode("utf-8"),
        }

    def _decrypt_token(self, ciphertext: str | None, iv: str | None, tag: str | None) -> str | None:
        c = _clean_text(ciphertext)
        i = _clean_text(iv)
        t = _clean_text(tag)
        if not c or not i or not t:
            return None
        aesgcm = AESGCM(self._token_key())
        try:
            plaintext = aesgcm.decrypt(
                base64.urlsafe_b64decode(i.encode("utf-8")),
                base64.urlsafe_b64decode(c.encode("utf-8"))
                + base64.urlsafe_b64decode(t.encode("utf-8")),
                None,
            )
        except Exception:
            return None
        return plaintext.decode("utf-8")

    async def _http_post_form(
        self, url: str, data: dict[str, Any], headers: dict[str, str] | None = None
    ) -> dict[str, Any]:
        timeout = httpx.Timeout(self._http_timeout)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, data=data, headers=headers)
        payload: dict[str, Any]
        try:
            payload = response.json()
        except Exception:
            payload = {}
        if response.status_code >= 400:
            message = _clean_text(payload.get("error_description")) or _clean_text(
                payload.get("error")
            )
            status_code = 401 if response.status_code in {400, 401, 403} else 502
            raise GmailApiError(
                message or f"Google request failed ({response.status_code})",
                status_code=status_code,
                payload=payload,
            )
        return payload

    async def _http_post_json(
        self, url: str, *, token: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        timeout = httpx.Timeout(self._http_timeout)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                url,
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
            )
        try:
            parsed = response.json()
        except Exception:
            parsed = {}
        if response.status_code >= 400:
            status_code = 401 if response.status_code in {400, 401, 403} else response.status_code
            raise GmailApiError(
                f"Gmail API request failed ({response.status_code})",
                status_code=status_code,
                payload=parsed if isinstance(parsed, dict) else {},
            )
        return parsed if isinstance(parsed, dict) else {}

    async def _http_get_json(
        self, url: str, *, token: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        timeout = httpx.Timeout(self._http_timeout)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(
                url,
                params=params,
                headers={"Authorization": f"Bearer {token}"},
            )
        try:
            payload = response.json()
        except Exception:
            payload = {}
        if response.status_code >= 400:
            if response.status_code in {401, 403}:
                raise GmailApiError("Gmail authorization failed", status_code=401, payload=payload)
            if response.status_code == 404:
                raise GmailApiError(
                    "Gmail resource was not found", status_code=404, payload=payload
                )
            raise GmailApiError(
                f"Gmail API request failed ({response.status_code})",
                status_code=502,
                payload=payload,
            )
        return payload if isinstance(payload, dict) else {}

    async def _register_watch(self, *, access_token: str) -> dict[str, Any]:
        if not self._watch_enabled():
            return {
                "watch_status": "not_configured",
                "watch_expiration_at": None,
                "history_id": None,
            }

        payload = {
            "topicName": self._watch_topic_name(),
            "labelIds": self._watch_label_ids(),
            "labelFilterAction": "include",
        }
        response = await self._http_post_json(_GMAIL_WATCH_URL, token=access_token, payload=payload)
        return {
            "watch_status": "active",
            "watch_expiration_at": _google_epoch_ms_to_datetime(response.get("expiration")),
            "history_id": _history_id_text(response.get("historyId")),
        }

    async def start_connect(
        self,
        *,
        user_id: str,
        redirect_uri: str | None,
        login_hint: str | None,
        include_granted_scopes: bool,
    ) -> dict[str, Any]:
        if not self.is_configured():
            raise GmailApiError("Gmail OAuth is not configured", status_code=503)

        resolved_redirect = _clean_text(redirect_uri) or self._oauth_redirect_uri()
        state = self._build_state_token(user_id=user_id, redirect_uri=resolved_redirect)

        scope = " ".join(
            [
                "openid",
                "email",
                "profile",
                "https://www.googleapis.com/auth/gmail.readonly",
            ]
        )

        prompt = "consent"
        if not _clean_text(login_hint):
            prompt = "consent select_account"

        query = {
            "client_id": self._oauth_client_id(),
            "redirect_uri": resolved_redirect,
            "response_type": "code",
            "scope": scope,
            "access_type": "offline",
            "include_granted_scopes": "true" if include_granted_scopes else "false",
            "state": state,
            "prompt": prompt,
        }
        if _clean_text(login_hint):
            query["login_hint"] = _clean_text(login_hint)

        authorize_url = f"{_GOOGLE_OAUTH_AUTHORIZE_URL}?{urlencode(query)}"

        logger.info(
            "gmail.connect.start user_id=%s include_granted_scopes=%s has_login_hint=%s",
            user_id,
            include_granted_scopes,
            bool(_clean_text(login_hint)),
        )

        return {
            "configured": True,
            "authorize_url": authorize_url,
            "state": state,
            "redirect_uri": resolved_redirect,
            "expires_at": (_utcnow() + timedelta(minutes=10)).isoformat().replace("+00:00", "Z"),
        }

    async def _exchange_code(self, *, code: str, redirect_uri: str) -> dict[str, Any]:
        data = {
            "code": code,
            "client_id": self._oauth_client_id(),
            "client_secret": self._oauth_client_secret(),
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }
        return await self._http_post_form(_GOOGLE_OAUTH_TOKEN_URL, data)

    async def _refresh_access_token(self, *, refresh_token: str) -> dict[str, Any]:
        data = {
            "client_id": self._oauth_client_id(),
            "client_secret": self._oauth_client_secret(),
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }
        return await self._http_post_form(_GOOGLE_OAUTH_TOKEN_URL, data)

    def _decode_id_token_claims(self, id_token: str | None) -> dict[str, Any]:
        token = _clean_text(id_token)
        if not token or token.count(".") < 2:
            return {}
        parts = token.split(".")
        try:
            payload = _b64url_decode(parts[1]).decode("utf-8")
            parsed = json.loads(payload)
        except Exception:
            return {}
        return parsed if isinstance(parsed, dict) else {}

    def _fetch_connection_row(self, *, user_id: str) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_gmail_connections
            WHERE user_id = :user_id
            LIMIT 1
            """,
            {"user_id": user_id},
        )
        return result.data[0] if result.data else None

    def _fetch_connection_row_by_email(self, *, google_email: str) -> dict[str, Any] | None:
        normalized = _clean_text(google_email).lower()
        if not normalized:
            return None
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_gmail_connections
            WHERE LOWER(google_email) = :google_email
            LIMIT 1
            """,
            {"google_email": normalized},
        )
        return result.data[0] if result.data else None

    def _count_receipts(self, *, user_id: str) -> int:
        result = self.db.execute_raw(
            "SELECT COUNT(*) AS total FROM kai_gmail_receipts WHERE user_id = :user_id",
            {"user_id": user_id},
        ).data
        if not result:
            return 0
        return int(result[0].get("total") or 0)

    def _mark_connection_needs_reauth(self, *, user_id: str, message: str) -> None:
        self.db.execute_raw(
            """
            UPDATE kai_gmail_connections
            SET status = 'error',
                revoked = TRUE,
                auto_sync_enabled = FALSE,
                watch_status = CASE
                    WHEN watch_status = 'not_configured' THEN watch_status
                    ELSE 'failed'
                END,
                last_sync_status = 'failed',
                last_sync_error = :message,
                status_refreshed_at = NOW(),
                updated_at = NOW()
            WHERE user_id = :user_id
            """,
            {"user_id": user_id, "message": message},
        )

    def _update_watch_snapshot(
        self,
        *,
        user_id: str,
        watch_status: str,
        watch_expiration_at: datetime | None,
        history_id: str | None = None,
    ) -> None:
        self.db.execute_raw(
            """
            UPDATE kai_gmail_connections
            SET watch_status = :watch_status,
                watch_expiration_at = :watch_expiration_at,
                last_watch_renewed_at = CASE
                    WHEN :watch_expiration_at IS NOT NULL THEN NOW()
                    ELSE last_watch_renewed_at
                END,
                history_id = COALESCE(:history_id, history_id),
                status_refreshed_at = NOW(),
                updated_at = NOW()
            WHERE user_id = :user_id
            """,
            {
                "user_id": user_id,
                "watch_status": watch_status,
                "watch_expiration_at": watch_expiration_at,
                "history_id": history_id,
            },
        )

    def _derive_watch_status(self, row: dict[str, Any] | None) -> str:
        if row is None:
            return "not_configured" if not self._watch_enabled() else "unknown"
        stored = _clean_text(row.get("watch_status"))
        expiration_at = _parse_iso(row.get("watch_expiration_at"))
        now = _utcnow()
        if not self._watch_enabled():
            return "not_configured"
        if stored == "failed":
            return "failed"
        if expiration_at is None:
            return stored or "unknown"
        if expiration_at <= now:
            return "expired"
        if expiration_at <= now + timedelta(seconds=self._watch_renew_before_seconds()):
            return "expiring"
        return stored or "active"

    def _derive_connection_state(self, row: dict[str, Any] | None) -> str:
        if not self.is_configured():
            return "not_configured"
        if not row:
            return "not_connected"
        status_text = _clean_text(row.get("status"), "disconnected")
        revoked = _to_bool(row.get("revoked"), False)
        if status_text == "connected" and not revoked:
            return "connected"
        if status_text == "error" or revoked:
            return "needs_reauth"
        return "not_connected"

    def _derive_sync_state(
        self, *, row: dict[str, Any] | None, latest_run: dict[str, Any] | None
    ) -> str:
        bootstrap_state = _clean_text(row.get("bootstrap_state"), "idle") if row else "idle"
        last_sync_status = _clean_text(row.get("last_sync_status"), "idle") if row else "idle"
        run_status = _clean_text(latest_run.get("status")) if latest_run else ""
        run_mode = _clean_text(latest_run.get("sync_mode")) if latest_run else ""
        if run_status in {"queued", "running"}:
            if run_mode in {"bootstrap", "recovery"} or bootstrap_state in {"queued", "running"}:
                return "bootstrap_running"
            if run_mode == "backfill":
                return "backfill_running"
            if run_mode == "incremental":
                return "incremental_running"
            return "syncing"
        if bootstrap_state == "failed" or last_sync_status == "failed":
            return "failed"
        if bootstrap_state == "queued":
            return "bootstrap_running"
        return "idle"

    def _serialize_status_payload(
        self,
        *,
        user_id: str,
        row: dict[str, Any] | None,
        latest_run: dict[str, Any] | None,
    ) -> dict[str, Any]:
        receipt_total = self._count_receipts(user_id=user_id)
        connection_state = self._derive_connection_state(row)
        watch_status = self._derive_watch_status(row)
        connected = connection_state == "connected"
        status_text = "disconnected"
        if row:
            status_text = _clean_text(row.get("status"), "disconnected")
        if connection_state == "needs_reauth":
            status_text = "error"
        elif connection_state == "not_connected":
            status_text = "disconnected"
        elif connection_state == "connected":
            status_text = "connected"

        return {
            "configured": self.is_configured(),
            "connected": connected,
            "status": status_text,
            "google_email": (_clean_text(row.get("google_email")) or None) if row else None,
            "google_sub": (_clean_text(row.get("google_sub")) or None) if row else None,
            "scope_csv": _clean_text(row.get("scope_csv")) if row else "",
            "last_sync_at": row.get("last_sync_at") if row else None,
            "last_sync_status": _clean_text(row.get("last_sync_status"), "idle") if row else "idle",
            "last_sync_error": (_clean_text(row.get("last_sync_error")) or None) if row else None,
            "auto_sync_enabled": _to_bool(row.get("auto_sync_enabled"), False) if row else False,
            "revoked": _to_bool(row.get("revoked"), False) if row else False,
            "connected_at": row.get("connected_at") if row else None,
            "disconnected_at": row.get("disconnected_at") if row else None,
            "latest_run": self._serialize_run(latest_run),
            "connection_state": connection_state,
            "sync_state": self._derive_sync_state(row=row, latest_run=latest_run),
            "bootstrap_state": _clean_text(row.get("bootstrap_state"), "idle") if row else "idle",
            "watch_status": watch_status,
            "watch_expires_at": row.get("watch_expiration_at") if row else None,
            "status_refreshed_at": row.get("status_refreshed_at") if row else None,
            "last_notification_at": row.get("last_notification_at") if row else None,
            "needs_reauth": connection_state == "needs_reauth",
            "receipt_counts": {"total": receipt_total},
        }

    async def complete_connect(
        self,
        *,
        user_id: str,
        code: str,
        state: str,
        redirect_uri: str | None,
    ) -> dict[str, Any]:
        if not self.is_configured():
            raise GmailApiError("Gmail OAuth is not configured", status_code=503)

        resolved_redirect = _clean_text(redirect_uri) or self._oauth_redirect_uri()
        self._verify_state_token(state=state, user_id=user_id, redirect_uri=resolved_redirect)

        token_payload = await self._exchange_code(code=code, redirect_uri=resolved_redirect)
        access_token = _clean_text(token_payload.get("access_token"))
        refresh_token = _clean_text(token_payload.get("refresh_token"))
        scope_csv = _clean_text(token_payload.get("scope"))
        expires_in = int(token_payload.get("expires_in") or 3600)
        id_token = _clean_text(token_payload.get("id_token"))

        if not access_token:
            raise GmailApiError("Google OAuth did not return an access token", status_code=502)

        profile = await self._http_get_json(_GMAIL_PROFILE_URL, token=access_token)
        claims = self._decode_id_token_claims(id_token)
        profile_history_id = _history_id_text(profile.get("historyId"))

        existing = self._fetch_connection_row(user_id=user_id)
        if not refresh_token and existing:
            refresh_token = (
                self._decrypt_token(
                    existing.get("refresh_token_ciphertext"),
                    existing.get("refresh_token_iv"),
                    existing.get("refresh_token_tag"),
                )
                or ""
            )
        if not refresh_token:
            raise GmailApiError(
                "Google did not return a refresh token. Reconnect and grant consent again.",
                status_code=400,
            )

        refresh_env = self._encrypt_token(refresh_token)
        access_env = self._encrypt_token(access_token)
        expires_at = _utcnow() + timedelta(seconds=max(60, expires_in))
        watch_state = {
            "watch_status": "not_configured" if not self._watch_enabled() else "unknown",
            "watch_expiration_at": None,
            "history_id": profile_history_id,
        }
        try:
            watch_state = {
                **watch_state,
                **(await self._register_watch(access_token=access_token)),
            }
        except Exception as exc:
            logger.warning(
                "gmail.connect.watch_registration_failed user_id=%s reason=%s", user_id, exc
            )
            watch_state["watch_status"] = "failed"

        initial_history_id = _max_history_id_text(
            watch_state.get("history_id"),
            profile_history_id,
            existing.get("history_id") if existing else None,
        )
        bootstrap_window_end = _utcnow()
        bootstrap_window_start = bootstrap_window_end - timedelta(
            days=self._bootstrap_recent_days()
        )

        self.db.execute_raw(
            """
            INSERT INTO kai_gmail_connections (
                user_id,
                google_email,
                google_sub,
                scope_csv,
                status,
                refresh_token_ciphertext,
                refresh_token_iv,
                refresh_token_tag,
                access_token_ciphertext,
                access_token_iv,
                access_token_tag,
                access_token_expires_at,
                auto_sync_enabled,
                revoked,
                history_id,
                watch_status,
                watch_expiration_at,
                last_watch_renewed_at,
                last_notification_at,
                bootstrap_state,
                bootstrap_completed_at,
                status_refreshed_at,
                connected_at,
                disconnected_at,
                token_updated_at,
                last_sync_status,
                last_sync_error,
                updated_at
            ) VALUES (
                :user_id,
                :google_email,
                :google_sub,
                :scope_csv,
                'connected',
                :refresh_token_ciphertext,
                :refresh_token_iv,
                :refresh_token_tag,
                :access_token_ciphertext,
                :access_token_iv,
                :access_token_tag,
                :access_token_expires_at,
                TRUE,
                FALSE,
                :history_id,
                :watch_status,
                :watch_expiration_at,
                CASE WHEN :watch_expiration_at IS NOT NULL THEN NOW() ELSE NULL END,
                NULL,
                'queued',
                NULL,
                NOW(),
                NOW(),
                NULL,
                NOW(),
                'idle',
                NULL,
                NOW()
            )
            ON CONFLICT (user_id) DO UPDATE SET
                google_email = EXCLUDED.google_email,
                google_sub = EXCLUDED.google_sub,
                scope_csv = EXCLUDED.scope_csv,
                status = 'connected',
                refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
                refresh_token_iv = EXCLUDED.refresh_token_iv,
                refresh_token_tag = EXCLUDED.refresh_token_tag,
                access_token_ciphertext = EXCLUDED.access_token_ciphertext,
                access_token_iv = EXCLUDED.access_token_iv,
                access_token_tag = EXCLUDED.access_token_tag,
                access_token_expires_at = EXCLUDED.access_token_expires_at,
                auto_sync_enabled = TRUE,
                revoked = FALSE,
                history_id = COALESCE(EXCLUDED.history_id, kai_gmail_connections.history_id),
                watch_status = EXCLUDED.watch_status,
                watch_expiration_at = EXCLUDED.watch_expiration_at,
                last_watch_renewed_at = CASE
                    WHEN EXCLUDED.watch_expiration_at IS NOT NULL THEN NOW()
                    ELSE kai_gmail_connections.last_watch_renewed_at
                END,
                last_notification_at = NULL,
                bootstrap_state = 'queued',
                bootstrap_completed_at = NULL,
                status_refreshed_at = NOW(),
                connected_at = COALESCE(kai_gmail_connections.connected_at, NOW()),
                disconnected_at = NULL,
                token_updated_at = NOW(),
                last_sync_status = 'idle',
                last_sync_error = NULL,
                updated_at = NOW()
            """,
            {
                "user_id": user_id,
                "google_email": _clean_text(profile.get("emailAddress"))
                or _clean_text(claims.get("email"))
                or None,
                "google_sub": _clean_text(claims.get("sub")) or None,
                "scope_csv": scope_csv,
                "refresh_token_ciphertext": refresh_env["ciphertext"],
                "refresh_token_iv": refresh_env["iv"],
                "refresh_token_tag": refresh_env["tag"],
                "access_token_ciphertext": access_env["ciphertext"],
                "access_token_iv": access_env["iv"],
                "access_token_tag": access_env["tag"],
                "access_token_expires_at": expires_at,
                "history_id": initial_history_id,
                "watch_status": watch_state.get("watch_status"),
                "watch_expiration_at": watch_state.get("watch_expiration_at"),
            },
        )

        logger.info(
            "gmail.connect.complete user_id=%s email=%s",
            user_id,
            _clean_text(profile.get("emailAddress"), "unknown"),
        )

        # Kick off bootstrap sync in the background. The caller only waits for
        # auth exchange + watch registration + snapshot persistence.
        try:
            await self.queue_sync(
                user_id=user_id,
                trigger_source="connect",
                sync_mode="bootstrap",
                window_start_at=bootstrap_window_start,
                window_end_at=bootstrap_window_end,
            )
        except Exception as exc:
            logger.warning("gmail.connect.queue_failed user_id=%s reason=%s", user_id, exc)
            message = _clean_text(str(exc)) or (
                "Gmail connected, but the first sync could not start. Try Sync now."
            )
            self._update_connection_sync_status(
                user_id=user_id,
                status="failed",
                error_message=message,
            )
            self.db.execute_raw(
                """
                UPDATE kai_gmail_connections
                SET bootstrap_state = 'failed',
                    updated_at = NOW()
                WHERE user_id = :user_id
                """,
                {"user_id": user_id},
            )

        return await self.get_status(user_id=user_id)

    async def _revoke_refresh_token(self, refresh_token: str) -> None:
        try:
            await self._http_post_form(
                _GOOGLE_OAUTH_REVOKE_URL,
                {"token": refresh_token},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        except Exception:
            # Revoke failures should not block disconnect.
            logger.warning("gmail.disconnect.revoke_failed")

    async def disconnect(self, *, user_id: str) -> dict[str, Any]:
        row = self._fetch_connection_row(user_id=user_id)
        if row:
            active_runs = self.db.execute_raw(
                """
                SELECT run_id, user_id, status
                FROM kai_gmail_sync_runs
                WHERE user_id = :user_id
                  AND status IN ('queued', 'running')
                ORDER BY requested_at DESC
                """,
                {"user_id": user_id},
            ).data
            for active_run in active_runs:
                run_id = _clean_text(active_run.get("run_id"))
                if not run_id:
                    continue
                self._mark_run_terminal(
                    run_id=run_id,
                    status="canceled",
                    error_message=_RUN_CANCELED_MESSAGE,
                )
                task = self._sync_tasks_by_run_id.get(run_id)
                if task is None:
                    continue
                try:
                    task.cancel()
                except Exception:
                    logger.warning("gmail.disconnect.cancel_task_failed run_id=%s", run_id)

            refresh_token = self._decrypt_token(
                row.get("refresh_token_ciphertext"),
                row.get("refresh_token_iv"),
                row.get("refresh_token_tag"),
            )
            if refresh_token:
                await self._revoke_refresh_token(refresh_token)

            self.db.execute_raw(
                """
                UPDATE kai_gmail_connections
                SET status = 'disconnected',
                    revoked = TRUE,
                    auto_sync_enabled = FALSE,
                    refresh_token_ciphertext = NULL,
                    refresh_token_iv = NULL,
                    refresh_token_tag = NULL,
                    access_token_ciphertext = NULL,
                    access_token_iv = NULL,
                    access_token_tag = NULL,
                    access_token_expires_at = NULL,
                    watch_status = CASE
                        WHEN :watch_enabled THEN 'expired'
                        ELSE 'not_configured'
                    END,
                    watch_expiration_at = NULL,
                    last_watch_renewed_at = NULL,
                    last_notification_at = NULL,
                    bootstrap_state = 'idle',
                    bootstrap_completed_at = NULL,
                    last_sync_status = 'idle',
                    last_sync_error = NULL,
                    disconnected_at = NOW(),
                    status_refreshed_at = NOW(),
                    token_updated_at = NOW(),
                    updated_at = NOW()
                WHERE user_id = :user_id
                """,
                {"user_id": user_id, "watch_enabled": self._watch_enabled()},
            )

        logger.info("gmail.disconnect user_id=%s", user_id)
        return await self.get_status(user_id=user_id)

    def _is_connection_sync_active(self, *, user_id: str) -> bool:
        row = self._fetch_connection_row(user_id=user_id)
        if row is None:
            return False
        return _clean_text(row.get("status")) == "connected" and not _to_bool(
            row.get("revoked"), False
        )

    async def _ensure_access_token(self, *, user_id: str) -> tuple[str, dict[str, Any]]:
        row = self._fetch_connection_row(user_id=user_id)
        if not row:
            raise GmailApiError("Gmail is not connected for this user", status_code=404)

        if _clean_text(row.get("status")) != "connected":
            raise GmailApiError("Gmail connection is not active", status_code=400)

        access_token = self._decrypt_token(
            row.get("access_token_ciphertext"),
            row.get("access_token_iv"),
            row.get("access_token_tag"),
        )
        expires_at = _parse_iso(row.get("access_token_expires_at"))

        if access_token and expires_at and expires_at > (_utcnow() + timedelta(seconds=90)):
            return access_token, row

        refresh_token = self._decrypt_token(
            row.get("refresh_token_ciphertext"),
            row.get("refresh_token_iv"),
            row.get("refresh_token_tag"),
        )
        if not refresh_token:
            message = "Stored Gmail refresh token is missing. Reconnect Gmail to continue."
            self._mark_connection_needs_reauth(user_id=user_id, message=message)
            raise GmailApiError(message, status_code=401)

        try:
            refreshed = await self._refresh_access_token(refresh_token=refresh_token)
        except GmailApiError as exc:
            if exc.status_code in {400, 401, 403, 404, 502}:
                message = (
                    _clean_text(exc.message)
                    or "Gmail token refresh failed. Reconnect Gmail to continue."
                )
                self._mark_connection_needs_reauth(user_id=user_id, message=message)
                raise GmailApiError(message, status_code=401, payload=exc.payload) from exc
            raise
        next_access = _clean_text(refreshed.get("access_token"))
        next_expires = int(refreshed.get("expires_in") or 3600)
        next_refresh = _clean_text(refreshed.get("refresh_token")) or refresh_token
        if not next_access:
            message = "Gmail token refresh did not return an access token. Reconnect Gmail."
            self._mark_connection_needs_reauth(user_id=user_id, message=message)
            raise GmailApiError(message, status_code=401)

        access_env = self._encrypt_token(next_access)
        refresh_env = self._encrypt_token(next_refresh)
        expires_value = _utcnow() + timedelta(seconds=max(60, next_expires))

        self.db.execute_raw(
            """
            UPDATE kai_gmail_connections
            SET access_token_ciphertext = :access_token_ciphertext,
                access_token_iv = :access_token_iv,
                access_token_tag = :access_token_tag,
                refresh_token_ciphertext = :refresh_token_ciphertext,
                refresh_token_iv = :refresh_token_iv,
                refresh_token_tag = :refresh_token_tag,
                access_token_expires_at = :access_token_expires_at,
                token_updated_at = NOW(),
                status_refreshed_at = NOW(),
                updated_at = NOW()
            WHERE user_id = :user_id
            """,
            {
                "user_id": user_id,
                "access_token_ciphertext": access_env["ciphertext"],
                "access_token_iv": access_env["iv"],
                "access_token_tag": access_env["tag"],
                "refresh_token_ciphertext": refresh_env["ciphertext"],
                "refresh_token_iv": refresh_env["iv"],
                "refresh_token_tag": refresh_env["tag"],
                "access_token_expires_at": expires_value,
            },
        )

        latest = self._fetch_connection_row(user_id=user_id) or row
        return next_access, latest

    def _build_receipt_query(
        self, *, query_since: datetime, query_before: datetime | None = None
    ) -> str:
        since_unix = int(query_since.timestamp())
        query = (
            "("
            "category:purchases "
            "OR subject:(receipt OR invoice OR order OR payment OR transaction) "
            'OR ("thank you for your order" OR "order confirmation" OR "order total" '
            'OR "amount paid" OR "payment received")'
            ") "
            f"after:{since_unix} -category:spam"
        )
        if query_before is not None:
            query = f"{query} before:{int(query_before.timestamp())}"
        return query

    async def _list_messages(
        self,
        *,
        access_token: str,
        query_text: str,
        page_token: str | None,
        max_results: int,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "q": query_text,
            "maxResults": max_results,
            "includeSpamTrash": "false",
        }
        if _clean_text(page_token):
            params["pageToken"] = _clean_text(page_token)
        return await self._http_get_json(_GMAIL_MESSAGES_URL, token=access_token, params=params)

    async def _get_message_metadata(
        self, *, access_token: str, gmail_message_id: str
    ) -> dict[str, Any]:
        return await self._http_get_json(
            f"{_GMAIL_MESSAGES_URL}/{gmail_message_id}",
            token=access_token,
            params={
                "format": "metadata",
                "metadataHeaders": ["From", "Subject", "Date", "Message-ID"],
            },
        )

    async def _get_message_metadata_batch(
        self, *, access_token: str, gmail_message_ids: list[str]
    ) -> list[dict[str, Any]]:
        if not gmail_message_ids:
            return []
        results = await asyncio.gather(
            *[
                self._get_message_metadata(access_token=access_token, gmail_message_id=message_id)
                for message_id in gmail_message_ids
            ],
            return_exceptions=True,
        )
        payloads: list[dict[str, Any]] = []
        for message_id, result in zip(gmail_message_ids, results, strict=False):
            if isinstance(result, Exception):
                logger.warning(
                    "gmail.sync.message_batch_failed gmail_message_id=%s reason=%s",
                    message_id,
                    str(result)[:_RUN_MESSAGE_FAILED_LOG_LIMIT],
                )
                continue
            payloads.append(result)
        return payloads

    async def _list_history(
        self,
        *,
        access_token: str,
        start_history_id: str,
        page_token: str | None,
        max_results: int = 100,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "startHistoryId": start_history_id,
            "maxResults": max_results,
            "historyTypes": ["messageAdded", "labelAdded"],
        }
        if _clean_text(page_token):
            params["pageToken"] = _clean_text(page_token)
        return await self._http_get_json(_GMAIL_HISTORY_URL, token=access_token, params=params)

    def _message_ids_from_history(self, payload: dict[str, Any]) -> list[str]:
        history_entries = payload.get("history") if isinstance(payload.get("history"), list) else []
        seen: set[str] = set()
        message_ids: list[str] = []
        for entry in history_entries:
            if not isinstance(entry, dict):
                continue
            for key in ("messagesAdded", "labelsAdded", "messages"):
                records = entry.get(key)
                if not isinstance(records, list):
                    continue
                for record in records:
                    message_obj = record
                    if isinstance(record, dict) and isinstance(record.get("message"), dict):
                        message_obj = record.get("message")
                    if not isinstance(message_obj, dict):
                        continue
                    message_id = _clean_text(message_obj.get("id"))
                    if not message_id or message_id in seen:
                        continue
                    seen.add(message_id)
                    message_ids.append(message_id)
        return message_ids

    def _extract_headers(self, payload: dict[str, Any]) -> dict[str, str]:
        headers = payload.get("payload", {}).get("headers", [])
        out: dict[str, str] = {}
        if isinstance(headers, list):
            for entry in headers:
                if not isinstance(entry, dict):
                    continue
                name = _clean_text(entry.get("name")).lower()
                value = _clean_text(entry.get("value"))
                if name and value:
                    out[name] = value
        return out

    def _parse_from_header(self, value: str) -> tuple[str | None, str | None]:
        raw = _clean_text(value)
        if not raw:
            return None, None
        if "<" in raw and ">" in raw:
            name = raw.split("<", 1)[0].strip().strip('"')
            email = raw.split("<", 1)[1].split(">", 1)[0].strip().lower()
            return (name or None, email or None)
        if "@" in raw:
            return None, raw.lower()
        return raw, None

    def _candidate_from_message(self, payload: dict[str, Any]) -> ReceiptCandidate:
        headers = self._extract_headers(payload)
        subject = _clean_text(headers.get("subject")) or _clean_text(payload.get("snippet"))
        snippet = _clean_text(payload.get("snippet"))
        from_name, from_email = self._parse_from_header(_clean_text(headers.get("from")))
        internal_date: datetime | None = None

        raw_internal = _clean_text(payload.get("internalDate"))
        if raw_internal.isdigit():
            try:
                internal_date = datetime.fromtimestamp(int(raw_internal) / 1000.0, tz=timezone.utc)
            except Exception:
                internal_date = None

        if internal_date is None:
            try:
                parsed = parsedate_to_datetime(_clean_text(headers.get("date")))
                internal_date = (
                    parsed.astimezone(timezone.utc)
                    if parsed.tzinfo
                    else parsed.replace(tzinfo=timezone.utc)
                )
            except Exception:
                internal_date = None

        labels = payload.get("labelIds") if isinstance(payload.get("labelIds"), list) else []
        normalized_labels = [str(label).strip().upper() for label in labels if str(label).strip()]

        return ReceiptCandidate(
            gmail_message_id=_clean_text(payload.get("id")),
            gmail_thread_id=_clean_text(payload.get("threadId")) or None,
            gmail_internal_date=internal_date,
            gmail_history_id=_clean_text(payload.get("historyId")) or None,
            labels=normalized_labels,
            subject=subject,
            snippet=snippet,
            from_name=from_name,
            from_email=from_email,
            message_id_header=_clean_text(headers.get("message-id")) or None,
        )

    def _classify_candidate(self, candidate: ReceiptCandidate) -> dict[str, Any]:
        score = 0.0
        reasons: list[str] = []
        combined_text = f"{candidate.subject} {candidate.snippet}"

        if "CATEGORY_PURCHASES" in candidate.labels:
            score += 0.55
            reasons.append("gmail_category_purchases")

        if _RECEIPT_SUBJECT_RE.search(candidate.subject):
            score += 0.30
            reasons.append("subject_keyword")

        if _RECEIPT_SNIPPET_RE.search(candidate.snippet):
            score += 0.20
            reasons.append("snippet_keyword")

        if _ORDER_ID_RE.search(combined_text):
            score += 0.25
            reasons.append("order_id_signal")

        if _AMOUNT_RE.search(combined_text):
            score += 0.20
            reasons.append("amount_signal")

        domain = _email_domain(candidate.from_email)
        if domain:
            host = domain.split(".", 1)[0]
            if host in _MERCHANT_HINTS:
                score += 0.20
                reasons.append("merchant_domain_hint")

        likely = score >= 0.50
        needs_llm = not likely and score >= 0.25

        return {
            "is_receipt": likely,
            "needs_llm": needs_llm,
            "confidence": min(0.99, round(score, 5)),
            "source": "deterministic",
            "reasons": reasons,
        }

    async def _llm_extract_candidate(self, candidate: ReceiptCandidate) -> dict[str, Any] | None:
        if not self._llm_fallback_enabled():
            return None
        api_key = _clean_text(os.getenv("GOOGLE_API_KEY"))
        if not api_key:
            return None

        try:
            from google import genai  # type: ignore
            from google.genai import types as genai_types  # type: ignore
        except Exception:
            return None

        prompt = (
            "Classify if this email metadata represents a purchase receipt. "
            "Respond ONLY JSON with keys: is_receipt(boolean), confidence(number), "
            "merchant_name(string|null), order_id(string|null), amount(number|null), currency(string|null).\n"
            f"Subject: {candidate.subject}\n"
            f"From: {candidate.from_email or ''}\n"
            f"Snippet: {candidate.snippet}\n"
            f"Labels: {','.join(candidate.labels)}"
        )

        try:
            client = genai.Client(api_key=api_key)
            response = await client.aio.models.generate_content(
                model=self._llm_model(),
                contents=prompt,
                config=genai_types.GenerateContentConfig(temperature=0),
            )
            text = _clean_text(getattr(response, "text", ""))
            if not text:
                return None
            start = text.find("{")
            end = text.rfind("}")
            if start < 0 or end <= start:
                return None
            parsed = json.loads(text[start : end + 1])
            if not isinstance(parsed, dict):
                return None
            is_receipt = _to_bool(parsed.get("is_receipt"), False)
            confidence = float(parsed.get("confidence") or 0)
            if confidence <= 0:
                confidence = 0.45
            return {
                "is_receipt": is_receipt,
                "confidence": min(0.99, max(0.0, confidence)),
                "merchant_name": _clean_text(parsed.get("merchant_name")) or None,
                "order_id": _clean_text(parsed.get("order_id")) or None,
                "amount": parsed.get("amount"),
                "currency": _clean_text(parsed.get("currency")) or None,
                "source": "llm",
            }
        except Exception as exc:
            logger.warning("gmail.sync.llm_fallback_failed reason=%s", exc)
            return None

    def _extract_receipt_fields(
        self,
        *,
        candidate: ReceiptCandidate,
        classification: dict[str, Any],
        llm_payload: dict[str, Any] | None,
    ) -> dict[str, Any]:
        merchant_name = _clean_text(candidate.from_name)
        if not merchant_name and candidate.from_email:
            merchant_name = candidate.from_email.split("@", 1)[0].replace(".", " ").strip()

        order_match = _ORDER_ID_RE.search(f"{candidate.subject} {candidate.snippet}")
        order_id = order_match.group(1).upper() if order_match else None

        amount_match = _AMOUNT_RE.search(f"{candidate.subject} {candidate.snippet}")
        amount_value = None
        currency = None
        if amount_match:
            try:
                amount_value = float(amount_match.group(1).replace(",", ""))
                currency = _currency_from_symbol(amount_match.group(0))
            except Exception:
                amount_value = None

        if llm_payload:
            if _clean_text(llm_payload.get("merchant_name")):
                merchant_name = _clean_text(llm_payload.get("merchant_name"))
            if _clean_text(llm_payload.get("order_id")):
                order_id = _clean_text(llm_payload.get("order_id"))
            if llm_payload.get("amount") is not None:
                try:
                    amount_value = float(llm_payload.get("amount"))
                except Exception:
                    pass
            if _clean_text(llm_payload.get("currency")):
                currency = _clean_text(llm_payload.get("currency")).upper()

        receipt_date = candidate.gmail_internal_date or _utcnow()
        checksum_input = "|".join(
            [
                candidate.gmail_message_id,
                _clean_text(candidate.gmail_thread_id),
                _clean_text(candidate.message_id_header),
                _clean_text(merchant_name).lower(),
                f"{amount_value:.2f}" if isinstance(amount_value, float) else "",
                _clean_text(currency).upper(),
                _clean_text(order_id).upper(),
                _clean_text(candidate.from_email).lower(),
                _clean_text(candidate.subject).lower(),
                receipt_date.date().isoformat() if receipt_date else "",
            ]
        )
        checksum = (
            hashlib.sha256(checksum_input.encode("utf-8")).hexdigest() if checksum_input else None
        )

        return {
            "merchant_name": merchant_name or None,
            "order_id": order_id,
            "amount": amount_value,
            "currency": currency,
            "receipt_date": receipt_date,
            "classification_confidence": float(classification.get("confidence") or 0),
            "classification_source": _clean_text(classification.get("source"), "deterministic"),
            "receipt_checksum": checksum,
        }

    def _upsert_receipt(
        self, *, user_id: str, candidate: ReceiptCandidate, extracted: dict[str, Any]
    ) -> bool:
        result = self.db.execute_raw(
            """
            INSERT INTO kai_gmail_receipts (
                user_id,
                gmail_message_id,
                gmail_thread_id,
                gmail_internal_date,
                gmail_history_id,
                subject,
                snippet,
                from_name,
                from_email,
                merchant_name,
                order_id,
                currency,
                amount,
                receipt_date,
                classification_confidence,
                classification_source,
                receipt_checksum,
                raw_reference_json,
                updated_at
            ) VALUES (
                :user_id,
                :gmail_message_id,
                :gmail_thread_id,
                :gmail_internal_date,
                :gmail_history_id,
                :subject,
                :snippet,
                :from_name,
                :from_email,
                :merchant_name,
                :order_id,
                :currency,
                :amount,
                :receipt_date,
                :classification_confidence,
                :classification_source,
                :receipt_checksum,
                CAST(:raw_reference_json AS jsonb),
                NOW()
            )
            ON CONFLICT (user_id, gmail_message_id)
            DO UPDATE SET
                gmail_thread_id = EXCLUDED.gmail_thread_id,
                gmail_internal_date = EXCLUDED.gmail_internal_date,
                gmail_history_id = EXCLUDED.gmail_history_id,
                subject = EXCLUDED.subject,
                snippet = EXCLUDED.snippet,
                from_name = EXCLUDED.from_name,
                from_email = EXCLUDED.from_email,
                merchant_name = EXCLUDED.merchant_name,
                order_id = EXCLUDED.order_id,
                currency = EXCLUDED.currency,
                amount = EXCLUDED.amount,
                receipt_date = EXCLUDED.receipt_date,
                classification_confidence = EXCLUDED.classification_confidence,
                classification_source = EXCLUDED.classification_source,
                receipt_checksum = EXCLUDED.receipt_checksum,
                raw_reference_json = EXCLUDED.raw_reference_json,
                updated_at = NOW()
            RETURNING (xmax = 0) AS inserted_new
            """,
            {
                "user_id": user_id,
                "gmail_message_id": candidate.gmail_message_id,
                "gmail_thread_id": candidate.gmail_thread_id,
                "gmail_internal_date": candidate.gmail_internal_date,
                "gmail_history_id": candidate.gmail_history_id,
                "subject": candidate.subject,
                "snippet": candidate.snippet,
                "from_name": candidate.from_name,
                "from_email": candidate.from_email,
                "merchant_name": extracted.get("merchant_name"),
                "order_id": extracted.get("order_id"),
                "currency": extracted.get("currency"),
                "amount": extracted.get("amount"),
                "receipt_date": extracted.get("receipt_date"),
                "classification_confidence": extracted.get("classification_confidence"),
                "classification_source": extracted.get("classification_source"),
                "receipt_checksum": extracted.get("receipt_checksum"),
                "raw_reference_json": json.dumps(
                    {
                        "labels": candidate.labels,
                        "message_id_header": candidate.message_id_header,
                    }
                ),
            },
        )
        if not result.data:
            return False
        inserted_raw = result.data[0].get("inserted_new")
        if isinstance(inserted_raw, bool):
            return inserted_raw
        if isinstance(inserted_raw, str):
            return inserted_raw.strip().lower() in {"1", "true", "t", "yes", "on"}
        if isinstance(inserted_raw, (int, float)):
            return bool(inserted_raw)
        return False

    def _latest_sync_run(self, *, user_id: str) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_gmail_sync_runs
            WHERE user_id = :user_id
            ORDER BY requested_at DESC
            LIMIT 1
            """,
            {"user_id": user_id},
        )
        return result.data[0] if result.data else None

    def _serialize_run(self, row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        return {
            "run_id": _clean_text(row.get("run_id")),
            "user_id": _clean_text(row.get("user_id")),
            "trigger_source": _clean_text(row.get("trigger_source")),
            "sync_mode": _clean_text(row.get("sync_mode"), "manual"),
            "status": _clean_text(row.get("status"), "unknown"),
            "start_history_id": _history_id_text(row.get("start_history_id")),
            "end_history_id": _history_id_text(row.get("end_history_id")),
            "window_start_at": row.get("window_start_at"),
            "window_end_at": row.get("window_end_at"),
            "requested_at": row.get("requested_at"),
            "started_at": row.get("started_at"),
            "completed_at": row.get("completed_at"),
            "listed_count": int(row.get("listed_count") or 0),
            "filtered_count": int(row.get("filtered_count") or 0),
            "synced_count": int(row.get("synced_count") or 0),
            "extracted_count": int(row.get("extracted_count") or 0),
            "duplicates_dropped": int(row.get("duplicates_dropped") or 0),
            "extraction_success_rate": float(row.get("extraction_success_rate") or 0),
            "error_message": _clean_text(row.get("error_message")) or None,
            "metrics": _safe_json_obj(row.get("metrics_json")),
        }

    async def get_status(self, *, user_id: str) -> dict[str, Any]:
        self._reconcile_active_runs(user_id=user_id)
        row = self._fetch_connection_row(user_id=user_id)
        latest_run = self._latest_sync_run(user_id=user_id)
        return self._serialize_status_payload(user_id=user_id, row=row, latest_run=latest_run)

    def _should_renew_watch(self, row: dict[str, Any] | None) -> bool:
        if not self._watch_enabled():
            return False
        if row is None:
            return False
        expiration_at = _parse_iso(row.get("watch_expiration_at"))
        if expiration_at is None:
            return True
        return expiration_at <= _utcnow() + timedelta(seconds=self._watch_renew_before_seconds())

    def _next_backfill_window(
        self, *, current_window_start_at: datetime | None, now: datetime | None = None
    ) -> tuple[datetime, datetime] | None:
        anchor = now or _utcnow()
        full_start = anchor - timedelta(days=self._full_sync_days())
        recent_start = anchor - timedelta(days=self._bootstrap_recent_days())
        cursor = current_window_start_at or recent_start
        if cursor <= full_start:
            return None
        next_end = cursor
        next_start = max(full_start, next_end - timedelta(days=self._backfill_chunk_days()))
        if next_start >= next_end:
            return None
        return next_start, next_end

    async def reconcile_connection(
        self, *, user_id: str, allow_queue_catchup: bool = False
    ) -> dict[str, Any]:
        row = self._fetch_connection_row(user_id=user_id)
        if row is None:
            return await self.get_status(user_id=user_id)

        if _clean_text(row.get("status")) != "connected" or _to_bool(row.get("revoked"), False):
            return await self.get_status(user_id=user_id)

        try:
            access_token, row = await self._ensure_access_token(user_id=user_id)
        except GmailApiError:
            return await self.get_status(user_id=user_id)

        watch_status = self._derive_watch_status(row)
        if self._should_renew_watch(row) or watch_status in {"failed", "expired", "unknown"}:
            try:
                watch_state = await self._register_watch(access_token=access_token)
                self._update_watch_snapshot(
                    user_id=user_id,
                    watch_status=_clean_text(watch_state.get("watch_status"), "active"),
                    watch_expiration_at=_parse_iso(watch_state.get("watch_expiration_at"))
                    or watch_state.get("watch_expiration_at"),
                    history_id=_history_id_text(watch_state.get("history_id")),
                )
            except GmailApiError as exc:
                message = _clean_text(exc.message) or "Gmail watch renewal failed."
                self.db.execute_raw(
                    """
                    UPDATE kai_gmail_connections
                    SET watch_status = 'failed',
                        last_sync_error = COALESCE(last_sync_error, :message),
                        status_refreshed_at = NOW(),
                        updated_at = NOW()
                    WHERE user_id = :user_id
                    """,
                    {"user_id": user_id, "message": message},
                )

        self.db.execute_raw(
            """
            UPDATE kai_gmail_connections
            SET status_refreshed_at = NOW(),
                updated_at = NOW()
            WHERE user_id = :user_id
            """,
            {"user_id": user_id},
        )

        if allow_queue_catchup:
            refreshed_row = self._fetch_connection_row(user_id=user_id) or row
            last_sync_at = _parse_iso(refreshed_row.get("last_sync_at"))
            last_notification_at = _parse_iso(refreshed_row.get("last_notification_at"))
            stale_threshold = _utcnow() - timedelta(hours=self._watch_notification_stale_hours())
            should_catch_up = (
                last_sync_at is None
                or last_sync_at < stale_threshold
                or (
                    self._watch_enabled()
                    and (last_notification_at is None or last_notification_at < stale_threshold)
                )
            )
            if should_catch_up:
                try:
                    await self.queue_sync(
                        user_id=user_id,
                        trigger_source="auto_reconcile",
                        sync_mode="incremental",
                    )
                except Exception as exc:
                    logger.warning(
                        "gmail.reconcile.catchup_queue_failed user_id=%s reason=%s", user_id, exc
                    )

        return await self.get_status(user_id=user_id)

    async def handle_push_notification(self, payload: dict[str, Any]) -> dict[str, Any]:
        envelope = payload.get("message") if isinstance(payload.get("message"), dict) else payload
        data_text = _clean_text(envelope.get("data")) if isinstance(envelope, dict) else ""
        decoded_payload: dict[str, Any] = {}
        if data_text:
            try:
                decoded_payload = _safe_json_load(base64.b64decode(data_text).decode("utf-8"))
            except Exception:
                decoded_payload = {}
        notification = decoded_payload if decoded_payload else payload
        google_email = _clean_text(notification.get("emailAddress")).lower()
        history_id = _history_id_text(notification.get("historyId"))
        if not google_email:
            return {"accepted": True, "handled": False, "reason": "missing_email"}

        row = self._fetch_connection_row_by_email(google_email=google_email)
        if row is None:
            return {"accepted": True, "handled": False, "reason": "unknown_connection"}

        user_id = _clean_text(row.get("user_id"))
        if (
            not user_id
            or _clean_text(row.get("status")) != "connected"
            or _to_bool(row.get("revoked"), False)
        ):
            return {"accepted": True, "handled": False, "reason": "inactive_connection"}

        self.db.execute_raw(
            """
            UPDATE kai_gmail_connections
            SET last_notification_at = NOW(),
                status_refreshed_at = NOW(),
                history_id = COALESCE(:history_id, history_id),
                updated_at = NOW()
            WHERE user_id = :user_id
            """,
            {"user_id": user_id, "history_id": history_id},
        )

        sync_mode = "incremental" if _history_id_text(row.get("history_id")) else "recovery"
        queued = await self.queue_sync(
            user_id=user_id,
            trigger_source="webhook",
            sync_mode=sync_mode,
            end_history_id=history_id,
        )
        return {
            "accepted": True,
            "handled": True,
            "user_id": user_id,
            "queued": queued.get("accepted", False),
            "run": queued.get("run"),
        }

    def _track_background_task(
        self, task: asyncio.Task[Any] | Any, run_id: str | None = None
    ) -> None:
        if task is None:
            return

        tracked_in_set = False
        try:
            self._background_tasks.add(task)
            tracked_in_set = True
        except TypeError:
            tracked_in_set = False

        if run_id:
            self._sync_tasks_by_run_id[run_id] = task

        add_done_callback = getattr(task, "add_done_callback", None)
        if not callable(add_done_callback):
            return

        def _cleanup(completed: asyncio.Task[Any]) -> None:
            if tracked_in_set:
                self._background_tasks.discard(completed)
            if run_id:
                existing = self._sync_tasks_by_run_id.get(run_id)
                if existing is completed:
                    self._sync_tasks_by_run_id.pop(run_id, None)

        add_done_callback(_cleanup)

    def _dispatch_sync_run(self, *, run_id: str, user_id: str) -> None:
        task = asyncio.create_task(self._run_sync_worker(run_id=run_id, user_id=user_id))
        self._track_background_task(task, run_id=run_id)

    async def queue_sync(
        self,
        *,
        user_id: str,
        trigger_source: str,
        sync_mode: str = "manual",
        start_history_id: str | None = None,
        end_history_id: str | None = None,
        window_start_at: datetime | None = None,
        window_end_at: datetime | None = None,
    ) -> dict[str, Any]:
        if not self.is_configured():
            raise GmailApiError("Gmail OAuth is not configured", status_code=503)
        self._token_key()

        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                connection_row = await conn.fetchrow(
                    """
                    SELECT user_id, status, auto_sync_enabled, revoked
                    FROM kai_gmail_connections
                    WHERE user_id = $1
                    FOR UPDATE
                    """,
                    user_id,
                )
                if connection_row is None:
                    raise GmailApiError("Gmail is not connected for this user", status_code=404)

                connection = dict(connection_row)
                if _clean_text(connection.get("status")) != "connected" or _to_bool(
                    connection.get("revoked"), False
                ):
                    raise GmailApiError("Gmail connection is not active", status_code=409)

                resolved_start_history_id = _history_id_text(start_history_id)
                if sync_mode in {"incremental", "manual"} and not resolved_start_history_id:
                    resolved_start_history_id = _history_id_text(connection.get("history_id"))

                blocking_run: dict[str, Any] | None = None
                while True:
                    existing = await conn.fetchrow(
                        """
                        SELECT *
                        FROM kai_gmail_sync_runs
                        WHERE user_id = $1
                          AND status IN ('queued', 'running')
                        ORDER BY requested_at DESC
                        LIMIT 1
                        """,
                        user_id,
                    )
                    if existing is None:
                        break
                    current_run = dict(existing)
                    if not await self._recover_active_run_in_tx(conn=conn, run=current_run):
                        blocking_run = current_run
                        break
                if blocking_run is not None:
                    return {
                        "accepted": False,
                        "reason": "sync_already_running",
                        "run": self._serialize_run(blocking_run),
                    }

                run_id = f"gmail_sync_{uuid.uuid4().hex}"
                inserted = await conn.fetchrow(
                    """
                    INSERT INTO kai_gmail_sync_runs (
                        run_id,
                        user_id,
                        trigger_source,
                        sync_mode,
                        start_history_id,
                        end_history_id,
                        window_start_at,
                        window_end_at,
                        status,
                        requested_at,
                        updated_at
                    ) VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8,
                        'queued',
                        NOW(),
                        NOW()
                    )
                    RETURNING *
                    """,
                    run_id,
                    user_id,
                    trigger_source,
                    sync_mode,
                    resolved_start_history_id,
                    _history_id_text(end_history_id),
                    window_start_at,
                    window_end_at,
                )

        self._dispatch_sync_run(run_id=run_id, user_id=user_id)

        return {
            "accepted": True,
            "run": self._serialize_run(dict(inserted))
            if inserted
            else await self.get_sync_run(run_id=run_id, user_id=user_id),
        }

    async def _run_sync_worker(self, *, run_id: str, user_id: str) -> None:
        started_at = _utcnow()
        listed_count = 0
        filtered_count = 0
        synced_count = 0
        extracted_count = 0
        duplicates_dropped = 0
        message_error_count = 0

        query_text = ""
        query_since: datetime | None = None
        query_before: datetime | None = None
        max_history_id: str | None = None
        trigger_source = "unknown"
        sync_mode = "manual"
        run_window_start_at: datetime | None = None
        run_window_end_at: datetime | None = None
        start_history_id: str | None = None
        target_history_id: str | None = None
        progress_update_counter = 0
        progress_last_flush_monotonic = time.monotonic()
        connection_check_interval_messages = 10
        messages_since_connection_check = 0

        def _build_progress_metrics(*, include_duration: bool = False) -> dict[str, Any]:
            extraction_success_rate = (
                round(extracted_count / filtered_count, 5) if filtered_count > 0 else 1.0
            )
            payload: dict[str, Any] = {
                "listed_count": listed_count,
                "filtered_count": filtered_count,
                "synced_count": synced_count,
                "extracted_count": extracted_count,
                "duplicates_dropped": duplicates_dropped,
                "message_error_count": message_error_count,
                "extraction_success_rate": extraction_success_rate,
                "trigger_source": trigger_source,
                "sync_mode": sync_mode,
                "start_history_id": start_history_id,
                "target_history_id": target_history_id,
            }
            if include_duration:
                payload["duration_ms"] = int((_utcnow() - started_at).total_seconds() * 1000)
            return payload

        def _flush_progress(*, force: bool = False) -> None:
            nonlocal progress_update_counter, progress_last_flush_monotonic
            progress_update_counter += 1
            now = time.monotonic()
            should_flush = (
                force
                or progress_update_counter >= 5
                or (now - progress_last_flush_monotonic) >= 2.0
            )
            if not should_flush:
                return

            progress_update_counter = 0
            progress_last_flush_monotonic = now
            metrics = _build_progress_metrics(include_duration=True)
            self.db.execute_raw(
                """
                UPDATE kai_gmail_sync_runs
                SET query_since = :query_since,
                    query_text = :query_text,
                    listed_count = :listed_count,
                    filtered_count = :filtered_count,
                    synced_count = :synced_count,
                    extracted_count = :extracted_count,
                    duplicates_dropped = :duplicates_dropped,
                    extraction_success_rate = :extraction_success_rate,
                    metrics_json = CAST(:metrics_json AS jsonb),
                    updated_at = NOW()
                WHERE run_id = :run_id
                """,
                {
                    "run_id": run_id,
                    "query_since": query_since,
                    "query_text": query_text,
                    "listed_count": listed_count,
                    "filtered_count": filtered_count,
                    "synced_count": synced_count,
                    "extracted_count": extracted_count,
                    "duplicates_dropped": duplicates_dropped,
                    "extraction_success_rate": metrics["extraction_success_rate"],
                    "metrics_json": json.dumps(metrics),
                },
            )

        def _assert_connection_still_active() -> None:
            if self._is_connection_sync_active(user_id=user_id):
                return
            raise asyncio.CancelledError()

        async def _process_message_payloads(payloads: list[dict[str, Any]]) -> None:
            nonlocal listed_count
            nonlocal filtered_count
            nonlocal synced_count
            nonlocal extracted_count
            nonlocal duplicates_dropped
            nonlocal message_error_count
            nonlocal max_history_id
            nonlocal messages_since_connection_check

            for metadata in payloads:
                listed_count += 1
                messages_since_connection_check += 1
                if messages_since_connection_check >= connection_check_interval_messages:
                    messages_since_connection_check = 0
                    _assert_connection_still_active()

                gmail_message_id = _clean_text(metadata.get("id"))
                try:
                    candidate = self._candidate_from_message(metadata)
                    if not candidate.gmail_message_id:
                        _flush_progress()
                        continue

                    det = self._classify_candidate(candidate)
                    llm_payload: dict[str, Any] | None = None
                    classification = det

                    if not det["is_receipt"] and det.get("needs_llm"):
                        llm_payload = await self._llm_extract_candidate(candidate)
                        if llm_payload and _to_bool(llm_payload.get("is_receipt"), False):
                            classification = {
                                "is_receipt": True,
                                "needs_llm": False,
                                "confidence": float(
                                    llm_payload.get("confidence") or det.get("confidence") or 0.5
                                ),
                                "source": "llm",
                            }

                    if not classification.get("is_receipt"):
                        _flush_progress()
                        continue

                    filtered_count += 1
                    extracted = self._extract_receipt_fields(
                        candidate=candidate,
                        classification=classification,
                        llm_payload=llm_payload,
                    )
                    core_signal_present = bool(
                        extracted.get("merchant_name")
                        or extracted.get("order_id")
                        or extracted.get("amount")
                    )
                    if core_signal_present:
                        extracted_count += 1

                    inserted = self._upsert_receipt(
                        user_id=user_id,
                        candidate=candidate,
                        extracted=extracted,
                    )
                    if inserted:
                        synced_count += 1
                    else:
                        duplicates_dropped += 1

                    max_history_id = _max_history_id_text(
                        max_history_id,
                        candidate.gmail_history_id,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as message_exc:
                    message_error_count += 1
                    logger.warning(
                        "gmail.sync.message_failed user_id=%s run_id=%s gmail_message_id=%s reason=%s",
                        user_id,
                        run_id,
                        gmail_message_id,
                        str(message_exc)[:_RUN_MESSAGE_FAILED_LOG_LIMIT],
                    )
                _flush_progress()

        try:
            self.db.execute_raw(
                """
                UPDATE kai_gmail_sync_runs
                SET status = 'running',
                    started_at = NOW(),
                    updated_at = NOW()
                WHERE run_id = :run_id
                """,
                {"run_id": run_id},
            )

            run_meta = self.db.execute_raw(
                """
                SELECT
                    trigger_source,
                    sync_mode,
                    start_history_id,
                    end_history_id,
                    window_start_at,
                    window_end_at
                FROM kai_gmail_sync_runs
                WHERE run_id = :run_id
                LIMIT 1
                """,
                {"run_id": run_id},
            ).data
            if run_meta:
                trigger_source = _clean_text(run_meta[0].get("trigger_source"), "unknown")
                sync_mode = _clean_text(run_meta[0].get("sync_mode"), "manual")
                start_history_id = _history_id_text(run_meta[0].get("start_history_id"))
                target_history_id = _history_id_text(run_meta[0].get("end_history_id"))
                run_window_start_at = _parse_iso(run_meta[0].get("window_start_at"))
                run_window_end_at = _parse_iso(run_meta[0].get("window_end_at"))
            self.db.execute_raw(
                """
                UPDATE kai_gmail_connections
                SET last_sync_status = 'running',
                    last_sync_error = NULL,
                    bootstrap_state = CASE
                        WHEN :sync_mode IN ('bootstrap', 'recovery') THEN 'running'
                        ELSE bootstrap_state
                    END,
                    updated_at = NOW()
                WHERE user_id = :user_id
                """,
                {"user_id": user_id, "sync_mode": sync_mode},
            )

            _assert_connection_still_active()
            access_token, conn_row = await self._ensure_access_token(user_id=user_id)
            if sync_mode in {"incremental", "manual"} and not start_history_id:
                start_history_id = _history_id_text(conn_row.get("history_id"))
            if sync_mode in {"bootstrap", "recovery"}:
                run_window_end_at = run_window_end_at or _utcnow()
                run_window_start_at = run_window_start_at or (
                    run_window_end_at - timedelta(days=self._bootstrap_recent_days())
                )
            elif sync_mode == "backfill":
                run_window_end_at = run_window_end_at or _utcnow()
                run_window_start_at = run_window_start_at or (
                    run_window_end_at - timedelta(days=self._backfill_chunk_days())
                )

            if sync_mode in {"bootstrap", "recovery", "backfill"}:
                query_since = run_window_start_at
                query_before = run_window_end_at
                query_text = self._build_receipt_query(
                    query_since=query_since
                    or (_utcnow() - timedelta(days=self._bootstrap_recent_days())),
                    query_before=query_before,
                )
            else:
                query_text = f"history:start={start_history_id or 'missing'}"
            _flush_progress(force=True)
            remaining = self._max_messages_per_sync()
            if sync_mode in {"manual", "incremental"} and not start_history_id:
                sync_mode = "recovery"
                run_window_end_at = _utcnow()
                run_window_start_at = run_window_end_at - timedelta(
                    days=self._bootstrap_recent_days()
                )
                query_since = run_window_start_at
                query_before = run_window_end_at
                query_text = self._build_receipt_query(
                    query_since=query_since,
                    query_before=query_before,
                )

            if sync_mode in {"bootstrap", "recovery", "backfill"}:
                page_token: str | None = None
                while remaining > 0:
                    _assert_connection_still_active()
                    page_size = min(100, remaining)
                    listing = await self._list_messages(
                        access_token=access_token,
                        query_text=query_text,
                        page_token=page_token,
                        max_results=page_size,
                    )
                    messages = (
                        listing.get("messages") if isinstance(listing.get("messages"), list) else []
                    )
                    if not messages:
                        break
                    message_ids = [
                        _clean_text(message.get("id"))
                        for message in messages
                        if _clean_text(message.get("id"))
                    ]
                    for index in range(0, len(message_ids), self._metadata_batch_size()):
                        if remaining <= 0:
                            break
                        batch_ids = message_ids[
                            index : index + min(self._metadata_batch_size(), remaining)
                        ]
                        remaining -= len(batch_ids)
                        payloads = await self._get_message_metadata_batch(
                            access_token=access_token,
                            gmail_message_ids=batch_ids,
                        )
                        message_error_count += max(0, len(batch_ids) - len(payloads))
                        await _process_message_payloads(payloads)
                    page_token = _clean_text(listing.get("nextPageToken")) or None
                    if not page_token:
                        break
            else:
                page_token = None
                while remaining > 0 and start_history_id:
                    _assert_connection_still_active()
                    history_payload = await self._list_history(
                        access_token=access_token,
                        start_history_id=start_history_id,
                        page_token=page_token,
                        max_results=min(100, remaining),
                    )
                    max_history_id = _max_history_id_text(
                        max_history_id,
                        history_payload.get("historyId"),
                        target_history_id,
                    )
                    message_ids = self._message_ids_from_history(history_payload)
                    for index in range(0, len(message_ids), self._metadata_batch_size()):
                        if remaining <= 0:
                            break
                        batch_ids = message_ids[
                            index : index + min(self._metadata_batch_size(), remaining)
                        ]
                        remaining -= len(batch_ids)
                        payloads = await self._get_message_metadata_batch(
                            access_token=access_token,
                            gmail_message_ids=batch_ids,
                        )
                        message_error_count += max(0, len(batch_ids) - len(payloads))
                        await _process_message_payloads(payloads)
                    page_token = _clean_text(history_payload.get("nextPageToken")) or None
                    if not page_token:
                        break

            _flush_progress(force=True)
            metrics = _build_progress_metrics(include_duration=True)
            extraction_success_rate = float(metrics["extraction_success_rate"])
            final_history_id = _max_history_id_text(max_history_id, target_history_id)

            self.db.execute_raw(
                """
                UPDATE kai_gmail_sync_runs
                SET status = 'completed',
                    sync_mode = :sync_mode,
                    start_history_id = COALESCE(:start_history_id, start_history_id),
                    end_history_id = COALESCE(:end_history_id, end_history_id),
                    window_start_at = COALESCE(:window_start_at, window_start_at),
                    window_end_at = COALESCE(:window_end_at, window_end_at),
                    query_since = :query_since,
                    query_text = :query_text,
                    listed_count = :listed_count,
                    filtered_count = :filtered_count,
                    synced_count = :synced_count,
                    extracted_count = :extracted_count,
                    duplicates_dropped = :duplicates_dropped,
                    extraction_success_rate = :extraction_success_rate,
                    metrics_json = CAST(:metrics_json AS jsonb),
                    completed_at = NOW(),
                    updated_at = NOW(),
                    error_message = NULL
                WHERE run_id = :run_id
                """,
                {
                    "run_id": run_id,
                    "sync_mode": sync_mode,
                    "start_history_id": start_history_id,
                    "end_history_id": final_history_id,
                    "window_start_at": run_window_start_at,
                    "window_end_at": run_window_end_at,
                    "query_since": query_since,
                    "query_text": query_text,
                    "listed_count": listed_count,
                    "filtered_count": filtered_count,
                    "synced_count": synced_count,
                    "extracted_count": extracted_count,
                    "duplicates_dropped": duplicates_dropped,
                    "extraction_success_rate": extraction_success_rate,
                    "metrics_json": json.dumps(metrics),
                },
            )

            self.db.execute_raw(
                """
                UPDATE kai_gmail_connections
                SET last_sync_at = NOW(),
                    history_id = COALESCE(:history_id, history_id),
                    bootstrap_state = CASE
                        WHEN :sync_mode IN ('bootstrap', 'recovery') THEN 'completed'
                        ELSE bootstrap_state
                    END,
                    bootstrap_completed_at = CASE
                        WHEN :sync_mode IN ('bootstrap', 'recovery') THEN NOW()
                        ELSE bootstrap_completed_at
                    END,
                    last_sync_status = 'completed',
                    last_sync_error = NULL,
                    status_refreshed_at = NOW(),
                    updated_at = NOW()
                WHERE user_id = :user_id
                """,
                {
                    "user_id": user_id,
                    "sync_mode": sync_mode,
                    "history_id": final_history_id,
                },
            )

            if sync_mode in {"bootstrap", "recovery", "backfill"}:
                next_window = self._next_backfill_window(
                    current_window_start_at=run_window_start_at,
                    now=run_window_end_at or _utcnow(),
                )
                if next_window is not None:
                    try:
                        await self.queue_sync(
                            user_id=user_id,
                            trigger_source="backfill",
                            sync_mode="backfill",
                            window_start_at=next_window[0],
                            window_end_at=next_window[1],
                        )
                    except Exception as exc:
                        logger.warning(
                            "gmail.sync.backfill_queue_failed user_id=%s run_id=%s reason=%s",
                            user_id,
                            run_id,
                            exc,
                        )

            logger.info(
                "gmail.sync.completed user_id=%s run_id=%s sync_mode=%s listed_count=%s filtered_count=%s synced_count=%s extracted_count=%s duplicates_dropped=%s extraction_success_rate=%s",
                user_id,
                run_id,
                sync_mode,
                listed_count,
                filtered_count,
                synced_count,
                extracted_count,
                duplicates_dropped,
                extraction_success_rate,
            )
        except asyncio.CancelledError:
            logger.info("gmail.sync.canceled user_id=%s run_id=%s", user_id, run_id)
            self._mark_run_terminal(
                run_id=run_id,
                status="canceled",
                error_message=_RUN_CANCELED_MESSAGE,
            )
            raise
        except GmailApiError as exc:
            if exc.status_code == 404 and sync_mode in {"manual", "incremental"}:
                self.db.execute_raw(
                    """
                    UPDATE kai_gmail_sync_runs
                    SET status = 'failed',
                        sync_mode = :sync_mode,
                        start_history_id = COALESCE(:start_history_id, start_history_id),
                        end_history_id = COALESCE(:end_history_id, end_history_id),
                        query_since = :query_since,
                        query_text = :query_text,
                        listed_count = :listed_count,
                        filtered_count = :filtered_count,
                        synced_count = :synced_count,
                        extracted_count = :extracted_count,
                        duplicates_dropped = :duplicates_dropped,
                        extraction_success_rate = :extraction_success_rate,
                        error_message = :error_message,
                        completed_at = NOW(),
                        updated_at = NOW()
                    WHERE run_id = :run_id
                    """,
                    {
                        "run_id": run_id,
                        "sync_mode": sync_mode,
                        "start_history_id": start_history_id,
                        "end_history_id": target_history_id,
                        "query_since": query_since,
                        "query_text": query_text,
                        "listed_count": listed_count,
                        "filtered_count": filtered_count,
                        "synced_count": synced_count,
                        "extracted_count": extracted_count,
                        "duplicates_dropped": duplicates_dropped,
                        "extraction_success_rate": round(extracted_count / filtered_count, 5)
                        if filtered_count > 0
                        else 0,
                        "error_message": _RUN_HISTORY_GAP_MESSAGE,
                    },
                )
                self.db.execute_raw(
                    """
                    UPDATE kai_gmail_connections
                    SET bootstrap_state = 'queued',
                        last_sync_status = 'failed',
                        last_sync_error = :error_message,
                        status_refreshed_at = NOW(),
                        updated_at = NOW()
                    WHERE user_id = :user_id
                    """,
                    {"user_id": user_id, "error_message": _RUN_HISTORY_GAP_MESSAGE},
                )
                try:
                    await self.queue_sync(
                        user_id=user_id,
                        trigger_source="history_gap_recovery",
                        sync_mode="recovery",
                        window_start_at=_utcnow() - timedelta(days=self._bootstrap_recent_days()),
                        window_end_at=_utcnow(),
                    )
                except Exception as queue_exc:
                    logger.warning(
                        "gmail.sync.recovery_queue_failed user_id=%s run_id=%s reason=%s",
                        user_id,
                        run_id,
                        queue_exc,
                    )
                return
            raise
        except Exception as exc:
            logger.exception("gmail.sync.failed user_id=%s run_id=%s", user_id, run_id)
            self.db.execute_raw(
                """
                UPDATE kai_gmail_sync_runs
                SET status = 'failed',
                    sync_mode = :sync_mode,
                    start_history_id = COALESCE(:start_history_id, start_history_id),
                    end_history_id = COALESCE(:end_history_id, end_history_id),
                    window_start_at = COALESCE(:window_start_at, window_start_at),
                    window_end_at = COALESCE(:window_end_at, window_end_at),
                    query_since = :query_since,
                    query_text = :query_text,
                    listed_count = :listed_count,
                    filtered_count = :filtered_count,
                    synced_count = :synced_count,
                    extracted_count = :extracted_count,
                    duplicates_dropped = :duplicates_dropped,
                    extraction_success_rate = :extraction_success_rate,
                    error_message = :error_message,
                    completed_at = NOW(),
                    updated_at = NOW()
                WHERE run_id = :run_id
                """,
                {
                    "run_id": run_id,
                    "sync_mode": sync_mode,
                    "start_history_id": start_history_id,
                    "end_history_id": target_history_id,
                    "window_start_at": run_window_start_at,
                    "window_end_at": run_window_end_at,
                    "query_since": query_since,
                    "query_text": query_text,
                    "listed_count": listed_count,
                    "filtered_count": filtered_count,
                    "synced_count": synced_count,
                    "extracted_count": extracted_count,
                    "duplicates_dropped": duplicates_dropped,
                    "extraction_success_rate": round(extracted_count / filtered_count, 5)
                    if filtered_count > 0
                    else 0,
                    "error_message": str(exc),
                },
            )
            self.db.execute_raw(
                """
                UPDATE kai_gmail_connections
                SET last_sync_status = 'failed',
                    last_sync_error = :error_message,
                    bootstrap_state = CASE
                        WHEN :sync_mode IN ('bootstrap', 'recovery') THEN 'failed'
                        ELSE bootstrap_state
                    END,
                    status_refreshed_at = NOW(),
                    updated_at = NOW()
                WHERE user_id = :user_id
                """,
                {
                    "user_id": user_id,
                    "sync_mode": sync_mode,
                    "error_message": str(exc),
                },
            )

    async def get_sync_run(self, *, run_id: str, user_id: str) -> dict[str, Any] | None:
        self._reconcile_active_runs(user_id=user_id, run_id=run_id)
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_gmail_sync_runs
            WHERE run_id = :run_id
              AND user_id = :user_id
            LIMIT 1
            """,
            {
                "run_id": run_id,
                "user_id": user_id,
            },
        )
        if not result.data:
            return None
        return self._serialize_run(result.data[0])

    async def list_receipts(
        self,
        *,
        user_id: str,
        page: int,
        per_page: int,
    ) -> dict[str, Any]:
        page = max(1, int(page or 1))
        per_page = max(1, min(100, int(per_page or 25)))
        offset = (page - 1) * per_page

        rows = self.db.execute_raw(
            """
            SELECT
                id,
                gmail_message_id,
                gmail_thread_id,
                gmail_internal_date,
                subject,
                snippet,
                from_name,
                from_email,
                merchant_name,
                order_id,
                currency,
                amount,
                receipt_date,
                classification_confidence,
                classification_source,
                created_at,
                updated_at
            FROM kai_gmail_receipts
            WHERE user_id = :user_id
            ORDER BY COALESCE(receipt_date, gmail_internal_date, created_at) DESC, created_at DESC
            LIMIT :limit OFFSET :offset
            """,
            {
                "user_id": user_id,
                "limit": per_page,
                "offset": offset,
            },
        ).data

        total_row = self.db.execute_raw(
            "SELECT COUNT(*) AS total FROM kai_gmail_receipts WHERE user_id = :user_id",
            {"user_id": user_id},
        ).data
        total = int(total_row[0]["total"]) if total_row else 0

        return {
            "items": rows,
            "page": page,
            "per_page": per_page,
            "total": total,
            "has_more": (offset + len(rows)) < total,
        }

    async def _run_scheduled_sync_once(self) -> None:
        threshold = _utcnow() - timedelta(hours=self._daily_sync_age_hours())
        due_rows = self.db.execute_raw(
            """
            SELECT user_id
            FROM kai_gmail_connections
            WHERE status = 'connected'
              AND auto_sync_enabled = TRUE
              AND (
                    last_sync_at IS NULL
                 OR last_sync_at < :threshold
                 OR watch_expiration_at IS NULL
                 OR watch_expiration_at < :renew_threshold
                 OR last_notification_at IS NULL
                 OR last_notification_at < :threshold
              )
            ORDER BY COALESCE(last_sync_at, created_at) ASC
            LIMIT 50
            """,
            {
                "threshold": threshold,
                "renew_threshold": _utcnow()
                + timedelta(seconds=self._watch_renew_before_seconds()),
            },
        ).data

        for row in due_rows:
            uid = _clean_text(row.get("user_id"))
            if not uid:
                continue
            try:
                await self.reconcile_connection(user_id=uid, allow_queue_catchup=True)
            except Exception as exc:
                logger.warning("gmail.schedule.reconcile_failed user_id=%s reason=%s", uid, exc)

    async def _run_scheduled_sync_with_lock(self) -> None:
        lock_key = 0x4B414947  # stable integer lock key
        try:
            pool = await get_pool()
            async with pool.acquire() as conn:
                acquired = await conn.fetchval("SELECT pg_try_advisory_lock($1)", lock_key)
                if not acquired:
                    return
                try:
                    await self._run_scheduled_sync_once()
                finally:
                    try:
                        await conn.execute("SELECT pg_advisory_unlock($1)", lock_key)
                    except Exception as unlock_exc:
                        logger.warning("gmail.schedule.unlock_failed reason=%s", unlock_exc)
        except Exception as exc:
            logger.warning("gmail.schedule.lock_failed reason=%s", exc)

    async def _schedule_loop(self) -> None:
        interval = self._auto_interval_seconds()
        logger.info("gmail.schedule.loop_started interval_seconds=%s", interval)
        await asyncio.sleep(1.0 + (secrets.randbelow(1500) / 1000.0))
        while True:
            try:
                await self._run_scheduled_sync_with_lock()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception("gmail.schedule.loop_iteration_failed reason=%s", exc)
            jitter = max(3, int(interval * 0.12))
            try:
                await asyncio.sleep(interval + secrets.randbelow(jitter + 1))
            except asyncio.CancelledError:
                raise

    def start_background_sync_loop(self) -> None:
        if not self._sync_enabled():
            logger.info("gmail.schedule.disabled")
            return
        if self._schedule_loop_task and not self._schedule_loop_task.done():
            return
        self._schedule_loop_task = asyncio.create_task(self._schedule_loop())


_gmail_receipts_service: GmailReceiptsService | None = None


def get_gmail_receipts_service() -> GmailReceiptsService:
    global _gmail_receipts_service
    if _gmail_receipts_service is None:
        _gmail_receipts_service = GmailReceiptsService()
    return _gmail_receipts_service


def start_gmail_receipts_background_sync() -> None:
    get_gmail_receipts_service().start_background_sync_loop()
