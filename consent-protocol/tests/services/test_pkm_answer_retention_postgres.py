"""Account erasure and paused admission preserve paid obligations and delivered access."""

from __future__ import annotations

from uuid import UUID

import pytest
from fastapi import HTTPException, Response
from sqlalchemy import text

from api.routes.one import answer_requests as routes
from hushh_mcp.services.account_answer_erasure import erase_unpaid_answer_content
from tests.services.test_pkm_answer_races_postgres import _approved, payments_enabled  # noqa: F401
from tests.services.test_pkm_answer_recovery_postgres import row
from tests.services.test_pkm_answer_requests_postgres import (  # noqa: F401
    ENVELOPE,
    OWNER,
    REQUESTER,
    _deliver_composed,
    _mark_paid,
    clean,
    connector_postgres_url,
)
from tests.services.test_pkm_answer_requests_postgres import (
    answer_engine as _answer_engine,
)

answer_engine = _answer_engine


@pytest.mark.parametrize("participant", [OWNER, REQUESTER])
async def test_answer_erasure_preserves_financial_history_and_rolls_back(
    answer_engine, participant
):
    _, request, digest = await _approved(answer_engine)
    _mark_paid(answer_engine, request, digest)
    before = row(answer_engine, "pkm_answer_requests", request)
    with pytest.raises(RuntimeError, match="ANSWER_PAYMENT_RECONCILIATION_REQUIRED"):
        with answer_engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE pkm_answer_requests SET question='Synthetic erasure sentinel' WHERE request_id=:r"
                ),
                {"r": request},
            )
            erase_unpaid_answer_content(connection, user_id=participant)
    assert row(answer_engine, "pkm_answer_requests", request) == before
    assert row(answer_engine, "pkm_answer_payment_orders", request)["status"] == "paid"
    assert row(answer_engine, "pkm_answer_payment_obligations", request)["status"] == "paid"


@pytest.mark.parametrize("participant", [OWNER, REQUESTER])
async def test_answer_erasure_removes_unfunded_content_for_either_participant(
    answer_engine, participant
):
    _, request, _ = await _approved(answer_engine)
    with answer_engine.begin() as connection:
        erase_unpaid_answer_content(connection, user_id=participant)
        for table in ("pkm_answer_requests", "pkm_answer_request_scopes"):
            assert (
                connection.execute(
                    text(f"SELECT count(*) FROM {table} WHERE request_id=:r"), {"r": request}
                ).scalar()
                == 0
            )


async def test_paused_admission_preserves_delivered_access_and_recipient_authorization(
    answer_engine, monkeypatch
):
    service, request_id, digest = await _approved(answer_engine)
    _mark_paid(answer_engine, request_id, digest)
    await _deliver_composed(
        service,
        answer_engine,
        owner_user_id=OWNER,
        request_id=request_id,
        envelope=ENVELOPE,
        source_revisions={"travel": 7},
    )
    answer = await service.fetch_answer(requester_user_id=REQUESTER, request_id=request_id)
    monkeypatch.setenv("PKM_ANSWER_PAYMENTS_ENABLED", "false")
    monkeypatch.setenv("PKM_ANSWER_COMPOSER_ENABLED", "false")
    monkeypatch.setattr(routes, "_requests", lambda: service)
    response = Response()
    assert await routes.get_answer(UUID(request_id), response, REQUESTER) == answer
    assert response.headers["Cache-Control"] == "private, no-store"
    with pytest.raises(HTTPException) as denied:
        await routes.get_answer(UUID(request_id), Response(), "another-requester")
    assert denied.value.status_code == 404
