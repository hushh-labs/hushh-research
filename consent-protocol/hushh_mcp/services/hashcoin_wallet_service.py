"""Integer earnings ledger with isolated, non-cash sandbox redemption.

One Hashcoin is one USD cent. Live credits are financial liabilities; test
credits merely demonstrate payout UX and can never consume a live balance.
All mutations serialize on a wallet row, with immutable source references.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Callable
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore
from hushh_mcp.services.payout_doorbell import PayoutDoorbellError, notify_payout_changed
from hushh_mcp.services.payout_request_labels import owner_request_labels
from hushh_mcp.services.payout_review import (
    review_for_balance,
    review_for_earning,
    review_for_redemption,
)
from hushh_mcp.services.stripe_mode import live_hashcoin_redemption_enabled

logger = logging.getLogger(__name__)


class HashcoinError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def hashcoins_enabled() -> bool:
    return (os.getenv("DRIVE_REQUEST_HASHCOINS_ENABLED") or "").strip().lower() == "true"


def _mode(mode: str) -> str:
    if mode not in {"live", "test"}:
        raise HashcoinError("invalid_mode")
    return mode


def _amount(value: int) -> int:
    if type(value) is not int or not 1 <= value <= 50000:
        raise HashcoinError("invalid_amount")
    return value


def _uuid(value: str) -> str:
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise HashcoinError("invalid_request") from None


class HashcoinWalletService(ExternalConnectorLifecycleStore):
    @staticmethod
    def ensure_wallet(connection, *, user_id: str, stripe_mode: str) -> str:
        if not user_id:
            raise HashcoinError("invalid_owner")
        mode = _mode(stripe_mode)
        connection.execute(
            text("""INSERT INTO hashcoin_wallets(wallet_id,user_id,stripe_mode)
              VALUES (:wallet,:owner,:mode) ON CONFLICT (user_id,stripe_mode) DO NOTHING"""),
            {"wallet": str(uuid4()), "owner": user_id, "mode": mode},
        )
        return str(
            connection.execute(
                text(
                    "SELECT wallet_id FROM hashcoin_wallets WHERE user_id=:owner AND stripe_mode=:mode"
                ),
                {"owner": user_id, "mode": mode},
            ).scalar_one()
        )

    @staticmethod
    def _notify(connection, wallet: dict) -> None:
        """Queue the owner's wallet doorbell; an erased wallet has no owner to tell."""
        if not wallet.get("user_id"):
            return
        try:
            notify_payout_changed(connection, wallet["user_id"], ["wallet"])
        except PayoutDoorbellError:
            # A doorbell is advisory and readers also poll; it never fails a ledger write.
            logger.warning("hashcoin.doorbell_skipped reason=invalid_owner")

    @classmethod
    def _post(cls, connection, *, wallet_id: str, kind: str, source: str, amount: int) -> bool:
        wallet = cls._row(
            connection,
            "SELECT * FROM hashcoin_wallets WHERE wallet_id=:wallet FOR UPDATE",
            {"wallet": wallet_id},
        )
        if wallet is None:
            raise HashcoinError("wallet_unavailable")
        inserted = (
            connection.execute(
                text("""INSERT INTO hashcoin_ledger_entries
          (entry_id,wallet_id,entry_kind,source_ref,amount_coins)
          VALUES (:entry,:wallet,:kind,:source,:amount)
          ON CONFLICT (wallet_id,entry_kind,source_ref) DO NOTHING"""),
                {
                    "entry": str(uuid4()),
                    "wallet": wallet_id,
                    "kind": kind,
                    "source": source,
                    "amount": amount,
                },
            ).rowcount
            == 1
        )
        saved = connection.execute(
            text("""SELECT amount_coins FROM hashcoin_ledger_entries
          WHERE wallet_id=:wallet AND entry_kind=:kind AND source_ref=:source"""),
            {"wallet": wallet_id, "kind": kind, "source": source},
        ).scalar_one()
        if saved != amount:
            raise HashcoinError("ledger_source_mismatch")
        if inserted:
            cls._notify(connection, wallet)
        return inserted

    @classmethod
    def credit_earning(cls, connection, *, request_id: str) -> bool:
        """Called after actual-fee settlement, in that exact DB transaction."""
        payout = cls._row(
            connection,
            """SELECT * FROM drive_request_owner_payouts
          WHERE request_id=:request FOR UPDATE""",
            {"request": _uuid(request_id)},
        )
        if (
            payout is None
            or payout["settlement_method"] != "hashcoins"
            or payout["status"] != "hashcoins_credited"
            or payout["wallet_id"] is None
            or payout["owner_earning_cents"] is None
            or payout["owner_earning_cents"] <= 0
            or payout["actual_processing_fee_cents"] is None
            or payout["finalized_at"] is None
            or payout["stripe_transfer_id"] is not None
        ):
            raise HashcoinError("earning_not_settled")
        amount = _amount(payout["owner_earning_cents"])
        inserted = cls._post(
            connection,
            wallet_id=str(payout["wallet_id"]),
            kind="earning",
            source=request_id,
            amount=amount,
        )
        if payout["stripe_mode"] == "live" and payout["sandbox_wallet_id"] is not None:
            cls._post(
                connection,
                wallet_id=str(payout["sandbox_wallet_id"]),
                kind="sandbox_earning",
                source=request_id,
                amount=amount,
            )
        return inserted

    @classmethod
    def reverse_earning(cls, connection, *, request_id: str) -> bool:
        payout = cls._row(
            connection,
            """SELECT * FROM drive_request_owner_payouts
          WHERE request_id=:request FOR UPDATE""",
            {"request": _uuid(request_id)},
        )
        if (
            payout is None
            or payout["settlement_method"] != "hashcoins"
            or payout["status"]
            not in {"hashcoins_credited", "hashcoins_held", "hashcoins_reversed"}
            or payout["wallet_id"] is None
            or not payout["owner_earning_cents"]
        ):
            return False
        inserted = cls._post(
            connection,
            wallet_id=str(payout["wallet_id"]),
            kind="reversal",
            source=request_id,
            amount=-payout["owner_earning_cents"],
        )
        if payout["stripe_mode"] == "live" and payout["sandbox_wallet_id"] is not None:
            cls._post(
                connection,
                wallet_id=str(payout["sandbox_wallet_id"]),
                kind="sandbox_reversal",
                source=request_id,
                amount=-payout["owner_earning_cents"],
            )
        connection.execute(
            text("""UPDATE drive_request_owner_payouts SET
          status='hashcoins_reversed',reversal_amount_cents=owner_earning_cents,
          safe_error_code='external_debit',updated_at=clock_timestamp()
          WHERE request_id=:request"""),
            {"request": request_id},
        )
        connection.execute(
            text("""UPDATE hashcoin_redemptions SET reversal_status='due',
              reversal_next_check_at=clock_timestamp(),updated_at=clock_timestamp()
              WHERE source_request_id=:request AND stripe_mode='live'
                AND status='succeeded' AND reversal_status='none'"""),
            {"request": request_id},
        )
        # A bank transfer already sent (or whose result is uncertain) is a
        # durable debt after its funding charge disappears. Never clear that
        # hold merely because future earnings offset the negative balance.
        connection.execute(
            text("""UPDATE hashcoin_wallets SET held=TRUE WHERE wallet_id=:wallet
          AND EXISTS (SELECT 1 FROM hashcoin_redemptions r
            WHERE r.wallet_id=:wallet AND r.source_request_id=:request
              AND r.stripe_mode='live'
              AND r.status IN ('dispatching','unknown','succeeded')
              AND r.reversal_status<>'reversed')"""),
            {"wallet": payout["wallet_id"], "request": request_id},
        )
        if payout["status"] == "hashcoins_held":
            connection.execute(
                text("""UPDATE hashcoin_wallets w SET held=FALSE
              WHERE w.wallet_id IN (:wallet,:sandbox) AND w.erased_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM drive_request_owner_payouts p
                WHERE p.status='hashcoins_held' AND
                  (p.wallet_id=w.wallet_id OR p.sandbox_wallet_id=w.wallet_id))
              AND NOT EXISTS (SELECT 1 FROM hashcoin_redemptions r
                JOIN drive_request_owner_payouts p ON p.request_id=r.source_request_id
                WHERE r.wallet_id=w.wallet_id AND r.stripe_mode='live'
                  AND r.status IN ('dispatching','unknown','succeeded')
                  AND (p.status='hashcoins_reversed'
                    OR r.provider_review_reason IS NOT NULL))"""),
                {"wallet": payout["wallet_id"], "sandbox": payout["sandbox_wallet_id"]},
            )
        return inserted

    @staticmethod
    def _balance(connection, wallet: dict | None) -> dict:
        if wallet is None:
            return {
                "balanceCoins": 0,
                "reservedCoins": 0,
                "availableCoins": 0,
                "amountCents": 0,
                "held": False,
            }
        params = {"wallet": wallet["wallet_id"]}
        balance = int(
            connection.execute(
                text("""SELECT COALESCE(sum(amount_coins),0)
          FROM hashcoin_ledger_entries WHERE wallet_id=:wallet"""),
                params,
            ).scalar_one()
        )
        reserved = int(
            connection.execute(
                text("""SELECT COALESCE(sum(amount_coins),0)
          FROM hashcoin_redemptions WHERE wallet_id=:wallet
          AND status IN ('reserved','dispatching','unknown')"""),
                params,
            ).scalar_one()
        )
        return {
            "balanceCoins": balance,
            "reservedCoins": reserved,
            "availableCoins": 0 if wallet["held"] else max(0, balance - reserved),
            "amountCents": balance,
            "held": bool(wallet["held"] or balance < 0),
        }

    @staticmethod
    def _next_live_source(
        connection, *, wallet_id: str, available: int, exact_amount: int | None = None
    ) -> dict | None:
        if available < 1:
            return None
        return HashcoinWalletService._row(
            connection,
            """SELECT p.request_id,p.stripe_charge_id,p.stripe_payment_intent_id,
            p.gross_amount_cents,p.refund_amount_cents,p.owner_earning_cents
          FROM drive_request_owner_payouts p
          WHERE p.wallet_id=:wallet AND p.stripe_mode='live'
            AND p.settlement_method='hashcoins' AND p.status='hashcoins_credited'
            AND p.stripe_charge_id LIKE 'ch_%'
            AND p.owner_earning_cents BETWEEN 1 AND LEAST(:available,50000)
            AND (:exact_amount IS NULL OR p.owner_earning_cents=:exact_amount)
            AND NOT EXISTS (SELECT 1 FROM hashcoin_redemptions r
              WHERE r.source_request_id=p.request_id AND r.stripe_mode='live'
                AND r.status IN ('reserved','dispatching','unknown','succeeded'))
          ORDER BY p.credited_at,p.request_id LIMIT 1""",
            {"wallet": wallet_id, "available": available, "exact_amount": exact_amount},
        )

    @staticmethod
    def _summary_live_sources(connection, *, wallet_id: str, available: int) -> list[dict]:
        """The live sources Redeem can take, oldest first, in one statement.

        Replays _next_live_source's predicate and order with LIMIT 500 instead
        of LIMIT 1, so the first row is the source the next cash-out reserves.
        """
        if available < 1:
            return []
        return [
            dict(row)
            for row in connection.execute(
                text("""SELECT p.request_id,p.owner_earning_cents
          FROM drive_request_owner_payouts p
          WHERE p.wallet_id=:wallet AND p.stripe_mode='live'
            AND p.settlement_method='hashcoins' AND p.status='hashcoins_credited'
            AND p.stripe_charge_id LIKE 'ch_%'
            AND p.owner_earning_cents BETWEEN 1 AND LEAST(:available,50000)
            AND NOT EXISTS (SELECT 1 FROM hashcoin_redemptions r
              WHERE r.source_request_id=p.request_id AND r.stripe_mode='live'
                AND r.status IN ('reserved','dispatching','unknown','succeeded'))
          ORDER BY p.credited_at,p.request_id LIMIT 500"""),
                {"wallet": wallet_id, "available": available},
            ).mappings()
        ]

    @staticmethod
    def _summary_redeemable(sources: list[dict], *, available: int) -> tuple[int, int]:
        """Coins and sources sequential cash-outs can spend now, as (coins, count).

        Each cash-out spends one whole source, oldest first, while it fits what
        is still available; a source that no longer fits never fits later.
        """
        redeemable = count = 0
        remaining = available
        for row in sources:
            amount = int(row["owner_earning_cents"])
            if amount <= min(remaining, 50000):
                redeemable, remaining, count = redeemable + amount, remaining - amount, count + 1
        return redeemable, count

    @staticmethod
    def _summary_holds(connection, *, wallet: dict, live: dict[str, Any]) -> list[dict[str, Any]]:
        """Why a live wallet is held, mirroring its hold and release predicates.

        Reasons come only from payout_review. Each hold keeps its raw request ID
        and start time; the caller resolves labels and formats times.
        """
        # Every hold predicate sets the wallet flag before it applies, and the
        # release clears it only once none applies. "held" also covers a debt.
        if not live["held"]:
            return []
        params = {"wallet": str(wallet["wallet_id"])}
        holds: list[dict[str, Any]] = []
        for row in connection.execute(
            text("""SELECT request_id,status,safe_error_code,owner_earning_cents,held_at
          FROM drive_request_owner_payouts
          WHERE wallet_id=:wallet AND status='hashcoins_held'
          ORDER BY held_at NULLS LAST,request_id LIMIT 20"""),
            params,
        ).mappings():
            review = review_for_earning(row)
            if review is not None:
                holds.append(
                    {
                        "id": f"earning:{row['request_id']}",
                        **review,
                        "coins": int(row["owner_earning_cents"] or 0),
                        "requestId": str(row["request_id"]),
                        "since": row["held_at"],
                    }
                )
        for row in connection.execute(
            text("""SELECT r.redemption_id,r.stripe_mode,r.status,r.reversal_status,
            r.provider_review_reason,r.amount_coins,r.source_request_id,
            r.last_provider_checked_at,p.status AS source_status,
            e.created_at AS source_reversed_at
          FROM hashcoin_redemptions r
          LEFT JOIN drive_request_owner_payouts p ON p.request_id=r.source_request_id
          LEFT JOIN hashcoin_ledger_entries e ON e.wallet_id=r.wallet_id
            AND e.entry_kind='reversal' AND e.source_ref=r.source_request_id
          WHERE r.wallet_id=:wallet AND r.stripe_mode='live'
            AND r.reversal_status<>'reversed'
            AND (r.provider_review_reason IS NOT NULL OR
              (p.status='hashcoins_reversed' AND
                r.status IN ('dispatching','unknown','succeeded')))
          ORDER BY r.created_at,r.redemption_id LIMIT 20"""),
            params,
        ).mappings():
            review = review_for_redemption(row, {"status": row["source_status"]})
            if review is not None:
                holds.append(
                    {
                        "id": f"redemption:{row['redemption_id']}",
                        **review,
                        "coins": int(row["amount_coins"]),
                        "requestId": str(row["source_request_id"])
                        if row["source_request_id"]
                        else None,
                        # Flagged by the transfer check, or refunded after cash-out.
                        "since": row["last_provider_checked_at"]
                        if row["provider_review_reason"] is not None
                        else row["source_reversed_at"],
                    }
                )
        balance = live["balanceCoins"]
        review = review_for_balance(
            balance_coins=balance, held=bool(wallet["held"]), explained=bool(holds)
        )
        if review is not None:
            # A debt holds its deficit; an unexplained hold freezes what would be available.
            coins = -balance if balance < 0 else max(balance - live["reservedCoins"], 0)
            holds.insert(
                0,
                {"id": "balance", **review, "coins": coins, "requestId": None, "since": None},
            )
        return holds[:20]

    @classmethod
    def _summary_live_review(
        cls,
        connection,
        *,
        user_id: str,
        wallet: dict | None,
        live: dict[str, Any],
        sources: list[dict],
    ) -> dict[str, Any]:
        """Additive live summary fields (#8 holds, #9 redeemable totals).

        Invariants: nextRedeemCoins <= redeemableCoins <= availableCoins.
        """
        available, next_coins = live["availableCoins"], live["nextRedeemCoins"]
        redeemable, count = (
            cls._summary_redeemable(sources, available=available) if next_coins > 0 else (0, 0)
        )
        holds = cls._summary_holds(connection, wallet=wallet, live=live) if wallet else []
        source_id = str(sources[0]["request_id"]) if sources and next_coins > 0 else None
        request_ids = [hold["requestId"] for hold in holds if hold["requestId"]]
        if source_id:
            request_ids.append(source_id)
        # Only the owner's own, unerased requests keep an ID and a label.
        labels = (
            owner_request_labels(connection, user_id=user_id, request_ids=request_ids)
            if request_ids
            else {}
        )
        return {
            "holds": [
                {
                    "id": hold["id"],
                    "reason": hold["reason"],
                    "nextStep": hold["nextStep"],
                    "coins": hold["coins"],
                    "requestId": hold["requestId"] if hold["requestId"] in labels else None,
                    "requestLabel": labels.get(hold["requestId"]) if hold["requestId"] else None,
                    "since": hold["since"].isoformat() if hold["since"] is not None else None,
                }
                for hold in holds
            ],
            "redeemableCoins": redeemable,
            "redeemableCount": count,
            "remainingAfterNextCoins": available - next_coins,
            "notRedeemableCoins": available - redeemable,
            "nextRedeemSource": {"requestId": source_id, "label": labels[source_id]}
            if source_id in labels
            else None,
        }

    async def summary(self, *, user_id: str) -> dict[str, Any]:
        if not user_id:
            raise HashcoinError("invalid_owner")

        def operation(connection):
            rows = (
                connection.execute(
                    text("""SELECT * FROM hashcoin_wallets
              WHERE user_id=:owner ORDER BY stripe_mode FOR SHARE"""),
                    {"owner": user_id},
                )
                .mappings()
                .all()
            )
            wallets = {row["stripe_mode"]: dict(row) for row in rows}
            live = self._balance(connection, wallets.get("live"))
            # One read of the sources Redeem can take: its first row is the next
            # cash-out, and the rest give the redeemable totals. Nothing is read
            # while live cash-out is off, since nothing is offered then.
            sources = (
                self._summary_live_sources(
                    connection,
                    wallet_id=str(wallets["live"]["wallet_id"]),
                    available=live["availableCoins"],
                )
                if wallets.get("live") and not live["held"] and live_hashcoin_redemption_enabled()
                else []
            )
            live["nextRedeemCoins"] = int(sources[0]["owner_earning_cents"]) if sources else 0
            live.update(
                self._summary_live_review(
                    connection,
                    user_id=user_id,
                    wallet=wallets.get("live"),
                    live=live,
                    sources=sources,
                )
            )
            return {
                "coinName": "Hussh Coins",
                "coinsPerDollar": 100,
                "currency": "USD",
                "live": live,
                "sandbox": self._balance(connection, wallets.get("test")),
                "liveRedemptionEnabled": live_hashcoin_redemption_enabled(),
                "maxRedeemCoins": 50000,
            }

        return await self._transaction(operation)

    @staticmethod
    def _redemption(row: dict | None) -> dict | None:
        if row is None:
            return None
        return {
            "id": str(row["redemption_id"]),
            "walletId": str(row["wallet_id"]),
            "status": row["status"],
            "clientRequestId": str(row["request_key"]),
            "amountCoins": row["amount_coins"],
            "stripeMode": row["stripe_mode"],
            "accountId": row["destination_account_id"],
            "sourceRequestId": str(row["source_request_id"])
            if row.get("source_request_id")
            else None,
            "sourceChargeId": row.get("source_charge_id"),
            "sourcePaymentIntentId": row.get("source_payment_intent_id"),
            "sourceGrossCents": row.get("source_gross_cents"),
            "sourceRefundCents": row.get("source_refund_cents"),
            "providerReviewReason": row.get("provider_review_reason"),
            "providerReversedCoins": row.get("provider_reversed_amount_coins"),
            "reversalStatus": row.get("reversal_status", "none"),
            "stripeReversalId": row.get("stripe_reversal_id"),
            "reversalReviewReason": row.get("reversal_review_reason"),
            "reversalAttemptId": str(row["reversal_attempt_id"])
            if row.get("reversal_attempt_id")
            else None,
            "reversalFirstDispatchAt": row["reversal_first_dispatch_at"].isoformat()
            if row.get("reversal_first_dispatch_at")
            else None,
            "stripeTransferId": row["stripe_transfer_id"],
            "firstDispatchAt": row["first_dispatch_at"].isoformat()
            if row["first_dispatch_at"]
            else None,
            "createdAt": row["created_at"].isoformat(),
            "attemptId": str(row["attempt_id"]) if row.get("attempt_id") else None,
        }

    async def get_redemption(
        self, *, user_id: str, request_key: str, stripe_mode: str = "test"
    ) -> dict | None:
        mode = _mode(stripe_mode)
        return await self._transaction(
            lambda c: self._redemption(
                self._row(
                    c,
                    """SELECT r.* FROM hashcoin_redemptions r JOIN hashcoin_wallets w USING(wallet_id)
            WHERE w.user_id=:owner AND w.stripe_mode=:mode AND r.stripe_mode=:mode
              AND r.request_key=:key""",
                    {"owner": user_id, "key": _uuid(request_key), "mode": mode},
                )
            )
        )

    async def list_redemptions(
        self, *, user_id: str, max_items: int = 10, stripe_mode: str = "test"
    ) -> list[dict]:
        if type(max_items) is not int or not 1 <= max_items <= 20:
            raise HashcoinError("invalid_limit")
        mode = _mode(stripe_mode)
        return await self._transaction(
            lambda c: [
                self._redemption(dict(row))
                for row in c.execute(
                    text("""SELECT r.* FROM hashcoin_redemptions r
              JOIN hashcoin_wallets w USING(wallet_id) WHERE w.user_id=:owner
              AND w.stripe_mode=:mode AND r.stripe_mode=:mode
              ORDER BY r.created_at DESC,r.redemption_id DESC LIMIT :limit"""),
                    {"owner": user_id, "limit": max_items, "mode": mode},
                )
                .mappings()
                .all()
            ]
        )

    async def list_pending_redemptions(
        self, *, user_id: str, max_items: int = 10, stripe_mode: str = "test"
    ) -> list[dict]:
        if type(max_items) is not int or not 1 <= max_items <= 20:
            raise HashcoinError("invalid_limit")
        mode = _mode(stripe_mode)
        return await self._transaction(
            lambda c: [
                self._redemption(dict(row))
                for row in c.execute(
                    text("""SELECT r.* FROM hashcoin_redemptions r
              JOIN hashcoin_wallets w USING(wallet_id) WHERE w.user_id=:owner
              AND w.stripe_mode=:mode AND r.stripe_mode=:mode
              AND r.status IN ('reserved','dispatching','unknown')
              ORDER BY r.created_at,r.redemption_id LIMIT :limit"""),
                    {"owner": user_id, "limit": max_items, "mode": mode},
                )
                .mappings()
                .all()
            ]
        )

    async def list_reconcilable_redemptions(
        self, *, max_items: int = 10, stripe_mode: str = "test"
    ) -> list[dict]:
        if type(max_items) is not int or not 1 <= max_items <= 20:
            raise HashcoinError("invalid_limit")
        mode = _mode(stripe_mode)

        def operation(connection):
            rows = (
                connection.execute(
                    text("""SELECT r.*,w.user_id FROM hashcoin_redemptions r
              JOIN hashcoin_wallets w USING(wallet_id) WHERE
              (w.user_id IS NOT NULL OR (r.stripe_mode='live' AND w.erased_at IS NOT NULL))
              AND w.stripe_mode=:mode AND r.stripe_mode=:mode
              AND r.status IN ('reserved','dispatching','unknown')
              AND (r.lease_expires_at IS NULL OR r.lease_expires_at<=clock_timestamp())
              AND r.updated_at<clock_timestamp()-interval '1 minute'
              ORDER BY r.updated_at,r.redemption_id LIMIT :limit"""),
                    {"limit": max_items, "mode": mode},
                )
                .mappings()
                .all()
            )
            return [{**self._redemption(dict(row)), "userId": row["user_id"]} for row in rows]

        return await self._transaction(operation)

    async def list_live_completed_for_review(self, *, max_items: int = 10) -> list[dict]:
        if type(max_items) is not int or not 1 <= max_items <= 20:
            raise HashcoinError("invalid_limit")

        def operation(connection):
            return [
                self._redemption(dict(row))
                for row in connection.execute(
                    text("""SELECT r.* FROM hashcoin_redemptions r
                  JOIN hashcoin_wallets w USING(wallet_id)
                  WHERE r.stripe_mode='live' AND w.stripe_mode='live'
                    AND r.status='succeeded' AND
                      (r.provider_review_reason IS NULL OR r.reversal_status='reversed')
                    AND (r.last_provider_checked_at IS NULL OR
                      r.last_provider_checked_at<clock_timestamp()-interval '1 hour')
                  ORDER BY r.last_provider_checked_at NULLS FIRST,r.redemption_id LIMIT :limit"""),
                    {"limit": max_items},
                )
                .mappings()
                .all()
            ]

        return await self._transaction(operation)

    async def record_live_transfer_check(
        self,
        *,
        redemption_id: str,
        stripe_transfer_id: str,
        review_reason: str | None,
        reversed_coins: int = 0,
    ) -> None:
        if review_reason not in {None, "transfer_reversed", "transfer_mismatch"}:
            raise HashcoinError("invalid_review_reason")
        if type(reversed_coins) is not int or reversed_coins < 0:
            raise HashcoinError("invalid_amount")

        def operation(connection):
            row = self._row(
                connection,
                """SELECT r.*,w.user_id FROM hashcoin_redemptions r
              JOIN hashcoin_wallets w USING(wallet_id)
              WHERE r.redemption_id=:id AND r.stripe_mode='live'
              FOR UPDATE OF w,r""",
                {"id": _uuid(redemption_id)},
            )
            if (
                row is None
                or row["status"] != "succeeded"
                or row["stripe_transfer_id"] != stripe_transfer_id
                or reversed_coins > row["amount_coins"]
            ):
                raise HashcoinError("redemption_mismatch")
            if row["provider_review_reason"] is not None and row["reversal_status"] != "reversed":
                return
            connection.execute(
                text("""UPDATE hashcoin_redemptions SET
                  last_provider_checked_at=clock_timestamp(),
                  provider_review_reason=:reason,
                  provider_reversed_amount_coins=:reversed,
                  updated_at=clock_timestamp()
                  WHERE redemption_id=:id"""),
                {
                    "id": redemption_id,
                    "reason": review_reason,
                    "reversed": reversed_coins,
                },
            )
            if review_reason is not None:
                connection.execute(
                    text("UPDATE hashcoin_wallets SET held=TRUE WHERE wallet_id=:wallet"),
                    {"wallet": row["wallet_id"]},
                )
                self._notify(connection, row)

        await self._transaction(operation)

    async def list_due_live_reversals(self, *, max_items: int = 10) -> list[dict]:
        if type(max_items) is not int or not 1 <= max_items <= 20:
            raise HashcoinError("invalid_limit")

        def operation(connection):
            return [
                self._redemption(dict(row))
                for row in connection.execute(
                    text("""SELECT r.* FROM hashcoin_redemptions r
                  JOIN drive_request_owner_payouts p ON p.request_id=r.source_request_id
                  WHERE r.stripe_mode='live' AND r.status='succeeded'
                    AND p.stripe_mode='live' AND p.status='hashcoins_reversed'
                    AND r.reversal_status IN ('due','unknown')
                    AND r.reversal_next_check_at<=clock_timestamp()
                    AND (r.reversal_lease_expires_at IS NULL OR
                      r.reversal_lease_expires_at<=clock_timestamp())
                  ORDER BY r.reversal_next_check_at,r.redemption_id LIMIT :limit"""),
                    {"limit": max_items},
                )
                .mappings()
                .all()
            ]

        return await self._transaction(operation)

    async def claim_live_reversal(self, *, redemption_id: str) -> dict | None:
        def operation(connection):
            row = self._row(
                connection,
                """SELECT r.* FROM hashcoin_redemptions r
              JOIN drive_request_owner_payouts p ON p.request_id=r.source_request_id
              JOIN hashcoin_wallets w ON w.wallet_id=r.wallet_id
              WHERE r.redemption_id=:id AND r.stripe_mode='live' AND r.status='succeeded'
                AND p.stripe_mode='live' AND p.status='hashcoins_reversed'
                AND r.reversal_status IN ('due','unknown')
                AND r.reversal_next_check_at<=clock_timestamp()
                AND (r.reversal_lease_expires_at IS NULL OR
                  r.reversal_lease_expires_at<=clock_timestamp()) FOR UPDATE OF w,r""",
                {"id": _uuid(redemption_id)},
            )
            if row is None:
                return None
            attempt = row["reversal_attempt_id"] or uuid4()
            claimed = self._row(
                connection,
                """UPDATE hashcoin_redemptions SET reversal_status='unknown',
              reversal_attempt_id=:attempt,
              reversal_first_dispatch_at=COALESCE(reversal_first_dispatch_at,clock_timestamp()),
              reversal_lease_expires_at=clock_timestamp()+interval '2 minutes',
              reversal_next_check_at=clock_timestamp()+interval '2 minutes',
              updated_at=clock_timestamp()
              WHERE redemption_id=:id RETURNING *""",
                {"id": redemption_id, "attempt": str(attempt)},
            )
            connection.execute(
                text("UPDATE hashcoin_wallets SET held=TRUE WHERE wallet_id=:wallet"),
                {"wallet": row["wallet_id"]},
            )
            return self._redemption(claimed)

        return await self._transaction(operation)

    async def finish_live_reversal(
        self,
        *,
        redemption_id: str,
        attempt_id: str,
        outcome: str,
        stripe_reversal_id: str | None = None,
        review_reason: str | None = None,
    ) -> dict:
        if outcome not in {"reversed", "unknown", "manual_review"}:
            raise HashcoinError("invalid_outcome")
        if outcome == "reversed" and (
            not isinstance(stripe_reversal_id, str) or not stripe_reversal_id.startswith("trr_")
        ):
            raise HashcoinError("invalid_reversal")
        if review_reason not in {
            None,
            "provider_mismatch",
            "idempotency_window_elapsed",
            "provider_unavailable",
        }:
            raise HashcoinError("invalid_review_reason")

        def operation(connection):
            row = self._row(
                connection,
                """SELECT r.*,w.user_id FROM hashcoin_redemptions r
                  JOIN hashcoin_wallets w USING(wallet_id)
                  WHERE r.redemption_id=:id FOR UPDATE OF w,r""",
                {"id": _uuid(redemption_id)},
            )
            if row is None or str(row["reversal_attempt_id"]) != _uuid(attempt_id):
                raise HashcoinError("redemption_lease_lost")
            if row["reversal_status"] == "reversed":
                if outcome != "reversed" or row["stripe_reversal_id"] != stripe_reversal_id:
                    raise HashcoinError("redemption_mismatch")
                return self._redemption(row)
            if row["reversal_status"] != "unknown" or row["status"] != "succeeded":
                raise HashcoinError("redemption_mismatch")
            if outcome == "reversed":
                source_reversed = connection.execute(
                    text("""SELECT status='hashcoins_reversed' FROM drive_request_owner_payouts
                      WHERE request_id=:request"""),
                    {"request": row["source_request_id"]},
                ).scalar_one_or_none()
                if not source_reversed:
                    raise HashcoinError("redemption_mismatch")
                self._post(
                    connection,
                    wallet_id=str(row["wallet_id"]),
                    kind="redemption_reversal",
                    source=redemption_id,
                    amount=row["amount_coins"],
                )
            saved = self._row(
                connection,
                """UPDATE hashcoin_redemptions SET reversal_status=:outcome,
              stripe_reversal_id=:reversal,reversal_review_reason=:reason,
              reversal_lease_expires_at=NULL,
              reversal_next_check_at=clock_timestamp()+interval '5 minutes',
              updated_at=clock_timestamp() WHERE redemption_id=:id RETURNING *""",
                {
                    "id": redemption_id,
                    "outcome": outcome,
                    "reversal": stripe_reversal_id if outcome == "reversed" else None,
                    "reason": review_reason,
                },
            )
            if outcome == "reversed":
                connection.execute(
                    text("""UPDATE hashcoin_wallets w SET held=FALSE
                      WHERE w.wallet_id=:wallet AND w.erased_at IS NULL
                        AND (SELECT COALESCE(sum(amount_coins),0)
                          FROM hashcoin_ledger_entries e WHERE e.wallet_id=w.wallet_id)>=0
                        AND NOT EXISTS (SELECT 1 FROM drive_request_owner_payouts p
                          WHERE p.status='hashcoins_held'
                            AND (p.wallet_id=w.wallet_id OR p.sandbox_wallet_id=w.wallet_id))
                        AND NOT EXISTS (SELECT 1 FROM hashcoin_redemptions r
                          LEFT JOIN drive_request_owner_payouts p
                            ON p.request_id=r.source_request_id
                          WHERE r.wallet_id=w.wallet_id AND r.stripe_mode='live'
                            AND r.reversal_status<>'reversed'
                            AND (r.provider_review_reason IS NOT NULL OR
                              (p.status='hashcoins_reversed' AND
                                r.status IN ('dispatching','unknown','succeeded'))))"""),
                    {"wallet": row["wallet_id"]},
                )
            self._notify(connection, row)
            return self._redemption(saved)

        return await self._transaction(operation)

    async def reserve_redemption(
        self,
        *,
        user_id: str,
        amount_coins: int,
        request_key: str,
        destination_account_id: str,
        stripe_mode: str = "test",
    ) -> dict:
        mode = _mode(stripe_mode)
        if mode == "live" and not live_hashcoin_redemption_enabled():
            raise HashcoinError("live_redemption_unavailable")
        if (
            not user_id
            or not isinstance(destination_account_id, str)
            or not destination_account_id.startswith("acct_")
        ):
            raise HashcoinError("invalid_account")
        amount, key = _amount(amount_coins), _uuid(request_key)

        def operation(connection):
            wallet = self._row(
                connection,
                """SELECT * FROM hashcoin_wallets
              WHERE user_id=:owner AND stripe_mode=:mode FOR UPDATE""",
                {"owner": user_id, "mode": mode},
            )
            if wallet is None:
                raise HashcoinError("insufficient_balance")
            prior = self._row(
                connection,
                """SELECT * FROM hashcoin_redemptions
              WHERE wallet_id=:wallet AND request_key=:key""",
                {"wallet": wallet["wallet_id"], "key": key},
            )
            if prior:
                if (
                    prior["amount_coins"] != amount
                    or prior["stripe_mode"] != mode
                    or prior["destination_account_id"] != destination_account_id
                ):
                    raise HashcoinError("redemption_mismatch")
                return self._redemption(prior)
            if wallet["held"]:
                raise HashcoinError("wallet_held")
            if self._balance(connection, wallet)["availableCoins"] < amount:
                raise HashcoinError("insufficient_balance")
            source = None
            if mode == "live":
                source = self._next_live_source(
                    connection,
                    wallet_id=str(wallet["wallet_id"]),
                    available=amount,
                    exact_amount=amount,
                )
                if source is None or source["owner_earning_cents"] != amount:
                    raise HashcoinError("live_source_unavailable")
            row = self._row(
                connection,
                """INSERT INTO hashcoin_redemptions
              (redemption_id,wallet_id,request_key,amount_coins,stripe_mode,
               destination_account_id,source_request_id,source_charge_id,
               source_payment_intent_id,source_gross_cents,source_refund_cents)
              VALUES (:id,:wallet,:key,:amount,:mode,:account,:source_request,:charge,
                :intent,:gross,:refund) RETURNING *""",
                {
                    "id": str(uuid4()),
                    "wallet": wallet["wallet_id"],
                    "key": key,
                    "amount": amount,
                    "mode": mode,
                    "account": destination_account_id,
                    "source_request": str(source["request_id"]) if source else None,
                    "charge": source["stripe_charge_id"] if source else None,
                    "intent": source["stripe_payment_intent_id"] if source else None,
                    "gross": source["gross_amount_cents"] if source else None,
                    "refund": source["refund_amount_cents"] if source else None,
                },
            )
            self._notify(connection, wallet)
            return self._redemption(row)

        return await self._transaction(operation)

    async def claim_redemption(
        self,
        *,
        user_id: str | None,
        redemption_id: str,
        stripe_mode: str = "test",
        allow_erased: bool = False,
    ) -> dict | None:
        mode = _mode(stripe_mode)

        def operation(connection):
            row = self._row(
                connection,
                """SELECT r.*,w.held,w.user_id FROM hashcoin_redemptions r
              JOIN hashcoin_wallets w USING(wallet_id) WHERE r.redemption_id=:id
              AND (w.user_id=:owner OR
                (:allow_erased AND w.user_id IS NULL AND w.erased_at IS NOT NULL))
              AND w.stripe_mode=:mode AND r.stripe_mode=:mode
              FOR UPDATE OF w,r""",
                {
                    "id": _uuid(redemption_id),
                    "owner": user_id,
                    "mode": mode,
                    "allow_erased": bool(allow_erased and user_id is None and mode == "live"),
                },
            )
            if row is None or row["status"] in {"succeeded", "failed"}:
                return None
            balance = self._balance(connection, row)
            source_ready = True
            if row["stripe_mode"] == "live":
                source = self._row(
                    connection,
                    """SELECT status,stripe_charge_id FROM drive_request_owner_payouts
                  WHERE request_id=:request AND wallet_id=:wallet
                    AND settlement_method='hashcoins' AND stripe_mode='live'""",
                    {"request": row["source_request_id"], "wallet": row["wallet_id"]},
                )
                source_ready = bool(
                    source
                    and source["status"] == "hashcoins_credited"
                    and source["stripe_charge_id"] == row["source_charge_id"]
                )
            create_allowed = (
                source_ready
                and not balance["held"]
                and balance["balanceCoins"] >= balance["reservedCoins"]
                and not allow_erased
            )
            if row["first_dispatch_at"] is None and not create_allowed:
                connection.execute(
                    text("""UPDATE hashcoin_redemptions SET status='failed',
                  updated_at=clock_timestamp() WHERE redemption_id=:id AND first_dispatch_at IS NULL"""),
                    {"id": redemption_id},
                )
                self._notify(connection, row)
                return None
            previous_status = row["status"]
            row = self._row(
                connection,
                """UPDATE hashcoin_redemptions SET status='dispatching',
              first_dispatch_at=COALESCE(first_dispatch_at,clock_timestamp()),
              lease_expires_at=clock_timestamp()+interval '2 minutes',attempt_id=:attempt,
              updated_at=clock_timestamp() WHERE redemption_id=:id
              AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING *""",
                {"id": redemption_id, "attempt": str(uuid4())},
            )
            result = self._redemption(row)
            if result is not None:
                result["previousStatus"] = previous_status
                result["createAllowed"] = create_allowed
            return result

        return await self._transaction(operation)

    async def create_live_transfer_fenced(
        self, *, redemption: dict, create: Callable[[], Any]
    ) -> Any | None:
        """Serialize the irreversible Stripe write against owner erasure.

        The session advisory lock remains held across bounded provider I/O,
        while the final eligibility read is committed before that I/O. The
        erasure trigger uses the same Postgres-computed wallet lock key.
        """

        def operation():
            wallet_id = _uuid(redemption["walletId"])
            redemption_id = _uuid(redemption["id"])
            attempt_id = _uuid(redemption["attemptId"])
            lock_sql = "hashtextextended(CAST(:wallet AS text),303)"
            with self.db.engine.connect() as connection:
                acquired = False
                try:
                    acquired = bool(
                        connection.execute(
                            text(f"SELECT pg_try_advisory_lock({lock_sql})"),
                            {"wallet": wallet_id},
                        ).scalar_one()
                    )
                    connection.commit()
                    if not acquired:
                        return None
                    allowed = connection.execute(
                        text("""SELECT EXISTS (SELECT 1 FROM hashcoin_redemptions r
                          JOIN hashcoin_wallets w USING(wallet_id)
                          JOIN drive_request_owner_payouts p
                            ON p.request_id=r.source_request_id
                          WHERE r.redemption_id=:redemption AND r.wallet_id=:wallet
                            AND r.stripe_mode='live' AND w.stripe_mode='live'
                            AND w.user_id IS NOT NULL AND w.erased_at IS NULL AND NOT w.held
                            AND r.status='dispatching' AND r.attempt_id=:attempt
                            AND p.status='hashcoins_credited' AND p.stripe_mode='live'
                            AND p.stripe_charge_id=r.source_charge_id)"""),
                        {
                            "redemption": redemption_id,
                            "wallet": wallet_id,
                            "attempt": attempt_id,
                        },
                    ).scalar_one()
                    connection.commit()
                    if not allowed:
                        return None
                    return create()
                finally:
                    if acquired:
                        try:
                            connection.rollback()
                            connection.execute(
                                text(f"SELECT pg_advisory_unlock({lock_sql})"),
                                {"wallet": wallet_id},
                            )
                            connection.commit()
                        except Exception:
                            # Closing an invalidated backend releases session locks.
                            connection.invalidate()

        return await asyncio.to_thread(operation)

    async def finish_redemption(
        self,
        *,
        redemption_id: str,
        outcome: str,
        stripe_transfer_id: str | None = None,
        attempt_id: str | None = None,
    ) -> dict:
        if outcome not in {"succeeded", "failed", "unknown"}:
            raise HashcoinError("invalid_outcome")
        if outcome == "succeeded" and (
            not isinstance(stripe_transfer_id, str) or not stripe_transfer_id.startswith("tr_")
        ):
            raise HashcoinError("invalid_transfer")

        def operation(connection):
            row = self._row(
                connection,
                """SELECT r.*,w.user_id,w.held
              FROM hashcoin_redemptions r JOIN hashcoin_wallets w USING(wallet_id)
              WHERE r.redemption_id=:id FOR UPDATE OF w,r""",
                {"id": _uuid(redemption_id)},
            )
            if row is None:
                raise HashcoinError("redemption_unavailable")
            if row["status"] == "succeeded":
                if outcome != "succeeded" or stripe_transfer_id != row["stripe_transfer_id"]:
                    raise HashcoinError("redemption_mismatch")
                return self._redemption(row)
            if row["status"] == "failed":
                if outcome != "failed":
                    raise HashcoinError("redemption_mismatch")
                return self._redemption(row)
            if row["status"] != "reserved" and attempt_id is None:
                raise HashcoinError("redemption_lease_lost")
            if attempt_id is not None and str(row["attempt_id"]) != _uuid(attempt_id):
                raise HashcoinError("redemption_lease_lost")
            if outcome == "succeeded" and row["status"] == "reserved":
                raise HashcoinError("redemption_not_dispatched")
            if outcome == "succeeded":
                self._post(
                    connection,
                    wallet_id=str(row["wallet_id"]),
                    kind="redemption",
                    source=redemption_id,
                    amount=-row["amount_coins"],
                )
            saved = self._row(
                connection,
                """UPDATE hashcoin_redemptions SET status=:outcome,
              stripe_transfer_id=:transfer,lease_expires_at=NULL,updated_at=clock_timestamp()
              WHERE redemption_id=:id RETURNING *""",
                {
                    "id": redemption_id,
                    "outcome": outcome,
                    "transfer": stripe_transfer_id if outcome == "succeeded" else None,
                },
            )
            if outcome == "succeeded" and row["stripe_mode"] == "live":
                source_reversed = connection.execute(
                    text("""SELECT status='hashcoins_reversed' FROM drive_request_owner_payouts
                      WHERE request_id=:request"""),
                    {"request": row["source_request_id"]},
                ).scalar_one_or_none()
                if source_reversed:
                    saved = self._row(
                        connection,
                        """UPDATE hashcoin_redemptions SET reversal_status='due',
                      reversal_next_check_at=clock_timestamp() WHERE redemption_id=:id RETURNING *""",
                        {"id": redemption_id},
                    )
                    connection.execute(
                        text("UPDATE hashcoin_wallets SET held=TRUE WHERE wallet_id=:wallet"),
                        {"wallet": row["wallet_id"]},
                    )
            self._notify(connection, row)
            return self._redemption(saved)

        return await self._transaction(operation)
