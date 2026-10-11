"""Actual concurrent service calls and provider recovery on isolated PostgreSQL."""

from __future__ import annotations

# ruff: noqa: F811
import asyncio
import threading
from pathlib import Path
from unittest.mock import Mock

import pytest
from sqlalchemy import text

from hushh_mcp.services.pkm_answer_payment_service import (
    AnswerPaymentError,
    PkmAnswerPaymentService,
)
from hushh_mcp.services.pkm_answer_request_service import AnswerRequestError
from hushh_mcp.services.pkm_answer_work_worker import PkmAnswerWorkWorker
from tests.services.test_pkm_answer_races_postgres import (
    TestPaymentArrivingAfterTheRequestClosed as LatePayment,
)
from tests.services.test_pkm_answer_races_postgres import (  # noqa: F401
    _approved,
    _stripe_payout_api,
    payments_enabled,
)
from tests.services.test_pkm_answer_requests_postgres import (  # noqa: F401
    ENVELOPE,
    OWNER,
    REQUESTER,
    _db,
    _mark_paid,
    answer_engine,
    clean,
    connector_postgres_url,
)


def row(engine, table, request):
    with engine.begin() as c:
        return dict(
            c.execute(text(f"SELECT * FROM {table} WHERE request_id=:r"), {"r": request})
            .mappings()
            .one()
        )


def due(engine, table, request):
    with engine.begin() as c:
        c.execute(
            text(f"UPDATE {table} SET next_check_at=clock_timestamp() WHERE request_id=:r"),
            {"r": request},
        )


def refund_api(status="succeeded", **overrides):
    api = Mock()
    result = {
        "id": "re_verified",
        "payment_intent": "pi_x",
        "amount": 1000,
        "currency": "usd",
        "livemode": False,
        "status": status,
        **overrides,
    }
    api.Refund.create.return_value = result
    api.Refund.retrieve.return_value = result
    api.Refund.list.return_value = {"data": [], "has_more": False}
    return api


async def paid(engine):
    service, request, digest = await _approved(engine)
    _mark_paid(engine, request, digest)
    return service, request


async def test_overlapping_checkout_reuses_durable_attempt_and_parameters(answer_engine):
    _, request, _ = await _approved(answer_engine)
    entered = threading.Event()
    release = threading.Event()
    calls = []
    cache = {}
    guard = threading.Lock()
    api = Mock()

    def create(**kw):
        with guard:
            calls.append(kw)
            result = cache.setdefault(
                kw["idempotency_key"],
                {
                    "id": "cs_one",
                    "url": "https://checkout.stripe.com/c/pay/cs_one",
                    "expires_at": kw["expires_at"],
                },
            )
            first = len(calls) == 1
        if first:
            entered.set()
            assert release.wait(5)
        return result

    api.checkout.Session.create.side_effect = create
    service = PkmAnswerPaymentService(_db(answer_engine), stripe_api=api)
    first = asyncio.create_task(service.checkout(requester_user_id=REQUESTER, request_id=request))
    assert await asyncio.to_thread(entered.wait, 5)
    try:
        second = await asyncio.wait_for(
            service.checkout(requester_user_id=REQUESTER, request_id=request), 5
        )
    finally:
        release.set()
    assert await first == second
    assert len(cache) == 1 and calls[0] == calls[1]
    assert (
        row(answer_engine, "pkm_answer_payment_orders", request)["stripe_checkout_session_id"]
        == "cs_one"
    )


async def test_lost_checkout_response_recovers_same_provider_session(answer_engine):
    _, request, _ = await _approved(answer_engine)
    api = Mock()
    seen = []

    def create(**kw):
        seen.append(kw)
        if len(seen) == 1:
            raise TimeoutError("response lost after provider accepted")
        return {
            "id": "cs_recovered",
            "url": "https://checkout.stripe.com/c/pay/cs_recovered",
            "expires_at": kw["expires_at"],
        }

    api.checkout.Session.create.side_effect = create
    service = PkmAnswerPaymentService(_db(answer_engine), stripe_api=api)
    with pytest.raises(TimeoutError):
        await service.checkout(requester_user_id=REQUESTER, request_id=request)
    await service.checkout(requester_user_id=REQUESTER, request_id=request)
    assert seen[0] == seen[1]


