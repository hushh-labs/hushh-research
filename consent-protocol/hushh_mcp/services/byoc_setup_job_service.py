"""The one-click cloud setup as an observable background job.

WHY A JOB AND NOT A REQUEST
---------------------------
The six-stage chain (create project, link billing, enable APIs, apply IAM,
settle the grant, prove and record) ran inside one synchronous HTTP request
bounded by three stacked timeouts: backend settle 45s, proxy 55s, browser 60s.
A fresh project legitimately needs longer. Measured live (2026-08-21,
hussh-one-6pf68p): creation and API enabling consumed 24s, leaving the settle
window 15 seconds against Google's minutes-scale IAM propagation, so the person
was told to "press Continue again" -- a machine's job handed to a human.

The route now burns the single-use OAuth code synchronously (it cannot wait),
hands the in-memory token to a background task, and answers in about a second
with a job id. The task runs the chain, writing one durable stage record per
transition; a status route serves that record to every surface that wants to
show the truth. The settle stage can now wait the realistic window because no
HTTP budget applies to it.

TOKEN CUSTODY IS UNCHANGED
--------------------------
The person's transient access token lives in this task's memory for the job's
lifetime, exactly as it lived in the request coroutine before. It is never
written to the jobs table, never logged, never persisted. The table holds
stage names, timestamps, a typed refusal, and coordinates only.

ONE ROW PER PERSON, SUPERSEDED IN PLACE
---------------------------------------
A new attempt overwrites the row with a new job id. A superseded task notices
(its writes are guarded by job id) and exits without touching anything -- so
two tabs racing produce one winner and zero interleaved records.

DEV-LANE HONESTY
----------------
Background continuation after the response requires an unthrottled instance.
The dev backend runs --no-cpu-throttling; uat and prod do not, and the whole
personal-agent surface is dev-only today. When this lane is promoted, that
flag promotes with it (scripts/deploy/backend-deploy.sh carries the note).
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

from db.db_client import get_db

logger = logging.getLogger(__name__)

_JOBS = "byoc_setup_jobs"

#: Stage order, which is the product order: nothing is authorized before it
#: exists and bills, and nothing is recorded before the fresh grant answers.
JOB_STAGES: tuple[str, ...] = (
    "creating_project",
    "linking_billing",
    "enabling_apis",
    "applying_iam",
    "settling_grant",
    "proving",
)

#: Settle backoff for the background job. Sums to ~164s of waiting plus probe
#: time -- sized to Google's observed IAM propagation, not to an HTTP budget.
SETTLE_DELAYS_SECONDS: tuple[float, ...] = (2, 4, 8, 15, 30, 45, 60)

#: A running job whose record has not advanced in this long is presumed dead
#: (the instance restarted mid-run). The chain is idempotent, so the honest
#: answer is "start it again", and the status route says so.
STALE_AFTER_SECONDS = 180.0


class JobSuperseded(Exception):
    """A newer attempt owns the row; this task must stop writing and exit."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ByocSetupJobRepo:
    """Single-writer stage record over the ``byoc_setup_jobs`` table."""

    def __init__(self, client: Any = None):
        self._client = client

    def _db(self) -> Any:
        return self._client if self._client is not None else get_db()

    async def start(self, *, user_id: str, job_id: str, project_id: str) -> None:
        row = {
            "user_id": user_id,
            "job_id": job_id,
            "project_id": project_id,
            "status": "running",
            "stage": "starting",
            "stages": [],
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

    async def find_by_project(self, project_id: str) -> list[dict]:
        """The reverse index the cross-project orphan sweep needs: which user(s) set up
        this project. A fleet-first sweep sees a bare service name in a user's project and
        must map it back to an owner before it can propose adoption; ``project_id`` is the
        only stored link from a project to the user who named it.

        Returns every matching job row (normally one). The caller resolves ties by
        preferring the registry row's CURRENT ``user_cloud_project`` over a superseded job,
        since a person can switch clouds and leave a stale job row behind."""
        normalized = str(project_id or "").strip()
        if not normalized:
            return []
        response = self._db().table(_JOBS).select("*").eq("project_id", normalized).execute()
        return [dict(r) for r in (response.data or [])]

    async def _guarded_update(self, *, user_id: str, job_id: str, data: dict) -> None:
        current = await self._current(user_id)
        if not current or current.get("job_id") != job_id:
            raise JobSuperseded(f"job {job_id} no longer owns the row")
        data["updated_at"] = _now()
        self._db().table(_JOBS).update(data).eq("user_id", user_id).execute()

    async def advance(self, *, user_id: str, job_id: str, stage: str) -> None:
        current = await self._current(user_id)
        if not current or current.get("job_id") != job_id:
            raise JobSuperseded(f"job {job_id} no longer owns the row")
        stages = list(current.get("stages") or [])
        stages.append({"stage": stage, "at": _now()})
        await self._guarded_update(
            user_id=user_id, job_id=job_id, data={"stage": stage, "stages": stages}
        )
        logger.info("byoc_setup_job.stage user=%s job=%s stage=%s", user_id, job_id, stage)

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
            "byoc_setup_job.finished user=%s job=%s status=%s code=%s",
            user_id,
            job_id,
            status,
            error_code or "",
        )

    async def get(self, user_id: str) -> Optional[dict]:
        return await self._current(user_id)


