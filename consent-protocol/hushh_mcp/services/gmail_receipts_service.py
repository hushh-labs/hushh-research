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
_GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
_GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile"
_GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages"

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
_AMOUNT_RE = re.compile(r"(?<![A-Z0-9])(?:USD|\$|EUR|€|GBP|£|INR|₹)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)")

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
        return bool(self._oauth_client_id() and self._oauth_client_secret() and self._oauth_redirect_uri())

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
                base64.urlsafe_b64decode(c.encode("utf-8")) + base64.urlsafe_b64decode(t.encode("utf-8")),
                None,
            )
        except Exception:
            return None
        return plaintext.decode("utf-8")

    async def _http_post_form(self, url: str, data: dict[str, Any], headers: dict[str, str] | None = None) -> dict[str, Any]:
        timeout = httpx.Timeout(self._http_timeout)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, data=data, headers=headers)
        payload: dict[str, Any]
        try:
            payload = response.json()
        except Exception:
            payload = {}
        if response.status_code >= 400:
            message = _clean_text(payload.get("error_description")) or _clean_text(payload.get("error"))
            raise GmailApiError(
                message or f"Google request failed ({response.status_code})",
                status_code=502,
                payload=payload,
            )
        return payload

    async def _http_get_json(self, url: str, *, token: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
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
            raise GmailApiError(
                f"Gmail API request failed ({response.status_code})",
                status_code=502,
                payload=payload,
            )
        return payload if isinstance(payload, dict) else {}

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
                connected_at = COALESCE(kai_gmail_connections.connected_at, NOW()),
                disconnected_at = NULL,
                token_updated_at = NOW(),
                last_sync_status = 'idle',
                last_sync_error = NULL,
                updated_at = NOW()
            """,
            {
                "user_id": user_id,
                "google_email": _clean_text(profile.get("emailAddress")) or _clean_text(claims.get("email")) or None,
                "google_sub": _clean_text(claims.get("sub")) or None,
                "scope_csv": scope_csv,
                "refresh_token_ciphertext": refresh_env["ciphertext"],
                "refresh_token_iv": refresh_env["iv"],
                "refresh_token_tag": refresh_env["tag"],
                "access_token_ciphertext": access_env["ciphertext"],
                "access_token_iv": access_env["iv"],
                "access_token_tag": access_env["tag"],
                "access_token_expires_at": expires_at,
            },
        )

        logger.info("gmail.connect.complete user_id=%s email=%s", user_id, _clean_text(profile.get("emailAddress"), "unknown"))

        # kickoff first sync
        try:
            await self.queue_sync(user_id=user_id, trigger_source="connect")
        except Exception as exc:
            logger.warning("gmail.connect.queue_failed user_id=%s reason=%s", user_id, exc)

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
                    disconnected_at = NOW(),
                    token_updated_at = NOW(),
                    updated_at = NOW()
                WHERE user_id = :user_id
                """,
                {"user_id": user_id},
            )

        logger.info("gmail.disconnect user_id=%s", user_id)
        return await self.get_status(user_id=user_id)

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
            raise GmailApiError("Stored Gmail refresh token is missing", status_code=401)

        refreshed = await self._refresh_access_token(refresh_token=refresh_token)
        next_access = _clean_text(refreshed.get("access_token"))
        next_expires = int(refreshed.get("expires_in") or 3600)
        next_refresh = _clean_text(refreshed.get("refresh_token")) or refresh_token
        if not next_access:
            raise GmailApiError("Gmail token refresh did not return access token", status_code=401)

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

    def _build_receipt_query(self, *, query_since: datetime) -> str:
        since_unix = int(query_since.timestamp())
        return (
            "("
            "category:purchases "
            "OR subject:(receipt OR invoice OR order OR payment OR transaction) "
            "OR (\"thank you for your order\" OR \"order confirmation\" OR \"order total\" "
            "OR \"amount paid\" OR \"payment received\")"
            ") "
            f"after:{since_unix} -category:spam"
        )

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

    async def _get_message_metadata(self, *, access_token: str, gmail_message_id: str) -> dict[str, Any]:
        return await self._http_get_json(
            f"{_GMAIL_MESSAGES_URL}/{gmail_message_id}",
            token=access_token,
            params={
                "format": "metadata",
                "metadataHeaders": ["From", "Subject", "Date", "Message-ID"],
            },
        )

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
                internal_date = parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
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
        checksum = hashlib.sha256(checksum_input.encode("utf-8")).hexdigest() if checksum_input else None

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

    def _upsert_receipt(self, *, user_id: str, candidate: ReceiptCandidate, extracted: dict[str, Any]) -> bool:
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
            "status": _clean_text(row.get("status"), "unknown"),
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
        row = self._fetch_connection_row(user_id=user_id)
        latest_run = self._latest_sync_run(user_id=user_id)
        if not row:
            return {
                "configured": self.is_configured(),
                "connected": False,
                "status": "disconnected",
                "google_email": None,
                "last_sync_at": None,
                "last_sync_status": "idle",
                "last_sync_error": None,
                "auto_sync_enabled": False,
                "revoked": False,
                "scope_csv": "",
                "latest_run": self._serialize_run(latest_run),
            }

        connected = _clean_text(row.get("status")) == "connected"
        return {
            "configured": self.is_configured(),
            "connected": connected,
            "status": _clean_text(row.get("status"), "disconnected"),
            "google_email": _clean_text(row.get("google_email")) or None,
            "google_sub": _clean_text(row.get("google_sub")) or None,
            "scope_csv": _clean_text(row.get("scope_csv")),
            "last_sync_at": row.get("last_sync_at"),
            "last_sync_status": _clean_text(row.get("last_sync_status"), "idle"),
            "last_sync_error": _clean_text(row.get("last_sync_error")) or None,
            "auto_sync_enabled": _to_bool(row.get("auto_sync_enabled"), False),
            "revoked": _to_bool(row.get("revoked"), False),
            "connected_at": row.get("connected_at"),
            "disconnected_at": row.get("disconnected_at"),
            "latest_run": self._serialize_run(latest_run),
        }

    def _track_background_task(self, task: asyncio.Task[Any], run_id: str | None = None) -> None:
        self._background_tasks.add(task)
        if run_id:
            self._sync_tasks_by_run_id[run_id] = task

        def _cleanup(completed: asyncio.Task[Any]) -> None:
            self._background_tasks.discard(completed)
            if run_id:
                existing = self._sync_tasks_by_run_id.get(run_id)
                if existing is completed:
                    self._sync_tasks_by_run_id.pop(run_id, None)

        task.add_done_callback(_cleanup)

    async def queue_sync(self, *, user_id: str, trigger_source: str) -> dict[str, Any]:
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
                if existing is not None:
                    return {
                        "accepted": False,
                        "reason": "sync_already_running",
                        "run": self._serialize_run(dict(existing)),
                    }

                run_id = f"gmail_sync_{uuid.uuid4().hex}"
                inserted = await conn.fetchrow(
                    """
                    INSERT INTO kai_gmail_sync_runs (
                        run_id,
                        user_id,
                        trigger_source,
                        status,
                        requested_at,
                        updated_at
                    ) VALUES (
                        $1,
                        $2,
                        $3,
                        'queued',
                        NOW(),
                        NOW()
                    )
                    RETURNING *
                    """,
                    run_id,
                    user_id,
                    trigger_source,
                )

        task = asyncio.create_task(self._run_sync_worker(run_id=run_id, user_id=user_id))
        self._track_background_task(task, run_id=run_id)

        return {
            "accepted": True,
            "run": self._serialize_run(dict(inserted)) if inserted else await self.get_sync_run(run_id=run_id, user_id=user_id),
        }

    async def _run_sync_worker(self, *, run_id: str, user_id: str) -> None:
        started_at = _utcnow()
        listed_count = 0
        filtered_count = 0
        synced_count = 0
        extracted_count = 0
        duplicates_dropped = 0

        query_text = ""
        query_since: datetime | None = None
        max_history_id: int | None = None
        trigger_source = "unknown"
        progress_update_counter = 0
        progress_last_flush_monotonic = time.monotonic()

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
                "extraction_success_rate": extraction_success_rate,
                "trigger_source": trigger_source,
            }
            if include_duration:
                payload["duration_ms"] = int((_utcnow() - started_at).total_seconds() * 1000)
            return payload

        def _flush_progress(*, force: bool = False) -> None:
            nonlocal progress_update_counter, progress_last_flush_monotonic
            progress_update_counter += 1
            now = time.monotonic()
            should_flush = force or progress_update_counter >= 5 or (now - progress_last_flush_monotonic) >= 2.0
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
                SELECT trigger_source
                FROM kai_gmail_sync_runs
                WHERE run_id = :run_id
                LIMIT 1
                """,
                {"run_id": run_id},
            ).data
            if run_meta:
                trigger_source = _clean_text(run_meta[0].get("trigger_source"), "unknown")
            self.db.execute_raw(
                """
                UPDATE kai_gmail_connections
                SET last_sync_status = 'running',
                    last_sync_error = NULL,
                    updated_at = NOW()
                WHERE user_id = :user_id
                """,
                {"user_id": user_id},
            )

            access_token, conn_row = await self._ensure_access_token(user_id=user_id)
            last_sync_at = _parse_iso(conn_row.get("last_sync_at"))
            if last_sync_at is None:
                query_since = _utcnow() - timedelta(days=365)
            else:
                query_since = last_sync_at - timedelta(hours=2)

            query_text = self._build_receipt_query(query_since=query_since)
            _flush_progress(force=True)
            page_token: str | None = None
            remaining = self._max_messages_per_sync()

            while remaining > 0:
                page_size = min(100, remaining)
                listing = await self._list_messages(
                    access_token=access_token,
                    query_text=query_text,
                    page_token=page_token,
                    max_results=page_size,
                )
                messages = listing.get("messages") if isinstance(listing.get("messages"), list) else []
                if not messages:
                    break

                for message in messages:
                    if remaining <= 0:
                        break
                    remaining -= 1
                    gmail_message_id = _clean_text(message.get("id"))
                    if not gmail_message_id:
                        continue

                    metadata = await self._get_message_metadata(
                        access_token=access_token,
                        gmail_message_id=gmail_message_id,
                    )
                    listed_count += 1
                    candidate = self._candidate_from_message(metadata)
                    if not candidate.gmail_message_id:
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
                                "confidence": float(llm_payload.get("confidence") or det.get("confidence") or 0.5),
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
                        extracted.get("merchant_name") or extracted.get("order_id") or extracted.get("amount")
                    )
                    if core_signal_present:
                        extracted_count += 1

                    inserted = self._upsert_receipt(user_id=user_id, candidate=candidate, extracted=extracted)
                    if inserted:
                        synced_count += 1
                    else:
                        duplicates_dropped += 1

                    if candidate.gmail_history_id and candidate.gmail_history_id.isdigit():
                        numeric_history = int(candidate.gmail_history_id)
                        if max_history_id is None or numeric_history > max_history_id:
                            max_history_id = numeric_history

                    _flush_progress()

                page_token = _clean_text(listing.get("nextPageToken")) or None
                if not page_token:
                    break

            _flush_progress(force=True)
            metrics = _build_progress_metrics(include_duration=True)
            extraction_success_rate = float(metrics["extraction_success_rate"])

            self.db.execute_raw(
                """
                UPDATE kai_gmail_sync_runs
                SET status = 'completed',
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
                    last_sync_status = 'completed',
                    last_sync_error = NULL,
                    updated_at = NOW()
                WHERE user_id = :user_id
                """,
                {
                    "user_id": user_id,
                    "history_id": str(max_history_id) if max_history_id is not None else None,
                },
            )

            logger.info(
                "gmail.sync.completed user_id=%s run_id=%s listed_count=%s filtered_count=%s synced_count=%s extracted_count=%s duplicates_dropped=%s extraction_success_rate=%s",
                user_id,
                run_id,
                listed_count,
                filtered_count,
                synced_count,
                extracted_count,
                duplicates_dropped,
                extraction_success_rate,
            )
        except Exception as exc:
            logger.exception("gmail.sync.failed user_id=%s run_id=%s", user_id, run_id)
            self.db.execute_raw(
                """
                UPDATE kai_gmail_sync_runs
                SET status = 'failed',
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
                    updated_at = NOW()
                WHERE user_id = :user_id
                """,
                {
                    "user_id": user_id,
                    "error_message": str(exc),
                },
            )

    async def get_sync_run(self, *, run_id: str, user_id: str) -> dict[str, Any] | None:
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
              AND (last_sync_at IS NULL OR last_sync_at < :threshold)
            ORDER BY COALESCE(last_sync_at, created_at) ASC
            LIMIT 50
            """,
            {"threshold": threshold},
        ).data

        for row in due_rows:
            uid = _clean_text(row.get("user_id"))
            if not uid:
                continue
            try:
                await self.queue_sync(user_id=uid, trigger_source="auto_daily")
            except Exception as exc:
                logger.warning("gmail.schedule.queue_failed user_id=%s reason=%s", uid, exc)

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
