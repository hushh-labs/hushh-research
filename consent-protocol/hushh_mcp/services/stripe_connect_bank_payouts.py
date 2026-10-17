"""Connected-account bank payout state, separate from document earnings.

A document earning is settled by a Stripe Transfer into an owner's connected
balance. Stripe can combine many such earnings in one later bank Payout. This
store therefore reports Payout objects per owner and never attributes a bank
deposit to an individual document request.

Each deposit also keeps a write-once, masked snapshot of the bank it was sent
to, Stripe's bank trace reference and its reconciliation status. Provider reads
are ordered by the time they were taken: a newer same-status read (a moved
arrival date, a trace reference) is kept, an older one is not, and a status
never moves backwards.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import stripe
from sqlalchemy import text

from hushh_mcp.services.drive_request_payment_service import _config as payment_config
from hushh_mcp.services.drive_request_payment_service import _stripe_dict
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore
from hushh_mcp.services.payout_account_status_cache import invalidate_payout_account_status
from hushh_mcp.services.payout_doorbell import PayoutDoorbellError, notify_payout_changed
from hushh_mcp.services.pkm_payout_service import _account_readiness, resume_document_owner_setup
from hushh_mcp.services.stripe_mode import (
    configured_connect_mode,
    configured_stripe_mode,
    connect_config,
)

_ACCOUNT_EVENT_TYPES = {
    "account.updated",
    "account.external_account.created",
    "account.external_account.updated",
    "account.external_account.deleted",
}
_BALANCE_EVENT_TYPE = "balance.available"
_RECONCILIATION_EVENT_TYPE = "payout.reconciliation_completed"
_EVENT_TYPES = _ACCOUNT_EVENT_TYPES | {
    _BALANCE_EVENT_TYPE,
    "payout.created",
    "payout.updated",
    "payout.paid",
    "payout.failed",
    "payout.canceled",
    _RECONCILIATION_EVENT_TYPE,
}
# Stripe can itemise an automatic payout once its reconciliation completes.
_RECONCILE_ON_EVENT_TYPES = frozenset({"payout.paid", _RECONCILIATION_EVENT_TYPE})
_PAYOUT_RANK = {"pending": 0, "in_transit": 1, "paid": 2, "canceled": 3, "failed": 4}
_PROVIDER_ID = re.compile(r"^[A-Za-z0-9_]{4,255}$")
_SAFE_FAILURE_CODE = re.compile(r"^[a-z0-9_]{1,64}$")
_DESTINATION_ID = re.compile(r"^(ba|card)_[A-Za-z0-9_]{1,250}$")
_LAST4 = re.compile(r"^[0-9]{4}$")
# A bank reference is shown verbatim: printable ASCII without edge spaces.
_TRACE_VALUE = re.compile(r"^[\x21-\x7e](?:[\x20-\x7e]{0,126}[\x21-\x7e])?$")
_PAYOUT_METHODS = frozenset({"standard", "instant"})
_TRACE_STATUSES = frozenset({"pending", "supported", "unsupported"})
_RECONCILIATION_STATUSES = frozenset({"in_progress", "completed", "not_applicable"})
_SCAN_INTERVAL = timedelta(minutes=5)
_PROVIDER_READ_TIMEOUT_SECONDS = 8
_OWNER_PAGE_SIZE = 20  # installed clients reject a longer deposit list
_MAX_CURSOR_LENGTH = 256
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_MAX_CURSOR_MICROS = (datetime.max.replace(tzinfo=UTC) - _EPOCH) // timedelta(microseconds=1)

# A newer read applies when its status rank is higher, or when the rank is the
# same and it adds or corrects provider detail. The destination is write-once.
_STORE_PAYOUT_SQL = """INSERT INTO stripe_connect_bank_payouts AS p
  (stripe_payout_id,stripe_account_id,livemode,amount_cents,currency,status,status_rank,
   expected_arrival_at,failure_code,created_at,destination_id,destination_kind,
   destination_bank_name,destination_last4,payout_method,automatic,trace_status,trace_value,
   reconciliation_status,provider_observed_at,status_changed_at)
  VALUES (:id,:account,:livemode,:amount,'usd',:status,:rank,:arrival,:failure,:created,
   :destination_id,:destination_kind,:bank_name,:last4,:method,:automatic,:trace_status,
   :trace_value,:reconciliation,:observed,:observed)
  ON CONFLICT (stripe_payout_id) DO UPDATE SET
    status=excluded.status,
    status_rank=excluded.status_rank,
    expected_arrival_at=COALESCE(excluded.expected_arrival_at,p.expected_arrival_at),
    failure_code=CASE WHEN excluded.status_rank>p.status_rank THEN excluded.failure_code
      ELSE COALESCE(excluded.failure_code,p.failure_code) END,
    destination_id=COALESCE(p.destination_id,excluded.destination_id),
    destination_kind=COALESCE(p.destination_kind,excluded.destination_kind),
    destination_bank_name=CASE
      WHEN p.destination_id IS NULL OR p.destination_id=excluded.destination_id
      THEN COALESCE(p.destination_bank_name,excluded.destination_bank_name)
      ELSE p.destination_bank_name END,
    destination_last4=CASE
      WHEN p.destination_id IS NULL OR p.destination_id=excluded.destination_id
      THEN COALESCE(p.destination_last4,excluded.destination_last4)
      ELSE p.destination_last4 END,
    payout_method=COALESCE(p.payout_method,excluded.payout_method),
    automatic=COALESCE(p.automatic,excluded.automatic),
    trace_status=COALESCE(excluded.trace_status,p.trace_status),
    trace_value=COALESCE(excluded.trace_value,p.trace_value),
    reconciliation_status=COALESCE(excluded.reconciliation_status,p.reconciliation_status),
    provider_observed_at=CASE
      WHEN p.provider_observed_at IS NULL OR p.provider_observed_at<excluded.provider_observed_at
      THEN excluded.provider_observed_at ELSE p.provider_observed_at END,
    status_changed_at=CASE WHEN excluded.status_rank>p.status_rank
      THEN excluded.provider_observed_at ELSE p.status_changed_at END,
    paid_at=CASE WHEN excluded.status='paid' AND excluded.status_rank>p.status_rank
      THEN excluded.provider_observed_at ELSE p.paid_at END,
    failed_at=CASE WHEN excluded.status='failed' AND excluded.status_rank>p.status_rank
      THEN excluded.provider_observed_at ELSE p.failed_at END,
    updated_at=CURRENT_TIMESTAMP
  WHERE p.stripe_account_id=excluded.stripe_account_id
    AND p.livemode=excluded.livemode
    AND p.amount_cents=excluded.amount_cents
    AND p.currency=excluded.currency
    AND (p.status_rank<excluded.status_rank
      OR (p.status_rank=excluded.status_rank
        AND (p.provider_observed_at IS NULL
          OR p.provider_observed_at<excluded.provider_observed_at)
        AND ((excluded.expected_arrival_at IS NOT NULL
            AND p.expected_arrival_at IS DISTINCT FROM excluded.expected_arrival_at)
          OR (excluded.failure_code IS NOT NULL
            AND p.failure_code IS DISTINCT FROM excluded.failure_code)
          OR (excluded.trace_status IS NOT NULL
            AND p.trace_status IS DISTINCT FROM excluded.trace_status)
          OR (excluded.trace_value IS NOT NULL
            AND p.trace_value IS DISTINCT FROM excluded.trace_value)
          OR (excluded.reconciliation_status IS NOT NULL
            AND p.reconciliation_status IS DISTINCT FROM excluded.reconciliation_status)
          OR (p.destination_id IS NULL AND excluded.destination_id IS NOT NULL)
          OR ((p.destination_id IS NULL OR p.destination_id=excluded.destination_id)
            AND ((p.destination_bank_name IS NULL AND excluded.destination_bank_name IS NOT NULL)
              OR (p.destination_last4 IS NULL AND excluded.destination_last4 IS NOT NULL)))
          OR (p.payout_method IS NULL AND excluded.payout_method IS NOT NULL)
          OR (p.automatic IS NULL AND excluded.automatic IS NOT NULL))))"""

# Keyset pages on stripe_connect_bank_payouts_owner_recent (migration 294).
_OWNER_PAYOUTS_SQL = """SELECT stripe_payout_id,amount_cents,status,expected_arrival_at,
  failure_code,created_at,paid_at,failed_at,destination_bank_name,destination_last4,
  trace_status,trace_value FROM stripe_connect_bank_payouts
  WHERE stripe_account_id=:account AND livemode=:livemode
  ORDER BY created_at DESC,stripe_payout_id DESC LIMIT :limit"""
_OWNER_PAYOUTS_AFTER_SQL = """SELECT stripe_payout_id,amount_cents,status,expected_arrival_at,
  failure_code,created_at,paid_at,failed_at,destination_bank_name,destination_last4,
  trace_status,trace_value FROM stripe_connect_bank_payouts
  WHERE stripe_account_id=:account AND livemode=:livemode
    AND (created_at,stripe_payout_id)<(:before_at,:before_id)
  ORDER BY created_at DESC,stripe_payout_id DESC LIMIT :limit"""


class ConnectBankPayoutError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _valid_id(value: Any, prefix: str) -> bool:
    return (
        isinstance(value, str) and value.startswith(prefix) and bool(_PROVIDER_ID.fullmatch(value))
    )


def _closed(value: Any, allowed: frozenset[str]) -> str | None:
    return value if isinstance(value, str) and value in allowed else None


def _balances() -> Any:
    """The Connect balance ledger, imported when used because it may import this module."""
    from hushh_mcp.services import stripe_connect_balances

    return stripe_connect_balances


def _config() -> tuple[str, str, bool]:
    try:
        key, payment_webhook_secret, _ = payment_config()
    except Exception:
        raise ConnectBankPayoutError("payout_unavailable") from None
    connect_webhook_secret = (os.getenv("STRIPE_CONNECT_WEBHOOK_SECRET") or "").strip()
    if (
        not connect_webhook_secret.startswith("whsec_")
        or len(connect_webhook_secret) < 20
        or connect_webhook_secret == payment_webhook_secret
    ):
        raise ConnectBankPayoutError("payout_unavailable")
    return key, connect_webhook_secret, key.startswith("sk_live_")


def _destination_fields(destination: Any) -> dict[str, Any]:
    """Mask a payout destination; an unexpanded ID or a deleted bank keeps only the ID."""
    snapshot: dict[str, Any] = {
        "destination_id": None,
        "destination_kind": None,
        "bank_name": None,
        "last4": None,
    }
    details = destination if isinstance(destination, dict) else None
    destination_id = details.get("id") if details is not None else destination
    if not isinstance(destination_id, str) or not _DESTINATION_ID.fullmatch(destination_id):
        return snapshot
    kind = "bank_account" if destination_id.startswith("ba_") else "card"
    snapshot["destination_id"] = destination_id
    snapshot["destination_kind"] = kind
    if details is None or details.get("deleted") is True or details.get("object") != kind:
        return snapshot
    # Same display rules as the account's current bank (pkm_payout_service).
    name = details.get("bank_name") if kind == "bank_account" else None
    last4 = details.get("last4")
    snapshot["bank_name"] = name.strip()[:80] if isinstance(name, str) and name.strip() else None
    snapshot["last4"] = last4 if isinstance(last4, str) and _LAST4.fullmatch(last4) else None
    return snapshot


def _trace_fields(trace: Any) -> tuple[str | None, str | None]:
    """Stripe's bank trace: a value exists only while its status is supported."""
    if not isinstance(trace, dict):
        return None, None
    status = _closed(trace.get("status"), _TRACE_STATUSES)
    value = trace.get("value")
    if status != "supported" or not isinstance(value, str) or not _TRACE_VALUE.fullmatch(value):
        return status, None
    return status, value


