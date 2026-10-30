"""Admission approval and composer authorization run before provider work."""

from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from fastapi import BackgroundTasks, HTTPException, Response

from api.routes.one import answer_requests as routes


async def _create_answer_request(*args, **kwargs):
    return await routes.create_answer_request(*args, **kwargs, background_tasks=BackgroundTasks())


async def test_question_create_forwards_valid_retry_identity_and_refuses_invalid_keys(monkeypatch):
    operation = str(uuid4())
    service = Mock(create=AsyncMock(return_value={"requestId": operation}))
    monkeypatch.setattr(routes, "_requests", lambda: service)
    body = {
        "ownerUserId": "owner",
        "question": "What are your food preferences?",
        "clientRequestId": operation,
    }
    assert await _create_answer_request(Response(), body, "requester") == {"requestId": operation}
    assert service.create.call_args.kwargs["client_request_id"] == operation
    for invalid in ("not-a-uuid", False, {}):
        with pytest.raises(HTTPException) as error:
            await _create_answer_request(
                Response(), {**body, "clientRequestId": invalid}, "requester"
            )
        assert error.value.status_code == 422
    assert service.create.await_count == 1


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("PKM_ANSWER_PAYMENTS_ENABLED", "true")
    monkeypatch.setenv("PKM_ANSWER_COMPOSER_ENABLED", "true")


async def test_unapproved_composer_blocks_the_paid_lane_only(monkeypatch):
    """An unreviewed composer closes checkout. It does not close intake.

    Payments stay enabled here, so `requests` is reported from the payment
    flag's fallback: the composer is not part of the intake decision.
    """
    monkeypatch.setenv("PKM_ANSWER_COMPOSER_ENABLED", "false")
    payments = Mock(checkout=AsyncMock())
    monkeypatch.setattr(routes, "_payments", lambda: payments)
    gates = await routes.answer_requests_available(Response(), "requester")
    # Payments stay on, so payout setup stays reachable; only the paid
    # answer path is closed by an unreviewed composer.
    assert (gates["enabled"], gates["requests"], gates["payments"], gates["payouts"]) == (
        False,
        True,
        False,
        True,
    )
    with pytest.raises(HTTPException) as error:
        await routes.create_answer_checkout(uuid4(), Response(), "requester")
    assert error.value.status_code == 503
    payments.checkout.assert_not_called()


async def test_request_intake_survives_paused_payments_but_checkout_does_not(monkeypatch):
    """Intake and owner review are admitted with the money lane off.

    The negative control is in the same test on purpose: if the intake gate
    ever starts consulting the payment flags again, the first three
    assertions fail; if the paid gate is loosened to match, the checkout
    assertion fails.
    """
    monkeypatch.setenv("PKM_ANSWER_REQUESTS_ENABLED", "true")
    monkeypatch.setenv("PKM_ANSWER_PAYMENTS_ENABLED", "false")
    monkeypatch.setenv("PKM_ANSWER_COMPOSER_ENABLED", "false")
    requests = Mock(
        create=AsyncMock(return_value={"requestId": "synthetic-request"}),
        approve=AsyncMock(return_value={"termsDigest": "digest"}),
    )
    payments = Mock(checkout=AsyncMock())
    monkeypatch.setattr(routes, "_requests", lambda: requests)
    monkeypatch.setattr(routes, "_payments", lambda: payments)

    gates = await routes.answer_requests_available(Response(), "requester")
    assert (gates["enabled"], gates["requests"], gates["payments"]) == (False, True, False)
    assert await _create_answer_request(
        Response(),
        {"ownerUserId": "owner", "question": "Which flights do you prefer?"},
        "requester",
    ) == {"requestId": "synthetic-request"}
    assert await routes.approve_answer_request(
        uuid4(),
        Response(),
        {"scopes": ["attr.travel.trips"], "amountCents": 500, "modelProcessingConsent": True},
        "owner",
    ) == {"termsDigest": "digest"}

    with pytest.raises(HTTPException) as error:
        await routes.create_answer_checkout(uuid4(), Response(), "requester")
    assert error.value.status_code == 503
    payments.checkout.assert_not_called()


