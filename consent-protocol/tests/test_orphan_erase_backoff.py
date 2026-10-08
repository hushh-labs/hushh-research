"""A stuck orphan erasure backs off, frees its slot, and says why in a bounded code.

Two failure shapes had no terminal path: a reservation that was never hosted, and a
running owner agent that refuses the erasure fence. The sweep is right to refuse
both. What it must not do is retry them on every pass, hold one of the five erasure
slots each time, and log the same line every five minutes while the transport code
that would name the cause never reaches the log.

Hermetic: the worker takes injected callables and an injected clock; the
deprovision case fakes only the registry, the account guard and the fence.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.services import account_service
from hushh_mcp.services import personal_agent_provisioning_service as provisioning
from hushh_mcp.services import personal_agent_reconcile_worker as worker_module
from hushh_mcp.services.orphan_erase_backoff import (
    MAX_DELAY,
    bounded_code,
    bounded_reason,
    error_fields,
)
from hushh_mcp.services.personal_agent_reconcile_worker import (
    OrphanCandidate,
    PersonalAgentReconcileWorker,
)
from hushh_mcp.services.pod_migration_transport import PodMigrationTransportError

_T0 = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)
_SECRET = "the pod refused at projects/their-project/services/one-pod-x"


@pytest.fixture(autouse=True)
def _core_env(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")
    monkeypatch.setenv("PERSONAL_AGENT_RECONCILE_ENABLED", "1")


class _Clock:
    def __init__(self) -> None:
        self.at = _T0

    def __call__(self) -> datetime:
        return self.at


class _Fleet:
    """Owners that are all absent from the identity provider; some refuse erasure."""

    def __init__(self, absent: list[str], present: int = 20) -> None:
        self.answers: dict[str, bool] = {f"p{i}": True for i in range(present)}
        self.answers.update({uid: False for uid in absent})
        self.refusing: set[str] = set()
        self.attempts: list[str] = []
        self.erased: list[str] = []

    async def fetch(self) -> list[OrphanCandidate]:
        return [OrphanCandidate(u, f"h-{u}", "pending") for u in self.answers]

    async def owner_exists(self, user_id: str) -> bool:
        return self.answers[user_id]

    async def erase(self, user_id: str) -> None:
        self.attempts.append(user_id)
        if user_id in self.refusing:
            raise PodMigrationTransportError("POD_REFUSED_403", _SECRET)
        self.erased.append(user_id)
        del self.answers[user_id]


async def _none(*_a, **_k):
    return []


def _worker(fleet: _Fleet, clock: _Clock) -> PersonalAgentReconcileWorker:
    return PersonalAgentReconcileWorker(
        fetch_stalled=_none,
        retry=_none,
        fetch_idle=_none,
        reap=_none,
        fetch_orphan_candidates=fleet.fetch,
        owner_exists=fleet.owner_exists,
        erase_orphan=fleet.erase,
        orphan_confirm_after=timedelta(0),
        clock=clock,
    )


def _pass(w: PersonalAgentReconcileWorker, clock: _Clock, after: timedelta = timedelta(0)):
    clock.at = clock.at + after
    return asyncio.run(w.scan_and_reconcile())


def _blocked_lines(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if "orphan_erase_blocked" in r.getMessage()]


def test_a_refusing_owner_is_not_retried_every_pass(caplog):
    fleet = _Fleet(["stuck"])
    fleet.refusing = {"stuck"}
    clock = _Clock()
    w = _worker(fleet, clock)
    with caplog.at_level(logging.WARNING):
        _pass(w, clock)
        for _ in range(3):  # passes that all fall inside the first 5-minute step
            _pass(w, clock, timedelta(seconds=90))
    assert fleet.attempts == ["stuck"], "a backed-off owner must not be retried each pass"
    lines = _blocked_lines(caplog)
    assert len(lines) == 1, "one orphan_erase_blocked line per step, not per pass"
    assert "reason=POD_REFUSED_403" in lines[0]
    assert "retry_in_s=300" in lines[0]
    joined = "\n".join(r.getMessage() for r in caplog.records)
    assert "their-project" not in joined, "the message must never name the person's project"


def test_the_delay_doubles_to_a_six_hour_cap(caplog):
    fleet = _Fleet(["stuck"])
    fleet.refusing = {"stuck"}
    clock = _Clock()
    w = _worker(fleet, clock)
    with caplog.at_level(logging.WARNING):
        _pass(w, clock)
        for _ in range(9):
            _pass(w, clock, MAX_DELAY)  # always past the current step
    delays = [int(line.split("retry_in_s=")[1].split()[0]) for line in _blocked_lines(caplog)]
    assert delays[:7] == [300, 600, 1200, 2400, 4800, 9600, 19200]
    assert delays[7:] == [21600, 21600, 21600]


def test_owners_in_backoff_do_not_hold_batch_slots(monkeypatch):
    monkeypatch.setattr(worker_module, "_ORPHAN_ERASE_BATCH", 2)
    fleet = _Fleet(["s1", "s2", "o1", "o2"])
    fleet.refusing = {"s1", "s2"}
    clock = _Clock()
    w = _worker(fleet, clock)
    first = _pass(w, clock)
    assert first.orphan_erase_failed_count == 2 and fleet.erased == []
    second = _pass(w, clock, timedelta(seconds=60))
    assert second.orphans_erased_count == 2
    assert sorted(fleet.erased) == ["o1", "o2"], "stuck owners must yield their slots"


def test_success_and_reappearance_reset_the_backoff():
    fleet = _Fleet(["stuck", "back"])
    fleet.refusing = {"stuck", "back"}
    clock = _Clock()
    w = _worker(fleet, clock)
    _pass(w, clock)
    _pass(w, clock, timedelta(minutes=5))
    assert w._erase_backoff.attempts("stuck") == 2

    fleet.answers["back"] = True  # the identity came back
    fleet.refusing = set()
    _pass(w, clock, timedelta(minutes=10))
    assert w._erase_backoff.attempts("back") == 0
    assert w._erase_backoff.attempts("stuck") == 0, "a successful erasure clears the step"
    assert fleet.erased == ["stuck"]


def test_bounded_code_admits_only_the_transport_shape():
    assert bounded_code(PodMigrationTransportError("POD_UNREACHABLE", _SECRET)) == "POD_UNREACHABLE"
    for unsafe in ("pod_unreachable", "A" * 65, _SECRET, "POD REFUSED", ""):
        assert bounded_code(PodMigrationTransportError(unsafe, "m")) == ""
    weird = RuntimeError("m")
    weird.code = 403  # type: ignore[attr-defined]
    assert bounded_code(weird) == ""
    assert bounded_reason(RuntimeError(_SECRET)) == "RuntimeError"
    assert error_fields(RuntimeError(_SECRET)) == "error_type=RuntimeError"


class _ReservedRegistry:
    async def reserve_erasure(self, *, user_id: str) -> dict:
        return {"ownerId": user_id, "attemptId": "attempt-1"}


def test_deprovision_logs_the_transport_code_never_the_message(monkeypatch, caplog):
    def _refuse(self, user_id: str) -> None:
        raise account_service.PersonalAgentDeprovisioningRequiredError("resources remain")

    async def _not_owner_cloud(*_a, **_k) -> bool:
        return False

    async def _fence_refused(**_k):
        raise PodMigrationTransportError("POD_REFUSED_403", _SECRET)

    monkeypatch.setattr(
        account_service.AccountService, "assert_personal_agent_external_resources_absent", _refuse
    )
    # Neither the owner-access nor the never-hosted outcome applies: the chain decides.
    monkeypatch.setattr(provisioning.never_hosted, "erase_reserved_outside_chain", _not_owner_cloud)
    service = provisioning.PersonalAgentProvisioningService(
        registry=_ReservedRegistry(), grant=object()
    )
    monkeypatch.setattr(service, "_fence_reserved_erasure", _fence_refused)

    with caplog.at_level(logging.WARNING):
        with pytest.raises(account_service.PersonalAgentDeprovisioningRequiredError):
            asyncio.run(service.deprovision(user_id="owner-1"))

    lines = [
        r.getMessage() for r in caplog.records if "erasure_admission_unavailable" in r.getMessage()
    ]
    assert lines == [
        "personal_agent.erasure_admission_unavailable "
        "error_type=PodMigrationTransportError code=POD_REFUSED_403"
    ]
    assert "their-project" not in "\n".join(r.getMessage() for r in caplog.records)
