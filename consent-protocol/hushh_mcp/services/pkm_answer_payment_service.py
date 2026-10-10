"""Stripe-hosted Checkout for one paid answer, at its order's approved price.

A sibling of the Drive document lane, not a second payment system: the Stripe
environment guard, key/live-mode rules, return URLs and the
construct_event signature check are imported from
``drive_request_payment_service`` so there is one source of truth for them.
What differs is the subject (a question, not a document request) and the
binding (``terms_digest``).

Settlement authority is the database order, never the event. A paid event must
match that order's amount, currency, session and — uniquely to this lane — its
``terms_digest``. The digest covers the question, the approved scopes, both
participants and the quote, so a payment made against earlier terms cannot
settle a re-priced or re-scoped question.

The answer itself never passes through here. Delivery is a sealed envelope the
owner's device produces; this module only decides whether the work is paid for.
"""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime
from uuid import uuid4

import stripe
from sqlalchemy import text

from hushh_mcp.services.drive_request_payment_service import (
    CHECKOUT_HOLD_SECONDS,
    _checkout_return_url,
    _config,
    _stripe_dict,
    require_payment_configuration,
)
from hushh_mcp.services.external_connector_lifecycle_store import (
    ExternalConnectorLifecycleStore,
)

#: Registered in the Stripe webhook dispatcher. An unregistered kind would fall
#: through to the Drive handler, which returns early and reports success to
#: Stripe — taking money and never settling. See api/routes/drive_request_payments.py.
logger = logging.getLogger(__name__)

PAYMENT_KIND = "pkm_answer"

MIN_ANSWER_PRICE_CENTS = 100
MAX_ANSWER_PRICE_CENTS = 50_000

#: How long the owner's device has to produce the answer once payment settles.
#: Quoted to the requester before checkout; a miss refunds in full.
ANSWER_DEADLINE_HOURS = 72


class AnswerPaymentError(RuntimeError):
    """Safe error code. Never carries SQL, credentials or question text."""


def _now() -> datetime:
    return datetime.now(UTC)


def valid_answer_price_cents(value: object) -> bool:
    """Whole dollars only, matching the Drive lane's owner-set price rule."""
    return (
        type(value) is int
        and MIN_ANSWER_PRICE_CENTS <= value <= MAX_ANSWER_PRICE_CENTS
        and value % 100 == 0
    )