def _payout_fields(
    remote: dict[str, Any], *, payout_id: str, livemode: bool, observed_at: datetime
) -> dict[str, Any]:
    status = remote.get("status")
    amount = remote.get("amount")
    arrival = remote.get("arrival_date")
    created = remote.get("created")
    failure_code = remote.get("failure_code")
    if (
        remote.get("id") != payout_id
        or remote.get("object") != "payout"
        or remote.get("livemode") is not livemode
        or status not in _PAYOUT_RANK
        or type(amount) is not int
        or amount <= 0
        or remote.get("currency") != "usd"
        or type(created) is not int
        or created < 0
        or (arrival is not None and (type(arrival) is not int or arrival < 0))
    ):
        raise ConnectBankPayoutError("provider_mismatch")
    try:
        created_at = datetime.fromtimestamp(created, UTC)
        arrival_at = datetime.fromtimestamp(arrival, UTC) if arrival is not None else None
    except (OverflowError, OSError, ValueError):
        raise ConnectBankPayoutError("provider_mismatch") from None
    # Display details are optional: an unknown shape stores nothing, never a guess.
    automatic = remote.get("automatic")
    trace_status, trace_value = _trace_fields(remote.get("trace_id"))
    return {
        "id": payout_id,
        "status": status,
        "rank": _PAYOUT_RANK[status],
        "amount": amount,
        "created": created_at,
        "arrival": arrival_at,
        "failure": failure_code
        if isinstance(failure_code, str) and _SAFE_FAILURE_CODE.fullmatch(failure_code)
        else None,
        "observed": observed_at,
        **_destination_fields(remote.get("destination")),
        # Stripe's ``payout_method`` is a v2 account ID; ``method`` is the speed.
        "method": _closed(remote.get("method"), _PAYOUT_METHODS),
        "automatic": automatic if type(automatic) is bool else None,
        "trace_status": trace_status,
        "trace_value": trace_value,
        "reconciliation": _closed(remote.get("reconciliation_status"), _RECONCILIATION_STATUSES),
    }


