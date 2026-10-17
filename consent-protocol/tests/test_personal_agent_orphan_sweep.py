"""The owner-existence sweep: erase what nobody can ever sign in to release.

Hermetic, like ``test_personal_agent_reconcile_worker.py``: every fact the sweep
acts on is an injected callable, and the clock is injected so "absent for ten
minutes" is a value, not a wait.

The properties that have to hold, because the action is a full account erasure
in a person's own cloud:

1. **Unknown is never absent.** A lookup that times out, raises, or answers
   ``None`` erases nothing and forgets any earlier absence.
2. **Absence must persist.** One "no such user" is remembered, not acted on;
   only an absence older than ``orphan_confirm_after`` is erased.
3. **A wave is a broken backend, not an orphan wave.** When most owners read
   absent in one pass the whole pass refuses.
4. **The sweep is structurally inert** without all three callables, and bounded
   per pass when they are there.
5. **One failed erasure never stops the batch**, and the failure is counted.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.services import personal_agent_reconcile_worker as worker_module
from hushh_mcp.services.personal_agent_reconcile_worker import (
    OrphanCandidate,
    PersonalAgentReconcileWorker,
)

_T0 = datetime(2026, 9, 13, 12, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _core_env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("PERSONAL_AGENT_RECONCILE_ENABLED", "1")


class Clock:
    def __init__(self, at: datetime = _T0) -> None:
        self.at = at

    def __call__(self) -> datetime:
        return self.at

    def advance(self, delta: timedelta) -> None:
        self.at = self.at + delta


class Identity:
    """A fake identity provider: per-owner answer True / False / None / raise."""

    def __init__(self, answers: dict[str, object]) -> None:
        self.answers = answers
        self.asked: list[str] = []
        self.erased: list[str] = []
        self.erase_raises_for: set[str] = set()
        self.candidates: list[OrphanCandidate] = [
            OrphanCandidate(user_id=uid, hushh_id=f"h-{uid}", status="provisioned")
            for uid in answers
        ]

    async def fetch(self) -> list[OrphanCandidate]:
        return list(self.candidates)

    async def owner_exists(self, user_id: str):
        self.asked.append(user_id)
        answer = self.answers[user_id]
        if answer == "raise":
            raise RuntimeError("identity backend unreachable: token=secret")
        return answer

    async def erase(self, user_id: str) -> None:
        if user_id in self.erase_raises_for:
            raise RuntimeError("teardown failed for projects/their-project/services/x")
        self.erased.append(user_id)


async def _noop_list(*_a, **_k):
    return []


async def _never(*_a, **_k):
    raise AssertionError("must not be called")


def _worker(identity: Identity, clock: Clock, **kw) -> PersonalAgentReconcileWorker:
    return PersonalAgentReconcileWorker(
        fetch_stalled=_noop_list,
        retry=_never,
        fetch_idle=_noop_list,
        reap=_never,
        fetch_orphan_candidates=identity.fetch,
        owner_exists=identity.owner_exists,
        erase_orphan=identity.erase,
        clock=clock,
        **kw,
    )


def _run(w: PersonalAgentReconcileWorker):
    return asyncio.run(w.scan_and_reconcile())


# ---------------------------------------------------------------------------
# 1. unknown is never absent
# ---------------------------------------------------------------------------


def test_unknown_answer_erases_nothing_even_after_the_confirm_window():
    clock = Clock()
    identity = Identity({"u1": None})
    w = _worker(identity, clock, orphan_confirm_after=timedelta(0))

    report = _run(w)

    assert identity.erased == []
    assert report.orphans_erased_count == 0
    assert report.orphans_pending_count == 0


def test_a_raising_lookup_is_unknown_not_absent():
    clock = Clock()
    identity = Identity({"u1": "raise"})
    w = _worker(identity, clock, orphan_confirm_after=timedelta(0))

    report = _run(w)

    assert identity.erased == []
    assert report.orphans_erased_count == 0


def test_an_unknown_answer_forgets_an_earlier_absence():
    clock = Clock()
    identity = Identity({"u1": False})
    w = _worker(identity, clock)

    _run(w)  # first sighting: remembered
    assert "u1" in w._absent_first_seen

    identity.answers["u1"] = None
    _run(w)
    assert "u1" not in w._absent_first_seen

    # Back to absent: the clock restarts, so no erase yet even though the wall
    # clock has moved past the window since the FIRST sighting.
    identity.answers["u1"] = False
    clock.advance(timedelta(minutes=30))
    report = _run(w)
    assert identity.erased == []
    assert report.orphans_pending_count == 1


# ---------------------------------------------------------------------------
# 2. absence must persist across the confirm window
# ---------------------------------------------------------------------------


def test_first_absence_is_pending_and_a_confirmed_absence_is_erased():
    clock = Clock()
    identity = Identity({"u1": False, "u2": True})
    w = _worker(identity, clock)

    first = _run(w)
    assert identity.erased == []
    assert first.orphans_pending_count == 1
    assert first.orphans_erased_count == 0

    clock.advance(timedelta(minutes=9))
    second = _run(w)
    assert identity.erased == [], "nine minutes is inside the ten-minute window"
    assert second.orphans_pending_count == 1

    clock.advance(timedelta(minutes=1))
    third = _run(w)
    assert identity.erased == ["u1"]
    assert third.orphans_erased_count == 1
    assert third.orphans_pending_count == 0
    assert "u1" not in w._absent_first_seen


def test_an_owner_who_reappears_is_forgotten():
    clock = Clock()
    identity = Identity({"u1": False})
    w = _worker(identity, clock)
    _run(w)
    identity.answers["u1"] = True
    clock.advance(timedelta(hours=1))
    report = _run(w)
    assert identity.erased == []
    assert report.orphans_pending_count == 0
    assert w._absent_first_seen == {}


def test_a_row_that_disappears_drops_its_absence_clock():
    clock = Clock()
    identity = Identity({"u1": False})
    w = _worker(identity, clock)
    _run(w)
    assert "u1" in w._absent_first_seen
    identity.candidates = []
    _run(w)
    assert w._absent_first_seen == {}


# ---------------------------------------------------------------------------
# 3. mass absence refuses the pass
# ---------------------------------------------------------------------------


def test_mass_absence_refuses_the_whole_pass(caplog):
    clock = Clock()
    identity = Identity({"u1": False, "u2": False, "u3": False, "u4": True})
    w = _worker(identity, clock, orphan_confirm_after=timedelta(0))

    with caplog.at_level("ERROR"):
        report = _run(w)

    assert identity.erased == []
    assert report.orphans_erased_count == 0
    assert report.orphans_pending_count == 3
    assert any("orphan_sweep_refused" in r.getMessage() for r in caplog.records)


def test_two_orphans_in_a_small_fleet_are_still_erased():
    """The breaker needs a count AND a share; two of two is a real orphan pair."""
    clock = Clock()
    identity = Identity({"u1": False, "u2": False})
    w = _worker(identity, clock, orphan_confirm_after=timedelta(0))
    report = _run(w)
    assert sorted(identity.erased) == ["u1", "u2"]
    assert report.orphans_erased_count == 2


def test_three_orphans_in_a_large_fleet_are_erased():
    clock = Clock()
    answers: dict[str, object] = {f"p{i}": True for i in range(10)}
    answers.update({"o1": False, "o2": False, "o3": False})
    identity = Identity(answers)
    w = _worker(identity, clock, orphan_confirm_after=timedelta(0))
    report = _run(w)
    assert sorted(identity.erased) == ["o1", "o2", "o3"]
    assert report.orphans_erased_count == 3


# ---------------------------------------------------------------------------
# 4. structurally inert / bounded
# ---------------------------------------------------------------------------


def test_without_all_three_callables_the_sweep_never_asks():
    clock = Clock()
    identity = Identity({"u1": False})
    w = PersonalAgentReconcileWorker(
        fetch_stalled=_noop_list,
        retry=_never,
        fetch_idle=_noop_list,
        reap=_never,
        fetch_orphan_candidates=identity.fetch,
        owner_exists=identity.owner_exists,
        # no erase_orphan
        clock=clock,
        orphan_confirm_after=timedelta(0),
    )
    report = _run(w)
    assert identity.asked == []
    assert report.orphans_erased_count == 0


def test_a_pass_erases_at_most_the_batch(monkeypatch):
    monkeypatch.setattr(worker_module, "_ORPHAN_ERASE_BATCH", 2)
    clock = Clock()
    answers: dict[str, object] = {f"p{i}": True for i in range(20)}
    answers.update({"o1": False, "o2": False, "o3": False, "o4": False})
    identity = Identity(answers)
    w = _worker(identity, clock, orphan_confirm_after=timedelta(0))

    first = _run(w)
    assert first.orphans_erased_count == 2
    assert len(identity.erased) == 2

    # The two left over are erased on the next pass, not lost.
    identity.candidates = [c for c in identity.candidates if c.user_id not in identity.erased]
    second = _run(w)
    assert second.orphans_erased_count == 2
    assert sorted(identity.erased) == ["o1", "o2", "o3", "o4"]


def test_the_kill_switch_stops_the_sweep(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_RECONCILE_ENABLED", "0")
    clock = Clock()
    identity = Identity({"u1": False})
    w = _worker(identity, clock, orphan_confirm_after=timedelta(0))
    report = _run(w)
    assert report.skipped is True
    assert identity.asked == []


# ---------------------------------------------------------------------------
# 5. one failed erasure never stops the batch, and it is counted, redacted
# ---------------------------------------------------------------------------


def test_one_failed_erasure_is_counted_and_the_rest_proceed(caplog):
    clock = Clock()
    identity = Identity({"o1": False, "o2": False, "p1": True, "p2": True, "p3": True})
    identity.erase_raises_for = {"o1"}
    w = _worker(identity, clock, orphan_confirm_after=timedelta(0))

    with caplog.at_level("WARNING"):
        report = _run(w)

    assert identity.erased == ["o2"]
    assert report.orphans_erased_count == 1
    assert report.orphan_erase_failed_count == 1
    # The failed owner stays on the absence clock so the next pass retries it.
    assert "o1" in w._absent_first_seen
    joined = "\n".join(r.getMessage() for r in caplog.records)
    assert "orphan_erase_failed" in joined
    assert "their-project" not in joined, "a cloud error body must never name the person's project"


def test_summary_line_names_the_new_counts():
    clock = Clock()
    identity = Identity({"o1": False, "o2": False, "p1": True, "p2": True, "p3": True})
    w = _worker(identity, clock, orphan_confirm_after=timedelta(0))
    report = _run(w)
    line = report.summary()
    assert "2 orphans erased" in line
    assert "0 pending confirmation" in line
    assert report.total_scanned == 2
