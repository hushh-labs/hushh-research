"""Approval, recipient confidentiality and payment authority regression guards."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from pydantic import ValidationError
from test_finance_sharing_postgres import envelope

from hushh_mcp.services.advisor_review_billing import verified_subscription
from hushh_mcp.services.advisor_review_contract import AdvisorPlan, CreateAdvisorReview, MeetingTime
from hushh_mcp.services.advisor_review_store import AdvisorReviewError, project


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


def test_monthly_offer_has_explicit_price_and_service_terms():
    good = {
        "amountCents": 2000,
        "services": "One portfolio review meeting each month.",
        "cancellationTerms": "Cancel to stop future monthly renewals.",
    }
    assert AdvisorPlan.model_validate(good).interval == "month"
    for bad in ({"amountCents": True}, {"amountCents": 0}, {"interval": "year"}, {"services": ""}):
        with pytest.raises(ValidationError):
            AdvisorPlan.model_validate({**good, **bad})


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
        "latest_invoice": {"status": "paid"},
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

    monkeypatch.setattr(events, "test_config", lambda: "synthetic-test-key")
    monkeypatch.setenv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_synthetic_local_test")
    monkeypatch.setattr(
        events, "get_db", lambda: pytest.fail("Unverified event reached the database")
    )

    def invalid(*args):
        raise ValueError("invalid signature")

    provider = SimpleNamespace(Webhook=SimpleNamespace(construct_event=invalid))
    with pytest.raises(AdvisorReviewError, match="SIGNATURE_INVALID"):
        events.process_event(b"{}", "synthetic", provider=provider)
    provider.Webhook.construct_event = lambda *args: {"livemode": True}
    with pytest.raises(AdvisorReviewError, match="TEST_BILLING_REQUIRED"):
        events.process_event(b"{}", "synthetic", provider=provider)
    provider.Webhook.construct_event = lambda *args: {"livemode": False, "data": {"object": {}}}
    assert events.process_event(b"{}", "synthetic", provider=provider) == {"received": True}
