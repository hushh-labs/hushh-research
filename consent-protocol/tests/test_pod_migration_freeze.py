"""The freeze is what makes the export's single-writer assumption true.

A commit-log export replays a chain and seals it. If a turn lands mid-export, the
sealed bundle is a photograph of a log that has since moved on -- and the head
comparison at the end would fail, correctly, after all the work. So the row is
frozen first, and `migrating` is read as a refusal by every writer path.

The interesting assertions here are the ones about what the freeze must NOT do:

* it must not stop the fleet cap from counting a migrating pod (a migration
  briefly holds two hosts, and under-counting a cost ceiling spends money);
* it must not let the liveness sweep judge a deliberate silence as a fault
  (which would wake a pod mid-export and bill a cold start for the privilege).

Those two pull in opposite directions on the same row, which is why one status
tuple could not answer both questions.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.personal_agent_registry_repo import (
    _ACTIVE_POD_STATUSES,
    _LIVENESS_CANDIDATE_STATUSES,
    _STALLED_POD_STATUSES,
    PersonalAgentRegistryRepo,
)


class _FakeResponse:
    def __init__(self, data):
        self.data = data


class _FakeTable:
    def __init__(self, store):
        self._store = store
        self._filters: dict = {}
        self._payload = None

    def update(self, data):
        self._payload = dict(data)
        return self

    def eq(self, column, value):
        self._filters[column] = value
        return self

    def execute(self):
        rows = self._store["rows"]
        matched = [r for r in rows if all(r.get(k) == v for k, v in self._filters.items())]
        for row in matched:
            row.update(self._payload)
        return _FakeResponse([dict(r) for r in matched])


class _FakeDb:
    def __init__(self, store):
        self._store = store

    def table(self, _name):
        return _FakeTable(self._store)


def _repo(rows):
    store = {"rows": [dict(r) for r in rows]}
    repo = PersonalAgentRegistryRepo()
    repo._db = lambda: _FakeDb(store)  # type: ignore[method-assign]
    repo._store = store  # type: ignore[attr-defined]
    return repo


# --------------------------------------------------------------------------- #
# Freezing
# --------------------------------------------------------------------------- #


async def test_a_provisioned_row_can_be_frozen():
    repo = _repo([{"user_id": "u1", "status": "provisioned"}])

    assert await repo.begin_migration("u1") is True
    assert repo._store["rows"][0]["status"] == "migrating"


@pytest.mark.parametrize(
    "status", ["provisioning", "connecting", "provisioning_failed", "needs_reinit", "migrating"]
)
async def test_only_a_provisioned_row_can_be_frozen(status: str):
    """A pod still standing up, already failed, or already migrating must not be
    frozen out from under whatever is happening to it. Zero rows matched is a
    "not ready to move", not a silent success."""
    repo = _repo([{"user_id": "u1", "status": status}])

    assert await repo.begin_migration("u1") is False
    assert repo._store["rows"][0]["status"] == status


async def test_the_freeze_changes_only_the_status():
    """Everything else on the row is still TRUE while the pod is frozen, and the
    rollback is a status write back. Clearing coordinates here would make the
    rollback a reconstruction instead."""
    repo = _repo(
        [
            {
                "user_id": "u1",
                "status": "provisioned",
                "hushh_id": "ha1_abc",
                "pod_pubkey": "key",
                "external_agent_id": "one-pod-ha1-abc",
                "user_cloud_project": None,
            }
        ]
    )

    await repo.begin_migration("u1")

    row = repo._store["rows"][0]
    assert row["hushh_id"] == "ha1_abc"
    assert row["pod_pubkey"] == "key"
    assert row["external_agent_id"] == "one-pod-ha1-abc"


# --------------------------------------------------------------------------- #
# Unfreezing -- the rollback for every pre-switch failure
# --------------------------------------------------------------------------- #


async def test_a_migrating_row_can_be_unfrozen_to_exactly_where_it_started():
    repo = _repo([{"user_id": "u1", "status": "migrating"}])

    assert await repo.end_migration("u1") is True
    assert repo._store["rows"][0]["status"] == "provisioned"


async def test_a_dead_job_cannot_unfreeze_a_row_a_newer_attempt_owns():
    """Conditional on still being `migrating`, so a task that died and was
    superseded cannot reach back and unfreeze a row that has since moved on."""
    repo = _repo([{"user_id": "u1", "status": "provisioned"}])

    assert await repo.end_migration("u1") is False
    assert repo._store["rows"][0]["status"] == "provisioned"


async def test_a_blank_user_id_touches_nothing():
    repo = _repo([{"user_id": "u1", "status": "provisioned"}])

    assert await repo.begin_migration("  ") is False
    assert await repo.end_migration("") is False
    assert repo._store["rows"][0]["status"] == "provisioned"


# --------------------------------------------------------------------------- #
# The two questions one tuple used to answer
# --------------------------------------------------------------------------- #


def test_a_migrating_pod_still_counts_against_the_fleet_cap():
    """A migration briefly holds TWO hosts. Not counting the row would let the
    cap under-count, and under-counting a cost ceiling spends money."""
    assert "migrating" in _ACTIVE_POD_STATUSES


def test_the_liveness_sweep_never_judges_a_frozen_pod():
    """A frozen pod is silent on purpose. Probing it would read a deliberate
    silence as a fault, wake the pod mid-export, and bill a cold start."""
    assert "migrating" not in _LIVENESS_CANDIDATE_STATUSES


def test_the_retry_sweep_never_re_provisions_a_migrating_pod():
    """Re-provisioning would replace the very pod being migrated FROM, while its
    log is being read."""
    assert "migrating" not in _STALLED_POD_STATUSES


def test_the_two_tuples_differ_only_where_they_have_to():
    """They answer different questions, but a gratuitous divergence would be a
    bug waiting to happen. The one status they disagree about is the one whose
    two answers genuinely conflict."""
    assert set(_ACTIVE_POD_STATUSES) - set(_LIVENESS_CANDIDATE_STATUSES) == {"migrating"}
    assert not set(_LIVENESS_CANDIDATE_STATUSES) - set(_ACTIVE_POD_STATUSES)


# --------------------------------------------------------------------------- #
# What a person is told
# --------------------------------------------------------------------------- #


def test_a_frozen_pod_says_it_is_moving_rather_than_starting_up():
    """ "Starting up" would be false, and it would invite a retry loop against a
    pod that is deliberately frozen."""
    from api.routes.one.pod_relay import _not_ready

    refusal = _not_ready("migrating")

    assert refusal.status_code == 409
    assert refusal.detail["code"] == "AGENT_MIGRATING"
    assert "moving to your cloud" in refusal.detail["message"]


def test_every_other_not_ready_state_is_unchanged():
    from api.routes.one.pod_relay import _not_ready

    refusal = _not_ready("connecting")

    assert refusal.detail["code"] == "AGENT_NOT_READY"
    assert refusal.detail["status"] == "connecting"
