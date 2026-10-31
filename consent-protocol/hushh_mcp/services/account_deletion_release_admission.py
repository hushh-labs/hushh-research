"""Admission shared with the existing account-deletion release fence."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import text

# The SQL installer/remover use this same database-global protocol identifier.
_KEY = "hushh.account-deletion.release.v1"
_FENCED = """SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('actor_profiles','vault_keys')
      AND t.tgname='trg_block_account_deletion_during_release'
      AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
)"""

# Closed, non-sensitive set: logs, the scheduler response and alerts key on it.
PausedReason = Literal[
    "release_fence_installed",
    "release_lock_unavailable",
    "lifecycle_roots_missing",
    "admission_check_failed",
]


class AccountDeletionReleasePaused(RuntimeError):
    """Retryable release admission refusal; never a provider quarantine.

    `reason` keeps a paused drain distinguishable from an idle one.
    """

    sqlstate = "55000"

    def __init__(self, reason: PausedReason = "admission_check_failed") -> None:
        super().__init__("account deletion is temporarily unavailable during a lifecycle release")
        self.reason: PausedReason = reason


def admit_erasure_transaction(conn: Any) -> None:
    """Drain against old and new installers before owner locks or row erasure."""
    conn.execute(
        text(f"""
        LOCK TABLE public.actor_profiles, public.vault_keys IN ROW EXCLUSIVE MODE;
        DO $admit$ BEGIN
          IF ({_FENCED}) THEN
            RAISE EXCEPTION USING ERRCODE='55000',
              MESSAGE='account deletion is temporarily unavailable during a lifecycle release';
          END IF;
        END $admit$;
    """)
    )


def _connect():
    from db.connection import dedicated_connection

    return dedicated_connection()


@dataclass(frozen=True)
class ReleaseAdmission:
    _connection: Any = field(repr=False)

    async def check(self) -> None:
        """A lost session must stop subsequent external dispatch."""
        try:
            held = await self._connection.fetchval(
                """SELECT EXISTS (SELECT 1 FROM pg_locks
                   WHERE pid=pg_backend_pid() AND locktype='advisory'
                     AND mode='ShareLock' AND granted AND objsubid=1
                     AND classid=((hashtextextended($1,0) >> 32) & 4294967295)::oid
                     AND objid=(hashtextextended($1,0) & 4294967295)::oid)""",
                _KEY,
                timeout=3,
            )
        except Exception as exc:
            raise AccountDeletionReleasePaused("admission_check_failed") from exc
        if held is not True:
            raise AccountDeletionReleasePaused("release_lock_unavailable")


@asynccontextmanager
async def release_admission() -> AsyncIterator[ReleaseAdmission]:
    """Hold a dedicated session, not a request-pool slot or open transaction."""
    async with _connect() as conn:
        acquired = False
        body_failed = False
        try:
            try:
                acquired = await conn.fetchval(
                    "SELECT pg_try_advisory_lock_shared(hashtextextended($1,0))", _KEY, timeout=3
                )
                roots = await conn.fetchval(
                    """SELECT count(*) FROM pg_class c
                    JOIN pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relname IN ('actor_profiles','vault_keys')
                      AND c.relkind IN ('r','p')""",
                    timeout=3,
                )
                fenced = await conn.fetchval(_FENCED, timeout=3)
            except Exception as exc:
                raise AccountDeletionReleasePaused("admission_check_failed") from exc
            if fenced:
                raise AccountDeletionReleasePaused("release_fence_installed")
            if acquired is not True:
                raise AccountDeletionReleasePaused("release_lock_unavailable")
            if roots != 2:
                raise AccountDeletionReleasePaused("lifecycle_roots_missing")
            yield ReleaseAdmission(conn)
        except BaseException:
            body_failed = True
            raise
        finally:
            if acquired and not conn.is_closed():
                try:
                    await asyncio.wait_for(
                        conn.fetchval(
                            "SELECT pg_advisory_unlock_shared(hashtextextended($1,0))", _KEY
                        ),
                        timeout=3,
                    )
                except BaseException:
                    # Ending this owned session releases its advisory lock even
                    # when cancellation or a dead socket prevents a round trip.
                    conn.terminate()
                    if not body_failed:
                        raise
