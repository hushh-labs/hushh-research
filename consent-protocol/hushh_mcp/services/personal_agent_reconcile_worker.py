"""
Background worker that keeps the per-user personal-agent fleet honest: it retries
provisions that stalled, and reaps pods nobody has used in a long time.

Fleet hygiene, per docs/future/personal-agent/DEV-LIVE-EXECUTION-PLAN.md B6.

Why this worker exists
----------------------
Provisioning is fire-and-forget off the phone-verify seam, so nothing retries it.
``PersonalAgentProvisioningService.provision`` deliberately leaves a failed run's
registry row stuck rather than rolling it back, precisely so a sweep can find it
later -- but until now there was no sweep, and a stalled row stayed stalled
forever. Symmetrically, every provisioned pod is a billable host that keeps
costing money whether or not its owner ever comes back.

Two sweeps, one pass:

  retry
    Rows the fleet gave up on are handed back to the provisioning service, which
    re-runs the normal ladder. Retrying is safe because ``provision`` is
    idempotent by user (``upsert``) and a new standing grant supersedes any prior
    one, so retries cannot accumulate live tokens.

  reap
    A pod idle beyond ``HUSSH_POD_IDLE_REAP_HOURS`` has its HOST torn down --
    **and only its host.** The registry row, the HusshID, the phone hash, the pod
    public key and the A2A address all SURVIVE. Nothing about the person's agent
    identity is destroyed and no tombstone is written, because nothing was
    deprovisioned in the account sense. Re-provisioning on the owner's next
    activity is the intended outcome: the owner pays one cold start instead of
    weeks of idle warm floor. This is why reaping calls the compute backend
    directly rather than
    ``PersonalAgentProvisioningService.deprovision`` -- that path revokes the
    standing read, tombstones the HusshID and deletes the row, which is account
    teardown, a completely different act.

Ship-dark
---------
Inert unless ``PERSONAL_AGENT_RECONCILE_ENABLED`` is explicitly on, on top of
``PERSONAL_AGENT_ENABLED``. Two independent switches, because this sweep DELETES
compute. The flag is read at start AND on every pass, so flipping it back off
stops an already-running loop with no redeploy. Nothing starts this worker
automatically: ``server.py`` has no attach point for it, deliberately, until a
human decides to turn the sweep on.

Known gap, stated here rather than in a runbook
-----------------------------------------------
``personal_agent_registry`` has no last-activity column, and ``updated_at`` has no
``ON UPDATE`` trigger and is never written by
``personal_agent_registry_repo.py`` -- so it is effectively the row's creation
time. There is therefore no truthful source of pod idleness in the schema today.
This worker owns the POLICY (the cutoff instant computed from
``pod_idle_reap_hours``) and takes the idle set from an injected callable; it does
NOT claim that any particular column measures idleness. Wiring an adapter that
reads ``updated_at`` would reap by row AGE, not by inactivity. Close that gap with
a real activity column (or an activity source) before enabling the reap in any
environment where a wrong answer costs someone their warm pod.

The worker is decoupled from the database through dependency-injected async
callables, the same shape as ``revocation_worker.py``, so it is fully testable
without a live database or a live cloud backend.

Usage (only once a human turns the flag on)::

    from hushh_mcp.services.personal_agent_reconcile_worker import (
        start_personal_agent_reconcile_loop,
    )

    task = start_personal_agent_reconcile_loop(
        fetch_stalled=registry_adapter.fetch_stalled_agents,
        retry=provisioning_adapter.retry,
        fetch_idle=registry_adapter.fetch_idle_pods,
        reap=backend_adapter.tear_down_host,
        interval_seconds=900,
    )
    # task is None while PERSONAL_AGENT_RECONCILE_ENABLED is off.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from hushh_mcp.runtime_settings import (
    personal_agent_enabled,
    personal_agent_reconcile_enabled,
    pod_idle_reap_hours,
)
from hushh_mcp.services.personal_agent_provisioning_service import (
    FEED_EVENT_PROVISIONING,
    FEED_EVENT_REAPED,
    record_provisioning_feed_event_safe,
)

logger = logging.getLogger(__name__)

_LABEL = "personal-agent reconcile"


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StalledAgent:
    """
    Minimal record returned by the fetch_stalled callable.

    user_id  — owner of the registry row (the retry's subject)
    hushh_id — opaque agent identifier; may be empty
    status   — the registry status that marked it stalled
    """

    user_id: str
    hushh_id: str
    status: str


@dataclass(frozen=True)
class IdlePod:
    """
    Minimal record returned by the fetch_idle callable.

    user_id           — owner of the registry row
    hushh_id          — opaque agent identifier; may be empty
    external_agent_id — the backend host id to tear down (required; a row with
                        none has no host and is not reapable)
    """

    user_id: str
    hushh_id: str
    external_agent_id: str


@dataclass
class ReconcileReport:
    """Summary returned by a single scan_and_reconcile() call."""

    retried_count: int
    retry_failed_count: int
    reaped_count: int
    reap_failed_count: int
    scan_start: datetime
    scan_end: datetime
    skipped: bool = False
    label: str = _LABEL

    @property
    def total_scanned(self) -> int:
        return (
            self.retried_count
            + self.retry_failed_count
            + self.reaped_count
            + self.reap_failed_count
        )

    def summary(self) -> str:
        elapsed = (self.scan_end - self.scan_start).total_seconds()
        return (
            f"[{self.label}] Reconcile scan: "
            f"{self.retried_count} retried, {self.reaped_count} reaped, "
            f"{self.retry_failed_count + self.reap_failed_count} failed "
            f"of {self.total_scanned} in {elapsed:.2f}s"
        )


def _empty_report(scan_start: datetime, *, skipped: bool = False) -> ReconcileReport:
    return ReconcileReport(
        retried_count=0,
        retry_failed_count=0,
        reaped_count=0,
        reap_failed_count=0,
        scan_start=scan_start,
        scan_end=datetime.now(timezone.utc),
        skipped=skipped,
    )


# ---------------------------------------------------------------------------
# Core worker
# ---------------------------------------------------------------------------


class PersonalAgentReconcileWorker:
    """
    Retries stalled personal-agent provisions and reaps idle pods.

    All database and cloud interactions are provided via injected async callables
    so the worker can be tested without a live database or a live backend:

    fetch_stalled
        Async callable returning the registry rows whose provisioning gave up.
        Signature::

            async def fetch_stalled() -> list[StalledAgent]: ...

    retry
        Async callable that re-runs provisioning for one owner.  Signature::

            async def retry(user_id: str) -> None: ...

    fetch_idle
        Async callable returning pods with no activity since a cutoff instant the
        worker computes from ``HUSSH_POD_IDLE_REAP_HOURS``.  Signature::

            async def fetch_idle(idle_since: datetime) -> list[IdlePod]: ...

    reap
        Async callable that tears down ONE host and nothing else -- no revoke, no
        tombstone, no row delete.  Signature::

            async def reap(external_agent_id: str) -> None: ...
    """

    def __init__(
        self,
        fetch_stalled: Callable[[], Awaitable[list[StalledAgent]]],
        retry: Callable[[str], Awaitable[None]],
        fetch_idle: Callable[[datetime], Awaitable[list[IdlePod]]],
        reap: Callable[[str], Awaitable[None]],
    ) -> None:
        self._fetch_stalled = fetch_stalled
        self._retry = retry
        self._fetch_idle = fetch_idle
        self._reap = reap

    async def scan_and_reconcile(self) -> ReconcileReport:
        """
        Run one reconcile pass: retry what stalled, then reap what went idle.

        Returns a ReconcileReport with counts and timing.  Individual failures are
        logged but do not abort the scan — the worker continues to process
        remaining records, and the retry sweep never blocks the reap sweep.

        Returns an empty report with ``skipped=True``, having touched nothing at
        all, whenever either kill-switch is off. The check is here rather than only
        at start-up so a flag flipped off mid-flight stops the very next pass.
        """
        scan_start = datetime.now(timezone.utc)
        if not (personal_agent_enabled() and personal_agent_reconcile_enabled()):
            return _empty_report(scan_start, skipped=True)

        retried, retry_failed = await self._retry_stalled()
        reaped, reap_failed = await self._reap_idle()

        report = ReconcileReport(
            retried_count=retried,
            retry_failed_count=retry_failed,
            reaped_count=reaped,
            reap_failed_count=reap_failed,
            scan_start=scan_start,
            scan_end=datetime.now(timezone.utc),
        )
        logger.info(report.summary())
        return report

    async def _retry_stalled(self) -> tuple[int, int]:
        try:
            stalled: list[StalledAgent] = await self._fetch_stalled()
        except Exception:
            logger.exception("[%s] fetch_stalled failed — skipping retry sweep", _LABEL)
            return 0, 0

        retried = 0
        failed = 0
        for record in stalled:
            try:
                await self._retry(record.user_id)
                retried += 1
                # The owner sees setup start again, on the same line the first
                # attempt used: a retry IS a provisioning attempt.
                await record_provisioning_feed_event_safe(
                    user_id=record.user_id, event_type=FEED_EVENT_PROVISIONING
                )
                logger.info(
                    "[%s] personal_agent.retried status=%s hushh_id_present=%s",
                    _LABEL,
                    record.status,
                    bool(record.hushh_id),
                )
            except Exception:
                failed += 1
                # No user id, no HusshID, no phone: a reconcile log line is not a
                # place to put an identifier for an owner who did nothing wrong.
                logger.exception(
                    "[%s] personal_agent.retry_failed status=%s", _LABEL, record.status
                )
        return retried, failed

    async def _reap_idle(self) -> tuple[int, int]:
        idle_since = datetime.now(timezone.utc) - timedelta(hours=pod_idle_reap_hours())
        try:
            idle: list[IdlePod] = await self._fetch_idle(idle_since)
        except Exception:
            logger.exception("[%s] fetch_idle failed — skipping reap sweep", _LABEL)
            return 0, 0

        reaped = 0
        failed = 0
        for pod in idle:
            if not (pod.external_agent_id or "").strip():
                # No host recorded -> nothing billable to tear down. Skipping keeps
                # the reap sweep from ever being the thing that touches a row.
                continue
            try:
                await self._reap(pod.external_agent_id)
                reaped += 1
                await record_provisioning_feed_event_safe(
                    user_id=pod.user_id, event_type=FEED_EVENT_REAPED
                )
                logger.info(
                    "[%s] personal_agent.reaped idle_since=%s hushh_id_present=%s",
                    _LABEL,
                    idle_since.isoformat(),
                    bool(pod.hushh_id),
                )
            except Exception:
                failed += 1
                logger.exception("[%s] personal_agent.reap_failed", _LABEL)
        return reaped, failed


# ---------------------------------------------------------------------------
# Background loop
# ---------------------------------------------------------------------------


async def _reconcile_loop(
    worker: PersonalAgentReconcileWorker,
    interval_seconds: float,
) -> None:
    """Run the fleet-hygiene sweep until cancelled."""
    logger.info("[%s] Reconcile loop started (interval=%ss)", _LABEL, interval_seconds)
    while True:
        try:
            await worker.scan_and_reconcile()
        except asyncio.CancelledError:
            logger.info("[%s] Reconcile loop cancelled", _LABEL)
            return
        except Exception:
            logger.exception("[%s] Unhandled error in reconcile loop", _LABEL)
        await asyncio.sleep(interval_seconds)


def start_personal_agent_reconcile_loop(
    *,
    fetch_stalled: Callable[[], Awaitable[list[StalledAgent]]],
    retry: Callable[[str], Awaitable[None]],
    fetch_idle: Callable[[datetime], Awaitable[list[IdlePod]]],
    reap: Callable[[str], Awaitable[None]],
    interval_seconds: float = 900.0,
) -> asyncio.Task | None:
    """
    Schedule the reconcile worker as a background asyncio Task.

    Returns ``None`` -- creating no task at all -- while either kill-switch is
    off, which is the default. That is the ship-dark guarantee at the outer edge:
    with the flags unset, nothing is scheduled, no callable is ever invoked, and
    no timer runs. The same check repeats inside every pass, so a flag flipped off
    later also stops a loop that is already running.

    Returns the Task so callers can cancel it on shutdown.
    """
    if not (personal_agent_enabled() and personal_agent_reconcile_enabled()):
        logger.info("[%s] not scheduled: reconcile sweep is disabled", _LABEL)
        return None

    worker = PersonalAgentReconcileWorker(
        fetch_stalled=fetch_stalled,
        retry=retry,
        fetch_idle=fetch_idle,
        reap=reap,
    )
    return asyncio.create_task(
        _reconcile_loop(worker, interval_seconds),
        name="personal-agent-reconcile-worker",
    )
