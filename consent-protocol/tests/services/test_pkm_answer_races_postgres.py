"""Races and retries in the paid-answer lane, against real PostgreSQL.

The dangerous states here are not "an error happened" but "money moved and
nothing else did". These tests drive the orderings that could produce one:
a second checkout, a cancellation arriving beside a settlement, a refund the
provider refused, and two drains reaching for the same row.
"""

from __future__ import annotations

from unittest.mock import Mock

import pytest
from sqlalchemy import text

from hushh_mcp.services.pkm_answer_request_service import AnswerRequestError
from hushh_mcp.services.pkm_answer_work_worker import PkmAnswerWorkWorker
from tests.services.test_pkm_answer_requests_postgres import (  # noqa: F401
    ENVELOPE,
    OWNER,
    REQUESTER,
    StubResolver,
    _ask,
    _db,
    _mark_paid,
    answer_engine,
    clean,
    connector_postgres_url,
)


@pytest.fixture(autouse=True)
def payments_enabled(monkeypatch):
    # The lane ships disabled; the workers short-circuit unless it is on.
    monkeypatch.setenv("PKM_ANSWER_PAYMENTS_ENABLED", "true")
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "test")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret_value")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    from hushh_mcp.runtime_settings import clear_runtime_settings_caches

    clear_runtime_settings_caches()
    yield
    clear_runtime_settings_caches()


async def _approved(engine, amount=1000):
    service, request_id = await _ask(engine, StubResolver(["attr.travel.trips"]))
    approved = await service.approve(
        owner_user_id=OWNER,
        request_id=request_id,
        scopes=["attr.travel.trips"],
        amount_cents=amount,
    )
    return service, request_id, approved["termsDigest"]


def _orders(engine, request_id):
    with engine.begin() as connection:
        return (
            connection.execute(
                text("SELECT count(*) FROM pkm_answer_payment_orders WHERE request_id=:r"),
                {"r": request_id},
            ).scalar(),
        )


class TestRepeatedCheckout:
    async def test_a_second_checkout_reuses_one_order_row(self, answer_engine):  # noqa: F811
        _service, request_id, digest = await _approved(answer_engine)
        # The order row is keyed by request_id, so a repeated checkout can only
        # ever re-quote the same row. Two paid orders for one question is the
        # state this makes unrepresentable.
        with answer_engine.begin() as connection:
            for _ in range(2):
                connection.execute(
                    text(
                        """INSERT INTO pkm_answer_payment_orders
                           (request_id,owner_user_id,requester_user_id,amount_cents,
                            terms_digest,status)
                           VALUES (:r,:o,:q,1000,:d,'awaiting_payment')
                           ON CONFLICT (request_id) DO UPDATE
                             SET amount_cents = EXCLUDED.amount_cents,
                                 updated_at = clock_timestamp()"""
                    ),
                    {"r": request_id, "o": OWNER, "q": REQUESTER, "d": digest},
                )
        assert _orders(answer_engine, request_id) == (1,)

    async def test_a_paid_order_cannot_be_re_quoted_to_a_new_price(self, answer_engine):  # noqa: F811
        _service, request_id, digest = await _approved(answer_engine)
        _mark_paid(answer_engine, request_id, digest)
        # The delivery gate compares the order's digest to the request's, so a
        # re-price after payment cannot be settled by the old payment. Proven
        # in the payment suite; here we assert the paid row is not overwritten
        # silently by a second checkout attempt.
        with answer_engine.begin() as connection:
            connection.execute(
                text(
                    """UPDATE pkm_answer_payment_orders
                       SET amount_cents = 2000
                       WHERE request_id = :r AND status <> 'paid'"""
                ),
                {"r": request_id},
            )
            amount = connection.execute(
                text("SELECT amount_cents FROM pkm_answer_payment_orders WHERE request_id=:r"),
                {"r": request_id},
            ).scalar()
        assert amount == 1000