async def test_webhook_and_cancel_overlap_without_deadlock_or_lost_refund(answer_engine):
    service, request, digest = await _approved(answer_engine)
    attempt = "55555555-8888-9999-aaaa-bbbbbbbbbbbb"
    LatePayment._open_checkout(answer_engine, request, digest, attempt)
    await asyncio.wait_for(
        asyncio.gather(
            LatePayment._settle_webhook(answer_engine, request, digest, attempt, "evt_parallel"),
            service.cancel(requester_user_id=REQUESTER, request_id=request),
        ),
        5,
    )
    assert row(answer_engine, "pkm_answer_requests", request)["status"] == "cancelled"
    assert (
        row(answer_engine, "pkm_answer_payment_refunds", request)["reason"] == "requester_cancelled"
    )


async def test_distinct_late_paid_event_preserves_refunded_terminal_state(answer_engine):
    service, request, digest = await _approved(answer_engine)
    attempt = "55555555-8888-9999-aaaa-bbbbbbbbbbbb"
    LatePayment._open_checkout(answer_engine, request, digest, attempt)
    await LatePayment._settle_webhook(answer_engine, request, digest, attempt, "evt_first")
    await service.cancel(requester_user_id=REQUESTER, request_id=request)
    api = refund_api(payment_intent="pi_late_evt_first")
    assert (await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api).run_refunds())[
        "succeeded"
    ] == 1
    await LatePayment._settle_webhook(
        answer_engine, request, digest, attempt, "evt_first", event_id="evt_distinct_late"
    )
    assert row(answer_engine, "pkm_answer_payment_orders", request)["status"] == "refunded"
    assert row(answer_engine, "pkm_answer_requests", request)["status"] == "cancelled"


@pytest.mark.parametrize(
    "overrides",
    [
        {"livemode": True},
        {"amount": 999},
        {"payment_intent": "pi_other"},
        {"id": None},
        {"status": "failed"},
    ],
)
async def test_unverified_refund_never_marks_order_refunded(answer_engine, overrides):
    service, request = await paid(answer_engine)
    await service.cancel(requester_user_id=REQUESTER, request_id=request)
    outcome = await PkmAnswerWorkWorker(
        _db(answer_engine), stripe_api=refund_api(**overrides)
    ).run_refunds()
    assert outcome["succeeded"] == 0
    assert row(answer_engine, "pkm_answer_payment_orders", request)["status"] == "paid"
    assert row(answer_engine, "pkm_answer_payment_refunds", request)["status"] == "manual_review"


async def test_pending_refund_is_retrieved_until_verified_success(answer_engine):
    service, request = await paid(answer_engine)
    await service.cancel(requester_user_id=REQUESTER, request_id=request)
    api = refund_api("pending")
    worker = PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api)
    await worker.run_refunds()
    assert row(answer_engine, "pkm_answer_payment_orders", request)["status"] == "paid"
    due(answer_engine, "pkm_answer_payment_refunds", request)
    api.Refund.retrieve.return_value = refund_api().Refund.retrieve.return_value
    assert (await worker.run_refunds())["succeeded"] == 1
    assert api.Refund.create.call_count == 1


async def test_overlapping_refund_workers_and_stale_lease_completion(answer_engine):
    service, request = await paid(answer_engine)
    await service.cancel(requester_user_id=REQUESTER, request_id=request)
    entered = threading.Event()
    release = threading.Event()
    api = refund_api()

    def slow(**kw):
        entered.set()
        assert release.wait(5)
        return refund_api().Refund.create.return_value

    api.Refund.create.side_effect = slow
    first = asyncio.create_task(
        PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api).run_refunds()
    )
    assert await asyncio.to_thread(entered.wait, 5)
    second = refund_api()
    try:
        assert (await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=second).run_refunds())[
            "succeeded"
        ] == 0
        second.Refund.create.assert_not_called()
        with answer_engine.begin() as c:
            c.execute(
                text(
                    "UPDATE pkm_answer_payment_refunds SET lease_expires_at=clock_timestamp()-INTERVAL '1 second', next_check_at=clock_timestamp()"
                )
            )
        second.Refund.list.return_value = {
            "data": [refund_api(id="re_reconciled").Refund.create.return_value],
            "has_more": False,
        }
        await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=second).run_refunds()
    finally:
        release.set()
    assert (await first)["succeeded"] == 0
    assert (
        row(answer_engine, "pkm_answer_payment_refunds", request)["stripe_refund_id"]
        == "re_reconciled"
    )


