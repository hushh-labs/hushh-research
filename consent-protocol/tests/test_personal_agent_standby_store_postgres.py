"""The standby placement store, on a real PostgreSQL under the registry's guard triggers.

Migrations 900-950 are applied verbatim (provision admission 917, the erasure guard
chain, the signing-key trigger 947, Azure coordinates 948, and 950 itself), because a
WHERE clause, a deferred constraint trigger and a one-statement swap can only be
proven by running them. Design: docs/future/personal-agent/STANDBY-SYNC.md (E8-E10).
"""

from __future__ import annotations

import ast
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from hushh_mcp.services import personal_agent_standby_store as standby_store
from hushh_mcp.services.account_service import (
    AccountService,
    PersonalAgentDeprovisioningRequiredError,
)
from hushh_mcp.services.personal_agent_standby_store import (
    PersonalAgentStandbyStore,
    StandbyRefused,
)
from hushh_mcp.services.pod_request_signing import public_key_b64, signing_key_id
from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin

psycopg2 = pytest.importorskip("psycopg2")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")

ROOT = Path(__file__).resolve().parents[1]
PARKED = ROOT / "db/migrations/parked"
OWNER = "synthetic-owner"
HUSHH_ID = "ha1_abcdefghijklmnopqrstuvwxyz234567"
OTHER = "synthetic-other"
OTHER_HUSHH_ID = "ha1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
TENANT = "11111111-2222-3333-4444-555555555555"
SUBSCRIPTION = "66666666-7777-8888-9999-000000000000"
HEAD_A = "a" * 64
HEAD_B = "b" * 64


def _signing(seed: int) -> tuple[str, str]:
    public = public_key_b64(Ed25519PrivateKey.from_private_bytes(bytes([seed]) * 32))
    return public, signing_key_id(public)


PRIMARY_SIGNING = _signing(1)
STANDBY_SIGNING = _signing(2)


class _Db:
    """The ``execute_raw`` surface of the app's DB client, over the temp server."""

    def __init__(self, server: TempPostgres) -> None:
        from sqlalchemy import create_engine

        self.engine = create_engine(
            f"postgresql+psycopg2://hushh@/postgres?host={server.dir}&port={server.port}"
        )

    def execute_raw(self, sql: str, params: dict) -> SimpleNamespace:
        from sqlalchemy import text

        with self.engine.begin() as conn:
            result = conn.execute(text(sql), params)
            rows = [dict(row._mapping) for row in result] if result.returns_rows else []
        return SimpleNamespace(data=rows)


@pytest.fixture(scope="module")
def server():
    old = postgres_harness.MIGRATIONS
    postgres_harness.MIGRATIONS = []
    pg = TempPostgres()
    try:
        pg.start()
        schema = (ROOT / "db/legacy/init_legacy_schema.sql").read_text()
        table = schema.split("CREATE TABLE IF NOT EXISTS consent_audit (", 1)[1].split(";", 1)[0]
        pg.execute("CREATE TABLE IF NOT EXISTS consent_audit (" + table)
        pg.execute("CREATE TABLE IF NOT EXISTS actor_profiles (user_id TEXT PRIMARY KEY)")
        pg.apply_file(ROOT / "db/migrations/201_account_deletion_tombstones.sql")
        pg.apply_file(PARKED / "915_personal_agent_renewal_authority.sql")
        for name in (
            "900_personal_agent_registry.sql", "905_personal_agent_liveness.sql",
            "906_personal_agent_user_cloud.sql", "907_pod_lifecycle_events.sql",
            "908_personal_agent_tombstone_metadata.sql", "911_pod_migration_jobs.sql",
            "912_personal_agent_status_migrating.sql", "914_personal_agent_billing_space_id.sql",
            "916_personal_agent_erasure_admission.sql", "917_personal_agent_provision_admission.sql",
            "909_byoc_setup_jobs.sql",
        ):  # fmt: skip
            pg.apply_file(PARKED / name)
        for path in sorted(PARKED.glob("*.sql")):
            if 918 <= int(path.name.split("_", 1)[0]) <= 943:
                pg.apply_file(path)
        for name in (
            "947_pod_request_signing.sql",
            "948_personal_agent_user_azure.sql",
            "949_personal_agent_owner_access_erasure.sql",
            "950_personal_agent_standby_placements.sql",
        ):
            pg.apply_file(PARKED / name)
        yield pg
    finally:
        postgres_harness.MIGRATIONS = old
        pg.stop()


