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
    _deliver_composed,
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
    api.PaymentIntent.retrieve.side_effect = lambda intent_id, **kwargs: {
        "id": intent_id,
        "status": "succeeded",
        "livemode": False,
        "amount": 1000,
        "amount_received": 1000,
        "currency": "usd",
    }
    api.Refund.create.return_value = result
    api.Refund.retrieve.return_value = result
    api.Refund.list.return_value = {"data": [], "has_more": False}
    return api


async def paid(engine):
    service, request, digest = await _approved(engine)
    _mark_paid(engine, request, digest)
    return service, request


def select_live_with_retained_test_keys(monkeypatch):
    """Mirror UAT's live shared Drive lane beside historical answer orders."""
    monkeypatch.setenv("PKM_ANSWER_STRIPE_TEST_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("PKM_ANSWER_STRIPE_TEST_WEBHOOK_SECRET", "whsec_payment_test_secret_value")
    monkeypatch.setenv("STRIPE_MODE", "live")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_shared_synthetic_only_key")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_shared_synthetic_only_live_secret")
    monkeypatch.setenv("PKM_ANSWER_STRIPE_MODE", "live")
    monkeypatch.setenv("PKM_ANSWER_STRIPE_SECRET_KEY", "sk_live_synthetic_only_key")
    monkeypatch.setenv("PKM_ANSWER_STRIPE_WEBHOOK_SECRET", "whsec_synthetic_only_secret")


async def test_overlapping_checkout_reuses_durable_attempt_and_parameters(answer_engine):
    _, request, _ = await _approved(answer_engine, prepared=True)
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


@pytest.mark.parametrize("switch_live", [False, True])
async def test_lost_checkout_response_recovers_same_provider_session(
    answer_engine, monkeypatch, switch_live
):
    _, request, _ = await _approved(answer_engine, prepared=True)
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
    if switch_live:
        select_live_with_retained_test_keys(monkeypatch)
        monkeypatch.setenv("PKM_ANSWER_LIVE_PROVIDER_REVIEWED", "true")
    await service.checkout(requester_user_id=REQUESTER, request_id=request)
    assert seen[0] == seen[1]
    assert seen[1]["api_key"].startswith("sk_test_")


@pytest.mark.parametrize("blocker", ["receiptless", "composer_paused"])
async def test_old_reserved_checkout_cannot_mint_payable_session_without_prepared_gemini(
    answer_engine, monkeypatch, blocker
):
    _, request, _ = await _approved(answer_engine, prepared=True)
    api = Mock()
    api.checkout.Session.create.side_effect = TimeoutError("provider dispatch outcome unknown")
    service = PkmAnswerPaymentService(_db(answer_engine), stripe_api=api)
    with pytest.raises(TimeoutError):
        await service.checkout(requester_user_id=REQUESTER, request_id=request)
    before = row(answer_engine, "pkm_answer_payment_orders", request)
    assert before["status"] == "awaiting_payment"
    if blocker == "receiptless":
        with answer_engine.begin() as c:
            c.execute(
                text(
                    "UPDATE pkm_answer_deliveries SET source_revisions='{}'::jsonb WHERE request_id=:r"
                ),
                {"r": request},
            )
    else:
        monkeypatch.setenv("PKM_ANSWER_COMPOSER_ENABLED", "false")
    with pytest.raises(
        AnswerPaymentError,
        match="answer_not_ready" if blocker == "receiptless" else "composer_not_enabled",
    ):
        await service.checkout(requester_user_id=REQUESTER, request_id=request)
    assert api.checkout.Session.create.call_count == 1
    assert row(answer_engine, "pkm_answer_payment_orders", request) == before