def _as_utc(value: datetime | str) -> datetime:
    parsed = datetime.fromisoformat(value) if isinstance(value, str) else value
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def _iso_datetime(value: datetime | str | None) -> str | None:
    # UTC whatever the database session's time zone, so one instant has one form.
    return None if value is None else _as_utc(value).isoformat()


def _encode_cursor(*, mode: str, created_at: datetime | str, payout_id: str) -> str:
    micros = (_as_utc(created_at) - _EPOCH) // timedelta(microseconds=1)
    body = json.dumps(
        {"id": payout_id, "m": mode, "t": micros, "v": 1}, separators=(",", ":"), sort_keys=True
    )
    return base64.urlsafe_b64encode(body.encode("ascii")).decode("ascii").rstrip("=")


def _decode_cursor(cursor: Any, *, mode: str) -> tuple[datetime, str]:
    """The (created_at, payout ID) position the next page starts after."""
    if not isinstance(cursor, str) or not 1 <= len(cursor) <= _MAX_CURSOR_LENGTH:
        raise ConnectBankPayoutError("invalid_cursor")
    try:
        body = json.loads(
            base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True)
        )
    except ValueError:
        raise ConnectBankPayoutError("invalid_cursor") from None
    if not isinstance(body, dict) or set(body) != {"id", "m", "t", "v"}:
        raise ConnectBankPayoutError("invalid_cursor")
    micros = body["t"]
    if (
        type(body["v"]) is not int
        or body["v"] != 1
        or body["m"] != mode
        or type(micros) is not int
        or not 0 <= micros <= _MAX_CURSOR_MICROS
        or not _valid_id(body["id"], "po_")
    ):
        raise ConnectBankPayoutError("invalid_cursor")
    return _EPOCH + timedelta(microseconds=micros), body["id"]


