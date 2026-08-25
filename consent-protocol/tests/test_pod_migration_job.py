"""The migration ticket: one writer, honest staleness, person-language stages.

Two tabs racing a migration is the failure this ticket's guarded writes prevent,
and it matters more here than it does for cloud setup: two interleaved migration
tasks could export from a pod one of them has already reaped.

Also asserted: the stage order IS the safety argument. Every step is placed so
the failure before it is survivable, and a reordering that put the switch before
the verify -- or the reap before the switch -- would break that without breaking
anything a test would otherwise notice.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.services.pod_migration_service import (
    JOB_STAGES,
    STALE_AFTER_SECONDS,
    MigrationJobSuperseded,
    PodMigrationJobRepo,
    is_stale,
    new_job_id,
    person_facing_stage,
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

    def select(self, *_columns):
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
        return _FakeResponse([dict(r) for r in matched])


class _FakeDb:
    def __init__(self, store):
        self._store = store

    def table(self, _name):
        return _FakeTable(self._store)


@pytest.fixture
def repo():
    store = {"rows": []}
    instance = PodMigrationJobRepo(client=_FakeDb(store))
    instance._store = store  # type: ignore[attr-defined]
    return instance


# --------------------------------------------------------------------------- #
# The ticket
# --------------------------------------------------------------------------- #


async def test_a_job_records_where_it_is_going(repo):
    job_id = new_job_id()
    await repo.start(
        user_id="u1",
        job_id=job_id,
        hushh_id="ha1_abc",
        target_project="their-own-project",
        target_region="us-central1",
    )

    row = await repo.get("u1")
    assert row["job_id"] == job_id
    assert row["hushh_id"] == "ha1_abc"
    assert row["target_project"] == "their-own-project"
    assert row["status"] == "running"
    # Both proofs start empty. A job that began life with a head sha could
    # "verify" against a value nobody measured.
    assert row["source_head_sha"] is None
    assert row["target_head_sha"] is None


async def test_a_superseded_task_cannot_write(repo):
    """Two tabs racing. The loser must stop, not interleave.

    Worse here than in cloud setup: two live migration tasks could have one
    exporting from a pod the other has already torn down.
    """
    first = new_job_id()
    await repo.start(user_id="u1", job_id=first, hushh_id="ha1", target_project="p")
    await repo.advance(user_id="u1", job_id=first, stage="freezing")

    second = new_job_id()
    await repo.start(user_id="u1", job_id=second, hushh_id="ha1", target_project="p")

    with pytest.raises(MigrationJobSuperseded):
        await repo.advance(user_id="u1", job_id=first, stage="exporting")
    with pytest.raises(MigrationJobSuperseded):
        await repo.finish(user_id="u1", job_id=first, status="succeeded")
    with pytest.raises(MigrationJobSuperseded):
        await repo.record_source_receipt(
            user_id="u1", job_id=first, head_sha="deadbeef", record_count=3
        )

    row = await repo.get("u1")
    assert row["job_id"] == second
    assert row["stage"] == "starting"


async def test_stages_accumulate_in_order(repo):
    job_id = new_job_id()
    await repo.start(user_id="u1", job_id=job_id, hushh_id="ha1", target_project="p")
    for stage in ("freezing", "preparing_cloud", "exporting"):
        await repo.advance(user_id="u1", job_id=job_id, stage=stage)

    row = await repo.get("u1")
    assert [entry["stage"] for entry in row["stages"]] == [
        "freezing",
        "preparing_cloud",
        "exporting",
    ]
    assert row["stage"] == "exporting"


async def test_both_receipts_are_recorded_separately(repo):
    """The two heads are recorded by the two sides that measured them.

    Recording one number from one side would let a single compromised or buggy
    end certify its own success, which is what an independent comparison exists
    to prevent.
    """
    job_id = new_job_id()
    await repo.start(user_id="u1", job_id=job_id, hushh_id="ha1", target_project="p")

    await repo.record_source_receipt(user_id="u1", job_id=job_id, head_sha="aaa", record_count=4)
    await repo.record_target_receipt(user_id="u1", job_id=job_id, head_sha="aaa", record_count=4)

    row = await repo.get("u1")
    assert row["source_head_sha"] == "aaa"
    assert row["target_head_sha"] == "aaa"
    assert row["source_record_count"] == 4
    assert row["target_record_count"] == 4


async def test_a_failure_is_typed_and_readable(repo):
    job_id = new_job_id()
    await repo.start(user_id="u1", job_id=job_id, hushh_id="ha1", target_project="p")
    await repo.finish(
        user_id="u1",
        job_id=job_id,
        status="failed",
        error_code="HEAD_MISMATCH",
        error_message="the rebuilt chain head does not match the source",
    )

    row = await repo.get("u1")
    assert row["status"] == "failed"
    assert row["error_code"] == "HEAD_MISMATCH"
    assert "does not match" in row["error_message"]


# --------------------------------------------------------------------------- #
# The stage order IS the safety argument
# --------------------------------------------------------------------------- #


def test_verification_precedes_the_switch():
    """A bad move must be a move that did not happen.

    Switching before verifying would put a person onto a pod with a different
    history than the one they had, and nothing downstream would notice.
    """
    assert JOB_STAGES.index("verifying") < JOB_STAGES.index("switching_over")


def test_the_old_host_is_reaped_only_after_the_switch():
    """The row must never point at a host that has been torn down."""
    assert JOB_STAGES.index("switching_over") < JOB_STAGES.index("cleaning_up")


def test_the_freeze_precedes_the_export():
    """The export's single-writer assumption is what the freeze makes true."""
    assert JOB_STAGES.index("freezing") < JOB_STAGES.index("exporting")