@pytest.mark.parametrize("blocker", ["receiptless", "composer_paused", "payments_paused"])
async def test_payment_status_hides_payable_url_without_prepared_answer_and_open_gates(
    answer_engine, monkeypatch, blocker
):
    _, request, _ = await _approved(answer_engine, prepared=True)
    api = Mock()
    api.checkout.Session.create.side_effect = lambda **kw: {
        "id": "cs_status_guard",
        "url": "https://checkout.stripe.com/c/pay/cs_status_guard",
        "expires_at": kw["expires_at"],
    }
    service = PkmAnswerPaymentService(_db(answer_engine), stripe_api=api)
    opened = await service.checkout(requester_user_id=REQUESTER, request_id=request)
    visible = await service.get_payment(requester_user_id=REQUESTER, request_id=request)
    assert visible["checkoutUrl"] == opened["checkoutUrl"]
    if blocker == "receiptless":
        with answer_engine.begin() as c:
            c.execute(
                text(
                    "UPDATE pkm_answer_deliveries SET source_revisions='{}'::jsonb WHERE request_id=:r"
                ),
                {"r": request},
            )
    else:
        name = (
            "PKM_ANSWER_COMPOSER_ENABLED"
            if blocker == "composer_paused"
            else "PKM_ANSWER_PAYMENTS_ENABLED"
        )
        monkeypatch.setenv(name, "false")
    before = row(answer_engine, "pkm_answer_payment_orders", request)
    hidden = await service.get_payment(requester_user_id=REQUESTER, request_id=request)
    assert hidden["checkoutUrl"] is None
    assert hidden["preparationStatus"] == ("preparing" if blocker == "receiptless" else "ready")
    assert row(answer_engine, "pkm_answer_payment_orders", request) == before
    assert api.checkout.Session.create.call_count == 1


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
        await _deliver_composed(
            service, answer_engine, owner_user_id=OWNER, request_id=request, envelope=ENVELOPE
        )
    assert (await PkmAnswerWorkWorker(_db(answer_engine)).run_timeouts())["refunds_filed"] == 1


async def test_delivery_rejects_unrelated_or_revoked_recipient_key(answer_engine):
    service, request = await paid(answer_engine)
    with pytest.raises(AnswerRequestError, match="invalid_envelope"):
        await _deliver_composed(
            service,
            answer_engine,
            owner_user_id=OWNER,
            request_id=request,
            envelope={**ENVELOPE, "recipientKeyId": "other"},
        )
    with answer_engine.begin() as c:
        c.execute(text("UPDATE marketplace_recipient_keys SET status='revoked'"))
    with pytest.raises(AnswerRequestError, match="invalid_envelope"):
        await _deliver_composed(
            service, answer_engine, owner_user_id=OWNER, request_id=request, envelope=ENVELOPE
        )


async def test_empty_answer_service_files_full_refund_and_no_earning(answer_engine):
    service, request = await paid(answer_engine)
    await _deliver_composed(
        service,
        answer_engine,
        owner_user_id=OWNER,
        request_id=request,
        envelope=ENVELOPE,
        has_content=False,
    )
    assert row(answer_engine, "pkm_answer_payment_refunds", request)["reason"] == "empty_answer"
    worker = PkmAnswerWorkWorker(_db(answer_engine), stripe_api=refund_api())
    assert (await worker.run_refunds())["succeeded"] == 1
    assert (await worker.run_payouts())["transferred"] == 0


async def test_account_enrollment_recovers_waiting_payout_without_legacy_fallback(answer_engine):
    service, request = await paid(answer_engine)
    await _deliver_composed(
        service, answer_engine, owner_user_id=OWNER, request_id=request, envelope=ENVELOPE
    )
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
    await _deliver_composed(
        service, answer_engine, owner_user_id=OWNER, request_id=request, envelope=ENVELOPE
    )
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


async def test_test_obligations_use_test_credentials_when_new_orders_are_live(
    answer_engine, monkeypatch
):
    service, request = await paid(answer_engine)
    await service.cancel(requester_user_id=REQUESTER, request_id=request)
    monkeypatch.setenv("PKM_ANSWER_STRIPE_MODE", "live")
    monkeypatch.setenv("PKM_ANSWER_STRIPE_SECRET_KEY", "sk_live_synthetic_only_key")
    monkeypatch.setenv("PKM_ANSWER_STRIPE_WEBHOOK_SECRET", "whsec_synthetic_only_secret")
    api = refund_api()
    assert (await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api).run_refunds())[
        "succeeded"
    ] == 1
    assert api.Refund.create.call_count == 1
    for call in api.PaymentIntent.retrieve.call_args_list + api.Refund.create.call_args_list:
        assert call.kwargs["api_key"].startswith("sk_test_")


