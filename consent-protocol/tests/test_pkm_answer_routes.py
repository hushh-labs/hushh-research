"""Admission approval and composer authorization run before provider work."""

from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from fastapi import HTTPException, Response

from api.routes.one import answer_requests as routes


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("PKM_ANSWER_PAYMENTS_ENABLED", "true")
    monkeypatch.setenv("PKM_ANSWER_COMPOSER_ENABLED", "true")


async def test_unapproved_composer_blocks_admission(monkeypatch):
    monkeypatch.setenv("PKM_ANSWER_COMPOSER_ENABLED", "false")
    payments = Mock(checkout=AsyncMock())
    monkeypatch.setattr(routes, "_payments", lambda: payments)
    assert await routes.answer_requests_available(Response(), "requester") == {"enabled": False}
    with pytest.raises(HTTPException) as error:
        await routes.create_answer_checkout(uuid4(), Response(), "requester")
    assert error.value.status_code == 503
    payments.checkout.assert_not_called()


async def test_cancel_remains_available_after_admission_paused(monkeypatch):
    monkeypatch.setenv("PKM_ANSWER_PAYMENTS_ENABLED", "false")
    monkeypatch.setenv("PKM_ANSWER_COMPOSER_ENABLED", "false")
    requests = Mock(cancel=AsyncMock(return_value={"status": "cancelled"}))
    monkeypatch.setattr(routes, "_requests", lambda: requests)
    assert await routes.cancel_answer_request(uuid4(), Response(), "requester") == {
        "status": "cancelled"
    }


@pytest.mark.parametrize(
    "projection",
    [
        {"memory": "approved", "values": {"attr.other.secret": 42}},
        {"memory": "approved", "values": {}},
        {"memory": "approved", "values": {"attr.travel.trips": []}, "extra": 1},
    ],
)
async def test_composer_rejects_unapproved_projection(monkeypatch, projection):
    requests = Mock(
        assert_answerable=AsyncMock(
            return_value={"approvedScopes": ["attr.travel.trips"], "modelProcessingConsented": True}
        )
    )
    monkeypatch.setattr(routes, "_requests", lambda: requests)
    composer = Mock()
    monkeypatch.setattr(routes, "AnswerComposer", composer)
    with pytest.raises(HTTPException) as error:
        await routes.compose_answer(uuid4(), Response(), {"projection": projection}, "owner")
    assert error.value.status_code == 422
    composer.assert_not_called()


async def test_composer_refuses_hosting_change_before_provider_dispatch(
    monkeypatch, shared_hub_owner
):
    async def answerable(**kwargs):
        shared_hub_owner.return_value = "byoc"
        return {"approvedScopes": ["attr.travel.trips"], "modelProcessingConsented": True}

    monkeypatch.setattr(routes, "_requests", lambda: Mock(assert_answerable=answerable))
    composer = Mock()
    monkeypatch.setattr(routes, "AnswerComposer", composer)
    with pytest.raises(HTTPException) as error:
        await routes.compose_answer(
            uuid4(),
            Response(),
            {"projection": {"memory": "synthetic", "values": {"attr.travel.trips": []}}},
            "owner",
        )
    assert error.value.status_code == 409
    composer.assert_not_called()


def test_answer_payout_setup_uses_answer_credentials_and_no_drive_wake(monkeypatch):
    monkeypatch.setattr(
        routes,
        "answer_payment_config",
        lambda: ("sk_live_isolated_key_value_123456", "whsec_signing", "https://uat.hushh.ai"),
    )
    monkeypatch.setattr(routes, "answer_stripe_mode", lambda: "live")
    factory = Mock()
    monkeypatch.setattr(routes, "PkmPayoutService", factory)
    routes._payouts()
    factory.assert_called_once_with(
        mode="live", api_key="sk_live_isolated_key_value_123456", resume_documents=False
    )


@pytest.mark.parametrize(
    ("enabled", "answer_mode", "allowed"),
    [
        ("false", "test", False),  # UAT: paused sandbox answers beside live Connect
        ("false", "invalid", False),
        ("true", "test", True),
        ("false", "live", True),
    ],
)
async def test_paused_answer_lane_never_opens_payout_account_in_another_mode(
    monkeypatch, enabled, answer_mode, allowed
):
    monkeypatch.setenv("PKM_ANSWER_PAYMENTS_ENABLED", enabled)
    monkeypatch.setenv("PKM_ANSWER_STRIPE_MODE", answer_mode)
    monkeypatch.setenv("STRIPE_CONNECT_MODE", "live")
    service = Mock(
        account_status=AsyncMock(return_value={"account": None, "stripeMode": answer_mode}),
        onboarding_link=AsyncMock(return_value={"url": "https://connect.stripe.com/setup/x"}),
    )
    payouts = Mock(return_value=service)
    monkeypatch.setattr(routes, "_payouts", payouts)
    for call in (
        lambda: routes.answer_payout_account(Response(), "owner"),
        lambda: routes.answer_payout_link("onboarding", Response(), "owner"),
    ):
        if allowed:
            await call()
            continue
        with pytest.raises(HTTPException) as error:
            await call()
        assert error.value.status_code == 404
        assert error.value.headers == {"Cache-Control": "no-store"}
    assert payouts.call_count == (2 if allowed else 0)


