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
from datetime import UTC, datetime
from typing import Any

import stripe
from sqlalchemy import text

from hushh_mcp.services.drive_request_payment_service import _config as payment_config
from hushh_mcp.services.drive_request_payment_service import _stripe_dict
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore
from hushh_mcp.services.pkm_payout_service import _account_readiness, resume_document_owner_setup
from hushh_mcp.services.stripe_mode import configured_stripe_mode

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
}
_PAYOUT_RANK = {"pending": 0, "in_transit": 1, "paid": 2, "canceled": 3, "failed": 4}
_PROVIDER_ID = re.compile(r"^[A-Za-z0-9_]{4,255}$")
_SAFE_FAILURE_CODE = re.compile(r"^[a-z0-9_]{1,64}$")


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
    failure_code = remote.get("failure_code")
    if (
        remote.get("id") != payout_id
        or remote.get("object") != "payout"
        or remote.get("livemode") is not livemode
        or status not in _PAYOUT_RANK
        or type(amount) is not int
        or amount <= 0
        or remote.get("currency") != "usd"
        or (arrival is not None and (type(arrival) is not int or arrival < 0))
    ):
        raise ConnectBankPayoutError("provider_mismatch")
    return {
        "id": payout_id,
        "status": status,
        "rank": _PAYOUT_RANK[status],
        "amount": amount,
        "arrival": datetime.fromtimestamp(arrival, UTC) if arrival is not None else None,
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
    def __init__(self, db: Any | None = None, *, stripe_api: Any = None) -> None:
        super().__init__(db)
        self.stripe_api = stripe_api or stripe

    async def process_webhook(self, *, payload: bytes, signature: str | None) -> str:
        """Verify Stripe first, then reconcile its current connected-account state."""
        key, webhook_secret, livemode = _config()
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
            lambda c: self._event_binding(c, event_id, account_id, event_type, object_id)
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
            )
        )
        if account_event and result == "updated":
            owner = await self._transaction(
                lambda c: c.execute(
                    text(
                        "SELECT user_id FROM stripe_owner_payout_accounts WHERE stripe_account_id=:account AND stripe_mode=:stripe_mode"
                    ),
                    {"account": account_id, "stripe_mode": configured_stripe_mode()},
                ).scalar_one_or_none()
            )
            if owner:
                await resume_document_owner_setup(self.db, owner)
        return result

    @staticmethod
    def _event_binding(
        connection: Any, event_id: str, account_id: str, event_type: str, object_id: str
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
            {"account": account_id, "stripe_mode": configured_stripe_mode()},
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
    ) -> str:
        mapped = (
            connection.execute(
                text("""SELECT user_id FROM stripe_owner_payout_accounts
              WHERE stripe_account_id=:account AND stripe_mode=:stripe_mode LIMIT 1"""),
                {"account": account_id, "stripe_mode": configured_stripe_mode()},
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
                    "stripe_mode": configured_stripe_mode(),
                },
            )
            StripeConnectBankPayouts._notify_owner(connection, mapped["user_id"])
            return "updated"
        result = connection.execute(
            text("""INSERT INTO stripe_connect_bank_payouts
              (stripe_payout_id,stripe_account_id,livemode,amount_cents,currency,
               status,status_rank,expected_arrival_at,failure_code)
              VALUES (:id,:account,:livemode,:amount,'usd',:status,:rank,:arrival,:failure)
              ON CONFLICT (stripe_payout_id) DO UPDATE SET
                status=CASE WHEN excluded.status_rank >= stripe_connect_bank_payouts.status_rank
                  THEN excluded.status ELSE stripe_connect_bank_payouts.status END,
                status_rank=CASE WHEN excluded.status_rank >= stripe_connect_bank_payouts.status_rank
                  THEN excluded.status_rank ELSE stripe_connect_bank_payouts.status_rank END,
                expected_arrival_at=CASE WHEN excluded.status_rank >= stripe_connect_bank_payouts.status_rank
                  THEN excluded.expected_arrival_at ELSE stripe_connect_bank_payouts.expected_arrival_at END,
                failure_code=CASE WHEN excluded.status_rank >= stripe_connect_bank_payouts.status_rank
                  THEN excluded.failure_code ELSE stripe_connect_bank_payouts.failure_code END,
                updated_at=CURRENT_TIMESTAMP
              WHERE stripe_connect_bank_payouts.stripe_account_id=excluded.stripe_account_id
                AND stripe_connect_bank_payouts.livemode=excluded.livemode
                AND stripe_connect_bank_payouts.amount_cents=excluded.amount_cents
                AND stripe_connect_bank_payouts.currency=excluded.currency"""),
            {
                "id": snapshot["id"],
                "account": account_id,
                "livemode": livemode,
                "amount": snapshot["amount"],
                "status": snapshot["status"],
                "rank": snapshot["rank"],
                "arrival": snapshot["arrival"],
                "failure": snapshot["failure"],
            },
        )
        if result.rowcount != 1:
            raise ConnectBankPayoutError("provider_mismatch")
        StripeConnectBankPayouts._notify_owner(connection, mapped["user_id"])
        return "updated"

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
        _, _, livemode = _config()

        def read(connection: Any) -> dict[str, Any]:
            account = (
                connection.execute(
                    text("""SELECT stripe_account_id FROM stripe_owner_payout_accounts
                  WHERE user_id=:owner AND stripe_mode=:stripe_mode LIMIT 1"""),
                    {"owner": user_id, "stripe_mode": configured_stripe_mode()},
                )
                .mappings()
                .first()
            )
            if account is None:
                return {"currency": "USD", "payouts": []}
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