def test_the_destination_exists_before_anything_is_exported():
    """An export that sits waiting for a pod to boot is a sealed bundle with
    nowhere to go and a frozen agent behind it."""
    assert JOB_STAGES.index("creating_pod") < JOB_STAGES.index("exporting")
    assert JOB_STAGES.index("collecting_target_key") < JOB_STAGES.index("exporting")


# --------------------------------------------------------------------------- #
# Staleness is reported, not hidden
# --------------------------------------------------------------------------- #


def test_a_stalled_job_is_reported_as_stale():
    stalled = {
        "status": "running",
        "updated_at": (
            datetime.now(timezone.utc) - timedelta(seconds=STALE_AFTER_SECONDS + 60)
        ).isoformat(),
    }
    assert is_stale(stalled) is True


def test_a_recently_advanced_job_is_not_stale():
    fresh = {"status": "running", "updated_at": datetime.now(timezone.utc).isoformat()}
    assert is_stale(fresh) is False


def test_a_finished_job_is_never_stale():
    """Staleness is a statement about a job that stopped advancing while claiming
    to run. A finished job stopped advancing on purpose."""
    done = {
        "status": "succeeded",
        "updated_at": (datetime.now(timezone.utc) - timedelta(days=7)).isoformat(),
    }
    assert is_stale(done) is False


def test_the_stale_window_is_longer_than_a_cloud_setup():
    """Two provisions and a chain replay legitimately take longer than one
    project creation, and calling a live migration dead is worse than waiting."""
    from hushh_mcp.services.byoc_setup_job_service import STALE_AFTER_SECONDS as SETUP_WINDOW

    assert STALE_AFTER_SECONDS > SETUP_WINDOW


# --------------------------------------------------------------------------- #
# What a person is told
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("stage", JOB_STAGES)
def test_every_stage_has_person_language(stage: str):
    """No machine stage may reach a person untranslated. A checklist that says
    "collecting_target_key" is a log line someone accidentally shipped."""
    said = person_facing_stage(stage)
    assert said
    assert "_" not in said
    assert said != "Working", f"{stage} has no person-facing sentence"


def test_the_three_transport_stages_are_one_sentence():
    """Export, transfer and import are one thing to a person: their agent's
    memory is moving. Splitting it invites "which one is the risky one", whose
    honest answer is "none, that is what the verify step is for"."""
    said = {person_facing_stage(s) for s in ("exporting", "transferring", "importing")}
    assert len(said) == 1