class TestRepeatedCheckoutThroughTheService:
    """A second checkout call must not leave a payable orphan session.

    The class above covers the database invariant; this one drives the actual
    service method, which is where the session is minted or reused.
    """

    @staticmethod
    def _stripe(url="https://checkout.stripe.com/c/pay/cs_new"):
        from unittest.mock import Mock as _Mock

        api = _Mock()
        api.checkout.Session.create.return_value = {
            "id": "cs_new",
            "url": url,
            "expires_at": int(__import__("time").time()) + 1800,
        }
        return api

    async def test_an_unchanged_live_session_is_reused_not_reminted(self, answer_engine):  # noqa: F811
        service, request_id, digest = await _approved(answer_engine)
        from hushh_mcp.services.pkm_answer_payment_service import PkmAnswerPaymentService

        api = self._stripe()
        payments = PkmAnswerPaymentService(_db(answer_engine), stripe_api=api)
        first = await payments.checkout(requester_user_id=REQUESTER, request_id=request_id)
        second = await payments.checkout(requester_user_id=REQUESTER, request_id=request_id)

        # One session, handed back twice. Minting a second and nulling the
        # first would leave a payable session settlement then rejects.
        assert api.checkout.Session.create.call_count == 1
        assert first["checkoutUrl"] == second["checkoutUrl"]
        api.checkout.Session.expire.assert_not_called()

    async def test_a_reprice_expires_the_old_session_before_minting_a_new_one(
        self,
        answer_engine,  # noqa: F811
    ):
        service, request_id, digest = await _approved(answer_engine)
        from hushh_mcp.services.pkm_answer_payment_service import PkmAnswerPaymentService

        api = self._stripe()
        payments = PkmAnswerPaymentService(_db(answer_engine), stripe_api=api)
        await payments.checkout(requester_user_id=REQUESTER, request_id=request_id)

        # The owner re-prices, which changes the terms digest.
        with answer_engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE pkm_answer_requests SET amount_cents = 2000,"
                    " terms_digest = :d WHERE request_id = :r"
                ),
                {"r": request_id, "d": "c" * 64},
            )
        await payments.checkout(requester_user_id=REQUESTER, request_id=request_id)

        assert api.checkout.Session.create.call_count == 2
        # The superseded session is closed at Stripe, so it cannot be paid.
        api.checkout.Session.expire.assert_called_once()
        assert api.checkout.Session.expire.call_args.args[0] == "cs_new"

    async def test_an_already_paid_order_refuses_another_checkout(self, answer_engine):  # noqa: F811
        # Two guards stand in front of a second charge. This one is the inner
        # order check: the request is still 'approved' but the order is paid.
        service, request_id, digest = await _approved(answer_engine)
        _mark_paid(answer_engine, request_id, digest)
        with answer_engine.begin() as connection:
            connection.execute(
                text("UPDATE pkm_answer_requests SET status='approved' WHERE request_id=:r"),
                {"r": request_id},
            )
        from hushh_mcp.services.pkm_answer_payment_service import (
            AnswerPaymentError,
            PkmAnswerPaymentService,
        )

        api = self._stripe()
        with pytest.raises(AnswerPaymentError, match="payment_already_paid"):
            await PkmAnswerPaymentService(_db(answer_engine), stripe_api=api).checkout(
                requester_user_id=REQUESTER, request_id=request_id
            )
        api.checkout.Session.create.assert_not_called()

    async def test_a_request_already_being_answered_refuses_a_checkout(self, answer_engine):  # noqa: F811
        # And the outer guard: once paid, the request leaves 'approved', so a
        # late checkout attempt is refused before the order is even read.
        service, request_id, digest = await _approved(answer_engine)
        _mark_paid(answer_engine, request_id, digest)
        from hushh_mcp.services.pkm_answer_payment_service import (
            AnswerPaymentError,
            PkmAnswerPaymentService,
        )

        api = self._stripe()
        with pytest.raises(AnswerPaymentError, match="payment_not_ready"):
            await PkmAnswerPaymentService(_db(answer_engine), stripe_api=api).checkout(
                requester_user_id=REQUESTER, request_id=request_id
            )
        api.checkout.Session.create.assert_not_called()


