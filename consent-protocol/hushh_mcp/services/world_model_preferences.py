"""Explicit PWM consent and generation fences; never a findings or key store."""

from __future__ import annotations

import uuid

from db.connection import get_pool
from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.services.connection_graph_service import lock_connection_graph_users_async


async def preferences(user_id, *, conn=None):
    async def read(connection):
        row = await connection.fetchrow(
            "SELECT enabled,email_enabled,generation,auto_started_at,active_draft_id FROM pwm_research_preferences WHERE user_id=$1",
            user_id,
            timeout=5,
        )
        return dict(row) if row else None

    if conn is not None:
        return await read(conn)
    pool = await get_pool()
    async with pool.acquire(timeout=5) as connection:
        return await read(connection)


def public_preferences(row):
    return {
        "enabled": bool(row and row["enabled"]),
        "email_enabled": bool(row and row["email_enabled"]),
        "consent_version": "pwm-native-v1",
    }


async def update_preferences(user_id, token, *, enabled, email_enabled):
    if await validate_first_party_owner_token(user_id, token) is None:
        raise PermissionError("Owner session ended")
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        await lock_connection_graph_users_async(conn, user_ids=[user_id])
        if await validate_first_party_owner_token(user_id, token, conn=conn) is None:
            raise PermissionError("Owner session ended")
        row = await conn.fetchrow(
            """INSERT INTO pwm_research_preferences(user_id,enabled,email_enabled,generation)
            VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET
            enabled=EXCLUDED.enabled,email_enabled=EXCLUDED.email_enabled,
            generation=CASE WHEN pwm_research_preferences.enabled <> EXCLUDED.enabled THEN EXCLUDED.generation ELSE pwm_research_preferences.generation END,
            auto_started_at=CASE WHEN pwm_research_preferences.enabled <> EXCLUDED.enabled THEN NULL ELSE pwm_research_preferences.auto_started_at END,
            active_draft_id=CASE WHEN pwm_research_preferences.enabled <> EXCLUDED.enabled THEN NULL ELSE pwm_research_preferences.active_draft_id END,
            updated_at=NOW() RETURNING enabled,email_enabled,generation,auto_started_at,active_draft_id""",
            user_id,
            enabled,
            email_enabled,
            uuid.uuid4(),
            timeout=5,
        )
    return public_preferences(row)


async def enroll_default(user_id, token):
    """Default-on research for an owner without a choice on record. The version
    records the default policy, not proof that a disclosure was seen. Any
    existing row, including an explicit opt-out, is never modified."""
    if await validate_first_party_owner_token(user_id, token) is None:
        raise PermissionError("Owner session ended")
    pool = await get_pool()
    async with pool.acquire(timeout=5) as conn, conn.transaction():
        await lock_connection_graph_users_async(conn, user_ids=[user_id])
        if await validate_first_party_owner_token(user_id, token, conn=conn) is None:
            raise PermissionError("Owner session ended")
        await conn.execute(
            """INSERT INTO pwm_research_preferences(user_id,enabled,email_enabled,generation,consent_version)
            VALUES ($1,TRUE,TRUE,$2,'pwm-default-v1') ON CONFLICT (user_id) DO NOTHING""",
            user_id,
            uuid.uuid4(),
            timeout=5,
        )


async def draft_completed(user_id, draft_id):
    """True once the draft reached a terminal outcome the owner was told about."""
    pool = await get_pool()
    async with pool.acquire(timeout=5) as connection:
        return bool(
            await connection.fetchval(
                "SELECT 1 FROM pwm_completion_events WHERE user_id=$1 AND draft_id=$2",
                user_id,
                draft_id,
                timeout=5,
            )
        )


async def checkpoint_committed(conn, user_id, state):
    """Runs only inside the winning encrypted checkpoint transaction."""
    row = await conn.fetchrow(
        "SELECT enabled,generation FROM pwm_research_preferences WHERE user_id=$1 FOR UPDATE",
        user_id,
        timeout=5,
    )
    if not row or str(row["generation"]) != state.get("consent_generation"):
        raise PermissionError("Research consent changed")
    draft_id = uuid.UUID(state["job_id"])
    if state["status"] == "saved":
        await conn.execute(
            "UPDATE pwm_research_preferences SET active_draft_id=NULL WHERE user_id=$1 AND active_draft_id=$2",
            user_id,
            draft_id,
            timeout=5,
        )
        return
    if not row["enabled"]:
        raise PermissionError("Research consent ended")
    # A newly active draft restarts the re-preparation interval; resumed
    # slices of the same draft keep it.
    await conn.execute(
        """UPDATE pwm_research_preferences SET active_draft_id=$2,
        auto_started_at=CASE WHEN auto_started_at IS NULL OR active_draft_id IS DISTINCT FROM $2
        THEN NOW() ELSE auto_started_at END WHERE user_id=$1""",
        user_id,
        draft_id,
        timeout=5,
    )
    result = state.get("result", {})
    outcome = None
    if state["status"] == "offered":
        report = result.get("report", {})
        has_findings = any(section.get("facts") for section in report.get("sections", []))
        outcome = (
            ("ready" if report.get("match_status") == "matched" else "partial")
            if has_findings
            else "attention"
        )
    elif state["status"] in {"unavailable", "insufficient_identity"}:
        outcome = "attention"
    if outcome:
        await conn.execute(
            """INSERT INTO pwm_completion_events(user_id,draft_id,generation,outcome,email_state)
            VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id,draft_id) DO UPDATE SET
            outcome=EXCLUDED.outcome,email_state=EXCLUDED.email_state,next_attempt_at=NOW()
            WHERE pwm_completion_events.outcome='attention' AND EXCLUDED.outcome IN ('ready','partial')
            AND pwm_completion_events.generation=EXCLUDED.generation""",
            user_id,
            draft_id,
            row["generation"],
            outcome,
            "suppressed" if outcome == "attention" else "pending",
            timeout=5,
        )


async def checkpoint_before_write(conn, user_id):
    # Same lock order as reset, consent updates and email dispatch.
    await lock_connection_graph_users_async(conn, user_ids=[user_id])
