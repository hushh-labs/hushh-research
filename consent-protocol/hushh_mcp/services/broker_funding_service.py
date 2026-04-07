"""Broker funding orchestration (Plaid Auth + Alpaca ACH funding)."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from db.db_client import DatabaseExecutionError, get_db
from hushh_mcp.integrations.alpaca import (
    AlpacaApiError,
    AlpacaBrokerHttpClient,
    AlpacaBrokerRuntimeConfig,
)
from hushh_mcp.integrations.plaid import PlaidHttpClient, PlaidRuntimeConfig

logger = logging.getLogger(__name__)

_FUNDS_DIRECTION_INCOMING = "INCOMING"
_FUNDS_DIRECTION_OUTGOING = "OUTGOING"

_PENDING_TRANSFER_STATUSES = {"QUEUED", "PENDING", "SUBMITTED", "APPROVAL_PENDING", "PROCESSING"}
_COMPLETED_TRANSFER_STATUSES = {"COMPLETE", "COMPLETED", "SETTLED", "POSTED"}
_CANCELED_TRANSFER_STATUSES = {"CANCELED", "CANCELLED", "VOIDED"}
_RETURNED_TRANSFER_STATUSES = {"RETURNED", "REVERSED"}
_FAILED_TRANSFER_STATUSES = {"FAILED", "REJECTED", "ERROR"}
_NOTIFIABLE_TRANSFER_USER_STATUSES = {"completed", "failed", "returned", "canceled"}

_RELATIONSHIP_APPROVED_STATUSES = {"APPROVED"}
_RELATIONSHIP_PENDING_STATUSES = {"QUEUED", "PENDING", "SUBMITTED"}
_RELATIONSHIP_TERMINAL_FAILURE_STATUSES = {"REJECTED", "CANCELED", "DISABLED", "ERROR"}

_ALPACA_ACCOUNT_ID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_ALPACA_CONNECT_DEFAULT_AUTHORIZE_URL = "https://app.alpaca.markets/oauth/authorize"
_ALPACA_CONNECT_DEFAULT_TOKEN_URL = "https://api.alpaca.markets/oauth/token"  # noqa: S105
_ALPACA_CONNECT_DEFAULT_ACCOUNT_URL = "https://api.alpaca.markets/v2/account"
_ALPACA_CONNECT_DEFAULT_SCOPES = "account:write trading"
_ALPACA_CONNECT_SESSION_TTL_SECONDS_DEFAULT = 15 * 60


class FundingOrchestrationError(RuntimeError):
    """Typed funding orchestration error with HTTP-friendly metadata."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "FUNDING_ORCHESTRATION_ERROR",
        status_code: int = 400,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.code = code
        self.status_code = status_code
        self.details = details or {}
        super().__init__(message)


class PlaidWebhookVerificationError(FundingOrchestrationError):
    """Raised when Plaid webhook verification fails."""

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(
            message,
            code="PLAID_WEBHOOK_VERIFICATION_FAILED",
            status_code=401,
            details=details,
        )


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _utcnow_iso() -> str:
    return _utcnow().isoformat().replace("+00:00", "Z")


def _clean_text(value: Any, *, default: str = "") -> str:
    if not isinstance(value, str):
        return default
    text = value.strip()
    return text or default


def _json_load(value: Any, *, fallback: Any) -> Any:
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            return fallback
        return parsed
    return fallback


