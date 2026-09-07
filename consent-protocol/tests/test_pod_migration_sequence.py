"""The chain's ORDER and its ROLLBACK, exercised without a cloud.

The risky part of a migration is not any single step -- each of those has its own
tests -- it is the sequence, and specifically what happens when a step in the
middle fails. Those paths are the ones that would otherwise only ever run for the
first time on a real person's agent, in two real projects, which is the most
expensive place to discover that a failure left a pod frozen forever.

So the steps are injected, and these tests drive the sequencer through every
failure position. The property asserted throughout is the one the whole design
rests on:

    Before the switch, the source is untouched and the worst outcome is a
    migration that did not happen.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.pod_migration_service import (
    MigrationJobSuperseded,
    PodMigrationJobRepo,
    new_job_id,
    run_migration,
)


class _FakeResponse:
    def __init__(self, data):
        self.data = data


class _FakeTable:
    def __init__(self, store):
        self._store = store
        self._filters: dict = {}
        self._op = None
        self._payload = None

    def select(self, *_c):
        self._op = "select"
        return self

    def insert(self, row):
        self._op = "insert"
        self._payload = dict(row)
        return self

    def update(self, data):
        self._op = "update"
        self._payload = dict(data)
        return self

    def eq(self, column, value):
        self._filters[column] = value
        return self

    def limit(self, _n):
        return self

    def execute(self):
        rows = self._store["rows"]
        if self._op == "insert":
            rows.append(dict(self._payload))
            return _FakeResponse([dict(self._payload)])
        matched = [r for r in rows if all(r.get(k) == v for k, v in self._filters.items())]
        if self._op == "update":
            for row in matched:
                row.update(self._payload)
        return _FakeResponse([dict(r) for r in matched])


class _FakeDb:
    def __init__(self, store):
        self._store = store

    def table(self, _name):
        return _FakeTable(self._store)


class _Steps:
    """Every outside call the chain makes, recorded, with a failure injectable
    at any named position."""

    def __init__(self, *, fail_at: str | None = None, can_freeze: bool = True):
        self.calls: list[str] = []
        self.fail_at = fail_at
        self.can_freeze = can_freeze
        self.source_head = "head-abc"
        self.target_head = "head-abc"
        self.source_count = 3
        self.target_count = 3

    def _maybe_fail(self, name: str) -> None:
        self.calls.append(name)
        if self.fail_at == name:
            raise RuntimeError(f"injected failure at {name}")

    async def freeze(self) -> bool:
        self._maybe_fail("freeze")
        return self.can_freeze

    async def unfreeze(self) -> None:
        self.calls.append("unfreeze")

    async def prepare_destination(self) -> None:
        self._maybe_fail("prepare_destination")

    async def create_destination(self) -> str:
        self._maybe_fail("create_destination")
        return "https://one-pod-dst.run.app"

    async def collect_destination_key(self):
        self._maybe_fail("collect_destination_key")
        return ("public-key", "key-id")

    async def export_source(self, public_key: str, key_id: str):
        self._maybe_fail("export_source")
        return {
            "bundle": {"ciphertext": "..."},
            "headSha": self.source_head,
            "recordCount": self.source_count,
        }

    async def import_destination(self, bundle):
        self._maybe_fail("import_destination")
        return {"headSha": self.target_head, "recordCount": self.target_count}

    async def switch_over(self, destination_url: str) -> None:
        self._maybe_fail("switch_over")

    async def reap_source(self) -> None:
        self._maybe_fail("reap_source")

    async def rollback_destination(self) -> None:
        self.calls.append("rollback_destination")


@pytest.fixture
def repo():
    store = {"rows": []}
    instance = PodMigrationJobRepo(client=_FakeDb(store))
    instance._store = store  # type: ignore[attr-defined]
    return instance


async def _run(repo, steps):
    job_id = new_job_id()
    await repo.start(user_id="u1", job_id=job_id, hushh_id="ha1_abc", target_project="theirs")
    status = await run_migration(user_id="u1", job_id=job_id, steps=steps, repo=repo)
    return status, await repo.get("u1")


# --------------------------------------------------------------------------- #
# The happy path
# --------------------------------------------------------------------------- #


async def test_a_verified_move_switches_and_reaps_in_that_order(repo):
    steps = _Steps()

    status, row = await _run(repo, steps)

    assert status == "succeeded"
    assert row["status"] == "succeeded"
    assert steps.calls.index("switch_over") < steps.calls.index("reap_source")
    assert steps.calls.index("import_destination") < steps.calls.index("switch_over")
    assert "unfreeze" not in steps.calls, "a successful move must not unfreeze a switched row"
    assert row["source_head_sha"] == row["target_head_sha"] == "head-abc"


async def test_the_destination_is_built_before_anything_is_exported(repo):
    steps = _Steps()
    await _run(repo, steps)

    assert steps.calls.index("create_destination") < steps.calls.index("export_source")
    assert steps.calls.index("collect_destination_key") < steps.calls.index("export_source")


# --------------------------------------------------------------------------- #
# Refusing to start
# --------------------------------------------------------------------------- #


async def test_a_row_that_cannot_be_frozen_stops_immediately(repo):
    """The freeze is conditional on the row being `provisioned`, so it both takes
    the lock and answers "is this agent even in a state to be moved"."""
    steps = _Steps(can_freeze=False)

    status, row = await _run(repo, steps)

    assert status == "failed"
    assert row["error_code"] == "NOT_READY_TO_MOVE"
    # Nothing was frozen, so nothing may be unfrozen -- unfreezing here would
    # write over a row this job never owned.
    assert "unfreeze" not in steps.calls
    assert "create_destination" not in steps.calls


# --------------------------------------------------------------------------- #
# Every pre-switch failure is survivable
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "position",
    [
        "prepare_destination",
        "create_destination",
        "collect_destination_key",
        "export_source",
        "import_destination",
    ],
)
async def test_a_failure_before_the_switch_unfreezes_and_tears_down(repo, position: str):
    """The property the whole design rests on: before the switch, the worst
    outcome is a migration that did not happen."""
    steps = _Steps(fail_at=position)

    status, row = await _run(repo, steps)

    assert status == "failed"
    assert "unfreeze" in steps.calls, f"a failure at {position} left the agent frozen"
    assert "rollback_destination" in steps.calls
    assert "switch_over" not in steps.calls
    assert "reap_source" not in steps.calls, "the source was reaped after a failed move"
    assert row["error_code"] == "MIGRATION_FAILED"


async def test_the_rollback_runs_even_if_the_teardown_itself_fails(repo):
    """Unfreezing matters more than tidying. A person whose move failed must get
    their agent back even when the half-built destination cannot be removed."""

    class _StubbornSteps(_Steps):
        async def rollback_destination(self) -> None:
            self.calls.append("rollback_destination")
            raise RuntimeError("the destination could not be torn down")

    steps = _StubbornSteps(fail_at="export_source")

    status, _row = await _run(repo, steps)

    assert status == "failed"
    assert "unfreeze" in steps.calls, "a failed teardown swallowed the unfreeze"


# --------------------------------------------------------------------------- #
# The gate
# --------------------------------------------------------------------------- #


async def test_a_head_mismatch_refuses_the_switch(repo):
    """The zero-loss oracle doing its job. A move that cannot be proved is a
    move that does not happen."""
    steps = _Steps()
    steps.target_head = "a-different-head"

    status, row = await _run(repo, steps)

    assert status == "failed"
    assert row["error_code"] == "HEAD_MISMATCH"
    assert "switch_over" not in steps.calls
    assert "unfreeze" in steps.calls
    # Both measurements are still recorded, so an operator can see WHAT
    # disagreed rather than only that something did.
    assert row["source_head_sha"] == "head-abc"
    assert row["target_head_sha"] == "a-different-head"


async def test_a_count_disagreement_refuses_the_switch(repo):
    """Equal heads already imply equal counts, so a disagreement means one end
    is reporting something other than what it did. Worth refusing loudly rather
    than trusting the hash and moving on."""
    steps = _Steps()
    steps.target_count = 2

    status, row = await _run(repo, steps)

    assert status == "failed"
    assert row["error_code"] == "COUNT_MISMATCH"
    assert "switch_over" not in steps.calls


async def test_a_failed_switch_still_puts_the_agent_back(repo):
    steps = _Steps(fail_at="switch_over")

    status, row = await _run(repo, steps)

    assert status == "failed"
    assert row["error_code"] == "SWITCH_FAILED"
    assert "unfreeze" in steps.calls
    assert "reap_source" not in steps.calls


# --------------------------------------------------------------------------- #
# After the switch, only cleanup can fail -- and it is not fatal
# --------------------------------------------------------------------------- #


async def test_a_stranded_old_host_does_not_fail_the_move(repo):
    """The person's agent is already live and verified in their own cloud. A
    host we could not tear down is an operational cost; telling them their move
    failed because of it would be false."""
    steps = _Steps(fail_at="reap_source")

    status, row = await _run(repo, steps)

    assert status == "succeeded"
    assert row["status"] == "succeeded"
    assert "unfreeze" not in steps.calls


# --------------------------------------------------------------------------- #
# A superseded job gets out of the way
# --------------------------------------------------------------------------- #


async def test_a_superseded_job_stops_without_unfreezing(repo):
    """Unfreezing here would unfreeze a migration that is currently running --
    the newer one -- and hand a live export a pod that starts taking turns."""
    steps = _Steps()
    first = new_job_id()
    await repo.start(user_id="u1", job_id=first, hushh_id="ha1_abc", target_project="theirs")
    # A second attempt takes the row while the first is mid-flight.
    await repo.start(user_id="u1", job_id=new_job_id(), hushh_id="ha1_abc", target_project="theirs")

    with pytest.raises(MigrationJobSuperseded):
        await run_migration(user_id="u1", job_id=first, steps=steps, repo=repo)

    assert "unfreeze" not in steps.calls


async def test_a_failed_unfreeze_still_records_what_went_wrong(repo):
    """The worst version of a bad day, and the one that must still speak.

    An earlier version let a failed teardown escape `run_migration`, so the typed
    failure was never recorded and the ticket sat at `running` until it went
    stale. The one situation where a person most needs to be told what happened
    was the one where nothing told them.
    """

    class _AllBroken(_Steps):
        async def unfreeze(self) -> None:
            self.calls.append("unfreeze")
            raise RuntimeError("the row could not be unfrozen")

        async def rollback_destination(self) -> None:
            self.calls.append("rollback_destination")
            raise RuntimeError("the destination could not be torn down")

    steps = _AllBroken(fail_at="import_destination")

    status, row = await _run(repo, steps)

    assert status == "failed"
    assert row["status"] == "failed", "the ticket was left claiming to be running"
    assert row["error_code"] == "MIGRATION_FAILED"
    # Both recovery attempts were made even though both failed.
    assert "unfreeze" in steps.calls
    assert "rollback_destination" in steps.calls


async def test_the_agent_is_unfrozen_before_the_teardown_is_attempted(repo):
    """Order within the recovery: giving the person their agent back is more
    urgent than removing a half-built pod nobody is using."""
    steps = _Steps(fail_at="export_source")

    await _run(repo, steps)

    assert steps.calls.index("unfreeze") < steps.calls.index("rollback_destination")
