"""Mode-bound Stripe transfers discharge only the matching coin liability."""

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
    live_hashcoin_platform_key_configured,
    live_hashcoin_redemption_enabled,
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
    if row.get("stripeMode") == "live":
        reversal_status = row.get("reversalStatus", "none")
        result["reversalStatus"] = (
            "manual_review"
            if reversal_status == "none" and row.get("providerReviewReason")
            else reversal_status
        )
    if result["status"] in {"reserved", "dispatching"}:
        result["status"] = "pending"
    return result


def _transfer_matches(
    remote: dict[str, Any], row: dict[str, Any], *, allow_reversed: bool = False
) -> bool:
    mode = row.get("stripeMode")
    if mode not in {"test", "live"}:
        return False
    destination = remote.get("destination")
    if isinstance(destination, dict):
        destination = destination.get("id")
    metadata = remote.get("metadata")
    reversed_amount = remote.get("amount_reversed", 0)
    source_transaction = remote.get("source_transaction")
    if isinstance(source_transaction, dict):
        source_transaction = source_transaction.get("id")
    source_request = row.get("sourceRequestId")
    group = (
        f"drive-request-{source_request}"
        if mode == "live" and source_request
        else f"hashcoin-{row['id']}"
    )
    return bool(
        isinstance(metadata, dict)
        and type(reversed_amount) is int
        and isinstance(remote.get("id"), str)
        and remote["id"].startswith("tr_")
        and remote.get("livemode") is (mode == "live")
        and remote.get("currency") == "usd"
        and type(remote.get("amount")) is int
        and remote["amount"] == row["amountCoins"]
        and destination == row["accountId"]
        and remote.get("transfer_group") == group
        and source_transaction == (row.get("sourceChargeId") if mode == "live" else None)
        and metadata.get("payment_kind")
        == ("hashcoin_live_redemption" if mode == "live" else "hashcoin_sandbox_redemption")
        and metadata.get("hashcoin_redemption_id") == row["id"]
        and 0 <= reversed_amount <= row["amountCoins"]
        and (allow_reversed or (remote.get("reversed") is not True and reversed_amount == 0))
    )


def _live_source_matches(charge: dict[str, Any], intent: dict[str, Any], row: dict) -> bool:
    latest_charge = intent.get("latest_charge")
    if isinstance(latest_charge, dict):
        latest_charge = latest_charge.get("id")
    return bool(
        charge.get("id") == row.get("sourceChargeId")
        and charge.get("payment_intent") == row.get("sourcePaymentIntentId")
        and charge.get("amount") == row.get("sourceGrossCents")
        and charge.get("amount_refunded") == row.get("sourceRefundCents")
        and charge.get("currency") == "usd"
        and charge.get("livemode") is True
        and charge.get("paid") is True
        and charge.get("captured") is True
        and charge.get("disputed") is False
        and intent.get("id") == row.get("sourcePaymentIntentId")
        and latest_charge == row.get("sourceChargeId")
        and intent.get("status") == "succeeded"
        and intent.get("livemode") is True
    )


