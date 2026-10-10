"""Bounded drain workers for the paid-answer lane.

Three obligations that must outlive a single request, registered on the
existing Drive work drain rather than a new runner:

* **timeouts** -- a paid answer past its quoted deadline expires and files a
  refund. Without this the deadline shown before checkout is decorative.
* **refunds** -- a refund is a durable row claimed under a lease and retried
  on its own schedule. A Stripe outage delays it; it never loses it.
* **payouts** -- the owner's earning for a delivered answer, 300 bps
  commission, mirroring the Drive lane.

Every worker is bounded (`max_jobs`), claims with `FOR UPDATE SKIP LOCKED`
under a lease, and is safe to run concurrently with another drain: two
instances cannot claim the same row, and a crashed instance's lease expires so
the row returns rather than sticking.

No provider message is ever written to the database. Failures collapse to a
closed `safe_error_code` set.
"""

from __future__ import annotations

import logging
from typing import Any

import stripe
from sqlalchemy import text

from hushh_mcp.services.drive_request_payment_service import _config, _stripe_dict
from hushh_mcp.services.external_connector_lifecycle_store import (
    ExternalConnectorLifecycleStore,
)
from hushh_mcp.services.pkm_answer_payment_service import answer_payments_enabled

logger = logging.getLogger(__name__)

LEASE_SECONDS = 90
RETRY_BACKOFF_SECONDS = 300
MAX_REFUND_ATTEMPTS = 8
MAX_PAYOUT_ATTEMPTS = 8
COMMISSION_BPS = 300


