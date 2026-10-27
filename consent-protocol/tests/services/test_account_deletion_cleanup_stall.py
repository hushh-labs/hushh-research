"""A paused deletion drain is reported, never read as an idle queue.

UAT 2026-10-27: a failed release retained the deletion fence, the provider
drain refused admission on every tick and reported settled=0 for ~5 hours.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from hushh_mcp.services import account_deletion_cleanup_stall as stall
from hushh_mcp.services import account_deletion_lifecycle_service as lifecycle
from hushh_mcp.services import account_deletion_provider_worker as worker
from hushh_mcp.services.account_deletion_release_admission import AccountDeletionReleasePaused

pytestmark = [pytest.mark.feature_account_deletion, pytest.mark.trace_loop]


@pytest.mark.parametrize("fenced", [False, True])
async def test_drain_reports_a_paused_release_instead_of_an_idle_queue(monkeypatch, fenced):
    @asynccontextmanager
    async def admission():
        if fenced:
            raise AccountDeletionReleasePaused("release_fence_installed")
        yield SimpleNamespace(check=AsyncMock())

    claim_due = MagicMock(return_value=[])
    monkeypatch.setattr(worker.journal, "available", lambda: True)
    monkeypatch.setattr(worker.journal, "claim_due", claim_due)
    monkeypatch.setattr(worker, "release_admission", admission)

    outcome = await worker.drain_with_outcome(limit=3)

    assert outcome == worker.DrainOutcome(0, "release_fence_installed" if fenced else None)
    assert await worker.drain(limit=3) == 0
    # A pause never consumes a claim; an admitted idle queue is still polled.
    assert claim_due.called is not fenced


@pytest.mark.parametrize(
    ("backlog", "level", "event"),
    [
        ((1, 18_000), "ERROR", "account_deletion.cleanup_stalled"),
        ((1, 60), "WARNING", "account_deletion.cleanup_paused"),
    ],
)
def test_paused_drain_is_reported_once_and_escalates_when_a_deletion_waits(
    monkeypatch, caplog, backlog, level, event
):
    async def _paused(*, limit: int):
        return worker.DrainOutcome(0, "release_fence_installed")

    monkeypatch.setattr(worker, "drain_with_outcome", _paused)
    monkeypatch.setattr(stall, "_provider_cleanup_backlog", lambda: backlog)
    monkeypatch.setattr(
        lifecycle.AccountDeletionLifecycleService,
        "claim_due_cleanup_intents",
        lambda self, *, limit: [],
    )

    with caplog.at_level("INFO", logger=stall.logger.name):
        report = asyncio.run(lifecycle.drain_account_deletion_cleanup_with_report())
        settled = asyncio.run(lifecycle.drain_account_deletion_cleanup_intents())
        # Draining never reports by itself: every instance loop would multiply it.
        assert not [r for r in caplog.records if "cleanup_paused" in r.getMessage()]
        asyncio.run(stall.report_paused_drain(report.paused_reason))

    assert report == stall.AccountDeletionDrainReport(0, "release_fence_installed")
    assert settled == 0
    record = next(r for r in caplog.records if r.getMessage().startswith(event))
    assert record.levelname == level
    assert f"reason=release_fence_installed due=1 oldest_due_age_s={backlog[1]}" in (
        record.getMessage()
    )
