"""Owner review state for a future hosted Live Memory pilot.

A pending row is not a worker credential or a source grant. This service stores
no key material, owner token, source value, or attestation assertion; there is
deliberately no transition to an active capture state.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from db.db_client import get_db
from hushh_mcp.services.hosted_memory_envelope_contract import (
    active_catalog_source,
    admitted_source_id,
)

SOURCE_KIND = "curated_oauth_connector"
REVIEW_VERSION = "hosted_memory_pilot.v1"


class HostedMemoryPilotUnavailable(RuntimeError):
    """The owner review state could not be read or changed reliably."""


class HostedMemoryPilotConflict(RuntimeError):
    """The review generation changed before an owner request could commit."""


def _public_state(row: Any | None) -> dict[str, Any]:
    if row is None:
        return {
            "status": "off",
            "grantId": None,
            "generation": "0",
            "sourceKind": None,
            "sourceId": None,
            "reviewVersion": None,
            "reviewedAt": None,
            "expiresAt": None,
            "revokedAt": None,
            "captureEnabled": False,
            "workerPaired": False,
        }
    status = str(row["status"])
    expires_at = row["expires_at"]
    observed_at = row.get("observed_at") or datetime.now(timezone.utc)
    if status == "pending" and expires_at <= observed_at:
        status = "expired"
    return {
        "status": status,
        "grantId": str(row["grant_id"]),
        "generation": str(row["generation"]),
        "sourceKind": row["source_kind"],
        "sourceId": row["source_id"],
        "reviewVersion": row["review_version"],
        "reviewedAt": row["reviewed_at"].isoformat(),
        "expiresAt": expires_at.isoformat(),
        "revokedAt": row["revoked_at"].isoformat() if row["revoked_at"] else None,
        "captureEnabled": False,
        "workerPaired": False,
    }


class HostedMemoryPilotService:
    def __init__(self, db: Any | None = None) -> None:
        self.db = db or get_db()

    @staticmethod
    def _configure(connection: Any) -> None:
        connection.execute(text("SET LOCAL statement_timeout = '5s'"))
        connection.execute(text("SET LOCAL lock_timeout = '2s'"))

    async def current(self, *, user_id: str) -> dict[str, Any]:
        if not user_id:
            raise ValueError("owner identity required")

        def read() -> dict[str, Any]:
            with self.db.engine.begin() as connection:
                self._configure(connection)
                row = (
                    connection.execute(
                        text("""SELECT grant_id, generation, source_kind, source_id, review_version,
                                      status, reviewed_at, expires_at, revoked_at,
                                      clock_timestamp() AS observed_at
                               FROM public.live_memory_hosted_pilot_grants
                               WHERE user_id=:user_id"""),
                        {"user_id": user_id},
                    )
                    .mappings()
                    .first()
                )
                return _public_state(row)

        try:
            return await asyncio.to_thread(read)
        except SQLAlchemyError:
            raise HostedMemoryPilotUnavailable("hosted memory review unavailable") from None

    async def request_pending(
        self, *, user_id: str, expected_generation: int, source_id: str
    ) -> dict[str, Any]:
        if not user_id or not 0 <= expected_generation <= 2**63 - 1:
            raise ValueError("owner identity and valid generation required")
        if not admitted_source_id(source_id):
            raise ValueError("source is outside the curated pilot")

        def write() -> dict[str, Any]:
            with self.db.engine.begin() as connection:
                self._configure(connection)
                if not active_catalog_source(connection, source_id):
                    raise ValueError("source is outside the active curated catalog")
                inserted = None
                if expected_generation == 0:
                    inserted = (
                        connection.execute(
                            text("""INSERT INTO public.live_memory_hosted_pilot_grants
                                  (user_id, source_kind, source_id, review_version, status,
                                   reviewed_at, expires_at)
                               VALUES (:user_id, :source_kind, :source_id, :review_version, 'pending',
                                       clock_timestamp(), clock_timestamp() + interval '15 minutes')
                               ON CONFLICT (user_id) DO NOTHING
                               RETURNING grant_id, generation, source_kind, source_id, review_version,
                                         status, reviewed_at, expires_at, revoked_at,
                                         clock_timestamp() AS observed_at"""),
                            {
                                "user_id": user_id,
                                "source_kind": SOURCE_KIND,
                                "source_id": source_id,
                                "review_version": REVIEW_VERSION,
                            },
                        )
                        .mappings()
                        .first()
                    )
                if inserted is not None:
                    return _public_state(inserted)
                existing = (
                    connection.execute(
                        text("""SELECT grant_id, generation, source_kind, source_id, review_version,
                                      status, reviewed_at, expires_at, revoked_at,
                                      clock_timestamp() AS observed_at
                               FROM public.live_memory_hosted_pilot_grants
                               WHERE user_id=:user_id FOR UPDATE"""),
                        {"user_id": user_id},
                    )
                    .mappings()
                    .first()
                )
                if existing is None:
                    raise HostedMemoryPilotConflict("review generation changed")
                if int(existing["generation"]) != expected_generation:
                    # A retry of the first successful request is harmless only
                    # while that exact first generation is still pending.
                    if not (
                        expected_generation == 0
                        and int(existing["generation"]) == 1
                        and existing["status"] == "pending"
                        and existing["source_id"] == source_id
                        and existing["expires_at"] > existing["observed_at"]
                    ):
                        raise HostedMemoryPilotConflict("review generation changed")
                if (
                    existing["status"] == "pending"
                    and existing["source_id"] == source_id
                    and existing["expires_at"] > existing["observed_at"]
                ):
                    return _public_state(existing)
                renewed = (
                    connection.execute(
                        text("""UPDATE public.live_memory_hosted_pilot_grants
                               SET grant_id=gen_random_uuid(), generation=generation+1,
                                   source_kind=:source_kind, source_id=:source_id,
                                   review_version=:review_version,
                                   status='pending', reviewed_at=clock_timestamp(),
                                   expires_at=clock_timestamp() + interval '15 minutes',
                                   revoked_at=NULL, updated_at=clock_timestamp()
                               WHERE user_id=:user_id
                               RETURNING grant_id, generation, source_kind, source_id, review_version,
                                         status, reviewed_at, expires_at, revoked_at,
                                         clock_timestamp() AS observed_at"""),
                        {
                            "user_id": user_id,
                            "source_kind": SOURCE_KIND,
                            "source_id": source_id,
                            "review_version": REVIEW_VERSION,
                        },
                    )
                    .mappings()
                    .one()
                )
                return _public_state(renewed)

        try:
            return await asyncio.to_thread(write)
        except SQLAlchemyError:
            raise HostedMemoryPilotUnavailable("hosted memory review unavailable") from None

    async def revoke(self, *, user_id: str) -> dict[str, Any]:
        if not user_id:
            raise ValueError("owner identity required")

        def write() -> dict[str, Any]:
            with self.db.engine.begin() as connection:
                self._configure(connection)
                # Insert a revocation fence even when the first review has not
                # committed yet. Otherwise DELETE could return "off" and a
                # delayed POST with generation 0 could create fresh intent.
                revoked = (
                    connection.execute(
                        text("""INSERT INTO public.live_memory_hosted_pilot_grants
                                  (user_id, source_kind, review_version, status,
                                   reviewed_at, expires_at, revoked_at)
                               VALUES (:user_id, :source_kind, :review_version, 'revoked',
                                       clock_timestamp(), clock_timestamp() + interval '15 minutes',
                                       clock_timestamp())
                               ON CONFLICT (user_id) DO UPDATE
                               SET status='revoked',
                                   generation=CASE
                                     WHEN live_memory_hosted_pilot_grants.status='revoked'
                                     THEN live_memory_hosted_pilot_grants.generation
                                     ELSE live_memory_hosted_pilot_grants.generation+1
                                   END,
                                   revoked_at=COALESCE(
                                     live_memory_hosted_pilot_grants.revoked_at,
                                     clock_timestamp()),
                                   updated_at=clock_timestamp()
                               RETURNING grant_id, generation, source_kind, source_id, review_version,
                                         status, reviewed_at, expires_at, revoked_at,
                                         clock_timestamp() AS observed_at"""),
                        {
                            "user_id": user_id,
                            "source_kind": SOURCE_KIND,
                            "review_version": REVIEW_VERSION,
                        },
                    )
                    .mappings()
                    .one()
                )
                return _public_state(revoked)

        try:
            return await asyncio.to_thread(write)
        except SQLAlchemyError:
            raise HostedMemoryPilotUnavailable("hosted memory review unavailable") from None