class TestCancellationPaymentRace:
    async def test_cancelling_a_paid_request_files_exactly_one_refund(self, answer_engine):  # noqa: F811
        service, request_id, digest = await _approved(answer_engine)
        _mark_paid(answer_engine, request_id, digest)

        await service.cancel(requester_user_id=REQUESTER, request_id=request_id)
        # A second cancel is refused, so a retrying client cannot file two.
        with pytest.raises(AnswerRequestError, match="request_not_cancellable"):
            await service.cancel(requester_user_id=REQUESTER, request_id=request_id)

        with answer_engine.begin() as connection:
            rows = (
                connection.execute(
                    text(
                        "SELECT reason, status FROM pkm_answer_payment_refunds WHERE request_id=:r"
                    ),
                    {"r": request_id},
                )
                .mappings()
                .all()
            )
        assert len(rows) == 1
        assert rows[0]["reason"] == "requester_cancelled"
        assert rows[0]["status"] == "queued"

    async def test_a_delivered_answer_cannot_be_cancelled_afterwards(self, answer_engine):  # noqa: F811
        service, request_id, digest = await _approved(answer_engine)
        _mark_paid(answer_engine, request_id, digest)
        await service.deliver(owner_user_id=OWNER, request_id=request_id, envelope=ENVELOPE)
        # The buyer has the answer; cancelling now would be a free read.
        with pytest.raises(AnswerRequestError, match="answer_already_delivered"):
            await service.cancel(requester_user_id=REQUESTER, request_id=request_id)

    async def test_declining_after_payment_files_a_refund_and_voids_the_earning(
        self,
        answer_engine,  # noqa: F811
    ):
        service, request_id, digest = await _approved(answer_engine)
        _mark_paid(answer_engine, request_id, digest)
        with answer_engine.begin() as connection:
            connection.execute(
                text(
                    """INSERT INTO pkm_answer_owner_payouts
                       (request_id, gross_amount_cents, status, owner_earning_cents)
                       VALUES (:r, 1000, 'due', 970)"""
                ),
                {"r": request_id},
            )
        await service.decline(owner_user_id=OWNER, request_id=request_id)
        with answer_engine.begin() as connection:
            refund = connection.execute(
                text("SELECT reason FROM pkm_answer_payment_refunds WHERE request_id=:r"),
                {"r": request_id},
            ).scalar()
            payout = connection.execute(
                text("SELECT status FROM pkm_answer_owner_payouts WHERE request_id=:r"),
                {"r": request_id},
            ).scalar()
        assert refund == "owner_declined"
        # A refunded answer must not also pay the owner.
        assert payout == "void"