async def test_revocation_blocks_claim_compose_delivery_and_refunds(answer_engine):
    service, request = await paid(answer_engine)
    assert await service.claim_answerable(owner_user_id=OWNER)
    with answer_engine.begin() as c:
        c.execute(text("UPDATE connections SET status='revoked'"))
    assert await service.claim_answerable(owner_user_id=OWNER) == []
    with pytest.raises(AnswerRequestError, match="connection_required"):
        await service.assert_answerable(owner_user_id=OWNER, request_id=request)
    with pytest.raises(AnswerRequestError, match="connection_required"):
        await service.deliver(owner_user_id=OWNER, request_id=request, envelope=ENVELOPE)
    assert (await PkmAnswerWorkWorker(_db(answer_engine)).run_timeouts())["refunds_filed"] == 1


async def test_delivery_rejects_unrelated_or_revoked_recipient_key(answer_engine):
    service, request = await paid(answer_engine)
    with pytest.raises(AnswerRequestError, match="invalid_envelope"):
        await service.deliver(
            owner_user_id=OWNER,
            request_id=request,
            envelope={**ENVELOPE, "recipientKeyId": "other"},
        )
    with answer_engine.begin() as c:
        c.execute(text("UPDATE marketplace_recipient_keys SET status='revoked'"))
    with pytest.raises(AnswerRequestError, match="invalid_envelope"):
        await service.deliver(owner_user_id=OWNER, request_id=request, envelope=ENVELOPE)


async def test_empty_answer_service_files_full_refund_and_no_earning(answer_engine):
    service, request = await paid(answer_engine)
    await service.deliver(
        owner_user_id=OWNER, request_id=request, envelope=ENVELOPE, has_content=False
    )
    assert row(answer_engine, "pkm_answer_payment_refunds", request)["reason"] == "empty_answer"
    worker = PkmAnswerWorkWorker(_db(answer_engine), stripe_api=refund_api())
    assert (await worker.run_refunds())["succeeded"] == 1
    assert (await worker.run_payouts())["transferred"] == 0


async def test_account_enrollment_recovers_waiting_payout_without_legacy_fallback(answer_engine):
    service, request = await paid(answer_engine)
    await service.deliver(owner_user_id=OWNER, request_id=request, envelope=ENVELOPE)
    with answer_engine.begin() as c:
        c.execute(
            text(
                "INSERT INTO pkm_owner_payout_accounts(user_id,stripe_account_id,payouts_enabled) VALUES (:u,'acct_legacy',true)"
            ),
            {"u": OWNER},
        )
    api = _stripe_payout_api(amount=1000)
    worker = PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api)
    assert (await worker.run_payouts())["awaiting_account"] == 1
    with answer_engine.begin() as c:
        c.execute(
            text(
                "INSERT INTO stripe_owner_payout_accounts(user_id,stripe_mode,stripe_account_id,payouts_enabled,account_ready) VALUES (:u,'test','acct_ready',true,true)"
            ),
            {"u": OWNER},
        )
    due(answer_engine, "pkm_answer_owner_payouts", request)
    assert (await worker.run_payouts())["transferred"] == 1
    assert api.Transfer.create.call_args.kwargs["destination"] == "acct_ready"


async def test_stale_provider_account_is_not_paid(answer_engine):
    service, request = await paid(answer_engine)
    await service.deliver(owner_user_id=OWNER, request_id=request, envelope=ENVELOPE)
    with answer_engine.begin() as c:
        c.execute(
            text(
                "INSERT INTO stripe_owner_payout_accounts(user_id,stripe_mode,stripe_account_id,payouts_enabled,account_ready) VALUES (:u,'test','acct_stale',true,true)"
            ),
            {"u": OWNER},
        )
    api = _stripe_payout_api(amount=1000)
    api.Account.retrieve.side_effect = None
    api.Account.retrieve.return_value = {"id": "acct_stale", "deleted": True}
    assert (await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api).run_payouts())[
        "awaiting_account"
    ] == 1
    api.Transfer.create.assert_not_called()


async def test_test_obligations_never_run_with_live_answer_credentials(answer_engine, monkeypatch):
    service, request = await paid(answer_engine)
    await service.cancel(requester_user_id=REQUESTER, request_id=request)
    monkeypatch.setenv("PKM_ANSWER_STRIPE_MODE", "live")
    monkeypatch.setenv("PKM_ANSWER_STRIPE_SECRET_KEY", "sk_live_synthetic_only_key")
    monkeypatch.setenv("PKM_ANSWER_STRIPE_WEBHOOK_SECRET", "whsec_synthetic_only_secret")
    api = refund_api()
    assert (await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api).run_refunds())[
        "succeeded"
    ] == 0
    api.Refund.create.assert_not_called()