@pytest.fixture
def pg(server):
    server.execute("TRUNCATE personal_agent_standby_placements, personal_agent_registry CASCADE")
    return server


@pytest.fixture
def store(pg):
    return PersonalAgentStandbyStore(client=_Db(pg))


def _primary(
    pg: TempPostgres,
    *,
    owner: str = OWNER,
    hushh_id: str = HUSHH_ID,
    project: str = "owner-project",
    status: str = "provisioned",
    metadata: dict | None = None,
    signed: bool = True,
) -> None:
    meta = {"serviceUid": "incarnation-1", "url": "https://agent.example.test"}
    meta.update(metadata or {})
    public, kid = (PRIMARY_SIGNING if owner == OWNER else _signing(9)) if signed else (None, None)
    # One INSERT: the guard triggers (rightly) refuse later updates to rows under
    # erasure or with an unfinished provision, which is the state some tests need.
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status,backend,external_agent_id,"
        "a2a_route,deployment_target,model_credential_mode,user_cloud_project,user_cloud_region,"
        "user_cloud_authorized_at,pod_pubkey,pod_key_id,runtime_version,backend_metadata,"
        "pod_signing_pubkey,pod_signing_key_id) VALUES "
        "(%s,%s,%s,'user_gcp',%s,'https://a2a.example/u/x','user_gcp','user_adc',%s,"
        "'us-central1',now(),'cHVi',%s,'v1',%s::jsonb,%s,%s)",
        (owner, hushh_id, status, f"svc-{owner}", project, f"podk_{owner}", json.dumps(meta),
         public, kid),
    )  # fmt: skip


def _placement(**overrides) -> dict:
    public, kid = STANDBY_SIGNING
    placement = {
        "deployment_target": "user_azure",
        "backend": "user_azure",
        "external_agent_id": "/subscriptions/x/resourceGroups/rg-one/containerApps/ca-one",
        "model_credential_mode": "user_azure_mi",
        "user_cloud_region": "eastus2",
        "user_cloud_tenant_id": TENANT,
        "user_cloud_subscription_id": SUBSCRIPTION,
        "user_cloud_resource_group": "rg-one",
        "url": "https://ca-one.example.azurecontainerapps.io",
        "pod_pubkey": "c3RhbmRieQ==",
        "pod_key_id": "podk_standby",
        "pod_signing_pubkey": public,
        "pod_signing_key_id": kid,
        "runtime_version": "v1",
        "backend_metadata": {"serviceUid": "azure-uid"},
    }
    placement.update(overrides)
    return placement


def _insert_standby(pg: TempPostgres, *, owner: str = OWNER, hushh_id: str = HUSHH_ID) -> None:
    """Insert a standby directly, for rows ``add_standby`` would (rightly) refuse."""
    public, kid = STANDBY_SIGNING
    pg.execute(
        "INSERT INTO personal_agent_standby_placements(user_id,hushh_id,deployment_target,"
        "external_agent_id,user_cloud_region,user_cloud_tenant_id,user_cloud_subscription_id,"
        "user_cloud_resource_group,url,pod_pubkey,pod_key_id,pod_signing_pubkey,"
        "pod_signing_key_id) VALUES (%s,%s,'user_azure','ca-direct','eastus2',%s,%s,%s,"
        "'https://direct.example','c3Q=','podk_direct',%s,%s)",
        (owner, hushh_id, TENANT, SUBSCRIPTION, f"rg-{owner}", public, kid),
    )


def _registry(pg: TempPostgres, owner: str = OWNER) -> dict:
    [(row,)] = pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry AS r WHERE user_id=%s", (owner,)
    )
    return row


def _standby(pg: TempPostgres, owner: str = OWNER) -> dict | None:
    rows = pg.execute(
        "SELECT to_jsonb(s) FROM personal_agent_standby_placements AS s WHERE user_id=%s", (owner,)
    )
    return rows[0][0] if rows else None


def _run(coro):
    return asyncio.run(coro)


# -- add / read / one per person ---------------------------------------------------------


