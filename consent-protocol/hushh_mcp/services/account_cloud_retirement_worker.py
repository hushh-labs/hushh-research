"""Deferred Dev cleanup on the existing account drain and removal supervisor."""

from __future__ import annotations

import json
import logging
import os
import re
import sys
from uuid import uuid4

from sqlalchemy import text

from db.db_client import get_db_connection, get_db_engine
from hushh_mcp.services.account_cloud_retirement import available
from hushh_mcp.services.legacy_cloud_removal import (
    LegacyRemovalJournal,
    _require,
    operator_source,
    supervise_removal,
)

logger = logging.getLogger(__name__)


def due_operations() -> list[dict]:
    with get_db_connection() as conn:
        if not available(conn):
            return []
        return [
            dict(row)
            for row in conn.execute(
                text("""SELECT c.user_id,c.attempt_id,
          c.recovery->>'planSha256' AS digest FROM personal_agent_cloud_removals c
          WHERE c.completed_at IS NULL AND c.cancelled_at IS NULL
           AND c.retirement_handoff IS NOT NULL
           AND public.account_cloud_retirement_handoff_valid(c.user_id,c.retirement_handoff)
           AND public.account_cloud_retirement_quiescent(c.user_id,c.attempt_id)
           AND NOT EXISTS(SELECT 1 FROM (
            SELECT e FROM jsonb_array_elements(c.recovery->'events') WITH ORDINALITY x(e,n)
             WHERE e->>'stage'='executor_exit' ORDER BY n DESC LIMIT 1) last_exit
            WHERE e->'receipt'->>'outcome'<>'returned'
             AND (e->>'recordedAt')::timestamptz+interval '15 minutes'>clock_timestamp())
           AND EXISTS(SELECT 1 FROM account_deletion_tombstones t
            WHERE t.provider_cleanup_id::text=c.retirement_handoff->>'cleanupOperation' AND t.erasure_phase='erased')
           AND (public.legacy_cloud_removal_complete(c.user_id,c.attempt_id) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.recovery->'events') e
             WHERE e->>'stage'='observation' AND e->'receipt'->>'status'='waiting_for_provider')
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.recovery->'plan'->'resources') r
             WHERE r->>'type' IN ('gcs_bucket','kms_key') AND (
              NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.recovery->'events') e
               WHERE e->>'resource'=(r->>'type')||':'||(r->>'id') AND e->>'stage'='observation')
              OR EXISTS(SELECT 1 FROM (
               SELECT e FROM jsonb_array_elements(c.recovery->'events') WITH ORDINALITY x(e,n)
                WHERE e->>'resource'=(r->>'type')||':'||(r->>'id') AND e->>'stage'='observation'
                ORDER BY n DESC LIMIT 1) latest
               WHERE e->'receipt'->>'status'='waiting_for_provider'
                AND greatest((e->'receipt'->'coverage'->>'nextEligibleAt')::timestamptz,
                  (e->>'recordedAt')::timestamptz+interval '15 minutes')<=clock_timestamp()))))
          ORDER BY c.created_at LIMIT 1""")
            ).mappings()
        ]


def _run_one(operation: dict, source: str) -> bool:
    raw = get_db_engine().raw_connection()
    raw.driver_connection.autocommit = True
    try:
        journal = LegacyRemovalJournal(
            raw.driver_connection, operation["user_id"], operation["attempt_id"]
        )
        recovery = journal.read()
        _require(recovery["planSha256"] == operation["digest"])
        # Source adoption is an append against the original plan, after fresh
        # native identity/authority checks, never an invented old executor.
        from hushh_mcp.services.account_cloud_retirement import verify_cleanup_authority

        with get_db_connection() as conn:
            _require(available(conn))
            params = {
                "owner": operation["user_id"],
                "attempt": operation["attempt_id"],
                "digest": operation["digest"],
            }
            if (
                conn.execute(
                    text("SELECT public.legacy_cloud_removal_complete(:owner,:attempt)"), params
                ).scalar_one()
                is True
            ):
                return (
                    conn.execute(
                        text(
                            "SELECT public.finalize_personal_agent_cloud_removal(:owner,:attempt,:digest)"
                        ),
                        params,
                    ).scalar_one()
                    is True
                )
            reservation = conn.execute(
                text("SELECT public.account_cloud_retirement_reservation(:owner,:attempt)"), params
            ).scalar_one()
        verify_cleanup_authority(recovery, reservation)
        previous = operator_source(recovery)
        if previous != source:
            journal.append(
                "$executor",
                "operator_source",
                {
                    "previousSourceRevision": previous,
                    "sourceRevision": source,
                    "planSha256": operation["digest"],
                    "actor": recovery["plan"]["actor"],
                },
            )
        payload = {"operation": operation, "source": source, "args": {"execution_id": uuid4().hex}}
        status = supervise_removal(
            journal, payload, command=[sys.executable, "-m", __name__, "--worker"]
        )
        if status != 0:
            return False
        with get_db_connection() as conn:
            return (
                conn.execute(
                    text(
                        "SELECT public.finalize_personal_agent_cloud_removal(:owner,:attempt,:digest)"
                    ),
                    {
                        "owner": operation["user_id"],
                        "attempt": operation["attempt_id"],
                        "digest": operation["digest"],
                    },
                ).scalar_one()
                is True
            )
    finally:
        raw.close()


