"""Per-process Drive unit budgets on a fake clock; no provider calls."""

import pytest

from hushh_mcp.services import drive_provider_pacing as pacing_module
from hushh_mcp.services.drive_provider_pacing import (
    MAX_DEFER_SECONDS,
    UNIT_COSTS,
    DrivePacing,
    bounded_wait,
    current_owner,
    owner_scope,
)


class Clock:
    def __init__(self, now=10_000.0):
        self.now = now

    def __call__(self):
        return self.now


def pacing(clock, **limits):
    return DrivePacing(clock=clock, enforce=lambda: True, **limits)


def test_google_unit_costs_and_process_share():
    # guides/limits: list 100, read 5, download 200; changes and drives as a list.
    assert UNIT_COSTS["list"] == 100 and UNIT_COSTS["metadata"] == 5
    assert UNIT_COSTS["content"] == UNIT_COSTS["export"] == 200
    assert UNIT_COSTS["changes"] == UNIT_COSTS["list_drives"] == 100
    default = DrivePacing(enforce=lambda: True)
    assert default._user_limit == 162_500 and default._project_limit == 500_000


def test_owner_budget_defers_until_the_oldest_units_leave_the_minute():
    clock = Clock()
    gate = pacing(clock, user_units_per_minute=300)
    assert gate.admit("owner", "list") is None
    clock.now += 10
    assert gate.admit("owner", "list") is None
    assert gate.admit("owner", "list") is None
    # 300 units spent; the next list waits until the first second (t+0) expires.
    wait = gate.admit("owner", "list")
    assert wait == pytest.approx(50.0)
    assert gate.spent("owner") == 300  # a deferral charges nothing
    clock.now += 50
    assert gate.admit("owner", "list") is None
    assert gate.spent("owner") == 300


def test_cheap_reads_still_fit_when_a_list_does_not():
    clock = Clock()
    gate = pacing(clock, user_units_per_minute=200)
    assert gate.admit("owner", "list") is None
    assert gate.admit("owner", "list") is None
    assert gate.admit("owner", "list") is not None
    gate_reads = pacing(clock, user_units_per_minute=105)
    assert gate_reads.admit("owner", "list") is None
    assert gate_reads.admit("owner", "metadata") is None
    assert gate_reads.admit("owner", "metadata") is not None


def test_owners_are_isolated_but_share_the_project_budget():
    clock = Clock()
    gate = pacing(clock, user_units_per_minute=200, project_units_per_minute=300)
    assert gate.admit("owner-a", "list") is None
    assert gate.admit("owner-a", "list") is None
    assert gate.admit("owner-a", "list") is not None
    # Negative control: another owner has its own budget...
    assert gate.admit("owner-b", "list") is None
    # ...until the project budget is spent, which defers every owner.
    assert gate.admit("owner-c", "list") is not None
    assert gate.admit(None, "metadata") is not None
    assert gate.spent() == 300


def test_deferral_is_bounded_between_one_and_sixty_four_seconds():
    clock = Clock(10_000.9)
    gate = pacing(clock, user_units_per_minute=100)
    assert gate.admit("owner", "list") is None
    clock.now = 10_059.95
    assert gate.admit("owner", "list") == 1.0  # never a busy loop
    huge = pacing(Clock(), user_units_per_minute=10)
    assert huge.admit("owner", "list") == 60.0  # cost above the whole budget
    assert huge.admit("owner", "list") <= MAX_DEFER_SECONDS


def test_outside_the_worker_admission_is_a_no_op(monkeypatch):
    clock = Clock()
    gate = DrivePacing(clock=clock, user_units_per_minute=100)
    monkeypatch.delenv("DRIVE_WORKER_MODE", raising=False)
    assert all(gate.admit("owner", "list") is None for _ in range(5))
    assert gate.spent("owner") == 0 and gate.spent() == 0
    # Negative control: the same gate in the worker charges and then defers.
    monkeypatch.setenv("DRIVE_WORKER_MODE", "true")
    assert gate.admit("owner", "list") is None
    assert gate.admit("owner", "list") is not None
    assert gate.spent("owner") == 100


def test_owner_lru_is_bounded_and_scope_is_task_local():
    gate = pacing(Clock(), max_owners=2)
    for owner in ("a", "b", "c"):
        gate.admit(owner, "list")
    assert list(gate._owners) == ["b", "c"]
    assert current_owner() is None
    with owner_scope("owner"):
        assert current_owner() == "owner"
        with owner_scope(""):
            assert current_owner() is None
        assert current_owner() == "owner"
    assert current_owner() is None


@pytest.mark.parametrize(
    "value,expected",
    [(5, 5.0), (0.5, 0.5), (-3, 0.0), (999, 64.0), (True, None), ("5", None), (float("nan"), None)],
)
def test_bounded_wait(value, expected):
    assert bounded_wait(value) == expected


def test_process_singleton_exists_and_resets():
    pacing_module.PACING.admit("someone", "metadata")
    pacing_module.PACING.reset()
    assert pacing_module.PACING.spent() == 0