class PkmAnswerPaymentService(ExternalConnectorLifecycleStore):
    def __init__(self, db=None, *, stripe_api=None):
        super().__init__(db)
        self.stripe_api = stripe_api or stripe

    # ------------------------------------------------------------ entitlement

    @staticmethod
    def require_paid_answer(connection, request_row) -> None:
        """Gate every answer delivery. Call inside the delivery transaction,
        after locking the request row.

        Mirrors ``DriveRequestPaymentStore.require_paid_if_required``: a
        ``FOR SHARE`` read inside the caller's transaction, and a
        ``reconciliation_required`` hold blocks delivery even on a paid row.

        This is an authority guard, not a semantic decision, so it is correct
        for it to be deterministic (backend-semantic-boundary.md: "enforcing
        consent ... must survive this boundary untouched").
        """
        row = (
            connection.execute(
                text(
                    """SELECT status, paid_at, reconciliation_required, terms_digest
                   FROM pkm_answer_payment_orders
                   WHERE request_id = :request FOR SHARE"""
                ),
                {"request": str(request_row["request_id"])},
            )
            .mappings()
            .first()
        )
        if (
            row is None
            or row["status"] != "paid"
            or row["paid_at"] is None
            or row["reconciliation_required"]
        ):
            raise AnswerPaymentError("payment_required")
        # The answer must be produced under the terms that were paid for.
        if row["terms_digest"] != request_row["terms_digest"]:
            raise AnswerPaymentError("terms_changed")

    # --------------------------------------------------------------- reading

    async def get_payment(self, *, requester_user_id: str, request_id: str) -> dict:
        def read(connection):
            row = self._row(
                connection,
                """SELECT r.status AS request_status, r.amount_cents, r.currency,
                          r.answer_deadline_at, r.question, o.status AS order_status,
                          o.stripe_checkout_url, o.paid_at, o.refunded_at, o.refund_reason
                   FROM pkm_answer_requests r
                   LEFT JOIN pkm_answer_payment_orders o ON o.request_id = r.request_id
                   WHERE r.request_id = :request AND r.requester_user_id = :requester""",
                {"request": request_id, "requester": requester_user_id},
            )
            if row is None:
                raise AnswerPaymentError("request_unavailable")
            return row

        row = await self._transaction(read)
        return {
            "requestStatus": row["request_status"],
            "orderStatus": row["order_status"],
            "amountCents": row["amount_cents"],
            "currency": row["currency"],
            "checkoutUrl": row["stripe_checkout_url"],
            "paidAt": row["paid_at"].isoformat() if row["paid_at"] else None,
            "refundedAt": row["refunded_at"].isoformat() if row["refunded_at"] else None,
            "refundReason": row["refund_reason"],
            "answerDeadlineAt": (
                row["answer_deadline_at"].isoformat() if row["answer_deadline_at"] else None
            ),
            # The requester must be told the wait before paying, not after.
            "fulfilment": "owner_device",
            "answerDeadlineHours": ANSWER_DEADLINE_HOURS,
        }

    # -------------------------------------------------------------- checkout

    def _retire_session(self, session_id: str, key: str) -> str:
        """Prove a superseded Checkout session can no longer be charged.

        Returns ``"dead"``, ``"paid"`` or ``"unknown"``. The caller must not
        forget a session it cannot prove is dead: a second live session means
        the requester can pay into an attempt id settlement will reject, and
        that payment has no order to land on, no answer owed and no refund
        filed. An expire call that times out is ``"unknown"``, not success --
        the outcome at Stripe is genuinely undetermined.
        """

        def classify(session: object) -> str | None:
            try:
                data = _stripe_dict(session)
            except (AttributeError, TypeError, ValueError):
                return None
            if not isinstance(data, dict):
                return None
            if data.get("status") == "expired":
                return "dead"
            if data.get("status") == "complete" or data.get("payment_status") == "paid":
                return "paid"
            return None

        verdict: str | None = None
        try:
            verdict = classify(self.stripe_api.checkout.Session.expire(session_id, api_key=key))
        except Exception:  # noqa: BLE001 - every failure mode is "not proven dead"
            logger.info("answer_checkout.session_expire_unconfirmed")
        if verdict is None:
            # Expiring may have failed because the session was already expired
            # or already completed. Read the authoritative state rather than
            # parsing the error.
            try:
                verdict = classify(
                    self.stripe_api.checkout.Session.retrieve(session_id, api_key=key)
                )
            except Exception:  # noqa: BLE001
                logger.info("answer_checkout.session_state_unreadable")
        return verdict or "unknown"

    @staticmethod
    def _checkout_decision(request: dict, order: dict | None) -> dict:
        """Decide reuse / supersede / fresh for one locked request+order pair.

        Pure, so the pre-Stripe and post-Stripe transactions cannot disagree
        about what they are doing.
        """
        if order is None:
            return {"action": "fresh", "stale": None}
        if order["status"] == "paid":
            raise AnswerPaymentError("payment_already_paid")
        if (
            order["status"] == "checkout_open"
            and order["stripe_checkout_session_id"]
            and order["stripe_checkout_url"]
            and order["amount_cents"] == request["amount_cents"]
            and order["terms_digest"] == request["terms_digest"]
            and order["stripe_checkout_expires_at"] is not None
            and order["stripe_checkout_expires_at"] > _now()
        ):
            # Nothing about the terms changed and the session is still live:
            # hand back the SAME session. Minting a second one and nulling the
            # first leaves a payable Stripe session whose attempt id
            # settlement will reject -- the requester pays and the order never
            # settles.
            return {"action": "reuse", "stale": None}
        stale = order["stripe_checkout_session_id"]
        if order["status"] == "checkout_open" and stale:
            # Our own expiry clock is not Stripe's. A session we consider
            # lapsed can still be sitting open in the requester's browser.
            return {"action": "supersede", "stale": str(stale)}
        return {"action": "requote", "stale": None}

    async def checkout(self, *, requester_user_id: str, request_id: str) -> dict:
        """Open (or reuse) a hosted Checkout session for one approved question."""
        require_payment_configuration()
        key, _webhook_secret, origin = _config()

        def load(connection):
            request = self._row(
                connection,
                """SELECT request_id, owner_user_id, requester_user_id, status,
                          amount_cents, currency, terms_digest
                   FROM pkm_answer_requests
                   WHERE request_id = :request FOR UPDATE""",
                {"request": request_id},
            )
            if request is None or request["requester_user_id"] != requester_user_id:
                raise AnswerPaymentError("request_unavailable")
            if request["status"] != "approved":
                raise AnswerPaymentError("payment_not_ready")
            if not valid_answer_price_cents(request["amount_cents"]):
                raise AnswerPaymentError("payment_not_ready")
            order = self._row(
                connection,
                """SELECT * FROM pkm_answer_payment_orders
                   WHERE request_id = :request FOR UPDATE""",
                {"request": request_id},
            )
            return request, order, self._checkout_decision(request, order)

        request, order, decision = await self._transaction(load)

        if decision["action"] == "reuse":
            return {
                "checkoutUrl": order["stripe_checkout_url"],
                "amountCents": order["amount_cents"],
            }

        if decision["action"] == "supersede":
            # Done BEFORE the row forgets the session, and outside the
            # transaction because it is a network call. Until Stripe confirms
            # the old session is dead the order keeps pointing at it, so every
            # possible webhook still has an order to settle or refund against.
            verdict = self._retire_session(decision["stale"], key)
            if verdict == "paid":
                # The requester paid the session we were about to discard.
                # Leave the order bound to it; the webhook settles it.
                raise AnswerPaymentError("payment_in_flight")
            if verdict != "dead":
                raise AnswerPaymentError("checkout_unavailable")

        def reserve(connection):
            fresh_request = self._row(
                connection,
                """SELECT request_id, owner_user_id, requester_user_id, status,
                          amount_cents, currency, terms_digest
                   FROM pkm_answer_requests
                   WHERE request_id = :request FOR UPDATE""",
                {"request": request_id},
            )
            if fresh_request is None or fresh_request["requester_user_id"] != requester_user_id:
                raise AnswerPaymentError("request_unavailable")
            if fresh_request["status"] != "approved":
                raise AnswerPaymentError("payment_not_ready")
            fresh_order = self._row(
                connection,
                """SELECT * FROM pkm_answer_payment_orders
                   WHERE request_id = :request FOR UPDATE""",
                {"request": request_id},
            )
            again = self._checkout_decision(fresh_request, fresh_order)
            if again != decision:
                # A concurrent checkout moved the order while we were talking
                # to Stripe. Refuse rather than act on the stale decision; the
                # caller retries and re-reads the committed state.
                raise AnswerPaymentError("checkout_unavailable")

            attempt_id = str(uuid4())
            if again["action"] == "fresh":
                connection.execute(
                    text(
                        """INSERT INTO pkm_answer_payment_orders
                           (request_id, owner_user_id, requester_user_id, amount_cents,
                            currency, terms_digest, status, checkout_attempt_id)
                           VALUES (:request, :owner, :requester, :amount, :currency,
                                   :digest, 'awaiting_payment', :attempt)"""
                    ),
                    {
                        "request": request_id,
                        "owner": fresh_request["owner_user_id"],
                        "requester": requester_user_id,
                        "amount": fresh_request["amount_cents"],
                        "currency": fresh_request["currency"],
                        "digest": fresh_request["terms_digest"],
                        "attempt": attempt_id,
                    },
                )
            else:
                # Safe now: either there was no session, or Stripe confirmed
                # the old one is expired and can never be charged.
                connection.execute(
                    text(
                        """UPDATE pkm_answer_payment_orders
                           SET amount_cents = :amount, terms_digest = :digest,
                               checkout_attempt_id = :attempt, status = 'awaiting_payment',
                               stripe_checkout_session_id = NULL, stripe_checkout_url = NULL,
                               stripe_checkout_expires_at = NULL,
                               updated_at = clock_timestamp()
                           WHERE request_id = :request"""
                    ),
                    {
                        "request": request_id,
                        "amount": fresh_request["amount_cents"],
                        "digest": fresh_request["terms_digest"],
                        "attempt": attempt_id,
                    },
                )
            return {**fresh_request, "checkout_attempt_id": attempt_id}

        reserved = await self._transaction(reserve)

        session = self.stripe_api.checkout.Session.create(
            mode="payment",
            client_reference_id=request_id,
            success_url=_checkout_return_url(origin, request_id, "paid"),
            cancel_url=_checkout_return_url(origin, request_id, "cancelled"),
            expires_at=int(_now().timestamp()) + CHECKOUT_HOLD_SECONDS,
            line_items=[
                {
                    "quantity": 1,
                    "price_data": {
                        "currency": reserved["currency"],
                        "unit_amount": reserved["amount_cents"],
                        # Opaque to Stripe: never the question text.
                        "product_data": {"name": "Answer request"},
                    },
                }
            ],
            metadata={
                "payment_kind": PAYMENT_KIND,
                "request_id": request_id,
                "checkout_attempt_id": reserved["checkout_attempt_id"],
                "terms_digest": reserved["terms_digest"],
            },
            api_key=key,
            idempotency_key=f"pkm-answer-{request_id}-{reserved['checkout_attempt_id']}",
        )
        created = _stripe_dict(session)

        def persist(connection):
            connection.execute(
                text(
                    """UPDATE pkm_answer_payment_orders
                       SET status = 'checkout_open',
                           stripe_checkout_session_id = :session,
                           stripe_checkout_url = :url,
                           stripe_checkout_expires_at = to_timestamp(:expires),
                           updated_at = clock_timestamp()
                       WHERE request_id = :request AND checkout_attempt_id = :attempt"""
                ),
                {
                    "request": request_id,
                    "attempt": reserved["checkout_attempt_id"],
                    "session": created.get("id"),
                    "url": created.get("url"),
                    "expires": created.get("expires_at"),
                },
            )

        await self._transaction(persist)
        return {"checkoutUrl": created.get("url"), "amountCents": reserved["amount_cents"]}

    # --------------------------------------------------------------- webhook

    async def process_webhook(self, *, payload: bytes, signature: str | None) -> None:
        key, webhook_secret, _origin = _config()
        try:
            raw_event = self.stripe_api.Webhook.construct_event(payload, signature, webhook_secret)
        except (ValueError, TypeError, stripe.error.SignatureVerificationError):
            raise AnswerPaymentError("payment_invalid_signature") from None
        try:
            event = _stripe_dict(raw_event)
        except (AttributeError, TypeError, ValueError):
            raise AnswerPaymentError("payment_invalid_event") from None
        if not isinstance(event, dict):
            raise AnswerPaymentError("payment_invalid_event")

        event_type = event.get("type")
        if event_type not in {
            "checkout.session.completed",
            "checkout.session.async_payment_succeeded",
            "checkout.session.expired",
        }:
            return

        data = event.get("data")
        session = data.get("object") if isinstance(data, dict) else None
        metadata = (session.get("metadata") if isinstance(session, dict) else None) or {}
        if not isinstance(session, dict) or not isinstance(metadata, dict):
            raise AnswerPaymentError("payment_invalid_event")
        if metadata.get("payment_kind") != PAYMENT_KIND:
            return

        request_id = str(metadata.get("request_id") or "").strip()
        if not request_id:
            raise AnswerPaymentError("payment_invalid_event")
        expired_event = event_type == "checkout.session.expired"
        amount_total = session.get("amount_total")

        # Shape only. The locked order below is the settlement authority.
        if (
            session.get("object") != "checkout.session"
            or not isinstance(session.get("id"), str)
            or session.get("client_reference_id") != request_id
            or session.get("mode") != "payment"
            or (not expired_event and session.get("payment_status") != "paid")
            or type(amount_total) is not int
            or not MIN_ANSWER_PRICE_CENTS <= amount_total <= MAX_ANSWER_PRICE_CENTS
            or session.get("currency") != "usd"
            or session.get("livemode") != key.startswith("sk_live_")
            or (not expired_event and not isinstance(session.get("payment_intent"), str))
            or not isinstance(event.get("id"), str)
        ):
            raise AnswerPaymentError("payment_invalid_event")

        def settle(connection):
            order = self._row(
                connection,
                """SELECT * FROM pkm_answer_payment_orders
                   WHERE request_id = :request FOR UPDATE""",
                {"request": request_id},
            )
            if order is None:
                raise AnswerPaymentError("payment_invalid_event")

            if expired_event:
                if (
                    order["status"] == "checkout_open"
                    and order["stripe_checkout_session_id"] == session["id"]
                ):
                    connection.execute(
                        text(
                            """UPDATE pkm_answer_payment_orders
                               SET status = 'expired', stripe_checkout_url = NULL,
                                   updated_at = clock_timestamp()
                               WHERE request_id = :request"""
                        ),
                        {"request": request_id},
                    )
                return

            # Bind the event to this exact order and to the terms that were
            # approved. Any mismatch is a refusal, never a best-effort settle.
            if (
                order["stripe_checkout_session_id"] != session["id"]
                or order["checkout_attempt_id"] is None
                or str(order["checkout_attempt_id"]) != str(metadata.get("checkout_attempt_id"))
                or order["amount_cents"] != amount_total
                or order["currency"] != session["currency"]
                or order["terms_digest"] != metadata.get("terms_digest")
            ):
                raise AnswerPaymentError("payment_invalid_event")

            # Replay guard. A duplicate delivery of the same Stripe event is a
            # no-op, not a second settlement.
            inserted = connection.execute(
                text(
                    """INSERT INTO pkm_answer_payment_webhook_events
                       (stripe_event_id, stripe_checkout_session_id, request_id)
                       VALUES (:event, :session, :request)
                       ON CONFLICT (stripe_event_id) DO NOTHING
                       RETURNING stripe_event_id"""
                ),
                {"event": event["id"], "session": session["id"], "request": request_id},
            ).first()
            if inserted is None:
                return

            if order["status"] == "paid":
                return

            connection.execute(
                text(
                    """UPDATE pkm_answer_payment_orders
                       SET status = 'paid', paid_at = clock_timestamp(),
                           stripe_payment_intent_id = :intent,
                           stripe_checkout_url = NULL, updated_at = clock_timestamp()
                       WHERE request_id = :request"""
                ),
                {"request": request_id, "intent": session["payment_intent"]},
            )
            # Only now does the owner's device have authorized work to do, and
            # only now does the fulfilment clock start.
            moved = connection.execute(
                text(
                    """UPDATE pkm_answer_requests
                       SET status = 'answering',
                           answer_deadline_at = clock_timestamp()
                               + make_interval(hours => :hours),
                           updated_at = clock_timestamp()
                       WHERE request_id = :request AND status = 'approved'
                       RETURNING request_id"""
                ),
                {"request": request_id, "hours": ANSWER_DEADLINE_HOURS},
            ).first()

            if moved is None:
                # The request closed while the payment was in flight: Stripe
                # retries for hours and a requester can cancel, or an owner
                # decline, inside that window. The money is taken and no
                # answer will ever be owed, so the duty to refund it is filed
                # here, in the same transaction that took it. Without this the
                # payment simply sits as a paid order nobody owes anything for.
                from hushh_mcp.services.pkm_answer_work_worker import file_refund

                closed = self._row(
                    connection,
                    """SELECT status FROM pkm_answer_requests
                       WHERE request_id = :request""",
                    {"request": request_id},
                )
                reason = {
                    "cancelled": "requester_cancelled",
                    "declined": "owner_declined",
                    "expired": "answer_timeout",
                }.get(str((closed or {}).get("status") or ""), "request_closed")
                # `request_closed` is not a refund reason the table accepts, so
                # an unexpected state is reconciled by hand rather than
                # silently dropped.
                if reason == "request_closed":
                    connection.execute(
                        text(
                            """UPDATE pkm_answer_payment_orders
                               SET reconciliation_required = TRUE,
                                   reconciliation_reason = 'request_closed',
                                   reconciliation_at = clock_timestamp(),
                                   updated_at = clock_timestamp()
                               WHERE request_id = :request"""
                        ),
                        {"request": request_id},
                    )
                else:
                    file_refund(connection, request_id, reason)

        await self._transaction(settle)
        self._wake_owner_device(request_id)

    @staticmethod
    def _wake_owner_device(request_id: str) -> None:
        """Best effort nudge so a paid answer is not waiting on a poll.

        The database state is the authority; a failed nudge only delays the
        answer to the owner's next unlock, which is already the contract.
        """
        try:
            from hushh_mcp.services.drive_work_wake import wake_drive_work

            wake_drive_work()
        except Exception:  # noqa: BLE001 - never fail a settled payment on a nudge
            pass

    # ---------------------------------------------------------------- refund

    async def refund(self, *, request_id: str, reason: str) -> dict:
        """Refund a paid answer in full. Delivered answers are never refunded.

        Reasons map to the product contract: the owner declined, the requester
        cancelled before delivery, the fulfilment deadline passed, or the
        approved scopes yielded nothing.
        """
        allowed = {"owner_declined", "requester_cancelled", "answer_timeout", "empty_answer"}
        if reason not in allowed:
            raise AnswerPaymentError("invalid_argument")
        require_payment_configuration()
        key, _secret, _origin = _config()

        def claim(connection):
            order = self._row(
                connection,
                """SELECT o.*, d.request_id AS delivered
                   FROM pkm_answer_payment_orders o
                   LEFT JOIN pkm_answer_deliveries d ON d.request_id = o.request_id
                   WHERE o.request_id = :request FOR UPDATE OF o""",
                {"request": request_id},
            )
            if order is None:
                raise AnswerPaymentError("request_unavailable")
            if order["status"] == "refunded":
                return None  # already refunded; idempotent
            if order["status"] != "paid":
                raise AnswerPaymentError("payment_not_ready")
            # An empty answer is still a delivery row, so it is refundable by
            # reason while a real answer is not.
            if order["delivered"] is not None and reason != "empty_answer":
                raise AnswerPaymentError("answer_already_delivered")
            return order

        order = await self._transaction(claim)
        if order is None:
            return {"refunded": True, "alreadyRefunded": True}

        refund = _stripe_dict(
            self.stripe_api.Refund.create(
                payment_intent=order["stripe_payment_intent_id"],
                api_key=key,
                # One refund per order, whatever the retry pattern.
                idempotency_key=f"pkm-answer-refund-{request_id}",
            )
        )

        def persist(connection):
            connection.execute(
                text(
                    """UPDATE pkm_answer_payment_orders
                       SET status = 'refunded', refunded_at = clock_timestamp(),
                           stripe_refund_id = :refund, refund_reason = :reason,
                           owner_earning_status = 'void', updated_at = clock_timestamp()
                       WHERE request_id = :request AND status = 'paid'"""
                ),
                {"request": request_id, "refund": refund.get("id"), "reason": reason},
            )

        await self._transaction(persist)
        return {"refunded": True, "refundId": refund.get("id")}


def answer_payments_enabled() -> bool:
    """Staged rollout flag, defaulting closed like the Drive lane."""
    return (os.getenv("PKM_ANSWER_PAYMENTS_ENABLED") or "").strip().lower() == "true"