def _as_list_of_dicts(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [entry for entry in value if isinstance(entry, dict)]


def _to_decimal(value: Any) -> Decimal | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        try:
            return Decimal(str(value))
        except InvalidOperation:
            return None
    if isinstance(value, str):
        text = value.strip().replace(",", "").replace("$", "")
        if not text:
            return None
        try:
            return Decimal(text)
        except InvalidOperation:
            return None
    return None


def _decimal_to_currency_text(value: Any) -> str:
    decimal_value = _to_decimal(value)
    if decimal_value is None:
        raise FundingOrchestrationError(
            "Transfer amount must be a valid number.",
            code="INVALID_TRANSFER_AMOUNT",
            status_code=422,
        )
    if decimal_value <= 0:
        raise FundingOrchestrationError(
            "Transfer amount must be greater than zero.",
            code="INVALID_TRANSFER_AMOUNT",
            status_code=422,
        )
    rounded = decimal_value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return f"{rounded:.2f}"


def _unique_texts(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = value.strip()
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


def _to_bool(value: Any, *, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def _direction_to_alpaca(direction: str) -> str:
    normalized = _clean_text(direction).lower()
    if normalized in {"from_brokerage", "outgoing", "withdraw", "withdrawal"}:
        return _FUNDS_DIRECTION_OUTGOING
    return _FUNDS_DIRECTION_INCOMING


def _looks_like_alpaca_account_id(value: str | None) -> bool:
    candidate = _clean_text(value)
    if not candidate:
        return False
    return bool(_ALPACA_ACCOUNT_ID_PATTERN.match(candidate))


def _normalize_https_url(value: str | None) -> str | None:
    raw = _clean_text(value)
    if not raw:
        return None
    parsed = urlsplit(raw)
    if parsed.scheme != "https" or not parsed.netloc:
        return None
    path = parsed.path or "/"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _user_facing_transfer_status(status_value: str | None) -> str:
    normalized = _clean_text(status_value).upper()
    if normalized in _COMPLETED_TRANSFER_STATUSES:
        return "completed"
    if normalized in _CANCELED_TRANSFER_STATUSES:
        return "canceled"
    if normalized in _RETURNED_TRANSFER_STATUSES:
        return "returned"
    if normalized in _FAILED_TRANSFER_STATUSES:
        return "failed"
    return "pending"


class BrokerFundingService:
    """Funding orchestration service backed by Plaid + Alpaca Broker APIs."""

    def __init__(self) -> None:
        self._db = None
        self._plaid_runtime_config: PlaidRuntimeConfig | None = None
        self._plaid_client: PlaidHttpClient | None = None
        self._alpaca_runtime_config: AlpacaBrokerRuntimeConfig | None = None
        self._alpaca_client: AlpacaBrokerHttpClient | None = None
        self._warned_fallback_encryption_key = False

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    @property
    def plaid_config(self) -> PlaidRuntimeConfig:
        if self._plaid_runtime_config is None:
            self._plaid_runtime_config = PlaidRuntimeConfig.from_env()
        return self._plaid_runtime_config

    @property
    def plaid_client(self) -> PlaidHttpClient:
        if self._plaid_client is None:
            self._plaid_client = PlaidHttpClient(self.plaid_config)
        return self._plaid_client

    @property
    def alpaca_config(self) -> AlpacaBrokerRuntimeConfig:
        if self._alpaca_runtime_config is None:
            self._alpaca_runtime_config = AlpacaBrokerRuntimeConfig.from_env()
        return self._alpaca_runtime_config

    @property
    def alpaca_client(self) -> AlpacaBrokerHttpClient:
        if self._alpaca_client is None:
            self._alpaca_client = AlpacaBrokerHttpClient(self.alpaca_config)
        return self._alpaca_client

    def is_configured(self) -> bool:
        return self.plaid_config.configured and self.alpaca_config.configured

    def configuration_status(self) -> dict[str, Any]:
        return {
            **self.plaid_config.to_status(),
            **self.alpaca_config.to_status(),
            "funding_orchestration_ready": self.is_configured(),
        }

    async def _plaid_post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self.plaid_client.post(path, payload)

    async def _alpaca_get(
        self,
        path: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any] | list[Any]:
        return await self.alpaca_client.get(path, params=params)

    async def _alpaca_post(
        self,
        path: str,
        payload: dict[str, Any],
    ) -> dict[str, Any] | list[Any]:
        return await self.alpaca_client.post(path, payload)

    async def _alpaca_delete(self, path: str) -> dict[str, Any] | list[Any]:
        return await self.alpaca_client.delete(path)

    def _resolve_secret_encryption_key(self) -> bytes:
        configured = _clean_text(
            os.getenv("FUNDING_SECRET_ENCRYPTION_KEY") or os.getenv("PLAID_TOKEN_ENCRYPTION_KEY")
        )
        if configured:
            try:
                decoded = base64.urlsafe_b64decode(configured.encode("utf-8"))
                if len(decoded) in {16, 24, 32}:
                    return decoded
            except Exception:
                pass
            if len(configured.encode("utf-8")) in {16, 24, 32}:
                return configured.encode("utf-8")

        digest = hashlib.sha256(
            (
                f"{self.plaid_config.client_id}::{self.plaid_config.secret}::"
                f"{self.alpaca_config.auth_header}::{self.alpaca_config.base_url}"
            ).encode("utf-8")
        ).digest()
        if not self._warned_fallback_encryption_key:
            logger.warning("funding.secret_encryption_key_missing_using_derived_fallback")
            self._warned_fallback_encryption_key = True
        return digest

    def _encrypt_secret(self, plaintext: str) -> dict[str, str]:
        key = self._resolve_secret_encryption_key()
        aesgcm = AESGCM(key)
        iv = os.urandom(12)
        ciphertext_with_tag = aesgcm.encrypt(iv, plaintext.encode("utf-8"), None)
        ciphertext = ciphertext_with_tag[:-16]
        tag = ciphertext_with_tag[-16:]
        return {
            "ciphertext": base64.urlsafe_b64encode(ciphertext).decode("utf-8"),
            "iv": base64.urlsafe_b64encode(iv).decode("utf-8"),
            "tag": base64.urlsafe_b64encode(tag).decode("utf-8"),
            "algorithm": "aes-256-gcm",
        }

    def _decrypt_secret(
        self,
        *,
        ciphertext: str,
        iv: str,
        tag: str,
    ) -> str:
        if not ciphertext or not iv or not tag:
            raise FundingOrchestrationError(
                "Stored encrypted secret envelope is incomplete.",
                code="ENCRYPTED_SECRET_INVALID",
                status_code=500,
            )
        key = self._resolve_secret_encryption_key()
        aesgcm = AESGCM(key)
        plaintext = aesgcm.decrypt(
            base64.urlsafe_b64decode(iv.encode("utf-8")),
            base64.urlsafe_b64decode(ciphertext.encode("utf-8"))
            + base64.urlsafe_b64decode(tag.encode("utf-8")),
            None,
        )
        return plaintext.decode("utf-8")

    def _fetch_default_brokerage_account(self, *, user_id: str) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_brokerage_accounts
            WHERE user_id = :user_id AND is_default = TRUE
            LIMIT 1
            """,
            {"user_id": user_id},
        )
        return result.data[0] if result.data else None

    def _fetch_latest_relationship_alpaca_account(self, *, user_id: str) -> str | None:
        result = self.db.execute_raw(
            """
            SELECT alpaca_account_id
            FROM kai_funding_ach_relationships
            WHERE user_id = :user_id
              AND alpaca_account_id IS NOT NULL
            ORDER BY updated_at DESC, created_at DESC
            LIMIT 1
            """,
            {"user_id": user_id},
        )
        if not result.data:
            return None
        return _clean_text(result.data[0].get("alpaca_account_id")) or None

    def _find_brokerage_account(
        self,
        *,
        user_id: str,
        alpaca_account_id: str,
    ) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_brokerage_accounts
            WHERE user_id = :user_id
              AND alpaca_account_id = :alpaca_account_id
            LIMIT 1
            """,
            {
                "user_id": user_id,
                "alpaca_account_id": alpaca_account_id,
            },
        )
        return result.data[0] if result.data else None

    def _upsert_brokerage_account(
        self,
        *,
        user_id: str,
        alpaca_account_id: str,
        set_as_default: bool,
        status: str = "active",
        metadata: dict[str, Any] | None = None,
    ) -> None:
        if set_as_default:
            self.db.execute_raw(
                """
                UPDATE kai_funding_brokerage_accounts
                SET is_default = FALSE,
                    updated_at = NOW()
                WHERE user_id = :user_id
                """,
                {"user_id": user_id},
            )

        self.db.execute_raw(
            """
            INSERT INTO kai_funding_brokerage_accounts (
                user_id,
                provider,
                alpaca_account_id,
                status,
                is_default,
                account_metadata_json,
                created_at,
                updated_at
            )
            VALUES (
                :user_id,
                'alpaca',
                :alpaca_account_id,
                :status,
                :is_default,
                CAST(:account_metadata_json AS JSONB),
                NOW(),
                NOW()
            )
            ON CONFLICT (user_id, alpaca_account_id)
            DO UPDATE SET
                status = EXCLUDED.status,
                is_default = EXCLUDED.is_default,
                account_metadata_json = EXCLUDED.account_metadata_json,
                updated_at = NOW()
            """,
            {
                "user_id": user_id,
                "alpaca_account_id": alpaca_account_id,
                "status": status,
                "is_default": set_as_default,
                "account_metadata_json": json.dumps(metadata or {}),
            },
        )

    def _resolve_alpaca_account_id(
        self,
        *,
        user_id: str,
        requested_account_id: str | None,
    ) -> str:
        default_row = self._fetch_default_brokerage_account(user_id=user_id)
        default_account_id = (
            _clean_text(default_row.get("alpaca_account_id")) if default_row else ""
        )
        latest_relationship_account_id = (
            self._fetch_latest_relationship_alpaca_account(user_id=user_id) or ""
        )
        configured_default = _clean_text(self.alpaca_config.default_account_id)

        cleaned_requested = _clean_text(requested_account_id)
        if cleaned_requested:
            if self._find_brokerage_account(
                user_id=user_id,
                alpaca_account_id=cleaned_requested,
            ):
                return cleaned_requested
            if _looks_like_alpaca_account_id(cleaned_requested):
                return cleaned_requested

            fallback_account_id = (
                default_account_id or latest_relationship_account_id or configured_default
            )
            if fallback_account_id:
                logger.warning(
                    "funding.requested_brokerage_account_not_alpaca user_id=%s requested=%s fallback=%s",
                    user_id,
                    cleaned_requested,
                    fallback_account_id,
                )
                return fallback_account_id

            raise FundingOrchestrationError(
                "Requested brokerage destination is not a valid Alpaca account ID.",
                code="ALPACA_ACCOUNT_NOT_MAPPED",
                status_code=422,
                details={
                    "requested_account_id": cleaned_requested,
                },
            )

        if default_account_id:
            return default_account_id
        if latest_relationship_account_id:
            return latest_relationship_account_id
        if configured_default:
            return configured_default

        raise FundingOrchestrationError(
            "No Alpaca brokerage account is configured for this user. Complete Alpaca brokerage onboarding and map the account before funding transfers.",
            code="ALPACA_ACCOUNT_REQUIRED",
            status_code=422,
        )

    def _alpaca_connect_config(self) -> dict[str, Any]:
        client_id = _clean_text(os.getenv("ALPACA_CONNECT_CLIENT_ID"))
        client_secret = _clean_text(os.getenv("ALPACA_CONNECT_CLIENT_SECRET"))
        redirect_uri = _normalize_https_url(
            os.getenv("ALPACA_CONNECT_REDIRECT_URI") or os.getenv("ALPACA_OAUTH_REDIRECT_URI")
        )
        authorize_url = _normalize_https_url(
            os.getenv("ALPACA_CONNECT_AUTHORIZE_URL") or _ALPACA_CONNECT_DEFAULT_AUTHORIZE_URL
        )
        token_url = _normalize_https_url(
            os.getenv("ALPACA_CONNECT_TOKEN_URL") or _ALPACA_CONNECT_DEFAULT_TOKEN_URL
        )
        account_url = _normalize_https_url(
            os.getenv("ALPACA_CONNECT_ACCOUNT_URL") or _ALPACA_CONNECT_DEFAULT_ACCOUNT_URL
        )
        raw_scopes = _clean_text(
            os.getenv("ALPACA_CONNECT_SCOPES"), default=_ALPACA_CONNECT_DEFAULT_SCOPES
        )
        scopes = [scope for scope in raw_scopes.split(" ") if scope.strip()]
        if not scopes:
            scopes = _ALPACA_CONNECT_DEFAULT_SCOPES.split(" ")
        try:
            ttl_seconds = int(
                os.getenv(
                    "ALPACA_CONNECT_STATE_TTL_SECONDS",
                    str(_ALPACA_CONNECT_SESSION_TTL_SECONDS_DEFAULT),
                )
                or str(_ALPACA_CONNECT_SESSION_TTL_SECONDS_DEFAULT)
            )
        except Exception:
            ttl_seconds = _ALPACA_CONNECT_SESSION_TTL_SECONDS_DEFAULT
        ttl_seconds = max(120, min(ttl_seconds, 24 * 3600))
        oauth_env = _clean_text(os.getenv("ALPACA_CONNECT_ENV")).lower()
        if oauth_env not in {"paper", "live"}:
            oauth_env = "live" if self.alpaca_config.environment == "production" else "paper"

        return {
            "configured": bool(
                client_id and client_secret and redirect_uri and authorize_url and token_url
            ),
            "missing_required": [
                *([] if client_id else ["ALPACA_CONNECT_CLIENT_ID"]),
                *([] if client_secret else ["ALPACA_CONNECT_CLIENT_SECRET"]),
                *(
                    []
                    if redirect_uri
                    else ["ALPACA_CONNECT_REDIRECT_URI (or ALPACA_OAUTH_REDIRECT_URI)"]
                ),
            ],
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "authorize_url": authorize_url,
            "token_url": token_url,
            "account_url": account_url,
            "scopes": scopes,
            "ttl_seconds": ttl_seconds,
            "oauth_env": oauth_env,
        }

    def _create_alpaca_connect_session(
        self,
        *,
        user_id: str,
        redirect_uri: str,
        ttl_seconds: int,
    ) -> dict[str, Any]:
        session_id = f"alpaca_connect_{uuid.uuid4().hex}"
        state = f"alpaca_state_{uuid.uuid4().hex}"
        expires_at = (_utcnow() + timedelta(seconds=ttl_seconds)).isoformat().replace("+00:00", "Z")
        self.db.execute_raw(
            """
            INSERT INTO kai_funding_alpaca_connect_sessions (
                session_id,
                user_id,
                state,
                redirect_uri,
                status,
                metadata_json,
                expires_at,
                created_at,
                updated_at
            )
            VALUES (
                :session_id,
                :user_id,
                :state,
                :redirect_uri,
                'pending',
                CAST(:metadata_json AS JSONB),
                CAST(:expires_at AS TIMESTAMPTZ),
                NOW(),
                NOW()
            )
            """,
            {
                "session_id": session_id,
                "user_id": user_id,
                "state": state,
                "redirect_uri": redirect_uri,
                "metadata_json": json.dumps({}),
                "expires_at": expires_at,
            },
        )
        return {
            "session_id": session_id,
            "state": state,
            "redirect_uri": redirect_uri,
            "expires_at": expires_at,
        }

    def _get_alpaca_connect_session(
        self,
        *,
        user_id: str,
        state: str,
    ) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_alpaca_connect_sessions
            WHERE user_id = :user_id
              AND state = :state
            ORDER BY created_at DESC
            LIMIT 1
            """,
            {
                "user_id": user_id,
                "state": state,
            },
        )
        return result.data[0] if result.data else None

    def _mark_alpaca_connect_session(
        self,
        *,
        session_id: str,
        status: str,
        error_code: str | None = None,
        error_message: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.db.execute_raw(
            """
            UPDATE kai_funding_alpaca_connect_sessions
            SET status = :status,
                consumed_at = CASE WHEN :status IN ('completed', 'failed', 'expired', 'replayed') THEN NOW() ELSE consumed_at END,
                error_code = :error_code,
                error_message = :error_message,
                metadata_json = CAST(:metadata_json AS JSONB),
                updated_at = NOW()
            WHERE session_id = :session_id
            """,
            {
                "session_id": session_id,
                "status": status,
                "error_code": _clean_text(error_code) or None,
                "error_message": _clean_text(error_message) or None,
                "metadata_json": json.dumps(metadata or {}),
            },
        )

    def _fetch_funding_item_row(self, *, user_id: str, item_id: str) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_plaid_items
            WHERE user_id = :user_id
              AND item_id = :item_id
            LIMIT 1
            """,
            {"user_id": user_id, "item_id": item_id},
        )
        return result.data[0] if result.data else None

    def _fetch_funding_item_by_item_id(self, *, item_id: str) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_plaid_items
            WHERE item_id = :item_id
            LIMIT 1
            """,
            {"item_id": item_id},
        )
        return result.data[0] if result.data else None

    def _list_funding_item_rows(self, *, user_id: str) -> list[dict[str, Any]]:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_plaid_items
            WHERE user_id = :user_id
              AND status != 'removed'
            ORDER BY updated_at DESC, created_at DESC
            """,
            {"user_id": user_id},
        )
        return result.data

    def _list_funding_accounts(self, *, user_id: str, item_id: str) -> list[dict[str, Any]]:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_plaid_accounts
            WHERE user_id = :user_id
              AND item_id = :item_id
            ORDER BY is_default DESC, updated_at DESC, created_at DESC
            """,
            {"user_id": user_id, "item_id": item_id},
        )
        return result.data

    def _find_funding_account(
        self,
        *,
        user_id: str,
        item_id: str,
        account_id: str,
    ) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_plaid_accounts
            WHERE user_id = :user_id
              AND item_id = :item_id
              AND account_id = :account_id
            LIMIT 1
            """,
            {
                "user_id": user_id,
                "item_id": item_id,
                "account_id": account_id,
            },
        )
        return result.data[0] if result.data else None

    def _set_default_funding_account(
        self,
        *,
        user_id: str,
        item_id: str,
        account_id: str,
    ) -> None:
        self.db.execute_raw(
            """
            UPDATE kai_funding_plaid_accounts
            SET is_default = FALSE,
                updated_at = NOW()
            WHERE user_id = :user_id
            """,
            {"user_id": user_id},
        )
        self.db.execute_raw(
            """
            UPDATE kai_funding_plaid_accounts
            SET is_default = TRUE,
                updated_at = NOW()
            WHERE user_id = :user_id
              AND item_id = :item_id
              AND account_id = :account_id
            """,
            {
                "user_id": user_id,
                "item_id": item_id,
                "account_id": account_id,
            },
        )
        self._update_selected_funding_account_metadata(
            user_id=user_id,
            item_id=item_id,
            account_id=account_id,
        )

    def _update_selected_funding_account_metadata(
        self,
        *,
        user_id: str,
        item_id: str,
        account_id: str,
    ) -> None:
        item_row = self._fetch_funding_item_row(user_id=user_id, item_id=item_id)
        if item_row is None:
            return
        metadata = _json_load(item_row.get("latest_metadata_json"), fallback={})
        if not isinstance(metadata, dict):
            metadata = {}
        metadata["selected_funding_account_id"] = account_id
        metadata["last_selected_funding_account_at"] = _utcnow_iso()
        self.db.execute_raw(
            """
            UPDATE kai_funding_plaid_items
            SET latest_metadata_json = CAST(:latest_metadata_json AS JSONB),
                updated_at = NOW()
            WHERE user_id = :user_id
              AND item_id = :item_id
            """,
            {
                "user_id": user_id,
                "item_id": item_id,
                "latest_metadata_json": json.dumps(metadata),
            },
        )

    def _store_funding_item(
        self,
        *,
        user_id: str,
        item_id: str,
        access_token: str,
        institution_id: str | None,
        institution_name: str | None,
        metadata: dict[str, Any],
    ) -> None:
        envelope = self._encrypt_secret(access_token)
        self.db.execute_raw(
            """
            INSERT INTO kai_funding_plaid_items (
                item_id,
                user_id,
                access_token_ciphertext,
                access_token_iv,
                access_token_tag,
                access_token_algorithm,
                institution_id,
                institution_name,
                plaid_env,
                status,
                latest_metadata_json,
                last_synced_at,
                created_at,
                updated_at
            )
            VALUES (
                :item_id,
                :user_id,
                :access_token_ciphertext,
                :access_token_iv,
                :access_token_tag,
                :access_token_algorithm,
                :institution_id,
                :institution_name,
                :plaid_env,
                'active',
                CAST(:latest_metadata_json AS JSONB),
                NOW(),
                NOW(),
                NOW()
            )
            ON CONFLICT (item_id)
            DO UPDATE SET
                user_id = EXCLUDED.user_id,
                access_token_ciphertext = EXCLUDED.access_token_ciphertext,
                access_token_iv = EXCLUDED.access_token_iv,
                access_token_tag = EXCLUDED.access_token_tag,
                access_token_algorithm = EXCLUDED.access_token_algorithm,
                institution_id = EXCLUDED.institution_id,
                institution_name = EXCLUDED.institution_name,
                plaid_env = EXCLUDED.plaid_env,
                status = 'active',
                latest_metadata_json = EXCLUDED.latest_metadata_json,
                last_error_code = NULL,
                last_error_message = NULL,
                updated_at = NOW(),
                last_synced_at = NOW()
            """,
            {
                "item_id": item_id,
                "user_id": user_id,
                "access_token_ciphertext": envelope["ciphertext"],
                "access_token_iv": envelope["iv"],
                "access_token_tag": envelope["tag"],
                "access_token_algorithm": envelope["algorithm"],
                "institution_id": institution_id,
                "institution_name": institution_name,
                "plaid_env": self.plaid_config.environment,
                "latest_metadata_json": json.dumps(metadata),
            },
        )

    def _replace_funding_accounts(
        self,
        *,
        user_id: str,
        item_id: str,
        accounts: list[dict[str, Any]],
        default_account_id: str | None,
    ) -> None:
        self.db.execute_raw(
            """
            DELETE FROM kai_funding_plaid_accounts
            WHERE user_id = :user_id
              AND item_id = :item_id
            """,
            {
                "user_id": user_id,
                "item_id": item_id,
            },
        )

        # A partial unique index enforces only one default account per user.
        # Reset any prior defaults before inserting the refreshed account set.
        if _clean_text(default_account_id):
            self.db.execute_raw(
                """
                UPDATE kai_funding_plaid_accounts
                SET is_default = FALSE,
                    updated_at = NOW()
                WHERE user_id = :user_id
                  AND is_default = TRUE
                """,
                {"user_id": user_id},
            )

        for account in accounts:
            account_id = _clean_text(account.get("account_id"))
            if not account_id:
                continue
            self.db.execute_raw(
                """
                INSERT INTO kai_funding_plaid_accounts (
                    user_id,
                    item_id,
                    account_id,
                    account_name,
                    official_name,
                    mask,
                    account_type,
                    account_subtype,
                    is_default,
                    account_metadata_json,
                    created_at,
                    updated_at
                )
                VALUES (
                    :user_id,
                    :item_id,
                    :account_id,
                    :account_name,
                    :official_name,
                    :mask,
                    :account_type,
                    :account_subtype,
                    :is_default,
                    CAST(:account_metadata_json AS JSONB),
                    NOW(),
                    NOW()
                )
                """,
                {
                    "user_id": user_id,
                    "item_id": item_id,
                    "account_id": account_id,
                    "account_name": _clean_text(account.get("name")) or None,
                    "official_name": _clean_text(account.get("official_name")) or None,
                    "mask": _clean_text(account.get("mask")) or None,
                    "account_type": _clean_text(account.get("type")) or None,
                    "account_subtype": _clean_text(account.get("subtype")) or None,
                    "is_default": account_id == default_account_id,
                    "account_metadata_json": json.dumps(account),
                },
            )

    def _record_consent(
        self,
        *,
        user_id: str,
        item_id: str,
        account_id: str,
        terms_version: str,
        consented_at: str | None,
        disclosure_version: str | None,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        consent_id = f"funding_consent_{uuid.uuid4().hex}"
        consented_at_ts = _clean_text(consented_at) or _utcnow_iso()
        result = self.db.execute_raw(
            """
            INSERT INTO kai_funding_consent_records (
                consent_id,
                user_id,
                item_id,
                account_id,
                terms_version,
                consented_at,
                disclosure_version,
                consent_metadata_json,
                created_at,
                updated_at
            )
            VALUES (
                :consent_id,
                :user_id,
                :item_id,
                :account_id,
                :terms_version,
                CAST(:consented_at AS TIMESTAMPTZ),
                :disclosure_version,
                CAST(:consent_metadata_json AS JSONB),
                NOW(),
                NOW()
            )
            RETURNING *
            """,
            {
                "consent_id": consent_id,
                "user_id": user_id,
                "item_id": item_id,
                "account_id": account_id,
                "terms_version": terms_version,
                "consented_at": consented_at_ts,
                "disclosure_version": disclosure_version,
                "consent_metadata_json": json.dumps(metadata),
            },
        )
        return result.data[0]

    def _get_funding_item_access_token(self, row: dict[str, Any]) -> str:
        return self._decrypt_secret(
            ciphertext=_clean_text(row.get("access_token_ciphertext")),
            iv=_clean_text(row.get("access_token_iv")),
            tag=_clean_text(row.get("access_token_tag")),
        )

    def _extract_preferred_account_ids(self, metadata: dict[str, Any] | None) -> list[str]:
        if not isinstance(metadata, dict):
            return []
        out: list[str] = []
        direct_account_id = _clean_text(metadata.get("account_id"))
        if direct_account_id:
            out.append(direct_account_id)
        selected = metadata.get("accounts")
        if isinstance(selected, list):
            for account in selected:
                if not isinstance(account, dict):
                    continue
                account_id = _clean_text(account.get("id") or account.get("account_id"))
                if account_id:
                    out.append(account_id)
        return _unique_texts(out)

    def _pick_default_account_id(
        self,
        *,
        accounts: list[dict[str, Any]],
        preferred_ids: list[str],
    ) -> str | None:
        account_ids = [_clean_text(account.get("account_id")) for account in accounts]
        account_ids = [account_id for account_id in account_ids if account_id]
        for preferred in preferred_ids:
            if preferred in account_ids:
                return preferred

        for account in accounts:
            account_id = _clean_text(account.get("account_id"))
            subtype = _clean_text(account.get("subtype")).lower()
            if account_id and subtype in {"checking", "savings"}:
                return account_id

        return account_ids[0] if account_ids else None

    def _normalize_plaid_accounts(self, payload_accounts: Any) -> list[dict[str, Any]]:
        accounts = _as_list_of_dicts(payload_accounts)
        depository = [
            account
            for account in accounts
            if _clean_text(account.get("type")).lower() == "depository"
        ]
        source = depository if depository else accounts
        out: list[dict[str, Any]] = []
        for account in source:
            account_id = _clean_text(account.get("account_id"))
            if not account_id:
                continue
            out.append(
                {
                    "account_id": account_id,
                    "name": _clean_text(account.get("name")) or None,
                    "official_name": _clean_text(account.get("official_name")) or None,
                    "mask": _clean_text(account.get("mask")) or None,
                    "type": _clean_text(account.get("type")) or None,
                    "subtype": _clean_text(account.get("subtype")) or None,
                    "verification_status": _clean_text(account.get("verification_status")) or None,
                    "balances": account.get("balances")
                    if isinstance(account.get("balances"), dict)
                    else {},
                }
            )
        return out

    async def create_funding_link_token(
        self,
        *,
        user_id: str,
        item_id: str | None = None,
        redirect_uri: str | None = None,
    ) -> dict[str, Any]:
        if not self.plaid_config.configured:
            return {
                **self.configuration_status(),
                "flow_type": "funding",
                "mode": "unconfigured",
                "link_token": None,
                "expiration": None,
            }

        payload: dict[str, Any] = {
            "client_name": self.plaid_config.client_name,
            "user": {"client_user_id": user_id},
            "country_codes": list(self.plaid_config.country_codes),
            "language": self.plaid_config.language,
            "products": ["auth"],
            "optional_products": ["transactions"],
            "account_filters": {
                "depository": {
                    "account_subtypes": ["checking", "savings"],
                }
            },
        }

        if self.plaid_config.webhook_url:
            payload["webhook"] = self.plaid_config.webhook_url

        resolved_redirect_uri = self.plaid_config.resolve_redirect_uri(redirect_uri)
        if resolved_redirect_uri:
            payload["redirect_uri"] = resolved_redirect_uri

        mode = "create"
        cleaned_item_id = _clean_text(item_id)
        if cleaned_item_id:
            row = self._fetch_funding_item_row(user_id=user_id, item_id=cleaned_item_id)
            if row is None:
                raise FundingOrchestrationError(
                    "Plaid funding item not found for update mode.",
                    code="PLAID_FUNDING_ITEM_NOT_FOUND",
                    status_code=404,
                )
            payload["access_token"] = self._get_funding_item_access_token(row)
            payload["update"] = {"account_selection_enabled": True}
            mode = "update"

        response = await self._plaid_post("/link/token/create", payload)
        return {
            **self.configuration_status(),
            "flow_type": "funding",
            "mode": mode,
            "link_token": _clean_text(response.get("link_token")) or None,
            "expiration": _clean_text(response.get("expiration")) or None,
            "request_id": response.get("request_id"),
            "redirect_uri": resolved_redirect_uri,
        }

    async def _create_plaid_processor_token(
        self,
        *,
        access_token: str,
        plaid_account_id: str,
    ) -> str:
        response = await self._plaid_post(
            "/processor/token/create",
            {
                "access_token": access_token,
                "account_id": plaid_account_id,
                "processor": "alpaca",
            },
        )
        processor_token = _clean_text(response.get("processor_token"))
        if not processor_token:
            raise FundingOrchestrationError(
                "Plaid processor token response did not include a processor_token.",
                code="PLAID_PROCESSOR_TOKEN_MISSING",
                status_code=502,
            )
        return processor_token

    def _extract_relationship_id(self, payload: dict[str, Any]) -> str:
        relationship_id = _clean_text(payload.get("id") or payload.get("relationship_id"))
        if not relationship_id:
            raise FundingOrchestrationError(
                "Alpaca ACH relationship response did not include an ID.",
                code="ALPACA_RELATIONSHIP_ID_MISSING",
                status_code=502,
            )
        return relationship_id

    def _extract_relationship_status(self, payload: dict[str, Any]) -> str:
        return _clean_text(payload.get("status"), default="QUEUED").upper()

    def _store_relationship(
        self,
        *,
        user_id: str,
        alpaca_account_id: str,
        item_id: str,
        account_id: str,
        relationship_id: str,
        processor_token: str,
        status: str,
        payload: dict[str, Any],
        status_reason_code: str | None = None,
        status_reason_message: str | None = None,
    ) -> None:
        envelope = self._encrypt_secret(processor_token)
        self.db.execute_raw(
            """
            INSERT INTO kai_funding_ach_relationships (
                relationship_id,
                user_id,
                alpaca_account_id,
                item_id,
                account_id,
                processor_token_ciphertext,
                processor_token_iv,
                processor_token_tag,
                processor_token_algorithm,
                status,
                status_reason_code,
                status_reason_message,
                relationship_payload_json,
                last_synced_at,
                created_at,
                updated_at
            )
            VALUES (
                :relationship_id,
                :user_id,
                :alpaca_account_id,
                :item_id,
                :account_id,
                :processor_token_ciphertext,
                :processor_token_iv,
                :processor_token_tag,
                :processor_token_algorithm,
                :status,
                :status_reason_code,
                :status_reason_message,
                CAST(:relationship_payload_json AS JSONB),
                NOW(),
                NOW(),
                NOW()
            )
            ON CONFLICT (relationship_id)
            DO UPDATE SET
                status = EXCLUDED.status,
                status_reason_code = EXCLUDED.status_reason_code,
                status_reason_message = EXCLUDED.status_reason_message,
                relationship_payload_json = EXCLUDED.relationship_payload_json,
                last_synced_at = NOW(),
                updated_at = NOW()
            """,
            {
                "relationship_id": relationship_id,
                "user_id": user_id,
                "alpaca_account_id": alpaca_account_id,
                "item_id": item_id,
                "account_id": account_id,
                "processor_token_ciphertext": envelope["ciphertext"],
                "processor_token_iv": envelope["iv"],
                "processor_token_tag": envelope["tag"],
                "processor_token_algorithm": envelope["algorithm"],
                "status": status.lower(),
                "status_reason_code": status_reason_code,
                "status_reason_message": status_reason_message,
                "relationship_payload_json": json.dumps(payload),
            },
        )

    def _find_relationship(
        self,
        *,
        user_id: str,
        alpaca_account_id: str,
        item_id: str,
        account_id: str,
    ) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_ach_relationships
            WHERE user_id = :user_id
              AND alpaca_account_id = :alpaca_account_id
              AND item_id = :item_id
              AND account_id = :account_id
            ORDER BY updated_at DESC, created_at DESC
            LIMIT 1
            """,
            {
                "user_id": user_id,
                "alpaca_account_id": alpaca_account_id,
                "item_id": item_id,
                "account_id": account_id,
            },
        )
        return result.data[0] if result.data else None

    def _find_relationship_by_id(
        self, *, user_id: str, relationship_id: str
    ) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_ach_relationships
            WHERE user_id = :user_id
              AND relationship_id = :relationship_id
            LIMIT 1
            """,
            {
                "user_id": user_id,
                "relationship_id": relationship_id,
            },
        )
        return result.data[0] if result.data else None

    async def _refresh_relationship_status(
        self,
        *,
        relationship: dict[str, Any],
    ) -> dict[str, Any]:
        relationship_id = _clean_text(relationship.get("relationship_id"))
        alpaca_account_id = _clean_text(relationship.get("alpaca_account_id"))
        user_id = _clean_text(relationship.get("user_id"))
        if not relationship_id or not alpaca_account_id or not user_id:
            return relationship

        response = await self._alpaca_get(
            f"/v1/accounts/{alpaca_account_id}/ach_relationships/{relationship_id}"
        )
        payload = response if isinstance(response, dict) else {}
        status = self._extract_relationship_status(payload)

        existing_payload = _json_load(relationship.get("relationship_payload_json"), fallback={})
        processor_token = self._decrypt_secret(
            ciphertext=_clean_text(relationship.get("processor_token_ciphertext")),
            iv=_clean_text(relationship.get("processor_token_iv")),
            tag=_clean_text(relationship.get("processor_token_tag")),
        )
        merged_payload = {**existing_payload, **payload}
        self._store_relationship(
            user_id=user_id,
            alpaca_account_id=alpaca_account_id,
            item_id=_clean_text(relationship.get("item_id")),
            account_id=_clean_text(relationship.get("account_id")),
            relationship_id=relationship_id,
            processor_token=processor_token,
            status=status,
            payload=merged_payload,
            status_reason_code=_clean_text(payload.get("reason_code")) or None,
            status_reason_message=_clean_text(payload.get("reason")) or None,
        )
        refreshed = self._find_relationship_by_id(user_id=user_id, relationship_id=relationship_id)
        return refreshed or relationship

    async def _create_or_refresh_relationship(
        self,
        *,
        user_id: str,
        alpaca_account_id: str,
        item_id: str,
        account_id: str,
        access_token: str,
        auto_poll: bool,
    ) -> dict[str, Any]:
        existing = self._find_relationship(
            user_id=user_id,
            alpaca_account_id=alpaca_account_id,
            item_id=item_id,
            account_id=account_id,
        )
        if existing:
            status = _clean_text(existing.get("status")).upper()
            if status in _RELATIONSHIP_APPROVED_STATUSES:
                return existing
            if status in _RELATIONSHIP_PENDING_STATUSES:
                refreshed = await self._refresh_relationship_status(relationship=existing)
                refreshed_status = _clean_text(refreshed.get("status")).upper()
                if refreshed_status in _RELATIONSHIP_APPROVED_STATUSES:
                    return refreshed
                if refreshed_status in _RELATIONSHIP_PENDING_STATUSES:
                    return (
                        await self._poll_for_relationship_approval(refreshed)
                        if auto_poll
                        else refreshed
                    )
            if status not in _RELATIONSHIP_TERMINAL_FAILURE_STATUSES:
                return existing

        processor_token = await self._create_plaid_processor_token(
            access_token=access_token,
            plaid_account_id=account_id,
        )
        response = await self._alpaca_post(
            f"/v1/accounts/{alpaca_account_id}/ach_relationships",
            {"processor_token": processor_token},
        )
        payload = response if isinstance(response, dict) else {}
        relationship_id = self._extract_relationship_id(payload)
        status = self._extract_relationship_status(payload)

        self._store_relationship(
            user_id=user_id,
            alpaca_account_id=alpaca_account_id,
            item_id=item_id,
            account_id=account_id,
            relationship_id=relationship_id,
            processor_token=processor_token,
            status=status,
            payload=payload,
            status_reason_code=_clean_text(payload.get("reason_code")) or None,
            status_reason_message=_clean_text(payload.get("reason")) or None,
        )

        relationship = self._find_relationship_by_id(
            user_id=user_id, relationship_id=relationship_id
        )
        if relationship is None:
            raise FundingOrchestrationError(
                "Failed to persist ACH relationship.",
                code="ACH_RELATIONSHIP_PERSIST_FAILED",
                status_code=500,
            )
        if (
            auto_poll
            and _clean_text(relationship.get("status")).upper() in _RELATIONSHIP_PENDING_STATUSES
        ):
            relationship = await self._poll_for_relationship_approval(relationship)
        return relationship

    async def _poll_for_relationship_approval(
        self,
        relationship: dict[str, Any],
    ) -> dict[str, Any]:
        timeout_seconds = max(
            0,
            int(os.getenv("FUNDING_ACH_RELATIONSHIP_POLL_SECONDS", "15") or "15"),
        )
        interval_seconds = max(
            1,
            int(os.getenv("FUNDING_ACH_RELATIONSHIP_POLL_INTERVAL_SECONDS", "2") or "2"),
        )
        if timeout_seconds == 0:
            return relationship

        deadline = _utcnow().timestamp() + timeout_seconds
        current = relationship
        while _utcnow().timestamp() < deadline:
            status = _clean_text(current.get("status")).upper()
            if status in _RELATIONSHIP_APPROVED_STATUSES:
                return current
            if status in _RELATIONSHIP_TERMINAL_FAILURE_STATUSES:
                return current
            await asyncio.sleep(interval_seconds)
            current = await self._refresh_relationship_status(relationship=current)

        return current

    def _parse_transfer_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        transfer = payload.get("transfer") if isinstance(payload.get("transfer"), dict) else payload
        amount_text = _clean_text(transfer.get("amount"))
        if not amount_text:
            decimal_amount = _to_decimal(transfer.get("amount"))
            amount_text = f"{decimal_amount:.2f}" if decimal_amount is not None else ""
        failure_reason_payload = (
            transfer.get("failure_reason")
            if isinstance(transfer.get("failure_reason"), dict)
            else transfer.get("reason")
        )
        reason_code = None
        reason_message = None
        if isinstance(failure_reason_payload, dict):
            reason_code = (
                _clean_text(
                    failure_reason_payload.get("code") or failure_reason_payload.get("reason_code")
                )
                or None
            )
            reason_message = (
                _clean_text(
                    failure_reason_payload.get("description")
                    or failure_reason_payload.get("reason")
                )
                or None
            )
        else:
            reason_message = _clean_text(failure_reason_payload) or None

        return {
            "transfer_id": _clean_text(transfer.get("id") or transfer.get("transfer_id")) or None,
            "status": _clean_text(transfer.get("status") or transfer.get("state")) or None,
            "direction": _clean_text(transfer.get("direction") or transfer.get("type")) or None,
            "amount": amount_text or None,
            "currency": _clean_text(transfer.get("currency") or transfer.get("currency_code"))
            or "USD",
            "created_at": _clean_text(transfer.get("created_at") or transfer.get("created"))
            or _utcnow_iso(),
            "failure_reason_code": reason_code,
            "failure_reason_message": reason_message,
            "raw": transfer if isinstance(transfer, dict) else {},
        }

    def _record_transfer_event(
        self,
        *,
        user_id: str,
        transfer_id: str,
        event_source: str,
        event_type: str,
        event_status: str | None,
        reason_code: str | None,
        reason_message: str | None,
        payload: dict[str, Any],
    ) -> None:
        self.db.execute_raw(
            """
            INSERT INTO kai_funding_transfer_events (
                event_id,
                transfer_id,
                user_id,
                event_source,
                event_type,
                event_status,
                reason_code,
                reason_message,
                payload_json,
                occurred_at,
                created_at
            )
            VALUES (
                :event_id,
                :transfer_id,
                :user_id,
                :event_source,
                :event_type,
                :event_status,
                :reason_code,
                :reason_message,
                CAST(:payload_json AS JSONB),
                NOW(),
                NOW()
            )
            """,
            {
                "event_id": f"transfer_event_{uuid.uuid4().hex}",
                "transfer_id": transfer_id,
                "user_id": user_id,
                "event_source": event_source,
                "event_type": event_type,
                "event_status": event_status,
                "reason_code": reason_code,
                "reason_message": reason_message,
                "payload_json": json.dumps(payload),
            },
        )

    def _fetch_transfer_row(self, *, user_id: str, transfer_id: str) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_transfers
            WHERE user_id = :user_id
              AND transfer_id = :transfer_id
            LIMIT 1
            """,
            {
                "user_id": user_id,
                "transfer_id": transfer_id,
            },
        )
        return result.data[0] if result.data else None

    def _fetch_transfer_row_by_idempotency(
        self,
        *,
        user_id: str,
        idempotency_key: str,
    ) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_transfers
            WHERE user_id = :user_id
              AND idempotency_key = :idempotency_key
            LIMIT 1
            """,
            {
                "user_id": user_id,
                "idempotency_key": idempotency_key,
            },
        )
        return result.data[0] if result.data else None

    def _store_transfer(
        self,
        *,
        user_id: str,
        transfer_id: str,
        alpaca_account_id: str,
        relationship_id: str,
        item_id: str,
        account_id: str,
        direction: str,
        amount: str,
        currency: str,
        status: str,
        idempotency_key: str,
        request_payload: dict[str, Any],
        response_payload: dict[str, Any],
        reason_code: str | None,
        reason_message: str | None,
        completed_at: str | None = None,
    ) -> None:
        self.db.execute_raw(
            """
            INSERT INTO kai_funding_transfers (
                transfer_id,
                user_id,
                alpaca_account_id,
                relationship_id,
                item_id,
                account_id,
                direction,
                amount,
                currency,
                status,
                user_facing_status,
                failure_reason_code,
                failure_reason_message,
                idempotency_key,
                request_payload_json,
                response_payload_json,
                requested_at,
                submitted_at,
                completed_at,
                created_at,
                updated_at
            )
            VALUES (
                :transfer_id,
                :user_id,
                :alpaca_account_id,
                :relationship_id,
                :item_id,
                :account_id,
                :direction,
                CAST(:amount AS NUMERIC),
                :currency,
                :status,
                :user_facing_status,
                :failure_reason_code,
                :failure_reason_message,
                :idempotency_key,
                CAST(:request_payload_json AS JSONB),
                CAST(:response_payload_json AS JSONB),
                NOW(),
                NOW(),
                CAST(:completed_at AS TIMESTAMPTZ),
                NOW(),
                NOW()
            )
            ON CONFLICT (transfer_id)
            DO UPDATE SET
                status = EXCLUDED.status,
                user_facing_status = EXCLUDED.user_facing_status,
                failure_reason_code = EXCLUDED.failure_reason_code,
                failure_reason_message = EXCLUDED.failure_reason_message,
                response_payload_json = EXCLUDED.response_payload_json,
                completed_at = COALESCE(EXCLUDED.completed_at, kai_funding_transfers.completed_at),
                updated_at = NOW()
            """,
            {
                "transfer_id": transfer_id,
                "user_id": user_id,
                "alpaca_account_id": alpaca_account_id,
                "relationship_id": relationship_id,
                "item_id": item_id,
                "account_id": account_id,
                "direction": direction,
                "amount": amount,
                "currency": currency,
                "status": status.lower(),
                "user_facing_status": _user_facing_transfer_status(status),
                "failure_reason_code": reason_code,
                "failure_reason_message": reason_message,
                "idempotency_key": idempotency_key,
                "request_payload_json": json.dumps(request_payload),
                "response_payload_json": json.dumps(response_payload),
                "completed_at": completed_at,
            },
        )

    async def _fetch_transfer_from_alpaca(
        self,
        *,
        alpaca_account_id: str,
        transfer_id: str,
    ) -> dict[str, Any] | None:
        try:
            response = await self._alpaca_get(
                f"/v1/accounts/{alpaca_account_id}/transfers/{transfer_id}"
            )
            if isinstance(response, dict):
                parsed = self._parse_transfer_payload(response)
                if _clean_text(parsed.get("transfer_id")):
                    return parsed
        except AlpacaApiError as exc:
            if exc.status_code != 404:
                raise

        list_response = await self._alpaca_get(f"/v1/accounts/{alpaca_account_id}/transfers")
        candidates: list[dict[str, Any]]
        if isinstance(list_response, dict):
            candidates = _as_list_of_dicts(
                list_response.get("transfers") or list_response.get("data")
            )
        else:
            candidates = _as_list_of_dicts(list_response)
        for candidate in candidates:
            parsed = self._parse_transfer_payload(candidate)
            if _clean_text(parsed.get("transfer_id")) == transfer_id:
                return parsed
        return None

    def _relationship_status_requirements(
        self,
        *,
        relationship: dict[str, Any],
    ) -> None:
        status = _clean_text(relationship.get("status")).upper()
        if status in _RELATIONSHIP_APPROVED_STATUSES:
            return
        if status in _RELATIONSHIP_PENDING_STATUSES:
            raise FundingOrchestrationError(
                "ACH relationship is pending approval.",
                code="ACH_RELATIONSHIP_NOT_APPROVED",
                status_code=409,
                details={
                    "relationship_id": _clean_text(relationship.get("relationship_id")) or None,
                    "status": status,
                },
            )
        raise FundingOrchestrationError(
            "ACH relationship is not eligible for transfers.",
            code="ACH_RELATIONSHIP_INELIGIBLE",
            status_code=409,
            details={
                "relationship_id": _clean_text(relationship.get("relationship_id")) or None,
                "status": status,
                "reason_code": _clean_text(relationship.get("status_reason_code")) or None,
                "reason_message": _clean_text(relationship.get("status_reason_message")) or None,
            },
        )

    def _max_amount_for_direction(self, direction: str) -> Decimal:
        incoming_default = Decimal("250000")
        outgoing_default = Decimal("250000")
        raw = (
            os.getenv("FUNDING_TRANSFER_MAX_OUTGOING_USD")
            if direction == _FUNDS_DIRECTION_OUTGOING
            else os.getenv("FUNDING_TRANSFER_MAX_INCOMING_USD")
        )
        parsed = _to_decimal(raw)
        if parsed is None or parsed <= 0:
            return outgoing_default if direction == _FUNDS_DIRECTION_OUTGOING else incoming_default
        return parsed

    def _validate_amount_limit(self, *, direction: str, amount_text: str) -> None:
        amount_decimal = _to_decimal(amount_text)
        if amount_decimal is None:
            raise FundingOrchestrationError(
                "Transfer amount is invalid.",
                code="INVALID_TRANSFER_AMOUNT",
                status_code=422,
            )
        max_allowed = self._max_amount_for_direction(direction)
        if amount_decimal > max_allowed:
            raise FundingOrchestrationError(
                "Transfer amount exceeds the configured limit.",
                code="TRANSFER_LIMIT_EXCEEDED",
                status_code=422,
                details={
                    "max_allowed": f"{max_allowed:.2f}",
                    "requested": f"{amount_decimal:.2f}",
                    "direction": direction,
                },
            )

    def _transfer_status_notification_copy(
        self,
        *,
        transfer_id: str,
        user_facing_status: str,
        amount_text: str | None,
        direction: str | None,
        failure_reason: str | None,
    ) -> tuple[str, str]:
        direction_label = (
            "deposit to brokerage"
            if _clean_text(direction).upper() != _FUNDS_DIRECTION_OUTGOING
            else "withdrawal to bank"
        )
        amount_label = f"${amount_text}" if _clean_text(amount_text) else "your transfer"
        title = "Funding transfer update"
        if user_facing_status == "completed":
            return title, f"{amount_label} {direction_label} completed."
        if user_facing_status == "returned":
            return title, f"{amount_label} {direction_label} was returned by the provider."
        if user_facing_status == "canceled":
            return title, f"{amount_label} {direction_label} was canceled."
        if user_facing_status == "failed":
            if failure_reason:
                return title, f"{amount_label} {direction_label} failed: {failure_reason}"
            return title, f"{amount_label} {direction_label} failed."
        return title, f"Transfer {transfer_id} changed status to {user_facing_status}."

    def _stringify_notification_data(self, payload: dict[str, Any]) -> dict[str, str]:
        out: dict[str, str] = {}
        for key, value in payload.items():
            if value is None:
                continue
            if isinstance(value, (dict, list)):
                out[key] = json.dumps(value)
                continue
            out[key] = str(value)
        return out

    async def _send_transfer_status_notification(
        self,
        *,
        user_id: str,
        transfer_id: str,
        user_facing_status: str,
        raw_status: str,
        amount_text: str | None,
        direction: str | None,
        failure_reason: str | None,
    ) -> None:
        try:
            result = self.db.execute_raw(
                "SELECT token, platform FROM user_push_tokens WHERE user_id = :uid",
                {"uid": user_id},
            )
            if result.error or not result.data:
                logger.info(
                    "funding.transfer_notification_skipped_no_tokens user_id=%s transfer_id=%s",
                    user_id,
                    transfer_id,
                )
                return

            from api.utils.firebase_admin import ensure_firebase_admin

            configured, _ = ensure_firebase_admin()
            if not configured:
                logger.warning(
                    "funding.transfer_notification_skipped_firebase_not_configured user_id=%s",
                    user_id,
                )
                return

            from firebase_admin import messaging

            title, body = self._transfer_status_notification_copy(
                transfer_id=transfer_id,
                user_facing_status=user_facing_status,
                amount_text=amount_text,
                direction=direction,
                failure_reason=failure_reason,
            )
            message_data = self._stringify_notification_data(
                {
                    "type": "funding_transfer_status",
                    "user_id": user_id,
                    "transfer_id": transfer_id,
                    "status": raw_status.lower(),
                    "user_facing_status": user_facing_status,
                    "amount": amount_text,
                    "direction": direction,
                    "failure_reason_message": failure_reason,
                    "deep_link": "/kai/portfolio",
                }
            )

            for row in result.data:
                token = _clean_text(row.get("token"))
                if not token:
                    continue
                message = messaging.Message(
                    token=token,
                    data=message_data,
                    notification=messaging.Notification(title=title, body=body),
                )
                try:
                    messaging.send(message)
                except (messaging.UnregisteredError, messaging.SenderIdMismatchError):
                    logger.warning(
                        "funding.transfer_notification_stale_token user_id=%s transfer_id=%s",
                        user_id,
                        transfer_id,
                    )
                    try:
                        self.db.execute_raw(
                            "DELETE FROM user_push_tokens WHERE token = :token",
                            {"token": token},
                        )
                    except Exception as cleanup_exc:
                        logger.warning(
                            "funding.transfer_notification_stale_token_cleanup_failed user_id=%s error=%s",
                            user_id,
                            cleanup_exc,
                        )
                except Exception as send_exc:
                    logger.warning(
                        "funding.transfer_notification_send_failed user_id=%s transfer_id=%s error=%s",
                        user_id,
                        transfer_id,
                        send_exc,
                    )
        except Exception:
            logger.exception(
                "funding.transfer_notification_failed user_id=%s transfer_id=%s",
                user_id,
                transfer_id,
            )

    def _queue_transfer_status_notification_if_needed(
        self,
        *,
        user_id: str,
        transfer_id: str,
        previous_status: str | None,
        current_status: str | None,
        amount_text: str | None,
        direction: str | None,
        failure_reason: str | None,
    ) -> None:
        previous_user_status = _user_facing_transfer_status(previous_status)
        next_user_status = _user_facing_transfer_status(current_status)
        if next_user_status == previous_user_status:
            return
        if next_user_status not in _NOTIFIABLE_TRANSFER_USER_STATUSES:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        loop.create_task(
            self._send_transfer_status_notification(
                user_id=user_id,
                transfer_id=transfer_id,
                user_facing_status=next_user_status,
                raw_status=_clean_text(current_status, default="pending"),
                amount_text=amount_text,
                direction=direction,
                failure_reason=failure_reason,
            )
        )

    async def exchange_funding_public_token(
        self,
        *,
        user_id: str,
        public_token: str,
        metadata: dict[str, Any] | None = None,
        resume_session_id: str | None = None,
        terms_version: str | None = None,
        consent_timestamp: str | None = None,
        alpaca_account_id: str | None = None,
    ) -> dict[str, Any]:
        if not self.plaid_config.configured:
            raise FundingOrchestrationError(
                "Plaid is not configured for funding.",
                code="PLAID_NOT_CONFIGURED",
                status_code=503,
            )

        exchange = await self._plaid_post(
            "/item/public_token/exchange",
            {"public_token": public_token},
        )
        item_id = _clean_text(exchange.get("item_id"))
        access_token = _clean_text(exchange.get("access_token"))
        if not item_id or not access_token:
            raise FundingOrchestrationError(
                "Plaid exchange did not return item_id/access_token.",
                code="PLAID_EXCHANGE_INVALID_RESPONSE",
                status_code=502,
            )

        metadata_payload = metadata if isinstance(metadata, dict) else {}
        institution_payload = (
            metadata_payload.get("institution")
            if isinstance(metadata_payload.get("institution"), dict)
            else metadata_payload
        )
        institution_id = (
            _clean_text(institution_payload.get("institution_id") or institution_payload.get("id"))
            if isinstance(institution_payload, dict)
            else None
        )
        institution_name = (
            _clean_text(
                institution_payload.get("name") or institution_payload.get("institution_name")
            )
            if isinstance(institution_payload, dict)
            else None
        )

        accounts_response = await self._plaid_post("/accounts/get", {"access_token": access_token})
        normalized_accounts = self._normalize_plaid_accounts(accounts_response.get("accounts"))
        if not normalized_accounts:
            raise FundingOrchestrationError(
                "No eligible bank account was returned by Plaid.",
                code="PLAID_FUNDING_ACCOUNT_NOT_FOUND",
                status_code=422,
            )

        default_account_id = self._pick_default_account_id(
            accounts=normalized_accounts,
            preferred_ids=self._extract_preferred_account_ids(metadata_payload),
        )
        if not default_account_id:
            raise FundingOrchestrationError(
                "A default funding account could not be selected.",
                code="PLAID_DEFAULT_ACCOUNT_SELECTION_FAILED",
                status_code=422,
            )

        item_metadata = {
            "item_purpose": "funding",
            "item_id": item_id,
            "resume_session_id": _clean_text(resume_session_id) or None,
            "selected_funding_account_id": default_account_id,
            "funding_account_ids": [
                _clean_text(account.get("account_id")) for account in normalized_accounts
            ],
            "last_synced_at": _utcnow_iso(),
        }
        self._store_funding_item(
            user_id=user_id,
            item_id=item_id,
            access_token=access_token,
            institution_id=institution_id,
            institution_name=institution_name,
            metadata=item_metadata,
        )
        self._replace_funding_accounts(
            user_id=user_id,
            item_id=item_id,
            accounts=normalized_accounts,
            default_account_id=default_account_id,
        )

        consent_row = self._record_consent(
            user_id=user_id,
            item_id=item_id,
            account_id=default_account_id,
            terms_version=_clean_text(terms_version)
            or _clean_text(metadata_payload.get("terms_version"))
            or "v1",
            consented_at=consent_timestamp
            or _clean_text(metadata_payload.get("consent_timestamp"))
            or None,
            disclosure_version=_clean_text(metadata_payload.get("disclosure_version")) or None,
            metadata={
                "source": "plaid_link",
                "institution_id": institution_id,
                "institution_name": institution_name,
            },
        )

        resolved_alpaca_account_id = _clean_text(alpaca_account_id) or _clean_text(
            metadata_payload.get("alpaca_account_id")
        )
        relationship_payload: dict[str, Any] | None = None
        relationship_pending_reason: dict[str, Any] | None = None

        if self.alpaca_config.configured:
            try:
                alpaca_account = self._resolve_alpaca_account_id(
                    user_id=user_id,
                    requested_account_id=resolved_alpaca_account_id,
                )
            except FundingOrchestrationError as exc:
                if exc.code not in {"ALPACA_ACCOUNT_REQUIRED", "ALPACA_ACCOUNT_NOT_MAPPED"}:
                    raise
                relationship_pending_reason = {
                    "code": exc.code,
                    "message": str(exc),
                }
            else:
                self._upsert_brokerage_account(
                    user_id=user_id,
                    alpaca_account_id=alpaca_account,
                    set_as_default=True,
                )
                relationship = await self._create_or_refresh_relationship(
                    user_id=user_id,
                    alpaca_account_id=alpaca_account,
                    item_id=item_id,
                    account_id=default_account_id,
                    access_token=access_token,
                    auto_poll=True,
                )
                relationship_payload = {
                    "relationship_id": _clean_text(relationship.get("relationship_id")) or None,
                    "status": _clean_text(relationship.get("status")) or None,
                }

        status_payload = await self.get_funding_status(user_id=user_id)
        status_payload["consent_record"] = {
            "consent_id": _clean_text(consent_row.get("consent_id")) or None,
            "terms_version": _clean_text(consent_row.get("terms_version")) or None,
            "consented_at": _clean_text(consent_row.get("consented_at")) or None,
        }
        if relationship_payload:
            status_payload["ach_relationship"] = relationship_payload
        if relationship_pending_reason:
            status_payload["ach_relationship_pending_reason"] = relationship_pending_reason
        return status_payload

    async def get_funding_status(self, *, user_id: str) -> dict[str, Any]:
        item_rows = self._list_funding_item_rows(user_id=user_id)
        brokerage_result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_brokerage_accounts
            WHERE user_id = :user_id
            ORDER BY is_default DESC, updated_at DESC
            """,
            {"user_id": user_id},
        )

        transfer_result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_transfers
            WHERE user_id = :user_id
            ORDER BY requested_at DESC, updated_at DESC
            LIMIT 30
            """,
            {"user_id": user_id},
        )

        relationship_result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_ach_relationships
            WHERE user_id = :user_id
            ORDER BY updated_at DESC, created_at DESC
            """,
            {"user_id": user_id},
        )
        relationships = relationship_result.data

        items: list[dict[str, Any]] = []
        account_count = 0
        institutions: list[str] = []

        for item in item_rows:
            item_id = _clean_text(item.get("item_id"))
            if not item_id:
                continue
            accounts = self._list_funding_accounts(user_id=user_id, item_id=item_id)
            account_count += len(accounts)
            institution_name = _clean_text(item.get("institution_name")) or None
            if institution_name:
                institutions.append(institution_name)
            item_metadata = _json_load(item.get("latest_metadata_json"), fallback={})
            if not isinstance(item_metadata, dict):
                item_metadata = {}
            selected_funding_account_id = (
                _clean_text(item_metadata.get("selected_funding_account_id")) or None
            )
            account_payloads: list[dict[str, Any]] = []
            default_account_id: str | None = None
            for account in accounts:
                account_id = _clean_text(account.get("account_id")) or None
                is_default = bool(account.get("is_default"))
                if is_default and default_account_id is None:
                    default_account_id = account_id
                account_payloads.append(
                    {
                        "account_id": account_id,
                        "name": _clean_text(account.get("account_name")) or None,
                        "official_name": _clean_text(account.get("official_name")) or None,
                        "mask": _clean_text(account.get("mask")) or None,
                        "type": _clean_text(account.get("account_type")) or None,
                        "subtype": _clean_text(account.get("account_subtype")) or None,
                        "is_default": is_default,
                        "is_selected_funding_account": False,
                    }
                )
            if not selected_funding_account_id:
                selected_funding_account_id = default_account_id
            if selected_funding_account_id:
                for account_payload in account_payloads:
                    account_payload["is_selected_funding_account"] = (
                        account_payload.get("account_id") == selected_funding_account_id
                    )

            item_relationships = [
                relationship
                for relationship in relationships
                if _clean_text(relationship.get("item_id")) == item_id
            ]
            items.append(
                {
                    "item_id": item_id,
                    "institution_id": _clean_text(item.get("institution_id")) or None,
                    "institution_name": institution_name,
                    "status": _clean_text(item.get("status"), default="active"),
                    "last_synced_at": _clean_text(item.get("last_synced_at"))
                    or _clean_text(item_metadata.get("last_synced_at"))
                    or None,
                    "selected_funding_account_id": selected_funding_account_id,
                    "accounts": account_payloads,
                    "relationships": [
                        {
                            "relationship_id": _clean_text(relationship.get("relationship_id"))
                            or None,
                            "alpaca_account_id": _clean_text(relationship.get("alpaca_account_id"))
                            or None,
                            "account_id": _clean_text(relationship.get("account_id")) or None,
                            "status": _clean_text(relationship.get("status")) or None,
                            "status_reason_code": _clean_text(
                                relationship.get("status_reason_code")
                            )
                            or None,
                            "status_reason_message": _clean_text(
                                relationship.get("status_reason_message")
                            )
                            or None,
                            "updated_at": _clean_text(relationship.get("updated_at")) or None,
                        }
                        for relationship in item_relationships
                    ],
                }
            )

        latest_transfers = [
            {
                "transfer_id": _clean_text(transfer.get("transfer_id")) or None,
                "relationship_id": _clean_text(transfer.get("relationship_id")) or None,
                "alpaca_account_id": _clean_text(transfer.get("alpaca_account_id")) or None,
                "brokerage_account_id": _clean_text(transfer.get("alpaca_account_id")) or None,
                "funding_account_id": _clean_text(transfer.get("account_id")) or None,
                "direction": _clean_text(transfer.get("direction")) or None,
                "amount": _clean_text(str(transfer.get("amount")))
                if transfer.get("amount") is not None
                else None,
                "currency": _clean_text(transfer.get("currency")) or "USD",
                "status": _clean_text(transfer.get("status")) or None,
                "user_facing_status": _clean_text(transfer.get("user_facing_status")) or None,
                "requested_at": _clean_text(transfer.get("requested_at")) or None,
                "completed_at": _clean_text(transfer.get("completed_at")) or None,
                "failure_reason_code": _clean_text(transfer.get("failure_reason_code")) or None,
                "failure_reason_message": _clean_text(transfer.get("failure_reason_message"))
                or None,
            }
            for transfer in transfer_result.data
        ]

        return {
            **self.configuration_status(),
            "user_id": user_id,
            "items": items,
            "brokerage_accounts": [
                {
                    "alpaca_account_id": _clean_text(row.get("alpaca_account_id")) or None,
                    "status": _clean_text(row.get("status")) or None,
                    "is_default": bool(row.get("is_default")),
                }
                for row in brokerage_result.data
            ],
            "latest_transfers": latest_transfers,
            "aggregate": {
                "item_count": len(items),
                "account_count": account_count,
                "institution_names": _unique_texts(institutions),
                "relationship_count": len(relationships),
            },
        }

    async def sync_funding_transactions(
        self,
        *,
        user_id: str,
        item_id: str,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        row = self._fetch_funding_item_row(user_id=user_id, item_id=item_id)
        if row is None:
            raise FundingOrchestrationError(
                "No linked Plaid funding item is available.",
                code="PLAID_FUNDING_ITEM_NOT_FOUND",
                status_code=404,
            )

        access_token = self._get_funding_item_access_token(row)
        item_metadata = _json_load(row.get("latest_metadata_json"), fallback={})
        working_cursor = (
            _clean_text(cursor) or _clean_text(item_metadata.get("transactions_cursor")) or None
        )

        added: list[dict[str, Any]] = []
        modified: list[dict[str, Any]] = []
        removed: list[dict[str, Any]] = []

        while True:
            payload: dict[str, Any] = {"access_token": access_token}
            if working_cursor:
                payload["cursor"] = working_cursor
            response = await self._plaid_post("/transactions/sync", payload)
            added.extend(_as_list_of_dicts(response.get("added")))
            modified.extend(_as_list_of_dicts(response.get("modified")))
            removed.extend(_as_list_of_dicts(response.get("removed")))
            next_cursor = _clean_text(response.get("next_cursor")) or working_cursor
            has_more = _to_bool(response.get("has_more"))
            working_cursor = next_cursor
            if not has_more:
                break

        merged_metadata = {
            **item_metadata,
            "transactions_cursor": working_cursor,
            "last_transactions_sync_at": _utcnow_iso(),
            "latest_transactions_preview": added[-100:],
        }
        self.db.execute_raw(
            """
            UPDATE kai_funding_plaid_items
            SET latest_metadata_json = CAST(:latest_metadata_json AS JSONB),
                last_synced_at = NOW(),
                updated_at = NOW()
            WHERE user_id = :user_id
              AND item_id = :item_id
            """,
            {
                "user_id": user_id,
                "item_id": item_id,
                "latest_metadata_json": json.dumps(merged_metadata),
            },
        )

        return {
            "item_id": item_id,
            "next_cursor": working_cursor,
            "added": added,
            "modified": modified,
            "removed": removed,
            "counts": {
                "added": len(added),
                "modified": len(modified),
                "removed": len(removed),
            },
        }

    async def set_default_funding_account(
        self,
        *,
        user_id: str,
        item_id: str,
        account_id: str,
    ) -> dict[str, Any]:
        item_row = self._fetch_funding_item_row(user_id=user_id, item_id=item_id)
        if item_row is None:
            raise FundingOrchestrationError(
                "No linked Plaid funding item is available.",
                code="PLAID_FUNDING_ITEM_NOT_FOUND",
                status_code=404,
            )

        account_row = self._find_funding_account(
            user_id=user_id,
            item_id=item_id,
            account_id=account_id,
        )
        if account_row is None:
            raise FundingOrchestrationError(
                "Selected funding account does not belong to the linked Plaid item.",
                code="PLAID_FUNDING_ACCOUNT_NOT_FOUND",
                status_code=422,
            )

        self._set_default_funding_account(
            user_id=user_id,
            item_id=item_id,
            account_id=account_id,
        )
        return await self.get_funding_status(user_id=user_id)

    async def set_brokerage_account(
        self,
        *,
        user_id: str,
        alpaca_account_id: str | None = None,
        set_default: bool = True,
    ) -> dict[str, Any]:
        cleaned_account_id = _clean_text(alpaca_account_id)
        if cleaned_account_id and not _looks_like_alpaca_account_id(cleaned_account_id):
            raise FundingOrchestrationError(
                "Alpaca account ID must be a valid UUID.",
                code="ALPACA_ACCOUNT_INVALID_FORMAT",
                status_code=422,
                details={"alpaca_account_id": cleaned_account_id},
            )
        if not cleaned_account_id:
            cleaned_account_id = self._resolve_alpaca_account_id(
                user_id=user_id,
                requested_account_id=None,
            )
        if not self.alpaca_config.configured:
            raise FundingOrchestrationError(
                "Alpaca is not configured for funding.",
                code="ALPACA_NOT_CONFIGURED",
                status_code=503,
            )

        try:
            await self._alpaca_get(f"/v1/accounts/{cleaned_account_id}")
        except AlpacaApiError as exc:
            if exc.status_code == 404:
                raise FundingOrchestrationError(
                    "Alpaca account not found for this partner environment.",
                    code="ALPACA_ACCOUNT_NOT_FOUND",
                    status_code=422,
                    details={"alpaca_account_id": cleaned_account_id},
                ) from exc
            raise

        self._upsert_brokerage_account(
            user_id=user_id,
            alpaca_account_id=cleaned_account_id,
            set_as_default=set_default,
            metadata={
                "linked_via": "manual_account_id",
                "linked_at": _utcnow_iso(),
            },
        )
        return await self.get_funding_status(user_id=user_id)

    async def create_alpaca_connect_link(
        self,
        *,
        user_id: str,
        redirect_uri: str | None = None,
    ) -> dict[str, Any]:
        config = self._alpaca_connect_config()
        if not config["configured"]:
            missing = ", ".join(config.get("missing_required") or [])
            hint = f" Missing: {missing}." if missing else ""
            raise FundingOrchestrationError(
                f"Alpaca Connect OAuth is not configured on this backend.{hint}",
                code="ALPACA_CONNECT_NOT_CONFIGURED",
                status_code=503,
            )

        requested_redirect_uri = _normalize_https_url(redirect_uri)
        resolved_redirect_uri = requested_redirect_uri or config["redirect_uri"]
        if not resolved_redirect_uri:
            raise FundingOrchestrationError(
                "Alpaca Connect redirect URI must use HTTPS.",
                code="ALPACA_CONNECT_REDIRECT_URI_REQUIRED",
                status_code=422,
            )
        if requested_redirect_uri and requested_redirect_uri != config["redirect_uri"]:
            raise FundingOrchestrationError(
                "Alpaca Connect redirect URI does not match the configured callback URL.",
                code="ALPACA_CONNECT_REDIRECT_URI_MISMATCH",
                status_code=422,
                details={
                    "configured_redirect_uri": config["redirect_uri"],
                    "requested_redirect_uri": requested_redirect_uri,
                },
            )

        session = self._create_alpaca_connect_session(
            user_id=user_id,
            redirect_uri=resolved_redirect_uri,
            ttl_seconds=int(config["ttl_seconds"]),
        )
        params = {
            "response_type": "code",
            "client_id": str(config["client_id"]),
            "redirect_uri": resolved_redirect_uri,
            "scope": " ".join(config["scopes"]),
            "state": session["state"],
            "env": str(config["oauth_env"]),
        }
        authorize_url = f"{config['authorize_url']}?{urlencode(params)}"

        return {
            "configured": True,
            "authorization_url": authorize_url,
            "state": session["state"],
            "expires_at": session["expires_at"],
            "redirect_uri": resolved_redirect_uri,
            "oauth_env": config["oauth_env"],
        }

    async def _exchange_alpaca_connect_code(
        self,
        *,
        code: str,
        redirect_uri: str,
    ) -> dict[str, Any]:
        config = self._alpaca_connect_config()
        if not config["configured"]:
            missing = ", ".join(config.get("missing_required") or [])
            hint = f" Missing: {missing}." if missing else ""
            raise FundingOrchestrationError(
                f"Alpaca Connect OAuth is not configured on this backend.{hint}",
                code="ALPACA_CONNECT_NOT_CONFIGURED",
                status_code=503,
            )

        form_payload = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": config["client_id"],
            "client_secret": config["client_secret"],
        }
        basic_auth = base64.b64encode(
            f"{config['client_id']}:{config['client_secret']}".encode("utf-8")
        ).decode("utf-8")
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {basic_auth}",
        }

        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=6.0)) as client:
            response = await client.post(config["token_url"], data=form_payload, headers=headers)
            if response.status_code >= 400:
                # Some deployments expect client credentials in the form body only.
                fallback_headers = {
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded",
                }
                response = await client.post(
                    config["token_url"],
                    data=form_payload,
                    headers=fallback_headers,
                )

        token_payload: dict[str, Any]
        try:
            parsed = response.json()
            token_payload = parsed if isinstance(parsed, dict) else {}
        except Exception:
            token_payload = {}

        if response.status_code >= 400:
            raise FundingOrchestrationError(
                _clean_text(token_payload.get("error_description"))
                or _clean_text(token_payload.get("message"))
                or "Alpaca OAuth code exchange failed.",
                code="ALPACA_CONNECT_TOKEN_EXCHANGE_FAILED",
                status_code=502,
                details={
                    "status_code": response.status_code,
                    "error": _clean_text(token_payload.get("error")) or None,
                },
            )

        access_token = _clean_text(token_payload.get("access_token"))
        if not access_token:
            raise FundingOrchestrationError(
                "Alpaca OAuth response did not include access_token.",
                code="ALPACA_CONNECT_ACCESS_TOKEN_MISSING",
                status_code=502,
            )
        return token_payload

    async def _fetch_alpaca_connect_account(
        self,
        *,
        access_token: str,
    ) -> dict[str, Any]:
        config = self._alpaca_connect_config()
        account_url = _clean_text(config.get("account_url"))
        if not account_url:
            raise FundingOrchestrationError(
                "Alpaca OAuth account endpoint is not configured.",
                code="ALPACA_CONNECT_ACCOUNT_ENDPOINT_MISSING",
                status_code=500,
            )

        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=6.0)) as client:
            response = await client.get(
                account_url,
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {access_token}",
                },
            )

        payload: dict[str, Any]
        try:
            parsed = response.json()
            payload = parsed if isinstance(parsed, dict) else {}
        except Exception:
            payload = {}

        if response.status_code >= 400:
            raise FundingOrchestrationError(
                _clean_text(payload.get("message")) or "Could not fetch Alpaca account profile.",
                code="ALPACA_CONNECT_ACCOUNT_FETCH_FAILED",
                status_code=502,
                details={
                    "status_code": response.status_code,
                },
            )
        return payload

    async def complete_alpaca_connect_link(
        self,
        *,
        user_id: str,
        state: str,
        code: str,
    ) -> dict[str, Any]:
        cleaned_state = _clean_text(state)
        cleaned_code = _clean_text(code)
        if not cleaned_state or not cleaned_code:
            raise FundingOrchestrationError(
                "Alpaca OAuth callback requires both state and code.",
                code="ALPACA_CONNECT_CALLBACK_INVALID",
                status_code=422,
            )

        session = self._get_alpaca_connect_session(user_id=user_id, state=cleaned_state)
        if session is None:
            raise FundingOrchestrationError(
                "No active Alpaca OAuth session was found.",
                code="ALPACA_CONNECT_SESSION_NOT_FOUND",
                status_code=404,
            )

        session_id = _clean_text(session.get("session_id"))
        status_value = _clean_text(session.get("status")).lower()
        if status_value in {"completed", "failed", "expired", "replayed"}:
            if session_id:
                self._mark_alpaca_connect_session(
                    session_id=session_id,
                    status="replayed",
                    error_code="ALPACA_CONNECT_STATE_REPLAY",
                    error_message="OAuth state has already been consumed.",
                )
            raise FundingOrchestrationError(
                "Alpaca OAuth state has already been used.",
                code="ALPACA_CONNECT_STATE_REPLAY",
                status_code=409,
            )

        expires_at_text = _clean_text(session.get("expires_at"))
        if expires_at_text:
            try:
                expires_at = datetime.fromisoformat(expires_at_text.replace("Z", "+00:00"))
                if expires_at < _utcnow():
                    if session_id:
                        self._mark_alpaca_connect_session(
                            session_id=session_id,
                            status="expired",
                            error_code="ALPACA_CONNECT_STATE_EXPIRED",
                            error_message="OAuth state expired before callback completion.",
                        )
                    raise FundingOrchestrationError(
                        "Alpaca OAuth session has expired. Start again.",
                        code="ALPACA_CONNECT_STATE_EXPIRED",
                        status_code=409,
                    )
            except FundingOrchestrationError:
                raise
            except Exception:
                pass

        redirect_uri = _clean_text(session.get("redirect_uri"))
        if not _normalize_https_url(redirect_uri):
            raise FundingOrchestrationError(
                "Stored Alpaca OAuth redirect URI is invalid.",
                code="ALPACA_CONNECT_REDIRECT_URI_INVALID",
                status_code=500,
            )

        account_id = ""
        try:
            token_payload = await self._exchange_alpaca_connect_code(
                code=cleaned_code,
                redirect_uri=redirect_uri,
            )
            access_token = _clean_text(token_payload.get("access_token"))
            account_payload = await self._fetch_alpaca_connect_account(access_token=access_token)
            account_id = _clean_text(account_payload.get("id") or account_payload.get("account_id"))
            if not _looks_like_alpaca_account_id(account_id):
                raise FundingOrchestrationError(
                    "Alpaca OAuth returned an unsupported account identifier.",
                    code="ALPACA_CONNECT_ACCOUNT_ID_INVALID",
                    status_code=422,
                    details={"account_id": account_id or None},
                )

            self._upsert_brokerage_account(
                user_id=user_id,
                alpaca_account_id=account_id,
                set_as_default=True,
                metadata={
                    "linked_via": "alpaca_oauth",
                    "linked_at": _utcnow_iso(),
                    "alpaca_oauth_env": self._alpaca_connect_config().get("oauth_env"),
                    "account_status": _clean_text(account_payload.get("status")) or None,
                    "account_currency": _clean_text(account_payload.get("currency")) or None,
                    "account_number_last4": _clean_text(account_payload.get("account_number"))[-4:]
                    or None,
                },
            )
            if session_id:
                self._mark_alpaca_connect_session(
                    session_id=session_id,
                    status="completed",
                    metadata={
                        "alpaca_account_id": account_id,
                    },
                )
        except FundingOrchestrationError:
            raise
        except Exception as exc:
            if session_id:
                self._mark_alpaca_connect_session(
                    session_id=session_id,
                    status="failed",
                    error_code="ALPACA_CONNECT_COMPLETE_FAILED",
                    error_message=str(exc),
                )
            raise FundingOrchestrationError(
                "Alpaca login could not be completed.",
                code="ALPACA_CONNECT_COMPLETE_FAILED",
                status_code=502,
            ) from exc

        status_payload = await self.get_funding_status(user_id=user_id)
        status_payload["alpaca_connect"] = {
            "linked": True,
            "alpaca_account_id": account_id,
        }
        return status_payload

    async def create_transfer(
        self,
        *,
        user_id: str,
        funding_item_id: str,
        funding_account_id: str,
        amount: float | str,
        user_legal_name: str,
        direction: str = "to_brokerage",
        network: str = "ach",
        ach_class: str = "web",
        description: str | None = None,
        idempotency_key: str | None = None,
        brokerage_item_id: str | None = None,
        brokerage_account_id: str | None = None,
        relationship_id: str | None = None,
        redirect_uri: str | None = None,
    ) -> dict[str, Any]:
        _ = network
        _ = ach_class
        _ = brokerage_item_id
        _ = redirect_uri

        if not _clean_text(user_legal_name):
            raise FundingOrchestrationError(
                "A legal name is required to create a transfer.",
                code="LEGAL_NAME_REQUIRED",
                status_code=422,
            )

        item_row = self._fetch_funding_item_row(user_id=user_id, item_id=funding_item_id)
        if item_row is None:
            raise FundingOrchestrationError(
                "No linked Plaid funding item is available.",
                code="PLAID_FUNDING_ITEM_NOT_FOUND",
                status_code=404,
            )

        account_row = self._find_funding_account(
            user_id=user_id,
            item_id=funding_item_id,
            account_id=funding_account_id,
        )
        if account_row is None:
            raise FundingOrchestrationError(
                "Selected funding account does not belong to the linked Plaid item.",
                code="PLAID_FUNDING_ACCOUNT_NOT_FOUND",
                status_code=422,
            )
        self._set_default_funding_account(
            user_id=user_id,
            item_id=funding_item_id,
            account_id=funding_account_id,
        )

        alpaca_account_id = self._resolve_alpaca_account_id(
            user_id=user_id,
            requested_account_id=brokerage_account_id,
        )
        self._upsert_brokerage_account(
            user_id=user_id,
            alpaca_account_id=alpaca_account_id,
            set_as_default=True,
            metadata={
                "last_used_at": _utcnow_iso(),
            },
        )

        access_token = self._get_funding_item_access_token(item_row)
        if _clean_text(relationship_id):
            relationship = self._find_relationship_by_id(
                user_id=user_id,
                relationship_id=_clean_text(relationship_id),
            )
            if relationship is None:
                raise FundingOrchestrationError(
                    "ACH relationship not found for this user.",
                    code="ACH_RELATIONSHIP_NOT_FOUND",
                    status_code=404,
                )
        else:
            relationship = await self._create_or_refresh_relationship(
                user_id=user_id,
                alpaca_account_id=alpaca_account_id,
                item_id=funding_item_id,
                account_id=funding_account_id,
                access_token=access_token,
                auto_poll=True,
            )

        relationship = await self._refresh_relationship_status(relationship=relationship)
        self._relationship_status_requirements(relationship=relationship)

        amount_text = _decimal_to_currency_text(amount)
        alpaca_direction = _direction_to_alpaca(direction)
        self._validate_amount_limit(direction=alpaca_direction, amount_text=amount_text)

        cleaned_idempotency_key = (
            _clean_text(idempotency_key) or f"funding_transfer_{uuid.uuid4().hex}"
        )
        dedupe = self._fetch_transfer_row_by_idempotency(
            user_id=user_id,
            idempotency_key=cleaned_idempotency_key,
        )
        if dedupe is not None:
            existing = await self.get_transfer(
                user_id=user_id,
                transfer_id=_clean_text(dedupe.get("transfer_id")),
            )
            existing["deduped"] = True
            existing["idempotency_key"] = cleaned_idempotency_key
            return existing

        request_payload = {
            "relationship_id": _clean_text(relationship.get("relationship_id")),
            "transfer_type": "ach",
            "direction": alpaca_direction,
            "amount": amount_text,
        }
        cleaned_description = _clean_text(description)
        if cleaned_description:
            request_payload["description"] = cleaned_description

        response = await self._alpaca_post(
            f"/v1/accounts/{alpaca_account_id}/transfers",
            request_payload,
        )
        transfer_payload = self._parse_transfer_payload(
            response if isinstance(response, dict) else {}
        )
        transfer_id = _clean_text(transfer_payload.get("transfer_id"))
        if not transfer_id:
            raise FundingOrchestrationError(
                "Alpaca transfer response did not include a transfer ID.",
                code="ALPACA_TRANSFER_ID_MISSING",
                status_code=502,
            )
        transfer_status = _clean_text(transfer_payload.get("status"), default="PENDING").upper()
        completed_at = (
            _utcnow_iso() if _user_facing_transfer_status(transfer_status) == "completed" else None
        )

        self._store_transfer(
            user_id=user_id,
            transfer_id=transfer_id,
            alpaca_account_id=alpaca_account_id,
            relationship_id=_clean_text(relationship.get("relationship_id")),
            item_id=funding_item_id,
            account_id=funding_account_id,
            direction=alpaca_direction,
            amount=amount_text,
            currency=_clean_text(transfer_payload.get("currency"), default="USD"),
            status=transfer_status,
            idempotency_key=cleaned_idempotency_key,
            request_payload=request_payload,
            response_payload=transfer_payload.get("raw")
            if isinstance(transfer_payload.get("raw"), dict)
            else {},
            reason_code=_clean_text(transfer_payload.get("failure_reason_code")) or None,
            reason_message=_clean_text(transfer_payload.get("failure_reason_message")) or None,
            completed_at=completed_at,
        )

        self._record_transfer_event(
            user_id=user_id,
            transfer_id=transfer_id,
            event_source="alpaca_api",
            event_type="transfer_created",
            event_status=transfer_status,
            reason_code=_clean_text(transfer_payload.get("failure_reason_code")) or None,
            reason_message=_clean_text(transfer_payload.get("failure_reason_message")) or None,
            payload={
                "request": request_payload,
                "response": transfer_payload.get("raw")
                if isinstance(transfer_payload.get("raw"), dict)
                else {},
            },
        )
        self._queue_transfer_status_notification_if_needed(
            user_id=user_id,
            transfer_id=transfer_id,
            previous_status=None,
            current_status=transfer_status,
            amount_text=amount_text,
            direction=alpaca_direction,
            failure_reason=_clean_text(transfer_payload.get("failure_reason_message")) or None,
        )

        return {
            "approved": True,
            "decision": "accepted",
            "idempotency_key": cleaned_idempotency_key,
            "transfer": transfer_payload,
            "relationship": {
                "relationship_id": _clean_text(relationship.get("relationship_id")) or None,
                "status": _clean_text(relationship.get("status")) or None,
            },
        }

    async def get_transfer(self, *, user_id: str, transfer_id: str) -> dict[str, Any]:
        row = self._fetch_transfer_row(user_id=user_id, transfer_id=transfer_id)
        if row is None:
            raise FundingOrchestrationError(
                "Transfer not found for this user.",
                code="TRANSFER_NOT_FOUND",
                status_code=404,
            )

        alpaca_account_id = _clean_text(row.get("alpaca_account_id"))
        remote_transfer = await self._fetch_transfer_from_alpaca(
            alpaca_account_id=alpaca_account_id,
            transfer_id=transfer_id,
        )

        prior_status = _clean_text(row.get("status")).upper()
        if remote_transfer is not None:
            status = _clean_text(
                remote_transfer.get("status"), default=prior_status or "PENDING"
            ).upper()
            completed_at = (
                _utcnow_iso()
                if _user_facing_transfer_status(status) == "completed"
                else _clean_text(row.get("completed_at")) or None
            )
            self._store_transfer(
                user_id=user_id,
                transfer_id=transfer_id,
                alpaca_account_id=alpaca_account_id,
                relationship_id=_clean_text(row.get("relationship_id")),
                item_id=_clean_text(row.get("item_id")),
                account_id=_clean_text(row.get("account_id")),
                direction=_clean_text(row.get("direction"), default=_FUNDS_DIRECTION_INCOMING),
                amount=_clean_text(str(row.get("amount"))),
                currency=_clean_text(
                    remote_transfer.get("currency"),
                    default=_clean_text(row.get("currency"), default="USD"),
                ),
                status=status,
                idempotency_key=_clean_text(row.get("idempotency_key")),
                request_payload=_json_load(row.get("request_payload_json"), fallback={}),
                response_payload=remote_transfer.get("raw")
                if isinstance(remote_transfer.get("raw"), dict)
                else {},
                reason_code=_clean_text(remote_transfer.get("failure_reason_code")) or None,
                reason_message=_clean_text(remote_transfer.get("failure_reason_message")) or None,
                completed_at=completed_at,
            )

            if status != prior_status:
                self._record_transfer_event(
                    user_id=user_id,
                    transfer_id=transfer_id,
                    event_source="alpaca_poll",
                    event_type="transfer_status_updated",
                    event_status=status,
                    reason_code=_clean_text(remote_transfer.get("failure_reason_code")) or None,
                    reason_message=_clean_text(remote_transfer.get("failure_reason_message"))
                    or None,
                    payload=remote_transfer.get("raw")
                    if isinstance(remote_transfer.get("raw"), dict)
                    else {},
                )

        refreshed_row = self._fetch_transfer_row(user_id=user_id, transfer_id=transfer_id)
        if refreshed_row is None:
            raise FundingOrchestrationError(
                "Transfer disappeared while refreshing status.",
                code="TRANSFER_REFRESH_FAILED",
                status_code=500,
            )

        transfer_payload = remote_transfer or {
            "transfer_id": _clean_text(refreshed_row.get("transfer_id")) or None,
            "status": _clean_text(refreshed_row.get("status")) or None,
            "direction": _clean_text(refreshed_row.get("direction")) or None,
            "amount": _clean_text(str(refreshed_row.get("amount")))
            if refreshed_row.get("amount") is not None
            else None,
            "currency": _clean_text(refreshed_row.get("currency")) or "USD",
            "created_at": _clean_text(refreshed_row.get("requested_at")) or None,
            "failure_reason_code": _clean_text(refreshed_row.get("failure_reason_code")) or None,
            "failure_reason_message": _clean_text(refreshed_row.get("failure_reason_message"))
            or None,
            "raw": _json_load(refreshed_row.get("response_payload_json"), fallback={}),
        }
        refreshed_status = _clean_text(refreshed_row.get("status")).upper()
        self._queue_transfer_status_notification_if_needed(
            user_id=user_id,
            transfer_id=transfer_id,
            previous_status=prior_status,
            current_status=refreshed_status,
            amount_text=_clean_text(str(refreshed_row.get("amount")))
            if refreshed_row.get("amount") is not None
            else None,
            direction=_clean_text(refreshed_row.get("direction")) or None,
            failure_reason=_clean_text(refreshed_row.get("failure_reason_message")) or None,
        )

        return {
            "transfer": transfer_payload,
            "reference": {
                "transfer_id": _clean_text(refreshed_row.get("transfer_id")) or None,
                "relationship_id": _clean_text(refreshed_row.get("relationship_id")) or None,
                "status": _clean_text(refreshed_row.get("status")) or None,
                "user_facing_status": _clean_text(refreshed_row.get("user_facing_status")) or None,
                "idempotency_key": _clean_text(refreshed_row.get("idempotency_key")) or None,
                "requested_at": _clean_text(refreshed_row.get("requested_at")) or None,
                "completed_at": _clean_text(refreshed_row.get("completed_at")) or None,
                "failure_reason_code": _clean_text(refreshed_row.get("failure_reason_code"))
                or None,
                "failure_reason_message": _clean_text(refreshed_row.get("failure_reason_message"))
                or None,
            },
        }

    async def cancel_transfer(self, *, user_id: str, transfer_id: str) -> dict[str, Any]:
        row = self._fetch_transfer_row(user_id=user_id, transfer_id=transfer_id)
        if row is None:
            raise FundingOrchestrationError(
                "Transfer not found for this user.",
                code="TRANSFER_NOT_FOUND",
                status_code=404,
            )

        alpaca_account_id = _clean_text(row.get("alpaca_account_id"))
        await self._alpaca_delete(f"/v1/accounts/{alpaca_account_id}/transfers/{transfer_id}")

        transfer_payload = await self.get_transfer(user_id=user_id, transfer_id=transfer_id)
        transfer_payload["canceled"] = True
        return transfer_payload

    def _payload_hash(self, raw_body: bytes) -> str:
        return hashlib.sha256(raw_body).hexdigest()

    def _jwk_to_int(self, value: Any) -> int:
        if isinstance(value, int):
            return value
        text = _clean_text(value)
        if not text:
            raise PlaidWebhookVerificationError(
                "Webhook verification key is missing RSA modulus/exponent."
            )
        if text.isdigit():
            return int(text)
        padded = text + "=" * ((4 - (len(text) % 4)) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("utf-8"))
        return int.from_bytes(decoded, byteorder="big")

    async def _verify_plaid_webhook(
        self,
        *,
        raw_body: bytes,
        headers: dict[str, str],
    ) -> tuple[bool, str, str | None]:
        verification_enabled = _to_bool(
            os.getenv("PLAID_WEBHOOK_VERIFICATION_ENABLED", "true"),
            default=True,
        )
        if not verification_enabled:
            return True, f"plaid-webhook-{uuid.uuid4().hex}", None

        if not self.plaid_config.configured:
            raise PlaidWebhookVerificationError(
                "Plaid webhook verification requires Plaid configuration."
            )

        header_value = _clean_text(
            headers.get("plaid-verification") or headers.get("Plaid-Verification")
        )
        if not header_value:
            raise PlaidWebhookVerificationError("Missing Plaid-Verification webhook header.")

        try:
            unverified_header = jwt.get_unverified_header(header_value)
        except Exception as exc:
            raise PlaidWebhookVerificationError(
                "Invalid Plaid webhook verification token header."
            ) from exc

        key_id = _clean_text(unverified_header.get("kid"))
        if not key_id:
            raise PlaidWebhookVerificationError(
                "Plaid webhook verification key id (kid) is missing."
            )

        key_response = await self._plaid_post("/webhook_verification_key/get", {"key_id": key_id})
        key_payload = (
            key_response.get("key") if isinstance(key_response.get("key"), dict) else key_response
        )
        if not isinstance(key_payload, dict):
            raise PlaidWebhookVerificationError(
                "Plaid webhook verification key payload is invalid."
            )

        modulus = self._jwk_to_int(key_payload.get("n"))
        exponent = self._jwk_to_int(key_payload.get("e"))
        public_key = rsa.RSAPublicNumbers(exponent, modulus).public_key()

        algorithm = _clean_text(unverified_header.get("alg"), default="RS256")
        try:
            claims = jwt.decode(
                header_value,
                public_key,
                algorithms=[algorithm],
                options={"verify_aud": False},
            )
        except Exception as exc:
            raise PlaidWebhookVerificationError(
                "Plaid webhook signature validation failed."
            ) from exc

        claim_hash = _clean_text(claims.get("request_body_sha256"))
        expected_hash_hex = hashlib.sha256(raw_body).hexdigest()
        expected_hash_b64 = base64.b64encode(hashlib.sha256(raw_body).digest()).decode("utf-8")
        if claim_hash not in {expected_hash_hex, expected_hash_b64}:
            raise PlaidWebhookVerificationError(
                "Plaid webhook request body hash mismatch.",
                details={"expected": expected_hash_hex},
            )

        issued_at = claims.get("iat")
        if isinstance(issued_at, (int, float)):
            max_skew_seconds = max(
                30,
                int(os.getenv("PLAID_WEBHOOK_MAX_SKEW_SECONDS", "300") or "300"),
            )
            if abs(_utcnow().timestamp() - float(issued_at)) > max_skew_seconds:
                raise PlaidWebhookVerificationError(
                    "Plaid webhook token timestamp is outside allowed skew.",
                    details={"iat": issued_at, "max_skew_seconds": max_skew_seconds},
                )

        event_uid = (
            _clean_text(claims.get("jti")) or f"plaid-webhook-{key_id}-{expected_hash_hex[:24]}"
        )
        return True, event_uid, key_id

    def _insert_webhook_event(
        self,
        *,
        provider: str,
        event_uid: str,
        payload_hash: str,
        signature_valid: bool,
        status: str,
        payload: dict[str, Any],
        headers: dict[str, Any],
    ) -> tuple[int | None, bool]:
        try:
            result = self.db.execute_raw(
                """
                INSERT INTO kai_funding_webhook_events (
                    provider,
                    event_uid,
                    payload_hash,
                    signature_valid,
                    replay_detected,
                    status,
                    payload_json,
                    headers_json,
                    created_at,
                    updated_at
                )
                VALUES (
                    :provider,
                    :event_uid,
                    :payload_hash,
                    :signature_valid,
                    FALSE,
                    :status,
                    CAST(:payload_json AS JSONB),
                    CAST(:headers_json AS JSONB),
                    NOW(),
                    NOW()
                )
                RETURNING id
                """,
                {
                    "provider": provider,
                    "event_uid": event_uid,
                    "payload_hash": payload_hash,
                    "signature_valid": signature_valid,
                    "status": status,
                    "payload_json": json.dumps(payload),
                    "headers_json": json.dumps(headers),
                },
            )
            return (int(result.data[0]["id"]), False) if result.data else (None, False)
        except DatabaseExecutionError as exc:
            detail = _clean_text(exc.details).lower()
            if "duplicate" in detail or "unique" in detail:
                return None, True
            raise

    def _update_webhook_event(
        self,
        *,
        webhook_id: int,
        status: str,
        replay_detected: bool = False,
        error_message: str | None = None,
    ) -> None:
        self.db.execute_raw(
            """
            UPDATE kai_funding_webhook_events
            SET status = :status,
                replay_detected = :replay_detected,
                error_message = :error_message,
                processed_at = NOW(),
                updated_at = NOW()
            WHERE id = :id
            """,
            {
                "id": webhook_id,
                "status": status,
                "replay_detected": replay_detected,
                "error_message": error_message,
            },
        )

    async def _refresh_transfer_from_webhook(self, *, transfer_id: str) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_funding_transfers
            WHERE transfer_id = :transfer_id
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            {"transfer_id": transfer_id},
        )
        if not result.data:
            return None
        row = result.data[0]
        user_id = _clean_text(row.get("user_id"))
        if not user_id:
            return None
        return await self.get_transfer(user_id=user_id, transfer_id=transfer_id)

    async def handle_plaid_webhook(
        self,
        payload: dict[str, Any],
        *,
        raw_body: bytes,
        headers: dict[str, str],
    ) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise FundingOrchestrationError(
                "Webhook payload must be a JSON object.",
                code="PLAID_WEBHOOK_INVALID_PAYLOAD",
                status_code=400,
            )

        signature_valid, event_uid, key_id = await self._verify_plaid_webhook(
            raw_body=raw_body,
            headers=headers,
        )
        payload_hash = self._payload_hash(raw_body)

        webhook_id, replay_detected = self._insert_webhook_event(
            provider="plaid",
            event_uid=event_uid,
            payload_hash=payload_hash,
            signature_valid=signature_valid,
            status="accepted",
            payload=payload,
            headers=headers,
        )
        if replay_detected:
            return {
                "accepted": True,
                "handled": False,
                "replay": True,
                "event_uid": event_uid,
            }

        transfer_id = _clean_text(
            payload.get("transfer_id")
            or payload.get("transferId")
            or (
                (payload.get("transfer") or {}).get("id")
                if isinstance(payload.get("transfer"), dict)
                else ""
            )
        )
        item_id = _clean_text(payload.get("item_id"))

        try:
            if transfer_id:
                transfer_result = await self._refresh_transfer_from_webhook(transfer_id=transfer_id)
                if transfer_result is not None:
                    if webhook_id is not None:
                        self._update_webhook_event(webhook_id=webhook_id, status="accepted")
                    return {
                        "accepted": True,
                        "handled": True,
                        "transfer_id": transfer_id,
                        "event_uid": event_uid,
                        "verification_key_id": key_id,
                    }

            if item_id:
                row = self._fetch_funding_item_by_item_id(item_id=item_id)
                if row is not None:
                    webhook_type = _clean_text(payload.get("webhook_type")) or None
                    webhook_code = _clean_text(payload.get("webhook_code")) or None
                    metadata = _json_load(row.get("latest_metadata_json"), fallback={})
                    merged = {
                        **metadata,
                        "last_webhook_at": _utcnow_iso(),
                    }
                    self.db.execute_raw(
                        """
                        UPDATE kai_funding_plaid_items
                        SET latest_metadata_json = CAST(:latest_metadata_json AS JSONB),
                            last_webhook_type = :webhook_type,
                            last_webhook_code = :webhook_code,
                            updated_at = NOW()
                        WHERE item_id = :item_id
                        """,
                        {
                            "item_id": item_id,
                            "latest_metadata_json": json.dumps(merged),
                            "webhook_type": webhook_type,
                            "webhook_code": webhook_code,
                        },
                    )
                    if webhook_id is not None:
                        self._update_webhook_event(webhook_id=webhook_id, status="accepted")
                    return {
                        "accepted": True,
                        "handled": True,
                        "item_id": item_id,
                        "event_uid": event_uid,
                        "verification_key_id": key_id,
                    }

            if webhook_id is not None:
                self._update_webhook_event(webhook_id=webhook_id, status="ignored")
            return {
                "accepted": True,
                "handled": False,
                "event_uid": event_uid,
                "verification_key_id": key_id,
                "reason": "not_funding_related",
            }
        except Exception as exc:
            if webhook_id is not None:
                self._update_webhook_event(
                    webhook_id=webhook_id,
                    status="error",
                    error_message=str(exc),
                )
            raise

    async def search_transfer_records(
        self,
        *,
        user_id: str | None = None,
        transfer_id: str | None = None,
        relationship_id: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        bounded_limit = max(1, min(limit, 200))
        result = self.db.execute_raw(
            """
            SELECT
                t.*,
                r.status AS relationship_status,
                r.status_reason_code AS relationship_reason_code,
                r.status_reason_message AS relationship_reason_message
            FROM kai_funding_transfers t
            LEFT JOIN kai_funding_ach_relationships r
              ON r.relationship_id = t.relationship_id
            WHERE (:user_id IS NULL OR t.user_id = :user_id)
              AND (:transfer_id IS NULL OR t.transfer_id = :transfer_id)
              AND (:relationship_id IS NULL OR t.relationship_id = :relationship_id)
            ORDER BY t.requested_at DESC, t.updated_at DESC
            LIMIT :limit
            """,
            {
                "user_id": _clean_text(user_id) or None,
                "transfer_id": _clean_text(transfer_id) or None,
                "relationship_id": _clean_text(relationship_id) or None,
                "limit": bounded_limit,
            },
        )
        return {
            "count": len(result.data),
            "items": result.data,
        }

    async def create_support_escalation(
        self,
        *,
        user_id: str,
        transfer_id: str | None,
        relationship_id: str | None,
        notes: str,
        severity: str,
        created_by: str | None,
    ) -> dict[str, Any]:
        cleaned_severity = _clean_text(severity, default="normal").lower()
        if cleaned_severity not in {"low", "normal", "high", "urgent"}:
            cleaned_severity = "normal"
        escalation_id = f"funding_escalation_{uuid.uuid4().hex}"
        result = self.db.execute_raw(
            """
            INSERT INTO kai_funding_support_escalations (
                escalation_id,
                user_id,
                transfer_id,
                relationship_id,
                status,
                severity,
                notes,
                created_by,
                created_at,
                updated_at
            )
            VALUES (
                :escalation_id,
                :user_id,
                :transfer_id,
                :relationship_id,
                'open',
                :severity,
                :notes,
                :created_by,
                NOW(),
                NOW()
            )
            RETURNING *
            """,
            {
                "escalation_id": escalation_id,
                "user_id": user_id,
                "transfer_id": _clean_text(transfer_id) or None,
                "relationship_id": _clean_text(relationship_id) or None,
                "severity": cleaned_severity,
                "notes": _clean_text(notes) or None,
                "created_by": _clean_text(created_by) or None,
            },
        )
        return result.data[0] if result.data else {"escalation_id": escalation_id}

    async def run_reconciliation(
        self,
        *,
        user_id: str | None = None,
        trigger_source: str = "manual",
        max_rows: int = 200,
    ) -> dict[str, Any]:
        bounded_max_rows = max(1, min(max_rows, 1000))
        run_id = f"funding_recon_{uuid.uuid4().hex}"
        self.db.execute_raw(
            """
            INSERT INTO kai_funding_reconciliation_runs (
                run_id,
                user_id,
                trigger_source,
                status,
                summary_json,
                mismatches_json,
                started_at,
                created_at,
                updated_at
            )
            VALUES (
                :run_id,
                :user_id,
                :trigger_source,
                'running',
                '{}'::jsonb,
                '[]'::jsonb,
                NOW(),
                NOW(),
                NOW()
            )
            """,
            {
                "run_id": run_id,
                "user_id": _clean_text(user_id) or None,
                "trigger_source": _clean_text(trigger_source, default="manual"),
            },
        )

        try:
            result = self.db.execute_raw(
                """
                SELECT *
                FROM kai_funding_transfers
                WHERE (:user_id IS NULL OR user_id = :user_id)
                  AND status IN ('queued', 'pending', 'submitted', 'completed', 'settled')
                ORDER BY requested_at DESC, updated_at DESC
                LIMIT :limit
                """,
                {
                    "user_id": _clean_text(user_id) or None,
                    "limit": bounded_max_rows,
                },
            )

            refreshed_count = 0
            status_changes = 0
            stale_pending = 0
            failures: list[dict[str, Any]] = []

            stale_seconds = max(
                3600,
                int(os.getenv("FUNDING_STALE_PENDING_SECONDS", str(48 * 3600)) or str(48 * 3600)),
            )
            now_ts = _utcnow().timestamp()

            for row in result.data:
                transfer_id = _clean_text(row.get("transfer_id"))
                row_user_id = _clean_text(row.get("user_id"))
                if not transfer_id or not row_user_id:
                    continue

                previous_status = _clean_text(row.get("status")).upper()
                try:
                    refreshed = await self.get_transfer(
                        user_id=row_user_id, transfer_id=transfer_id
                    )
                    refreshed_count += 1
                    next_status = _clean_text(
                        (refreshed.get("reference") or {}).get("status")
                    ).upper()
                    if next_status and next_status != previous_status:
                        status_changes += 1
                except Exception as exc:
                    failures.append(
                        {
                            "transfer_id": transfer_id,
                            "error": str(exc),
                        }
                    )
                    continue

                requested_at = _clean_text(row.get("requested_at"))
                if requested_at:
                    try:
                        requested_ts = datetime.fromisoformat(
                            requested_at.replace("Z", "+00:00")
                        ).timestamp()
                        if (
                            _clean_text(row.get("status")).upper() in _PENDING_TRANSFER_STATUSES
                            and (now_ts - requested_ts) > stale_seconds
                        ):
                            stale_pending += 1
                    except Exception:
                        pass

            summary = {
                "evaluated": len(result.data),
                "refreshed": refreshed_count,
                "status_changes": status_changes,
                "stale_pending": stale_pending,
                "failures": len(failures),
            }
            self.db.execute_raw(
                """
                UPDATE kai_funding_reconciliation_runs
                SET status = 'completed',
                    summary_json = CAST(:summary_json AS JSONB),
                    mismatches_json = CAST(:mismatches_json AS JSONB),
                    completed_at = NOW(),
                    updated_at = NOW()
                WHERE run_id = :run_id
                """,
                {
                    "run_id": run_id,
                    "summary_json": json.dumps(summary),
                    "mismatches_json": json.dumps(failures),
                },
            )
            return {
                "run_id": run_id,
                "status": "completed",
                "summary": summary,
                "mismatches": failures,
            }
        except Exception as exc:
            self.db.execute_raw(
                """
                UPDATE kai_funding_reconciliation_runs
                SET status = 'failed',
                    error_message = :error_message,
                    completed_at = NOW(),
                    updated_at = NOW()
                WHERE run_id = :run_id
                """,
                {
                    "run_id": run_id,
                    "error_message": str(exc),
                },
            )
            raise


_broker_funding_service: BrokerFundingService | None = None


def get_broker_funding_service() -> BrokerFundingService:
    global _broker_funding_service
    if _broker_funding_service is None:
        _broker_funding_service = BrokerFundingService()
    return _broker_funding_service