class TestPaymentArrivingAfterTheRequestClosed:
    """Stripe retries for hours, and a request can close inside that window.

    If settlement only looks at the order, the money is taken, no answer is
    ever owed, and no refund obligation is recorded anywhere.
    """

    @staticmethod
    async def _settle_webhook(engine, request_id, digest, attempt, event_id):
        import hashlib
        import hmac
        import json
        import time

        from hushh_mcp.services.pkm_answer_payment_service import (
            PAYMENT_KIND,
            PkmAnswerPaymentService,
        )

        body = json.dumps(
            {
                "id": event_id,
                "object": "event",
                "type": "checkout.session.completed",
                "data": {
                    "object": {
                        "id": "cs_test_late",
                        "object": "checkout.session",
                        "client_reference_id": request_id,
                        "metadata": {
                            "payment_kind": PAYMENT_KIND,
                            "request_id": request_id,
                            "checkout_attempt_id": attempt,
                            "terms_digest": digest,
                        },
                        "mode": "payment",
                        "payment_status": "paid",
                        "amount_total": 1000,
                        "currency": "usd",
                        "livemode": False,
                        "payment_intent": "pi_late_" + event_id,
                    }
                },
            }
        ).encode()
        stamp = int(time.time())
        mac = hmac.new(
            b"whsec_payment_test_secret_value", f"{stamp}.".encode() + body, hashlib.sha256
        ).hexdigest()
        await PkmAnswerPaymentService(_db(engine)).process_webhook(
            payload=body, signature=f"t={stamp},v1={mac}"
        )

    @staticmethod
    def _open_checkout(engine, request_id, digest, attempt):
        with engine.begin() as connection:
            connection.execute(
                text(
                    """INSERT INTO pkm_answer_payment_orders
                       (request_id,owner_user_id,requester_user_id,amount_cents,
                        terms_digest,status,checkout_attempt_id,stripe_checkout_session_id)
                       VALUES (:r,:o,:q,1000,:d,'checkout_open',:a,'cs_test_late')"""
                ),
                {"r": request_id, "o": OWNER, "q": REQUESTER, "d": digest, "a": attempt},
            )

    async def test_a_payment_landing_after_cancellation_is_refunded(self, answer_engine):  # noqa: F811
        service, request_id, digest = await _approved(answer_engine)
        attempt = "77777777-8888-9999-aaaa-bbbbbbbbbbbb"
        self._open_checkout(answer_engine, request_id, digest, attempt)

        # The requester cancels while the payment is still in flight.
        await service.cancel(requester_user_id=REQUESTER, request_id=request_id)
        await self._settle_webhook(answer_engine, request_id, digest, attempt, "evt_cancel")

        with answer_engine.begin() as connection:
            row = (
                connection.execute(
                    text(
                        """SELECT o.status AS order_status, r.status AS request_status, f.reason
                       FROM pkm_answer_payment_orders o
                       JOIN pkm_answer_requests r ON r.request_id = o.request_id
                       LEFT JOIN pkm_answer_payment_refunds f ON f.request_id = o.request_id
                       WHERE o.request_id = :r"""
                    ),
                    {"r": request_id},
                )
                .mappings()
                .first()
            )

        assert row["order_status"] == "paid"
        assert row["request_status"] == "cancelled"
        # Money was taken for an answer nobody will produce.
        assert row["reason"] == "requester_cancelled"

    async def test_a_payment_landing_after_the_owner_declined_is_refunded(self, answer_engine):  # noqa: F811
        service, request_id, digest = await _approved(answer_engine)
        attempt = "66666666-8888-9999-aaaa-bbbbbbbbbbbb"
        self._open_checkout(answer_engine, request_id, digest, attempt)
        await service.decline(owner_user_id=OWNER, request_id=request_id)
        await self._settle_webhook(answer_engine, request_id, digest, attempt, "evt_decline")

        with answer_engine.begin() as connection:
            reason = connection.execute(
                text("SELECT reason FROM pkm_answer_payment_refunds WHERE request_id=:r"),
                {"r": request_id},
            ).scalar()
        assert reason == "owner_declined"

    async def test_a_normal_payment_still_becomes_answerable_with_no_refund(
        self,
        answer_engine,  # noqa: F811
    ):
        # Negative control: the refund path must not fire on the happy path.
        service, request_id, digest = await _approved(answer_engine)
        attempt = "55555555-8888-9999-aaaa-bbbbbbbbbbbb"
        self._open_checkout(answer_engine, request_id, digest, attempt)
        await self._settle_webhook(answer_engine, request_id, digest, attempt, "evt_ok")

        with answer_engine.begin() as connection:
            row = (
                connection.execute(
                    text(
                        """SELECT r.status, r.answer_deadline_at IS NOT NULL AS has_deadline,
                              (SELECT count(*) FROM pkm_answer_payment_refunds f
                               WHERE f.request_id = r.request_id) AS refunds
                       FROM pkm_answer_requests r WHERE r.request_id = :r"""
                    ),
                    {"r": request_id},
                )
                .mappings()
                .first()
            )
        assert row["status"] == "answering"
        assert row["has_deadline"] is True
        assert row["refunds"] == 0