async def test_expand_only_rollback_preserves_financial_recovery_bindings(answer_engine):
    service, request = await paid(answer_engine)
    await _deliver_composed(
        service, answer_engine, owner_user_id=OWNER, request_id=request, envelope=ENVELOPE
    )
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
            "305_pkm_answer_payment_recovery.sql",
            "rollback/305_pkm_answer_payment_recovery.rollback.sql",
            "305_pkm_answer_payment_recovery.sql",
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
    requests, request, _ = await _approved(answer_engine, prepared=True)
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
    _, request, _ = await _approved(answer_engine, prepared=True)
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


async def test_existing_feed_status_projection_and_rollback(answer_engine):
    service, request, _ = await _approved(answer_engine)
    query = text(
        "SELECT metadata FROM feed_events WHERE source_domain='consent' AND source_row_id=:source ORDER BY id"
    )
    values = {"source": f"answer_request:{request}"}
    with answer_engine.connect() as c:
        before = list(c.execute(query, values).scalars())
    assert before
    with answer_engine.connect() as c:
        tx = c.begin()
        c.execute(
            text(
                "UPDATE pkm_answer_requests SET status='cancelled',updated_at=clock_timestamp() WHERE request_id=:r"
            ),
            {"r": request},
        )
        assert all(value["status"] == "cancelled" for value in c.execute(query, values).scalars())
        tx.rollback()
    with answer_engine.connect() as c:
        assert list(c.execute(query, values).scalars()) == before
    await service.cancel(requester_user_id=REQUESTER, request_id=request)
    with answer_engine.connect() as c:
        assert all(value["status"] == "cancelled" for value in c.execute(query, values).scalars())


async def test_recovered_expired_checkout_never_advertises_stale_url(answer_engine):
    _, request, _ = await _approved(answer_engine, prepared=True)
    api = Mock()
    api.checkout.Session.create.return_value = {
        "id": "cs_expired",
        "url": "https://checkout.stripe.com/c/pay/cs_expired",
        "expires_at": 1,
        "status": "expired",
    }
    service = PkmAnswerPaymentService(db=_db(answer_engine), stripe_api=api)
    with pytest.raises(AnswerPaymentError, match="checkout_unavailable"):
        await service.checkout(requester_user_id=REQUESTER, request_id=request)
    assert (
        row(answer_engine, "pkm_answer_payment_orders", request)["stripe_checkout_session_id"]
        == "cs_expired"
    )