async def test_preparing_the_answer_survives_paused_payments_but_selling_it_does_not(
    monkeypatch,
):
    """The step that decides whether an answer EXISTS is not the money gate.

    The owner's device prepares the answer at approval so "Answer not found"
    is honest and a verified payment can release it with no second owner
    action. Preparing moves no money. While it required the payment flag, a
    deployment with payments paused could never leave "Checking their memory
    for an answer": the device was never handed the work.

    Negative control in the same test: loosening the checkout gate to match
    fails the last assertion.
    """
    monkeypatch.setenv("PKM_ANSWER_REQUESTS_ENABLED", "true")
    monkeypatch.setenv("PKM_ANSWER_PAYMENTS_ENABLED", "false")
    monkeypatch.setenv("PKM_ANSWER_COMPOSER_ENABLED", "true")
    requests = Mock(
        claim_answerable=AsyncMock(return_value=[{"requestId": "synthetic-request"}]),
    )
    payments = Mock(checkout=AsyncMock())
    monkeypatch.setattr(routes, "_requests", lambda: requests)
    monkeypatch.setattr(routes, "_payments", lambda: payments)

    assert await routes.answerable_for_owner(Response(), "owner") == {
        "requests": [{"requestId": "synthetic-request"}]
    }

    # Selling it still waits for the payment lane, and nothing was charged.
    with pytest.raises(HTTPException) as error:
        await routes.create_answer_checkout(uuid4(), Response(), "requester")
    assert error.value.status_code == 503
    payments.checkout.assert_not_called()


async def test_preparing_the_answer_still_needs_its_own_composer_flag(monkeypatch):
    # The composer is the one flag preparation does depend on: without it the
    # device cannot read the approved information at all.
    monkeypatch.setenv("PKM_ANSWER_REQUESTS_ENABLED", "true")
    monkeypatch.setenv("PKM_ANSWER_PAYMENTS_ENABLED", "true")
    monkeypatch.setenv("PKM_ANSWER_COMPOSER_ENABLED", "false")
    requests = Mock(claim_answerable=AsyncMock())
    monkeypatch.setattr(routes, "_requests", lambda: requests)
    with pytest.raises(HTTPException) as error:
        await routes.answerable_for_owner(Response(), "owner")
    assert error.value.status_code == 503
    requests.claim_answerable.assert_not_called()


async def test_unset_request_flag_opens_intake_with_payments_off(monkeypatch):
    """The production regression: no binding must still mean open.

    The first revision of this gate defaulted to inheriting the payment
    flag when unset. Every deployed environment runs with payments off and
    no answer-requests binding, so intake stayed shut and UAT shipped the
    dead control this whole lane exists to remove. Unset is open; only an
    explicit "false" closes it.
    """
    monkeypatch.delenv("PKM_ANSWER_REQUESTS_ENABLED", raising=False)
    monkeypatch.setenv("PKM_ANSWER_PAYMENTS_ENABLED", "false")
    monkeypatch.setenv("PKM_ANSWER_COMPOSER_ENABLED", "false")
    requests = Mock(create=AsyncMock(return_value={"requestId": "synthetic-request"}))
    payments = Mock(checkout=AsyncMock())
    monkeypatch.setattr(routes, "_requests", lambda: requests)
    monkeypatch.setattr(routes, "_payments", lambda: payments)

    gates = await routes.answer_requests_available(Response(), "requester")
    assert (gates["requests"], gates["payments"]) == (True, False)
    assert await _create_answer_request(
        Response(),
        {"ownerUserId": "owner", "question": "Which flights do you prefer?"},
        "requester",
    ) == {"requestId": "synthetic-request"}

    # Negative control: defaulting intake open must not open the money path.
    with pytest.raises(HTTPException) as error:
        await routes.create_answer_checkout(uuid4(), Response(), "requester")
    assert error.value.status_code == 503
    payments.checkout.assert_not_called()


