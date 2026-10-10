from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from db.db_client import DatabaseClient, _apply_offline_schema
from hushh_mcp.services.consent_db import ConsentDBService

FIXED_TS = 1_234_567_890_000
USER_ID = "test_user_ordering"
AGENT_ID = "test_agent_ordering"
SCOPE = "test.ordering.scope"


def _setup_service() -> tuple[ConsentDBService, DatabaseClient]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    _apply_offline_schema(engine)
    db_client = DatabaseClient(engine=engine)
    service = ConsentDBService()
    service._db = db_client
    return service, db_client


def _insert_event(
    db: DatabaseClient,
    *,
    user_id: str = USER_ID,
    agent_id: str = AGENT_ID,
    scope: str = SCOPE,
    action: str,
    token_id: str,
    issued_at: int = FIXED_TS,
) -> int:
    res = (
        db.table("consent_audit")
        .insert(
            {
                "user_id": user_id,
                "agent_id": agent_id,
                "scope": scope,
                "action": action,
                "token_id": token_id,
                "issued_at": issued_at,
            }
        )
        .execute()
    )
    return res.data[0]["id"] if res.data else -1


@pytest.mark.asyncio
async def test_grant_then_revoke_same_issued_at_is_inactive():
    """Verify that when a grant is followed by a revocation with identical issued_at,
    the secondary 'id DESC' tie-breaker deterministically selects the revocation (id=2),
    marking the token inactive.
    """
    service, db = _setup_service()
    id_grant = _insert_event(
        db,
        action="CONSENT_GRANTED",
        token_id="token_order_1",  # noqa: S106 - synthetic token identity
    )
    id_revoke = _insert_event(
        db,
        action="REVOKED",
        token_id="token_order_1",  # noqa: S106 - synthetic token identity
    )

    assert id_grant < id_revoke, "Revocation must have higher row ID representing later insertion"

    is_active = await service.is_token_active(
        USER_ID,
        SCOPE,
        agent_id=AGENT_ID,
    )
    assert is_active is False


@pytest.mark.asyncio
async def test_revoke_then_grant_same_issued_at_is_active():
    """Verify that when a revocation is followed by a grant with identical issued_at,
    the secondary 'id DESC' tie-breaker deterministically selects the grant (id=2),
    marking the token active.
    """
    service, db = _setup_service()
    id_revoke = _insert_event(
        db,
        action="REVOKED",
        token_id="token_order_2",  # noqa: S106 - synthetic token identity
    )
    id_grant = _insert_event(
        db,
        action="CONSENT_GRANTED",
        token_id="token_order_2",  # noqa: S106 - synthetic token identity
    )

    assert id_revoke < id_grant, "Grant must have higher row ID representing later insertion"

    is_active = await service.is_token_active(
        USER_ID,
        SCOPE,
        agent_id=AGENT_ID,
    )
    assert is_active is True
