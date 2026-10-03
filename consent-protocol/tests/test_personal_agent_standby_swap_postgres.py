"""The standby switch, removal and account deletion, on a real PostgreSQL.

A swap is one statement fenced on the placement epoch and the observed standby's
key, and promotes only a standby that has completed a sync (E9); removal keeps
coordinates only (E10); account deletion refuses while a standby exists (E10).
Migrations 900-950 run verbatim (``tests/standby_postgres_support.py``).
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import personal_agent_standby_store as standby_store
from hushh_mcp.services.account_service import (
    AccountService,
    PersonalAgentDeprovisioningRequiredError,
)
from hushh_mcp.services.personal_agent_standby_store import StandbyRefused
from tests import standby_postgres_support as support
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin
from tests.standby_postgres_support import (
    HEAD_A,
    HUSHH_ID,
    OWNER,
    PRIMARY_SIGNING,
    Db,
    added,
    claim,
    direct_observed,
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


# -- swap ----------------------------------------------------------------------------


def test_the_swap_moves_the_whole_placement_and_bumps_the_epoch(pg, store):
    person = {"puppyAccess": {"d1": {"ok": True}}, "detachedPlacements": [{"reason": "old"}]}
    seed_primary(pg, metadata={**person, "observed": {"imageTag": "v1"}})
    run(store.add_standby(OWNER, 0, placement()))
    lease = claim(store, run(store.read_standby(OWNER)))
    run(store.record_sync_result(OWNER, run(store.read_standby(OWNER)), lease, 7, HEAD_A, "synced"))
    before_primary, before_standby = registry_row(pg), standby_row(pg)
    observed = run(store.read_standby(OWNER))

    swapped = run(store.swap_primary_and_standby(OWNER, observed))

    assert swapped == {"user_id": OWNER, "placement_epoch": 1}
    primary, standby = registry_row(pg), standby_row(pg)
    for field in ("deployment_target", "external_agent_id", "user_cloud_tenant_id",
                  "user_cloud_subscription_id", "user_cloud_resource_group", "user_cloud_region",
                  "model_credential_mode", "pod_pubkey", "pod_key_id", "pod_signing_pubkey",
                  "pod_signing_key_id", "runtime_version"):  # fmt: skip
        assert primary[field] == before_standby[field], field
        assert standby[field] == before_primary[field], field
    assert (
        primary["user_cloud_project"] is None and standby["user_cloud_project"] == "owner-project"
    )
    assert primary["backend_metadata"] == {
        "serviceUid": "azure-uid",
        "url": before_standby["url"],
        **person,
    }
    assert standby["url"] == "https://agent.example.test"
    assert standby["backend_metadata"] == {
        "serviceUid": "incarnation-1",
        "observed": {"imageTag": "v1"},
    }
    assert primary["status"] == "provisioned" and primary["identity_mode"] == "signed"
    assert primary["health_state"] == "unknown" and primary["last_heartbeat_at"] is None
    assert (standby["synced_seq"], standby["synced_head_sha"]) == (7, HEAD_A)
    assert standby["last_sync_status"] == "pending" and standby["sync_lease_id"] is None
    # Identity never moves.
    assert (primary["hushh_id"], primary["a2a_route"]) == (HUSHH_ID, before_primary["a2a_route"])

    # Epoch-fenced: the observation from before the switch cannot switch again.
    assert run(store.swap_primary_and_standby(OWNER, observed)) is None
    assert registry_row(pg)["placement_epoch"] == 1
    # And switching back restores the original placement, one epoch later.
    assert run(store.swap_primary_and_standby(OWNER, run(store.read_standby(OWNER)))) == {
        "user_id": OWNER,
        "placement_epoch": 2,
    }
    back = registry_row(pg)
    assert back["user_cloud_project"] == "owner-project" and back["pod_key_id"] == f"podk_{OWNER}"
    assert back["backend_metadata"] == before_primary["backend_metadata"]


def test_the_swap_accepts_a_needs_reinit_primary(pg, store):
    seed_primary(pg, status="needs_reinit")
    seed_standby(pg)
    assert run(store.swap_primary_and_standby(OWNER, direct_observed())) == {
        "user_id": OWNER,
        "placement_epoch": 1,
    }
    assert registry_row(pg)["status"] == "provisioned"


@pytest.mark.parametrize(
    "setup",
    [
        {"metadata": {"erasure": {"attemptId": "x"}}},
        {"metadata": {"upgradeLease": "2026-10-03T00:00:00|lease|image"}},
        {"metadata": {"provisionAttempt": {"phase": "reserved", "attemptId": "a" * 32}}},
        {"status": "migrating"},
    ],
)
def test_the_swap_refuses_during_erasure_upgrade_or_unfinished_provision(pg, store, setup):
    seed_primary(pg, **setup)
    seed_standby(pg)
    before = (registry_row(pg), standby_row(pg))
    assert run(store.swap_primary_and_standby(OWNER, direct_observed())) is None
    assert (registry_row(pg), standby_row(pg)) == before


def test_the_swap_needs_a_standby(pg, store):
    seed_primary(pg)
    before = registry_row(pg)
    assert run(store.swap_primary_and_standby(OWNER, direct_observed())) is None
    assert registry_row(pg) == before


def test_a_swap_planned_against_a_removed_standby_cannot_promote_its_replacement(pg, store):
    # Plan against standby A (synced to 7), then A is removed and B added. Neither moves
    # the epoch, so only the observed standby key tells the two apart.
    stale = added(pg, store)
    lease = claim(store, stale)
    run(store.record_sync_result(OWNER, stale, lease, 7, HEAD_A, "synced"))
    stale = run(store.read_standby(OWNER))
    assert run(store.remove_standby(OWNER, stale, "replaced"))
    replacement = placement(
        external_agent_id="ca-two", pod_key_id="podk_two", user_cloud_resource_group="rg-two"
    )
    assert run(store.add_standby(OWNER, 0, replacement))
    # Even once B has synced too, A's observation must not promote B.
    current = run(store.read_standby(OWNER))
    lease = claim(store, current)
    run(store.record_sync_result(OWNER, current, lease, 7, HEAD_A, "synced"))
    before = (registry_row(pg), standby_row(pg))

    assert run(store.swap_primary_and_standby(OWNER, stale)) is None
    assert (registry_row(pg), standby_row(pg)) == before
    assert registry_row(pg)["pod_key_id"] == f"podk_{OWNER}"


def test_a_never_synced_standby_is_never_promoted(pg, store):
    observed = added(pg, store)  # pending, synced_seq 0, no completed sync
    before = (registry_row(pg), standby_row(pg))
    assert run(store.swap_primary_and_standby(OWNER, observed)) is None
    assert (registry_row(pg), standby_row(pg)) == before
    # A failed attempt is not a completed sync either.
    lease = claim(store, observed)
    run(store.record_sync_result(OWNER, observed, lease, None, None, "failed"))
    assert run(store.swap_primary_and_standby(OWNER, observed)) is None
    assert registry_row(pg)["placement_epoch"] == 0


def test_the_swap_refuses_a_malformed_observation(pg, store):
    added(pg, store)
    for observed in (0, {"placement_epoch": 0}, {"placement_epoch": -1, "pod_key_id": "k"}):
        with pytest.raises(StandbyRefused):
            run(store.swap_primary_and_standby(OWNER, observed))


# -- remove (E10) --------------------------------------------------------------------


def test_remove_keeps_coordinates_only(pg, store):
    observed = added(pg, store)
    removed = run(store.remove_standby(OWNER, observed, "no longer wanted"))
    assert removed == {"user_id": OWNER, "detached_count": 1}
    assert standby_row(pg) is None
    [snapshot] = registry_row(pg)["backend_metadata"]["detachedPlacements"]
    assert snapshot["role"] == "standby" and snapshot["reason"] == "no longer wanted"
    assert snapshot["user_cloud_resource_group"] == "rg-one" and snapshot["url"].startswith("https")
    assert set(snapshot) <= set(standby_store.DETACHED_COORDINATES) | {
        "role",
        "reason",
        "detachedAt",
    }
    assert not any("key" in field or "pubkey" in field for field in snapshot)
    # The primary itself is untouched.
    assert registry_row(pg)["pod_signing_key_id"] == PRIMARY_SIGNING[1]


def test_remove_is_fenced_and_refused_during_erasure(pg, store):
    observed = added(pg, store)
    assert run(store.remove_standby(OWNER, {**observed, "placement_epoch": 3}, "r")) is None
    assert run(store.remove_standby(OWNER, {**observed, "pod_key_id": "podk_x"}, "r")) is None
    with pytest.raises(StandbyRefused):
        run(store.remove_standby(OWNER, observed, "  "))
    assert standby_row(pg) is not None

    pg.execute("TRUNCATE personal_agent_standby_placements, personal_agent_registry CASCADE")
    seed_primary(pg, metadata={"erasure": {"attemptId": "x"}})
    seed_standby(pg)
    assert run(store.remove_standby(OWNER, run(store.read_standby(OWNER)), "r")) is None
    assert standby_row(pg) is not None


def test_the_registry_row_cannot_be_deleted_out_from_under_a_standby(pg, store):
    added(pg, store)
    with pytest.raises(Exception, match="foreign key"):
        pg.execute("DELETE FROM personal_agent_registry WHERE user_id = %s", (OWNER,))


# -- account deletion (E10) ----------------------------------------------------------


def _deletion_guard(pg: TempPostgres) -> None:
    from sqlalchemy import text

    engine = Db(pg).engine
    with engine.begin() as conn:
        conn.execute(text("SELECT 1"))
        AccountService()._assert_personal_agent_external_resources_absent(
            conn, params={"user_id": OWNER}
        )


def test_account_deletion_refuses_while_a_standby_exists(pg):
    # A primary that reads as demonstrably unprovisioned on its own...
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status) VALUES (%s,%s,'unprovisioned')",
        (OWNER, HUSHH_ID),
    )
    _deletion_guard(pg)  # ...passes the external-resource check today,
    seed_standby(pg)
    with pytest.raises(PersonalAgentDeprovisioningRequiredError):
        _deletion_guard(pg)  # and is refused while its standby still exists.
