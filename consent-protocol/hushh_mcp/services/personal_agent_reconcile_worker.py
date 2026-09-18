"""
Background worker that keeps the per-user personal-agent fleet honest: it retries
provisions that stalled, and reaps pods nobody has used in a long time.

Fleet hygiene, per docs/reference/architecture/private-agent-north-star.md.

Why this worker exists
----------------------
Provisioning is fire-and-forget off the phone-verify seam, so nothing retries it.
``PersonalAgentProvisioningService.provision`` deliberately leaves a failed run's
registry row stuck rather than rolling it back, precisely so a sweep can find it
later -- but until now there was no sweep, and a stalled row stayed stalled
forever. Symmetrically, every provisioned pod is a billable host that keeps
costing money whether or not its owner ever comes back.

Four sweeps, one pass:

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

  upgrade
    Pods whose recorded build is behind the hub's image are moved onto it, a
    bounded batch per pass (see ``_upgrade_stale``).

  erase orphans
    A registry row whose OWNER no longer exists in the identity provider is the
    one case where account teardown IS the right act. Account deletion through
    the app erases the database first and the Firebase identity last, so the
    normal order never produces this. It appears when the identity is deleted out
    of band (a console delete, a test account swept by hand, the 2026-09-12 demo
    reset) and leaves a billing pod, a bucket, a KMS key and a HusshID that nobody
    can ever sign in to release. Nothing else in the system looks for it, so it
    would sit there until the invoice found it. The sweep asks the identity
    provider per owner, treats only a definitive "no such user" as absence (any
    error is "unknown" and never acts), requires the absence to hold across two
    passes ``orphan_confirm_after`` apart, refuses a pass in which most owners
    read absent (that is a misconfigured identity backend, not an orphan wave),
    and then runs the SAME full erasure the account route runs. See
    ``_erase_orphans``.

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
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from hushh_mcp.runtime_settings import (
    personal_agent_enabled,
    personal_agent_reconcile_enabled,
    personal_agent_upgrade_batch,
    personal_agent_upgrade_sweep_enabled,
    pod_idle_reap_hours,
)
from hushh_mcp.services.personal_agent_provisioning_service import (
    FEED_EVENT_PROVISIONING,
    FEED_EVENT_REAPED,
    record_provisioning_feed_event_safe,
)

_URL_RE = re.compile(r"https?://\S+")
#: `projects/<id>/...` and `namespaces/<id>/...` name a person's own cloud even when
#: they arrive outside a URL, which is how a Cloud Run error body usually carries them.
_RESOURCE_PATH_RE = re.compile(r"\b(projects|namespaces)/[^/\s]+", re.IGNORECASE)
#: Long opaque runs are the shape of a bearer token or an access key.
_OPAQUE_RE = re.compile(r"\b[A-Za-z0-9_\-]{40,}\b")


def _safe_detail(exc: BaseException) -> str:
    """What went wrong, with the parts that identify a person's cloud taken out.

    The comment that used to sit here said "type only, never the message", and the
    line under it logged `str(exc)` -- 9fc41c180 added the detail and left the
    prohibition standing above it. Both halves had a point. `requests.HTTPError` from
    `raise_for_status()` reads "403 Client Error: Forbidden for url:
    https://.../namespaces/<their project>/services/one-pod-<id>", so every failed
    sweep put a person's own project id and pod name in hub logs. And the detail is
    genuinely load-bearing: 0ba8c6b49 was diagnosed from it ("HTTP 403 starting a blob
    upload into a project authorised before the copy-writer grant existed"), and the
    registry marker keeps only `user_safe_failure_reason`, a coarse code -- so this
    line is the ONLY place the real error text appears.

    So the status code and the shape of the failure survive, and the coordinates do
    not. Redacting rather than deleting keeps the thing the detail was added for.
    """
    from hushh_mcp.consent.pii_sanitizer import sanitize_log_value  # noqa: PLC0415

    text = " ".join(str(exc).split())
    text = _URL_RE.sub("<url>", text)
    text = _RESOURCE_PATH_RE.sub(r"\1/<redacted>", text)
    text = _OPAQUE_RE.sub("<redacted>", text)
    return str(sanitize_log_value(text))[:240] or "<no detail>"


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


@dataclass(frozen=True)
class StalePod:
    """
    Minimal record returned by the fetch_stale callable.

    user_id  — owner of the registry row (the upgrade's subject)
    hushh_id — opaque agent identifier; may be empty
    image    — the image the row says the pod was built from
    """

    user_id: str
    hushh_id: str
    image: str


@dataclass(frozen=True)
class OrphanCandidate:
    """
    Minimal record returned by the fetch_orphan_candidates callable.

    user_id  — owner of the registry row, the identity the sweep asks about
    hushh_id — opaque agent identifier; may be empty
    status   — the registry status, for the log line only; every status is a
               candidate, because an orphan is an orphan whether its pod is
               ``provisioned`` or stuck at ``awaiting_agent_record``
    """

    user_id: str
    hushh_id: str
    status: str


#: At most this many orphaned accounts are erased per pass. A full erasure tears
#: down a pod, a bucket and KMS material in the person's own project, so a wave of
#: them is spread over passes rather than run in one burst.
_ORPHAN_ERASE_BATCH = 5
#: The mass-absence breaker: when at least this many owners read absent in one
#: pass AND they are more than half of the owners checked, the pass refuses to
#: erase anything. Real orphans arrive one or two at a time; "everyone is gone" is
#: the signature of the identity backend answering for the wrong project.
_MASS_ABSENCE_MIN = 3
#: How long an owner must stay absent before the sweep acts. Two passes at the
#: default interval, so a momentary lie from the identity provider costs nothing.
DEFAULT_ORPHAN_CONFIRM_AFTER = timedelta(minutes=10)


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
    upgraded_count: int = 0
    upgrade_failed_count: int = 0
    orphans_erased_count: int = 0
    orphan_erase_failed_count: int = 0
    #: Owners absent this pass but not yet for ``orphan_confirm_after``.
    orphans_pending_count: int = 0

    @property
    def total_scanned(self) -> int:
        return (
            self.retried_count
            + self.retry_failed_count
            + self.reaped_count
            + self.reap_failed_count
            + self.upgraded_count
            + self.upgrade_failed_count
            + self.orphans_erased_count
            + self.orphan_erase_failed_count
        )

    def summary(self) -> str:
        elapsed = (self.scan_end - self.scan_start).total_seconds()
        failed = (
            self.retry_failed_count
            + self.reap_failed_count
            + self.upgrade_failed_count
            + self.orphan_erase_failed_count
        )
        return (
            f"[{self.label}] Reconcile scan: "
            f"{self.retried_count} retried, {self.reaped_count} reaped, "
            f"{self.upgraded_count} upgraded, "
            f"{self.orphans_erased_count} orphans erased "
            f"({self.orphans_pending_count} pending confirmation), "
            f"{failed} failed of {self.total_scanned} in {elapsed:.2f}s"
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

    fetch_stale / upgrade (optional)
        The image-upgrade sweep. ``fetch_stale`` returns the whole pods whose
        recorded build is not the hub's current image; ``upgrade`` moves ONE pod
        onto it in place. Both default to None, which disables the sweep
        structurally; it is further gated by
        ``PERSONAL_AGENT_UPGRADE_SWEEP_ENABLED`` and bounded per pass by
        ``PERSONAL_AGENT_UPGRADE_BATCH``, because it restarts people's pods.
        Signatures::

            async def fetch_stale() -> list[StalePod]: ...
            async def upgrade(user_id: str) -> None: ...

    fetch_orphan_candidates / owner_exists / erase_orphan (optional)
        The owner-existence sweep. ``fetch_orphan_candidates`` returns registry
        rows (every status); ``owner_exists`` asks the identity provider about
        ONE owner and answers ``True``, ``False`` (a definitive "no such user")
        or ``None`` (could not tell: timeout, outage, misconfiguration), and the
        sweep acts only on ``False``, only once it has held for
        ``orphan_confirm_after``, and only when the pass is not a mass-absence
        reading. ``erase_orphan`` runs the full account erasure for one owner,
        the same cascade the account route runs, so the pod, the bucket, the
        keys, the HusshID tombstone and every user-keyed table go together. All
        three default to None, which disables the sweep structurally.
        Signatures::

            async def fetch_orphan_candidates() -> list[OrphanCandidate]: ...
            async def owner_exists(user_id: str) -> bool | None: ...
            async def erase_orphan(user_id: str) -> None: ...
    """

    def __init__(
        self,
        fetch_stalled: Callable[[], Awaitable[list[StalledAgent]]],
        retry: Callable[[str], Awaitable[None]],
        fetch_idle: Callable[[datetime], Awaitable[list[IdlePod]]],
        reap: Callable[[str], Awaitable[None]],
        fetch_stale: Optional[Callable[[], Awaitable[list[StalePod]]]] = None,
        upgrade: Optional[Callable[[str], Awaitable[None]]] = None,
        fetch_orphan_candidates: Optional[Callable[[], Awaitable[list[OrphanCandidate]]]] = None,
        owner_exists: Optional[Callable[[str], Awaitable[Optional[bool]]]] = None,
        erase_orphan: Optional[Callable[[str], Awaitable[None]]] = None,
        orphan_confirm_after: timedelta = DEFAULT_ORPHAN_CONFIRM_AFTER,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self._fetch_stalled = fetch_stalled
        self._retry = retry
        self._fetch_idle = fetch_idle
        self._reap = reap
        self._fetch_stale = fetch_stale
        self._upgrade = upgrade
        self._fetch_orphan_candidates = fetch_orphan_candidates
        self._owner_exists = owner_exists
        self._erase_orphan = erase_orphan
        self._orphan_confirm_after = orphan_confirm_after
        self._clock = clock
        #: user_id -> the instant this worker first saw the owner absent. Worker
        #: local on purpose: the loop runs in every gunicorn worker, and a shared
        #: record would need a schema change for a sweep that must stay boring.
        #: The cost is that two workers can each erase the same orphan; erasure
        #: is idempotent, so the second one counts a no-op, not damage.
        self._absent_first_seen: dict[str, datetime] = {}

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
        upgraded, upgrade_failed = await self._upgrade_stale()
        orphans_erased, orphan_failed, orphans_pending = await self._erase_orphans()

        report = ReconcileReport(
            retried_count=retried,
            retry_failed_count=retry_failed,
            reaped_count=reaped,
            reap_failed_count=reap_failed,
            scan_start=scan_start,
            scan_end=datetime.now(timezone.utc),
            upgraded_count=upgraded,
            upgrade_failed_count=upgrade_failed,
            orphans_erased_count=orphans_erased,
            orphan_erase_failed_count=orphan_failed,
            orphans_pending_count=orphans_pending,
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
                    "[%s] personal_agent.retried status=%s hushh_id=%s",
                    _LABEL,
                    record.status,
                    record.hushh_id or "<none>",
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
                    "[%s] personal_agent.reaped idle_since=%s hushh_id=%s",
                    _LABEL,
                    idle_since.isoformat(),
                    pod.hushh_id or "<none>",
                )
            except Exception:
                failed += 1
                logger.exception("[%s] personal_agent.reap_failed", _LABEL)
        return reaped, failed

    # ---------------------------------------------------------------------------
    # Background loop
    # ---------------------------------------------------------------------------

    async def _upgrade_stale(self) -> tuple[int, int]:
        """Move at most one batch of stale pods onto the current image.

        Inert unless BOTH callables were injected AND the sweep flag is on; the
        flag is read per pass so it can be flipped off mid-rollout. One failed
        upgrade never stops the batch, and the batch is small on purpose (see
        ``personal_agent_upgrade_batch``): a bad image is found by the first few
        people it reaches, not by everyone at once.
        """
        if self._fetch_stale is None or self._upgrade is None:
            return 0, 0
        if not personal_agent_upgrade_sweep_enabled():
            return 0, 0
        try:
            stale = await self._fetch_stale()
        except Exception:
            logger.exception("[%s] fetch_stale failed; skipping upgrade sweep", _LABEL)
            return 0, 0
        batch = stale[: personal_agent_upgrade_batch()]
        if stale and not batch:
            return 0, 0
        upgraded = 0
        failed = 0
        for pod in batch:
            try:
                await self._upgrade(pod.user_id)
                upgraded += 1
                logger.info(
                    "[%s] upgraded hushh_id=%s from=%s",
                    _LABEL,
                    pod.hushh_id or "<none>",
                    (pod.image or "-").rsplit("/", 1)[-1][:48],
                )
            except Exception as exc:
                failed += 1
                # Redacted, never raw: a cloud error body carries the person's own
                # project id, their pod name, and sometimes a token. `_safe_detail`
                # keeps the status code, which is the diagnosis, and drops the rest.
                logger.warning(
                    "[%s] upgrade failed hushh_id=%s error=%s detail=%s",
                    _LABEL,
                    pod.hushh_id or "<none>",
                    type(exc).__name__,
                    _safe_detail(exc),
                )
        if len(stale) > len(batch):
            logger.info(
                "[%s] %d stale pods remain after this batch", _LABEL, len(stale) - len(batch)
            )
        return upgraded, failed

    async def _erase_orphans(self) -> tuple[int, int, int]:
        """Erase accounts whose owner the identity provider no longer knows.

        Returns ``(erased, failed, pending)``. Structurally inert unless all three
        callables were injected. The decision ladder, in order, each step
        fail-closed:

        1. ``owner_exists`` answered ``None`` -> unknown, forget any earlier
           absence, never act. An outage must not read as a wave of deletions.
        2. Answered ``True`` -> present, forget any earlier absence.
        3. Answered ``False`` for the first time -> remember when, act later.
        4. Most owners absent this pass (``_MASS_ABSENCE_MIN`` and over half) ->
           refuse the whole pass and say so loudly; that is the identity backend
           answering for the wrong project, not an orphan wave.
        5. Absent for at least ``orphan_confirm_after`` -> erase, bounded by
           ``_ORPHAN_ERASE_BATCH`` per pass.

        The erasure is the account route's own cascade, so what an orphan leaves
        behind is exactly what a person's own deletion would leave behind: the
        retained accountability tables and nothing that bills.
        """
        if (
            self._fetch_orphan_candidates is None
            or self._owner_exists is None
            or self._erase_orphan is None
        ):
            return 0, 0, 0
        try:
            candidates = await self._fetch_orphan_candidates()
        except Exception:
            logger.exception("[%s] fetch_orphan_candidates failed; skipping sweep", _LABEL)
            return 0, 0, 0

        now = self._clock()
        absent: list[OrphanCandidate] = []
        checked = 0
        for candidate in candidates:
            user_id = candidate.user_id
            if not user_id:
                continue
            try:
                exists = await self._owner_exists(user_id)
            except Exception as exc:
                # Contract says the callable answers None for "unknown"; a raise is
                # the same thing said less carefully. Treat it identically.
                logger.warning(
                    "[%s] owner_exists raised hushh_id=%s error=%s",
                    _LABEL,
                    candidate.hushh_id or "<none>",
                    type(exc).__name__,
                )
                exists = None
            if exists is None:
                self._absent_first_seen.pop(user_id, None)
                continue
            checked += 1
            if exists:
                self._absent_first_seen.pop(user_id, None)
                continue
            self._absent_first_seen.setdefault(user_id, now)
            absent.append(candidate)

        # Owners that stopped being candidates (already erased, row gone) must not
        # keep an absence clock running against a user id that may be reused.
        live_ids = {c.user_id for c in candidates}
        for stale_id in [k for k in self._absent_first_seen if k not in live_ids]:
            self._absent_first_seen.pop(stale_id, None)

        if not absent:
            return 0, 0, 0
        if len(absent) >= _MASS_ABSENCE_MIN and len(absent) * 2 > checked:
            logger.error(
                "[%s] personal_agent.orphan_sweep_refused absent=%d checked=%d "
                "reason=mass_absence (identity backend answering for the wrong "
                "project?) nothing erased",
                _LABEL,
                len(absent),
                checked,
            )
            return 0, 0, len(absent)

        confirmed = [
            c
            for c in absent
            if now - self._absent_first_seen[c.user_id] >= self._orphan_confirm_after
        ]
        pending = len(absent) - len(confirmed)
        batch = confirmed[:_ORPHAN_ERASE_BATCH]
        erased = 0
        failed = 0
        for candidate in batch:
            first_seen = self._absent_first_seen[candidate.user_id]
            try:
                await self._erase_orphan(candidate.user_id)
                erased += 1
                self._absent_first_seen.pop(candidate.user_id, None)
                logger.warning(
                    "[%s] personal_agent.orphan_erased hushh_id=%s status=%s absent_for_s=%d",
                    _LABEL,
                    candidate.hushh_id or "<none>",
                    candidate.status,
                    int((now - first_seen).total_seconds()),
                )
            except Exception as exc:
                failed += 1
                logger.warning(
                    "[%s] personal_agent.orphan_erase_failed hushh_id=%s error=%s detail=%s",
                    _LABEL,
                    candidate.hushh_id or "<none>",
                    type(exc).__name__,
                    _safe_detail(exc),
                )
        if len(confirmed) > len(batch):
            logger.warning(
                "[%s] %d confirmed orphans remain after this batch",
                _LABEL,
                len(confirmed) - len(batch),
            )
        return erased, failed, pending


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
    fetch_stale: Optional[Callable[[], Awaitable[list[StalePod]]]] = None,
    upgrade: Optional[Callable[[str], Awaitable[None]]] = None,
    fetch_orphan_candidates: Optional[Callable[[], Awaitable[list[OrphanCandidate]]]] = None,
    owner_exists: Optional[Callable[[str], Awaitable[Optional[bool]]]] = None,
    erase_orphan: Optional[Callable[[str], Awaitable[None]]] = None,
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
        fetch_stale=fetch_stale,
        upgrade=upgrade,
        fetch_orphan_candidates=fetch_orphan_candidates,
        owner_exists=owner_exists,
        erase_orphan=erase_orphan,
    )
    return asyncio.create_task(
        _reconcile_loop(worker, interval_seconds),
        name="personal-agent-reconcile-worker",
    )