async def test_answer_center_role_status_isolation_and_single_row_per_request(answer_engine):
    from hushh_mcp.services.pkm_answer_center_contributor import PkmAnswerCenterContributor

    service, request, _ = await _approved(answer_engine)
    center = PkmAnswerCenterContributor(requests=service)
    expected = {
        "pending_resolution": ("incoming_requests", "outgoing_requests"),
        "awaiting_owner": ("incoming_requests", "outgoing_requests"),
        "approved": ("incoming_requests", "incoming_requests"),
        "answering": ("incoming_requests", "outgoing_requests"),
        "answered": ("history", "history"),
        "declined": ("history", "history"),
        "cancelled": ("history", "history"),
        "expired": ("history", "history"),
    }
    for status, participant_buckets in expected.items():
        with answer_engine.begin() as c:
            c.execute(
                text(
                    "UPDATE pkm_answer_requests SET status=:status, answered_at=CASE WHEN :status='answered' THEN clock_timestamp() ELSE NULL END, updated_at=clock_timestamp() WHERE request_id=:r"
                ),
                {"status": status, "r": request},
            )
        for user, bucket, role, counterpart in [
            (OWNER, participant_buckets[0], "owner", REQUESTER),
            (REQUESTER, participant_buckets[1], "requester", OWNER),
        ]:
            buckets = await center.collect(user)
            all_rows = [entry for entries in buckets.values() for entry in entries]
            assert len(all_rows) == 1
            assert len(buckets[bucket]) == 1
            entry = buckets[bucket][0]
            assert entry["id"] == f"answer_request:{request}"
            assert entry["counterpart_id"] == counterpart
            assert entry["metadata"]["role"] == role
            assert entry["metadata"]["request_status"] == status
            assert entry["scope"] is None
            assert entry["action"] == "ANSWER_REQUEST_REVIEW"
            # A closed set: this row reaches both participants, so a field
            # added here is a field disclosed to both.
            assert set(entry["metadata"]) == {
                "request_source",
                "role",
                "direction",
                "request_status",
                "payment_status",
                "question",
                "amount_cents",
                "proposed_scope_count",
                "answer_staged",
                "preparation_overdue",
                "answer_has_content",
            }
            # The Feed names the price and the question before the tap, so it
            # does not fetch one request per row. Both participants already
            # read these through /state and /payment.
            assert entry["metadata"]["question"] == "How much did you spend on travel last year?"
            assert isinstance(entry["metadata"]["proposed_scope_count"], int)
            assert entry["metadata"]["proposed_scope_count"] >= 0
        assert all(not entries for entries in (await center.collect("unrelated-account")).values())
    with answer_engine.begin() as c:
        c.execute(
            text(
                "UPDATE pkm_answer_requests SET status='approved',answered_at=NULL WHERE request_id=:r"
            ),
            {"r": request},
        )
        c.execute(
            text(
                "UPDATE connections SET status='revoked' WHERE (user_a_id=:a AND user_b_id=:b) OR (user_a_id=:b AND user_b_id=:a)"
            ),
            {"a": OWNER, "b": REQUESTER},
        )
    for user in [OWNER, REQUESTER]:
        buckets = await center.collect(user)
        assert buckets["incoming_requests"] == buckets["outgoing_requests"] == []
        assert len(buckets["history"]) == 1
        assert buckets["history"][0]["status"] == "connection_revoked"


async def test_real_refund_shape_without_livemode_uses_verified_source_intent(answer_engine):
    service, request = await paid(answer_engine)
    await service.cancel(requester_user_id=REQUESTER, request_id=request)
    api = refund_api()
    del api.Refund.create.return_value["livemode"]
    assert (await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api).run_refunds())[
        "succeeded"
    ] == 1
    api.PaymentIntent.retrieve.assert_called_once()
    assert row(answer_engine, "pkm_answer_payment_orders", request)["status"] == "refunded"


@pytest.mark.parametrize(
    "override",
    [{"livemode": True}, {"amount_received": 999}, {"currency": "eur"}, {"id": "pi_wrong"}],
)
async def test_refund_verifies_source_mode_and_terms_before_dispatch(answer_engine, override):
    service, request = await paid(answer_engine)
    await service.cancel(requester_user_id=REQUESTER, request_id=request)
    api = refund_api()
    api.PaymentIntent.retrieve.side_effect = None
    api.PaymentIntent.retrieve.return_value = {
        "id": "pi_x",
        "status": "succeeded",
        "livemode": False,
        "amount": 1000,
        "amount_received": 1000,
        "currency": "usd",
        **override,
    }
    result = await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api).run_refunds()
    assert result["manual_review"] == 1 and result["succeeded"] == 0
    api.Refund.create.assert_not_called()


async def test_missing_historical_key_preserves_refund_without_consuming_attempt(
    answer_engine, monkeypatch
):
    service, request = await paid(answer_engine)
    await service.cancel(requester_user_id=REQUESTER, request_id=request)
    monkeypatch.setenv("PKM_ANSWER_STRIPE_MODE", "live")
    monkeypatch.setenv("PKM_ANSWER_STRIPE_SECRET_KEY", "sk_live_synthetic_only_key")
    monkeypatch.setenv("PKM_ANSWER_STRIPE_WEBHOOK_SECRET", "whsec_synthetic_only_secret")
    monkeypatch.delenv("STRIPE_SECRET_KEY")
    monkeypatch.delenv("STRIPE_WEBHOOK_SECRET")
    api = refund_api()
    assert (await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api).run_refunds())[
        "succeeded"
    ] == 0
    assert row(answer_engine, "pkm_answer_payment_refunds", request)["attempts"] == 0
    api.Refund.create.assert_not_called()