async def test_request_kill_switch_closes_intake_even_with_payments_live(monkeypatch):
    """The explicit flag wins over the payment flag in both directions."""
    monkeypatch.setenv("PKM_ANSWER_REQUESTS_ENABLED", "false")
    requests = Mock(create=AsyncMock(), approve=AsyncMock())
    monkeypatch.setattr(routes, "_requests", lambda: requests)
    for call in (
        lambda: _create_answer_request(
            Response(),
            {"ownerUserId": "owner", "question": "Which flights do you prefer?"},
            "requester",
        ),
        lambda: routes.approve_answer_request(
            uuid4(),
            Response(),
            {"scopes": ["attr.travel.trips"], "amountCents": 500, "modelProcessingConsent": True},
            "owner",
        ),
    ):
        with pytest.raises(HTTPException) as error:
            await call()
        assert error.value.status_code == 503
    requests.create.assert_not_called()
    requests.approve.assert_not_called()


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


@pytest.mark.parametrize(
    "values",
    [
        {"attr.identity.identity_profile.declared_age": 29},
        {
            "attr.identity.identity_profile.declared_age": 29,
            "attr.identity.identity_profile.sex": None,
        },
        {
            "attr.identity.identity_profile.declared_age": 29,
            "attr.identity.identity_profile.sex": {"identity_profile": {"full_name": "Owner"}},
        },
        {
            "attr.identity.identity_profile.declared_age": 29,
            "attr.identity.identity_profile.sex": "   ",
        },
    ],
)
async def test_incomplete_exact_approved_facts_never_reach_composer(monkeypatch, values):
    service = Mock(
        assert_answerable=AsyncMock(
            return_value={
                "approvedScopes": [
                    "attr.identity.identity_profile.declared_age",
                    "attr.identity.identity_profile.sex",
                ],
                "modelProcessingConsented": True,
            }
        )
    )
    monkeypatch.setattr(routes, "_requests", lambda: service)
    composer = Mock()
    monkeypatch.setattr(routes, "AnswerComposer", composer)
    with pytest.raises(HTTPException) as error:
        await routes.compose_answer(
            uuid4(),
            Response(),
            {"projection": {"memory": "Owner is 29", "values": values}},
            "owner",
        )
    assert error.value.status_code == 422
    composer.assert_not_called()


async def test_gemini_partial_answer_with_gaps_gets_no_chargeable_receipt(
    monkeypatch, shared_hub_owner
):
    from hushh_mcp.services.answer_composer import AnswerComposer

    service = Mock(
        assert_answerable=AsyncMock(
            return_value={
                "approvedScopes": ["attr.travel.trips"],
                "modelProcessingConsented": True,
                "question": "Where and when was the trip?",
                "termsDigest": "b" * 64,
            }
        )
    )

    async def provider(_prompt):
        return {"answer": "The trip was to Tokyo.", "gaps": ["Trip date is unavailable."]}

    writer = AnswerComposer(runner=provider)
    monkeypatch.setattr(routes, "_requests", lambda: service)
    monkeypatch.setattr(routes, "AnswerComposer", lambda: writer)
    result = await routes.compose_answer(
        uuid4(),
        Response(),
        {
            "projection": {
                "memory": "Trip to Tokyo",
                "values": {"attr.travel.trips": {"trips": [{"city": "Tokyo"}]}},
            }
        },
        "owner",
    )
    assert result == {
        "answerMode": "projection",
        "answer": None,
        "gaps": ["Trip date is unavailable."],
    }


