"""Approval, recipient confidentiality and payment authority regression guards."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from pydantic import ValidationError
from test_finance_sharing_postgres import envelope

from hushh_mcp.services.advisor_review_billing import verified_subscription
from hushh_mcp.services.advisor_review_contract import (
    AdvisorPlan,
    CreateAdvisorReview,
    MeetingTime,
    PlanCheckout,
)
from hushh_mcp.services.advisor_review_store import AdvisorReviewError, project


def test_unready_payout_account_tells_each_person_their_own_next_step(monkeypatch):
    from hushh_mcp.services import advisor_review_billing as billing

    monkeypatch.setattr(billing, "one", lambda *_args, **_kwargs: None)
    # The advisor can finish their own Stripe setup; the owner paying cannot.
    with pytest.raises(AdvisorReviewError) as advisor_view:
        billing.payee(None, "advisor")
    with pytest.raises(AdvisorReviewError) as owner_view:
        billing.payee(None, "advisor", "ADVISOR_PAYEE_NOT_READY")
    assert advisor_view.value.code == "ADVISOR_CONNECT_STRIPE"
    assert owner_view.value.code == "ADVISOR_PAYEE_NOT_READY"


def request_body():
    return {
        "requestId": str(uuid4()),
        "advisorPersonRef": str(uuid4()),
        "envelope": envelope("advisor-key"),
        "ownerEnvelope": envelope("owner-key"),
        "contentHash": "a" * 64,
        "introduction": "Please review my allocation.",
        "approval": "connect_and_share_finance_snapshot_v1",
        "durationSeconds": 604800,
    }


def row(status="pending"):
    now = datetime.now(UTC)
    return {
        "id": uuid4(),
        "owner_user_id": "owner",
        "advisor_user_id": "advisor",
        "advisor_person_ref": uuid4(),
        "owner_person_ref": uuid4(),
        "owner_name": "Owner",
        "advisor_name": "Advisor",
        "status": status,
        "introduction": "Please review my allocation.",
        "created_at": now,
        "expires_at": now + timedelta(days=7),
        "server_now": now,
        "content_hash": "a" * 64,
        "meeting": None,
        "plan": None,
        "plan_revision": 0,
        "envelope": envelope("advisor-key"),
        "owner_envelope": envelope("owner-key"),
    }


def test_explicit_fixed_snapshot_approval_rejects_broader_authority():
    assert CreateAdvisorReview.model_validate(request_body()).durationSeconds == 604800
    for override in (
        {"approval": "connect_only"},
        {"durationSeconds": None},
        {"model_processing": True},
        {"trading": True},
    ):
        with pytest.raises(ValidationError):
            CreateAdvisorReview.model_validate({**request_body(), **override})


def test_pending_recipient_never_receives_snapshot_but_owner_can_review():
    pending = row()
    recipient = project(pending, "advisor", snapshot=True)
    assert recipient["snapshotAvailable"] is False and "envelope" not in recipient
    assert project(pending, "owner", snapshot=True)["envelope"]["recipientKeyId"] == "owner-key"
    accepted = project(row("accepted"), "advisor", snapshot=True)
    assert accepted["snapshotAvailable"] is True
    assert accepted["envelope"]["recipientKeyId"] == "advisor-key"


@pytest.mark.parametrize("status", ["declined", "withdrawn", "stopped", "expired"])
def test_terminal_requests_never_return_ciphertext_even_if_old_storage_remains(status):
    for viewer in ("owner", "advisor"):
        value = project(row(status), viewer, snapshot=True)
        assert value["snapshotAvailable"] is False and "envelope" not in value


def test_server_expiry_denies_snapshot_before_async_cleanup():
    expired = row("accepted")
    expired["expires_at"] = expired["server_now"] - timedelta(seconds=1)
    assert not project(expired, "advisor", snapshot=True)["snapshotAvailable"]


def test_meeting_requires_aware_time_and_real_zone():
    start = datetime.now(UTC) + timedelta(days=1)
    good = {"startAt": start, "endAt": start + timedelta(minutes=30), "timeZone": "Asia/Kolkata"}
    assert MeetingTime.model_validate(good).timeZone == "Asia/Kolkata"
    for bad in (
        {"timeZone": "made/up"},
        {"endAt": start + timedelta(hours=3)},
        {"startAt": start.replace(tzinfo=None)},
    ):
        with pytest.raises(ValidationError):
            MeetingTime.model_validate({**good, **bad})


def test_one_time_offer_requires_price_and_allows_optional_details():
    good = {
        "amountCents": 2000,
        "interval": "one_time",
        "services": "One portfolio review and a follow-up call.",
        "cancellationTerms": "Full refund before the review begins.",
    }
    assert AdvisorPlan.model_validate(good).interval == "one_time"
    minimum = {"amountCents": 2000, "interval": "one_time"}
    assert AdvisorPlan.model_validate(minimum).cancellationTerms == ""
    short = AdvisorPlan.model_validate(
        {**minimum, "services": " Review ", "cancellationTerms": "  "}
    )
    assert (short.services, short.cancellationTerms) == ("Review", "")
    for bad in (
        {"amountCents": True},
        {"amountCents": 0},
        {"interval": "month"},
        {"services": "x" * 1501},
    ):
        with pytest.raises(ValidationError):
            AdvisorPlan.model_validate({**good, **bad})
    assert PlanCheckout.model_validate({"planRevision": 1, "acceptPayment": True}).acceptPayment
    for old_or_missing in ({}, {"acceptRecurringPayment": True}, {"acceptPayment": False}):
        with pytest.raises(ValidationError):
            PlanCheckout.model_validate({"planRevision": 1, **old_or_missing})


def test_one_time_charge_binds_checkout_offer_amount_and_advisor(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock

    from hushh_mcp.services import advisor_payment_checkout as checkout

    request_id = str(uuid4())
    payment = {
        "plan_revision": 2,
        "attempt": 1,
        "plan_hash": "a" * 64,
        "amount_cents": 2500,
        "payee_account": "acct_advisor",
        "checkout_session_id": None,
        "payment_intent_id": None,
        "paid_at": None,
    }
    metadata = checkout.binding(request_id, payment)
    session = {
        "id": "cs_test_bound",
        "livemode": False,
        "client_reference_id": request_id,
        "mode": "payment",
        "metadata": metadata,
        "amount_total": 2500,
        "currency": "usd",
        "status": "open",
        "url": "https://checkout.stripe.com/test",
    }
    create = Mock(return_value=session)
    provider = SimpleNamespace(checkout=SimpleNamespace(Session=SimpleNamespace(create=create)))
    monkeypatch.setattr(checkout, "_app_origin", lambda: "https://uat.example.test")
    assert checkout.create_checkout(provider, "test-key", request_id, payment) == session
    kwargs = create.call_args.kwargs
    assert kwargs["mode"] == "payment"
    assert kwargs["idempotency_key"] == f"advisor-payment:{request_id}:2:1:dynamic-methods-v1"
    # Stripe rejects the retired explicit list with a 400, so the one-time Pay button failed.
    assert "payment_method_types" not in kwargs
    assert kwargs["payment_intent_data"]["transfer_data"] == {"destination": "acct_advisor"}
    assert "recurring" not in kwargs["line_items"][0]["price_data"]
    with pytest.raises(AdvisorReviewError, match="UNCONFIRMED"):
        checkout.verify_session(
            {**session, "metadata": {**metadata, "attempt": "2"}}, request_id, payment
        )
    assert checkout.checkout_expired({**session, "status": "expired", "payment_status": "unpaid"})
    assert not checkout.checkout_expired({**session, "status": "expired", "payment_status": "paid"})

    conn = Mock()
    paid = {
        **session,
        "status": "complete",
        "payment_status": "paid",
        "payment_intent": {
            "id": "pi_bound",
            "livemode": False,
            "status": "succeeded",
            "amount_received": 2500,
            "currency": "usd",
            "metadata": metadata,
            "transfer_data": {"destination": "acct_advisor"},
            "latest_charge": {
                "payment_intent": "pi_bound",
                "livemode": False,
                "paid": True,
                "captured": True,
                "currency": "usd",
                "amount_captured": 2500,
                "created": 1760000000,
                "amount_refunded": 0,
            },
        },
    }
    wrong_intent = {**paid["payment_intent"], "transfer_data": {"destination": "acct_other"}}
    with pytest.raises(AdvisorReviewError, match="UNCONFIRMED"):
        checkout.record_checkout(
            conn, request_id, payment, {**paid, "payment_intent": wrong_intent}
        )
    conn.execute.assert_not_called()
    result = checkout.record_checkout(conn, request_id, payment, paid)
    assert result["status"] == "paid" and result["amountCents"] == 2500
    assert result["paidAt"] == "2025-10-09T08:53:20+00:00"


def billing_pair():
    authority = {
        "plan_hash": "a" * 64,
        "payee_account": "acct_synthetic",
        "plan_revision": 2,
        "request_id": str(uuid4()),
        "plan": {"amountCents": 2000},
    }
    good = {
        "livemode": False,
        "metadata": {
            "plan_hash": authority["plan_hash"],
            "request_id": authority["request_id"],
            "plan_revision": "2",
        },
        "transfer_data": {"destination": "acct_synthetic"},
        "status": "active",
        "items": {
            "data": [
                {
                    "quantity": 1,
                    "price": {
                        "unit_amount": 2000,
                        "currency": "usd",
                        "recurring": {"interval": "month"},
                    },
                }
            ]
        },
        "latest_invoice": {
            "status": "paid",
            "livemode": False,
            "currency": "usd",
            "amount_paid": 2000,
        },
    }
    return authority, good


def test_subscription_status_requires_exact_test_mode_plan_and_payee():
    authority, good = billing_pair()
    assert verified_subscription(good, authority) == "active"
    for override in (
        {"livemode": True},
        {"metadata": {"plan_hash": "b" * 64}},
        {"transfer_data": {"destination": "acct_other"}},
        {
            "items": {
                "data": [
                    {
                        "quantity": 1,
                        "price": {
                            "unit_amount": 3000,
                            "currency": "usd",
                            "recurring": {"interval": "month"},
                        },
                    }
                ]
            }
        },
    ):
        with pytest.raises(AdvisorReviewError, match="UNCONFIRMED"):
            verified_subscription({**good, **override}, authority)
    assert verified_subscription({**good, "status": "past_due"}, authority) == "past_due"
    assert (
        verified_subscription({**good, "latest_invoice": {"status": "open"}}, authority)
        == "incomplete"
    )
    assert (
        verified_subscription(
            {**good, "latest_invoice": {**good["latest_invoice"], "amount_paid": 0}}, authority
        )
        == "incomplete"
    )


def test_no_unknown_subscription_state_is_treated_as_active():
    authority, good = billing_pair()
    assert verified_subscription({**good, "status": "trialing"}, authority) == "unknown"


def test_feed_metadata_is_reference_only_and_validates_request_identity():
    from hushh_mcp.services.feed_service import _safe_feed_metadata

    request_id = str(uuid4())
    assert _safe_feed_metadata(
        {"advisorReviewId": request_id, "viewerRole": "advisor", "portfolio": "secret"}
    ) == {"advisorReviewId": request_id, "viewerRole": "advisor"}
    assert _safe_feed_metadata({"advisorReviewId": "wrong", "viewerRole": "other"}) == {}


def test_billing_webhook_rejects_unverified_and_live_events_before_database_access(monkeypatch):
    from types import SimpleNamespace

    import hushh_mcp.services.advisor_review_billing_events as events

    monkeypatch.setenv("RIA_STRIPE_TEST_SECRET_KEY", "sk_test_" + "a" * 30)
    monkeypatch.setenv("RIA_STRIPE_TEST_WEBHOOK_SECRET", "whsec_" + "b" * 30)
    monkeypatch.setenv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_" + "c" * 30)
    monkeypatch.setattr(
        events, "get_db", lambda: pytest.fail("Unverified event reached the database")
    )

    def invalid(_payload, _signature, secret):
        assert secret == "whsec_" + "b" * 30
        raise ValueError("invalid signature")

    provider = SimpleNamespace(Webhook=SimpleNamespace(construct_event=invalid))
    with pytest.raises(AdvisorReviewError, match="SIGNATURE_INVALID"):
        events.process_event(b"{}", "synthetic", provider=provider)
    provider.Webhook.construct_event = lambda *args: {"livemode": True}
    with pytest.raises(AdvisorReviewError, match="TEST_BILLING_REQUIRED"):
        events.process_event(b"{}", "synthetic", provider=provider)
    provider.Webhook.construct_event = lambda *args: {"livemode": False, "data": {"object": {}}}
    assert events.process_event(b"{}", "synthetic", provider=provider) == {"received": True}


def test_ria_sandbox_does_not_fall_back_to_shared_stripe(monkeypatch):
    from hushh_mcp.services.advisor_review_billing import test_config

    monkeypatch.setenv("STRIPE_CONNECT_MODE", "test")
    monkeypatch.setenv("STRIPE_CONNECT_SECRET_KEY", "sk_test_" + "a" * 30)
    monkeypatch.setenv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_" + "b" * 30)
    monkeypatch.delenv("RIA_STRIPE_TEST_SECRET_KEY", raising=False)
    monkeypatch.delenv("RIA_STRIPE_TEST_WEBHOOK_SECRET", raising=False)
    with pytest.raises(AdvisorReviewError, match="TEST_BILLING_SETUP"):
        test_config()
    monkeypatch.setenv("RIA_STRIPE_TEST_SECRET_KEY", "sk_live_" + "a" * 30)
    monkeypatch.setenv("RIA_STRIPE_TEST_WEBHOOK_SECRET", "whsec_" + "b" * 30)
    with pytest.raises(AdvisorReviewError, match="TEST_BILLING_REQUIRED"):
        test_config()


def test_ria_sandbox_reads_only_its_two_secrets_from_the_uat_project(monkeypatch):
    from contextlib import nullcontext
    from types import SimpleNamespace

    from hushh_mcp.services import advisor_review_billing as billing

    values = ("sk_test_" + "a" * 30, "whsec_" + "b" * 30)
    lookups = []

    def access_secret_version(*, request, retry, timeout):
        lookups.append(request["name"])
        assert retry is None and timeout == 3
        return SimpleNamespace(payload=SimpleNamespace(data=values[len(lookups) - 1].encode()))

    monkeypatch.setattr(
        billing.secretmanager,
        "SecretManagerServiceClient",
        lambda: nullcontext(SimpleNamespace(access_secret_version=access_secret_version)),
    )
    monkeypatch.setattr(billing, "_credential_refresh_at", 0.0)
    monkeypatch.setattr(billing, "_uat_credentials", ("", ""))
    monkeypatch.delenv("RIA_STRIPE_TEST_SECRET_KEY", raising=False)
    monkeypatch.delenv("RIA_STRIPE_TEST_WEBHOOK_SECRET", raising=False)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    monkeypatch.setenv("K_SERVICE", "consent-protocol")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "production")
    with pytest.raises(AdvisorReviewError, match="TEST_BILLING_SETUP"):
        billing.test_config()
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-dev")
    with pytest.raises(AdvisorReviewError, match="TEST_BILLING_SETUP"):
        billing.test_config()
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-pda-uat")
    monkeypatch.setenv("K_SERVICE", "drive-worker")
    with pytest.raises(AdvisorReviewError, match="TEST_BILLING_SETUP"):
        billing.test_config()
    assert not lookups
    monkeypatch.setenv("K_SERVICE", "consent-protocol")
    assert billing.test_config() == billing.test_config() == values
    assert lookups == [
        "projects/hushh-pda-uat/secrets/RIA_STRIPE_TEST_SECRET_KEY/versions/latest",
        "projects/hushh-pda-uat/secrets/RIA_STRIPE_TEST_WEBHOOK_SECRET/versions/latest",
    ]


@pytest.mark.asyncio
async def test_ria_payouts_refuse_client_before_accessing_stripe(monkeypatch):
    from contextlib import nullcontext
    from types import SimpleNamespace

    from hushh_mcp.services import advisor_review_payouts as payouts

    monkeypatch.setattr(
        payouts, "get_db", lambda: SimpleNamespace(engine=SimpleNamespace(begin=nullcontext))
    )
    monkeypatch.setattr(payouts, "load", lambda *_: {"advisor_user_id": "advisor"})
    monkeypatch.setattr(
        payouts, "test_config", lambda: pytest.fail("Client reached the payout provider")
    )
    with pytest.raises(AdvisorReviewError, match="WRONG_PARTICIPANT"):
        await payouts.AdvisorSandboxPayouts.for_request("client", uuid4())


@pytest.mark.asyncio
async def test_ria_payout_status_uses_bound_account_and_rejects_live_results(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock

    from hushh_mcp.services import advisor_review_payouts as payouts

    key = "sk_test_" + "a" * 30
    readback = Mock(
        return_value={
            "data": [
                {
                    "type": "bank_account",
                    "status": "paid",
                    "currency": "usd",
                    "amount": 2400,
                    "livemode": False,
                }
            ]
        }
    )
    monkeypatch.setattr(
        payouts, "stripe_provider", lambda: SimpleNamespace(Payout=SimpleNamespace(list=readback))
    )
    service = payouts.AdvisorSandboxPayouts("advisor", uuid4(), key)
    monkeypatch.setattr(
        service.payouts,
        "refresh_account",
        AsyncMock(
            return_value={
                "stripe_account_id": "acct_bound",
                "readiness": {"ready": True},
            }
        ),
    )
    assert await service.status() == {
        "mode": "test",
        "setup": "ready",
        "latest": {
            "status": "paid",
            "currency": "usd",
            "amountCents": 2400,
        },
    }
    readback.assert_called_once_with(api_key=key, stripe_account="acct_bound", limit=1)
    readback.return_value["data"][0]["livemode"] = True
    with pytest.raises(AdvisorReviewError, match="UNCONFIRMED"):
        await service.status()


@pytest.mark.asyncio
async def test_ria_cleanup_requires_its_own_scheduler_identity(monkeypatch):
    from unittest.mock import AsyncMock

    from fastapi import HTTPException

    from api.routes import advisor_billing_webhook as routes
    from hushh_mcp.services.scheduler_identity import SchedulerIdentityError

    monkeypatch.setattr(routes, "stripe_environment", lambda: "uat")
    drain = AsyncMock(return_value=1)
    monkeypatch.setattr(routes, "cleanup_async", drain)

    def verify(**kwargs):
        assert kwargs["audience"] == "https://api.uat.hushh.ai/api/payments/advisor/stripe/cleanup"
        assert kwargs["allowed_emails"] == (
            "ria-sandbox-cleanup@hushh-pda-uat.iam.gserviceaccount.com",
        )
        if kwargs["authorization_header"] != "Bearer synthetic-scheduler":
            raise SchedulerIdentityError("scheduler_identity_forbidden")

    monkeypatch.setattr(routes, "verify_scheduler_request", verify)
    with pytest.raises(HTTPException) as refused:
        await routes.cleanup("Bearer another-scheduler")
    assert refused.value.status_code == 401
    drain.assert_not_awaited()
    monkeypatch.setattr(routes, "test_config", lambda: ("synthetic-key", "synthetic-signer"))
    assert await routes.cleanup("Bearer synthetic-scheduler") == {"settled": 1}
    drain.assert_awaited_once_with(limit=2)


@pytest.mark.asyncio
async def test_sandbox_payout_status_reads_a_real_stripe_list_object():
    from types import SimpleNamespace

    import stripe

    from hushh_mcp.services.advisor_review_payouts import AdvisorSandboxPayouts

    payout = {
        "id": "po_test",
        "livemode": False,
        "type": "bank_account",
        "currency": "usd",
        "status": "paid",
        "amount": 2500,
    }
    listed = stripe.ListObject.construct_from({"object": "list", "data": [payout]}, "sk_test_x")
    service = AdvisorSandboxPayouts.__new__(AdvisorSandboxPayouts)
    service.viewer, service.key = "advisor", "sk_test_" + "x" * 24
    service.payouts = SimpleNamespace(
        refresh_account=lambda _viewer: _async(
            {"stripe_account_id": "acct_test", "readiness": {"ready": True, "status": "ready"}}
        )
    )
    service.provider = SimpleNamespace(Payout=SimpleNamespace(list=lambda **_kwargs: listed))
    assert await service.status() == {
        "mode": "test",
        "setup": "ready",
        "latest": {"status": "paid", "amountCents": 2500, "currency": "usd"},
    }


async def _async(value):
    return value


def test_a_503_logs_where_it_failed_without_logging_what_it_said(caplog):
    import logging

    from fastapi import APIRouter, FastAPI
    from fastapi.testclient import TestClient

    from api.routes.one.finance_sharing import PrivateFinanceRoute

    router = APIRouter(route_class=PrivateFinanceRoute)

    @router.get("/boom/{item}")
    async def boom(item: str):
        raise TypeError("owner portfolio 1234")

    @router.get("/unconfirmed")
    async def unconfirmed():
        raise AdvisorReviewError("ADVISOR_BILLING_UNCONFIRMED", 503)

    @router.get("/changed")
    async def changed():
        raise AdvisorReviewError("ADVISOR_PLAN_CHANGED", 409)

    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    with caplog.at_level(logging.WARNING, logger="api.routes.one.finance_sharing"):
        generic = client.get("/boom/abc")
        coded = client.get("/unconfirmed")
        client.get("/changed")
    assert generic.json() == {"detail": {"code": "FINANCE_SHARE_UNAVAILABLE"}}
    assert coded.status_code == 503
    lines = [record.getMessage() for record in caplog.records]
    unavailable = next(line for line in lines if line.startswith("finance_sharing.unavailable"))
    assert "error=TypeError" in unavailable and "route=/boom/{item}" in unavailable
    assert "tests/test_advisor_review_contract.py:" in unavailable and ":boom" in unavailable
    assert "owner portfolio 1234" not in unavailable and "abc" not in unavailable
    assert "finance_sharing.error reason=advisor.billing.unconfirmed status=503" in " ".join(lines)
    assert not any("ADVISOR_PLAN_CHANGED" in line for line in lines)


def test_advisor_stripe_calls_return_plain_dicts_the_billing_code_can_read(monkeypatch):
    from types import SimpleNamespace

    import stripe

    from hushh_mcp.services import advisor_stripe

    account = stripe.Account.construct_from(
        {"id": "acct_1", "payouts_enabled": True, "capabilities": {"transfers": "active"}}, "k"
    )

    class Client:
        def __init__(self, *args, **kwargs):
            self.v1 = SimpleNamespace(accounts=SimpleNamespace(retrieve=lambda *_a, **_k: account))

    monkeypatch.setattr(stripe, "StripeClient", Client)
    remote = dict(advisor_stripe.provider().Account.retrieve("acct_1", api_key="k"))
    assert remote["id"] == "acct_1"
    assert remote["capabilities"].get("transfers") == "active"


def test_signed_webhook_event_from_the_real_sdk_is_readable(monkeypatch):
    import hashlib
    import hmac
    import json
    import time

    from hushh_mcp.services import advisor_review_billing_events as events

    secret = "whsec_" + "b" * 24
    monkeypatch.setenv("RIA_STRIPE_TEST_SECRET_KEY", "sk_test_" + "a" * 24)
    monkeypatch.setenv("RIA_STRIPE_TEST_WEBHOOK_SECRET", secret)
    payload = json.dumps(
        {
            "id": "evt_1",
            "object": "event",
            "type": "checkout.session.completed",
            "livemode": False,
            "data": {"object": {"id": "cs_test_1", "object": "checkout.session", "metadata": {}}},
        }
    )
    stamp = int(time.time())
    digest = hmac.new(secret.encode(), f"{stamp}.{payload}".encode(), hashlib.sha256).hexdigest()
    header = f"t={stamp},v1={digest}"
    assert events.process_event(payload.encode(), header) == {"received": True}