def _reversal_matches(remote: dict[str, Any], row: dict[str, Any]) -> bool:
    transfer = remote.get("transfer")
    if isinstance(transfer, dict):
        transfer = transfer.get("id")
    return bool(
        isinstance(remote.get("id"), str)
        and remote["id"].startswith("trr_")
        and transfer == row["stripeTransferId"]
        and type(remote.get("amount")) is int
        and remote["amount"] == row["amountCoins"]
        and remote.get("currency") == "usd"
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
        mode = configured_connect_mode()
        pending = await self.wallet.list_pending_redemptions(
            user_id=user_id, max_items=10, stripe_mode=mode
        )
        history = await self.wallet.list_redemptions(
            user_id=user_id, max_items=10, stripe_mode=mode
        )
        return {
            **snapshot,
            "payoutMode": mode,
            "liveRedemptionEnabled": live_hashcoin_redemption_enabled(),
            "testPayouts": mode == "test",
            "latestRedemption": _public(pending[0]) if pending else None,
            "redemptionHistory": [_public(row) for row in history],
        }

    async def redeem(
        self, *, user_id: str, amount_coins: int, client_request_id: str, mode: str
    ) -> dict[str, Any]:
        if mode not in {"test", "live"} or mode != configured_connect_mode():
            raise HashcoinRedemptionError(
                "LIVE_REDEMPTION_DISABLED", "Real bank withdrawals are not available yet."
            )
        if mode == "live" and not live_hashcoin_platform_key_configured():
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
                "PAYOUT_UNAVAILABLE", "Bank payouts are unavailable.", 503
            ) from None
        if key_mode != mode:
            raise HashcoinRedemptionError(
                "PAYOUT_UNAVAILABLE", "Bank payouts are unavailable.", 503
            )
        row = await self.wallet.get_redemption(
            user_id=user_id, request_key=request_key, stripe_mode=mode
        )
        if row is not None:
            if row["amountCoins"] != amount_coins or row["stripeMode"] != mode:
                raise HashcoinRedemptionError(
                    "REDEMPTION_CONFLICT", "Use the original redemption amount."
                )
            if row["status"] in {"succeeded", "failed"}:
                return _public(row)
            if (
                mode == "live"
                and not live_hashcoin_redemption_enabled()
                and row["status"] == "reserved"
                and row["userId"] is not None
            ):
                return _public(row)
        else:
            if mode == "live" and not live_hashcoin_redemption_enabled():
                raise HashcoinRedemptionError(
                    "LIVE_REDEMPTION_DISABLED", "Real bank withdrawals are not available yet."
                )
            accounts = self._accounts or PkmPayoutService(
                stripe_api=self.stripe_api, mode=mode, api_key=key
            )
            account = await accounts.refresh_account(user_id)
            if (
                not account
                or not isinstance(account.get("stripe_account_id"), str)
                or not account["stripe_account_id"].startswith("acct_")
                or not account.get("readiness", {}).get("ready")
            ):
                raise HashcoinRedemptionError("PAYOUT_ACCOUNT_REQUIRED", "Link your bank first.")
            if mode == "test":
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
                stripe_mode=mode,
                destination_account_id=account["stripe_account_id"],
            )
        claimed = await self.wallet.claim_redemption(
            user_id=user_id, redemption_id=row["id"], stripe_mode=mode
        )
        if claimed is None:
            current = await self.wallet.get_redemption(
                user_id=user_id, request_key=request_key, stripe_mode=mode
            )
            return _public(current or row)
        return await self._dispatch(claimed, key=key)

    async def reconcile_due(self, *, max_items: int = 4) -> dict[str, int]:
        mode = configured_connect_mode()
        if mode == "live" and not live_hashcoin_platform_key_configured():
            return {"disabled": 1}
        rows = await self.wallet.list_reconcilable_redemptions(
            max_items=max_items, stripe_mode=mode
        )
        counts: dict[str, int] = {}
        for row in rows:
            if (
                mode == "live"
                and not live_hashcoin_redemption_enabled()
                and row["status"] == "reserved"
            ):
                continue
            try:
                if row["userId"] is None and mode == "live":
                    # Erasure detaches identity but not the financial liability.
                    # Only observe a previously accepted transfer; never create one.
                    key, key_mode = connect_config()
                    if key_mode != "live":
                        raise ValueError("connect_mode_mismatch")
                    claimed = await self.wallet.claim_redemption(
                        user_id=None,
                        redemption_id=row["id"],
                        stripe_mode="live",
                        allow_erased=True,
                    )
                    if claimed is None:
                        outcome = "failed"
                    else:
                        claimed["createAllowed"] = False
                        outcome = (await self._dispatch(claimed, key=key))["status"]
                else:
                    result = await self.redeem(
                        user_id=row["userId"],
                        amount_coins=row["amountCoins"],
                        client_request_id=row["clientRequestId"],
                        mode=mode,
                    )
                    outcome = result["status"]
            except Exception as exc:
                logger.warning("hashcoin.reconcile_deferred type=%s", type(exc).__name__)
                outcome = "deferred"
            counts[outcome] = counts.get(outcome, 0) + 1
        if mode == "live":
            for outcome, count in (await self._reverse_refunded_live(max_items=max_items)).items():
                counts[f"refund_{outcome}"] = count
            reviewed = await self._review_completed_live(max_items=max_items)
            if reviewed:
                counts["completed_checked"] = reviewed
        return counts

    async def _reverse_refunded_live(self, *, max_items: int) -> dict[str, int]:
        key, mode = connect_config()
        if mode != "live" or not live_hashcoin_platform_key_configured():
            return {}
        rows = await self.wallet.list_due_live_reversals(max_items=max_items)
        outcomes: dict[str, int] = {}
        for row in rows:
            claim = await self.wallet.claim_live_reversal(redemption_id=row["id"])
            if claim is None:
                continue
            try:
                remote = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.Transfer.retrieve,
                        claim["stripeTransferId"],
                        api_key=key,
                    )
                )
                if not _transfer_matches(remote, claim, allow_reversed=True):
                    reversal, error = None, "provider_mismatch"
                else:
                    listed = _stripe_dict(
                        await asyncio.to_thread(
                            self.stripe_api.Transfer.list_reversals,
                            claim["stripeTransferId"],
                            limit=100,
                            api_key=key,
                        )
                    )
                    items = listed.get("data")
                    if listed.get("has_more") or not isinstance(items, list):
                        reversal, error = None, "provider_mismatch"
                    elif items:
                        candidates = [_stripe_dict(item) for item in items]
                        reversal, error = (
                            (candidates[0], None)
                            if len(candidates) == 1 and _reversal_matches(candidates[0], claim)
                            else (None, "provider_mismatch")
                        )
                    elif remote.get("reversed") is True or remote.get("amount_reversed") != 0:
                        reversal, error = None, "provider_mismatch"
                    else:
                        first = claim.get("reversalFirstDispatchAt")
                        started = (
                            datetime.fromisoformat(first.replace("Z", "+00:00"))
                            if isinstance(first, str)
                            else first
                        )
                        if started is None or datetime.now(UTC) - started > timedelta(hours=22):
                            reversal, error = None, "idempotency_window_elapsed"
                        else:
                            reversal = _stripe_dict(
                                await asyncio.to_thread(
                                    self.stripe_api.Transfer.create_reversal,
                                    claim["stripeTransferId"],
                                    amount=claim["amountCoins"],
                                    metadata={
                                        "payment_kind": "hashcoin_live_redemption_reversal",
                                        "hashcoin_redemption_id": claim["id"],
                                    },
                                    api_key=key,
                                    idempotency_key=(
                                        f"hashcoin-redeem-reversal:{stripe_environment()}:live:{claim['id']}"
                                    ),
                                )
                            )
                            error = (
                                None if _reversal_matches(reversal, claim) else "provider_mismatch"
                            )
                if reversal is not None and not _reversal_matches(reversal, claim):
                    reversal, error = None, "provider_mismatch"
            except Exception as exc:
                logger.warning("hashcoin.reversal_deferred type=%s", type(exc).__name__)
                reversal, error = None, "provider_unavailable"
            outcome = (
                "reversed"
                if reversal is not None
                else "manual_review"
                if error in {"provider_mismatch", "idempotency_window_elapsed"}
                else "unknown"
            )
            await self.wallet.finish_live_reversal(
                redemption_id=claim["id"],
                attempt_id=claim["reversalAttemptId"],
                outcome=outcome,
                stripe_reversal_id=reversal["id"] if reversal is not None else None,
                review_reason=error,
            )
            outcomes[outcome] = outcomes.get(outcome, 0) + 1
        return outcomes

    async def _review_completed_live(self, *, max_items: int) -> int:
        key, mode = connect_config()
        if mode != "live" or not live_hashcoin_platform_key_configured():
            return 0
        rows = await self.wallet.list_live_completed_for_review(max_items=max_items)
        checked = 0
        for row in rows:
            try:
                remote = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.Transfer.retrieve,
                        row["stripeTransferId"],
                        api_key=key,
                    )
                )
                matched = _transfer_matches(remote, row, allow_reversed=True)
                reversed_coins = remote.get("amount_reversed") if matched else 0
                if row.get("reversalStatus") == "reversed":
                    listed = _stripe_dict(
                        await asyncio.to_thread(
                            self.stripe_api.Transfer.list_reversals,
                            row["stripeTransferId"],
                            limit=100,
                            api_key=key,
                        )
                    )
                    reversals = listed.get("data")
                    expected = bool(
                        matched
                        and remote.get("reversed") is True
                        and reversed_coins == row["amountCoins"]
                        and listed.get("has_more") is False
                        and isinstance(reversals, list)
                        and len(reversals) == 1
                        and _reversal_matches(_stripe_dict(reversals[0]), row)
                        and _stripe_dict(reversals[0]).get("id") == row.get("stripeReversalId")
                    )
                    reason = None if expected else "transfer_mismatch"
                else:
                    reason = (
                        "transfer_mismatch"
                        if not matched or (remote.get("reversed") is True and reversed_coins == 0)
                        else "transfer_reversed"
                        if reversed_coins > 0
                        else None
                    )
            except Exception as exc:
                logger.warning("hashcoin.completed_check_deferred type=%s", type(exc).__name__)
                continue
            await self.wallet.record_live_transfer_check(
                redemption_id=row["id"],
                stripe_transfer_id=row["stripeTransferId"],
                review_reason=reason,
                reversed_coins=reversed_coins if matched else 0,
            )
            checked += 1
        return checked

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
        live = row["stripeMode"] == "live"
        group = f"drive-request-{row['sourceRequestId']}" if live else f"hashcoin-{row['id']}"
        try:
            scan_args = {"api_key": key, "transfer_group": group, "limit": 100 if live else 2}
            if not live:
                scan_args["destination"] = row["accountId"]
            existing = _stripe_dict(
                await asyncio.to_thread(
                    self.stripe_api.Transfer.list,
                    **scan_args,
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
        if live and not live_hashcoin_redemption_enabled():
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
                outcome = (
                    "failed" if live and row.get("previousStatus") == "reserved" else "unknown"
                )
                return await self._finish(row, outcome)
        except Exception:
            return await self._finish(row, "unknown")
        if live:
            try:
                charge = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.Charge.retrieve, row["sourceChargeId"], api_key=key
                    )
                )
                intent = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.PaymentIntent.retrieve,
                        row["sourcePaymentIntentId"],
                        api_key=key,
                    )
                )
                if not _live_source_matches(charge, intent, row):
                    outcome = "failed" if row.get("previousStatus") == "reserved" else "unknown"
                    return await self._finish(row, outcome)
            except Exception:
                return await self._finish(row, "unknown")
        try:
            transfer_args = {
                "api_key": key,
                "idempotency_key": (
                    f"hashcoin-redeem:{stripe_environment()}:{row['stripeMode']}:{row['id']}"
                ),
                "amount": row["amountCoins"],
                "currency": "usd",
                "destination": row["accountId"],
                "transfer_group": group,
                "metadata": {
                    "payment_kind": (
                        "hashcoin_live_redemption" if live else "hashcoin_sandbox_redemption"
                    ),
                    "hashcoin_redemption_id": row["id"],
                },
            }
            if live:
                transfer_args["source_transaction"] = row["sourceChargeId"]

                def create_live():
                    if self.stripe_api is stripe:
                        # A per-call client bounds the network wait without
                        # mutating Stripe globals shared by other requests.
                        client = stripe.StripeClient(
                            key,
                            http_client=stripe.RequestsClient(timeout=(3, 5)),
                            max_network_retries=0,
                        )
                        params = {
                            name: value
                            for name, value in transfer_args.items()
                            if name not in {"api_key", "idempotency_key"}
                        }
                        return client.v1.transfers.create(
                            params,
                            options={"idempotency_key": transfer_args["idempotency_key"]},
                        )
                    return self.stripe_api.Transfer.create(**transfer_args)

                response = await self.wallet.create_live_transfer_fenced(
                    redemption=row, create=create_live
                )
                if response is None:
                    outcome = "failed" if row.get("previousStatus") == "reserved" else "unknown"
                    return await self._finish(row, outcome)
            else:
                response = await asyncio.to_thread(self.stripe_api.Transfer.create, **transfer_args)
            remote = _stripe_dict(response)
        except stripe.InvalidRequestError as exc:
            # A persisted unknown outcome must not be released based on a later
            # error: an earlier transfer could already have been accepted.
            definite = row.get("previousStatus") == "reserved" and (
                not live
                or getattr(exc, "code", None) in {"balance_insufficient", "insufficient_funds"}
            )
            return await self._finish(row, "failed" if definite else "unknown")
        except Exception as exc:
            logger.warning("hashcoin.transfer_unknown type=%s", type(exc).__name__)
            return await self._finish(row, "unknown")
        if not _transfer_matches(remote, row):
            return await self._finish(row, "unknown")
        return await self._finish(row, "succeeded", remote["id"])
