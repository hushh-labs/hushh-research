"""Connected-account bank payout state, separate from document earnings.

A document earning is settled by a Stripe Transfer into an owner's connected
balance. Stripe can combine many such earnings in one later bank Payout. This
store therefore reports Payout objects per owner and never attributes a bank
deposit to an individual document request.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import UTC, datetime, timedelta
from typing import Any

import stripe
from sqlalchemy import text

from hushh_mcp.services.drive_request_payment_service import _config as payment_config
from hushh_mcp.services.drive_request_payment_service import _stripe_dict
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore
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
_EVENT_TYPES = _ACCOUNT_EVENT_TYPES | {
    "payout.created",
    "payout.updated",
    "payout.paid",
    "payout.failed",
    "payout.canceled",
}
_PAYOUT_RANK = {"pending": 0, "in_transit": 1, "paid": 2, "canceled": 3, "failed": 4}
_PROVIDER_ID = re.compile(r"^[A-Za-z0-9_]{4,255}$")
_SAFE_FAILURE_CODE = re.compile(r"^[a-z0-9_]{1,64}$")
_SCAN_INTERVAL = timedelta(minutes=5)
_PROVIDER_READ_TIMEOUT_SECONDS = 8


class ConnectBankPayoutError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _valid_id(value: Any, prefix: str) -> bool:
    return (
        isinstance(value, str) and value.startswith(prefix) and bool(_PROVIDER_ID.fullmatch(value))
    )


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


def _payout_fields(remote: dict[str, Any], *, payout_id: str, livemode: bool) -> dict[str, Any]:
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
    }


def _iso_datetime(value: datetime | str | None) -> str | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value) if isinstance(value, str) else value
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.isoformat()


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
        object_id = obj.get("id") if isinstance(obj, dict) else None
        account_event = event_type in _ACCOUNT_EVENT_TYPES
        external_event = event_type.startswith("account.external_account.")
        object_type = obj.get("object") if isinstance(obj, dict) else None
        expected_type = "account" if event_type == "account.updated" else "payout"
        if external_event:
            # Bank changes have their own events, not a guaranteed account.updated.
            # A deleted external account cannot be fetched: retrieve its owner
            # Account and recompute current readiness instead of replaying a delta.
            if not isinstance(object_type, str) or object_type not in {"bank_account", "card"}:
                return "ignored"
            expected_type = object_type
        prefix = {"account": "acct_", "payout": "po_", "bank_account": "ba_", "card": "card_"}[
            expected_type
        ]
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
            if account_event:
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
                remote = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.Payout.retrieve,
                        object_id,
                        stripe_account=account_id,
                        api_key=key,
                    )
                )
                snapshot = _payout_fields(remote, payout_id=object_id, livemode=livemode)
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
            StripeConnectBankPayouts._notify_owner(connection, mapped["user_id"])
            return "updated"
        StripeConnectBankPayouts._store_payout(
            connection, account_id=account_id, livemode=livemode, snapshot=snapshot
        )
        StripeConnectBankPayouts._notify_owner(connection, mapped["user_id"])
        return "updated"

    @staticmethod
    def _store_payout(
        connection: Any, *, account_id: str, livemode: bool, snapshot: dict[str, Any]
    ) -> bool:
        """Apply a provider snapshot only if its status is newer than our ledger.

        A payout can become failed after Stripe has reported it paid. Equal-rank
        snapshots have no provider update timestamp, so they cannot safely
        replace later metadata from another webhook or scan.
        """
        result = connection.execute(
            text("""INSERT INTO stripe_connect_bank_payouts
              (stripe_payout_id,stripe_account_id,livemode,amount_cents,currency,
               status,status_rank,expected_arrival_at,failure_code,created_at)
              VALUES (:id,:account,:livemode,:amount,'usd',:status,:rank,:arrival,:failure,:created)
              ON CONFLICT (stripe_payout_id) DO UPDATE SET
                status=excluded.status,
                status_rank=excluded.status_rank,
                expected_arrival_at=excluded.expected_arrival_at,
                failure_code=excluded.failure_code,
                updated_at=CURRENT_TIMESTAMP
              WHERE stripe_connect_bank_payouts.stripe_account_id=excluded.stripe_account_id
                AND stripe_connect_bank_payouts.livemode=excluded.livemode
                AND stripe_connect_bank_payouts.amount_cents=excluded.amount_cents
                AND stripe_connect_bank_payouts.currency=excluded.currency
                AND stripe_connect_bank_payouts.status_rank<excluded.status_rank"""),
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
            StripeConnectBankPayouts._notify_owner(connection, owner_id)
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
                }
                if cursor is not None:
                    options["starting_after"] = cursor
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
                snapshots.append(_payout_fields(remote, payout_id=payout_id, livemode=livemode))
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
    def _notify_owner(connection: Any, user_id: str) -> None:
        """Commit the owner's SSE doorbell atomically with the payout state.

        PostgreSQL delivers NOTIFY only after the enclosing transaction commits.
        The payload identifies an owner and state type, never a bank account or
        document request. Authenticated readers fetch the current snapshot.
        """
        if not isinstance(user_id, str) or not user_id:
            raise ConnectBankPayoutError("invalid_owner")
        payload = json.dumps(
            {"type": "bank_payout_changed", "user_id": user_id},
            separators=(",", ":"),
            ensure_ascii=False,
        )
        if len(payload.encode("utf-8")) > 7_500:
            raise ConnectBankPayoutError("invalid_owner")
        connection.execute(
            text("SELECT pg_notify('one_user_state_changed', :payload)"),
            {"payload": payload},
        )

    async def owner_summary(self, *, user_id: str) -> dict[str, Any]:
        if not isinstance(user_id, str) or not user_id:
            raise ConnectBankPayoutError("invalid_owner")
        _, _, livemode = self._configuration()

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
                return {"currency": "USD", "stripeMode": self.mode, "payouts": []}
            rows = (
                connection.execute(
                    text("""SELECT stripe_payout_id,amount_cents,status,expected_arrival_at,
                  failure_code,created_at FROM stripe_connect_bank_payouts
                  WHERE stripe_account_id=:account AND livemode=:livemode
                  ORDER BY created_at DESC,stripe_payout_id DESC LIMIT 20"""),
                    {"account": account["stripe_account_id"], "livemode": livemode},
                )
                .mappings()
                .all()
            )
            return {
                "currency": "USD",
                "stripeMode": self.mode,
                "payouts": [
                    {
                        "id": row["stripe_payout_id"],
                        "amountCents": row["amount_cents"],
                        "status": row["status"],
                        "expectedArrivalAt": _iso_datetime(row["expected_arrival_at"]),
                        "failureCode": row["failure_code"],
                    }
                    for row in rows
                ],
            }

        return await self._transaction(read)