@pytest.mark.parametrize(
    ("answer", "gaps", "payable"),
    [
        (
            "Recorded sex is female and saved location is London. Not included in this answer: Age.",
            [],
            True,
        ),
        ("Recorded sex is female and saved location is London.", [], False),
        (
            "Recorded sex is female. Not included in this answer: Age.",
            ["The approved location has no current coordinate."],
            False,
        ),
    ],
)
async def test_narrower_approved_answer_requires_disclosure_and_no_unexpected_gaps(
    monkeypatch, shared_hub_owner, answer, gaps, payable
):
    from hushh_mcp.services.answer_composer import AnswerComposer
    from hushh_mcp.services.answer_composition_receipt import verify_composition_receipt

    sex = "attr.identity.identity_profile.sex"
    location = "attr.location.saved_places"
    age = "attr.identity.identity_profile.declared_age"
    request = uuid4()
    service = Mock(
        assert_answerable=AsyncMock(
            return_value={
                "approvedScopes": [sex, location],
                "omittedScopes": [age],
                "modelProcessingConsented": True,
                "question": "What are your age, sex and location?",
                "termsDigest": "b" * 64,
            }
        )
    )
    prompts = []

    async def provider(prompt):
        prompts.append(prompt)
        return {"answer": answer, "gaps": gaps}

    monkeypatch.setattr(routes, "_requests", lambda: service)
    monkeypatch.setattr(routes, "AnswerComposer", lambda: AnswerComposer(runner=provider))
    result = await routes.compose_answer(
        request,
        Response(),
        {
            "projection": {
                "memory": "Approved sex and saved place only",
                "values": {
                    sex: {"identity_profile": {"sex": "female"}},
                    location: {"saved_places": [{"city": "London"}]},
                },
            }
        },
        "owner",
    )
    assert "What are your age, sex and location?" in prompts[0]
    assert "Not included in this answer: Age." in prompts[0]
    if payable:
        assert result["answerMode"] == "agent"
        assert result["answer"] == answer
        verify_composition_receipt(
            result["compositionReceipt"],
            request_id=str(request),
            owner_user_id="owner",
            terms_digest="b" * 64,
        )
    else:
        assert result["answerMode"] == "projection"
        assert result["answer"] is None
        assert "compositionReceipt" not in result


@pytest.mark.parametrize(
    "invalid",
    [
        {"attr.other.secret": {}},
        {
            "attr.identity.identity_profile.declared_age": {
                "sources": [],
                "builtAt": "private",
                "derivedOn": None,
            }
        },
        {
            "attr.identity.identity_profile.declared_age": {
                "sources": [
                    {
                        "domain": "financial",
                        "contentRevision": 1,
                        "manifestRevision": 2,
                        "absent": False,
                    }
                ],
                "builtAt": "2026-10-13T01:00:00Z",
                "derivedOn": "2026-10-13",
            }
        },
        {
            "attr.identity.identity_profile.declared_age": {
                "sources": [
                    {
                        "domain": "identity",
                        "contentRevision": True,
                        "manifestRevision": 2,
                        "absent": False,
                    }
                ],
                "builtAt": "2026-10-13T01:00:00Z",
                "derivedOn": "2026-10-13",
            }
        },
        {
            "attr.identity.identity_profile.declared_age": {
                "sources": [
                    {
                        "domain": "identity",
                        "contentRevision": 1,
                        "manifestRevision": 2,
                        "absent": False,
                        "readablePaths": ["private.dob"],
                    }
                ],
                "builtAt": "2026-10-13T01:00:00Z",
                "derivedOn": "2026-10-13",
            }
        },
    ],
)
async def test_composer_refuses_unapproved_or_unbounded_freshness_before_model(
    monkeypatch, invalid
):
    scope = "attr.identity.identity_profile.declared_age"
    service = Mock(
        assert_answerable=AsyncMock(
            return_value={
                "approvedScopes": [scope],
                "modelProcessingConsented": True,
            }
        )
    )
    monkeypatch.setattr(routes, "_requests", lambda: service)
    writer = Mock()
    monkeypatch.setattr(routes, "AnswerComposer", writer)
    with pytest.raises(HTTPException) as error:
        await routes.compose_answer(
            uuid4(),
            Response(),
            {
                "projection": {
                    "memory": "Age 29",
                    "values": {scope: {"identity_profile": {"declared_age": 29}}},
                    "sourceFreshness": invalid,
                }
            },
            "owner",
        )
    assert error.value.status_code == 422
    writer.assert_not_called()