async def test_old_test_answer_delivery_and_payout_survive_live_switch(answer_engine, monkeypatch):
    service, request = await paid(answer_engine)
    monkeypatch.setenv("PKM_ANSWER_LIVE_PROVIDER_REVIEWED", "true")
    select_live_with_retained_test_keys(monkeypatch)
    assert len(await service.claim_answerable(owner_user_id=OWNER)) == 1
    await _deliver_composed(
        service, answer_engine, owner_user_id=OWNER, request_id=request, envelope=ENVELOPE
    )
    assert (await service.fetch_answer(requester_user_id=REQUESTER, request_id=request))[
        "ciphertext"
    ] == ENVELOPE["ciphertext"]
    with answer_engine.begin() as c:
        c.execute(
            text(
                "INSERT INTO stripe_owner_payout_accounts(user_id,stripe_mode,stripe_account_id,payouts_enabled,account_ready) VALUES (:u,'test','acct_ready',true,true)"
            ),
            {"u": OWNER},
        )
    api = _stripe_payout_api(amount=1000)
    assert (await PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api).run_payouts())[
        "transferred"
    ] == 1
    assert api.Transfer.create.call_args.kwargs["api_key"].startswith("sk_test_")


async def test_old_test_timeout_still_files_refund_after_live_switch(answer_engine, monkeypatch):
    service, request = await paid(answer_engine)
    select_live_with_retained_test_keys(monkeypatch)
    with answer_engine.begin() as c:
        c.execute(
            text(
                "UPDATE pkm_answer_requests SET answer_deadline_at=clock_timestamp()-INTERVAL '1 hour' WHERE request_id=:r"
            ),
            {"r": request},
        )
    api = refund_api()
    worker = PkmAnswerWorkWorker(_db(answer_engine), stripe_api=api)
    assert (await worker.run_timeouts())["refunds_filed"] == 1
    assert (await worker.run_refunds())["succeeded"] == 1
    assert api.Refund.create.call_args.kwargs["api_key"].startswith("sk_test_")


async def test_staging_publishes_payable_price_without_order_and_updates_feed(answer_engine):
    from hushh_mcp.services.pkm_answer_center_contributor import PkmAnswerCenterContributor

    service, request, _ = await _approved(answer_engine)
    center = PkmAnswerCenterContributor(requests=service)
    before = (await center.collect(REQUESTER))["incoming_requests"][0]["metadata"]
    assert before["amount_cents"] == 1000
    assert before["answer_staged"] is False
    with answer_engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE pkm_answer_requests SET approved_at=now()-interval '3 minutes' WHERE request_id=:r"
            ),
            {"r": request},
        )
        connection.execute(
            text("UPDATE feed_events SET read_at=now() WHERE source_row_id=:r"),
            {"r": f"answer_request:{request}"},
        )
    pending = await PkmAnswerPaymentService(_db(answer_engine)).get_payment(
        requester_user_id=REQUESTER, request_id=request
    )
    assert pending["preparationStatus"] == "retry_required"
    await _deliver_composed(
        service, answer_engine, owner_user_id=OWNER, request_id=request, envelope=ENVELOPE
    )
    after = (await center.collect(REQUESTER))["incoming_requests"][0]["metadata"]
    assert after["answer_staged"] is True
    assert after["amount_cents"] == 1000
    with answer_engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM pkm_answer_payment_orders WHERE request_id=:r"),
                {"r": request},
            ).scalar_one()
            == 0
        )
        feed = (
            connection.execute(
                text(
                    "SELECT metadata, read_at FROM feed_events WHERE event_type='answer_request_payment_ready' AND source_row_id=:r"
                ),
                {"r": f"answer_request:{request}"},
            )
            .mappings()
            .one()
        )
        assert feed["metadata"]["status"] == "staged"
        assert feed["read_at"] is None
