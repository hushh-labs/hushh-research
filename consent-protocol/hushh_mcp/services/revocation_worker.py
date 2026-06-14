"""
Background worker that periodically scans active consents and revokes
those whose expiry time has passed.

Temporal Governance by Abdul Gaffar — Beast Mode initiative.

Why this worker exists
----------------------
The token validation layer (hushh_mcp/consent/token.py) already rejects
expired tokens at runtime via validate_token(). This worker's job is
complementary: it keeps the *database* state consistent by marking expired
consent records as REVOKED so that:

  - Audit queries show accurate lifecycle status (not "ACTIVE" for dead grants)
  - Downstream services that query the DB directly (not via validate_token)
    observe the correct state
  - Compliance reports reflect the actual active consent surface

The worker is intentionally decoupled from the database through
dependency-injected async callables, making it fully testable without a
live database connection.

Usage (register during FastAPI startup)::

    from services.revocation_worker import start_revocation_loop

    @app.on_event("startup")
    async def startup():
        start_revocation_loop(
            fetch_expired=my_db.fetch_expired_consents,
            revoke=my_db.mark_revoked,
            interval_seconds=300,
        )
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_LABEL = "Temporal Governance by Abdul Gaffar"


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExpiredConsent:
    """
    Minimal record returned by the fetch_expired callable.

    consent_id  — unique identifier of the consent record in the DB
    token_id    — the issued HCT: token string (may be empty if not issued)
    scope       — consent scope string, e.g. "pkm.read"
    expired_at  — UTC datetime when expiry was detected
    """

    consent_id: str
    token_id: str
    scope: str
    expired_at: datetime


@dataclass
class RevocationReport:
    """Summary returned by a single scan_and_revoke() call."""

    revoked_count: int
    failed_count: int
    scan_start: datetime
    scan_end: datetime
    label: str = _LABEL

    @property
    def total_scanned(self) -> int:
        return self.revoked_count + self.failed_count

    def summary(self) -> str:
        elapsed = (self.scan_end - self.scan_start).total_seconds()
        return (
            f"[{self.label}] Revocation scan: "
            f"{self.revoked_count}/{self.total_scanned} revoked "
            f"in {elapsed:.2f}s"
        )


# ---------------------------------------------------------------------------
# Core worker
# ---------------------------------------------------------------------------


class ConsentRevocationWorker:
    """
    Scans for and revokes expired consent records.

    All database interactions are provided via injected async callables so
    the worker can be tested without a live database:

    fetch_expired
        Async callable that returns a list of ExpiredConsent records whose
        expiry time has passed.  Signature::

            async def fetch_expired() -> list[ExpiredConsent]: ...

    revoke
        Async callable that marks a single consent as REVOKED in the
        database.  Receives the consent_id.  Signature::

            async def revoke(consent_id: str) -> None: ...
    """

    def __init__(
        self,
        fetch_expired: Callable[[], Awaitable[list[ExpiredConsent]]],
        revoke: Callable[[str], Awaitable[None]],
    ) -> None:
        self._fetch_expired = fetch_expired
        self._revoke = revoke

    async def scan_and_revoke(self) -> RevocationReport:
        """
        Run one revocation scan: fetch expired consents and mark each REVOKED.

        Returns a RevocationReport with counts and timing.  Individual
        revocation failures are logged but do not abort the scan — the
        worker continues to process remaining records.
        """
        scan_start = datetime.now(timezone.utc)
        revoked = 0
        failed = 0

        try:
            expired: list[ExpiredConsent] = await self._fetch_expired()
        except Exception:
            logger.exception(
                "[%s] fetch_expired failed — skipping scan", _LABEL
            )
            scan_end = datetime.now(timezone.utc)
            return RevocationReport(
                revoked_count=0,
                failed_count=0,
                scan_start=scan_start,
                scan_end=scan_end,
            )

        for record in expired:
            try:
                await self._revoke(record.consent_id)
                revoked += 1
                logger.info(
                    "[%s] consent.revoked consent_id=%s scope=%s expired_at=%s",
                    _LABEL,
                    record.consent_id,
                    record.scope,
                    record.expired_at.isoformat(),
                )
            except Exception:
                failed += 1
                logger.exception(
                    "[%s] consent.revoke_failed consent_id=%s",
                    _LABEL,
                    record.consent_id,
                )

        scan_end = datetime.now(timezone.utc)
        report = RevocationReport(
            revoked_count=revoked,
            failed_count=failed,
            scan_start=scan_start,
            scan_end=scan_end,
        )
        logger.info(report.summary())
        return report


# ---------------------------------------------------------------------------
# Background loop
# ---------------------------------------------------------------------------


async def _revocation_loop(
    worker: ConsentRevocationWorker,
    interval_seconds: float,
) -> None:
    """Run scan_and_revoke() on a fixed interval until cancelled."""
    logger.info(
        "[%s] Revocation loop started (interval=%ss)", _LABEL, interval_seconds
    )
    while True:
        try:
            await worker.scan_and_revoke()
        except asyncio.CancelledError:
            logger.info("[%s] Revocation loop cancelled", _LABEL)
            return
        except Exception:
            logger.exception("[%s] Unhandled error in revocation loop", _LABEL)
        await asyncio.sleep(interval_seconds)


def start_revocation_loop(
    *,
    fetch_expired: Callable[[], Awaitable[list[ExpiredConsent]]],
    revoke: Callable[[str], Awaitable[None]],
    interval_seconds: float = 300.0,
) -> asyncio.Task:
    """
    Schedule the revocation worker as a background asyncio Task.

    Call from your FastAPI startup handler::

        @app.on_event("startup")
        async def startup():
            start_revocation_loop(
                fetch_expired=db.fetch_expired_consents,
                revoke=db.mark_consent_revoked,
                interval_seconds=300,
            )

    Returns the Task so callers can cancel it on shutdown.
    """
    worker = ConsentRevocationWorker(
        fetch_expired=fetch_expired,
        revoke=revoke,
    )
    return asyncio.create_task(
        _revocation_loop(worker, interval_seconds),
        name="consent-revocation-worker",
    )