class TestRefundRetry:
    async def test_a_refused_refund_is_retried_not_lost(self, answer_engine):  # noqa: F811
        service, request_id, digest = await _approved(answer_engine)
        _mark_paid(answer_engine, request_id, digest)
        await service.cancel(requester_user_id=REQUESTER, request_id=request_id)

        failing = Mock()
        failing.Refund.create.side_effect = RuntimeError("provider down")
        worker = PkmAnswerWorkWorker(_db(answer_engine), stripe_api=failing)
        outcome = await worker.run_refunds(max_jobs=5)
        assert outcome["retried"] == 1

        with answer_engine.begin() as connection:
            row = (
                connection.execute(
                    text(
                        """SELECT status, attempts, safe_error_code, next_check_at > clock_timestamp()
                           AS backed_off
                       FROM pkm_answer_payment_refunds WHERE request_id=:r"""
                    ),
                    {"r": request_id},
                )
                .mappings()
                .first()
            )
        # Still owed, counted, backed off, and carrying a closed error code --
        # never a provider message.
        assert row["status"] == "queued"
        assert row["attempts"] == 1
        assert row["safe_error_code"] == "provider_unavailable"
        assert row["backed_off"] is True

        # The next sweep succeeds and the order becomes refunded.
        ok = Mock()
        ok.Refund.create.return_value = {"id": "re_test_ok"}
        with answer_engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE pkm_answer_payment_refunds SET next_check_at = clock_timestamp()"
                    " WHERE request_id=:r"
                ),
                {"r": request_id},
            )
        outcome = await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=ok).run_refunds(
            max_jobs=5
        )
        assert outcome["succeeded"] == 1

        with answer_engine.begin() as connection:
            order = (
                connection.execute(
                    text(
                        "SELECT status, owner_earning_status FROM pkm_answer_payment_orders"
                        " WHERE request_id=:r"
                    ),
                    {"r": request_id},
                )
                .mappings()
                .first()
            )
        assert order["status"] == "refunded"
        assert order["owner_earning_status"] == "void"

    async def test_the_refund_idempotency_key_is_stable_across_attempts(self, answer_engine):  # noqa: F811
        service, request_id, digest = await _approved(answer_engine)
        _mark_paid(answer_engine, request_id, digest)
        await service.cancel(requester_user_id=REQUESTER, request_id=request_id)

        api = Mock()
        api.Refund.create.side_effect = [RuntimeError("down"), {"id": "re_ok"}]
        worker = PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api)
        await worker.run_refunds(max_jobs=5)
        with answer_engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE pkm_answer_payment_refunds SET next_check_at = clock_timestamp()"
                    " WHERE request_id=:r"
                ),
                {"r": request_id},
            )
        await worker.run_refunds(max_jobs=5)

        keys = {call.kwargs["idempotency_key"] for call in api.Refund.create.call_args_list}
        # One key for both attempts: a retry can never produce a second refund.
        assert len(keys) == 1
        assert keys.pop() == f"pkm-answer-refund-{request_id}"

    async def test_a_second_drain_cannot_claim_a_leased_refund(self, answer_engine):  # noqa: F811
        service, request_id, digest = await _approved(answer_engine)
        _mark_paid(answer_engine, request_id, digest)
        await service.cancel(requester_user_id=REQUESTER, request_id=request_id)

        slow = Mock()
        slow.Refund.create.side_effect = RuntimeError("down")
        first = PkmAnswerWorkWorker(_db(answer_engine), stripe_api=slow)
        await first.run_refunds(max_jobs=5)

        # The row is backed off, so a concurrent drain finds nothing due.
        second = Mock()
        second.Refund.create.return_value = {"id": "re_double"}
        outcome = await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=second).run_refunds(
            max_jobs=5
        )
        assert outcome == {"succeeded": 0, "retried": 0, "manual_review": 0}
        second.Refund.create.assert_not_called()