def test_add_records_one_standby_and_latches_the_primary_to_signed(pg, store):
    _primary(pg)
    assert _registry(pg)["identity_mode"] is None

    added = _run(store.add_standby(OWNER, 0, _placement()))

    assert added["hushh_id"] == HUSHH_ID and added["pod_key_id"] == "podk_standby"
    assert _registry(pg)["identity_mode"] == "signed"
    read = _run(store.read_standby(OWNER))
    assert read["placement_epoch"] == 0 and read["synced_seq"] == 0
    assert read["last_sync_status"] == "pending"


def test_a_person_has_at_most_one_standby(pg, store):
    _primary(pg)
    assert _run(store.add_standby(OWNER, 0, _placement()))
    second = _placement(
        external_agent_id="ca-two", pod_key_id="podk_two", user_cloud_resource_group="rg-two"
    )
    assert _run(store.add_standby(OWNER, 0, second)) is None
    assert pg.execute("SELECT count(*) FROM personal_agent_standby_placements") == [(1,)]
    with pytest.raises(Exception, match="duplicate key"):
        _insert_standby(pg)


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
    _primary(pg, **setup)
    assert _run(store.add_standby(OWNER, epoch, _placement())) is None
    assert _standby(pg) is None


def test_add_refuses_the_primary_s_own_keys_or_host_and_malformed_placements(pg, store):
    _primary(pg)
    public, kid = PRIMARY_SIGNING
    shared_key = _placement(pod_signing_pubkey=public, pod_signing_key_id=kid)
    assert _run(store.add_standby(OWNER, 0, shared_key)) is None
    assert _run(store.add_standby(OWNER, 0, _placement(external_agent_id=f"svc-{OWNER}"))) is None
    for bad in (
        _placement(pod_signing_key_id="pods_" + "0" * 32),  # key id not derived from the key
        _placement(url="http://plain.example"),
        _placement(user_cloud_resource_group=None),
        _placement(backend_metadata={"puppyAccess": {}}),
        _placement(private_key="nope"),
    ):
        with pytest.raises(StandbyRefused):
            _run(store.add_standby(OWNER, 0, bad))
    assert _standby(pg) is None


# -- sync lease ----------------------------------------------------------------------


def _added(pg, store) -> dict:
    _primary(pg)
    _run(store.add_standby(OWNER, 0, _placement()))
    return _run(store.read_standby(OWNER))


def test_the_sync_lease_is_exclusive_and_respects_the_cooldown(pg, store):
    observed = _added(pg, store)
    first, second = uuid4().hex, uuid4().hex

    claimed = _run(store.claim_sync_lease(OWNER, observed, first, 0))
    assert claimed["sync_lease_id"] == first and claimed["last_sync_attempt_at"] is not None
    assert _run(store.claim_sync_lease(OWNER, observed, second, 0)) is None

    assert _run(store.record_sync_result(OWNER, observed, first, None, None, "failed"))
    assert _run(store.claim_sync_lease(OWNER, observed, second, 3600)) is None  # inside cooldown
    assert _run(store.claim_sync_lease(OWNER, observed, second, 0))["sync_lease_id"] == second


def test_an_expired_lease_may_be_reclaimed(pg, store):
    observed = _added(pg, store)
    held = uuid4().hex
    assert _run(store.claim_sync_lease(OWNER, observed, held, 0))
    pg.execute(
        "UPDATE personal_agent_standby_placements SET sync_lease_at = now() - interval '16 minutes',"
        " last_sync_attempt_at = now() - interval '16 minutes'"
    )
    taken = _run(store.claim_sync_lease(OWNER, observed, uuid4().hex, 600))
    assert taken is not None and taken["sync_lease_id"] != held
    # The old holder's result no longer lands: the lease, not elapsed time, owns it.
    assert _run(store.record_sync_result(OWNER, observed, held, 1, HEAD_A, "synced")) is None


def test_the_lease_is_fenced_on_epoch_and_on_which_standby(pg, store):
    observed = _added(pg, store)
    lease = uuid4().hex
    assert _run(store.claim_sync_lease(OWNER, {**observed, "placement_epoch": 1}, lease, 0)) is None
    assert (
        _run(store.claim_sync_lease(OWNER, {**observed, "pod_key_id": "podk_x"}, lease, 0)) is None
    )
    with pytest.raises(StandbyRefused):
        _run(store.claim_sync_lease(OWNER, observed, "not-hex", 0))


