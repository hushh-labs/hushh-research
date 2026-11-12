"""Missing receiving-key recovery and queue fairness against isolated PostgreSQL."""

import pytest
from sqlalchemy import text

from hushh_mcp.services.pkm_answer_request_service import (
    AnswerRequestError,
    PkmAnswerRequestService,
)
from tests.services.test_pkm_answer_requests_postgres import (  # noqa: F401
    ENVELOPE,
    OWNER,
    REQUESTER,
    StubResolver,
    _db,
    _deliver_composed,
    _fixture_catalog,
    answer_engine,
    clean,
    connector_postgres_url,
)


async def _approve_for(service, requester):
    request_id = (
        await service.create(
            requester_user_id=requester,
            owner_user_id=OWNER,
            question="What are your travel preferences?",
        )
    )["requestId"]
    await service.resolve_pending(request_id=request_id)
    await service.approve(
        owner_user_id=OWNER,
        request_id=request_id,
        scopes=["attr.travel.trips"],
        amount_cents=1000,
        model_processing_consent=True,
    )
    return request_id


@pytest.mark.parametrize(
    "fault", [None, "empty", "revoked", "foreign", "terms", "consent", "receipt"]
)
async def test_participant_readiness_requires_current_composed_stage(answer_engine, fault):  # noqa: F811
    service = PkmAnswerRequestService(
        _db(answer_engine),
        resolver=StubResolver(["attr.travel.trips"]),
        catalog_reader=_fixture_catalog(answer_engine),
    )
    request = await _approve_for(service, REQUESTER)
    assert not (await service.participant_state(user_id=OWNER, request_id=request))[
        "answerPrepared"
    ]
    await _deliver_composed(
        service,
        answer_engine,
        owner_user_id=OWNER,
        request_id=request,
        envelope=ENVELOPE,
        has_content=True,
    )
    with answer_engine.begin() as connection:
        if fault == "empty":
            connection.execute(
                text("UPDATE pkm_answer_deliveries SET has_content=false WHERE request_id=:r"),
                {"r": request},
            )
        elif fault == "revoked":
            connection.execute(
                text("UPDATE marketplace_recipient_keys SET status='revoked' WHERE user_id=:u"),
                {"u": REQUESTER},
            )
        elif fault == "foreign":
            connection.execute(
                text(
                    "UPDATE marketplace_recipient_keys SET user_id='foreign-owner' WHERE user_id=:u"
                ),
                {"u": REQUESTER},
            )
        elif fault in {"terms", "consent"}:
            column = "terms_digest" if fault == "terms" else "composer_consent_digest"
            connection.execute(
                text(f"UPDATE pkm_answer_requests SET {column}=repeat('a',64) WHERE request_id=:r"),
                {"r": request},
            )
        elif fault == "receipt":
            connection.execute(
                text(
                    "UPDATE pkm_answer_deliveries SET source_revisions=source_revisions-'_composition_receipt' WHERE request_id=:r"
                ),
                {"r": request},
            )
    for participant in (OWNER, REQUESTER):
        state = await service.participant_state(user_id=participant, request_id=request)
        assert state["answerPrepared"] is (fault is None)
        assert not {"staged_revisions", "composer_consent_digest", "terms_digest"} & state.keys()
    with pytest.raises(AnswerRequestError, match="request_unavailable"):
        await service.participant_state(user_id="stranger", request_id=request)


async def test_keyless_requests_are_visible_and_cannot_starve_ready_work(answer_engine):  # noqa: F811
    service = PkmAnswerRequestService(
        _db(answer_engine),
        resolver=StubResolver(["attr.travel.trips"]),
        catalog_reader=_fixture_catalog(answer_engine),
    )

    blocked = [await _approve_for(service, REQUESTER) for _ in range(6)]
    ready_requester = "ready-requester"
    with answer_engine.begin() as connection:
        connection.execute(
            text("UPDATE marketplace_recipient_keys SET status='revoked' WHERE user_id=:u"),
            {"u": REQUESTER},
        )
        connection.execute(
            text("INSERT INTO connections(user_a_id,user_b_id,status) VALUES(:a,:b,'active')"),
            {"a": OWNER, "b": ready_requester},
        )
        connection.execute(
            text("""INSERT INTO marketplace_recipient_keys(user_id,key_id,public_key_jwk,algorithm)
          SELECT :u,'ready-key',public_key_jwk,algorithm FROM marketplace_recipient_keys WHERE user_id=:old"""),
            {"u": ready_requester, "old": REQUESTER},
        )
    ready = await _approve_for(service, ready_requester)
    for participant in (OWNER, REQUESTER):
        state = await service.participant_state(user_id=participant, request_id=blocked[0])
        assert state["requesterKeyReady"] is False
        assert state["deliveryRecipientKeyId"] is None
    with pytest.raises(AnswerRequestError, match="request_unavailable"):
        await service.participant_state(user_id=ready_requester, request_id=blocked[0])
    work = await service.claim_answerable(owner_user_id=OWNER, limit=1)
    assert [row["requestId"] for row in work] == [ready]
    assert work[0]["recipientKey"]["keyId"] == "ready-key"
    with answer_engine.begin() as connection:
        connection.execute(
            text("UPDATE marketplace_recipient_keys SET status='active' WHERE user_id=:u"),
            {"u": REQUESTER},
        )
    assert (await service.participant_state(user_id=REQUESTER, request_id=blocked[0]))[
        "requesterKeyReady"
    ] is True
    assert len(await service.claim_answerable(owner_user_id=OWNER, limit=25)) == 7


async def test_rotated_empty_stages_cannot_starve_later_ready_work(answer_engine):  # noqa: F811
    service = PkmAnswerRequestService(
        _db(answer_engine),
        resolver=StubResolver(["attr.travel.trips"]),
        catalog_reader=_fixture_catalog(answer_engine),
    )
    for _ in range(5):
        request = await _approve_for(service, REQUESTER)
        assert await service.deliver(
            owner_user_id=OWNER,
            request_id=request,
            envelope=ENVELOPE,
            has_content=False,
        ) == {"delivered": True, "hasContent": False}
    with answer_engine.begin() as connection:
        connection.execute(
            text("UPDATE marketplace_recipient_keys SET status='revoked' WHERE user_id=:u"),
            {"u": REQUESTER},
        )
        connection.execute(
            text("""INSERT INTO marketplace_recipient_keys(user_id,key_id,public_key_jwk,algorithm)
                    SELECT user_id,'replacement-key',public_key_jwk,algorithm
                    FROM marketplace_recipient_keys WHERE user_id=:u AND key_id='key-1'"""),
            {"u": REQUESTER},
        )
    ready = await _approve_for(service, REQUESTER)
    for _ in range(2):
        work = await service.claim_answerable(owner_user_id=OWNER)
        assert [row["requestId"] for row in work] == [ready]
        assert work[0]["recipientKey"]["keyId"] == "replacement-key"