def _owner_payout(row: Any) -> dict[str, Any]:
    """One deposit for its owner: the masked bank only, never a provider account ID."""
    name, last4 = row["destination_bank_name"], row["destination_last4"]
    return {
        "id": row["stripe_payout_id"],
        "amountCents": row["amount_cents"],
        "status": row["status"],
        "expectedArrivalAt": _iso_datetime(row["expected_arrival_at"]),
        "failureCode": row["failure_code"],
        "createdAt": _iso_datetime(row["created_at"]),
        "paidAt": _iso_datetime(row["paid_at"]),
        "failedAt": _iso_datetime(row["failed_at"]),
        "bank": {"name": name, "last4": last4} if name is not None or last4 is not None else None,
        "bankReference": row["trace_value"] if row["trace_status"] == "supported" else None,
    }


class StripeConnectBankPayouts(ExternalConnectorLifecycleStore):
    def __init__(
        self, db: Any | None = None, *, stripe_api: Any = None, connect_mode: bool = False
    ) -> None:
        super().__init__(db)
        self.stripe_api = stripe_api or stripe
        self.connect_mode = connect_mode
        self.mode = configured_connect_mode() if connect_mode else configured_stripe_mode()

    def _configuration(self, *, webhook: bool = False) -> tuple[str, str, bool]:
        if not self.connect_mode:
            configured = _config()
            if ("live" if configured[2] else "test") != self.mode:
                raise ConnectBankPayoutError("payout_unavailable")
            return configured
        try:
            key, mode = connect_config()
        except ValueError:
            raise ConnectBankPayoutError("payout_unavailable") from None
        if mode != self.mode:
            raise ConnectBankPayoutError("payout_unavailable")
        # The sandbox endpoint has its own signature secret; the historic
        # endpoint retains live account and bank-deposit reconciliation.
        secret_name = (
            "STRIPE_CONNECT_TEST_WEBHOOK_SECRET"
            if mode == "test"
            else "STRIPE_CONNECT_WEBHOOK_SECRET"
        )
        secret = (os.getenv(secret_name) or "").strip()
        if webhook and (
            not secret.startswith("whsec_")
            or len(secret) < 20
            or secret == (os.getenv("STRIPE_WEBHOOK_SECRET") or "").strip()
        ):
            raise ConnectBankPayoutError("payout_unavailable")
        return key, secret, mode == "live"

    async def process_webhook(self, *, payload: bytes, signature: str | None) -> str:
        """Verify Stripe first, then reconcile its current connected-account state."""
        key, webhook_secret, livemode = self._configuration(webhook=True)
        if not signature or not payload or len(payload) > 128_000:
            raise ConnectBankPayoutError("invalid_event")
        try:
            event = _stripe_dict(
                await asyncio.to_thread(
                    self.stripe_api.Webhook.construct_event, payload, signature, webhook_secret
                )
            )
        except Exception:
            raise ConnectBankPayoutError("invalid_signature") from None
        event_type = event.get("type")
        if not isinstance(event_type, str) or event_type not in _EVENT_TYPES:
            return "ignored"
        event_id = event.get("id")
        account_id = event.get("account")
        data = event.get("data")
        obj = data.get("object") if isinstance(data, dict) else None
        account_event = event_type in _ACCOUNT_EVENT_TYPES
        balance_event = event_type == _BALANCE_EVENT_TYPE
        external_event = event_type.startswith("account.external_account.")
        object_type = obj.get("object") if isinstance(obj, dict) else None
        object_id = obj.get("id") if isinstance(obj, dict) else None
        expected_type = "account" if event_type == "account.updated" else "payout"
        if balance_event:
            # A Balance has no ID: it describes the event's connected account,
            # which therefore binds the event and stands in as its object.
            expected_type, object_id = "balance", account_id
        if external_event:
            # Bank changes have their own events, not a guaranteed account.updated.
            # A deleted external account cannot be fetched: retrieve its owner
            # Account and recompute current readiness instead of replaying a delta.
            if not isinstance(object_type, str) or object_type not in {"bank_account", "card"}:
                return "ignored"
            expected_type = object_type
        prefix = {
            "account": "acct_",
            "balance": "acct_",
            "payout": "po_",
            "bank_account": "ba_",
            "card": "card_",
        }[expected_type]
        if (
            not _valid_id(event_id, "evt_")
            or not _valid_id(account_id, "acct_")
            or not _valid_id(object_id, prefix)
            or not isinstance(obj, dict)
            or object_type != expected_type
            or (object_type == "account" and object_id != account_id)
            or (external_event and obj.get("account") is not None and obj["account"] != account_id)
            or type(event.get("livemode")) is not bool
        ):
            raise ConnectBankPayoutError("invalid_event")
        # Production Connect destinations can also receive sandbox events.
        # A different mode must never mutate this environment's ledger.
        if event["livemode"] is not livemode:
            return "ignored_mode"
        binding = await self._transaction(
            lambda c: self._event_binding(
                c, event_id, account_id, event_type, object_id, mode=self.mode
            )
        )
        if binding == "duplicate":
            return "duplicate"
        if binding is None:
            return "ignored_account"
        try:
            if balance_event:
                # The worker reads the authoritative balance; event amounts are not kept.
                snapshot: dict[str, Any] = {}
            elif account_event:
                remote = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.Account.retrieve, account_id, api_key=key
                    )
                )
                if remote.get("id") != account_id or remote.get("country") != "US":
                    raise ConnectBankPayoutError("provider_mismatch")
                # Stripe Account objects have no livemode field. The signed
                # event mode and environment-bound API key establish this
                # boundary; the retrieved mapped account establishes identity.
                snapshot = {
                    "details": remote.get("details_submitted") is True,
                    "payouts": remote.get("payouts_enabled") is True,
                    "ready": _account_readiness(remote)["ready"],
                }
            else:
                observed_at = datetime.now(UTC)
                remote = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.Payout.retrieve,
                        object_id,
                        stripe_account=account_id,
                        api_key=key,
                        expand=["destination"],
                    )
                )
                snapshot = _payout_fields(
                    remote, payout_id=object_id, livemode=livemode, observed_at=observed_at
                )
        except ConnectBankPayoutError:
            raise
        except Exception:
            raise ConnectBankPayoutError("provider_unavailable") from None
        result = await self._transaction(
            lambda c: self._apply(
                c,
                event_id=event_id,
                event_type=event_type,
                account_id=account_id,
                object_id=object_id,
                livemode=livemode,
                snapshot=snapshot,
                mode=self.mode,
            )
        )
        if account_event and result == "updated":
            owner = await self._transaction(
                lambda c: c.execute(
                    text(
                        "SELECT user_id FROM stripe_owner_payout_accounts WHERE stripe_account_id=:account AND stripe_mode=:stripe_mode"
                    ),
                    {"account": account_id, "stripe_mode": self.mode},
                ).scalar_one_or_none()
            )
            if owner:
                invalidate_payout_account_status(user_id=owner, mode=self.mode)
                await resume_document_owner_setup(self.db, owner)
        return result

    @staticmethod
    def _event_binding(
        connection: Any,
        event_id: str,
        account_id: str,
        event_type: str,
        object_id: str,
        *,
        mode: str | None = None,
    ) -> str | None:
        prior = (
            connection.execute(
                text("""SELECT stripe_account_id,event_type,stripe_object_id
              FROM stripe_connect_bank_payout_events WHERE stripe_event_id=:event"""),
                {"event": event_id},
            )
            .mappings()
            .first()
        )
        if prior is not None:
            if (
                prior["stripe_account_id"] != account_id
                or prior["event_type"] != event_type
                or prior["stripe_object_id"] != object_id
            ):
                raise ConnectBankPayoutError("provider_mismatch")
            return "duplicate"
        mapped = connection.execute(
            text("""SELECT 1 FROM stripe_owner_payout_accounts
              WHERE stripe_account_id=:account AND stripe_mode=:stripe_mode LIMIT 1"""),
            {"account": account_id, "stripe_mode": (mode or configured_stripe_mode())},
        ).first()
        return account_id if mapped is not None else None

    @staticmethod
    def _apply(
        connection: Any,
        *,
        event_id: str,
        event_type: str,
        account_id: str,
        object_id: str,
        livemode: bool,
        snapshot: dict[str, Any],
        mode: str | None = None,
    ) -> str:
        mapped = (
            connection.execute(
                text("""SELECT user_id FROM stripe_owner_payout_accounts
              WHERE stripe_account_id=:account AND stripe_mode=:stripe_mode LIMIT 1"""),
                {"account": account_id, "stripe_mode": (mode or configured_stripe_mode())},
            )
            .mappings()
            .first()
        )
        if mapped is None:
            return "ignored_account"
        # Every handled event, balance and reconciliation included, is recorded
        # once. Release replay of 298/304 widens the event CHECK and never
        # narrows it (db/migration_authority.py), so these rows stay valid.
        inserted = connection.execute(
            text("""INSERT INTO stripe_connect_bank_payout_events
              (stripe_event_id,stripe_account_id,event_type,stripe_object_id,livemode)
              VALUES (:event,:account,:type,:object,:livemode)
              ON CONFLICT (stripe_event_id) DO NOTHING"""),
            {
                "event": event_id,
                "account": account_id,
                "type": event_type,
                "object": object_id,
                "livemode": livemode,
            },
        )
        if inserted.rowcount == 0:
            return "duplicate"
        owner = mapped["user_id"]
        if event_type in _ACCOUNT_EVENT_TYPES:
            connection.execute(
                text("""UPDATE stripe_owner_payout_accounts
                  SET details_submitted=:details,payouts_enabled=:payouts,account_ready=:ready,
                  updated_at=CURRENT_TIMESTAMP WHERE stripe_account_id=:account AND stripe_mode=:stripe_mode"""),
                {
                    "details": snapshot["details"],
                    "payouts": snapshot["payouts"],
                    "ready": snapshot["ready"],
                    "account": account_id,
                    "stripe_mode": (mode or configured_stripe_mode()),
                },
            )
            StripeConnectBankPayouts._notify_owner(connection, owner, ("account",))
            return "updated"
        if event_type == _BALANCE_EVENT_TYPE:
            _balances().mark_balance_refresh_due(
                connection, stripe_account_id=account_id, livemode=livemode
            )
            StripeConnectBankPayouts._notify_owner(connection, owner, ("balance",))
            return "updated"
        if StripeConnectBankPayouts._store_payout(
            connection, account_id=account_id, livemode=livemode, snapshot=snapshot
        ):
            StripeConnectBankPayouts._notify_owner(connection, owner, ("bank_payouts",))
        if event_type in _RECONCILE_ON_EVENT_TYPES and StripeConnectBankPayouts._reconciled(
            connection, account_id=account_id, payout_id=snapshot["id"]
        ):
            _balances().enqueue_payout_reconciliation(
                connection, stripe_payout_id=snapshot["id"], stripe_account_id=account_id
            )
        return "updated"

    @staticmethod
    def _store_payout(
        connection: Any, *, account_id: str, livemode: bool, snapshot: dict[str, Any]
    ) -> bool:
        """Apply one provider read of a payout; report whether the stored row changed.

        A higher status rank always applies: a payout can fail after Stripe has
        reported it paid. A same-rank read applies only when it was taken after
        the stored one and adds or corrects provider detail, such as a moved
        arrival date or a bank trace. The status never moves backwards, status
        times move only when the rank rises, and the destination is write-once.
        """
        result = connection.execute(
            text(_STORE_PAYOUT_SQL),
            {
                "id": snapshot["id"],
                "account": account_id,
                "livemode": livemode,
                "amount": snapshot["amount"],
                "created": snapshot["created"],
                "status": snapshot["status"],
                "rank": snapshot["rank"],
                "arrival": snapshot["arrival"],
                "failure": snapshot["failure"],
                "observed": snapshot["observed"],
                "destination_id": snapshot["destination_id"],
                "destination_kind": snapshot["destination_kind"],
                "bank_name": snapshot["bank_name"],
                "last4": snapshot["last4"],
                "method": snapshot["method"],
                "automatic": snapshot["automatic"],
                "trace_status": snapshot["trace_status"],
                "trace_value": snapshot["trace_value"],
                "reconciliation": snapshot["reconciliation"],
            },
        )
        if result.rowcount == 1:
            return True
        current = (
            connection.execute(
                text("""SELECT stripe_account_id,livemode,amount_cents,currency,status_rank
                  FROM stripe_connect_bank_payouts WHERE stripe_payout_id=:id"""),
                {"id": snapshot["id"]},
            )
            .mappings()
            .first()
        )
        if (
            current is None
            or current["stripe_account_id"] != account_id
            or bool(current["livemode"]) is not livemode
            or current["amount_cents"] != snapshot["amount"]
            or current["currency"] != "usd"
            or current["status_rank"] < snapshot["rank"]
        ):
            raise ConnectBankPayoutError("provider_mismatch")
        return False

    @staticmethod
    def _reconciled(connection: Any, *, account_id: str, payout_id: str) -> bool:
        """Whether Stripe has reported this payout's balance transactions as final."""
        status = connection.execute(
            text("""SELECT reconciliation_status FROM stripe_connect_bank_payouts
              WHERE stripe_payout_id=:id AND stripe_account_id=:account"""),
            {"id": payout_id, "account": account_id},
        ).scalar_one_or_none()
        return status == "completed"

    @staticmethod
    def _claim_due_scan(
        connection: Any, *, mode: str, due_before: datetime, started_at: datetime
    ) -> dict[str, Any] | None:
        row = (
            connection.execute(
                text("""UPDATE stripe_owner_payout_accounts
                  SET bank_payout_scan_started_at=:started_at
                  WHERE stripe_mode=:stripe_mode
                    AND stripe_account_id=(
                      SELECT stripe_account_id FROM stripe_owner_payout_accounts
                      WHERE stripe_mode=:stripe_mode
                        AND (bank_payout_scan_started_at IS NULL
                          OR bank_payout_scan_started_at<:due_before)
                      ORDER BY bank_payout_scan_started_at ASC,stripe_account_id ASC
                      LIMIT 1)
                    AND (bank_payout_scan_started_at IS NULL
                      OR bank_payout_scan_started_at<:due_before)
                  RETURNING user_id,stripe_account_id,bank_payout_scan_cursor"""),
                {
                    "stripe_mode": mode,
                    "due_before": due_before,
                    "started_at": started_at,
                },
            )
            .mappings()
            .first()
        )
        return dict(row) if row is not None else None

    @staticmethod
    def _store_scan_page(
        connection: Any,
        *,
        owner_id: str,
        account_id: str,
        mode: str,
        livemode: bool,
        started_at: datetime,
        snapshots: list[dict[str, Any]],
        next_cursor: str | None,
    ) -> int:
        # Take the mapped account's row lock before ledger writes. Deletion,
        # reassignment, and a newer worker claim must win or wait atomically.
        updated = connection.execute(
            text("""UPDATE stripe_owner_payout_accounts SET bank_payout_scan_cursor=:cursor
              WHERE user_id=:owner AND stripe_account_id=:account AND stripe_mode=:stripe_mode
                AND bank_payout_scan_started_at=:started_at"""),
            {
                "cursor": next_cursor,
                "owner": owner_id,
                "account": account_id,
                "stripe_mode": mode,
                "started_at": started_at,
            },
        )
        if updated.rowcount != 1:
            return 0
        changed = sum(
            StripeConnectBankPayouts._store_payout(
                connection, account_id=account_id, livemode=livemode, snapshot=snapshot
            )
            for snapshot in snapshots
        )
        if changed:
            StripeConnectBankPayouts._notify_owner(connection, owner_id, ("bank_payouts",))
        return changed

    async def reconcile_due(
        self, *, max_accounts: int = 1, max_payouts_per_account: int = 100
    ) -> dict[str, int]:
        """Poll bounded Connect payout pages off the owner-facing request path.

        A durable, mode-scoped cursor recovers creations as well as status
        changes missed by webhooks. The claim timestamp is a five-minute lease;
        provider I/O always runs outside the database transaction.
        """
        if (
            type(max_accounts) is not int
            or not 1 <= max_accounts <= 4
            or type(max_payouts_per_account) is not int
            or not 1 <= max_payouts_per_account <= 100
        ):
            raise ValueError("invalid bank payout reconciliation bounds")
        key, _, livemode = self._configuration()
        outcomes = {
            "bank_accounts_checked": 0,
            "bank_payouts_changed": 0,
            "bank_provider_deferred": 0,
        }
        for _ in range(max_accounts):
            started_at = datetime.now(UTC)
            claim = await self._transaction(
                lambda c, started_at=started_at: self._claim_due_scan(
                    c,
                    mode=self.mode,
                    due_before=started_at - _SCAN_INTERVAL,
                    started_at=started_at,
                )
            )
            if claim is None:
                break
            account_id = claim["stripe_account_id"]
            cursor = claim["bank_payout_scan_cursor"]
            if not _valid_id(account_id, "acct_") or (
                cursor is not None and not _valid_id(cursor, "po_")
            ):
                raise ConnectBankPayoutError("provider_mismatch")
            try:
                options: dict[str, Any] = {
                    "limit": max_payouts_per_account,
                    "stripe_account": account_id,
                    "api_key": key,
                    "max_network_retries": 0,
                    "expand": ["data.destination"],
                }
                if cursor is not None:
                    options["starting_after"] = cursor
                observed_at = datetime.now(UTC)
                page = _stripe_dict(
                    await asyncio.wait_for(
                        asyncio.to_thread(self.stripe_api.Payout.list, **options),
                        timeout=_PROVIDER_READ_TIMEOUT_SECONDS,
                    )
                )
            except Exception:
                outcomes["bank_provider_deferred"] += 1
                break
            data = page.get("data") if isinstance(page, dict) else None
            has_more = page.get("has_more") if isinstance(page, dict) else None
            if (
                not isinstance(page, dict)
                or page.get("object") != "list"
                or not isinstance(data, list)
                or type(has_more) is not bool
                or len(data) > max_payouts_per_account
                or (has_more and not data)
            ):
                raise ConnectBankPayoutError("provider_mismatch")
            snapshots = []
            seen = set()
            for item in data:
                remote = _stripe_dict(item)
                payout_id = remote.get("id") if isinstance(remote, dict) else None
                if not _valid_id(payout_id, "po_") or payout_id in seen:
                    raise ConnectBankPayoutError("provider_mismatch")
                seen.add(payout_id)
                snapshots.append(
                    _payout_fields(
                        remote, payout_id=payout_id, livemode=livemode, observed_at=observed_at
                    )
                )
            next_cursor = snapshots[-1]["id"] if has_more else None
            changed = await self._transaction(
                lambda c, claim=claim, account_id=account_id, started_at=started_at, snapshots=snapshots, next_cursor=next_cursor: (
                    self._store_scan_page(
                        c,
                        owner_id=claim["user_id"],
                        account_id=account_id,
                        mode=self.mode,
                        livemode=livemode,
                        started_at=started_at,
                        snapshots=snapshots,
                        next_cursor=next_cursor,
                    )
                )
            )
            outcomes["bank_accounts_checked"] += 1
            outcomes["bank_payouts_changed"] += changed
        return outcomes

    @staticmethod
    def _notify_owner(connection: Any, user_id: str, kinds: Sequence[str]) -> None:
        """Commit the owner's payout doorbell atomically with the payout state.

        PostgreSQL delivers NOTIFY only after the enclosing transaction commits.
        The payload names an owner and the payout kinds that changed, never a
        bank account, amount or document request. Readers refetch those kinds.
        """
        if not isinstance(user_id, str) or not user_id:
            raise ConnectBankPayoutError("invalid_owner")
        try:
            notify_payout_changed(connection, user_id, kinds)
        except PayoutDoorbellError:
            raise ConnectBankPayoutError("invalid_owner") from None

    async def owner_summary(self, *, user_id: str, cursor: str | None = None) -> dict[str, Any]:
        """One page of the owner's bank deposits, newest first.

        A page holds at most 20 deposits. ``nextCursor`` is an opaque position
        after the page's last deposit; a malformed cursor or one from another
        Stripe mode is refused as ``invalid_cursor``.
        """
        if not isinstance(user_id, str) or not user_id:
            raise ConnectBankPayoutError("invalid_owner")
        position = None if cursor is None else _decode_cursor(cursor, mode=self.mode)
        # This is an owner- and mode-bound local ledger read. Provider keys
        # and webhook signing secrets are required only for provider operations.
        livemode = self.mode == "live"

        def read(connection: Any) -> dict[str, Any]:
            account = (
                connection.execute(
                    text("""SELECT stripe_account_id FROM stripe_owner_payout_accounts
                  WHERE user_id=:owner AND stripe_mode=:stripe_mode LIMIT 1"""),
                    {"owner": user_id, "stripe_mode": self.mode},
                )
                .mappings()
                .first()
            )
            if account is None:
                return {
                    "currency": "USD",
                    "stripeMode": self.mode,
                    "payouts": [],
                    "nextCursor": None,
                }
            params: dict[str, Any] = {
                "account": account["stripe_account_id"],
                "livemode": livemode,
                "limit": _OWNER_PAGE_SIZE + 1,
            }
            if position is None:
                statement = _OWNER_PAYOUTS_SQL
            else:
                statement = _OWNER_PAYOUTS_AFTER_SQL
                params["before_at"], params["before_id"] = position
            rows = connection.execute(text(statement), params).mappings().all()
            page = rows[:_OWNER_PAGE_SIZE]
            last = page[-1] if len(rows) > _OWNER_PAGE_SIZE else None
            return {
                "currency": "USD",
                "stripeMode": self.mode,
                "payouts": [_owner_payout(row) for row in page],
                "nextCursor": None
                if last is None
                else _encode_cursor(
                    mode=self.mode,
                    created_at=last["created_at"],
                    payout_id=last["stripe_payout_id"],
                ),
            }

        return await self._transaction(read)
