"""The standby placement store, on a real PostgreSQL under the registry's guard triggers.

Adding a standby, the sync lease, sync results and the due sweep (STANDBY-SYNC.md E8),
plus the structural no-decrypt assertion. Migrations 900-950 run verbatim
(``tests/standby_postgres_support.py``): a WHERE clause and a trigger can only be
proven by running them.
"""

from __future__ import annotations

import ast
from uuid import uuid4

import pytest

from hushh_mcp.services.personal_agent_standby_store import StandbyRefused
from tests import standby_postgres_support as support
from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.standby_postgres_support import (
    HEAD_A,
    HEAD_B,
    HUSHH_ID,
    OTHER,
    OTHER_HUSHH_ID,
    OWNER,
    PRIMARY_SIGNING,
    ROOT,
    added,
    claim,
    placement,
    registry_row,
    run,
    seed_primary,
    seed_standby,
    standby_row,
)

psycopg2 = pytest.importorskip("psycopg2")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")


@pytest.fixture(scope="module")
def server():
    yield from support.start_server()


@pytest.fixture
def pg(server):
    return support.reset(server)


@pytest.fixture
def store(pg):
    return support.store_for(pg)


# -- add / read / one per person ---------------------------------------------------------


def test_add_records_one_standby_and_latches_the_primary_to_signed(pg, store):
    seed_primary(pg)
    assert registry_row(pg)["identity_mode"] is None

    added = run(store.add_standby(OWNER, 0, placement()))

    assert added["hushh_id"] == HUSHH_ID and added["pod_key_id"] == "podk_standby"
    assert registry_row(pg)["identity_mode"] == "signed"
    read = run(store.read_standby(OWNER))
    assert read["placement_epoch"] == 0 and read["synced_seq"] == 0
    assert read["last_sync_status"] == "pending"


def test_a_person_has_at_most_one_standby(pg, store):
    seed_primary(pg)
    assert run(store.add_standby(OWNER, 0, placement()))
    second = placement(
        external_agent_id="ca-two", pod_key_id="podk_two", user_cloud_resource_group="rg-two"
    )
    assert run(store.add_standby(OWNER, 0, second)) is None
    assert pg.execute("SELECT count(*) FROM personal_agent_standby_placements") == [(1,)]
    with pytest.raises(Exception, match="duplicate key"):
        seed_standby(pg)


@pytest.mark.parametrize(
    ("setup", "epoch"),
    [
        ({}, 1),  # stale epoch
        ({"status": "needs_reinit"}, 0),  # only a provisioned primary takes a standby
        ({"metadata": {"erasure": {"attemptId": "x"}}}, 0),
        ({"metadata": {"provisionAttempt": {"phase": "reserved", "attemptId": "a" * 32}}}, 0),
        ({"signed": False}, 0),  # the primary cannot sign an epoch yet
    ],
)
def test_add_is_refused_for_a_primary_it_must_not_pair(pg, store, setup, epoch):
    seed_primary(pg, **setup)
    assert run(store.add_standby(OWNER, epoch, placement())) is None
    assert standby_row(pg) is None


def test_add_refuses_the_primary_s_own_keys_or_host_and_malformed_placements(pg, store):
    seed_primary(pg)
    public, kid = PRIMARY_SIGNING
    shared_key = placement(pod_signing_pubkey=public, pod_signing_key_id=kid)
    assert run(store.add_standby(OWNER, 0, shared_key)) is None
    assert run(store.add_standby(OWNER, 0, placement(external_agent_id=f"svc-{OWNER}"))) is None
    for bad in (
        placement(pod_signing_key_id="pods_" + "0" * 32),  # key id not derived from the key
        placement(url="http://plain.example"),
        placement(user_cloud_resource_group=None),
        placement(backend_metadata={"puppyAccess": {}}),
        placement(private_key="nope"),
    ):
        with pytest.raises(StandbyRefused):
            run(store.add_standby(OWNER, 0, bad))
    assert standby_row(pg) is None


# -- sync lease ----------------------------------------------------------------------


def test_the_sync_lease_is_exclusive_and_respects_the_cooldown(pg, store):
    observed = added(pg, store)
    first, second = uuid4().hex, uuid4().hex

    claimed = run(store.claim_sync_lease(OWNER, observed, first, 0))
    assert claimed["sync_lease_id"] == first and claimed["last_sync_attempt_at"] is not None
    assert run(store.claim_sync_lease(OWNER, observed, second, 0)) is None

    assert run(store.record_sync_result(OWNER, observed, first, None, None, "failed"))
    assert run(store.claim_sync_lease(OWNER, observed, second, 3600)) is None  # inside cooldown
    assert run(store.claim_sync_lease(OWNER, observed, second, 0))["sync_lease_id"] == second


def test_an_expired_lease_may_be_reclaimed(pg, store):
    observed = added(pg, store)
    held = uuid4().hex
    assert run(store.claim_sync_lease(OWNER, observed, held, 0))
    pg.execute(
        "UPDATE personal_agent_standby_placements SET sync_lease_at = now() - interval '16 minutes',"
        " last_sync_attempt_at = now() - interval '16 minutes'"
    )
    taken = run(store.claim_sync_lease(OWNER, observed, uuid4().hex, 600))
    assert taken is not None and taken["sync_lease_id"] != held
    # The old holder's result no longer lands: the lease, not elapsed time, owns it.
    assert run(store.record_sync_result(OWNER, observed, held, 1, HEAD_A, "synced")) is None


