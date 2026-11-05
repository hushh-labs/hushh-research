"""Bounded observation sink; domain ledgers remain the only effect authority."""

from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.services.plg_catalog import action_descriptor, activity_catalog

PHASES = frozenset({"started", "returned", "failed", "cancelled", "blocked"})
DAILY_LIMIT = 500


def _registered_profile(conn, user_id: str) -> bool:
    """A UID or anonymous auth spine alone never admits expanded collection.

    Read the canonical identity shadow after its lifecycle barrier. Auth-only
    accounts remain visible in the audience directory, with no activity baseline
    until normal identity warmup has recorded a registered contact.
    """
    if os.getenv("ONE_PLG_ACTIVITY_ALL_REGISTERED") != "true":
        return True
    return bool(
        conn.execute(
            text(
                "SELECT EXISTS(SELECT 1 FROM actor_identity_cache WHERE user_id=:uid "
                "AND (NULLIF(BTRIM(email),'') IS NOT NULL OR "
                "(phone_verified=TRUE AND NULLIF(BTRIM(phone_number),'') IS NOT NULL)))"
            ),
            {"uid": user_id},
        ).scalar()
    )


def enabled_for(user_id: str) -> bool:
    if os.getenv("ONE_PLG_ACTIVITY_ENABLED") != "true":
        return False
    if not user_id or len(user_id) > 128:
        return False
    if (
        os.getenv("ONE_PLG_ACTIVITY_ALL_REGISTERED") == "true"
        and os.getenv("GOOGLE_CLOUD_PROJECT") != "hushh-pda"
    ):
        return False
    if os.getenv("ONE_PLG_ACTIVITY_ALL_REGISTERED") != "true":
        allowed = {
            uid.strip()
            for uid in os.getenv("ONE_PLG_EXPORT_ACCOUNT_IDS", "").split(",")
            if uid.strip()
        }
        if not 1 <= len(allowed) <= 100 or user_id not in allowed:
            return False
    from api.utils.firebase_auth import current_auth_lane

    return current_auth_lane() == "production"


def admission(user_id: str) -> dict | None:
    if not enabled_for(user_id):
        return None
    # Optional SDK observation must stay importable by offline evaluators.
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionLifecycleService,
    )

    with get_db_connection() as conn:
        conn.execute(text("SET LOCAL statement_timeout='200ms'"))
        conn.execute(text("SET LOCAL lock_timeout='100ms'"))
        AccountDeletionLifecycleService.lock_user_writes_in_transaction(conn, user_ids=[user_id])
        if not _registered_profile(conn, user_id):
            return None
        row = conn.execute(
            text("""INSERT INTO one_product_activity_epochs(user_id) VALUES (:uid)
          ON CONFLICT(user_id) DO UPDATE SET user_id=EXCLUDED.user_id
          RETURNING generation,started_at"""),
            {"uid": user_id},
        ).fetchone()
    return {"generation": str(row.generation), "startedAt": row.started_at.isoformat()}


def observe(
    user_id: str, generation: str, action_id: str, phase: str, source: str, operation_id: str
) -> bool:
    if not enabled_for(user_id):
        return False
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        AccountDeletionLifecycleService,
    )

    descriptor = action_descriptor(action_id)
    if (
        not descriptor
        or descriptor["proof"] != source
        or phase not in PHASES
        or source not in {"client_reported", "execution_observed"}
        or (source == "client_reported" and descriptor["kind"] != "action")
        or len(operation_id) > 256
        or not operation_id
    ):
        raise ValueError("Invalid product observation")
    UUID(generation)
    event_id = hashlib.sha256(
        f"{user_id}:{generation}:{source}:{action_id}:{phase}:{operation_id}".encode()
    ).hexdigest()
    # Generic feature observations have independent IDs, not paired executions.
    # Retain correlation only for the dispatch/SDK contract that shares an ID.
    operation_key = (
        hashlib.sha256(
            f"{user_id}:{generation}:{source}:{action_id}:{operation_id}".encode()
        ).hexdigest()
        if not action_id.startswith("observation:")
        else None
    )
    now = datetime.now(timezone.utc)
    with get_db_connection() as conn:
        conn.execute(text("SET LOCAL statement_timeout='200ms'"))
        conn.execute(text("SET LOCAL lock_timeout='100ms'"))
        AccountDeletionLifecycleService.lock_user_writes_in_transaction(conn, user_ids=[user_id])
        if not _registered_profile(conn, user_id):
            return False
        # Serialize the small daily pilot budget. This lock grants no action authority.
        conn.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:uid,365))"), {"uid": user_id}
        )
        result = conn.execute(
            text("""INSERT INTO one_product_activity_observations
          (event_id,user_id,generation,agent_id,action_id,catalog_revision,source,phase,operation_key,observed_at,expires_at)
          SELECT :event,:uid,CAST(:generation AS UUID),:agent,:action,:catalog,:source,:phase,:operation,:at,:at + INTERVAL '7 days'
          FROM one_product_activity_epochs epoch
          WHERE epoch.user_id=:uid AND epoch.generation=CAST(:generation AS UUID)
            AND (SELECT COUNT(*) FROM one_product_activity_observations
              WHERE user_id=:uid AND observed_at>=:day_start) < :cap
          ON CONFLICT(event_id) DO NOTHING RETURNING event_id"""),
            {
                "event": event_id,
                "operation": operation_key,
                "uid": user_id,
                "generation": generation,
                "agent": descriptor["agentId"],
                "action": action_id,
                "catalog": activity_catalog()["revision"],
                "source": source,
                "phase": phase,
                "at": now,
                "day_start": now.replace(hour=0, minute=0, second=0, microsecond=0),
                "cap": DAILY_LIMIT,
            },
        )
        return bool(result.fetchone())


def purge_expired(limit: int = 1000) -> int:
    """Bounded maintenance, independent of collection flags and provider calls."""
    with get_db_connection() as conn:
        conn.execute(text("SET LOCAL statement_timeout='1s'"))
        conn.execute(text("SET LOCAL lock_timeout='100ms'"))
        # Migration-first rollout: existing maintenance remains valid before expansion.
        if not conn.execute(
            text("SELECT to_regclass('public.one_product_activity_observations')")
        ).scalar():
            return 0
        budget = min(max(limit, 1), 1000)
        removed = 0
        if conn.execute(text("SELECT to_regclass('public.one_product_value_receipts')")).scalar():
            values = conn.execute(
                text("""DELETE FROM one_product_value_receipts
              WHERE (user_id,generation,agent_id,effect_id) IN (
                SELECT user_id,generation,agent_id,effect_id FROM one_product_value_receipts
                WHERE expires_at<NOW() ORDER BY expires_at LIMIT :limit FOR UPDATE SKIP LOCKED)
              RETURNING effect_id"""),
                {"limit": max(1, budget // 2)},
            )
            removed = len(values.fetchall())
        result = conn.execute(
            text("""DELETE FROM one_product_activity_observations
          WHERE event_id IN (SELECT event_id FROM one_product_activity_observations
            WHERE expires_at<NOW() ORDER BY expires_at LIMIT :limit FOR UPDATE SKIP LOCKED)
          RETURNING event_id"""),
            {"limit": budget - removed},
        )
        return removed + len(result.fetchall())