def _owner_earning_cents(gross: int) -> int:
    """Gross minus the platform commission, floored at zero."""
    return max(0, gross - (gross * COMMISSION_BPS) // 10_000)


class PkmAnswerWorkWorker(ExternalConnectorLifecycleStore):
    def __init__(self, db=None, *, stripe_api=None):
        super().__init__(db)
        self.stripe_api = stripe_api or stripe

    # -------------------------------------------------------------- timeouts

    async def run_timeouts(self, *, max_jobs: int = 4) -> dict[str, int]:
        """Expire overdue answers and file their refunds.

        The expiry and the refund row are written in one transaction, so a
        request can never be marked expired without the obligation to refund it
        existing beside it.
        """
        if not answer_payments_enabled():
            return {"disabled": 1}

        def claim(connection) -> int:
            rows = (
                connection.execute(
                    text(
                        """UPDATE pkm_answer_requests SET status = 'expired',
                               updated_at = clock_timestamp()
                           WHERE request_id IN (
                             SELECT r.request_id FROM pkm_answer_requests r
                             WHERE r.status = 'answering'
                               AND r.answer_deadline_at IS NOT NULL
                               AND r.answer_deadline_at < clock_timestamp()
                               AND NOT EXISTS (
                                 SELECT 1 FROM pkm_answer_deliveries d
                                 WHERE d.request_id = r.request_id)
                             ORDER BY r.answer_deadline_at
                             LIMIT :limit FOR UPDATE SKIP LOCKED)
                           RETURNING request_id"""
                    ),
                    {"limit": max(1, min(int(max_jobs), 25))},
                )
                .mappings()
                .all()
            )
            filed = 0
            for row in rows:
                filed += _file_refund(connection, str(row["request_id"]), "answer_timeout")
            return filed

        filed = await self._transaction(claim)
        return {"expired": filed, "refunds_filed": filed}

    # --------------------------------------------------------------- refunds

    async def run_refunds(self, *, max_jobs: int = 4) -> dict[str, int]:
        """Dispatch due refunds, retrying failures under a lease."""
        if not answer_payments_enabled():
            return {"disabled": 1}
        try:
            key, _secret, _origin = _config()
        except Exception:  # noqa: BLE001 - unconfigured Stripe is not an error here
            return {"disabled": 1}

        claimed = await self._transaction(lambda connection: _claim_refunds(connection, max_jobs))
        outcomes = {"succeeded": 0, "retried": 0, "manual_review": 0}

        for row in claimed:
            request_id = str(row["request_id"])
            intent = row["stripe_payment_intent_id"]
            try:
                refund = _stripe_dict(
                    self.stripe_api.Refund.create(
                        payment_intent=intent,
                        api_key=key,
                        # Stable per request: a retry can never double-refund.
                        idempotency_key=f"pkm-answer-refund-{request_id}",
                    )
                )
                await self._transaction(
                    lambda connection, r=refund, rid=request_id: _settle_refund(
                        connection, rid, r.get("id")
                    )
                )
                outcomes["succeeded"] += 1
            except Exception as error:  # noqa: BLE001 - provider failure, closed code only
                code = _safe_refund_error(error)
                terminal = (row["attempts"] or 0) + 1 >= MAX_REFUND_ATTEMPTS
                await self._transaction(
                    lambda connection, rid=request_id, c=code, t=terminal: _defer_refund(
                        connection, rid, c, t
                    )
                )
                outcomes["manual_review" if terminal else "retried"] += 1
                logger.warning("answer_refund.deferred request=%s code=%s", request_id, code)

        return outcomes

    # --------------------------------------------------------------- payouts

    async def run_payouts(self, *, max_jobs: int = 4) -> dict[str, int]:
        """Transfer delivered answers' earnings to the owner's Connect account."""
        if not answer_payments_enabled():
            return {"disabled": 1}
        try:
            key, _secret, _origin = _config()
        except Exception:  # noqa: BLE001
            return {"disabled": 1}

        await self._transaction(_promote_due_payouts)
        claimed = await self._transaction(lambda connection: _claim_payouts(connection, max_jobs))
        outcomes = {"transferred": 0, "retried": 0, "awaiting_account": 0}

        for row in claimed:
            request_id = str(row["request_id"])
            destination = row["destination_account_id"]
            if not destination:
                await self._transaction(
                    lambda connection, rid=request_id: _await_account(connection, rid)
                )
                outcomes["awaiting_account"] += 1
                continue
            try:
                transfer = _stripe_dict(
                    self.stripe_api.Transfer.create(
                        amount=int(row["owner_earning_cents"]),
                        currency=row["currency"],
                        destination=destination,
                        api_key=key,
                        idempotency_key=f"pkm-answer-transfer-{row['transfer_attempt_id']}",
                    )
                )
                await self._transaction(
                    lambda connection, t=transfer, rid=request_id: _settle_payout(
                        connection, rid, t.get("id")
                    )
                )
                outcomes["transferred"] += 1
            except Exception as error:  # noqa: BLE001
                code = _safe_payout_error(error)
                terminal = (row["attempts"] or 0) + 1 >= MAX_PAYOUT_ATTEMPTS
                await self._transaction(
                    lambda connection, rid=request_id, c=code, t=terminal: _defer_payout(
                        connection, rid, c, t
                    )
                )
                outcomes["retried"] += 1
                logger.warning("answer_payout.deferred request=%s code=%s", request_id, code)

        return outcomes


# ------------------------------------------------------------- SQL helpers --


def file_refund(connection, request_id: str, reason: str) -> int:
    """Public entry point so request-time paths file the same durable row."""
    return _file_refund(connection, request_id, reason)


def _file_refund(connection, request_id: str, reason: str) -> int:
    """Record the obligation to refund. Idempotent per request."""
    result = connection.execute(
        text(
            """INSERT INTO pkm_answer_payment_refunds (request_id, reason)
               SELECT :request, :reason
               WHERE EXISTS (
                 SELECT 1 FROM pkm_answer_payment_orders
                 WHERE request_id = :request AND status = 'paid')
               ON CONFLICT (request_id) DO NOTHING
               RETURNING request_id"""
        ),
        {"request": request_id, "reason": reason},
    ).first()
    if result is None:
        return 0
    # A refunded answer earns nothing.
    connection.execute(
        text(
            """UPDATE pkm_answer_owner_payouts
               SET status = 'void', owner_earning_cents = NULL,
                   updated_at = clock_timestamp()
               WHERE request_id = :request AND status <> 'transferred'"""
        ),
        {"request": request_id},
    )
    return 1


def _claim_refunds(connection, max_jobs: int) -> list[dict[str, Any]]:
    return [
        dict(row)
        for row in connection.execute(
            text(
                """UPDATE pkm_answer_payment_refunds SET
                       status = 'dispatching',
                       first_dispatch_at = COALESCE(first_dispatch_at, clock_timestamp()),
                       lease_expires_at = clock_timestamp()
                           + make_interval(secs => :lease),
                       attempts = attempts + 1,
                       updated_at = clock_timestamp()
                   WHERE request_id IN (
                     SELECT request_id FROM pkm_answer_payment_refunds
                     WHERE status IN ('queued', 'dispatching', 'unknown', 'pending')
                       AND next_check_at <= clock_timestamp()
                       AND (lease_expires_at IS NULL
                            OR lease_expires_at < clock_timestamp())
                     ORDER BY next_check_at
                     LIMIT :limit FOR UPDATE SKIP LOCKED)
                   RETURNING request_id, attempts,
                     (SELECT stripe_payment_intent_id FROM pkm_answer_payment_orders o
                      WHERE o.request_id = pkm_answer_payment_refunds.request_id)
                       AS stripe_payment_intent_id"""
            ),
            {"limit": max(1, min(int(max_jobs), 25)), "lease": LEASE_SECONDS},
        ).mappings()
    ]


def _settle_refund(connection, request_id: str, refund_id: str | None) -> None:
    connection.execute(
        text(
            """UPDATE pkm_answer_payment_refunds
               SET status = 'succeeded', stripe_refund_id = :refund,
                   lease_expires_at = NULL, safe_error_code = NULL,
                   updated_at = clock_timestamp()
               WHERE request_id = :request"""
        ),
        {"request": request_id, "refund": refund_id},
    )
    connection.execute(
        text(
            """UPDATE pkm_answer_payment_orders
               SET status = 'refunded', refunded_at = clock_timestamp(),
                   stripe_refund_id = :refund, owner_earning_status = 'void',
                   updated_at = clock_timestamp()
               WHERE request_id = :request AND status = 'paid'"""
        ),
        {"request": request_id, "refund": refund_id},
    )


def _defer_refund(connection, request_id: str, code: str, terminal: bool) -> None:
    connection.execute(
        text(
            """UPDATE pkm_answer_payment_refunds
               SET status = :status, safe_error_code = :code,
                   lease_expires_at = NULL,
                   next_check_at = clock_timestamp() + make_interval(secs => :backoff),
                   updated_at = clock_timestamp()
               WHERE request_id = :request"""
        ),
        {
            "request": request_id,
            "status": "manual_review" if terminal else "queued",
            "code": code,
            "backoff": RETRY_BACKOFF_SECONDS,
        },
    )


def _promote_due_payouts(connection) -> None:
    """A delivered answer with content becomes a due earning."""
    connection.execute(
        text(
            """INSERT INTO pkm_answer_owner_payouts
               (request_id, gross_amount_cents, currency, status,
                platform_fee_cents, owner_earning_cents, destination_account_id)
               SELECT o.request_id, o.amount_cents, o.currency, 'due',
                      (o.amount_cents * :bps) / 10000,
                      o.amount_cents - (o.amount_cents * :bps) / 10000,
                      a.stripe_account_id
               FROM pkm_answer_payment_orders o
               JOIN pkm_answer_deliveries d ON d.request_id = o.request_id AND d.has_content
               LEFT JOIN pkm_owner_payout_accounts a
                 ON a.user_id = o.owner_user_id AND a.payouts_enabled
               WHERE o.status = 'paid' AND o.owner_earning_status = 'due'
               ON CONFLICT (request_id) DO NOTHING"""
        ),
        {"bps": COMMISSION_BPS},
    )


def _claim_payouts(connection, max_jobs: int) -> list[dict[str, Any]]:
    return [
        dict(row)
        for row in connection.execute(
            text(
                """UPDATE pkm_answer_owner_payouts SET
                       status = 'dispatching',
                       lease_expires_at = clock_timestamp()
                           + make_interval(secs => :lease),
                       attempts = attempts + 1,
                       updated_at = clock_timestamp()
                   WHERE request_id IN (
                     SELECT request_id FROM pkm_answer_owner_payouts
                     WHERE status IN ('due', 'dispatching', 'unknown', 'awaiting_account')
                       AND next_check_at <= clock_timestamp()
                       AND (lease_expires_at IS NULL
                            OR lease_expires_at < clock_timestamp())
                     ORDER BY next_check_at
                     LIMIT :limit FOR UPDATE SKIP LOCKED)
                   RETURNING request_id, attempts, currency, owner_earning_cents,
                             destination_account_id, transfer_attempt_id"""
            ),
            {"limit": max(1, min(int(max_jobs), 25)), "lease": LEASE_SECONDS},
        ).mappings()
    ]


def _settle_payout(connection, request_id: str, transfer_id: str | None) -> None:
    connection.execute(
        text(
            """UPDATE pkm_answer_owner_payouts
               SET status = 'transferred', stripe_transfer_id = :transfer,
                   transferred_at = clock_timestamp(), lease_expires_at = NULL,
                   safe_error_code = NULL, updated_at = clock_timestamp()
               WHERE request_id = :request"""
        ),
        {"request": request_id, "transfer": transfer_id},
    )
    connection.execute(
        text(
            """UPDATE pkm_answer_payment_orders
               SET owner_earning_status = 'transferred',
                   stripe_transfer_id = :transfer,
                   transferred_at = clock_timestamp(), updated_at = clock_timestamp()
               WHERE request_id = :request"""
        ),
        {"request": request_id, "transfer": transfer_id},
    )


def _await_account(connection, request_id: str) -> None:
    connection.execute(
        text(
            """UPDATE pkm_answer_owner_payouts
               SET status = 'awaiting_account', safe_error_code = 'account_not_ready',
                   lease_expires_at = NULL,
                   next_check_at = clock_timestamp() + make_interval(secs => :backoff),
                   updated_at = clock_timestamp()
               WHERE request_id = :request"""
        ),
        {"request": request_id, "backoff": RETRY_BACKOFF_SECONDS},
    )


def _defer_payout(connection, request_id: str, code: str, terminal: bool) -> None:
    connection.execute(
        text(
            """UPDATE pkm_answer_owner_payouts
               SET status = :status, safe_error_code = :code, lease_expires_at = NULL,
                   next_check_at = clock_timestamp() + make_interval(secs => :backoff),
                   updated_at = clock_timestamp()
               WHERE request_id = :request"""
        ),
        {
            "request": request_id,
            "status": "manual_review" if terminal else "due",
            "code": code,
            "backoff": RETRY_BACKOFF_SECONDS,
        },
    )


def _safe_refund_error(error: Exception) -> str:
    name = type(error).__name__
    if "Invalid" in name or "Permission" in name:
        return "provider_rejected"
    if "Idempotency" in name:
        return "idempotency_window_elapsed"
    return "provider_unavailable"


def _safe_payout_error(error: Exception) -> str:
    name = type(error).__name__
    if "Invalid" in name or "Permission" in name:
        return "provider_rejected"
    return "provider_unavailable"


__all__ = ["PkmAnswerWorkWorker", "file_refund"]