# -- sync result -------------------------------------------------------------------


def _claim(store, observed) -> str:
    lease = uuid4().hex
    assert _run(store.claim_sync_lease(OWNER, observed, lease, 0))
    return lease


def test_a_sync_result_only_moves_forward(pg, store):
    observed = _added(pg, store)
    lease = _claim(store, observed)
    synced = _run(store.record_sync_result(OWNER, observed, lease, 5, HEAD_A, "synced"))
    assert (synced["synced_seq"], synced["synced_head_sha"]) == (5, HEAD_A)
    assert synced["sync_lease_id"] is None and synced["last_sync_at"] is not None
    first_sync_at = synced["last_sync_at"]

    lease = _claim(store, observed)
    assert _run(store.record_sync_result(OWNER, observed, lease, 3, HEAD_B, "synced")) is None
    assert _run(store.record_sync_result(OWNER, observed, lease, 5, HEAD_B, "synced")) is None
    assert _standby(pg)["sync_lease_id"] == lease  # still held: the failure can be recorded
    failed = _run(store.record_sync_result(OWNER, observed, lease, 9, HEAD_B, "failed"))
    assert (failed["synced_seq"], failed["synced_head_sha"]) == (5, HEAD_A)
    assert failed["last_sync_status"] == "failed" and failed["last_sync_at"] == first_sync_at

    lease = _claim(store, observed)
    same = _run(store.record_sync_result(OWNER, observed, lease, 5, HEAD_A, "synced"))
    assert same["synced_seq"] == 5 and same["last_sync_status"] == "synced"
    with pytest.raises(Exception, match="never moves backwards"):
        pg.execute(
            "UPDATE personal_agent_standby_placements SET synced_seq = 1, synced_head_sha = %s",
            (HEAD_B,),
        )


def test_a_sync_result_is_fenced_on_lease_and_epoch(pg, store):
    observed = _added(pg, store)
    lease = _claim(store, observed)
    assert _run(store.record_sync_result(OWNER, observed, uuid4().hex, 1, HEAD_A, "synced")) is None
    stale = {**observed, "placement_epoch": 1}
    assert _run(store.record_sync_result(OWNER, stale, lease, 1, HEAD_A, "synced")) is None
    for args in ((1, None, "synced"), (0, HEAD_A, "synced"), (1, HEAD_A, "done")):
        with pytest.raises(StandbyRefused):
            _run(store.record_sync_result(OWNER, observed, lease, *args))
    assert _standby(pg)["synced_seq"] == 0


def test_due_standbys_come_least_recently_attempted_first(pg, store):
    _primary(pg)
    _primary(pg, owner=OTHER, hushh_id=OTHER_HUSHH_ID, project="other-project")
    _run(store.add_standby(OWNER, 0, _placement()))
    other = _placement(
        external_agent_id="ca-other", pod_key_id="podk_other", user_cloud_resource_group="rg-other"
    )
    _run(store.add_standby(OTHER, 0, other))
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
    due = _run(store.list_standbys_due("2999-01-01T00:00:00Z", 10))
    assert [row["user_id"] for row in due] == [OWNER, OTHER]
    assert all(row["placement_epoch"] == 0 for row in due)
    # Once synced, a standby is due only after its last sync; never synced is always due.
    observed = _run(store.read_standby(OWNER))
    lease = _claim(store, observed)
    assert _run(store.record_sync_result(OWNER, observed, lease, 2, HEAD_A, "synced"))
    due = _run(store.list_standbys_due("2000-01-01T00:00:00Z", 10))
    assert [row["user_id"] for row in due] == [OTHER]
    # A held lease takes a standby out of the sweep.
    assert _run(store.claim_sync_lease(OTHER, _run(store.read_standby(OTHER)), uuid4().hex, 0))
    assert _run(store.list_standbys_due("2000-01-01T00:00:00Z", 10)) == []


# -- swap ----------------------------------------------------------------------------


