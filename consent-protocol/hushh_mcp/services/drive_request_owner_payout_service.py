"""Durable Stripe Connect settlement for newly enrolled Drive request orders.

The payment order is the pricing authority. Delivery and refund outcomes are
read under database locks; Stripe reads/writes happen only after commit. A
unique transfer group plus a stable idempotency key fences uncertain writes.
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import stripe
from sqlalchemy import text

from hushh_mcp.services.drive_request_payment_service import _config, _stripe_dict
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore
from hushh_mcp.services.hashcoin_wallet_service import HashcoinWalletService, hashcoins_enabled
from hushh_mcp.services.stripe_mode import configured_stripe_mode, stripe_environment

_SAFE_RETRY_WINDOW = timedelta(hours=20)
_TERMINAL_REQUESTS = {"completed", "partial", "no_match"}


class PayoutTransientError(ValueError):
    """Provider data is not yet available; retain the durable fee claim."""


def payout_enabled() -> bool:
    return (os.getenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED") or "").strip().lower() == "true"


def round_half_up(numerator: int, denominator: int) -> int:
    """Round a nonnegative rational number to cents, with ties rounded up."""
    if (
        type(numerator) is not int
        or type(denominator) is not int
        or numerator < 0
        or denominator <= 0
    ):
        raise ValueError("invalid payout amount")
    return (2 * numerator + denominator) // (2 * denominator)


def delivery_amounts(
    *, gross_cents: int, confirmed: int, expected: int, commission_bps: int = 300
) -> dict[str, int]:
    if (
        type(gross_cents) is not int
        or not 100 <= gross_cents <= 50000
        or type(confirmed) is not int
        or type(expected) is not int
        or expected < 0
        or confirmed < 0
        or confirmed > expected
        or commission_bps != 300
    ):
        raise ValueError("invalid payout basis")
    retained = round_half_up(gross_cents * confirmed, expected) if expected else 0
    fee = round_half_up(retained * commission_bps, 10000)
    return {
        "retained_amount_cents": retained,
        "refund_amount_cents": gross_cents - retained,
        "platform_fee_cents": fee,
    }


def fee_amounts(
    *,
    gross_cents: int,
    retained_cents: int,
    platform_fee_cents: int,
    actual_processing_fee_cents: int,
) -> dict[str, int]:
    if (
        any(
            type(value) is not int
            for value in (
                gross_cents,
                retained_cents,
                platform_fee_cents,
                actual_processing_fee_cents,
            )
        )
        or gross_cents <= 0
        or not 0 <= retained_cents <= gross_cents
        or not 0 <= platform_fee_cents <= retained_cents
        or actual_processing_fee_cents < 0
    ):
        raise ValueError("invalid processing fee")
    # The owner bears the charge's actual processing fee, limited by proceeds.
    # Hushh absorbs any amount above the retained balance after commission.
    allocated = min(actual_processing_fee_cents, retained_cents - platform_fee_cents)
    return {
        "actual_processing_fee_cents": actual_processing_fee_cents,
        "allocated_processing_fee_cents": allocated,
        "owner_earning_cents": retained_cents - platform_fee_cents - allocated,
    }


def _provider_mode(key: str) -> bool:
    return key.startswith("sk_live_")


def _provider_id(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _retry_open(first_dispatch_at: datetime | None) -> bool:
    return bool(
        isinstance(first_dispatch_at, datetime)
        and first_dispatch_at.tzinfo is not None
        and datetime.now(UTC) < first_dispatch_at + _SAFE_RETRY_WINDOW
    )


def _erased_settlement_valid(payout: dict, obligation: dict | None) -> bool:
    """Accept only the paid, terminal delivery captured before identity erasure."""
    return bool(
        payout.get("erased_at") is not None
        and payout.get("eligible_at_erasure") is True
        and payout.get("finalized_at") is not None
        and type(payout.get("expected_files")) is int
        and type(payout.get("confirmed_files")) is int
        and 0 < payout["confirmed_files"] <= payout["expected_files"]
        and type(payout.get("retained_amount_cents")) is int
        and payout["retained_amount_cents"] > 0
        and _provider_id(payout.get("stripe_payment_intent_id")) is not None
        and obligation is not None
        and obligation.get("erased_at") is not None
        and obligation.get("status") == "paid"
        and obligation.get("reconciliation_required") is False
        and obligation.get("delivery_confirmed_at_erasure") is True
        and obligation.get("delivery_unsettled_at_erasure") is False
        and obligation.get("stripe_payment_intent_id") == payout["stripe_payment_intent_id"]
    )


class DriveRequestOwnerPayoutService(ExternalConnectorLifecycleStore):
    def __init__(self, db=None, *, stripe_api=None):
        super().__init__(db)
        self.stripe_api = stripe_api or stripe

    async def owner_history(self, *, user_id: str, cursor: str | None = None) -> dict[str, Any]:
        """Owner-scoped, bounded earnings; a transfer is never a bank deposit."""
        if not user_id:
            raise ValueError("invalid owner")
        cursor_id = str(UUID(cursor)) if cursor else None

        def operation(connection):
            rows = (
                connection.execute(
                    text("""SELECT p.request_id,p.status,p.stripe_mode,p.gross_amount_cents,
                  p.refund_amount_cents,p.platform_fee_cents,p.allocated_processing_fee_cents,
                  p.owner_earning_cents,p.reversal_amount_cents,p.created_at,p.transferred_at,
                  p.expected_files,p.confirmed_files,p.settlement_method,p.credited_at,r.user_id,r.request_envelope
                  FROM drive_request_owner_payouts p
                  JOIN drive_share_requests r ON r.request_id=p.request_id
                  JOIN drive_request_payment_orders o ON o.request_id=p.request_id
                  WHERE r.user_id=:owner AND p.erased_at IS NULL
                    AND o.stripe_payment_intent_id IS NOT NULL
                    AND (CAST(:cursor AS uuid) IS NULL OR (p.created_at,p.request_id) < (
                      SELECT c.created_at,c.request_id FROM drive_request_owner_payouts c
                      JOIN drive_share_requests cr ON cr.request_id=c.request_id
                      WHERE c.request_id=CAST(:cursor AS uuid) AND cr.user_id=:owner))
                  ORDER BY p.created_at DESC,p.request_id DESC LIMIT 21"""),
                    {"owner": user_id, "cursor": cursor_id},
                )
                .mappings()
                .all()
            )
            return [dict(row) for row in rows]

        rows = await self._transaction(operation)
        from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher, DriveSharingError

        cipher = DriveSharingCipher() if rows else None
        items = []
        for row in rows[:20]:
            description = "Document request"
            try:
                private = cipher.open(
                    row["request_envelope"],
                    user_id=user_id,
                    resource_id=str(row["request_id"]),
                    purpose="request",
                )
                terms = private.get("purpose")
                purpose = terms.get("purpose") if isinstance(terms, dict) else None
                if isinstance(purpose, str) and purpose.strip():
                    description = " ".join(purpose.split())[:120]
            except (DriveSharingError, ValueError, TypeError, KeyError):
                # Financial history remains readable if an old request's
                # descriptive envelope cannot be opened. Never log its contents.
                pass
            items.append(
                {
                    "requestId": str(row["request_id"]),
                    "description": description,
                    "stripeMode": row["stripe_mode"],
                    "status": row["status"],
                    "settlementMethod": row["settlement_method"],
                    "creditedCoins": row["owner_earning_cents"] if row["credited_at"] else None,
                    "creditedAt": row["credited_at"].isoformat() if row["credited_at"] else None,
                    "grossAmountCents": row["gross_amount_cents"],
                    "refundAmountCents": row["refund_amount_cents"],
                    "platformFeeCents": row["platform_fee_cents"],
                    "processingFeeCents": row["allocated_processing_fee_cents"],
                    "netAmountCents": row["owner_earning_cents"],
                    "reversedAmountCents": row["reversal_amount_cents"],
                    "createdAt": row["created_at"].isoformat(),
                    "transferredAt": row["transferred_at"].isoformat()
                    if row["transferred_at"]
                    else None,
                    "expectedFiles": row["expected_files"],
                    "confirmedFiles": row["confirmed_files"],
                }
            )
        return {
            "currency": "USD",
            "transactions": items,
            "stripeMode": configured_stripe_mode(),
            "nextCursor": str(rows[19]["request_id"]) if len(rows) > 20 else None,
        }

    @staticmethod
    def record_order(
        connection,
        *,
        request_id: str,
        owner_user_id: str,
        amount_cents: int,
        settlement_method: str = "stripe_transfer",
    ) -> bool:
        """Enroll only a new, unpaid order in the same transaction as its INSERT."""
        if settlement_method not in {"stripe_transfer", "hashcoins"}:
            raise ValueError("invalid settlement method")
        if not payout_enabled() and not (settlement_method == "hashcoins" and hashcoins_enabled()):
            raise RuntimeError("owner_payouts_disabled")
        request = str(UUID(str(request_id)))
        if not owner_user_id or type(amount_cents) is not int or not 100 <= amount_cents <= 50000:
            raise ValueError("invalid payout order")
        order = (
            connection.execute(
                text("""SELECT user_id,amount_cents,status,paid_at,stripe_mode,settlement_method FROM drive_request_payment_orders
              WHERE request_id=:request FOR UPDATE"""),
                {"request": request},
            )
            .mappings()
            .first()
        )
        if (
            order is None
            or order["user_id"] != owner_user_id
            or order["amount_cents"] != amount_cents
            or order["status"] not in {"awaiting_payment", "checkout_open"}
            or order["paid_at"] is not None
            or order["stripe_mode"] != configured_stripe_mode()
            or order.get("settlement_method", "stripe_transfer") != settlement_method
        ):
            raise ValueError("payout_order_not_new")
        wallet_id = sandbox_wallet_id = None
        if settlement_method == "hashcoins":
            wallet_id = HashcoinWalletService.ensure_wallet(
                connection, user_id=owner_user_id, stripe_mode=order["stripe_mode"]
            )
            if order["stripe_mode"] == "live":
                sandbox_wallet_id = HashcoinWalletService.ensure_wallet(
                    connection, user_id=owner_user_id, stripe_mode="test"
                )
        inserted = connection.execute(
            text("""INSERT INTO drive_request_owner_payouts
              (request_id,gross_amount_cents,stripe_mode,settlement_method,wallet_id,sandbox_wallet_id)
              VALUES (:request,:amount,:stripe_mode,:method,:wallet,:sandbox)
              ON CONFLICT (request_id) DO NOTHING"""),
            {
                "request": request,
                "amount": amount_cents,
                "stripe_mode": configured_stripe_mode(),
                "method": settlement_method,
                "wallet": wallet_id,
                "sandbox": sandbox_wallet_id,
            },
        )
        ledger = (
            connection.execute(
                text("""SELECT gross_amount_cents,commission_bps,settlement_method FROM drive_request_owner_payouts
              WHERE request_id=:request"""),
                {"request": request},
            )
            .mappings()
            .first()
        )
        if (
            ledger is None
            or ledger["gross_amount_cents"] != amount_cents
            or ledger["commission_bps"] != 300
            or ledger.get("settlement_method", "stripe_transfer") != settlement_method
        ):
            raise ValueError("payout_order_mismatch")
        return inserted.rowcount == 1

    @staticmethod
    def owner_projection(
        connection, *, request_id: str, owner_user_id: str
    ) -> dict[str, Any] | None:
        row = (
            connection.execute(
                text("""SELECT p.request_id,p.currency,p.gross_amount_cents,
                p.retained_amount_cents,p.platform_fee_cents,
                p.allocated_processing_fee_cents,p.owner_earning_cents,p.status,p.settlement_method
              FROM drive_request_owner_payouts p
              JOIN drive_request_payment_orders o ON o.request_id=p.request_id
              WHERE p.request_id=:request AND o.user_id=:owner AND p.erased_at IS NULL"""),
                {"request": str(UUID(str(request_id))), "owner": owner_user_id},
            )
            .mappings()
            .first()
        )
        if row is None:
            return None
        return {
            "requestId": str(row["request_id"]),
            "currency": row["currency"],
            "grossAmountCents": row["gross_amount_cents"],
            "retainedAmountCents": row["retained_amount_cents"],
            "platformFeeCents": row["platform_fee_cents"],
            "processingFeeCents": row["allocated_processing_fee_cents"],
            "ownerEarningCents": row["owner_earning_cents"],
            "settlementMethod": row["settlement_method"],
            "status": row["status"],
        }

    @staticmethod
    def mark_reversal_due(connection, *, request_id: str, reason: str) -> bool:
        """Called for a later full refund, dispute, or failed source charge."""
        if reason not in {"full_refund", "chargeback", "payment_failed", "external_reversal"}:
            raise ValueError("invalid reversal reason")
        row = (
            connection.execute(
                text("""SELECT status,owner_earning_cents,stripe_transfer_id,settlement_method FROM drive_request_owner_payouts
              WHERE request_id=:request FOR UPDATE"""),
                {"request": str(UUID(str(request_id)))},
            )
            .mappings()
            .first()
        )
        if row is not None and row.get("settlement_method") == "hashcoins":
            return HashcoinWalletService.reverse_earning(connection, request_id=request_id)
        if row is None or row["status"] in {"reversal_due", "reversal_unknown", "reversed", "void"}:
            return False
        if row["stripe_transfer_id"] is None or not row["owner_earning_cents"]:
            connection.execute(
                text("""UPDATE drive_request_owner_payouts SET status='manual_review',
                  reversal_amount_cents=owner_earning_cents,
                  safe_error_code='external_debit',updated_at=clock_timestamp()
                  WHERE request_id=:request"""),
                {"request": str(UUID(str(request_id)))},
            )
            return False
        connection.execute(
            text("""UPDATE drive_request_owner_payouts SET status='reversal_due',
              reversal_amount_cents=owner_earning_cents,next_check_at=clock_timestamp(),
              updated_at=clock_timestamp()
              WHERE request_id=:request"""),
            {"request": str(UUID(str(request_id)))},
        )
        return True

    @staticmethod
    def _delivery_summary(connection, request_id: str, requester_user_id: str) -> dict[str, int]:
        row = (
            connection.execute(
                text("""WITH file_outcomes AS (
                SELECT f.file_digest,
                  bool_or(e.state IN ('succeeded','preexisting')) AS confirmed,
                  bool_or(e.state IS NULL OR e.state NOT IN
                    ('succeeded','preexisting','skipped','failed','absent') OR
                    (e.state='failed' AND e.safe_error_code='permission_outcome_unknown'))
                    AS unsettled
                FROM drive_bulk_shares b
                JOIN drive_bulk_share_files f ON f.share_id=b.share_id
                JOIN drive_bulk_share_recipients recipient
                  ON recipient.share_id=b.share_id AND
                     recipient.recipient_user_id=:requester
                LEFT JOIN drive_bulk_share_effects e
                  ON e.share_id=f.share_id AND e.position=f.position AND
                     e.recipient_user_id=recipient.recipient_user_id
                WHERE b.origin_request_id=:request AND b.approved_at IS NOT NULL
                  AND (b.progressive_batch=FALSE OR f.origin_request_id=:request)
                GROUP BY f.file_digest
              ) SELECT COUNT(*) AS expected,
                COUNT(*) FILTER (WHERE confirmed) AS confirmed,
                COUNT(*) FILTER (WHERE unsettled) AS unsettled
              FROM file_outcomes"""),
                {"request": request_id, "requester": requester_user_id},
            )
            .mappings()
            .one()
        )
        return {key: int(row[key]) for key in ("expected", "confirmed", "unsettled")}

    def _advance_delivery(self, connection, request_id: str) -> str:
        # The same order as share/erasure/refund writers: shares, request,
        # order, obligation, refund, then payout.
        connection.execute(
            text("""SELECT share_id FROM drive_bulk_shares WHERE origin_request_id=:request
              ORDER BY share_id FOR UPDATE"""),
            {"request": request_id},
        ).all()
        request = self._row(
            connection,
            "SELECT * FROM drive_share_requests WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        order = self._row(
            connection,
            "SELECT * FROM drive_request_payment_orders WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        obligation = self._row(
            connection,
            "SELECT * FROM drive_request_payment_obligations WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        refund = self._row(
            connection,
            "SELECT * FROM drive_request_payment_refunds WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        payout = self._row(
            connection,
            "SELECT * FROM drive_request_owner_payouts WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        if payout is None or payout["status"] not in {"awaiting_delivery", "awaiting_refund"}:
            return "unchanged"
        if payout["status"] == "awaiting_refund" and payout["erased_at"] is not None:
            if (
                refund is None
                or refund["status"] != "succeeded"
                or refund["amount_cents"] != payout["refund_amount_cents"]
            ):
                return "held"
            target = (
                "void"
                if payout["retained_amount_cents"] == 0
                else "awaiting_fee"
                if _erased_settlement_valid(payout, obligation)
                else "manual_review"
            )
            connection.execute(
                text("""UPDATE drive_request_owner_payouts SET
              status=:status,safe_error_code=CASE WHEN :status='manual_review'
                THEN 'account_erased' ELSE NULL END,
              next_check_at=clock_timestamp(),updated_at=clock_timestamp()
              WHERE request_id=:request AND status='awaiting_refund'"""),
                {"request": request_id, "status": target},
            )
            return target
        if (
            request is None
            or order is None
            or obligation is None
            or payout["erased_at"] is not None
        ):
            return "held"
        # Full refunds deliberately preserve the charge's reconciliation fence.
        # Exact refund evidence may close a zero earning, but never authorize a
        # positive transfer or clear that fence. Refund and delivery workers can
        # finish in either order.
        full_refund_confirmed = bool(
            refund is not None
            and refund["status"] == "succeeded"
            and refund["stripe_refund_id"]
            and refund["amount_cents"] == payout["gross_amount_cents"]
            and order["status"] == obligation["status"] == "refunded"
            and order["stripe_mode"] == obligation["stripe_mode"] == payout["stripe_mode"]
            and order["stripe_payment_intent_id"]
            and order["stripe_payment_intent_id"] == obligation["stripe_payment_intent_id"]
            and (
                payout["stripe_payment_intent_id"] is None
                or payout["stripe_payment_intent_id"] == order["stripe_payment_intent_id"]
            )
            and order["amount_cents"] == obligation["amount_cents"] == payout["gross_amount_cents"]
        )
        if payout["status"] == "awaiting_delivery":
            if request["status"] not in _TERMINAL_REQUESTS or order["status"] not in {
                "paid",
                "refunded",
            }:
                return "held"
            if (
                order["reconciliation_required"] or obligation["reconciliation_required"]
            ) and not full_refund_confirmed:
                return "held"
            unresolved_batch = connection.execute(
                text("""SELECT EXISTS(SELECT 1 FROM drive_bulk_shares b
                  WHERE b.origin_request_id=:request AND b.status IN
                    ('review_ready','queued','running'))"""),
                {"request": request_id},
            ).scalar_one()
            if unresolved_batch:
                return "held"
            summary = self._delivery_summary(connection, request_id, request["recipient_user_id"])
            if summary["unsettled"]:
                return "held"
            amounts = delivery_amounts(
                gross_cents=payout["gross_amount_cents"],
                confirmed=summary["confirmed"],
                expected=summary["expected"],
                commission_bps=payout["commission_bps"],
            )
            if summary["expected"] == 0 and request["status"] != "no_match":
                return "held"
            if order["status"] == "refunded" and amounts["retained_amount_cents"] > 0:
                return "held"
            connection.execute(
                text("""UPDATE drive_request_owner_payouts SET
                  expected_files=:expected,confirmed_files=:confirmed,
                  retained_amount_cents=:retained,refund_amount_cents=:refund,
                  platform_fee_cents=:fee,finalized_at=clock_timestamp(),
                  status=CASE WHEN :refund>0 THEN 'awaiting_refund' ELSE 'awaiting_fee' END,
                  updated_at=clock_timestamp() WHERE request_id=:request
                    AND status='awaiting_delivery'"""),
                {
                    "request": request_id,
                    "expected": summary["expected"],
                    "confirmed": summary["confirmed"],
                    "retained": amounts["retained_amount_cents"],
                    "refund": amounts["refund_amount_cents"],
                    "fee": amounts["platform_fee_cents"],
                },
            )
            return "awaiting_refund" if amounts["refund_amount_cents"] else "awaiting_fee"
        if request["status"] not in _TERMINAL_REQUESTS or (
            (order["reconciliation_required"] or obligation["reconciliation_required"])
            and not (
                full_refund_confirmed
                and payout["retained_amount_cents"] == 0
                and payout["refund_amount_cents"] == payout["gross_amount_cents"]
            )
        ):
            return "held"
        if (
            refund is None
            or refund["status"] != "succeeded"
            or refund["amount_cents"] != payout["refund_amount_cents"]
        ):
            return "held"
        target = "void" if payout["retained_amount_cents"] == 0 else "awaiting_fee"
        connection.execute(
            text("""UPDATE drive_request_owner_payouts SET status=:status,
              next_check_at=clock_timestamp(),updated_at=clock_timestamp()
              WHERE request_id=:request AND status='awaiting_refund'"""),
            {"request": request_id, "status": target},
        )
        return target

    async def reconcile_due(self, *, max_orders: int = 20) -> dict[str, int]:
        if type(max_orders) is not int or not 1 <= max_orders <= 100:
            raise ValueError("invalid payout reconciliation bound")
        candidates = await self._transaction(
            lambda c: [
                str(row[0])
                for row in c.execute(
                    text("""SELECT request_id FROM drive_request_owner_payouts
              WHERE stripe_mode=:stripe_mode AND status IN ('awaiting_delivery','awaiting_refund')
              ORDER BY updated_at,request_id LIMIT :scan"""),
                    {"scan": max_orders * 4, "stripe_mode": configured_stripe_mode()},
                ).all()
            ]
        )
        outcomes = {
            "checked": 0,
            "awaiting_refund": 0,
            "awaiting_fee": 0,
            "void": 0,
            "manual_review": 0,
        }
        for request_id in candidates[:max_orders]:
            result = await self._transaction(
                lambda c, request_id=request_id: self._advance_delivery(c, request_id)
            )
            outcomes["checked"] += 1
            if result in outcomes:
                outcomes[result] += 1
            if result == "held":
                await self._transaction(
                    lambda c, request_id=request_id: c.execute(
                        text("""UPDATE drive_request_owner_payouts SET updated_at=clock_timestamp()
                      WHERE request_id=:request AND status IN
                        ('awaiting_delivery','awaiting_refund')"""),
                        {"request": request_id},
                    )
                )
        fee_count = await self.resolve_processing_fees(max_orders=max_orders)
        outcomes["fees_resolved"] = fee_count
        outcomes["coin_sources_checked"] = await self.reconcile_coin_sources(max_orders=max_orders)
        return outcomes

    async def resolve_processing_fees(self, *, max_orders: int = 20) -> int:
        if type(max_orders) is not int or not 1 <= max_orders <= 100:
            raise ValueError("invalid payout fee bound")
        claims = await self._transaction(
            lambda c: [
                dict(row)
                for row in c.execute(
                    text("""SELECT p.request_id,p.gross_amount_cents,p.retained_amount_cents,
                p.refund_amount_cents,p.platform_fee_cents,
                COALESCE(o.stripe_payment_intent_id,p.stripe_payment_intent_id)
                  AS stripe_payment_intent_id
              FROM drive_request_owner_payouts p
              JOIN drive_request_payment_obligations b ON b.request_id=p.request_id
              LEFT JOIN drive_request_payment_orders o ON o.request_id=p.request_id
              WHERE p.status='awaiting_fee' AND p.stripe_mode=:stripe_mode AND b.stripe_mode=p.stripe_mode
                AND p.next_check_at<=clock_timestamp()
                AND b.status='paid' AND b.reconciliation_required=FALSE
                AND ((p.erased_at IS NULL AND o.status='paid'
                  AND o.reconciliation_required=FALSE) OR
                  (p.erased_at IS NOT NULL AND o.request_id IS NULL
                  AND p.eligible_at_erasure=TRUE AND p.finalized_at IS NOT NULL
                  AND b.erased_at IS NOT NULL AND b.delivery_confirmed_at_erasure=TRUE
                  AND b.delivery_unsettled_at_erasure=FALSE
                  AND b.stripe_payment_intent_id=p.stripe_payment_intent_id))
              ORDER BY p.updated_at,p.request_id LIMIT :limit"""),
                    {"limit": max_orders, "stripe_mode": configured_stripe_mode()},
                )
                .mappings()
                .all()
            ]
        )
        if not claims:
            return 0
        key, _, _ = _config()
        resolved = 0
        for claim in claims:
            try:
                intent, charge, balance = await asyncio.to_thread(self._charge_and_fee, claim, key)
            except PayoutTransientError:
                await self._defer_fee(claim["request_id"])
                continue
            except ValueError:
                await self._transaction(
                    lambda c, claim=claim: c.execute(
                        text("""UPDATE drive_request_owner_payouts SET status='manual_review',
                      safe_error_code='charge_unavailable',updated_at=clock_timestamp()
                      WHERE request_id=:request AND status='awaiting_fee'"""),
                        {"request": claim["request_id"]},
                    )
                )
                continue
            except Exception:
                await self._defer_fee(claim["request_id"])
                continue
            result = await self._transaction(
                lambda c, claim=claim, intent=intent, charge=charge, balance=balance: (
                    self._finish_fee(c, claim, intent, charge, balance)
                )
            )
            resolved += bool(result)
        return resolved

    async def _defer_fee(self, request_id: str) -> None:
        await self._transaction(
            lambda c: c.execute(
                text("""UPDATE drive_request_owner_payouts SET
                  next_check_at=clock_timestamp()+interval '5 minutes',
                  updated_at=clock_timestamp()
                  WHERE request_id=:request AND status='awaiting_fee'"""),
                {"request": request_id},
            )
        )

    def _charge_and_fee(self, claim: dict, key: str) -> tuple[dict, dict, dict]:
        intent_id = _provider_id(claim["stripe_payment_intent_id"])
        if intent_id is None:
            raise ValueError("missing payment intent")
        intent = _stripe_dict(self.stripe_api.PaymentIntent.retrieve(intent_id, api_key=key))
        charge_id = _provider_id(intent.get("latest_charge"))
        if intent.get("id") != intent_id:
            raise ValueError("payment intent mismatch")
        if intent.get("status") != "succeeded" or charge_id is None:
            raise PayoutTransientError("unsettled payment intent")
        charge = _stripe_dict(self.stripe_api.Charge.retrieve(charge_id, api_key=key))
        if (
            charge.get("id") != charge_id
            or charge.get("payment_intent") != intent_id
            or charge.get("amount") != claim["gross_amount_cents"]
            or charge.get("transfer_group") != f"drive-request-{claim['request_id']}"
            or charge.get("currency") != "usd"
            or charge.get("paid") is not True
            or charge.get("captured") is not True
            or charge.get("disputed") is True
            or charge.get("amount_refunded") != claim["refund_amount_cents"]
            or charge.get("livemode") is not _provider_mode(key)
        ):
            raise ValueError("charge mismatch")
        balance_id = _provider_id(charge.get("balance_transaction"))
        if balance_id is None:
            raise PayoutTransientError("missing balance transaction")
        balance = _stripe_dict(self.stripe_api.BalanceTransaction.retrieve(balance_id, api_key=key))
        if balance.get("id") != balance_id or balance.get("currency") != "usd":
            raise ValueError("balance transaction mismatch")
        if type(balance.get("fee")) is not int:
            raise PayoutTransientError("missing processing fee")
        if balance["fee"] < 0:
            raise ValueError("invalid processing fee")
        return intent, charge, balance

    def _finish_fee(
        self, connection, claim: dict, intent: dict, charge: dict, balance: dict
    ) -> bool:
        order = self._row(
            connection,
            "SELECT * FROM drive_request_payment_orders WHERE request_id=:request FOR UPDATE",
            {"request": claim["request_id"]},
        )
        obligation = self._row(
            connection,
            "SELECT * FROM drive_request_payment_obligations WHERE request_id=:request FOR UPDATE",
            {"request": claim["request_id"]},
        )
        refund = self._row(
            connection,
            "SELECT status,amount_cents FROM drive_request_payment_refunds WHERE request_id=:request",
            {"request": claim["request_id"]},
        )
        payout = self._row(
            connection,
            "SELECT * FROM drive_request_owner_payouts WHERE request_id=:request FOR UPDATE",
            {"request": claim["request_id"]},
        )
        live_source = bool(
            payout is not None
            and payout["erased_at"] is None
            and order is not None
            and order["status"] == "paid"
            and not order["reconciliation_required"]
            and order["stripe_payment_intent_id"] == intent["id"]
        )
        erased_source = bool(
            payout is not None
            and order is None
            and _erased_settlement_valid(payout, obligation)
            and payout["stripe_payment_intent_id"] == intent["id"]
        )
        if (
            payout is None
            or payout["status"] != "awaiting_fee"
            or obligation is None
            or obligation["status"] != "paid"
            or obligation["reconciliation_required"]
            or obligation["stripe_payment_intent_id"] != intent["id"]
            or not (live_source or erased_source)
            or payout["gross_amount_cents"] != charge["amount"]
            or (
                payout["refund_amount_cents"] > 0
                and (
                    refund is None
                    or refund["status"] != "succeeded"
                    or refund["amount_cents"] != payout["refund_amount_cents"]
                )
            )
        ):
            return False
        amounts = fee_amounts(
            gross_cents=payout["gross_amount_cents"],
            retained_cents=payout["retained_amount_cents"],
            platform_fee_cents=payout["platform_fee_cents"],
            actual_processing_fee_cents=balance["fee"],
        )
        target = (
            ("hashcoins_credited" if payout.get("settlement_method") == "hashcoins" else "due")
            if amounts["owner_earning_cents"] > 0
            else "void"
        )
        connection.execute(
            text("""UPDATE drive_request_owner_payouts SET
              stripe_payment_intent_id=:intent,stripe_charge_id=:charge,
              stripe_balance_transaction_id=:balance,
              actual_processing_fee_cents=:actual,
              allocated_processing_fee_cents=:allocated,
              owner_earning_cents=:earning,status=:status,
              credited_at=CASE WHEN :status='hashcoins_credited' THEN clock_timestamp() ELSE credited_at END,
              next_check_at=clock_timestamp(),updated_at=clock_timestamp()
              WHERE request_id=:request AND status='awaiting_fee'"""),
            {
                "request": claim["request_id"],
                "intent": intent["id"],
                "charge": charge["id"],
                "balance": balance["id"],
                "actual": amounts["actual_processing_fee_cents"],
                "allocated": amounts["allocated_processing_fee_cents"],
                "earning": amounts["owner_earning_cents"],
                "status": target,
            },
        )
        if target == "hashcoins_credited":
            HashcoinWalletService.credit_earning(connection, request_id=str(claim["request_id"]))
        return True

    async def reconcile_coin_sources(self, *, max_orders: int = 20) -> int:
        if type(max_orders) is not int or not 1 <= max_orders <= 100:
            raise ValueError("invalid coin reconciliation bound")
        claims = await self._transaction(
            lambda c: [
                dict(row)
                for row in c.execute(
                    text("""
          SELECT * FROM drive_request_owner_payouts WHERE settlement_method='hashcoins'
          AND stripe_mode=:mode AND status IN ('hashcoins_credited','hashcoins_held')
          AND next_check_at<=clock_timestamp() ORDER BY next_check_at,request_id LIMIT :limit
          """),
                    {"mode": configured_stripe_mode(), "limit": max_orders},
                )
                .mappings()
                .all()
            ]
        )
        if not claims:
            return 0
        key, _, _ = _config()
        for claim in claims:
            try:
                charge = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.Charge.retrieve, claim["stripe_charge_id"], api_key=key
                    )
                )
                intent = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.PaymentIntent.retrieve,
                        claim["stripe_payment_intent_id"],
                        api_key=key,
                    )
                )
                dispute = None
                dispute_id = charge.get("dispute")
                if charge.get("disputed") is True and isinstance(dispute_id, str):
                    dispute = _stripe_dict(
                        await asyncio.to_thread(
                            self.stripe_api.Dispute.retrieve, dispute_id, api_key=key
                        )
                    )
                outcome = self._coin_source_outcome(claim, charge, intent, key, dispute)
            except Exception:
                outcome = "provider_unavailable"
            await self._transaction(
                lambda c, claim=claim, outcome=outcome: self._finish_coin_source_check(
                    c, str(claim["request_id"]), outcome
                )
            )
        return len(claims)

    @staticmethod
    def _coin_source_outcome(
        claim: dict, charge: dict, intent: dict, key: str, dispute: dict | None = None
    ) -> str:
        if (
            charge.get("id") != claim["stripe_charge_id"]
            or charge.get("payment_intent") != claim["stripe_payment_intent_id"]
            or charge.get("amount") != claim["gross_amount_cents"]
            or charge.get("currency") != "usd"
            or charge.get("livemode") is not _provider_mode(key)
            or intent.get("id") != claim["stripe_payment_intent_id"]
            or intent.get("livemode") is not _provider_mode(key)
        ):
            return "provider_mismatch"
        if (
            charge.get("paid") is not True
            or intent.get("status") != "succeeded"
            or charge.get("amount_refunded") == claim["gross_amount_cents"]
        ):
            return "reverse"
        if charge.get("amount_refunded") != claim["refund_amount_cents"]:
            return "refund_mismatch"
        if charge.get("disputed") is True:
            if (
                dispute is None
                or dispute.get("id") != charge.get("dispute")
                or dispute.get("charge") != charge.get("id")
                or dispute.get("livemode") is not _provider_mode(key)
            ):
                return "dispute_pending"
            if dispute.get("status") == "lost":
                return "reverse"
            if dispute.get("status") not in {"won", "warning_closed"}:
                return "dispute_pending"
        return "clear"

    def _finish_coin_source_check(self, connection, request_id: str, outcome: str) -> None:
        row = self._row(
            connection,
            """SELECT * FROM drive_request_owner_payouts
          WHERE request_id=:request FOR UPDATE""",
            {"request": request_id},
        )
        if row is None or row["status"] not in {"hashcoins_credited", "hashcoins_held"}:
            return
        if outcome == "reverse":
            HashcoinWalletService.reverse_earning(connection, request_id=request_id)
            return
        held = outcome in {"provider_mismatch", "refund_mismatch", "dispute_pending"}
        release = (
            outcome == "clear"
            and row["status"] == "hashcoins_held"
            and row["safe_error_code"] == "charge_unavailable"
        )
        hold_error = "charge_unavailable" if outcome == "dispute_pending" else outcome
        if row["status"] == "hashcoins_held" and row["safe_error_code"] in {
            "provider_mismatch",
            "refund_mismatch",
        }:
            # A later dispute poll must not overwrite a manual-review fence.
            hold_error = row["safe_error_code"]
        if held:
            connection.execute(
                text("""UPDATE hashcoin_wallets SET held=TRUE
              WHERE wallet_id IN (:wallet,:sandbox)"""),
                {"wallet": row["wallet_id"], "sandbox": row["sandbox_wallet_id"]},
            )
        connection.execute(
            text("""UPDATE drive_request_owner_payouts
          SET status=CASE WHEN :held THEN 'hashcoins_held'
              WHEN :release THEN 'hashcoins_credited' ELSE status END,
            safe_error_code=CASE WHEN :held THEN :error WHEN :release THEN NULL ELSE safe_error_code END,
            next_check_at=clock_timestamp()+interval '1 hour',updated_at=clock_timestamp()
          WHERE request_id=:request"""),
            {
                "request": request_id,
                "held": held,
                "release": release,
                "error": hold_error if held else None,
            },
        )
        if release:
            connection.execute(
                text("""UPDATE hashcoin_wallets w SET held=FALSE
              WHERE w.wallet_id IN (:wallet,:sandbox) AND w.erased_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM drive_request_owner_payouts p
                WHERE p.status='hashcoins_held' AND
                  (p.wallet_id=w.wallet_id OR p.sandbox_wallet_id=w.wallet_id))"""),
                {"wallet": row["wallet_id"], "sandbox": row["sandbox_wallet_id"]},
            )

    async def _adopt_production_transfer_accounts(self, request_ids: list[str]) -> None:
        """Existing live earnings must not wait for the owner to reopen Profile.

        Adoption only reads a legacy mapping and authenticates it with the live
        provider key. It never creates a replacement or crosses a mode boundary.
        """
        if stripe_environment() != "production" or configured_stripe_mode() != "live":
            return
        if not request_ids:
            return
        from hushh_mcp.services.pkm_packet_order_service import PacketOrderError
        from hushh_mcp.services.pkm_payout_service import PkmPayoutService

        owners = await self._transaction(
            lambda c: [
                str(row[0])
                for row in c.execute(
                    text("""SELECT DISTINCT r.user_id
                  FROM drive_request_owner_payouts p
                  JOIN drive_share_requests r ON r.request_id=p.request_id
                  LEFT JOIN stripe_owner_payout_accounts a
                    ON a.user_id=r.user_id AND a.stripe_mode='live'
                  WHERE p.request_id=ANY(CAST(:requests AS uuid[]))
                    AND p.stripe_mode='live' AND p.erased_at IS NULL
                    AND a.user_id IS NULL ORDER BY r.user_id LIMIT 5"""),
                    {"requests": request_ids[:400]},
                ).all()
            ]
        )
        service = PkmPayoutService(stripe_api=self.stripe_api)
        service._db = self.db
        for owner in owners:
            try:
                await service.refresh_account(owner)
            except PacketOrderError:
                continue  # Existing earning remains due for a later verified retry.

    async def transfer_due(self, *, max_orders: int = 20) -> dict[str, int]:
        if type(max_orders) is not int or not 1 <= max_orders <= 100:
            raise ValueError("invalid payout transfer bound")
        outcomes = {"claimed": 0, "transferred": 0, "unknown": 0, "manual_review": 0}
        # The switch controls enrollment and new Checkout. Once an earning is
        # enrolled and paid, disabling enrollment cannot strand that obligation.
        allow_new = True
        ids = await self._transaction(
            lambda c: [
                str(row[0])
                for row in c.execute(
                    text("""SELECT request_id FROM drive_request_owner_payouts
              WHERE stripe_mode=:stripe_mode AND settlement_method='stripe_transfer'
                AND (status IN ('dispatching','unknown') OR
                (:allow_new AND status IN ('due','awaiting_account')))
                AND next_check_at<=clock_timestamp()
                AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
              ORDER BY next_check_at,request_id LIMIT :limit"""),
                    {
                        "limit": max_orders * 4,
                        "allow_new": allow_new,
                        "stripe_mode": configured_stripe_mode(),
                    },
                ).all()
            ]
        )
        if not ids:
            return outcomes
        key, _, _ = _config()
        await self._adopt_production_transfer_accounts(ids)
        for request_id in ids:
            if outcomes["claimed"] >= max_orders:
                break
            claim = await self._transaction(
                lambda c, request_id=request_id: self._claim_transfer(
                    c, request_id, allow_new=allow_new
                )
            )
            if claim is None:
                continue
            outcomes["claimed"] += 1
            try:
                transfer, error = await asyncio.to_thread(self._provider_transfer, claim, key)
            except Exception:
                transfer, error = None, "provider_unavailable"
            result = await self._transaction(
                lambda c, claim=claim, transfer=transfer, error=error: self._finish_transfer(
                    c, claim, transfer, error
                )
            )
            if result in outcomes:
                outcomes[result] += 1
        return outcomes

    def _claim_transfer(
        self, connection, request_id: str, *, allow_new: bool = True
    ) -> dict[str, Any] | None:
        request = self._row(
            connection,
            "SELECT request_id,user_id,status FROM drive_share_requests WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        order = self._row(
            connection,
            "SELECT * FROM drive_request_payment_orders WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        obligation = self._row(
            connection,
            "SELECT * FROM drive_request_payment_obligations WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        refund = self._row(
            connection,
            "SELECT status,amount_cents FROM drive_request_payment_refunds WHERE request_id=:request",
            {"request": request_id},
        )
        payout = self._row(
            connection,
            "SELECT *, (lease_expires_at > clock_timestamp()) AS lease_active FROM drive_request_owner_payouts WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        if (
            payout is None
            or payout.get("stripe_mode") != configured_stripe_mode()
            or payout.get("settlement_method", "stripe_transfer") != "stripe_transfer"
        ):
            return None
        prior_attempt = bool(payout and payout["status"] in {"dispatching", "unknown"})
        live_source = bool(
            payout is not None
            and payout["erased_at"] is None
            and request is not None
            and order is not None
            and request["status"] in _TERMINAL_REQUESTS
            and order["status"] == "paid"
            and not order["reconciliation_required"]
            and obligation is not None
            and obligation["status"] == "paid"
            and not obligation["reconciliation_required"]
            and order["stripe_payment_intent_id"] == payout["stripe_payment_intent_id"]
            and obligation["stripe_payment_intent_id"] == payout["stripe_payment_intent_id"]
        )
        erased_source = bool(
            payout is not None
            and request is None
            and order is None
            and _erased_settlement_valid(payout, obligation)
        )
        if (
            payout is None
            or payout.get("lease_active") is True
            or payout["status"] not in {"due", "awaiting_account", "dispatching", "unknown"}
            or obligation is None
            or (not prior_attempt and not (live_source or erased_source))
            or (payout["erased_at"] is None and (request is None or order is None))
            or payout["owner_earning_cents"] is None
            or payout["owner_earning_cents"] <= 0
            or payout["stripe_charge_id"] is None
        ):
            return None
        if (
            not prior_attempt
            and payout["refund_amount_cents"]
            and (
                refund is None
                or refund["status"] != "succeeded"
                or refund["amount_cents"] != payout["refund_amount_cents"]
            )
        ):
            return None
        refund_confirmed = payout["refund_amount_cents"] == 0 or bool(
            refund is not None
            and refund["status"] == "succeeded"
            and refund["amount_cents"] == payout["refund_amount_cents"]
        )
        account = (
            self._row(
                connection,
                "SELECT * FROM stripe_owner_payout_accounts WHERE user_id=:owner AND stripe_mode=:stripe_mode",
                {"owner": request["user_id"], "stripe_mode": configured_stripe_mode()},
            )
            if request is not None and payout["erased_at"] is None
            else None
        )
        fresh = payout["status"] in {"due", "awaiting_account"}
        if fresh and not allow_new:
            return None
        if (
            fresh
            and payout["erased_at"] is None
            and (
                account is None
                or not account["details_submitted"]
                or not account["payouts_enabled"]
            )
        ):
            connection.execute(
                text("""UPDATE drive_request_owner_payouts SET
              status='awaiting_account',safe_error_code='account_unavailable',
              next_check_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
              WHERE request_id=:request AND status IN ('due','awaiting_account')"""),
                {"request": request_id},
            )
            return None
        destination = payout["destination_account_id"] or (
            account["stripe_account_id"] if account else None
        )
        if destination is None:
            if payout["erased_at"] is not None:
                connection.execute(
                    text("""UPDATE drive_request_owner_payouts SET
                  status='manual_review',safe_error_code='account_unavailable',
                  updated_at=clock_timestamp() WHERE request_id=:request"""),
                    {"request": request_id},
                )
            return None
        if (
            fresh
            and payout["destination_account_id"]
            and account is not None
            and destination != account["stripe_account_id"]
        ):
            connection.execute(
                text("""UPDATE drive_request_owner_payouts SET
              status='manual_review',safe_error_code='provider_mismatch',updated_at=clock_timestamp()
              WHERE request_id=:request"""),
                {"request": request_id},
            )
            return None
        # Each lease owns its completion. Stripe's request-scoped idempotency
        # key stays stable, while a slow older worker cannot overwrite a retry.
        attempt = str(uuid4())
        row = self._row(
            connection,
            """UPDATE drive_request_owner_payouts SET status='dispatching',
              destination_account_id=:destination,transfer_attempt_id=:attempt,
              first_dispatch_at=COALESCE(first_dispatch_at,clock_timestamp()),
              lease_expires_at=clock_timestamp()+interval '2 minutes',
              next_check_at=clock_timestamp()+interval '2 minutes',
              safe_error_code=NULL,updated_at=clock_timestamp()
              WHERE request_id=:request RETURNING *""",
            {"request": request_id, "destination": destination, "attempt": attempt},
        )
        if row is None:
            return None
        source_valid = live_source or erased_source
        return {
            **row,
            "first_transfer_attempt": payout.get("first_dispatch_at") is None,
            "must_reverse": bool(
                obligation["status"] == "refunded"
                or (order is not None and order["status"] == "refunded")
            ),
            "force_manual_review": bool(not source_valid or not refund_confirmed),
            "create_allowed": bool(
                allow_new
                and source_valid
                and refund_confirmed
                and (
                    erased_source
                    or (
                        account is not None
                        and account["details_submitted"]
                        and account["payouts_enabled"]
                        and destination == account["stripe_account_id"]
                    )
                )
            ),
        }

    def _provider_transfer(self, claim: dict, key: str) -> tuple[dict | None, str | None]:
        request_id = str(claim["request_id"])
        group = f"drive-request-{request_id}"
        existing = _stripe_dict(
            self.stripe_api.Transfer.list(transfer_group=group, limit=100, api_key=key)
        )
        if existing.get("has_more"):
            return None, "provider_mismatch"
        transfers = [_stripe_dict(item) for item in (existing.get("data") or [])]
        if transfers:
            matches = [
                item for item in transfers if self._transfer_matches(item, claim, key, group)
            ]
            return (
                (matches[0], None)
                if len(transfers) == len(matches) == 1
                else (None, "provider_mismatch")
            )
        if not claim.get("create_allowed"):
            return None, "account_unavailable"
        if not _retry_open(claim["first_dispatch_at"]):
            return None, "idempotency_window_elapsed"
        account = _stripe_dict(
            self.stripe_api.Account.retrieve(claim["destination_account_id"], api_key=key)
        )
        from hushh_mcp.services.pkm_payout_service import _account_readiness

        if (
            account.get("id") != claim["destination_account_id"]
            or not _account_readiness(account)["ready"]
        ):
            return None, "account_unavailable"
        intent = _stripe_dict(
            self.stripe_api.PaymentIntent.retrieve(claim["stripe_payment_intent_id"], api_key=key)
        )
        if (
            intent.get("id") != claim["stripe_payment_intent_id"]
            or intent.get("status") != "succeeded"
            or intent.get("latest_charge") != claim["stripe_charge_id"]
            or intent.get("livemode") is not _provider_mode(key)
        ):
            return None, "charge_unavailable"
        charge = _stripe_dict(
            self.stripe_api.Charge.retrieve(claim["stripe_charge_id"], api_key=key)
        )
        if (
            charge.get("id") != claim["stripe_charge_id"]
            or charge.get("payment_intent") != claim["stripe_payment_intent_id"]
            or charge.get("amount") != claim["gross_amount_cents"]
            or charge.get("amount_refunded") != claim["refund_amount_cents"]
            or charge.get("currency") != "usd"
            or charge.get("paid") is not True
            or charge.get("captured") is not True
            or charge.get("disputed") is True
            or charge.get("livemode") is not _provider_mode(key)
            or charge.get("balance_transaction") != claim["stripe_balance_transaction_id"]
            or charge.get("transfer_group") != group
        ):
            return None, "charge_unavailable"
        transfer = _stripe_dict(
            self.stripe_api.Transfer.create(
                amount=claim["owner_earning_cents"],
                currency="usd",
                destination=claim["destination_account_id"],
                source_transaction=claim["stripe_charge_id"],
                transfer_group=group,
                metadata={"payment_kind": "drive_request_owner_payout", "request_id": request_id},
                api_key=key,
                idempotency_key=f"drive-owner-transfer:{request_id}",
            )
        )
        return (
            (transfer, None)
            if self._transfer_matches(transfer, claim, key, group)
            else (None, "provider_mismatch")
        )

    @staticmethod
    def _transfer_matches(
        item: dict, claim: dict, key: str, group: str, *, allow_reversed: bool = False
    ) -> bool:
        return bool(
            _provider_id(item.get("id"))
            and item.get("amount") == claim["owner_earning_cents"]
            and item.get("currency") == "usd"
            and item.get("destination") == claim["destination_account_id"]
            and item.get("source_transaction") == claim["stripe_charge_id"]
            and item.get("transfer_group") == group
            and item.get("livemode") is _provider_mode(key)
            and type(item.get("reversed")) is bool
            and type(item.get("amount_reversed")) is int
            and (
                allow_reversed
                or (item.get("reversed") is False and item.get("amount_reversed") == 0)
            )
        )

    def _finish_transfer(
        self, connection, claim: dict, transfer: dict | None, error: str | None
    ) -> str:
        request = self._row(
            connection,
            "SELECT status FROM drive_share_requests WHERE request_id=:request FOR UPDATE",
            {"request": claim["request_id"]},
        )
        order = self._row(
            connection,
            "SELECT status,reconciliation_required,stripe_payment_intent_id FROM drive_request_payment_orders WHERE request_id=:request FOR UPDATE",
            {"request": claim["request_id"]},
        )
        obligation = self._row(
            connection,
            "SELECT * FROM drive_request_payment_obligations WHERE request_id=:request FOR UPDATE",
            {"request": claim["request_id"]},
        )
        refund = self._row(
            connection,
            "SELECT status,amount_cents FROM drive_request_payment_refunds WHERE request_id=:request FOR UPDATE",
            {"request": claim["request_id"]},
        )
        payout = self._row(
            connection,
            "SELECT * FROM drive_request_owner_payouts WHERE request_id=:request FOR UPDATE",
            {"request": claim["request_id"]},
        )
        if payout is None or str(payout["transfer_attempt_id"]) != str(
            claim["transfer_attempt_id"]
        ):
            return "manual_review"
        refund_confirmed = payout["refund_amount_cents"] == 0 or bool(
            refund is not None
            and refund["status"] == "succeeded"
            and refund["amount_cents"] == payout["refund_amount_cents"]
        )
        live_valid = bool(
            payout["erased_at"] is None
            and request is not None
            and request["status"] in _TERMINAL_REQUESTS
            and order is not None
            and order["status"] == "paid"
            and not order["reconciliation_required"]
            and obligation is not None
            and obligation["status"] == "paid"
            and not obligation["reconciliation_required"]
            and order["stripe_payment_intent_id"] == payout["stripe_payment_intent_id"]
            and obligation["stripe_payment_intent_id"] == payout["stripe_payment_intent_id"]
        )
        erased_valid = bool(
            request is None and order is None and _erased_settlement_valid(payout, obligation)
        )
        source_held = not (refund_confirmed and (live_valid or erased_valid))
        source_refunded = obligation is not None and obligation["status"] == "refunded"
        if transfer is not None:
            target = (
                "reversal_due"
                if payout["reversal_amount_cents"] or claim.get("must_reverse") or source_refunded
                else "manual_review"
                if source_held
                or payout["status"] == "manual_review"
                or claim.get("force_manual_review")
                else "transferred"
            )
            connection.execute(
                text("""UPDATE drive_request_owner_payouts SET
              status=:status,stripe_transfer_id=:transfer,transferred_at=clock_timestamp(),
              reversal_amount_cents=CASE WHEN :status='reversal_due' THEN
                owner_earning_cents ELSE reversal_amount_cents END,
              lease_expires_at=NULL,safe_error_code=CASE WHEN :status='transferred' THEN NULL
                ELSE safe_error_code END,
              next_check_at=CASE WHEN :status='transferred' THEN
                clock_timestamp()+interval '24 hours' ELSE clock_timestamp() END,
              updated_at=clock_timestamp()
              WHERE request_id=:request"""),
                {"request": claim["request_id"], "status": target, "transfer": transfer["id"]},
            )
            return target
        if payout["status"] == "manual_review" or payout["reversal_amount_cents"] or source_held:
            connection.execute(
                text("""UPDATE drive_request_owner_payouts SET
              status='manual_review',lease_expires_at=NULL,updated_at=clock_timestamp()
              WHERE request_id=:request"""),
                {"request": claim["request_id"]},
            )
            return "manual_review"
        target = (
            "manual_review"
            if error in {"provider_mismatch", "idempotency_window_elapsed", "charge_unavailable"}
            or not _retry_open(payout["first_dispatch_at"])
            else "unknown"
        )
        if (
            error == "account_unavailable"
            and payout["erased_at"] is None
            and claim.get("create_allowed")
        ):
            target = "awaiting_account"
        # The first claim may discover restricted banking before any transfer
        # write. That owner's setup time must not consume Stripe's retry window.
        # A prior uncertain attempt is never reset, even if a later read is empty.
        clear_unused_attempt = bool(
            target == "awaiting_account" and claim.get("first_transfer_attempt") is True
        )
        connection.execute(
            text("""UPDATE drive_request_owner_payouts SET
          status=:status,safe_error_code=:error,lease_expires_at=NULL,
          first_dispatch_at=CASE WHEN :clear_attempt THEN NULL ELSE first_dispatch_at END,
          transfer_attempt_id=CASE WHEN :clear_attempt THEN NULL ELSE transfer_attempt_id END,
          next_check_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
          WHERE request_id=:request"""),
            {
                "request": claim["request_id"],
                "status": target,
                "error": error or "provider_unavailable",
                "clear_attempt": clear_unused_attempt,
            },
        )
        return target

    async def reconcile_external_debits(self, *, max_orders: int = 20) -> dict[str, int]:
        """Rotate transferred charges daily for later refunds and disputes."""
        if type(max_orders) is not int or not 1 <= max_orders <= 100:
            raise ValueError("invalid external debit bound")
        ids = await self._transaction(
            lambda c: [
                str(row[0])
                for row in c.execute(
                    text("""SELECT request_id FROM drive_request_owner_payouts
              WHERE stripe_mode=:stripe_mode AND status IN ('transferred','manual_review')
                AND stripe_transfer_id IS NOT NULL
                AND stripe_charge_id IS NOT NULL
                AND stripe_payment_intent_id IS NOT NULL
                AND next_check_at<=clock_timestamp()
              ORDER BY next_check_at,request_id LIMIT :limit"""),
                    {"limit": max_orders, "stripe_mode": configured_stripe_mode()},
                ).all()
            ]
        )
        outcomes = {"checked": 0, "reversal_due": 0, "manual_review": 0}
        if not ids:
            return outcomes
        key, _, _ = _config()
        for request_id in ids:
            claim = await self._transaction(
                lambda c, request_id=request_id: self._row(
                    c,
                    """SELECT request_id,status,gross_amount_cents,refund_amount_cents,
                    owner_earning_cents,destination_account_id,stripe_transfer_id,
                    stripe_charge_id,stripe_payment_intent_id
                  FROM drive_request_owner_payouts WHERE request_id=:request""",
                    {"request": request_id},
                )
            )
            if claim is None or claim["status"] not in {"transferred", "manual_review"}:
                continue
            try:
                charge = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.Charge.retrieve, claim["stripe_charge_id"], api_key=key
                    )
                )
                intent = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.PaymentIntent.retrieve,
                        claim["stripe_payment_intent_id"],
                        api_key=key,
                    )
                )
                transfer = _stripe_dict(
                    await asyncio.to_thread(
                        self.stripe_api.Transfer.retrieve,
                        claim["stripe_transfer_id"],
                        api_key=key,
                    )
                )
                outcome = self._external_debit_outcome(claim, charge, intent, transfer, key)
            except Exception:
                outcome = "provider_unavailable"
            result = await self._transaction(
                lambda c, request_id=request_id, outcome=outcome: self._finish_external_debit_check(
                    c, request_id, outcome
                )
            )
            outcomes["checked"] += 1
            if result in outcomes:
                outcomes[result] += 1
        return outcomes

    @staticmethod
    def _external_debit_outcome(
        claim: dict, charge: dict, intent: dict, transfer: dict, key: str
    ) -> str:
        if (
            charge.get("id") != claim["stripe_charge_id"]
            or charge.get("payment_intent") != claim["stripe_payment_intent_id"]
            or charge.get("amount") != claim["gross_amount_cents"]
            or charge.get("currency") != "usd"
            or charge.get("livemode") is not _provider_mode(key)
            or intent.get("id") != claim["stripe_payment_intent_id"]
            or intent.get("livemode") is not _provider_mode(key)
        ):
            return "provider_mismatch"
        if not DriveRequestOwnerPayoutService._transfer_matches(
            transfer, claim, key, f"drive-request-{claim['request_id']}", allow_reversed=True
        ):
            return "provider_mismatch"
        amount_reversed = transfer.get("amount_reversed")
        if (
            type(amount_reversed) is not int
            or not 0 <= amount_reversed <= claim["owner_earning_cents"]
        ):
            return "provider_mismatch"
        if transfer.get("reversed") is True or amount_reversed > 0:
            return "external_reversal"
        if charge.get("disputed") is True:
            return "chargeback"
        if charge.get("amount_refunded") == claim["gross_amount_cents"]:
            return "full_refund"
        if charge.get("paid") is not True or intent.get("status") != "succeeded":
            return "payment_failed"
        if charge.get("amount_refunded") != claim["refund_amount_cents"]:
            return "refund_mismatch"
        return "clear"

    def _finish_external_debit_check(self, connection, request_id: str, outcome: str) -> str:
        row = self._row(
            connection,
            "SELECT status FROM drive_request_owner_payouts WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        if row is None or row["status"] not in {"transferred", "manual_review"}:
            return "unchanged"
        if outcome in {"chargeback", "full_refund", "payment_failed", "external_reversal"}:
            self.mark_reversal_due(connection, request_id=request_id, reason=outcome)
            return "reversal_due"
        if outcome in {"provider_mismatch", "refund_mismatch"}:
            connection.execute(
                text("""UPDATE drive_request_owner_payouts SET
              status='manual_review',safe_error_code=:error,
              next_check_at=clock_timestamp()+interval '24 hours',updated_at=clock_timestamp()
              WHERE request_id=:request"""),
                {
                    "request": request_id,
                    "error": "provider_mismatch"
                    if outcome == "provider_mismatch"
                    else "refund_mismatch",
                },
            )
            return "manual_review"
        interval = "1 hour" if outcome == "provider_unavailable" else "24 hours"
        connection.execute(
            text("""UPDATE drive_request_owner_payouts SET
          next_check_at=clock_timestamp()+CAST(:interval AS interval),
          safe_error_code=CASE WHEN status='manual_review' THEN safe_error_code
            WHEN :interval='1 hour' THEN 'provider_unavailable' ELSE NULL END,
          updated_at=clock_timestamp() WHERE request_id=:request"""),
            {"request": request_id, "interval": interval},
        )
        return "unchanged"

    async def reconcile_reversals(self, *, max_orders: int = 20) -> dict[str, int]:
        if type(max_orders) is not int or not 1 <= max_orders <= 100:
            raise ValueError("invalid reversal bound")
        ids = await self._transaction(
            lambda c: [
                str(row[0])
                for row in c.execute(
                    text("""SELECT request_id FROM drive_request_owner_payouts
              WHERE stripe_mode=:stripe_mode AND status IN ('reversal_due','reversal_unknown')
                AND next_check_at<=clock_timestamp()
                AND (reversal_lease_expires_at IS NULL OR
                     reversal_lease_expires_at<=clock_timestamp())
              ORDER BY next_check_at,request_id LIMIT :limit"""),
                    {"limit": max_orders, "stripe_mode": configured_stripe_mode()},
                ).all()
            ]
        )
        outcomes = {"claimed": 0, "reversed": 0, "reversal_unknown": 0, "manual_review": 0}
        if not ids:
            return outcomes
        key, _, _ = _config()
        for request_id in ids:
            claim = await self._transaction(
                lambda c, request_id=request_id: self._claim_reversal(c, request_id)
            )
            if claim is None:
                continue
            outcomes["claimed"] += 1
            try:
                reversal, error = await asyncio.to_thread(self._provider_reversal, claim, key)
            except Exception:
                reversal, error = None, "provider_unavailable"
            result = await self._transaction(
                lambda c, claim=claim, reversal=reversal, error=error: self._finish_reversal(
                    c, claim, reversal, error
                )
            )
            if result in outcomes:
                outcomes[result] += 1
        return outcomes

    def _claim_reversal(self, connection, request_id: str) -> dict | None:
        payout = self._row(
            connection,
            "SELECT * FROM drive_request_owner_payouts WHERE request_id=:request FOR UPDATE",
            {"request": request_id},
        )
        if (
            payout is None
            or payout.get("stripe_mode") != configured_stripe_mode()
            or payout["status"] not in {"reversal_due", "reversal_unknown"}
            or payout["stripe_transfer_id"] is None
            or not payout["reversal_amount_cents"]
        ):
            return None
        attempt = str(payout["reversal_attempt_id"] or uuid4())
        return self._row(
            connection,
            """UPDATE drive_request_owner_payouts SET status='reversal_unknown',
              reversal_attempt_id=:attempt,
              reversal_first_dispatch_at=COALESCE(reversal_first_dispatch_at,clock_timestamp()),
              reversal_lease_expires_at=clock_timestamp()+interval '2 minutes',
              next_check_at=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp()
              WHERE request_id=:request RETURNING *""",
            {"request": request_id, "attempt": attempt},
        )

    def _provider_reversal(self, claim: dict, key: str) -> tuple[dict | None, str | None]:
        transfer = _stripe_dict(
            self.stripe_api.Transfer.retrieve(claim["stripe_transfer_id"], api_key=key)
        )
        if not self._transfer_matches(
            transfer, claim, key, f"drive-request-{claim['request_id']}", allow_reversed=True
        ):
            return None, "provider_mismatch"
        listed = _stripe_dict(
            self.stripe_api.Transfer.list_reversals(
                claim["stripe_transfer_id"], limit=100, api_key=key
            )
        )
        if listed.get("has_more"):
            return None, "provider_mismatch"
        reversals = [_stripe_dict(item) for item in (listed.get("data") or [])]
        if reversals:
            matches = [item for item in reversals if self._reversal_matches(item, claim)]
            return (
                (matches[0], None)
                if len(reversals) == len(matches) == 1
                else (None, "provider_mismatch")
            )
        if transfer.get("reversed") is True or transfer.get("amount_reversed") != 0:
            return None, "provider_mismatch"
        if not _retry_open(claim["reversal_first_dispatch_at"]):
            return None, "idempotency_window_elapsed"
        reversal = _stripe_dict(
            self.stripe_api.Transfer.create_reversal(
                claim["stripe_transfer_id"],
                amount=claim["reversal_amount_cents"],
                metadata={
                    "payment_kind": "drive_request_owner_reversal",
                    "request_id": str(claim["request_id"]),
                },
                api_key=key,
                idempotency_key=f"drive-owner-reversal:{claim['request_id']}",
            )
        )
        return (
            (reversal, None)
            if self._reversal_matches(reversal, claim)
            else (None, "provider_mismatch")
        )

    @staticmethod
    def _reversal_matches(item: dict, claim: dict) -> bool:
        return bool(
            _provider_id(item.get("id"))
            and item.get("transfer") == claim["stripe_transfer_id"]
            and item.get("amount") == claim["reversal_amount_cents"]
            and item.get("currency") == "usd"
        )

    def _finish_reversal(
        self, connection, claim: dict, reversal: dict | None, error: str | None
    ) -> str:
        payout = self._row(
            connection,
            "SELECT * FROM drive_request_owner_payouts WHERE request_id=:request FOR UPDATE",
            {"request": claim["request_id"]},
        )
        if payout is None or str(payout["reversal_attempt_id"]) != str(
            claim["reversal_attempt_id"]
        ):
            return "manual_review"
        if reversal is not None:
            connection.execute(
                text("""UPDATE drive_request_owner_payouts SET
              status='reversed',stripe_reversal_id=:reversal,reversed_at=clock_timestamp(),
              reversal_lease_expires_at=NULL,safe_error_code=NULL,updated_at=clock_timestamp()
              WHERE request_id=:request"""),
                {"request": claim["request_id"], "reversal": reversal["id"]},
            )
            return "reversed"
        target = (
            "manual_review"
            if error in {"provider_mismatch", "idempotency_window_elapsed"}
            or not _retry_open(payout["reversal_first_dispatch_at"])
            else "reversal_unknown"
        )
        connection.execute(
            text("""UPDATE drive_request_owner_payouts SET
          status=:status,safe_error_code=:error,reversal_lease_expires_at=NULL,
          next_check_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
          WHERE request_id=:request"""),
            {
                "request": claim["request_id"],
                "status": target,
                "error": error or "provider_unavailable",
            },
        )
        return target
