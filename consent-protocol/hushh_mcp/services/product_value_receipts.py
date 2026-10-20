"""Bounded measurement receipts emitted after a domain confirms its effect.

This store never confirms an action. Calendar calls it only after Google has
acknowledged a reviewed mutation; observers cannot mint these through an API.
"""

from __future__ import annotations

import asyncio
import hashlib
import threading
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from typing import TypeVar

from sqlalchemy import text

from db.db_client import get_db_connection
from hushh_mcp.services import product_activity
from hushh_mcp.services.account_deletion_lifecycle_service import AccountDeletionLifecycleService

_capacity = threading.BoundedSemaphore(4)
_workers = ThreadPoolExecutor(max_workers=4, thread_name_prefix="plg-value")
T = TypeVar("T")


def _submit(callback: Callable[[], T]) -> Future[T | None] | None:
    """No queue beyond four in-flight measurements, including slow checkout."""
    if not _capacity.acquire(blocking=False):
        return None

    def run() -> T | None:
        try:
            return callback()
        except Exception:  # noqa: BLE001 - late failures must not log private diagnostics
            return None
        finally:
            _capacity.release()

    try:
        return _workers.submit(run)
    except Exception:
        _capacity.release()
        raise


def _optional_sync(callback: Callable[[], T]) -> T | None:
    try:
        future = _submit(callback)
        return future.result(timeout=0.3) if future else None
    except Exception:  # noqa: BLE001 - checkout, SQL and capacity loss are optional
        return None


async def _optional_async(callback: Callable[[], T]) -> T | None:
    try:
        future = _submit(callback)
        if future:
            return await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(future)), timeout=0.3)
    except Exception:  # noqa: BLE001 - measurement never gates a product operation
        pass
    return None


def _capture_epoch(user_id: str) -> str | None:
    admitted = product_activity.admission(user_id)
    return str(admitted["generation"]) if admitted else None


def capture_value_epoch_sync(user_id: str) -> str | None:
    return _optional_sync(lambda: _capture_epoch(user_id))


async def capture_value_epoch(user_id: str) -> str | None:
    """Pin measurement to the pre-effect epoch; a reset fences delayed callbacks."""
    return await _optional_async(lambda: _capture_epoch(user_id))


def _calendar_receipt(user_id: str, kind: str, source_id: str, generation: str) -> bool:
    if not product_activity.enabled_for(user_id):
        return False
    if kind not in {"proposal", "attendance"} or not source_id or len(source_id) > 128:
        raise ValueError("Invalid Calendar effect reference")
    return _effect_receipt(
        user_id,
        "agent_calendar",
        "calendar.provider_effect.v1",
        f"calendar:{kind}:{source_id}",
        generation,
    )


def _effect_receipt(user_id: str, agent_id: str, proof: str, source: str, generation: str) -> bool:
    effect = hashlib.sha256(f"{user_id}:{source}".encode()).hexdigest()
    with get_db_connection() as conn:
        conn.execute(text("SET LOCAL statement_timeout='200ms'"))
        conn.execute(text("SET LOCAL lock_timeout='100ms'"))
        AccountDeletionLifecycleService.lock_user_writes_in_transaction(conn, user_ids=[user_id])
        conn.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:uid,367))"), {"uid": user_id}
        )
        row = conn.execute(
            text("""INSERT INTO one_product_value_receipts
          (effect_id,user_id,generation,agent_id,proof)
          SELECT :effect,:uid,epoch.generation,:agent,:proof
          FROM one_product_activity_epochs epoch
          WHERE epoch.user_id=:uid AND epoch.generation=CAST(:generation AS UUID)
            AND (SELECT COUNT(*) FROM one_product_value_receipts
                 WHERE user_id=:uid AND occurred_at>=date_trunc('day',NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')<500
          ON CONFLICT(user_id,generation,agent_id,effect_id) DO NOTHING RETURNING effect_id"""),
            {
                "effect": effect,
                "uid": user_id,
                "generation": generation,
                "agent": agent_id,
                "proof": proof,
            },
        ).fetchone()
        return row is not None


def record_location_effect_sync(
    *, user_id: str, kind: str, source_id: str, generation: str | None
) -> None:
    """Only committed, deliberate direct Location writes call this seam."""
    if generation is None or not product_activity.enabled_for(user_id):
        return
    if kind not in {"private_share", "nearby_check_in"} or not source_id or len(source_id) > 256:
        return
    _optional_sync(
        lambda: _effect_receipt(
            user_id,
            "agent_location",
            "location.domain_effect.v1",
            f"location:{kind}:{source_id}",
            generation,
        )
    )


async def record_calendar_effect(
    *, user_id: str, kind: str, source_id: str, generation: str | None
) -> None:
    """Optional metadata cannot change a completed provider operation or retry it."""
    if generation is None:
        return

    await _optional_async(lambda: _calendar_receipt(user_id, kind, source_id, generation))


def _decision_receipt(user_id: str, request_id: str, generation: str, decision: str) -> bool:
    if not product_activity.enabled_for(user_id):
        return False
    if not request_id or len(request_id) > 128 or decision not in {"deny", "approve"}:
        raise ValueError("Invalid sharing-decision reference")
    effect = hashlib.sha256(
        f"{user_id}:consent-decision:{decision}:{request_id}".encode()
    ).hexdigest()
    with get_db_connection() as conn:
        conn.execute(text("SET LOCAL statement_timeout='200ms'"))
        conn.execute(text("SET LOCAL lock_timeout='100ms'"))
        AccountDeletionLifecycleService.lock_user_writes_in_transaction(conn, user_ids=[user_id])
        conn.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:uid,367))"), {"uid": user_id}
        )
        row = conn.execute(
            text("""INSERT INTO one_product_value_receipts
          (effect_id,user_id,generation,agent_id,proof,occurred_at)
          SELECT :effect,:uid,epoch.generation,'agent_nav','nav.owner_decision.v1',
            to_timestamp(a.issued_at / 1000.0)
          FROM one_product_activity_epochs epoch JOIN consent_audit a ON a.request_id=:request
          WHERE epoch.user_id=:uid AND epoch.generation=CAST(:generation AS UUID)
            AND a.action=:action AND a.metadata->>'decision_owner_uid'=:uid
            AND a.metadata->>'owner_decision'=:decision
            AND to_timestamp(a.issued_at / 1000.0)>=date_trunc('milliseconds',epoch.started_at)
            AND COALESCE(a.metadata->>'reused_consent_token','false') <> 'true'
            AND (SELECT COUNT(*) FROM one_product_value_receipts
                 WHERE user_id=:uid AND occurred_at>=date_trunc('day',NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')<500
          ORDER BY a.issued_at LIMIT 1
          ON CONFLICT(user_id,generation,agent_id,effect_id) DO NOTHING RETURNING effect_id"""),
            {
                "effect": effect,
                "uid": user_id,
                "generation": generation,
                "request": request_id,
                "decision": decision,
                "action": "CONSENT_DENIED" if decision == "deny" else "CONSENT_GRANTED",
            },
        ).fetchone()
        return row is not None


async def record_owner_decision(
    *, user_id: str, request_id: str, generation: str | None, decision: str
) -> None:
    if generation is None:
        return

    await _optional_async(lambda: _decision_receipt(user_id, request_id, generation, decision))
