"""Explicit sandbox redemption: test Stripe transfers never spend real earnings."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import stripe

from hushh_mcp.services.pkm_packet_order_service import _stripe_dict
from hushh_mcp.services.pkm_payout_service import PkmPayoutService, _account_readiness
from hushh_mcp.services.stripe_mode import (
    configured_connect_mode,
    connect_config,
    stripe_environment,
)

logger = logging.getLogger(__name__)


class HashcoinRedemptionError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 409) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _public(row: dict[str, Any]) -> dict[str, Any]:
    result = {
        key: row.get(key)
        for key in (
            "id",
            "clientRequestId",
            "status",
            "amountCoins",
            "stripeMode",
            "stripeTransferId",
            "createdAt",
        )
    }
    if result["status"] in {"reserved", "dispatching"}:
        result["status"] = "pending"
    return result


def _transfer_matches(remote: dict[str, Any], row: dict[str, Any]) -> bool:
    destination = remote.get("destination")
    if isinstance(destination, dict):
        destination = destination.get("id")
    metadata = remote.get("metadata")
    reversed_amount = remote.get("amount_reversed", 0)
    return bool(
        isinstance(metadata, dict)
        and type(reversed_amount) is int
        and isinstance(remote.get("id"), str)
        and remote["id"].startswith("tr_")
        and remote.get("livemode") is False
        and remote.get("currency") == "usd"
        and type(remote.get("amount")) is int
        and remote["amount"] == row["amountCoins"]
        and destination == row["accountId"]
        and remote.get("transfer_group") == f"hashcoin-{row['id']}"
        and metadata.get("hashcoin_redemption_id") == row["id"]
        and remote.get("reversed") is not True
        and reversed_amount == 0
    )


class HashcoinRedemptionService:
    def __init__(self, *, wallet: Any = None, stripe_api: Any = None, accounts: Any = None) -> None:
        self._wallet = wallet
        self.stripe_api = stripe_api or stripe
        self._accounts = accounts

    @property
    def wallet(self):
        if self._wallet is None:
            from hushh_mcp.services.hashcoin_wallet_service import HashcoinWalletService

            self._wallet = HashcoinWalletService()
        return self._wallet

    async def summary(self, *, user_id: str) -> dict[str, Any]:
        snapshot = await self.wallet.summary(user_id=user_id)
        pending = await self.wallet.list_pending_redemptions(user_id=user_id, max_items=10)
        history = await self.wallet.list_redemptions(user_id=user_id, max_items=10)
        return {
            **snapshot,
            "payoutMode": configured_connect_mode(),
            "liveRedemptionEnabled": False,
            "testPayouts": configured_connect_mode() == "test",
            "latestRedemption": _public(pending[0]) if pending else None,
            "redemptionHistory": [_public(row) for row in history],
        }

    async def redeem(
        self, *, user_id: str, amount_coins: int, client_request_id: str, mode: str
    ) -> dict[str, Any]:
        if mode != "test" or configured_connect_mode() != "test":
            raise HashcoinRedemptionError(
                "LIVE_REDEMPTION_DISABLED", "Real bank withdrawals are not available yet."
            )
        if type(amount_coins) is not int or not 1 <= amount_coins <= 50_000:
            raise HashcoinRedemptionError("INVALID_AMOUNT", "Enter a valid coin amount.", 422)
        try:
            request_key = str(UUID(client_request_id))
            key, key_mode = connect_config()
        except (ValueError, TypeError):
            raise HashcoinRedemptionError(
                "PAYOUT_UNAVAILABLE", "Test payouts are unavailable.", 503
            ) from None
        if key_mode != "test":
            raise HashcoinRedemptionError(
                "PAYOUT_UNAVAILABLE", "Test payouts are unavailable.", 503
            )
        row = await self.wallet.get_redemption(user_id=user_id, request_key=request_key)
        if row is not None:
            if row["amountCoins"] != amount_coins or row["stripeMode"] != "test":
                raise HashcoinRedemptionError(
                    "REDEMPTION_CONFLICT", "Use the original redemption amount."
                )
            if row["status"] in {"succeeded", "failed"}:
                return _public(row)
        else:
            accounts = self._accounts or PkmPayoutService(
                stripe_api=self.stripe_api, mode="test", api_key=key
            )
            account = await accounts.refresh_account(user_id)
            if not account or not account.get("readiness", {}).get("ready"):
                raise HashcoinRedemptionError(
                    "PAYOUT_ACCOUNT_REQUIRED", "Link your test bank first."
                )
            try:
                balance = _stripe_dict(
                    await asyncio.to_thread(self.stripe_api.Balance.retrieve, api_key=key)
                )
                available = sum(
                    item["amount"]
                    for item in balance.get("available", [])
                    if isinstance(item, dict)
                    and item.get("currency") == "usd"
                    and type(item.get("amount")) is int
                )
                if balance.get("livemode") is not False or available < amount_coins:
                    raise HashcoinRedemptionError(
                        "SANDBOX_FUNDS_UNAVAILABLE",
                        "Test payout funds are unavailable. Try later.",
                        503,
                    )
            except HashcoinRedemptionError:
                raise
            except Exception:
                raise HashcoinRedemptionError(
                    "PAYOUT_UNAVAILABLE", "Couldn't check test funds. Try again.", 503
                ) from None
            row = await self.wallet.reserve_redemption(
                user_id=user_id,
                amount_coins=amount_coins,
                request_key=request_key,
                stripe_mode="test",
                destination_account_id=account["stripe_account_id"],
            )
        claimed = await self.wallet.claim_redemption(user_id=user_id, redemption_id=row["id"])
        if claimed is None:
            current = await self.wallet.get_redemption(user_id=user_id, request_key=request_key)
            return _public(current or row)
        return await self._dispatch(claimed, key=key)

    async def reconcile_due(self, *, max_items: int = 4) -> dict[str, int]:
        if configured_connect_mode() != "test":
            return {"disabled": 1}
        rows = await self.wallet.list_reconcilable_redemptions(max_items=max_items)
        counts: dict[str, int] = {}
        for row in rows:
            try:
                result = await self.redeem(
                    user_id=row["userId"],
                    amount_coins=row["amountCoins"],
                    client_request_id=row["clientRequestId"],
                    mode="test",
                )
                outcome = result["status"]
            except Exception as exc:
                logger.warning("hashcoin.reconcile_deferred type=%s", type(exc).__name__)
                outcome = "deferred"
            counts[outcome] = counts.get(outcome, 0) + 1
        return counts

    async def _finish(
        self, row: dict[str, Any], outcome: str, transfer_id: str | None = None
    ) -> dict[str, Any]:
        result = await self.wallet.finish_redemption(
            redemption_id=row["id"],
            attempt_id=row["attemptId"],
            stripe_transfer_id=transfer_id,
            outcome=outcome,
        )
        return _public(result)

    async def _dispatch(self, row: dict[str, Any], *, key: str) -> dict[str, Any]:
        """Retry only within Stripe's idempotency retention; unknown stays reserved."""
        group = f"hashcoin-{row['id']}"
        try:
            existing = _stripe_dict(
                await asyncio.to_thread(
                    self.stripe_api.Transfer.list,
                    api_key=key,
                    transfer_group=group,
                    destination=row["accountId"],
                    limit=2,
                )
            )
            matches = existing.get("data")
            if not isinstance(matches, list) or existing.get("has_more") or len(matches) > 1:
                return await self._finish(row, "unknown")
            if matches:
                remote = _stripe_dict(matches[0])
                if not _transfer_matches(remote, row):
                    return await self._finish(row, "unknown")
                return await self._finish(row, "succeeded", remote["id"])
            if row.get("createAllowed") is not True:
                return await self._finish(row, "unknown")
            first = row.get("firstDispatchAt")
            started = (
                datetime.fromisoformat(first.replace("Z", "+00:00"))
                if isinstance(first, str)
                else first
            )
            if started is not None and datetime.now(UTC) - started > timedelta(hours=22):
                return await self._finish(row, "unknown")
        except Exception:
            return await self._finish(row, "unknown")
        try:
            account = _stripe_dict(
                await asyncio.to_thread(
                    self.stripe_api.Account.retrieve,
                    row["accountId"],
                    api_key=key,
                )
            )
            if account.get("id") != row["accountId"] or not _account_readiness(account)["ready"]:
                return await self._finish(row, "unknown")
        except Exception:
            return await self._finish(row, "unknown")
        try:
            remote = _stripe_dict(
                await asyncio.to_thread(
                    self.stripe_api.Transfer.create,
                    api_key=key,
                    idempotency_key=f"hashcoin-redeem:{stripe_environment()}:test:{row['id']}",
                    amount=row["amountCoins"],
                    currency="usd",
                    destination=row["accountId"],
                    transfer_group=group,
                    metadata={
                        "payment_kind": "hashcoin_sandbox_redemption",
                        "hashcoin_redemption_id": row["id"],
                    },
                )
            )
        except stripe.InvalidRequestError as exc:
            # A persisted unknown outcome must not be released based on a later
            # error: an earlier transfer could already have been accepted.
            definite = (
                row.get("previousStatus") == "reserved"
                and getattr(exc, "code", None) != "idempotency_key_in_use"
            )
            return await self._finish(row, "failed" if definite else "unknown")
        except Exception as exc:
            logger.warning("hashcoin.transfer_unknown type=%s", type(exc).__name__)
            return await self._finish(row, "unknown")
        if not _transfer_matches(remote, row):
            return await self._finish(row, "unknown")
        return await self._finish(row, "succeeded", remote["id"])
