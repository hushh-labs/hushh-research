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
from typing import Any, Optional

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
    ) -> None:
        row = {
            "user_id": user_id,
            "job_id": job_id,
            "hushh_id": hushh_id,
            "target_project": target_project,
            "target_region": target_region,
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