async def drain() -> None:
    from hushh_mcp.services.account_cloud_retirement import _selected_dev
    from hushh_mcp.services.account_deletion_lifecycle_service import (
        settle_cleanup_database_call as join,
    )
    from hushh_mcp.services.account_deletion_release_admission import release_admission

    if not _selected_dev():
        return
    source = os.environ.get("HUSHH_DEPLOY_SHA", "")
    _require(re.fullmatch(r"[0-9a-f]{40}", source) is not None, "CLOUD_REMOVAL_SOURCE_CHANGED")
    async with release_admission() as admission:
        for operation in await join(due_operations):
            await admission.check()
            complete = await join(_run_one, operation, source)
            logger.info("account_cloud_retirement.observed complete=%s", complete)


def bind_release_session(connection):
    """Keep the release barrier on the exact journal session used for dispatch."""
    from hushh_mcp.services.account_deletion_release_admission import _FENCED, _KEY

    def release_guard():
        with connection.cursor() as cursor:
            cursor.execute(
                """SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid()
                AND locktype='advisory' AND mode='ShareLock' AND granted AND objsubid=1
                AND classid=((hashtextextended(%s,0)>>32)&4294967295)::oid
                AND objid=(hashtextextended(%s,0)&4294967295)::oid)""",
                (_KEY, _KEY),
            )
            held = cursor.fetchone()[0]
            cursor.execute(_FENCED)
            fenced = cursor.fetchone()[0]
            _require(held is True and fenced is False, "CLOUD_REMOVAL_RELEASE_ADMISSION_LOST")

    with connection.cursor() as cursor:
        cursor.execute("SET statement_timeout='10000ms'; SET lock_timeout='3000ms'")
        cursor.execute("SELECT pg_try_advisory_lock_shared(hashtextextended(%s,0))", (_KEY,))
        _require(cursor.fetchone()[0] is True, "CLOUD_REMOVAL_RELEASE_ADMISSION_UNAVAILABLE")
    release_guard()
    return release_guard


def _worker(payload: dict, started_pipe) -> int:
    from hushh_mcp.services.account_cloud_retirement import cleanup_credential
    from hushh_mcp.services.legacy_cloud_removal_executor import LegacyGcpRemoval
    from hushh_mcp.services.legacy_cloud_removal_native import RecoverySession
    from hushh_mcp.services.legacy_cloud_removal_teardown import delete_remaining

    operation = payload["operation"]
    raw = get_db_engine().raw_connection()
    raw.driver_connection.autocommit = True
    journal = LegacyRemovalJournal(
        raw.driver_connection, operation["user_id"], operation["attempt_id"]
    )
    try:
        release_guard = bind_release_session(raw.driver_connection)
        _require(
            payload["source"] == os.environ.get("HUSHH_DEPLOY_SHA"), "CLOUD_REMOVAL_SOURCE_CHANGED"
        )
        started = journal.start(payload["args"]["execution_id"], payload["source"])
        print(json.dumps(started), file=started_pipe, flush=True)
        recovery = journal.read()
        with get_db_connection() as conn:
            _require(available(conn))
            row = conn.execute(
                text("""SELECT retirement_handoff->'reservation' FROM personal_agent_cloud_removals
              WHERE user_id=:owner AND attempt_id=:attempt AND public.account_cloud_retirement_handoff_valid(user_id,retirement_handoff)"""),
                {"owner": operation["user_id"], "attempt": operation["attempt_id"]},
            ).scalar_one()
        # The handoff already proves terminal compute/Memory and fenced writers.
        # This port continues only the remaining original resources.
        token = cleanup_credential(recovery)
        with RecoverySession(
            token=token,
            project=recovery["plan"]["project"]["projectId"],
            journal=journal,
            dispatch_guard=release_guard,
        ) as session:
            worker = LegacyGcpRemoval(session=session, journal=journal)
            delete_remaining(worker, token=token, reservation=row)
        return 0
    except Exception as exc:
        code = (
            str(exc)
            if str(exc).isupper() and len(str(exc)) <= 64
            else "CLOUD_REMOVAL_RECOVERY_INTERRUPTED"
        )
        journal.append("$executor", "attention", {"code": code, "uncertain": True})
        logger.warning("account_cloud_retirement.worker_failed code=%s", code)
        return 1
    finally:
        raw.close()


if __name__ == "__main__":
    _require(sys.argv[1:] == ["--worker"])
    payload = json.load(sys.stdin)
    with os.fdopen(payload["startedFd"], "w") as started_pipe:
        raise SystemExit(_worker(payload, started_pipe))