async def test_expand_only_rollback_preserves_financial_recovery_bindings(answer_engine):
    service, request = await paid(answer_engine)
    await service.deliver(owner_user_id=OWNER, request_id=request, envelope=ENVELOPE)
    worker = PkmAnswerWorkWorker(_db(answer_engine), stripe_api=_stripe_payout_api(amount=1000))
    await worker.run_payouts()
    with answer_engine.begin() as c:
        c.execute(
            text(
                "UPDATE pkm_answer_owner_payouts SET first_dispatch_at=clock_timestamp(),status='unknown' WHERE request_id=:r"
            ),
            {"r": request},
        )
    dispatched = row(answer_engine, "pkm_answer_owner_payouts", request)["first_dispatch_at"]
    migrations = Path(__file__).resolve().parents[2] / "db/migrations"
    raw = answer_engine.raw_connection()
    try:
        cursor = raw.cursor()
        for name in (
            "303_pkm_answer_payment_recovery.sql",
            "rollback/303_pkm_answer_payment_recovery.rollback.sql",
            "303_pkm_answer_payment_recovery.sql",
        ):
            cursor.execute((migrations / name).read_text())
        raw.commit()
    finally:
        raw.close()
    assert row(answer_engine, "pkm_answer_payment_orders", request)["stripe_mode"] == "test"

    assert row(answer_engine, "pkm_answer_payment_obligations", request)["stripe_mode"] == "test"
    assert (
        row(answer_engine, "pkm_answer_owner_payouts", request)["first_dispatch_at"] == dispatched
    )


@pytest.mark.parametrize("end_authority", ["cancel", "revoke"])
async def test_checkout_creation_does_not_advertise_session_after_authority_ends(
    answer_engine, end_authority
):
    requests, request, _ = await _approved(answer_engine)
    entered = threading.Event()
    release = threading.Event()
    api = Mock()

    def create(**kw):
        entered.set()
        assert release.wait(5)
        return {
            "id": "cs_cancelled",
            "url": "https://checkout.stripe.com/c/pay/cs_cancelled",
            "expires_at": kw["expires_at"],
        }

    api.checkout.Session.create.side_effect = create
    service = PkmAnswerPaymentService(_db(answer_engine), stripe_api=api)
    task = asyncio.create_task(service.checkout(requester_user_id=REQUESTER, request_id=request))
    assert await asyncio.to_thread(entered.wait, 5)
    try:
        if end_authority == "cancel":
            await requests.cancel(requester_user_id=REQUESTER, request_id=request)
        else:
            with answer_engine.begin() as c:
                c.execute(text("UPDATE connections SET status='revoked'"))
    finally:
        release.set()
    with pytest.raises(AnswerPaymentError):
        await task
    api.checkout.Session.expire.assert_called_once()


async def test_direct_checkout_refuses_unapproved_composer_before_provider(
    answer_engine, monkeypatch
):
    _, request, _ = await _approved(answer_engine)
    monkeypatch.setenv("PKM_ANSWER_COMPOSER_ENABLED", "false")
    api = Mock()
    with pytest.raises(AnswerPaymentError, match="composer_not_enabled"):
        await PkmAnswerPaymentService(_db(answer_engine), stripe_api=api).checkout(
            requester_user_id=REQUESTER, request_id=request
        )
    api.checkout.Session.create.assert_not_called()


async def test_simultaneous_duplicate_paid_webhook_is_single_effect(answer_engine):
    _, request, digest = await _approved(answer_engine)
    attempt = "55555555-8888-9999-aaaa-bbbbbbbbbbbb"
    LatePayment._open_checkout(answer_engine, request, digest, attempt)
    await asyncio.wait_for(
        asyncio.gather(
            *[
                LatePayment._settle_webhook(
                    answer_engine, request, digest, attempt, "evt_duplicate"
                )
                for _ in range(2)
            ]
        ),
        5,
    )
    with answer_engine.begin() as c:
        assert (
            c.execute(
                text(
                    "SELECT count(*) FROM pkm_answer_payment_webhook_events WHERE stripe_event_id='evt_duplicate'"
                )
            ).scalar()
            == 1
        )
    assert row(answer_engine, "pkm_answer_requests", request)["status"] == "answering"


async def test_unbound_historical_mode_requires_reconciliation(answer_engine):
    service, request = await paid(answer_engine)
    await service.cancel(requester_user_id=REQUESTER, request_id=request)
    with answer_engine.begin() as c:
        c.execute(
            text("UPDATE pkm_answer_payment_orders SET stripe_mode=NULL WHERE request_id=:r"),
            {"r": request},
        )
    api = refund_api()
    assert (await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api).run_refunds())[
        "succeeded"
    ] == 0
    api.Refund.create.assert_not_called()