def test_the_swap_moves_the_whole_placement_and_bumps_the_epoch(pg, store):
    person = {"puppyAccess": {"d1": {"ok": True}}, "detachedPlacements": [{"reason": "old"}]}
    _primary(pg, metadata={**person, "observed": {"imageTag": "v1"}})
    _run(store.add_standby(OWNER, 0, _placement()))
    lease = _claim(store, _run(store.read_standby(OWNER)))
    _run(
        store.record_sync_result(OWNER, _run(store.read_standby(OWNER)), lease, 7, HEAD_A, "synced")
    )
    before_primary, before_standby = _registry(pg), _standby(pg)

    swapped = _run(store.swap_primary_and_standby(OWNER, 0))

    assert swapped == {"user_id": OWNER, "placement_epoch": 1}
    primary, standby = _registry(pg), _standby(pg)
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
    assert _run(store.swap_primary_and_standby(OWNER, 0)) is None
    assert _registry(pg)["placement_epoch"] == 1
    # And switching back restores the original placement, one epoch later.
    assert _run(store.swap_primary_and_standby(OWNER, 1)) == {
        "user_id": OWNER,
        "placement_epoch": 2,
    }
    back = _registry(pg)
    assert back["user_cloud_project"] == "owner-project" and back["pod_key_id"] == f"podk_{OWNER}"
    assert back["backend_metadata"] == before_primary["backend_metadata"]


def test_the_swap_accepts_a_needs_reinit_primary(pg, store):
    _primary(pg, status="needs_reinit")
    _insert_standby(pg)
    assert _run(store.swap_primary_and_standby(OWNER, 0)) == {
        "user_id": OWNER,
        "placement_epoch": 1,
    }
    assert _registry(pg)["status"] == "provisioned"


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
    _primary(pg, **setup)
    _insert_standby(pg)
    before = (_registry(pg), _standby(pg))
    assert _run(store.swap_primary_and_standby(OWNER, 0)) is None
    assert (_registry(pg), _standby(pg)) == before


def test_the_swap_needs_a_standby(pg, store):
    _primary(pg)
    before = _registry(pg)
    assert _run(store.swap_primary_and_standby(OWNER, 0)) is None
    assert _registry(pg) == before


# -- remove (E10) --------------------------------------------------------------------


def test_remove_keeps_coordinates_only(pg, store):
    observed = _added(pg, store)
    removed = _run(store.remove_standby(OWNER, observed, "no longer wanted"))
    assert removed == {"user_id": OWNER, "detached_count": 1}
    assert _standby(pg) is None
    [snapshot] = _registry(pg)["backend_metadata"]["detachedPlacements"]
    assert snapshot["role"] == "standby" and snapshot["reason"] == "no longer wanted"
    assert snapshot["user_cloud_resource_group"] == "rg-one" and snapshot["url"].startswith("https")
    assert set(snapshot) <= set(standby_store.DETACHED_COORDINATES) | {
        "role",
        "reason",
        "detachedAt",
    }
    assert not any("key" in field or "pubkey" in field for field in snapshot)
    # The primary itself is untouched.
    assert _registry(pg)["pod_signing_key_id"] == PRIMARY_SIGNING[1]


def test_remove_is_fenced_and_refused_during_erasure(pg, store):
    observed = _added(pg, store)
    assert _run(store.remove_standby(OWNER, {**observed, "placement_epoch": 3}, "r")) is None
    assert _run(store.remove_standby(OWNER, {**observed, "pod_key_id": "podk_x"}, "r")) is None
    with pytest.raises(StandbyRefused):
        _run(store.remove_standby(OWNER, observed, "  "))
    assert _standby(pg) is not None

    pg.execute("TRUNCATE personal_agent_standby_placements, personal_agent_registry CASCADE")
    _primary(pg, metadata={"erasure": {"attemptId": "x"}})
    _insert_standby(pg)
    assert _run(store.remove_standby(OWNER, _run(store.read_standby(OWNER)), "r")) is None
    assert _standby(pg) is not None


def test_the_registry_row_cannot_be_deleted_out_from_under_a_standby(pg, store):
    _added(pg, store)
    with pytest.raises(Exception, match="foreign key"):
        pg.execute("DELETE FROM personal_agent_registry WHERE user_id = %s", (OWNER,))


# -- account deletion (E10) ----------------------------------------------------------


def _deletion_guard(pg: TempPostgres) -> None:
    from sqlalchemy import text

    engine = _Db(pg).engine
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
    _insert_standby(pg)
    with pytest.raises(PersonalAgentDeprovisioningRequiredError):
        _deletion_guard(pg)  # and is refused while its standby still exists.


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
