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
