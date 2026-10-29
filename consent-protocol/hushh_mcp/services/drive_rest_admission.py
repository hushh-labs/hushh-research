"""Postgres admission for trusted owner-bound Drive calls across worker replicas.

This is pacing only. Existing consent/payment/generation callbacks retain all
execution authority. No token, file ID, query or credential enters this store.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from functools import wraps
from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore
from hushh_mcp.services.google_drive_adapter import DriveReadError


class DriveRestDeferred(DriveReadError):
    def __init__(self, until):
        super().__init__("provider_unavailable", retryable=True)
        self.deferred_until = until


class DriveRestAdmission(ExternalConnectorLifecycleStore):
    async def acquire(self, owner, generation):
        def operation(connection):
            params = {"owner": owner, "generation": generation}
            connection.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:owner, 7439))"),
                {"owner": owner},
            )
            connection.execute(
                text("""INSERT INTO drive_rest_owner_admission(user_id,connection_generation)
                VALUES (:owner,:generation) ON CONFLICT DO NOTHING"""),
                params,
            )
            self._row(
                connection,
                """SELECT * FROM drive_rest_owner_admission
                WHERE user_id=:owner AND connection_generation=:generation FOR UPDATE""",
                params,
            )
            connection.execute(
                text("""DELETE FROM drive_rest_call_leases WHERE lease_id IN
                (SELECT lease_id FROM drive_rest_call_leases WHERE expires_at<=clock_timestamp() LIMIT 250)""")
            )
            count = connection.execute(
                text("""SELECT count(*) FROM drive_rest_call_leases
                WHERE user_id=:owner"""),
                params,
            ).scalar_one()
            concurrency = min(8, max(1, int(os.getenv("DRIVE_REST_OWNER_CONCURRENCY", "8"))))
            if count >= concurrency:
                return None, 0.1
            lease = str(uuid4())
            connection.execute(
                text("""INSERT INTO drive_rest_call_leases(lease_id,user_id,connection_generation,expires_at)
                VALUES (:lease,:owner,:generation,clock_timestamp()+INTERVAL '120 seconds')"""),
                {**params, "lease": lease},
            )
            return lease, 0

        return await self._transaction(operation)

    async def pace(self, owner, generation, lease):
        def operation(connection):
            params = {"owner": owner, "generation": generation, "lease": lease}
            connection.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:owner, 7439))"), params
            )
            current = connection.execute(
                text(
                    "SELECT 1 FROM drive_rest_call_leases WHERE lease_id=:lease AND user_id=:owner AND expires_at>clock_timestamp()"
                ),
                params,
            ).first()
            if current is None:
                raise DriveReadError("provider_unavailable", retryable=True)
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            next_start = connection.execute(
                text(
                    "SELECT max(next_start_at) FROM drive_rest_owner_admission WHERE user_id=:owner"
                ),
                params,
            ).scalar_one()
            if next_start > now:
                return min(1.0, max(0.01, (next_start - now).total_seconds()))
            rate = min(10.0, max(0.1, float(os.getenv("DRIVE_REST_OWNER_STARTS_PER_SECOND", "10"))))
            connection.execute(
                text("""UPDATE drive_rest_owner_admission SET next_start_at=clock_timestamp()+(:spacing * INTERVAL '1 second')
                WHERE user_id=:owner AND connection_generation=:generation"""),
                {**params, "spacing": 1 / rate},
            )
            connection.execute(
                text(
                    "UPDATE drive_rest_call_leases SET expires_at=clock_timestamp()+INTERVAL '120 seconds' WHERE lease_id=:lease"
                ),
                params,
            )
            return 0

        return await self._transaction(operation)

    async def release(self, lease):
        await self._transaction(
            lambda c: c.execute(
                text("DELETE FROM drive_rest_call_leases WHERE lease_id=:lease"), {"lease": lease}
            )
        )


@dataclass(frozen=True)
class OwnerScope:
    store: DriveRestAdmission
    owner: str
    generation: int
    require_current: object = None


_SCOPE: ContextVar[OwnerScope | None] = ContextVar("drive_rest_owner_scope", default=None)
_ADMITTED: ContextVar[bool] = ContextVar("drive_rest_call_admitted", default=False)


@asynccontextmanager
async def owner_scope(*, db, owner, generation, require_current=None):
    if not isinstance(owner, str) or not owner or type(generation) is not int or generation < 0:
        raise DriveReadError("invalid_argument")
    marker = _SCOPE.set(OwnerScope(DriveRestAdmission(db=db), owner, generation, require_current))
    try:
        yield
    finally:
        _SCOPE.reset(marker)


@asynccontextmanager
async def rest_admission(require_current=None):
    scope = _SCOPE.get()
    fence = require_current or (scope.require_current if scope else None)
    if scope is None or _ADMITTED.get():
        if fence:
            await fence()
        yield
        return
    lease = None
    try:
        while lease is None:
            if fence:
                await fence()
            pending = asyncio.create_task(scope.store.acquire(scope.owner, scope.generation))
            try:
                lease, delay = await asyncio.shield(pending)
            except asyncio.CancelledError:
                lease, _ = await pending
                raise
            if lease is None:
                await asyncio.sleep(delay)
        while True:
            if fence:
                await fence()
            delay = await scope.store.pace(scope.owner, scope.generation, lease)
            if not delay:
                break
            await asyncio.sleep(delay)
        if fence:
            await fence()
        marker = _ADMITTED.set(True)
        try:
            yield
        finally:
            _ADMITTED.reset(marker)
    finally:
        if lease is not None:
            try:
                await asyncio.shield(scope.store.release(lease))
            except Exception:
                logging.getLogger(__name__).warning(
                    "drive_rest.admission_cleanup outcome=lease_retained"
                )


def scoped_job(*, background=False):
    """Attach trusted store/job identity, never infer it from a bearer token."""

    def decorate(method):
        @wraps(method)
        async def run(self, job, *args, **kwargs):
            db = getattr(self.store, "db", None)
            if db is None:  # Explicit test doubles have no persistence adapter.
                return await method(self, job, *args, **kwargs)
            owner = self.store.owner(job) if background else job["user_id"]
            generation = job.get(
                "reconciliation_generation", job.get("generation", job.get("connection_generation"))
            )
            fence = (lambda: self.store.current(job)) if background else None
            async with owner_scope(
                db=db, owner=owner, generation=generation, require_current=fence
            ):
                return await method(self, job, *args, **kwargs)

        return run

    return decorate


def sharing_cooldown(connection, owner, generation):
    return connection.execute(
        text("""SELECT max(sharing_cooldown_until) FROM drive_rest_owner_admission
        WHERE user_id=:owner"""),
        {"owner": owner, "generation": generation},
    ).scalar_one_or_none()


def set_sharing_cooldown(connection, owner, generation, until):
    connection.execute(
        text("""INSERT INTO drive_rest_owner_admission(user_id,connection_generation,sharing_cooldown_until)
        VALUES (:owner,:generation,:until) ON CONFLICT(user_id,connection_generation) DO UPDATE
        SET sharing_cooldown_until=GREATEST(drive_rest_owner_admission.sharing_cooldown_until,EXCLUDED.sharing_cooldown_until)"""),
        {"owner": owner, "generation": generation, "until": until},
    )