async def run_setup_job(
    *,
    user_id: str,
    job_id: str,
    project: str,
    token: str,
    display_name: str,
    caller_sa: str,
    bootstrap_account_id: str,
    ensure_project: Callable[..., dict],
    ensure_billing: Callable[..., dict],
    apply_authorization: Callable[..., dict],
    wait_for_grant: Callable[..., Awaitable[bool]],
    save: Callable[[], Awaitable[Any]],
    repo: ByocSetupJobRepo | None = None,
    settle_delays: tuple[float, ...] | None = None,
) -> None:
    """The chain, with one durable stage record per transition.

    Every Google-facing step is injected so the route wires the real authorizer
    and tests wire fakes; the ordering and the record-keeping live here and
    nowhere else. Errors carry the authorizer's typed message into the record
    verbatim -- the same words the synchronous route used to raise.
    """
    from hushh_mcp.services.byoc_oauth_authorizer import ByocAuthorizeError

    jobs = repo or ByocSetupJobRepo()
    bootstrap_sa = f"{bootstrap_account_id}@{project}.iam.gserviceaccount.com"
    try:
        await jobs.advance(user_id=user_id, job_id=job_id, stage="creating_project")
        await asyncio.to_thread(
            ensure_project, project_id=project, display_name=display_name, token=token
        )

        await jobs.advance(user_id=user_id, job_id=job_id, stage="linking_billing")
        await asyncio.to_thread(ensure_billing, project_id=project, token=token)

        await jobs.advance(user_id=user_id, job_id=job_id, stage="enabling_apis")

        async def _mark_applying() -> None:
            await jobs.advance(user_id=user_id, job_id=job_id, stage="applying_iam")

        loop = asyncio.get_running_loop()
        await asyncio.to_thread(
            apply_authorization,
            project=project,
            token=token,
            caller_sa=caller_sa,
            bootstrap_account_id=bootstrap_account_id,
            on_apis_enabled=lambda: asyncio.run_coroutine_threadsafe(
                _mark_applying(), loop
            ).result(),
        )

        await jobs.advance(user_id=user_id, job_id=job_id, stage="settling_grant")
        # Late-bound so tests (and future tuning) can shrink the window by
        # patching the module constant; a def-time default would freeze it.
        delays = settle_delays if settle_delays is not None else SETTLE_DELAYS_SECONDS
        deadline = time.monotonic() + sum(delays) + 30.0
        settled = await wait_for_grant(bootstrap_sa, deadline=deadline, delays=delays)
        if not settled:
            await jobs.finish(
                user_id=user_id,
                job_id=job_id,
                status="failed",
                error_code="GRANT_SETTLING",
                error_message=(
                    "Your cloud is authorized, and Google is taking unusually long to "
                    "settle the new permission. Press Try again; everything already "
                    "done is kept."
                ),
            )
            return

        await jobs.advance(user_id=user_id, job_id=job_id, stage="proving")
        await save()

        await jobs.finish(user_id=user_id, job_id=job_id, status="recorded")
    except JobSuperseded:
        logger.info("byoc_setup_job.superseded user=%s job=%s", user_id, job_id)
    except ByocAuthorizeError as exc:
        try:
            await jobs.finish(
                user_id=user_id,
                job_id=job_id,
                status="failed",
                error_code=exc.code,
                error_message=str(exc),
            )
        except JobSuperseded:
            pass
    except Exception as exc:  # noqa: BLE001 - the record must never die silently
        logger.exception("byoc_setup_job.unexpected user=%s job=%s", user_id, job_id)
        try:
            await jobs.finish(
                user_id=user_id,
                job_id=job_id,
                status="failed",
                error_code="UNEXPECTED",
                error_message=(
                    "Something unexpected stopped the setup. Everything already done "
                    f"is kept; press Try again. ({type(exc).__name__})"
                ),
            )
        except JobSuperseded:
            pass


def new_job_id() -> str:
    return uuid.uuid4().hex


def is_stale(row: dict, *, now: datetime | None = None) -> bool:
    """A running job whose record stopped advancing is presumed dead."""
    if (row.get("status") or "") != "running":
        return False
    raw = str(row.get("updated_at") or "")
    try:
        updated = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return True
    reference = now or datetime.now(timezone.utc)
    if updated.tzinfo is None:
        updated = updated.replace(tzinfo=timezone.utc)
    return (reference - updated).total_seconds() > STALE_AFTER_SECONDS
