"""Stripe-hosted Checkout for one paid answer, at its order's approved price.

This lane reuses Drive's amount/refund rules, Checkout duration and provider
object normalization. Answer returns query their own status. Its Stripe mode and secret
bindings are independent, so live answers cannot change Drive's sandbox mode.

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
from urllib.parse import quote
from uuid import uuid4

import stripe
from sqlalchemy import text

from hushh_mcp.services.answer_composition_receipt import (
    COMPOSITION_RECEIPT_KEY,
    CompositionReceiptError,
    verify_composition_receipt,
)
from hushh_mcp.services.drive_request_payment_service import (
    CHECKOUT_HOLD_SECONDS,
    _stripe_dict,
)
from hushh_mcp.services.external_connector_lifecycle_store import (
    ExternalConnectorLifecycleStore,
)
from hushh_mcp.services.pkm_answer_config import (
    answer_composer_enabled,
    answer_stripe_mode,
    available_answer_payment_modes,
)
from hushh_mcp.services.pkm_answer_config import answer_payment_config as _config

#: Registered in the Stripe webhook dispatcher. An unregistered kind would fall
#: through to the Drive handler, which returns early and reports success to
#: Stripe — taking money and never settling. See api/routes/drive_request_payments.py.
logger = logging.getLogger(__name__)

PAYMENT_KIND = "pkm_answer"

MIN_ANSWER_PRICE_CENTS = 100
MAX_ANSWER_PRICE_CENTS = 50_000


def _answer_checkout_return_url(origin: str, request_id: str, result: str) -> str:
    return f"{origin}/one/feed?answerPaymentRequestId={quote(request_id)}&checkout={result}"


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
                    """SELECT status, paid_at, reconciliation_required, terms_digest, stripe_mode
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
            or row.get("stripe_mode") not in {"test", "live"}
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
                          r.request_id, r.owner_user_id, r.terms_digest, r.composer_consent_digest,
                          r.answer_deadline_at, r.question,
                          (r.approved_at < clock_timestamp() - interval '2 minutes') AS preparation_overdue,
                          o.status AS order_status,
                          o.stripe_checkout_url, o.paid_at, o.refunded_at, o.refund_reason,
                          o.reconciliation_required, d.has_content AS staged_has_content,
                          d.source_revisions AS staged_revisions
                   FROM pkm_answer_requests r
                   LEFT JOIN pkm_answer_payment_orders o ON o.request_id = r.request_id
                   LEFT JOIN pkm_answer_deliveries d ON d.request_id = r.request_id
                   WHERE r.request_id = :request AND r.requester_user_id = :requester""",
                {"request": request_id, "requester": requester_user_id},
            )
            if row is None:
                raise AnswerPaymentError("request_unavailable")
            return row

        row = await self._transaction(read)
        prepared = bool(
            row["staged_has_content"]
            and self._has_composed_answer({"source_revisions": row["staged_revisions"]}, row)
        )
        return {
            "requestStatus": row["request_status"],
            "orderStatus": row["order_status"],
            "amountCents": row["amount_cents"],
            "currency": row["currency"],
            "checkoutUrl": row["stripe_checkout_url"]
            if row["request_status"] == "approved"
            and prepared
            and answer_payments_enabled()
            and answer_composer_enabled()
            else None,
            "paidAt": row["paid_at"].isoformat() if row["paid_at"] else None,
            "refundedAt": row["refunded_at"].isoformat() if row["refunded_at"] else None,
            "refundReason": row["refund_reason"],
            "reconciliationRequired": bool(row["reconciliation_required"]),
            "preparationStatus": (
                ("retry_required" if row.get("preparation_overdue") else "preparing")
                if row["staged_has_content"] is None
                else "ready"
                if prepared
                else ("retry_required" if row.get("preparation_overdue") else "preparing")
                if row["staged_has_content"]
                else "empty"
            ),
            "answerDeadlineAt": (
                row["answer_deadline_at"].isoformat() if row["answer_deadline_at"] else None
            ),
            # The requester must be told the wait before paying, not after.
            "fulfilment": "owner_device",
            "answerDeadlineHours": ANSWER_DEADLINE_HOURS,
        }

    # -------------------------------------------------------------- checkout

    @staticmethod
    def _has_composed_answer(staged, request) -> bool:
        if request.get("composer_consent_digest") != request["terms_digest"]:
            return False
        try:
            verify_composition_receipt(
                (staged.get("source_revisions") or {}).get(COMPOSITION_RECEIPT_KEY),
                request_id=str(request["request_id"]),
                owner_user_id=request["owner_user_id"],
                terms_digest=request["terms_digest"],
                require_fresh=False,
            )
            return True
        except CompositionReceiptError:
            return False

    @staticmethod
    def _require_prepared_answer(connection, request) -> None:
        staged = (
            connection.execute(
                text("""SELECT has_content, ciphertext, iv, recipient_key_id, source_revisions
                    FROM pkm_answer_deliveries WHERE request_id = :request FOR SHARE"""),
                {"request": str(request["request_id"])},
            )
            .mappings()
            .first()
        )
        if staged is None:
            raise AnswerPaymentError("answer_not_ready")
        if not staged["has_content"]:
            raise AnswerPaymentError("answer_not_found")
        if not all(staged.get(field) for field in ("ciphertext", "iv", "recipient_key_id")):
            raise AnswerPaymentError("answer_not_ready")
        if not PkmAnswerPaymentService._has_composed_answer(staged, request):
            raise AnswerPaymentError("answer_not_ready")

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
        if order.get("stripe_mode") not in {"test", "live"}:
            raise AnswerPaymentError("payment_mode_mismatch")
        if order["status"] in {"paid", "refunded"}:
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
        if order["status"] == "awaiting_payment" and order["checkout_attempt_id"]:
            if (
                order["amount_cents"] != request["amount_cents"]
                or order["terms_digest"] != request["terms_digest"]
                or order["stripe_checkout_expires_at"] is None
                or order["stripe_checkout_expires_at"].timestamp() - CHECKOUT_HOLD_SECONDS
                < _now().timestamp() - 23 * 3600
            ):
                raise AnswerPaymentError("checkout_reconciliation_required")
            return {"action": "recover", "stale": str(order["checkout_attempt_id"])}
        stale = order["stripe_checkout_session_id"]
        if order["status"] == "checkout_open" and stale:
            # Our own expiry clock is not Stripe's. A session we consider
            # lapsed can still be sitting open in the requester's browser.
            return {"action": "supersede", "stale": str(stale)}
        return {"action": "requote", "stale": None}

    async def checkout(self, *, requester_user_id: str, request_id: str) -> dict:
        """Open (or reuse) a hosted Checkout session for one approved question."""

        def load(connection):
            request = self._row(
                connection,
                """SELECT request_id, owner_user_id, requester_user_id, status,
                          amount_cents, currency, terms_digest, composer_consent_digest
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
            # One payment buys one answer. The owner's device prepares the
            # answer at approval, so an approved question whose approved scopes
            # yielded nothing is already known to be unanswerable here, and
            # taking money for it would create a refund the person never
            # needed to be owed.
            order = self._row(
                connection,
                """SELECT * FROM pkm_answer_payment_orders
                   WHERE request_id = :request FOR UPDATE""",
                {"request": request_id},
            )
            from hushh_mcp.services.pkm_answer_request_service import PkmAnswerRequestService

            PkmAnswerRequestService._require_active_connection(
                connection, request["owner_user_id"], requester_user_id
            )
            decision = self._checkout_decision(request, order)
            # Recovering an idempotency key can create a new provider session
            # when an old reservation never reached Stripe. Even returning an
            # existing payable URL must first prove a complete Gemini stage.
            if not answer_composer_enabled():
                raise AnswerPaymentError("composer_not_enabled")
            self._require_prepared_answer(connection, request)
            return request, order, decision

        request, order, decision = await self._transaction(load)
        order_mode = order["stripe_mode"] if order else answer_stripe_mode()
        key, _webhook_secret, origin = _config(order_mode)

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
            from fastapi.concurrency import run_in_threadpool

            verdict = await run_in_threadpool(self._retire_session, decision["stale"], key)
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
                          amount_cents, currency, terms_digest, composer_consent_digest
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
            from hushh_mcp.services.pkm_answer_request_service import PkmAnswerRequestService

            PkmAnswerRequestService._require_active_connection(
                connection, fresh_request["owner_user_id"], requester_user_id
            )
            again = self._checkout_decision(fresh_request, fresh_order)
            if not answer_composer_enabled():
                raise AnswerPaymentError("composer_not_enabled")
            self._require_prepared_answer(connection, fresh_request)
            if (fresh_order["stripe_mode"] if fresh_order else answer_stripe_mode()) != order_mode:
                raise AnswerPaymentError("payment_mode_mismatch")
            if again["action"] == "recover":
                return {
                    **fresh_request,
                    "checkout_attempt_id": str(fresh_order["checkout_attempt_id"]),
                    "checkout_expires": int(fresh_order["stripe_checkout_expires_at"].timestamp()),
                }
            if again["action"] == "reuse":
                return {**fresh_request, "reuse_url": fresh_order["stripe_checkout_url"]}
            if again != decision:
                # A concurrent checkout moved the order while we were talking
                # to Stripe. Refuse rather than act on the stale decision; the
                # caller retries and re-reads the committed state.
                raise AnswerPaymentError("checkout_unavailable")

            from hushh_mcp.services.pkm_answer_request_service import PkmAnswerRequestService

            PkmAnswerRequestService._require_active_connection(
                connection, fresh_request["owner_user_id"], requester_user_id
            )
            attempt_id = str(uuid4())
            checkout_expires = int(_now().timestamp()) + CHECKOUT_HOLD_SECONDS
            if again["action"] == "fresh":
                connection.execute(
                    text(
                        """INSERT INTO pkm_answer_payment_orders
                           (request_id, owner_user_id, requester_user_id, amount_cents,
                            currency, terms_digest, status, checkout_attempt_id, stripe_mode,
                            stripe_checkout_expires_at)
                           VALUES (:request, :owner, :requester, :amount, :currency,
                                   :digest, 'awaiting_payment', :attempt, :stripe_mode, to_timestamp(:expires))"""
                    ),
                    {
                        "request": request_id,
                        "owner": fresh_request["owner_user_id"],
                        "requester": requester_user_id,
                        "amount": fresh_request["amount_cents"],
                        "currency": fresh_request["currency"],
                        "digest": fresh_request["terms_digest"],
                        "attempt": attempt_id,
                        "stripe_mode": order_mode,
                        "expires": checkout_expires,
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
                               stripe_checkout_expires_at = to_timestamp(:expires),
                               updated_at = clock_timestamp()
                           WHERE request_id = :request"""
                    ),
                    {
                        "request": request_id,
                        "amount": fresh_request["amount_cents"],
                        "digest": fresh_request["terms_digest"],
                        "attempt": attempt_id,
                        "stripe_mode": order_mode,
                        "expires": checkout_expires,
                    },
                )
            return {
                **fresh_request,
                "checkout_attempt_id": attempt_id,
                "checkout_expires": checkout_expires,
            }

        reserved = await self._transaction(reserve)

        if "reuse_url" in reserved:
            return {"checkoutUrl": reserved["reuse_url"], "amountCents": reserved["amount_cents"]}

        from fastapi.concurrency import run_in_threadpool

        session = await run_in_threadpool(
            self.stripe_api.checkout.Session.create,
            mode="payment",
            client_reference_id=request_id,
            success_url=_answer_checkout_return_url(origin, request_id, "success"),
            cancel_url=_answer_checkout_return_url(origin, request_id, "cancel"),
            expires_at=reserved["checkout_expires"],
            payment_intent_data={
                "transfer_group": f"pkm-answer:{request_id}",
                # The same routing metadata as the session, because the one
                # Stripe endpoint routes on `data.object.metadata.payment_kind`
                # and a payment_intent or charge event carries the INTENT's
                # metadata, not the session's. Without it those events route to
                # no lane at all: the endpoint answers Stripe `{"received":
                # true}` and settles nothing, which is the exact failure the
                # dispatcher's own comment warns about -- money taken, nothing
                # delivered. The Drive lane has always tagged both.
                "metadata": {
                    "payment_kind": PAYMENT_KIND,
                    "request_id": request_id,
                    "checkout_attempt_id": reserved["checkout_attempt_id"],
                    "terms_digest": reserved["terms_digest"],
                },
            },
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
            request = self._row(
                connection,
                "SELECT status,owner_user_id,requester_user_id FROM pkm_answer_requests WHERE request_id=:request FOR UPDATE",
                {"request": request_id},
            )
            connected = self._row(
                connection,
                """SELECT id FROM connections WHERE status='active'
                AND ((user_a_id=:owner AND user_b_id=:requester) OR (user_b_id=:owner AND user_a_id=:requester)) FOR SHARE""",
                {"owner": reserved["owner_user_id"], "requester": requester_user_id},
            )
            updated = connection.execute(
                text(
                    """UPDATE pkm_answer_payment_orders
                       SET status = 'checkout_open',
                           stripe_checkout_session_id = :session,
                           stripe_checkout_url = :url,
                           stripe_checkout_expires_at = to_timestamp(:expires),
                           updated_at = clock_timestamp()
                       WHERE request_id = :request AND checkout_attempt_id = :attempt
                         AND status IN ('awaiting_payment', 'checkout_open')
                       RETURNING request_id"""
                ),
                {
                    "request": request_id,
                    "attempt": reserved["checkout_attempt_id"],
                    "session": created.get("id"),
                    "url": created.get("url"),
                    "expires": created.get("expires_at"),
                },
            ).first()
            return updated is not None, bool(
                request and request["status"] == "approved" and connected
            )

        persisted, eligible = await self._transaction(persist)
        if not eligible:
            from fastapi.concurrency import run_in_threadpool

            await run_in_threadpool(self._retire_session, str(created.get("id")), key)
            raise AnswerPaymentError("payment_not_ready")
        if not persisted:
            # Settlement may have won; never advertise an orphan payable URL.
            raise AnswerPaymentError("payment_in_flight")
        if (
            not created.get("url")
            or not created.get("id")
            or not isinstance(created.get("expires_at"), (int, float))
            or created["expires_at"] <= _now().timestamp()
            or created.get("status") in {"expired", "complete"}
        ):
            # Identity is retained for the next verified retire/reconciliation.
            # Never advertise Stripe's cached expired recovery response.
            raise AnswerPaymentError("checkout_unavailable")
        return {"checkoutUrl": created.get("url"), "amountCents": reserved["amount_cents"]}

    # --------------------------------------------------------------- webhook

    async def process_webhook(self, *, payload: bytes, signature: str | None) -> None:
        raw_event = None
        key = ""
        signed_event = False
        for mode in available_answer_payment_modes():
            candidate_key, webhook_secret, _origin = _config(mode)
            try:
                verified = _stripe_dict(
                    self.stripe_api.Webhook.construct_event(payload, signature, webhook_secret)
                )
                signed_event = True
                # A shared endpoint can use the same signing secret for both
                # modes. Choose the key from authenticated provider mode,
                # never from the candidate secret's iteration order.
                session = (verified.get("data") or {}).get("object") or {}
                livemode = verified.get("livemode", session.get("livemode"))
                if type(livemode) is bool and livemode != (mode == "live"):
                    continue
                raw_event = verified
                key = candidate_key
                break
            except (ValueError, TypeError, stripe.error.SignatureVerificationError):
                continue
        if raw_event is None:
            raise AnswerPaymentError(
                "payment_invalid_event" if signed_event else "payment_invalid_signature"
            )
        try:
            event = _stripe_dict(raw_event)
        except (AttributeError, TypeError, ValueError):
            raise AnswerPaymentError("payment_invalid_event") from None
        if not isinstance(event, dict):
            raise AnswerPaymentError("payment_invalid_event")

        await self._settle_verified_event(event=event, key=key)

    async def recover_checkout_event(
        self, *, request_id: str, stripe_event_id: str, stripe_mode: str | None = None
    ) -> None:
        """Operator recovery using an authenticated provider event, never fabricated signatures.

        This uses the same transaction and replay guard as signed webhooks.
        No browser-return, PaymentIntent, or caller-supplied event can settle an order.
        """
        order = await self._transaction(
            lambda connection: self._row(
                connection,
                "SELECT stripe_mode FROM pkm_answer_payment_orders WHERE request_id=:request",
                {"request": request_id},
            )
        )
        if order is None:
            raise AnswerPaymentError("request_unavailable")
        stored_mode = order.get("stripe_mode")
        mode = stored_mode if stored_mode is not None else stripe_mode
        if mode not in {"test", "live"} or (stripe_mode is not None and stripe_mode != mode):
            raise AnswerPaymentError("payment_mode_mismatch")
        key, _secret, _origin = _config(mode)
        from fastapi.concurrency import run_in_threadpool

        raw = await run_in_threadpool(self.stripe_api.Event.retrieve, stripe_event_id, api_key=key)
        event = _stripe_dict(raw)
        session = (event.get("data") or {}).get("object") or {}
        if (
            event.get("id") != stripe_event_id
            or event.get("type")
            not in {"checkout.session.completed", "checkout.session.async_payment_succeeded"}
            or (session.get("metadata") or {}).get("request_id") != request_id
        ):
            raise AnswerPaymentError("payment_invalid_event")
        current = _stripe_dict(
            await run_in_threadpool(
                self.stripe_api.checkout.Session.retrieve,
                session.get("id"),
                api_key=key,
            )
        )
        # Confirm the same paid provider object still belongs to these exact terms.
        for field in (
            "id",
            "client_reference_id",
            "mode",
            "payment_status",
            "amount_total",
            "currency",
            "livemode",
            "payment_intent",
            "metadata",
        ):
            if current.get(field) != session.get(field):
                raise AnswerPaymentError("payment_invalid_event")
        await self._settle_verified_event(
            event=event, key=key, reconcile_mode=mode if stored_mode is None else None
        )

    async def _settle_verified_event(
        self, *, event: dict, key: str, reconcile_mode: str | None = None
    ) -> None:
        """Only signed webhook or authenticated provider-read callers enter here."""

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
            request = self._row(
                connection,
                """SELECT request_id, status, owner_user_id, requester_user_id, terms_digest,
                          composer_consent_digest
                   FROM pkm_answer_requests WHERE request_id=:request FOR UPDATE""",
                {"request": request_id},
            )
            order = self._row(
                connection,
                """SELECT * FROM pkm_answer_payment_orders
                   WHERE request_id = :request FOR UPDATE""",
                {"request": request_id},
            )
            if order is None:
                raise AnswerPaymentError("payment_invalid_event")

            verified_mode = "live" if key.startswith("sk_live_") else "test"
            historical_unbound = (
                order.get("stripe_mode") is None and reconcile_mode == verified_mode
            )
            if order.get("stripe_mode") != verified_mode and not historical_unbound:
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
                (order["stripe_checkout_session_id"] not in {None, session["id"]})
                or order["checkout_attempt_id"] is None
                or str(order["checkout_attempt_id"]) != str(metadata.get("checkout_attempt_id"))
                or order["amount_cents"] != amount_total
                or order["currency"] != session["currency"]
                or order["terms_digest"] != metadata.get("terms_digest")
            ):
                raise AnswerPaymentError("payment_invalid_event")

            if (
                order["status"] in {"paid", "refunded"}
                and order["stripe_payment_intent_id"] != session["payment_intent"]
            ):
                raise AnswerPaymentError("payment_invalid_event")

            if historical_unbound:
                # Only authenticated Event + current Session recovery can bind
                # an old row. Never infer its mode from today's deployment.
                if order["stripe_checkout_session_id"] != session["id"]:
                    raise AnswerPaymentError("payment_invalid_event")
                connection.execute(
                    text(
                        "UPDATE pkm_answer_payment_orders SET stripe_mode=:mode WHERE request_id=:request"
                    ),
                    {"mode": verified_mode, "request": request_id},
                )

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

            if order["status"] in {"paid", "refunded"}:
                if order["stripe_payment_intent_id"] != session["payment_intent"]:
                    raise AnswerPaymentError("payment_invalid_event")
                return

            connection.execute(
                text(
                    """UPDATE pkm_answer_payment_orders
                       SET status = 'paid', paid_at = clock_timestamp(),
                           stripe_payment_intent_id = :intent,
                           stripe_checkout_session_id = :session,
                           stripe_checkout_url = NULL, updated_at = clock_timestamp()
                       WHERE request_id = :request"""
                ),
                {
                    "request": request_id,
                    "intent": session["payment_intent"],
                    "session": session["id"],
                },
            )
            # Record a verified charge even if authority ended in flight, but
            # never release its envelope. The connection lock serializes this
            # decision against disconnect; the existing worker refunds it.
            connected = self._row(
                connection,
                """SELECT id FROM connections WHERE status='active'
                   AND ((user_a_id=:owner AND user_b_id=:requester)
                     OR (user_b_id=:owner AND user_a_id=:requester)) FOR SHARE""",
                {"owner": order["owner_user_id"], "requester": order["requester_user_id"]},
            )
            if not connected or not request or request["terms_digest"] != order["terms_digest"]:
                connection.execute(
                    text("""UPDATE pkm_answer_payment_orders
                    SET reconciliation_required=TRUE, reconciliation_reason='authority_changed',
                        reconciliation_at=clock_timestamp(), updated_at=clock_timestamp()
                    WHERE request_id=:request"""),
                    {"request": request_id},
                )
                if request and request["status"] == "approved":
                    connection.execute(
                        text("""UPDATE pkm_answer_requests SET status='declined',
                        declined_at=clock_timestamp(), updated_at=clock_timestamp()
                        WHERE request_id=:request"""),
                        {"request": request_id},
                    )
                if request and request["status"] != "answered":
                    from hushh_mcp.services.pkm_answer_work_worker import file_refund

                    reason = {"cancelled": "requester_cancelled", "expired": "answer_timeout"}.get(
                        request["status"], "owner_declined"
                    )
                    file_refund(connection, request_id, reason)
                return
            # An answer prepared at approval was waiting on exactly this, so a
            # verified payment releases it here. Requiring the owner to unlock
            # and act a second time is what the 72-hour clock below exists to
            # survive, and a staged answer never needs it.
            staged = (
                connection.execute(
                    text(
                        """SELECT has_content, source_revisions FROM pkm_answer_deliveries
                           WHERE request_id = :request FOR SHARE"""
                    ),
                    {"request": request_id},
                )
                .mappings()
                .first()
            )
            if (
                staged is not None
                and staged["has_content"]
                and self._has_composed_answer(staged, request)
            ):
                moved = connection.execute(
                    text(
                        """UPDATE pkm_answer_requests
                           SET status = 'answered', answered_at = clock_timestamp(),
                               updated_at = clock_timestamp()
                           WHERE request_id = :request AND status = 'approved'
                           RETURNING request_id"""
                    ),
                    {"request": request_id},
                ).first()
                if moved is not None:
                    connection.execute(
                        text(
                            """UPDATE pkm_answer_payment_orders
                               SET owner_earning_status = 'due', updated_at = clock_timestamp()
                               WHERE request_id = :request AND status = 'paid'"""
                        ),
                        {"request": request_id},
                    )
                    from hushh_mcp.services.pkm_answer_request_service import (
                        PkmAnswerRequestService,
                    )

                    PkmAnswerRequestService._feed(
                        connection,
                        user_id=order["requester_user_id"],
                        event_type="answer_delivered",
                        request_id=request_id,
                        status="answered",
                    )
            else:
                # Only now does the owner's device have authorized work to do,
                # and only now does the fulfilment clock start.
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
        from hushh_mcp.services.pkm_answer_work_worker import file_refund

        def file(connection):
            request = self._row(
                connection,
                "SELECT request_id, status FROM pkm_answer_requests WHERE request_id=:request FOR UPDATE",
                {"request": request_id},
            )
            if request is None:
                raise AnswerPaymentError("request_unavailable")
            delivered = self._row(
                connection,
                "SELECT has_content FROM pkm_answer_deliveries WHERE request_id=:request",
                {"request": request_id},
            )
            if request["status"] == "answered" and delivered and delivered["has_content"]:
                raise AnswerPaymentError("answer_already_delivered")
            return file_refund(connection, request_id, reason)

        await self._transaction(file)
        return {"refundQueued": True}


def answer_payments_enabled() -> bool:
    """Staged rollout flag, defaulting closed like the Drive lane."""
    return (os.getenv("PKM_ANSWER_PAYMENTS_ENABLED") or "").strip().lower() == "true"