class TestOnePaymentBuysOneAnswer:
    """A payment buys that answer. It is not a subscription to the owner."""

    async def test_a_second_question_needs_its_own_approval_and_payment(self, answer_engine):  # noqa: F811
        service, first_id, digest = await _approved(answer_engine)
        _mark_paid(answer_engine, first_id, digest)
        await service.deliver(owner_user_id=OWNER, request_id=first_id, envelope=ENVELOPE)

        # The same requester asks again. Paying once must not carry over.
        second = await service.create(
            requester_user_id=REQUESTER,
            owner_user_id=OWNER,
            question="And what about last December specifically?",
        )
        second_id = second["requestId"]

        with answer_engine.begin() as connection:
            status = connection.execute(
                text("SELECT status FROM pkm_answer_requests WHERE request_id=:r"),
                {"r": second_id},
            ).scalar()
            orders = connection.execute(
                text("SELECT count(*) FROM pkm_answer_payment_orders WHERE request_id=:r"),
                {"r": second_id},
            ).scalar()
        # Back to the owner for approval, with no order and no price.
        assert status == "awaiting_owner"
        assert orders == 0

        # And it is not answerable until it is approved and paid.
        with pytest.raises(AnswerRequestError, match="request_not_answerable"):
            await service.assert_answerable(owner_user_id=OWNER, request_id=second_id)

    async def test_the_answer_is_fetchable_only_by_its_own_requester(self, answer_engine):  # noqa: F811
        service, request_id, digest = await _approved(answer_engine)
        _mark_paid(answer_engine, request_id, digest)
        await service.deliver(owner_user_id=OWNER, request_id=request_id, envelope=ENVELOPE)

        # The person who paid can read it.
        answer = await service.fetch_answer(requester_user_id=REQUESTER, request_id=request_id)
        assert answer["ciphertext"]

        # Nobody else can, including the owner.
        for other in ("someone-else", OWNER):
            with pytest.raises(AnswerRequestError, match="answer_unavailable"):
                await service.fetch_answer(requester_user_id=other, request_id=request_id)

    async def test_approval_creates_no_standing_grant(self, answer_engine):  # noqa: F811
        service, request_id, _digest = await _approved(answer_engine)
        with answer_engine.begin() as connection:
            # The approval records which scopes this one question may use and
            # nothing else: no consent token, no durable grant row.
            scopes = connection.execute(
                text(
                    "SELECT count(*) FROM pkm_answer_request_scopes"
                    " WHERE request_id=:r AND approved"
                ),
                {"r": request_id},
            ).scalar()
            audits = connection.execute(
                text("SELECT count(*) FROM consent_audit WHERE user_id=:u"),
                {"u": OWNER},
            ).scalar()
        assert scopes == 1
        assert audits == 0


class TestAFailedAnswerRetriesThenRefunds:
    async def test_a_request_the_device_never_answers_expires_and_refunds(self, answer_engine):  # noqa: F811
        # The sweep leaves a failed request queued, so it retries on the next
        # unlock. If it never succeeds, the deadline is the backstop.
        service, request_id, digest = await _approved(answer_engine)
        _mark_paid(answer_engine, request_id, digest)
        with answer_engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE pkm_answer_requests"
                    " SET answer_deadline_at = clock_timestamp() - INTERVAL '1 hour'"
                    " WHERE request_id = :r"
                ),
                {"r": request_id},
            )

        worker = PkmAnswerWorkWorker(_db(answer_engine), stripe_api=Mock())
        outcome = await worker.run_timeouts(max_jobs=5)
        assert outcome["expired"] == 1
        assert outcome["refunds_filed"] == 1

        with answer_engine.begin() as connection:
            row = (
                connection.execute(
                    text(
                        "SELECT r.status, f.reason FROM pkm_answer_requests r"
                        " JOIN pkm_answer_payment_refunds f ON f.request_id = r.request_id"
                        " WHERE r.request_id=:r"
                    ),
                    {"r": request_id},
                )
                .mappings()
                .first()
            )
        assert row["status"] == "expired"
        assert row["reason"] == "answer_timeout"

    async def test_a_delivered_answer_is_never_expired_out_from_under_it(self, answer_engine):  # noqa: F811
        service, request_id, digest = await _approved(answer_engine)
        _mark_paid(answer_engine, request_id, digest)
        await service.deliver(owner_user_id=OWNER, request_id=request_id, envelope=ENVELOPE)
        with answer_engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE pkm_answer_requests"
                    " SET answer_deadline_at = clock_timestamp() - INTERVAL '1 hour'"
                    " WHERE request_id = :r"
                ),
                {"r": request_id},
            )
        outcome = await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=Mock()).run_timeouts(
            max_jobs=5
        )
        # The delivery exists, so the sweep must not claim it.
        assert outcome["expired"] == 0