def test_the_lease_is_fenced_on_epoch_and_on_which_standby(pg, store):
    observed = added(pg, store)
    lease = uuid4().hex
    assert run(store.claim_sync_lease(OWNER, {**observed, "placement_epoch": 1}, lease, 0)) is None
    assert (
        run(store.claim_sync_lease(OWNER, {**observed, "pod_key_id": "podk_x"}, lease, 0)) is None
    )
    with pytest.raises(StandbyRefused):
        run(store.claim_sync_lease(OWNER, observed, "not-hex", 0))


# -- sync result -------------------------------------------------------------------


def test_a_sync_result_only_moves_forward(pg, store):
    observed = added(pg, store)
    lease = claim(store, observed)
    synced = run(store.record_sync_result(OWNER, observed, lease, 5, HEAD_A, "synced"))
    assert (synced["synced_seq"], synced["synced_head_sha"]) == (5, HEAD_A)
    assert synced["sync_lease_id"] is None and synced["last_sync_at"] is not None
    first_sync_at = synced["last_sync_at"]

    lease = claim(store, observed)
    assert run(store.record_sync_result(OWNER, observed, lease, 3, HEAD_B, "synced")) is None
    assert run(store.record_sync_result(OWNER, observed, lease, 5, HEAD_B, "synced")) is None
    assert standby_row(pg)["sync_lease_id"] == lease  # still held: the failure can be recorded
    failed = run(store.record_sync_result(OWNER, observed, lease, 9, HEAD_B, "failed"))
    assert (failed["synced_seq"], failed["synced_head_sha"]) == (5, HEAD_A)
    assert failed["last_sync_status"] == "failed" and failed["last_sync_at"] == first_sync_at

    lease = claim(store, observed)
    same = run(store.record_sync_result(OWNER, observed, lease, 5, HEAD_A, "synced"))
    assert same["synced_seq"] == 5 and same["last_sync_status"] == "synced"
    with pytest.raises(Exception, match="never moves backwards"):
        pg.execute(
            "UPDATE personal_agent_standby_placements SET synced_seq = 1, synced_head_sha = %s",
            (HEAD_B,),
        )


def test_a_sync_result_is_fenced_on_lease_and_epoch(pg, store):
    observed = added(pg, store)
    lease = claim(store, observed)
    assert run(store.record_sync_result(OWNER, observed, uuid4().hex, 1, HEAD_A, "synced")) is None
    stale = {**observed, "placement_epoch": 1}
    assert run(store.record_sync_result(OWNER, stale, lease, 1, HEAD_A, "synced")) is None
    for args in ((1, None, "synced"), (0, HEAD_A, "synced"), (1, HEAD_A, "done")):
        with pytest.raises(StandbyRefused):
            run(store.record_sync_result(OWNER, observed, lease, *args))
    assert standby_row(pg)["synced_seq"] == 0


def test_due_standbys_come_least_recently_attempted_first(pg, store):
    seed_primary(pg)
    seed_primary(pg, owner=OTHER, hushh_id=OTHER_HUSHH_ID, project="other-project")
    run(store.add_standby(OWNER, 0, placement()))
    other = placement(
        external_agent_id="ca-other", pod_key_id="podk_other", user_cloud_resource_group="rg-other"
    )
    run(store.add_standby(OTHER, 0, other))
    pg.execute(
        "UPDATE personal_agent_standby_placements SET last_sync_attempt_at = now() - interval '1 hour'"
        " WHERE user_id = %s",
        (OTHER,),
    )
    pg.execute(
        "UPDATE personal_agent_standby_placements SET last_sync_attempt_at = now() - interval '2 hours'"
        " WHERE user_id = %s",
        (OWNER,),
    )
    due = run(store.list_standbys_due("2999-01-01T00:00:00Z", 10))
    assert [row["user_id"] for row in due] == [OWNER, OTHER]
    assert all(row["placement_epoch"] == 0 for row in due)
    # Once synced, a standby is due only after its last sync; never synced is always due.
    observed = run(store.read_standby(OWNER))
    lease = claim(store, observed)
    assert run(store.record_sync_result(OWNER, observed, lease, 2, HEAD_A, "synced"))
    due = run(store.list_standbys_due("2000-01-01T00:00:00Z", 10))
    assert [row["user_id"] for row in due] == [OTHER]
    # A held lease takes a standby out of the sweep.
    assert run(store.claim_sync_lease(OTHER, run(store.read_standby(OTHER)), uuid4().hex, 0))
    assert run(store.list_standbys_due("2000-01-01T00:00:00Z", 10)) == []


# -- the hub cannot read what it records ---------------------------------------------


@pytest.mark.parametrize(
    "module",
    ["personal_agent_standby_store", "personal_agent_standby_sql", "pod_placement_fence"],
)
def test_the_standby_modules_have_no_decryption_path(module):
    """Structural, as for the migration transport: no decrypt import, no decrypt call."""
    source = (ROOT / "hushh_mcp/services" / f"{module}.py").read_text(encoding="utf-8")
    imported: set[str] = set()
    called: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.Call):
            name = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
            if name:
                called.add(name)
    forbidden = {"cryptography", "open_bundle", "pod_migration_bundle", "pod_commit_log"}
    assert not {n for n in imported if any(f in n for f in forbidden)}
    assert not (called & {"decrypt", "open_bundle", "unseal", "resolve_pod_log_key"})
