"""Moving a person's agent between clouds, as an observable background job.

WHY A JOB AND NOT A REQUEST
---------------------------
The chain crosses two clouds and eleven steps: freeze the source, stand up the
destination, collect its published key, export, ferry, import and re-seal,
verify, switch the row, reap the old host. Provisioning alone regularly takes
minutes -- the same reason `byoc_setup_job_service` exists -- and a timeout here
would be far worse than a timeout there: it could leave a person's memory in
flight between two pods with nothing recording where it got to.

So this owns a durable ticket, one row per person, superseded in place, with the
identical guarded-write discipline the setup job proved. The status route serves
that record, and a person can leave the screen and come back to a finished move.

THE ORDER IS THE SAFETY ARGUMENT
--------------------------------
Every step is placed so that the failure BEFORE it is survivable:

* freeze first, so the export cannot race a live writer;
* build the destination before exporting, so an export never sits waiting;
* verify before switching, so a bad move is a move that did not happen;
* switch before reaping, so the old host still exists while it is still the one
  the row points at;
* reap last, and only the HOST -- never the identity, never a tombstone.

At every point before the switch, the source pod is intact and the worst
outcome is a migration that failed with the person's agent exactly where it was.

WHAT THIS SERVICE CANNOT DO, BY CONSTRUCTION
--------------------------------------------
It cannot read the bundle it carries. Export and import run inside the two pods
(`api/routes/one/pod_migration.py`) because the keys live there and nowhere
else. This service holds ciphertext, two head hashes, and coordinates. If a
future change gives it a decryption path, the honesty clause it exists to
protect is gone -- so the hub-side verification is deliberately a hash
comparison, which needs no key at all.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional, Protocol

from db.db_client import get_db

logger = logging.getLogger(__name__)

_JOBS = "pod_migration_jobs"

#: Stage order, which is the safety order argued in the module docstring.
JOB_STAGES: tuple[str, ...] = (
    "freezing",
    "preparing_cloud",
    "creating_pod",
    "collecting_target_key",
    "exporting",
    "transferring",
    "importing",
    "verifying",
    "switching_over",
    "cleaning_up",
)

#: A running job whose record has not advanced in this long is presumed dead --
#: the instance restarted mid-run. Longer than the setup job's 180s because two
#: provisions and a chain replay legitimately take longer than one project
#: creation, and calling a live migration dead is worse than waiting.
STALE_AFTER_SECONDS = 900.0


class MigrationJobSuperseded(Exception):
    """A newer attempt owns the row; this task must stop writing and exit."""


class MigrationRefused(Exception):
    """A typed refusal a person can act on, rather than a stack trace."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_job_id() -> str:
    return f"mig_{uuid.uuid4().hex[:16]}"