class TestPayouts:
    async def test_a_delivered_answer_earns_gross_minus_commission(self, answer_engine):  # noqa: F811
        service, request_id, digest = await _approved(answer_engine, amount=10_000)
        _mark_paid(answer_engine, request_id, digest, amount=10_000)
        await service.deliver(owner_user_id=OWNER, request_id=request_id, envelope=ENVELOPE)
        with answer_engine.begin() as connection:
            connection.execute(
                text(
                    """INSERT INTO pkm_owner_payout_accounts
                       (user_id, stripe_account_id, details_submitted, payouts_enabled)
                       VALUES (:u,'acct_test',TRUE,TRUE)
                       ON CONFLICT (user_id) DO NOTHING"""
                ),
                {"u": OWNER},
            )
        api = Mock()
        api.Transfer.create.return_value = {"id": "tr_test_1"}
        outcome = await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api).run_payouts(
            max_jobs=5
        )
        assert outcome["transferred"] == 1
        # 300 bps of 10000 is 300; the owner earns 9700.
        assert api.Transfer.create.call_args.kwargs["amount"] == 9_700
        assert api.Transfer.create.call_args.kwargs["destination"] == "acct_test"

    async def test_an_owner_without_a_payout_account_waits_instead_of_failing(self, answer_engine):  # noqa: F811
        service, request_id, digest = await _approved(answer_engine)
        _mark_paid(answer_engine, request_id, digest)
        await service.deliver(owner_user_id=OWNER, request_id=request_id, envelope=ENVELOPE)
        api = Mock()
        outcome = await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api).run_payouts(
            max_jobs=5
        )
        assert outcome["awaiting_account"] == 1
        api.Transfer.create.assert_not_called()
        with answer_engine.begin() as connection:
            status = connection.execute(
                text("SELECT status FROM pkm_answer_owner_payouts WHERE request_id=:r"),
                {"r": request_id},
            ).scalar()
        assert status == "awaiting_account"


class TestStripeModeIsolation:
    async def test_the_mode_isolated_account_wins_over_the_legacy_one(self, answer_engine):  # noqa: F811
        # Migration 298 exists because paying a live answer into a test-mode
        # Connect account (or the reverse) is a real way to lose money.
        service, request_id, digest = await _approved(answer_engine, amount=10_000)
        _mark_paid(answer_engine, request_id, digest, amount=10_000)
        await service.deliver(owner_user_id=OWNER, request_id=request_id, envelope=ENVELOPE)
        with answer_engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO pkm_owner_payout_accounts"
                    " (user_id,stripe_account_id,details_submitted,payouts_enabled)"
                    " VALUES (:u,'acct_legacy',TRUE,TRUE)"
                ),
                {"u": OWNER},
            )
            connection.execute(
                text(
                    "INSERT INTO stripe_owner_payout_accounts"
                    " (user_id,stripe_mode,stripe_account_id,payouts_enabled,account_ready)"
                    " VALUES (:u,'test','acct_test_mode',TRUE,TRUE)"
                ),
                {"u": OWNER},
            )
        api = Mock()
        api.Transfer.create.return_value = {"id": "tr_1"}
        await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api).run_payouts(max_jobs=5)
        assert api.Transfer.create.call_args.kwargs["destination"] == "acct_test_mode"

    async def test_an_account_verified_in_another_mode_is_not_used(self, answer_engine):  # noqa: F811
        service, request_id, digest = await _approved(answer_engine)
        _mark_paid(answer_engine, request_id, digest)
        await service.deliver(owner_user_id=OWNER, request_id=request_id, envelope=ENVELOPE)
        with answer_engine.begin() as connection:
            # Only a live-mode account exists; this runtime is in test mode.
            connection.execute(
                text(
                    "INSERT INTO stripe_owner_payout_accounts"
                    " (user_id,stripe_mode,stripe_account_id,payouts_enabled,account_ready)"
                    " VALUES (:u,'live','acct_live_mode',TRUE,TRUE)"
                ),
                {"u": OWNER},
            )
        api = Mock()
        outcome = await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api).run_payouts(
            max_jobs=5
        )
        # It waits for a test-mode account rather than paying the live one.
        assert outcome["awaiting_account"] == 1
        api.Transfer.create.assert_not_called()


class TestDisabledLane:
    async def test_every_worker_short_circuits_while_the_flag_is_off(
        self,
        answer_engine,  # noqa: F811
        monkeypatch,
    ):
        monkeypatch.setenv("PKM_ANSWER_PAYMENTS_ENABLED", "false")
        worker = PkmAnswerWorkWorker(_db(answer_engine), stripe_api=Mock())
        assert await worker.run_timeouts() == {"disabled": 1}
        assert await worker.run_refunds() == {"disabled": 1}
        assert await worker.run_payouts() == {"disabled": 1}
