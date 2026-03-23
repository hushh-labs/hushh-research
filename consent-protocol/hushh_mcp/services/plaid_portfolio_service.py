"""Plaid-backed read-only portfolio source for Kai.

This service stores Plaid Items outside the BYOK PKM blob so webhook-driven
sync can update brokerage snapshots without requiring the user's vault key.

The PKM remains the editable statement source. Plaid snapshots are kept in
dedicated server storage and aggregated into Kai on read.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from db.db_client import get_db
from hushh_mcp.integrations.plaid import (
    PlaidApiError,
    PlaidHttpClient,
    PlaidRuntimeConfig,
)
from hushh_mcp.kai_import import build_financial_analytics_v2

logger = logging.getLogger(__name__)

PortfolioSource = Literal["statement", "plaid"]

_READONLY_ITEM_STATUSES = {"active", "error", "relink_required", "permission_revoked"}
_ACTIVE_ITEM_STATUSES = {"active", "error", "relink_required"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _utcnow_iso() -> str:
    return _utcnow().isoformat().replace("+00:00", "Z")


def _clean_text(value: Any, *, default: str = "") -> str:
    if not isinstance(value, str):
        return default
    text = value.strip()
    if not text:
        return default
    return text


def _to_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        value_f = float(value)
        return value_f if value_f == value_f else None
    if isinstance(value, str):
        text = value.strip().replace(",", "").replace("$", "")
        if not text:
            return None
        try:
            value_f = float(text)
            return value_f if value_f == value_f else None
        except ValueError:
            return None
    return None


def _to_int(value: Any, *, default: int = 0) -> int:
    value_f = _to_float(value)
    if value_f is None:
        return default
    try:
        return int(value_f)
    except Exception:
        return default


def _to_bool(value: Any, *, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    if isinstance(value, (int, float)):
        return bool(value)
    return default


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


def _round_currency(value: Any) -> float:
    number = _to_float(value) or 0.0
    return round(number, 2)


def _round_pct(value: Any) -> float | None:
    number = _to_float(value)
    if number is None:
        return None
    return round(number, 4)


def _unique_texts(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        cleaned = value.strip()
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(cleaned)
    return out


class PlaidPortfolioService:
    """Dedicated storage + sync service for Kai Plaid brokerage connections."""

    def __init__(self) -> None:
        self._db = None
        self._background_tasks: set[asyncio.Task[Any]] = set()
        self._refresh_tasks_by_run_id: dict[str, asyncio.Task[Any]] = {}
        self._warned_fallback_encryption_key = False
        self._runtime_config: PlaidRuntimeConfig | None = None
        self._client: PlaidHttpClient | None = None

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    @property
    def config(self) -> PlaidRuntimeConfig:
        if self._runtime_config is None:
            self._runtime_config = PlaidRuntimeConfig.from_env()
        return self._runtime_config

    @property
    def client(self) -> PlaidHttpClient:
        if self._client is None:
            self._client = PlaidHttpClient(self.config)
        return self._client

    def _track_background_task(
        self,
        task: asyncio.Task[Any],
        *,
        run_id: str | None = None,
    ) -> None:
        self._background_tasks.add(task)
        if run_id:
            self._refresh_tasks_by_run_id[run_id] = task

        def _cleanup(completed: asyncio.Task[Any]) -> None:
            self._background_tasks.discard(completed)
            if run_id:
                existing = self._refresh_tasks_by_run_id.get(run_id)
                if existing is completed:
                    self._refresh_tasks_by_run_id.pop(run_id, None)

        task.add_done_callback(_cleanup)

    def _plaid_env(self) -> str:
        return self.config.environment

    def _plaid_base_url(self) -> str:
        return self.config.base_url

    def _client_id(self) -> str:
        return self.config.client_id

    def _secret(self) -> str:
        return self.config.secret

    def is_configured(self) -> bool:
        return self.config.configured

    def configuration_status(self) -> dict[str, Any]:
        return self.config.to_status()

    def _country_codes(self) -> list[str]:
        return list(self.config.country_codes)

    def _language(self) -> str:
        return self.config.language

    def _client_name(self) -> str:
        return self.config.client_name

    def _webhook_url(self) -> str | None:
        return self.config.webhook_url

    def _frontend_url(self) -> str | None:
        return self.config.frontend_url

    def _redirect_path(self) -> str:
        return self.config.redirect_path

    def _normalize_redirect_uri(self, value: str | None) -> str | None:
        raw = _clean_text(value)
        if not raw:
            return None
        parsed = urlsplit(raw)
        if not parsed.scheme or not parsed.netloc:
            return None
        path = parsed.path or "/"
        return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))

    def _default_redirect_uri(self) -> str | None:
        return self.config.redirect_uri

    def resolve_redirect_uri(self, requested_redirect_uri: str | None = None) -> str | None:
        return self.config.resolve_redirect_uri(requested_redirect_uri)

    def _tx_history_days(self) -> int:
        return self.config.tx_history_days

    def _manual_entry_enabled(self) -> bool:
        return self.config.manual_entry_enabled

    def _resolve_encryption_key(self) -> bytes:
        configured = _clean_text(os.getenv("PLAID_TOKEN_ENCRYPTION_KEY"))
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
            f"{self._client_id()}::{self._secret()}::{self._plaid_env()}".encode("utf-8")
        ).digest()
        if not self._warned_fallback_encryption_key:
            logger.warning(
                "plaid.token_encryption_key_missing_using_derived_fallback environment=%s",
                self._plaid_env(),
            )
            self._warned_fallback_encryption_key = True
        return digest

    def _encrypt_access_token(self, access_token: str) -> dict[str, str]:
        key = self._resolve_encryption_key()
        aesgcm = AESGCM(key)
        nonce = os.urandom(12)
        ciphertext_with_tag = aesgcm.encrypt(nonce, access_token.encode("utf-8"), None)
        ciphertext = ciphertext_with_tag[:-16]
        tag = ciphertext_with_tag[-16:]
        return {
            "ciphertext": base64.urlsafe_b64encode(ciphertext).decode("utf-8"),
            "iv": base64.urlsafe_b64encode(nonce).decode("utf-8"),
            "tag": base64.urlsafe_b64encode(tag).decode("utf-8"),
            "algorithm": "aes-256-gcm",
        }

    def _decrypt_access_token(self, row: dict[str, Any]) -> str:
        ciphertext = _clean_text(row.get("access_token_ciphertext"))
        iv = _clean_text(row.get("access_token_iv"))
        tag = _clean_text(row.get("access_token_tag"))
        if not ciphertext or not iv or not tag:
            raise RuntimeError("Stored Plaid access token envelope is incomplete.")
        key = self._resolve_encryption_key()
        aesgcm = AESGCM(key)
        plaintext = aesgcm.decrypt(
            base64.urlsafe_b64decode(iv.encode("utf-8")),
            base64.urlsafe_b64decode(ciphertext.encode("utf-8"))
            + base64.urlsafe_b64decode(tag.encode("utf-8")),
            None,
        )
        return plaintext.decode("utf-8")

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self.client.post(path, payload)

    def _fetch_item_row(self, *, user_id: str, item_id: str) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_plaid_items
            WHERE user_id = :user_id
              AND item_id = :item_id
            LIMIT 1
            """,
            {"user_id": user_id, "item_id": item_id},
        )
        return result.data[0] if result.data else None

    def _fetch_item_row_by_item_id(self, item_id: str) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_plaid_items
            WHERE item_id = :item_id
            LIMIT 1
            """,
            {"item_id": item_id},
        )
        return result.data[0] if result.data else None

    def _list_item_rows(self, *, user_id: str) -> list[dict[str, Any]]:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_plaid_items
            WHERE user_id = :user_id
            ORDER BY COALESCE(last_sync_at, updated_at) DESC, created_at DESC
            """,
            {"user_id": user_id},
        )
        return result.data

    def _latest_run_by_item(self, *, user_id: str) -> dict[str, dict[str, Any]]:
        result = self.db.execute_raw(
            """
            SELECT DISTINCT ON (item_id)
                run_id,
                user_id,
                item_id,
                status,
                trigger_source,
                refresh_method,
                fallback_reason,
                webhook_type,
                webhook_code,
                requested_at,
                started_at,
                completed_at,
                error_code,
                error_message,
                result_summary_json,
                updated_at
            FROM kai_plaid_refresh_runs
            WHERE user_id = :user_id
            ORDER BY item_id, requested_at DESC, updated_at DESC
            """,
            {"user_id": user_id},
        )
        return {str(row["item_id"]): row for row in result.data if row.get("item_id")}

    def _get_refresh_run(self, *, user_id: str, run_id: str) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_plaid_refresh_runs
            WHERE user_id = :user_id
              AND run_id = :run_id
            LIMIT 1
            """,
            {"user_id": user_id, "run_id": run_id},
        )
        return result.data[0] if result.data else None

    def _refresh_run_status(self, *, run_id: str) -> str | None:
        result = self.db.execute_raw(
            """
            SELECT status
            FROM kai_plaid_refresh_runs
            WHERE run_id = :run_id
            LIMIT 1
            """,
            {"run_id": run_id},
        )
        if not result.data:
            return None
        return _clean_text(result.data[0].get("status")) or None

    def _is_refresh_run_active(self, run: dict[str, Any] | None) -> bool:
        if not isinstance(run, dict):
            return False
        return _clean_text(run.get("status")) in {"queued", "running"}

    def _is_refresh_run_canceled(self, *, run_id: str) -> bool:
        return self._refresh_run_status(run_id=run_id) == "canceled"

    def _create_link_session(
        self,
        *,
        user_id: str,
        item_id: str | None,
        mode: str,
        redirect_uri: str,
        link_token: str,
        expires_at: str | None,
    ) -> dict[str, Any]:
        resume_session_id = f"plaid_link_{uuid.uuid4().hex}"
        result = self.db.execute_raw(
            """
            INSERT INTO kai_plaid_link_sessions (
                resume_session_id,
                user_id,
                item_id,
                mode,
                status,
                redirect_uri,
                link_token,
                expires_at,
                created_at,
                updated_at
            )
            VALUES (
                :resume_session_id,
                :user_id,
                :item_id,
                :mode,
                'active',
                :redirect_uri,
                :link_token,
                CAST(:expires_at AS TIMESTAMPTZ),
                NOW(),
                NOW()
            )
            RETURNING *
            """,
            {
                "resume_session_id": resume_session_id,
                "user_id": user_id,
                "item_id": item_id,
                "mode": mode,
                "redirect_uri": redirect_uri,
                "link_token": link_token,
                "expires_at": expires_at,
            },
        )
        return result.data[0]

    def _get_link_session(self, *, user_id: str, resume_session_id: str) -> dict[str, Any] | None:
        result = self.db.execute_raw(
            """
            SELECT *
            FROM kai_plaid_link_sessions
            WHERE user_id = :user_id
              AND resume_session_id = :resume_session_id
              AND status = 'active'
              AND (expires_at IS NULL OR expires_at > NOW())
            LIMIT 1
            """,
            {
                "user_id": user_id,
                "resume_session_id": resume_session_id,
            },
        )
        return result.data[0] if result.data else None

    def _complete_link_session(self, *, user_id: str, resume_session_id: str) -> None:
        self.db.execute_raw(
            """
            UPDATE kai_plaid_link_sessions
            SET status = 'completed',
                completed_at = NOW(),
                updated_at = NOW()
            WHERE user_id = :user_id
              AND resume_session_id = :resume_session_id
            """,
            {
                "user_id": user_id,
                "resume_session_id": resume_session_id,
            },
        )

    def get_active_source(self, user_id: str) -> PortfolioSource:
        result = self.db.execute_raw(
            """
            SELECT active_source
            FROM kai_portfolio_source_preferences
            WHERE user_id = :user_id
            LIMIT 1
            """,
            {"user_id": user_id},
        )
        if not result.data:
            return "statement"
        active_source = _clean_text(result.data[0].get("active_source"), default="statement")
        return active_source if active_source in {"statement", "plaid"} else "statement"

    def set_active_source(self, *, user_id: str, active_source: PortfolioSource) -> PortfolioSource:
        self.db.execute_raw(
            """
            INSERT INTO kai_portfolio_source_preferences (
                user_id,
                active_source,
                created_at,
                updated_at
            )
            VALUES (
                :user_id,
                :active_source,
                NOW(),
                NOW()
            )
            ON CONFLICT (user_id) DO UPDATE
            SET active_source = EXCLUDED.active_source,
                updated_at = NOW()
            """,
            {"user_id": user_id, "active_source": active_source},
        )
        return active_source

    def _create_refresh_run(
        self,
        *,
        user_id: str,
        item_id: str,
        trigger_source: str,
        webhook_type: str | None = None,
        webhook_code: str | None = None,
    ) -> dict[str, Any]:
        run_id = f"plaid_refresh_{uuid.uuid4().hex}"
        result = self.db.execute_raw(
            """
            INSERT INTO kai_plaid_refresh_runs (
                run_id,
                user_id,
                item_id,
                status,
                trigger_source,
                webhook_type,
                webhook_code,
                requested_at,
                created_at,
                updated_at,
                result_summary_json
            )
            VALUES (
                :run_id,
                :user_id,
                :item_id,
                'queued',
                :trigger_source,
                :webhook_type,
                :webhook_code,
                NOW(),
                NOW(),
                NOW(),
                CAST(:result_summary_json AS JSONB)
            )
            RETURNING *
            """,
            {
                "run_id": run_id,
                "user_id": user_id,
                "item_id": item_id,
                "trigger_source": trigger_source,
                "webhook_type": webhook_type,
                "webhook_code": webhook_code,
                "result_summary_json": json.dumps({}),
            },
        )
        return result.data[0]

    def _mark_item_sync_status(
        self,
        *,
        item_id: str,
        sync_status: str,
        status: str | None = None,
        last_error_code: str | None = None,
        last_error_message: str | None = None,
        webhook_type: str | None = None,
        webhook_code: str | None = None,
        refresh_requested: bool = False,
    ) -> None:
        self.db.execute_raw(
            """
            UPDATE kai_plaid_items
            SET sync_status = :sync_status,
                status = COALESCE(:status, status),
                last_error_code = :last_error_code,
                last_error_message = :last_error_message,
                last_webhook_type = COALESCE(:webhook_type, last_webhook_type),
                last_webhook_code = COALESCE(:webhook_code, last_webhook_code),
                last_refresh_requested_at = CASE
                    WHEN :refresh_requested THEN NOW()
                    ELSE last_refresh_requested_at
                END,
                updated_at = NOW()
            WHERE item_id = :item_id
            """,
            {
                "item_id": item_id,
                "sync_status": sync_status,
                "status": status,
                "last_error_code": last_error_code,
                "last_error_message": last_error_message,
                "webhook_type": webhook_type,
                "webhook_code": webhook_code,
                "refresh_requested": refresh_requested,
            },
        )

    def _sync_status_after_cancel(self, item_row: dict[str, Any]) -> str:
        current_status = _clean_text(item_row.get("status"), default="active")
        if current_status == "relink_required":
            return "action_required"
        if current_status == "permission_revoked":
            return "failed"
        if _clean_text(item_row.get("last_sync_at")):
            return "stale"
        return "idle"

    def _update_refresh_run(
        self,
        *,
        run_id: str,
        status: str,
        refresh_method: str | None = None,
        fallback_reason: str | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
        result_summary: dict[str, Any] | None = None,
        webhook_type: str | None = None,
        webhook_code: str | None = None,
        started: bool = False,
        completed: bool = False,
    ) -> None:
        self.db.execute_raw(
            """
            UPDATE kai_plaid_refresh_runs
            SET status = :status,
                refresh_method = COALESCE(:refresh_method, refresh_method),
                fallback_reason = COALESCE(:fallback_reason, fallback_reason),
                error_code = :error_code,
                error_message = :error_message,
                webhook_type = COALESCE(:webhook_type, webhook_type),
                webhook_code = COALESCE(:webhook_code, webhook_code),
                result_summary_json = CAST(:result_summary_json AS JSONB),
                started_at = CASE
                    WHEN :started THEN COALESCE(started_at, NOW())
                    ELSE started_at
                END,
                completed_at = CASE
                    WHEN :completed THEN NOW()
                    ELSE completed_at
                END,
                updated_at = NOW()
            WHERE run_id = :run_id
            """,
            {
                "run_id": run_id,
                "status": status,
                "refresh_method": refresh_method,
                "fallback_reason": fallback_reason,
                "error_code": error_code,
                "error_message": error_message,
                "result_summary_json": json.dumps(result_summary or {}),
                "webhook_type": webhook_type,
                "webhook_code": webhook_code,
                "started": started,
                "completed": completed,
            },
        )

    def _normalize_account(
        self, item_row: dict[str, Any], account: dict[str, Any]
    ) -> dict[str, Any]:
        balances = account.get("balances") if isinstance(account.get("balances"), dict) else {}
        return {
            "account_id": _clean_text(account.get("account_id")),
            "persistent_account_id": _clean_text(account.get("persistent_account_id")) or None,
            "name": _clean_text(account.get("name")),
            "official_name": _clean_text(account.get("official_name")) or None,
            "mask": _clean_text(account.get("mask")) or None,
            "type": _clean_text(account.get("type")) or None,
            "subtype": _clean_text(account.get("subtype")) or None,
            "balances": {
                "available": _to_float(balances.get("available")),
                "current": _to_float(balances.get("current")),
                "iso_currency_code": _clean_text(balances.get("iso_currency_code"), default="USD"),
                "limit": _to_float(balances.get("limit")),
            },
            "institution_id": _clean_text(item_row.get("institution_id")) or None,
            "institution_name": _clean_text(item_row.get("institution_name")) or None,
            "item_id": _clean_text(item_row.get("item_id")),
        }

    def _instrument_kind(self, security: dict[str, Any], *, symbol: str, name: str) -> str:
        sec_type = _clean_text(security.get("type")).lower()
        sec_subtype = _clean_text(security.get("subtype")).lower()
        hint = f"{symbol} {name} {sec_type} {sec_subtype}".lower()
        if sec_type == "cash" or "money market" in hint or "sweep" in hint:
            return "cash_equivalent"
        if sec_type in {"equity", "etf", "mutual fund"}:
            return "equity"
        if sec_type == "fixed income" or sec_subtype in {"bond", "bill", "note", "cd"}:
            return "fixed_income"
        if "reit" in hint or "real estate" in hint or "commodity" in hint:
            return "real_asset"
        return "other"

    def _is_cash_equivalent(self, security: dict[str, Any], *, symbol: str, name: str) -> bool:
        instrument_kind = self._instrument_kind(security, symbol=symbol, name=name)
        return instrument_kind == "cash_equivalent"

    def _is_equity_like(self, security: dict[str, Any]) -> bool:
        sec_type = _clean_text(security.get("type")).lower()
        sec_subtype = _clean_text(security.get("subtype")).lower()
        return sec_type in {"equity", "etf"} or sec_subtype in {
            "common stock",
            "adr",
            "etf",
            "index fund",
        }

    def _normalize_holding(
        self,
        *,
        item_row: dict[str, Any],
        account_lookup: dict[str, dict[str, Any]],
        security_lookup: dict[str, dict[str, Any]],
        holding: dict[str, Any],
        last_synced_at: str | None,
        sync_status: str,
    ) -> dict[str, Any]:
        account_id = _clean_text(holding.get("account_id"))
        security_id = _clean_text(holding.get("security_id"))
        account = account_lookup.get(account_id, {})
        security = security_lookup.get(security_id, {})
        ticker_symbol = _clean_text(security.get("ticker_symbol")).upper()
        proxy_security_id = _clean_text(security.get("proxy_security_id")) or None
        display_symbol = ticker_symbol or proxy_security_id or security_id or "UNKNOWN"
        name = _clean_text(security.get("name"), default="Unknown")
        quantity = _to_float(holding.get("quantity")) or 0.0
        price = (
            _to_float(holding.get("institution_price"))
            or _to_float(security.get("close_price"))
            or 0.0
        )
        market_value = _to_float(holding.get("institution_value")) or (
            price * quantity if price and quantity else 0.0
        )
        cost_basis = _to_float(holding.get("cost_basis"))
        unrealized = (
            round(market_value - cost_basis, 2)
            if cost_basis is not None and market_value is not None
            else None
        )
        unrealized_pct = (
            round((unrealized / cost_basis) * 100.0, 4)
            if unrealized is not None and cost_basis not in {None, 0}
            else None
        )
        instrument_kind = self._instrument_kind(security, symbol=display_symbol, name=name)
        is_cash_equivalent = self._is_cash_equivalent(security, symbol=display_symbol, name=name)
        analyze_eligible = (
            bool(display_symbol) and self._is_equity_like(security) and not is_cash_equivalent
        )
        fixed_income = (
            security.get("fixed_income") if isinstance(security.get("fixed_income"), dict) else {}
        )
        option_contract = (
            security.get("option_contract")
            if isinstance(security.get("option_contract"), dict)
            else {}
        )

        return {
            "symbol": display_symbol,
            "symbol_cusip": _clean_text(security.get("cusip")) or None,
            "identifier_type": "ticker" if ticker_symbol else "derived",
            "name": name,
            "quantity": round(quantity, 6),
            "price": round(price, 6),
            "market_value": round(market_value, 2),
            "cost_basis": round(cost_basis, 2) if cost_basis is not None else None,
            "unrealized_gain_loss": unrealized,
            "unrealized_gain_loss_pct": unrealized_pct,
            "estimated_annual_income": None,
            "est_yield": _to_float((fixed_income.get("yield_rate") or {}).get("percentage")),
            "asset_class": _clean_text(security.get("type")) or None,
            "sector": _clean_text(security.get("sector")) or None,
            "industry": _clean_text(security.get("industry")) or None,
            "asset_type": _clean_text(security.get("subtype"))
            or _clean_text(security.get("type"))
            or None,
            "instrument_kind": instrument_kind,
            "is_cash_equivalent": is_cash_equivalent,
            "is_investable": analyze_eligible,
            "analyze_eligible": analyze_eligible,
            "analyze_eligible_reason": None if analyze_eligible else "non_equity_or_missing_ticker",
            "debate_eligible": analyze_eligible,
            "optimize_eligible": analyze_eligible,
            "symbol_source": "plaid_security_ticker"
            if ticker_symbol
            else "plaid_security_identifier",
            "symbol_kind": "plaid_brokerage_symbol",
            "security_listing_status": "plaid_broker_sourced",
            "is_sec_common_equity_ticker": analyze_eligible,
            "confidence": 1.0,
            "provenance": {
                "source_type": "plaid",
                "item_id": _clean_text(item_row.get("item_id")),
                "institution_id": _clean_text(item_row.get("institution_id")) or None,
                "institution_name": _clean_text(item_row.get("institution_name")) or None,
                "account_id": account_id or None,
                "account_name": _clean_text(account.get("name")) or None,
                "security_id": security_id or None,
                "proxy_security_id": proxy_security_id,
                "institution_price_as_of": _clean_text(holding.get("institution_price_as_of"))
                or None,
                "close_price_as_of": _clean_text(security.get("close_price_as_of")) or None,
                "option_contract": option_contract or None,
                "fixed_income": fixed_income or None,
            },
            "source_type": "plaid",
            "source_id": f"{_clean_text(item_row.get('item_id'))}:{account_id or 'unknown'}:{security_id or display_symbol}",
            "item_id": _clean_text(item_row.get("item_id")),
            "account_id": account_id or None,
            "persistent_account_id": _clean_text(account.get("persistent_account_id")) or None,
            "institution_id": _clean_text(item_row.get("institution_id")) or None,
            "institution_name": _clean_text(item_row.get("institution_name")) or None,
            "last_synced_at": last_synced_at,
            "institution_price_as_of": _clean_text(holding.get("institution_price_as_of")) or None,
            "is_editable": False,
            "sync_status": sync_status,
            "security_id": security_id or None,
            "proxy_security_id": proxy_security_id,
            "account_name": _clean_text(account.get("name")) or None,
            "account_mask": _clean_text(account.get("mask")) or None,
            "account_subtype": _clean_text(account.get("subtype")) or None,
        }

    def _summarize_transactions(self, transactions: list[dict[str, Any]]) -> dict[str, Any]:
        dividends = 0.0
        interest = 0.0
        fees = 0.0
        contributions = 0.0
        withdrawals = 0.0
        buys = 0.0
        sells = 0.0
        for row in transactions:
            subtype = _clean_text(row.get("subtype")).lower()
            tx_type = _clean_text(row.get("type")).lower()
            amount = _to_float(row.get("amount")) or 0.0
            fee_amount = _to_float(row.get("fees")) or 0.0
            fees += fee_amount
            if "dividend" in subtype or "dividend" in tx_type:
                dividends += amount
            elif "interest" in subtype or "interest" in tx_type:
                interest += amount
            elif subtype in {"deposit", "contribution", "transfer in"} or "contribution" in subtype:
                contributions += amount
            elif subtype in {"withdrawal", "transfer out"}:
                withdrawals += abs(amount)
            elif "buy" in subtype or tx_type == "buy":
                buys += abs(amount)
            elif "sell" in subtype or tx_type == "sell":
                sells += abs(amount)
        return {
            "dividends_taxable": round(dividends, 2),
            "interest_income": round(interest, 2),
            "total_income": round(dividends + interest, 2),
            "total_fees": round(fees, 2),
            "gross_buys": round(buys, 2),
            "gross_sells": round(sells, 2),
            "net_contributions": round(contributions - withdrawals, 2),
        }

    def _build_portfolio_payload(
        self,
        *,
        holdings: list[dict[str, Any]],
        accounts: list[dict[str, Any]],
        transactions: list[dict[str, Any]],
        institution_names: list[str],
        last_synced_at: str | None,
        sync_status: str,
        item_count: int,
        item_ids: list[str],
    ) -> dict[str, Any]:
        holdings_total = round(
            sum(_to_float(row.get("market_value")) or 0.0 for row in holdings),
            2,
        )
        cash_balance = round(
            sum(
                _to_float(row.get("market_value")) or 0.0
                for row in holdings
                if row.get("is_cash_equivalent")
            ),
            2,
        )
        account_balance_total = round(
            sum(
                (
                    _to_float(
                        (
                            (row.get("balances") or {})
                            if isinstance(row.get("balances"), dict)
                            else {}
                        ).get("current")
                    )
                    or 0.0
                )
                for row in accounts
            ),
            2,
        )
        ending_value = holdings_total or account_balance_total
        income_summary = self._summarize_transactions(transactions)

        investable_count = sum(1 for row in holdings if bool(row.get("is_investable")))
        cash_positions_count = sum(1 for row in holdings if bool(row.get("is_cash_equivalent")))
        missing_cost_basis_count = sum(1 for row in holdings if row.get("cost_basis") in {None, 0})
        sector_coverage_count = sum(1 for row in holdings if _clean_text(row.get("sector")))
        symbol_coverage_count = sum(1 for row in holdings if _clean_text(row.get("symbol")))
        holdings_count = len(holdings)
        sector_coverage_pct = sector_coverage_count / holdings_count if holdings_count > 0 else 0.0
        symbol_coverage_pct = symbol_coverage_count / holdings_count if holdings_count > 0 else 0.0

        account_summary = {
            "ending_value": ending_value,
            "cash_balance": cash_balance,
            "equities_value": round(max(ending_value - cash_balance, 0.0), 2),
            "total_income_period": income_summary.get("total_income"),
            "total_income_ytd": income_summary.get("total_income"),
            "total_fees": income_summary.get("total_fees"),
            "net_deposits_period": income_summary.get("net_contributions"),
            "net_deposits_ytd": income_summary.get("net_contributions"),
        }

        quality_report_v2 = {
            "schema_version": 2,
            "raw_count": holdings_count,
            "validated_count": holdings_count,
            "aggregated_count": holdings_count,
            "holdings_count": holdings_count,
            "investable_positions_count": investable_count,
            "cash_positions_count": cash_positions_count,
            "allocation_coverage_pct": round(1.0 if holdings_count > 0 else 0.0, 4),
            "symbol_trust_coverage_pct": round(symbol_coverage_pct, 4),
            "parser_quality_score": 1.0 if holdings_count > 0 else 0.0,
            "quality_gate": {
                "passed": holdings_count > 0,
                "severity": "pass" if sync_status == "completed" else "warn",
                "reasons": [] if sync_status == "completed" else ["broker_sync_pending"],
                "source_type": "plaid",
                "sync_status": sync_status,
            },
            "dropped_reasons": {},
            "diagnostics": {
                "source_type": "plaid",
                "last_synced_at": last_synced_at,
                "account_count": len(accounts),
                "item_count": item_count,
                "missing_cost_basis_count": missing_cost_basis_count,
                "sector_coverage_pct": round(sector_coverage_pct, 4),
                "supported_investable_holdings_count": investable_count,
            },
        }

        canonical_portfolio = {
            "schema_version": 2,
            "generated_at": _utcnow_iso(),
            "account_info": {
                "account_number": None,
                "account_type": "investment_accounts",
                "account_holder": None,
                "brokerage_name": institution_names[0]
                if len(institution_names) == 1
                else "Multiple brokerages",
                "institution_name": institution_names[0]
                if len(institution_names) == 1
                else "Multiple institutions",
                "statement_period": {
                    "start": None,
                    "end": None,
                },
                "statement_details": {
                    "source_type": "plaid",
                    "item_ids": item_ids,
                },
                "account_metadata": {
                    "item_count": item_count,
                    "account_count": len(accounts),
                },
            },
            "account_summary": account_summary,
            "holdings": holdings,
            "asset_allocation": None,
            "cash_ledger": {
                "rows": [row for row in holdings if row.get("is_cash_equivalent")],
                "total_cash_equivalent_value": cash_balance,
                "cash_balance": cash_balance,
            },
            "total_value": ending_value,
            "cash_balance": cash_balance,
            "statement_period": {"start": None, "end": None},
            "quality_report_v2": quality_report_v2,
            "source_metadata": {
                "source_type": "plaid",
                "source_label": "Plaid",
                "is_editable": False,
                "sync_status": sync_status,
                "last_synced_at": last_synced_at,
                "item_count": item_count,
                "account_count": len(accounts),
                "institution_names": institution_names,
                "requires_explicit_source_selection_for_analysis": False,
            },
            "transactions": transactions,
            "activity_and_transactions": transactions,
            "income_summary": {
                "dividends_taxable": income_summary.get("dividends_taxable"),
                "interest_income": income_summary.get("interest_income"),
                "total_income": income_summary.get("total_income"),
            },
            "total_fees": income_summary.get("total_fees"),
        }

        analytics = build_financial_analytics_v2(
            canonical_portfolio_v2=canonical_portfolio,
            raw_extract_v2={
                "income_summary": canonical_portfolio.get("income_summary"),
                "reconciliation_summary": {
                    "source_type": "plaid",
                    "sync_status": sync_status,
                    "item_count": item_count,
                    "account_count": len(accounts),
                    "last_synced_at": last_synced_at,
                    "missing_cost_basis_count": missing_cost_basis_count,
                    "sector_coverage_pct": round(sector_coverage_pct, 4),
                },
            },
        )
        analytics.setdefault("quality_metrics", {})
        analytics["quality_metrics"].update(
            {
                "source_type": "plaid",
                "data_freshness": {
                    "last_synced_at": last_synced_at,
                    "sync_status": sync_status,
                },
                "missing_cost_basis_count": missing_cost_basis_count,
                "sector_coverage_pct": round(sector_coverage_pct, 4),
                "supported_investable_holdings_count": investable_count,
            }
        )
        analytics.setdefault("debate_readiness", {})
        analytics["debate_readiness"].update(
            {
                "source_type": "plaid",
                "eligible_count": investable_count,
                "quality_score": 1.0 if holdings_count > 0 else 0.0,
                "last_synced_at": last_synced_at,
            }
        )
        analytics.setdefault("optimize_signals", {})
        analytics["optimize_signals"].update(
            {
                "source_type": "plaid",
                "missing_cost_basis_count": missing_cost_basis_count,
            }
        )

        canonical_portfolio["analytics_v2"] = analytics
        return canonical_portfolio

    async def _fetch_all_investment_transactions(self, access_token: str) -> list[dict[str, Any]]:
        start_date = (date.today() - timedelta(days=self._tx_history_days())).isoformat()
        end_date = date.today().isoformat()
        offset = 0
        count = 100
        transactions: list[dict[str, Any]] = []
        total = None
        while total is None or offset < total:
            payload = await self._post(
                "/investments/transactions/get",
                {
                    "access_token": access_token,
                    "start_date": start_date,
                    "end_date": end_date,
                    "count": count,
                    "offset": offset,
                },
            )
            rows = payload.get("investment_transactions")
            page_rows = rows if isinstance(rows, list) else []
            transactions.extend([row for row in page_rows if isinstance(row, dict)])
            total = _to_int(payload.get("total_investment_transactions"), default=len(transactions))
            offset += len(page_rows)
            if not page_rows:
                break
        return transactions

    async def _sync_item_snapshot(
        self,
        *,
        user_id: str,
        item_id: str,
        access_token: str,
        institution_id: str | None,
        institution_name: str | None,
        status: str = "active",
        sync_status: str = "completed",
    ) -> dict[str, Any]:
        holdings_payload = await self._post(
            "/investments/holdings/get",
            {"access_token": access_token},
        )
        try:
            transactions = await self._fetch_all_investment_transactions(access_token)
        except PlaidApiError as exc:
            logger.warning(
                "plaid.transactions_sync_failed user_id=%s item_id=%s error_code=%s status=%s",
                user_id,
                item_id,
                exc.error_code,
                exc.status_code,
            )
            transactions = []

        accounts_raw = holdings_payload.get("accounts")
        holdings_raw = holdings_payload.get("holdings")
        securities_raw = holdings_payload.get("securities")
        accounts = (
            [row for row in accounts_raw if isinstance(row, dict)]
            if isinstance(accounts_raw, list)
            else []
        )
        holdings = (
            [row for row in holdings_raw if isinstance(row, dict)]
            if isinstance(holdings_raw, list)
            else []
        )
        securities = (
            [row for row in securities_raw if isinstance(row, dict)]
            if isinstance(securities_raw, list)
            else []
        )

        item_row = {
            "item_id": item_id,
            "institution_id": institution_id,
            "institution_name": institution_name,
        }
        normalized_accounts = [self._normalize_account(item_row, row) for row in accounts]
        account_lookup = {
            _clean_text(row.get("account_id")): normalized_row
            for row, normalized_row in zip(accounts, normalized_accounts, strict=False)
            if _clean_text(row.get("account_id"))
        }
        security_lookup = {
            _clean_text(row.get("security_id")): row
            for row in securities
            if _clean_text(row.get("security_id"))
        }
        last_synced_at = _utcnow_iso()
        normalized_holdings = [
            self._normalize_holding(
                item_row=item_row,
                account_lookup=account_lookup,
                security_lookup=security_lookup,
                holding=row,
                last_synced_at=last_synced_at,
                sync_status=sync_status,
            )
            for row in holdings
        ]
        portfolio_payload = self._build_portfolio_payload(
            holdings=normalized_holdings,
            accounts=normalized_accounts,
            transactions=transactions,
            institution_names=_unique_texts([institution_name] if institution_name else []),
            last_synced_at=last_synced_at,
            sync_status=sync_status,
            item_count=1,
            item_ids=[item_id],
        )
        summary_payload = {
            "item_id": item_id,
            "institution_id": institution_id,
            "institution_name": institution_name,
            "last_synced_at": last_synced_at,
            "sync_status": sync_status,
            "account_count": len(normalized_accounts),
            "holdings_count": len(normalized_holdings),
            "transactions_count": len(transactions),
            "total_value": portfolio_payload.get("total_value"),
            "cash_balance": portfolio_payload.get("cash_balance"),
        }

        envelope = self._encrypt_access_token(access_token)
        self.db.execute_raw(
            """
            INSERT INTO kai_plaid_items (
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
                sync_status,
                last_sync_at,
                last_error_code,
                last_error_message,
                latest_accounts_json,
                latest_holdings_json,
                latest_securities_json,
                latest_transactions_json,
                latest_summary_json,
                latest_portfolio_json,
                latest_metadata_json,
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
                :status,
                :sync_status,
                NOW(),
                NULL,
                NULL,
                CAST(:latest_accounts_json AS JSONB),
                CAST(:latest_holdings_json AS JSONB),
                CAST(:latest_securities_json AS JSONB),
                CAST(:latest_transactions_json AS JSONB),
                CAST(:latest_summary_json AS JSONB),
                CAST(:latest_portfolio_json AS JSONB),
                CAST(:latest_metadata_json AS JSONB),
                NOW(),
                NOW()
            )
            ON CONFLICT (item_id) DO UPDATE
            SET user_id = EXCLUDED.user_id,
                access_token_ciphertext = EXCLUDED.access_token_ciphertext,
                access_token_iv = EXCLUDED.access_token_iv,
                access_token_tag = EXCLUDED.access_token_tag,
                access_token_algorithm = EXCLUDED.access_token_algorithm,
                institution_id = EXCLUDED.institution_id,
                institution_name = EXCLUDED.institution_name,
                plaid_env = EXCLUDED.plaid_env,
                status = EXCLUDED.status,
                sync_status = EXCLUDED.sync_status,
                last_sync_at = NOW(),
                last_error_code = NULL,
                last_error_message = NULL,
                latest_accounts_json = EXCLUDED.latest_accounts_json,
                latest_holdings_json = EXCLUDED.latest_holdings_json,
                latest_securities_json = EXCLUDED.latest_securities_json,
                latest_transactions_json = EXCLUDED.latest_transactions_json,
                latest_summary_json = EXCLUDED.latest_summary_json,
                latest_portfolio_json = EXCLUDED.latest_portfolio_json,
                latest_metadata_json = EXCLUDED.latest_metadata_json,
                updated_at = NOW()
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
                "plaid_env": self._plaid_env(),
                "status": status,
                "sync_status": sync_status,
                "latest_accounts_json": json.dumps(normalized_accounts),
                "latest_holdings_json": json.dumps(normalized_holdings),
                "latest_securities_json": json.dumps(securities),
                "latest_transactions_json": json.dumps(transactions),
                "latest_summary_json": json.dumps(summary_payload),
                "latest_portfolio_json": json.dumps(portfolio_payload),
                "latest_metadata_json": json.dumps(
                    {
                        "item_id": item_id,
                        "user_id": user_id,
                        "institution_id": institution_id,
                        "institution_name": institution_name,
                        "last_synced_at": last_synced_at,
                    }
                ),
            },
        )
        return {
            "summary": summary_payload,
            "portfolio": portfolio_payload,
            "accounts": normalized_accounts,
            "holdings": normalized_holdings,
            "transactions": transactions,
        }

    def _aggregate_status_payload(self, *, user_id: str) -> dict[str, Any]:
        rows = self._list_item_rows(user_id=user_id)
        latest_runs = self._latest_run_by_item(user_id=user_id)
        items: list[dict[str, Any]] = []
        aggregate_accounts: list[dict[str, Any]] = []
        aggregate_holdings: list[dict[str, Any]] = []
        aggregate_transactions: list[dict[str, Any]] = []
        institution_names: list[str] = []
        active_item_ids: list[str] = []
        last_synced_candidates: list[str] = []
        any_running = False

        for row in rows:
            item_id = _clean_text(row.get("item_id"))
            if not item_id:
                continue
            status = _clean_text(row.get("status"), default="active")
            sync_status = _clean_text(row.get("sync_status"), default="idle")
            latest_run = latest_runs.get(item_id)
            if latest_run and _clean_text(latest_run.get("status")) in {"queued", "running"}:
                any_running = True
            summary = _json_load(row.get("latest_summary_json"), fallback={})
            accounts = _json_load(row.get("latest_accounts_json"), fallback=[])
            holdings = _json_load(row.get("latest_holdings_json"), fallback=[])
            transactions = _json_load(row.get("latest_transactions_json"), fallback=[])
            portfolio = _json_load(row.get("latest_portfolio_json"), fallback={})
            institution_name = _clean_text(row.get("institution_name"))
            if institution_name:
                institution_names.append(institution_name)
            last_synced_at = (
                _clean_text(row.get("last_sync_at"))
                or _clean_text(summary.get("last_synced_at"))
                or None
            )
            if last_synced_at:
                last_synced_candidates.append(last_synced_at)
            if status in _READONLY_ITEM_STATUSES:
                aggregate_accounts.extend([entry for entry in accounts if isinstance(entry, dict)])
                aggregate_holdings.extend([entry for entry in holdings if isinstance(entry, dict)])
                aggregate_transactions.extend(
                    [entry for entry in transactions if isinstance(entry, dict)]
                )
                active_item_ids.append(item_id)

            items.append(
                {
                    "item_id": item_id,
                    "institution_id": _clean_text(row.get("institution_id")) or None,
                    "institution_name": institution_name or None,
                    "status": status,
                    "sync_status": sync_status,
                    "last_synced_at": last_synced_at,
                    "last_refresh_requested_at": row.get("last_refresh_requested_at"),
                    "last_error_code": _clean_text(row.get("last_error_code")) or None,
                    "last_error_message": _clean_text(row.get("last_error_message")) or None,
                    "last_webhook_type": _clean_text(row.get("last_webhook_type")) or None,
                    "last_webhook_code": _clean_text(row.get("last_webhook_code")) or None,
                    "summary": summary if isinstance(summary, dict) else {},
                    "accounts": accounts if isinstance(accounts, list) else [],
                    "portfolio_data": portfolio if isinstance(portfolio, dict) else {},
                    "latest_refresh_run": {
                        **latest_run,
                        "result_summary_json": _json_load(
                            latest_run.get("result_summary_json"), fallback={}
                        )
                        if latest_run
                        else {},
                    }
                    if latest_run
                    else None,
                }
            )

        unique_institutions = _unique_texts(institution_names)
        aggregate_portfolio = (
            self._build_portfolio_payload(
                holdings=aggregate_holdings,
                accounts=aggregate_accounts,
                transactions=aggregate_transactions,
                institution_names=unique_institutions,
                last_synced_at=max(last_synced_candidates) if last_synced_candidates else None,
                sync_status="running" if any_running else ("completed" if items else "idle"),
                item_count=len(active_item_ids),
                item_ids=active_item_ids,
            )
            if aggregate_accounts or aggregate_holdings
            else None
        )
        if aggregate_portfolio:
            aggregate_portfolio.setdefault("source_metadata", {})
            aggregate_portfolio["source_metadata"].update(
                {
                    "source_type": "plaid",
                    "source_label": "Plaid",
                    "is_editable": False,
                    "institution_names": unique_institutions,
                    "item_count": len(active_item_ids),
                    "account_count": len(aggregate_accounts),
                    "last_synced_at": max(last_synced_candidates)
                    if last_synced_candidates
                    else None,
                    "sync_status": "running" if any_running else "completed",
                }
            )

        aggregate_payload = {
            "item_count": len(active_item_ids),
            "account_count": len(aggregate_accounts),
            "holdings_count": len(aggregate_holdings),
            "institution_names": unique_institutions,
            "last_synced_at": max(last_synced_candidates) if last_synced_candidates else None,
            "sync_status": "running" if any_running else ("completed" if items else "idle"),
            "portfolio_data": aggregate_portfolio,
        }

        return {
            **self.configuration_status(),
            "user_id": user_id,
            "source_preference": self.get_active_source(user_id),
            "items": items,
            "aggregate": aggregate_payload,
        }

    async def create_link_token(
        self,
        *,
        user_id: str,
        item_id: str | None = None,
        redirect_uri: str | None = None,
    ) -> dict[str, Any]:
        if not self.is_configured():
            return {
                **self.configuration_status(),
                "mode": "unconfigured",
                "link_token": None,
                "expiration": None,
                "resume_session_id": None,
            }

        payload: dict[str, Any] = {
            "client_name": self._client_name(),
            "user": {"client_user_id": user_id},
            "country_codes": self._country_codes(),
            "language": self._language(),
            "account_filters": {
                "investment": {
                    "account_subtypes": ["all"],
                }
            },
        }
        if self._manual_entry_enabled():
            payload["investments"] = {"allow_manual_entry": True}
        webhook_url = self._webhook_url()
        if webhook_url:
            payload["webhook"] = webhook_url
        resolved_redirect_uri = self.resolve_redirect_uri(redirect_uri)
        if resolved_redirect_uri:
            payload["redirect_uri"] = resolved_redirect_uri

        mode: str = "create"
        if item_id:
            existing = self._fetch_item_row(user_id=user_id, item_id=item_id)
            if existing is None:
                raise RuntimeError("Plaid Item not found for update-mode link token.")
            payload["access_token"] = self._decrypt_access_token(existing)
            payload["update"] = {"account_selection_enabled": True}
            mode = "update"
        else:
            payload["products"] = ["investments"]

        response = await self._post("/link/token/create", payload)
        link_token = _clean_text(response.get("link_token")) or None
        expiration = _clean_text(response.get("expiration")) or None
        resume_session_id = None
        if link_token and resolved_redirect_uri:
            session = self._create_link_session(
                user_id=user_id,
                item_id=item_id,
                mode=mode,
                redirect_uri=resolved_redirect_uri,
                link_token=link_token,
                expires_at=expiration,
            )
            resume_session_id = _clean_text(session.get("resume_session_id")) or None
        return {
            **self.configuration_status(),
            "mode": mode,
            "link_token": link_token,
            "expiration": expiration,
            "request_id": response.get("request_id"),
            "redirect_uri": resolved_redirect_uri,
            "resume_session_id": resume_session_id,
        }

    async def get_oauth_resume(
        self,
        *,
        user_id: str,
        resume_session_id: str,
    ) -> dict[str, Any] | None:
        if not self.is_configured():
            return None

        session = self._get_link_session(
            user_id=user_id,
            resume_session_id=resume_session_id,
        )
        if session is None:
            return None
        return {
            **self.configuration_status(),
            "mode": _clean_text(session.get("mode"), default="create"),
            "item_id": _clean_text(session.get("item_id")) or None,
            "link_token": _clean_text(session.get("link_token")) or None,
            "expiration": session.get("expires_at"),
            "redirect_uri": _clean_text(session.get("redirect_uri")) or None,
            "resume_session_id": _clean_text(session.get("resume_session_id")) or None,
        }

    async def exchange_public_token(
        self,
        *,
        user_id: str,
        public_token: str,
        metadata: dict[str, Any] | None = None,
        resume_session_id: str | None = None,
    ) -> dict[str, Any]:
        if not self.is_configured():
            return self._aggregate_status_payload(user_id=user_id)

        exchange = await self._post(
            "/item/public_token/exchange",
            {"public_token": public_token},
        )
        item_id = _clean_text(exchange.get("item_id"))
        access_token = _clean_text(exchange.get("access_token"))
        if not item_id or not access_token:
            raise RuntimeError("Plaid exchange did not return an item_id/access_token pair.")

        institution = metadata if isinstance(metadata, dict) else {}
        institution_name = None
        institution_id = None
        institution_value = (
            institution.get("institution")
            if isinstance(institution.get("institution"), dict)
            else institution
        )
        if isinstance(institution_value, dict):
            institution_name = _clean_text(institution_value.get("name")) or None
            institution_id = (
                _clean_text(institution_value.get("institution_id"))
                or _clean_text(institution_value.get("id"))
                or None
            )
        else:
            institution_name = _clean_text(institution.get("institution_name")) or None
            institution_id = _clean_text(institution.get("institution_id")) or None

        await self._sync_item_snapshot(
            user_id=user_id,
            item_id=item_id,
            access_token=access_token,
            institution_id=institution_id,
            institution_name=institution_name,
            status="active",
            sync_status="completed",
        )

        current_source = self.get_active_source(user_id)
        if current_source != "plaid":
            self.set_active_source(user_id=user_id, active_source="plaid")

        cleaned_resume_session_id = _clean_text(resume_session_id) or None
        if cleaned_resume_session_id:
            self._complete_link_session(
                user_id=user_id,
                resume_session_id=cleaned_resume_session_id,
            )

        return self._aggregate_status_payload(user_id=user_id)

    async def refresh_items(
        self,
        *,
        user_id: str,
        item_id: str | None = None,
        trigger_source: str = "manual_refresh",
    ) -> dict[str, Any]:
        rows = self._list_item_rows(user_id=user_id)
        target_rows = [
            row
            for row in rows
            if _clean_text(row.get("item_id"))
            and (item_id is None or _clean_text(row.get("item_id")) == item_id)
            and _clean_text(row.get("status"), default="active") in _ACTIVE_ITEM_STATUSES
        ]
        if not target_rows:
            raise RuntimeError("No active Plaid Item is available to refresh.")

        latest_runs = self._latest_run_by_item(user_id=user_id)
        blocking_runs = [
            latest_runs.get(_clean_text(row.get("item_id")))
            for row in target_rows
            if self._is_refresh_run_active(latest_runs.get(_clean_text(row.get("item_id"))))
        ]
        if blocking_runs:
            raise RuntimeError(
                "A Plaid refresh is already in progress. Let it finish or cancel it first."
            )

        runs: list[dict[str, Any]] = []
        for row in target_rows:
            current_item_id = _clean_text(row.get("item_id"))
            run = self._create_refresh_run(
                user_id=user_id,
                item_id=current_item_id,
                trigger_source=trigger_source,
            )
            self._mark_item_sync_status(
                item_id=current_item_id,
                sync_status="running",
                refresh_requested=True,
            )
            task = asyncio.create_task(
                self._refresh_item_worker(
                    user_id=user_id,
                    item_row=row,
                    run_id=_clean_text(run.get("run_id")),
                )
            )
            self._track_background_task(task, run_id=_clean_text(run.get("run_id")) or None)
            runs.append(run)

        return {
            "accepted": True,
            "runs": [
                {
                    **run,
                    "result_summary_json": _json_load(run.get("result_summary_json"), fallback={}),
                }
                for run in runs
            ],
        }

    async def cancel_refresh_run(self, *, user_id: str, run_id: str) -> dict[str, Any] | None:
        run = self._get_refresh_run(user_id=user_id, run_id=run_id)
        if run is None:
            return None

        status = _clean_text(run.get("status"), default="queued")
        if status not in {"queued", "running"}:
            return {
                **run,
                "result_summary_json": _json_load(run.get("result_summary_json"), fallback={}),
            }

        item_id = _clean_text(run.get("item_id"))
        item_row = self._fetch_item_row(user_id=user_id, item_id=item_id) if item_id else None
        result_summary = {
            "canceled_by": "user",
            "canceled_at": _utcnow_iso(),
        }
        self._update_refresh_run(
            run_id=run_id,
            status="canceled",
            error_message="Refresh canceled by user.",
            result_summary=result_summary,
            completed=True,
        )
        if item_row is not None:
            self._mark_item_sync_status(
                item_id=item_id,
                sync_status=self._sync_status_after_cancel(item_row),
                status=_clean_text(item_row.get("status"), default="active"),
            )

        task = self._refresh_tasks_by_run_id.get(run_id)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception(
                    "plaid.refresh_cancel_task_failed user_id=%s run_id=%s",
                    user_id,
                    run_id,
                )

        refreshed = self._get_refresh_run(user_id=user_id, run_id=run_id)
        if refreshed is None:
            return None
        return {
            **refreshed,
            "result_summary_json": _json_load(refreshed.get("result_summary_json"), fallback={}),
        }

    async def update_item_webhooks(
        self,
        *,
        user_id: str | None = None,
        item_id: str | None = None,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        webhook_url = self._webhook_url()
        if not webhook_url:
            raise RuntimeError("PLAID_WEBHOOK_URL is not configured.")

        if item_id:
            row = self._fetch_item_row_by_item_id(item_id)
            rows = [row] if row else []
            if user_id:
                rows = [entry for entry in rows if _clean_text(entry.get("user_id")) == user_id]
        elif user_id:
            rows = self._list_item_rows(user_id=user_id)
        else:
            result = self.db.execute_raw(
                """
                SELECT *
                FROM kai_plaid_items
                WHERE status != 'removed'
                ORDER BY user_id, created_at DESC
                """
            )
            rows = result.data

        updated: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            current_item_id = _clean_text(row.get("item_id"))
            if not current_item_id:
                continue
            if dry_run:
                updated.append(
                    {
                        "item_id": current_item_id,
                        "user_id": _clean_text(row.get("user_id")) or None,
                        "institution_name": _clean_text(row.get("institution_name")) or None,
                        "webhook_url": webhook_url,
                        "updated": False,
                    }
                )
                continue

            access_token = self._decrypt_access_token(row)
            response = await self._post(
                "/item/webhook/update",
                {
                    "access_token": access_token,
                    "webhook": webhook_url,
                },
            )
            updated.append(
                {
                    "item_id": current_item_id,
                    "user_id": _clean_text(row.get("user_id")) or None,
                    "institution_name": _clean_text(row.get("institution_name")) or None,
                    "webhook_url": webhook_url,
                    "updated": True,
                    "request_id": response.get("request_id"),
                }
            )

        return {
            "dry_run": dry_run,
            "webhook_url": webhook_url,
            "count": len(updated),
            "items": updated,
        }

    async def _refresh_item_worker(
        self,
        *,
        user_id: str,
        item_row: dict[str, Any],
        run_id: str,
    ) -> None:
        item_id = _clean_text(item_row.get("item_id"))
        self._update_refresh_run(
            run_id=run_id,
            status="running",
            started=True,
        )
        try:
            access_token = self._decrypt_access_token(item_row)
            refresh_method = "investments_refresh"
            fallback_reason = None
            try:
                await self._post("/investments/refresh", {"access_token": access_token})
            except PlaidApiError as exc:
                if exc.error_code == "PRODUCT_NOT_SUPPORTED":
                    refresh_method = "holdings_get_fallback"
                    fallback_reason = exc.error_code
                    logger.info(
                        "plaid.refresh_fallback_product_not_supported user_id=%s item_id=%s",
                        user_id,
                        item_id,
                    )
                else:
                    raise

            if self._is_refresh_run_canceled(run_id=run_id):
                logger.info(
                    "plaid.refresh_canceled_before_sync user_id=%s item_id=%s run_id=%s",
                    user_id,
                    item_id,
                    run_id,
                )
                return

            sync_result = await self._sync_item_snapshot(
                user_id=user_id,
                item_id=item_id,
                access_token=access_token,
                institution_id=_clean_text(item_row.get("institution_id")) or None,
                institution_name=_clean_text(item_row.get("institution_name")) or None,
                status="active",
                sync_status="completed",
            )
            result_summary = sync_result.get("summary") if isinstance(sync_result, dict) else {}
            if self._is_refresh_run_canceled(run_id=run_id):
                logger.info(
                    "plaid.refresh_canceled_after_sync user_id=%s item_id=%s run_id=%s",
                    user_id,
                    item_id,
                    run_id,
                )
                return
            self._update_refresh_run(
                run_id=run_id,
                status="completed",
                refresh_method=refresh_method,
                fallback_reason=fallback_reason,
                result_summary=result_summary if isinstance(result_summary, dict) else {},
                completed=True,
            )
            self._mark_item_sync_status(item_id=item_id, sync_status="completed", status="active")
        except asyncio.CancelledError:
            logger.info(
                "plaid.refresh_worker_canceled user_id=%s item_id=%s run_id=%s",
                user_id,
                item_id,
                run_id,
            )
            if not self._is_refresh_run_canceled(run_id=run_id):
                self._update_refresh_run(
                    run_id=run_id,
                    status="canceled",
                    error_message="Refresh canceled by user.",
                    result_summary={
                        "canceled_by": "user",
                        "canceled_at": _utcnow_iso(),
                    },
                    completed=True,
                )
                self._mark_item_sync_status(
                    item_id=item_id,
                    sync_status=self._sync_status_after_cancel(item_row),
                    status=_clean_text(item_row.get("status"), default="active"),
                )
            raise
        except PlaidApiError as exc:
            logger.warning(
                "plaid.refresh_failed user_id=%s item_id=%s error_code=%s status=%s",
                user_id,
                item_id,
                exc.error_code,
                exc.status_code,
            )
            item_status = (
                "relink_required"
                if exc.error_code
                in {
                    "ITEM_LOGIN_REQUIRED",
                    "PENDING_EXPIRATION",
                    "ITEM_NOT_SUPPORTED",
                }
                else "error"
            )
            self._mark_item_sync_status(
                item_id=item_id,
                sync_status="failed",
                status=item_status,
                last_error_code=exc.error_code,
                last_error_message=str(exc),
            )
            self._update_refresh_run(
                run_id=run_id,
                status="failed",
                error_code=exc.error_code,
                error_message=str(exc),
                result_summary={
                    "error_type": exc.error_type,
                    "display_message": exc.display_message,
                },
                completed=True,
            )
        except Exception as exc:
            logger.exception("plaid.refresh_worker_crashed user_id=%s item_id=%s", user_id, item_id)
            self._mark_item_sync_status(
                item_id=item_id,
                sync_status="failed",
                status="error",
                last_error_message=str(exc),
            )
            self._update_refresh_run(
                run_id=run_id,
                status="failed",
                error_message=str(exc),
                completed=True,
            )

    async def get_status(self, *, user_id: str) -> dict[str, Any]:
        return self._aggregate_status_payload(user_id=user_id)

    async def get_refresh_run_status(self, *, user_id: str, run_id: str) -> dict[str, Any] | None:
        row = self._get_refresh_run(user_id=user_id, run_id=run_id)
        if row is None:
            return None
        return {
            **row,
            "result_summary_json": _json_load(row.get("result_summary_json"), fallback={}),
        }

    async def handle_webhook(self, payload: dict[str, Any]) -> dict[str, Any]:
        item_id = _clean_text(payload.get("item_id"))
        webhook_type = _clean_text(payload.get("webhook_type"))
        webhook_code = _clean_text(payload.get("webhook_code"))
        if not item_id:
            return {"accepted": True, "handled": False, "reason": "missing_item_id"}

        row = self._fetch_item_row_by_item_id(item_id)
        if row is None:
            logger.info(
                "plaid.webhook_item_unknown item_id=%s type=%s code=%s",
                item_id,
                webhook_type,
                webhook_code,
            )
            return {"accepted": True, "handled": False, "reason": "unknown_item"}

        user_id = _clean_text(row.get("user_id"))
        if webhook_type == "HOLDINGS" and webhook_code == "DEFAULT_UPDATE":
            run = self._create_refresh_run(
                user_id=user_id,
                item_id=item_id,
                trigger_source="webhook",
                webhook_type=webhook_type or None,
                webhook_code=webhook_code or None,
            )
            self._mark_item_sync_status(
                item_id=item_id,
                sync_status="running",
                webhook_type=webhook_type or None,
                webhook_code=webhook_code or None,
            )
            task = asyncio.create_task(
                self._refresh_item_worker(
                    user_id=user_id,
                    item_row=row,
                    run_id=_clean_text(run.get("run_id")),
                )
            )
            self._track_background_task(task)
            return {"accepted": True, "handled": True, "run_id": _clean_text(run.get("run_id"))}

        if webhook_type == "ITEM":
            if webhook_code == "PENDING_EXPIRATION":
                self._mark_item_sync_status(
                    item_id=item_id,
                    sync_status="action_required",
                    status="relink_required",
                    webhook_type=webhook_type or None,
                    webhook_code=webhook_code or None,
                )
            elif webhook_code == "USER_PERMISSION_REVOKED":
                self._mark_item_sync_status(
                    item_id=item_id,
                    sync_status="failed",
                    status="permission_revoked",
                    webhook_type=webhook_type or None,
                    webhook_code=webhook_code or None,
                )
            elif webhook_code == "NEW_ACCOUNTS_AVAILABLE":
                self._mark_item_sync_status(
                    item_id=item_id,
                    sync_status="action_required",
                    status="active",
                    webhook_type=webhook_type or None,
                    webhook_code=webhook_code or None,
                )
            elif webhook_code == "ERROR":
                error_payload = (
                    payload.get("error") if isinstance(payload.get("error"), dict) else {}
                )
                self._mark_item_sync_status(
                    item_id=item_id,
                    sync_status="failed",
                    status="relink_required",
                    last_error_code=_clean_text(error_payload.get("error_code")) or None,
                    last_error_message=_clean_text(error_payload.get("error_message")) or None,
                    webhook_type=webhook_type or None,
                    webhook_code=webhook_code or None,
                )
            else:
                self._mark_item_sync_status(
                    item_id=item_id,
                    sync_status=_clean_text(row.get("sync_status"), default="idle"),
                    status=_clean_text(row.get("status"), default="active"),
                    webhook_type=webhook_type or None,
                    webhook_code=webhook_code or None,
                )
            return {"accepted": True, "handled": True}

        self._mark_item_sync_status(
            item_id=item_id,
            sync_status=_clean_text(row.get("sync_status"), default="idle"),
            status=_clean_text(row.get("status"), default="active"),
            webhook_type=webhook_type or None,
            webhook_code=webhook_code or None,
        )
        return {"accepted": True, "handled": True}


_plaid_portfolio_service: PlaidPortfolioService | None = None


def get_plaid_portfolio_service() -> PlaidPortfolioService:
    global _plaid_portfolio_service
    if _plaid_portfolio_service is None:
        _plaid_portfolio_service = PlaidPortfolioService()
    return _plaid_portfolio_service