async def test_public_person_reference_resolves_before_active_connection_admission(monkeypatch):
    public_ref = str(uuid4())
    identity = Mock(get_relationship_target=Mock(return_value=("owner", {"status": "connected"})))
    monkeypatch.setattr(routes, "PersonProfileService", lambda: identity)
    requests = Mock(create=AsyncMock(return_value={"requestId": "synthetic-request"}))
    monkeypatch.setattr(routes, "_requests", lambda: requests)
    result = await routes.create_answer_request(
        Response(),
        {"personRef": public_ref, "question": "Which flights do you prefer?"},
        "requester",
    )
    assert result == {"requestId": "synthetic-request"}
    identity.get_relationship_target.assert_called_once_with(
        viewer_user_id="requester", public_person_ref=public_ref
    )
    assert requests.create.call_args.kwargs["owner_user_id"] == "owner"
    assert requests.create.call_args.kwargs["period_start"] is None
    assert requests.create.call_args.kwargs["period_end"] is None


async def test_missing_public_profile_never_admits_or_falls_back_to_reference_as_uid(monkeypatch):
    identity = Mock(get_relationship_target=Mock(side_effect=routes.PersonProfileNotFoundError()))
    monkeypatch.setattr(routes, "PersonProfileService", lambda: identity)
    requests = Mock(create=AsyncMock())
    monkeypatch.setattr(routes, "_requests", lambda: requests)
    with pytest.raises(HTTPException) as error:
        await routes.create_answer_request(
            Response(),
            {"personRef": str(uuid4()), "question": "Which flights do you prefer?"},
            "requester",
        )
    assert error.value.status_code == 404
    requests.create.assert_not_called()


@pytest.mark.parametrize(
    "body",
    [{"personRef": "not-a-public-reference"}, {"personRef": str(uuid4()), "ownerUserId": "owner"}],
)
async def test_invalid_or_ambiguous_public_target_is_rejected(monkeypatch, body):
    identity = Mock()
    monkeypatch.setattr(routes, "PersonProfileService", identity)
    with pytest.raises(HTTPException) as error:
        await routes.create_answer_request(
            Response(), {**body, "question": "Which flights do you prefer?"}, "requester"
        )
    assert error.value.status_code == 422
    identity.assert_not_called()


@pytest.mark.parametrize(
    "period",
    [
        {},
        {"periodStart": None, "periodEnd": None},
        {"periodStart": "2026-01-01", "periodEnd": "2026-01-31"},
    ],
)
async def test_create_preserves_question_and_optional_period(monkeypatch, period):
    question = "What did you spend on travel in January 2026?"
    requests = Mock(create=AsyncMock(return_value={"requestId": str(uuid4())}))
    monkeypatch.setattr(routes, "_requests", lambda: requests)
    await routes.create_answer_request(
        Response(), {"ownerUserId": "owner", "question": question, **period}, "requester"
    )
    requests.create.assert_awaited_once_with(
        requester_user_id="requester",
        owner_user_id="owner",
        question=question,
        period_start=period.get("periodStart"),
        period_end=period.get("periodEnd"),
    )


@pytest.mark.parametrize("value", [False, 0, [], {}])
async def test_invalid_date_types_are_not_silently_dropped(monkeypatch, value):
    requests = Mock(create=AsyncMock(side_effect=routes.AnswerRequestError("invalid_period")))
    monkeypatch.setattr(routes, "_requests", lambda: requests)
    with pytest.raises(HTTPException) as error:
        await routes.create_answer_request(
            Response(),
            {
                "ownerUserId": "owner",
                "question": "What is your age?",
                "periodStart": value,
                "periodEnd": value,
            },
            "requester",
        )
    assert error.value.status_code == 422
    assert requests.create.call_args.kwargs["period_start"] == value


@pytest.mark.parametrize(
    "start,end",
    [
        ("2026-02-30", "2026-03-01"),
        ("2025-02-29", "2025-03-01"),
        ("20260101", "20260201"),
        ("2026-1-01", "2026-02-01"),
        ("2026-02-01", "2026-01-01"),
        ("2026-01-01", None),
        (None, "2026-01-01"),
        (False, False),
        (0, 0),
        ([], []),
        ({}, {}),
    ],
)
async def test_invalid_period_fails_before_catalog_or_storage(monkeypatch, start, end):
    service = routes.PkmAnswerRequestService(object())
    catalog = AsyncMock()
    monkeypatch.setattr(service, "_catalog", catalog)
    with pytest.raises(routes.AnswerRequestError, match="invalid_period"):
        await service.create(
            requester_user_id="requester",
            owner_user_id="owner",
            question="What is your age?",
            period_start=start,
            period_end=end,
        )
    catalog.assert_not_called()