class PodMigrationJobRepo:
    """Single-writer stage record over the ``pod_migration_jobs`` table.

    A deliberate copy of `ByocSetupJobRepo`'s shape rather than a shared base
    class: the two tables carry different columns (this one holds the two head
    hashes that are the whole verification story) and a premature abstraction
    over two writers of two tables is how the guarded-write discipline gets
    generalised into something that no longer guards.
    """

    def __init__(self, client: Any = None):
        self._client = client

    def _db(self) -> Any:
        return self._client if self._client is not None else get_db()

    async def start(
        self,
        *,
        user_id: str,
        job_id: str,
        hushh_id: str,
        target_project: str,
        target_region: Optional[str] = None,
        source_pod_url: Optional[str] = None,
        source_service: Optional[str] = None,
    ) -> None:
        row = {
            "user_id": user_id,
            "job_id": job_id,
            "hushh_id": hushh_id,
            "target_project": target_project,
            "target_region": target_region,
            # Captured at freeze time because standing up the destination
            # rewrites the row's host coordinates. Reading the source address
            # from the row afterwards would export from the pod that has no
            # history yet, and report an empty bundle as a successful move.
            "source_pod_url": source_pod_url,
            "source_service": source_service,
            "status": "running",
            "stage": "starting",
            "stages": [],
            "source_head_sha": None,
            "source_record_count": None,
            "target_head_sha": None,
            "target_record_count": None,
            "error_code": None,
            "error_message": None,
            "created_at": _now(),
            "updated_at": _now(),
        }
        existing = (
            self._db().table(_JOBS).select("user_id").eq("user_id", user_id).limit(1).execute()
        )
        if existing.data:
            self._db().table(_JOBS).update(row).eq("user_id", user_id).execute()
        else:
            self._db().table(_JOBS).insert(row).execute()

    async def _current(self, user_id: str) -> Optional[dict]:
        response = self._db().table(_JOBS).select("*").eq("user_id", user_id).limit(1).execute()
        rows = response.data or []
        return dict(rows[0]) if rows else None

    async def _guarded_update(self, *, user_id: str, job_id: str, data: dict) -> None:
        current = await self._current(user_id)
        if not current or current.get("job_id") != job_id:
            raise MigrationJobSuperseded(f"job {job_id} no longer owns the row")
        data["updated_at"] = _now()
        self._db().table(_JOBS).update(data).eq("user_id", user_id).execute()

    async def advance(self, *, user_id: str, job_id: str, stage: str) -> None:
        current = await self._current(user_id)
        if not current or current.get("job_id") != job_id:
            raise MigrationJobSuperseded(f"job {job_id} no longer owns the row")
        stages = list(current.get("stages") or [])
        stages.append({"stage": stage, "at": _now()})
        await self._guarded_update(
            user_id=user_id, job_id=job_id, data={"stage": stage, "stages": stages}
        )
        logger.info("pod_migration_job.stage user=%s job=%s stage=%s", user_id, job_id, stage)

    async def record_source_receipt(
        self, *, user_id: str, job_id: str, head_sha: str, record_count: int
    ) -> None:
        """What the source PROVED it exported. Coordinates, never content."""
        await self._guarded_update(
            user_id=user_id,
            job_id=job_id,
            data={"source_head_sha": head_sha, "source_record_count": int(record_count)},
        )

    async def record_target_receipt(
        self, *, user_id: str, job_id: str, head_sha: str, record_count: int
    ) -> None:
        await self._guarded_update(
            user_id=user_id,
            job_id=job_id,
            data={"target_head_sha": head_sha, "target_record_count": int(record_count)},
        )

    async def finish(
        self,
        *,
        user_id: str,
        job_id: str,
        status: str,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        await self._guarded_update(
            user_id=user_id,
            job_id=job_id,
            data={
                "status": status,
                "error_code": error_code,
                "error_message": error_message,
            },
        )
        logger.info(
            "pod_migration_job.finished user=%s job=%s status=%s code=%s",
            user_id,
            job_id,
            status,
            error_code or "",
        )

    async def get(self, user_id: str) -> Optional[dict]:
        return await self._current(user_id)


def is_stale(row: dict, *, reference: Optional[datetime] = None) -> bool:
    """A running job whose record stopped advancing is presumed dead.

    Reported rather than hidden: a person watching a frozen checklist deserves
    "this stopped, and here is what is still safe" instead of a spinner that
    never resolves. The source pod is intact in every pre-switch stage, so the
    honest recovery is to unfreeze and offer the move again.
    """
    if str(row.get("status") or "") != "running":
        return False
    raw = str(row.get("updated_at") or "")
    if not raw:
        return False
    try:
        updated = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    if updated.tzinfo is None:
        updated = updated.replace(tzinfo=timezone.utc)
    now = reference or datetime.now(timezone.utc)
    return (now - updated).total_seconds() > STALE_AFTER_SECONDS


def person_facing_stage(stage: str) -> str:
    """What a person is told, which is not what the machine is doing.

    The eleven machine stages collapse into four things somebody actually cares
    about. "Exporting" and "transferring" and "importing" are one sentence to a
    person -- their agent's memory is moving -- and splitting it into three
    invites the question "which one is the risky one", whose honest answer is
    "none of them, that is what the verify step is for".
    """
    if stage in ("freezing", "starting"):
        return "Pausing your agent for a moment"
    if stage in ("preparing_cloud", "creating_pod", "collecting_target_key"):
        return "Building your agent in your cloud"
    if stage in ("exporting", "transferring", "importing"):
        return "Moving everything it has learned"
    if stage in ("verifying", "switching_over"):
        return "Checking nothing was lost"
    if stage == "cleaning_up":
        return "Tidying up the old one"
    return "Working"


# --------------------------------------------------------------------------- #
# The sequencer
# --------------------------------------------------------------------------- #


class MigrationSteps(Protocol):
    """Everything the chain needs from the outside world, as named callables.

    Dependency-injected for the same reason `personal_agent_reconcile_worker` is:
    the risky part of this chain is its ORDER and its rollback, and both are
    fully exercisable without a cloud. Wiring the real Cloud Run calls in here
    would make the sequence testable only where two real projects exist, which
    is precisely where a rollback bug is most expensive to discover.
    """

    async def freeze(self) -> bool: ...
    async def unfreeze(self) -> None: ...
    async def prepare_destination(self) -> None: ...
    async def create_destination(self) -> str: ...
    async def collect_destination_key(self) -> tuple[str, str]: ...
    async def export_source(self, public_key: str, key_id: str) -> dict[str, Any]: ...
    async def import_destination(self, bundle: dict[str, Any]) -> dict[str, Any]: ...
    async def switch_over(self, destination_url: str) -> None: ...
    async def reap_source(self) -> None: ...
    async def rollback_destination(self) -> None: ...


async def run_migration(
    *,
    user_id: str,
    job_id: str,
    steps: Any,
    repo: PodMigrationJobRepo,
) -> str:
    """Run the chain. Returns the terminal status; never raises for a refusal.

    THE ORDER IS THE SAFETY ARGUMENT, and it is enforced here rather than
    described: every step is placed so the failure BEFORE it is survivable, and
    the rollback for everything up to the switch is "put the row back and tear
    down what we built".

    THE SWITCH IS THE POINT OF NO RETURN, and it is gated on a hash comparison
    the hub can perform without any key at all. Before it, the source pod is
    untouched and the worst outcome is a migration that did not happen. After
    it, the destination is live and verified and only cleanup can still fail --
    which is why cleanup is last and its failure is logged rather than fatal.
    """
    from hushh_mcp.services.pod_migration_bundle import (  # noqa: PLC0415
        PodMigrationBundleError,
        verify_rebuilt_head,
    )

    async def _fail(code: str, message: str) -> str:
        await repo.finish(
            user_id=user_id,
            job_id=job_id,
            status="failed",
            error_code=code,
            error_message=message,
        )
        return "failed"

    async def _recover() -> None:
        """Put the person's agent back, then tidy what we can.

        Both halves are best-effort and NEITHER may propagate. An earlier version
        let a failed teardown escape, which meant the typed failure was never
        recorded and the ticket sat at `running` until it went stale -- so the one
        situation where a person most needs to be told what happened was the one
        where nothing told them. Unfreezing matters more than tidying, and saying
        what went wrong matters more than both.
        """
        try:
            await steps.unfreeze()
        except Exception:  # noqa: BLE001
            logger.warning(
                "pod_migration.unfreeze_failed -- the row is still frozen", exc_info=True
            )
        try:
            await steps.rollback_destination()
        except Exception:  # noqa: BLE001
            logger.warning(
                "pod_migration.rollback_failed -- a half-built pod may remain", exc_info=True
            )

    # 1. Freeze. Conditional on the row being `provisioned`, so this both takes
    #    the lock and answers "is this agent even in a state to be moved".
    await repo.advance(user_id=user_id, job_id=job_id, stage="freezing")
    if not await steps.freeze():
        # Nothing was frozen, so there is nothing to unfreeze. Returning here
        # rather than falling through is what keeps the rollback path from
        # unfreezing a row this job never owned.
        return await _fail(
            "NOT_READY_TO_MOVE",
            "your agent is not in a state that can be moved right now",
        )

    try:
        # 2-3. Build the destination BEFORE exporting, so a sealed bundle never
        #      sits waiting on a pod to boot with a frozen agent behind it.
        await repo.advance(user_id=user_id, job_id=job_id, stage="preparing_cloud")
        await steps.prepare_destination()

        await repo.advance(user_id=user_id, job_id=job_id, stage="creating_pod")
        destination_url = await steps.create_destination()

        # 4. PULL the destination's published key. Never accepted from a caller,
        #    the same direction the collector always reads keys in.
        await repo.advance(user_id=user_id, job_id=job_id, stage="collecting_target_key")
        public_key, key_id = await steps.collect_destination_key()

        # 5. Export. The source verifies its own chain first and refuses if it
        #    is broken, so a bundle is never built from a chain nobody trusts.
        await repo.advance(user_id=user_id, job_id=job_id, stage="exporting")
        exported = await steps.export_source(public_key, key_id)
        source_head = str(exported.get("headSha") or "")
        source_count = int(exported.get("recordCount") or 0)
        await repo.record_source_receipt(
            user_id=user_id, job_id=job_id, head_sha=source_head, record_count=source_count
        )

        # 6-7. Ferry and rebuild. The hub holds ciphertext it cannot open.
        await repo.advance(user_id=user_id, job_id=job_id, stage="transferring")
        await repo.advance(user_id=user_id, job_id=job_id, stage="importing")
        imported = await steps.import_destination(dict(exported.get("bundle") or {}))
        target_head = str(imported.get("headSha") or "")
        target_count = int(imported.get("recordCount") or 0)
        await repo.record_target_receipt(
            user_id=user_id, job_id=job_id, head_sha=target_head, record_count=target_count
        )

        # 8. The gate. A hash comparison, which needs no key -- so the hub can
        #    verify a move it could never have read.
        await repo.advance(user_id=user_id, job_id=job_id, stage="verifying")
        try:
            verify_rebuilt_head(source_head_sha=source_head, target_head_sha=target_head)
        except PodMigrationBundleError as exc:
            await _recover()
            return await _fail("HEAD_MISMATCH", str(exc))
        if source_count != target_count:
            # Belt and braces: equal heads already imply equal counts, so a
            # disagreement here means one of the two ends is reporting something
            # other than what it did, and that is worth refusing loudly.
            await _recover()
            return await _fail(
                "COUNT_MISMATCH",
                f"the two ends disagree on how many records moved ({source_count}/{target_count})",
            )

    except MigrationJobSuperseded:
        # A newer attempt owns the row. Stop writing and get out of its way --
        # unfreezing here would unfreeze a migration that is currently running.
        raise
    except Exception as exc:  # noqa: BLE001 - every pre-switch failure is survivable
        logger.warning("pod_migration.failed_before_switch", exc_info=True)
        await _recover()
        return await _fail("MIGRATION_FAILED", f"{type(exc).__name__}: {exc}")

    # 9. The point of no return, taken only after the proof.
    await repo.advance(user_id=user_id, job_id=job_id, stage="switching_over")
    try:
        await steps.switch_over(destination_url)
    except Exception as exc:  # noqa: BLE001
        logger.warning("pod_migration.switch_failed", exc_info=True)
        await _recover()
        return await _fail("SWITCH_FAILED", f"{type(exc).__name__}: {exc}")

    # 10. Cleanup is last and its failure is NOT fatal. The person's agent is
    #     already live and verified in their own cloud; a stranded old host is
    #     an operational cost, and telling them their move failed because of it
    #     would be false.
    await repo.advance(user_id=user_id, job_id=job_id, stage="cleaning_up")
    try:
        await steps.reap_source()
    except Exception:  # noqa: BLE001
        logger.warning("pod_migration.source_reap_failed -- the move succeeded", exc_info=True)

    await repo.finish(user_id=user_id, job_id=job_id, status="succeeded")
    return "succeeded"