@pytest.mark.parametrize(
    ("scope", "value"),
    [
        ("attr.identity.identity_profile.declared_age", {"identity_profile": {"declared_age": 29}}),
        ("attr.professional.profile.age", {"profile": {"age": 29}}),
        ("attr.professional.profile.*", {"profile": {"age": 29}}),
    ],
)
async def test_composer_carries_bounded_exact_scope_freshness_into_gemini_receipt(
    monkeypatch, shared_hub_owner, scope, value
):
    from hushh_mcp.services.answer_composer import AnswerComposer
    from hushh_mcp.services.answer_composition_receipt import verify_composition_receipt

    request = uuid4()
    service = Mock(
        assert_answerable=AsyncMock(
            return_value={
                "approvedScopes": [scope],
                "modelProcessingConsented": True,
                "question": "What is your age?",
                "termsDigest": "b" * 64,
            }
        )
    )
    seen = []

    async def provider(prompt):
        seen.append(prompt)
        return {"answer": "I am 29 years old."}

    writer = AnswerComposer(runner=provider)
    monkeypatch.setattr(routes, "_requests", lambda: service)
    monkeypatch.setattr(routes, "AnswerComposer", lambda: writer)
    response = await routes.compose_answer(
        request,
        Response(),
        {
            "projection": {
                "memory": "Age 29",
                "values": {scope: value},
                "sourceFreshness": {
                    scope: {
                        "sources": [
                            {
                                "domain": "identity",
                                "contentRevision": 7,
                                "manifestRevision": 9,
                                "absent": False,
                            },
                            {
                                "domain": "one_memory",
                                "contentRevision": 3,
                                "manifestRevision": 5,
                                "absent": False,
                            },
                        ],
                        "builtAt": "2026-10-13T01:00:00Z",
                        "derivedOn": "2026-10-13",
                    }
                },
            }
        },
        "owner",
    )
    assert response["answer"] == "I am 29 years old."
    assert '"contentRevision": 7' in seen[0] and '"derivedOn": "2026-10-13"' in seen[0]
    assert "date_of_birth" not in seen[0] and "readablePaths" not in seen[0]
    verify_composition_receipt(
        response["compositionReceipt"],
        request_id=str(request),
        owner_user_id="owner",
        terms_digest="b" * 64,
    )


@pytest.mark.parametrize("leaf", ["sex", "job_title", "*"])
async def test_composer_refuses_identity_metadata_for_other_professional_scopes(monkeypatch, leaf):
    scope = f"attr.professional.profile.{leaf}"
    service = Mock(
        assert_answerable=AsyncMock(
            return_value={"approvedScopes": [scope], "modelProcessingConsented": True}
        )
    )
    writer = Mock()
    monkeypatch.setattr(routes, "_requests", lambda: service)
    monkeypatch.setattr(routes, "AnswerComposer", writer)
    with pytest.raises(HTTPException) as error:
        await routes.compose_answer(
            uuid4(),
            Response(),
            {
                "projection": {
                    "memory": "Only the approved professional fact",
                    "values": {scope: {"profile": {leaf if leaf != "*" else "job_title": "Saved"}}},
                    "sourceFreshness": {
                        scope: {
                            "sources": [
                                {
                                    "domain": "identity",
                                    "contentRevision": 7,
                                    "manifestRevision": 9,
                                    "absent": False,
                                }
                            ],
                            "builtAt": "2026-10-13T01:00:00Z",
                            "derivedOn": None,
                        }
                    },
                }
            },
            "owner",
        )
    assert error.value.status_code == 422
    writer.assert_not_called()


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
    result = await _create_answer_request(
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
        await _create_answer_request(
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
        await _create_answer_request(
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
    await _create_answer_request(
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
        await _create_answer_request(
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
            {
                "projection": {
                    "memory": "synthetic",
                    "values": {"attr.travel.trips": {"trips": [{"city": "Tokyo"}]}},
                }
            },
            "owner",
        )
    assert error.value.status_code == 409
    composer.assert_not_called()
