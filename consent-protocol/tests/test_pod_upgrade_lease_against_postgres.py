"""Actual PostgreSQL claim/publication checks for the existing image-upgrade lease."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import pytest

import tests.helpers.pod_upgrade_lease_cases as _upgrade_lease_cases
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin

pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="no PostgreSQL binaries on this host")

_REGISTRY_SCHEMA = (
    Path(__file__).resolve().parents[1]
    / "db"
    / "migrations"
    / "parked"
    / "900_personal_agent_registry.sql"
)

_USER = "uid-lease"
_TARGET = "gcr.io/hushh-pda-dev/consent-protocol-pod:dev-331a11456"


class _CapturingClient:
    """Not a fake database -- a tap. It records what the repository actually sends."""

    def __init__(self) -> None:
        self.sql: Optional[str] = None
        self.params: Optional[dict] = None

    def execute_raw(self, sql: str, params: Optional[dict] = None) -> Any:
        self.sql = sql
        self.params = params

        class _Empty:
            data: list = []

        return _Empty()


def _shipped_claim(target_image: str, observed: dict) -> tuple[Optional[str], dict]:
    """The statement and binds `claim_image_upgrade` sends in production."""
    tap = _CapturingClient()
    repo = PersonalAgentRegistryRepo(client=tap)
    asyncio.run(
        repo.claim_image_upgrade(user_id=_USER, target_image=target_image, observed=observed)
    )
    return tap.sql, dict(tap.params or {})


@pytest.fixture(scope="module")
def pg():
    """Disposable PostgreSQL with only the registry migrations."""
    original = postgres_harness.MIGRATIONS
    postgres_harness.MIGRATIONS = []
    server = TempPostgres()
    try:
        server.start()
        server.apply_file(_REGISTRY_SCHEMA)
        for name in (
            "905_personal_agent_liveness.sql",
            "906_personal_agent_user_cloud.sql",
            "909_byoc_setup_jobs.sql",
            "914_personal_agent_billing_space_id.sql",
            "947_pod_request_signing.sql",
            "948_personal_agent_user_azure.sql",
        ):
            server.apply_file(_REGISTRY_SCHEMA.parent / name)
        # This suite exercises registry CAS, not standby/deletion triggers. Read
        # the real registry-column portion instead of inventing a test column.
        placement = (
            _REGISTRY_SCHEMA.parent / "950_personal_agent_standby_placements.sql"
        ).read_text()
        server.execute(placement.split("CREATE TABLE IF NOT EXISTS", 1)[0] + "COMMIT;")
        server.apply_file(_REGISTRY_SCHEMA.parent / "980_personal_agent_upgrade_host_binding.sql")
        yield server
    finally:
        postgres_harness.MIGRATIONS = original
        server.stop()


@pytest.fixture(scope="module")
def pg_before_host_guard():
    """Disposable registry immediately before migration 980."""
    original = postgres_harness.MIGRATIONS
    postgres_harness.MIGRATIONS = []
    server = TempPostgres()
    try:
        server.start()
        server.apply_file(_REGISTRY_SCHEMA)
        for name in (
            "905_personal_agent_liveness.sql",
            "906_personal_agent_user_cloud.sql",
            "909_byoc_setup_jobs.sql",
            "914_personal_agent_billing_space_id.sql",
            "947_pod_request_signing.sql",
            "948_personal_agent_user_azure.sql",
        ):
            server.apply_file(_REGISTRY_SCHEMA.parent / name)
        placement = (
            _REGISTRY_SCHEMA.parent / "950_personal_agent_standby_placements.sql"
        ).read_text()
        server.execute(placement.split("CREATE TABLE IF NOT EXISTS", 1)[0] + "COMMIT;")
        yield server
    finally:
        postgres_harness.MIGRATIONS = original
        server.stop()


@pytest.fixture
def engine(pg):
    """Exercise production SQLAlchemy parameter binding against PostgreSQL."""
    from sqlalchemy import create_engine

    return create_engine(
        f"postgresql+psycopg2://hushh@/postgres?host={pg.dir}&port={pg.port}",
        future=True,
    )


@pytest.fixture
def engine_before_host_guard(pg_before_host_guard):
    from sqlalchemy import create_engine

    return create_engine(
        "postgresql+psycopg2://hushh@/postgres"
        f"?host={pg_before_host_guard.dir}&port={pg_before_host_guard.port}",
        future=True,
    )


def _row(pg, *, status: str = "provisioned", lease: Optional[str] = None) -> None:
    pg.execute("DELETE FROM personal_agent_registry WHERE user_id = %s", (_USER,))
    metadata = "{}" if lease is None else f'{{"upgradeLease": "{lease}"}}'
    pg.execute(
        """
        INSERT INTO personal_agent_registry (user_id, hushh_id, status, backend_metadata,
          pod_pubkey, pod_signing_key_id, pod_signing_pubkey)
        VALUES (%s, %s, %s, %s::jsonb, 'synthetic-public', %s, %s)
        """,
        (_USER, "ha1_lease", status, metadata, "pods_" + "f" * 32, "A" * 43 + "="),
    )


def _claim(engine, target_image: str = _TARGET) -> list:
    from sqlalchemy import text

    with engine.begin() as conn:
        observed = dict(
            conn.execute(
                text("SELECT * FROM personal_agent_registry WHERE user_id=:owner"), {"owner": _USER}
            )
            .mappings()
            .one()
        )
        sql, params = _shipped_claim(target_image, observed)
        return list(conn.execute(text(sql), params)) if sql is not None else []


def test_the_shipped_claim_statement_is_accepted_by_postgres(pg, engine):
    """Validate the shipped SQL against the actual schema."""
    _row(pg)
    assert _claim(engine), "the statement ran but claimed nothing on a free lease"


def test_the_second_worker_is_refused_while_the_lease_is_held(pg, engine):
    """Concurrent workers must have exactly one lease winner."""
    _row(pg)
    assert _claim(engine), "the first worker did not get the lease"
    assert _claim(engine) == [], "a second worker won a lease that was already held"


def test_a_contested_claim_does_not_raise_on_the_lease_value(
    pg_before_host_guard, engine_before_host_guard
):
    """Regression: casting the composite lease as a timestamp raised on contention."""
    held = f"{datetime.now(timezone.utc).isoformat()}|{_TARGET}"
    _row(pg_before_host_guard, lease=held)
    assert _claim(engine_before_host_guard) == [], (
        "a held lease was either claimable or unparseable"
    )


def test_elapsed_time_does_not_drain_provider_work(pg_before_host_guard, engine_before_host_guard):
    """A lost worker can leave an external operation running; age is not drainage."""
    stale = f"{(datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()}|{_TARGET}"
    _row(pg_before_host_guard, lease=stale)
    assert _claim(engine_before_host_guard) == [], "elapsed time admitted overlapping provider work"


def test_a_lease_inside_the_ttl_is_not_reclaimable(pg_before_host_guard, engine_before_host_guard):
    """The other side of the same boundary, or the TTL would be decoration."""
    recent = f"{(datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()}|{_TARGET}"
    _row(pg_before_host_guard, lease=recent)
    assert _claim(engine_before_host_guard) == [], (
        "a lease taken a minute ago was treated as abandoned"
    )


def test_legacy_writer_cannot_insert_or_claim_without_a_host_binding(pg):
    _upgrade_lease_cases.legacy_writer_cannot_insert_or_claim_without_host_binding(
        pg, _row, _USER, pytest
    )


@pytest.mark.asyncio
async def test_old_lease_only_clear_is_refused_after_a_host_bound_claim(pg, engine):
    await _upgrade_lease_cases.old_lease_only_clear_is_refused_after_host_bound_claim(
        pg, engine, _row, _USER, _TARGET, pytest
    )


@pytest.mark.asyncio
async def test_fabricated_provider_json_and_legacy_repair_guc_cannot_clear_a_lease(pg, engine):
    await _upgrade_lease_cases.fabricated_provider_json_and_legacy_repair_guc_cannot_clear_lease(
        pg, engine, _row, _USER, _TARGET, pytest
    )


def test_only_a_provisioned_row_can_be_claimed(pg, engine):
    """An upgrade is not a create. A row mid-provision must not be swept into one."""
    _row(pg, status="connecting")
    assert _claim(engine) == [], "a row that is not provisioned was claimed for upgrade"


def test_the_claim_writes_the_lease_it_says_it_writes(pg, engine):
    """The lease must land in `backend_metadata`, or the next claim reads nothing."""
    import json

    _row(pg)
    assert _claim(engine)
    with pg._conn.cursor() as cursor:
        cursor.execute("SELECT * FROM personal_agent_registry WHERE user_id = %s", (_USER,))
        columns = [description[0] for description in cursor.description]
        stored = dict(zip(columns, cursor.fetchone(), strict=True))
    metadata = stored["backend_metadata"]
    value = metadata["upgradeLease"]
    assert value and value.endswith(f"|{_TARGET}"), (
        "the lease value is the half the cooldown and the target check both read"
    )
    from hushh_mcp.services.personal_agent_registry_repo import (
        upgrade_host_binding_json,
        upgrade_host_snapshot,
    )

    assert metadata["upgradeLeaseHost"] == json.loads(
        upgrade_host_binding_json(upgrade_host_snapshot(stored))
    )


@pytest.mark.asyncio
async def test_expired_worker_cannot_publish_over_new_claim(pg, engine):
    await _upgrade_lease_cases.expired_worker_cannot_publish_over_new_claim(
        pg, engine, _row, _USER, _TARGET
    )


@pytest.mark.asyncio
async def test_owner_claim_publishes_delta_without_dropping_new_heartbeat(pg, engine):
    await _upgrade_lease_cases.owner_claim_publishes_delta_without_dropping_new_heartbeat(
        pg, engine, _row, _USER, _TARGET
    )


@pytest.mark.asyncio
async def test_lifecycle_transition_refuses_old_upgrade_publication(pg, engine):
    await _upgrade_lease_cases.lifecycle_transition_refuses_old_upgrade_publication(
        pg, engine, _row, _USER, _TARGET
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changed_field",
    [
        "liveness_mode",
        "project",
        "region",
        "service",
        "serviceUid",
        "url",
        "runtime_service_account",
        "tenancy",
        "ingress",
        "substrateReceipt",
        "hostKind",
        "vmHost",
        "vmConfigurationSha256",
        "vmUpdateModuleSha256",
        "image",
        "image_digest",
        "runtime_principal_id",
        "runtime_client_id",
        "vmPower",
        "placement_epoch",
        "pod_signing_key_id",
        "pod_signing_pubkey",
        "phone_e164_hash",
        "user_cloud_authorized_at",
        "deployment_target",
    ],
)
async def test_changed_host_refuses_claim_and_old_publication(pg, engine, changed_field):
    await _upgrade_lease_cases.changed_host_refuses_claim_and_old_publication(
        pg, engine, changed_field, _row, _USER, _TARGET, pytest
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("metadata", [None, "null"])
async def test_claim_distinguishes_sql_null_from_json_null(pg, engine, metadata):
    from db.db_client import DatabaseClient

    _row(pg)
    pg.execute(
        "UPDATE personal_agent_registry SET backend_metadata=%s::jsonb WHERE user_id=%s",
        (metadata, _USER),
    )
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    lease = await repo.claim_image_upgrade(
        user_id=_USER, target_image=_TARGET, observed=await repo.get(_USER)
    )
    stored = pg.execute(
        "SELECT backend_metadata->>'upgradeLease' FROM personal_agent_registry WHERE user_id=%s",
        (_USER,),
    )[0][0]
    if metadata is None:
        assert lease and stored == lease
    else:
        assert lease is None and stored is None


@pytest.mark.asyncio
async def test_equivalent_timestamp_offsets_preserve_claim(pg, engine):
    from db.db_client import DatabaseClient

    _row(pg)
    pg.execute(
        "UPDATE personal_agent_registry SET user_cloud_authorized_at=updated_at WHERE user_id=%s",
        (_USER,),
    )
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    observed = await repo.get(_USER)
    for key in ("updated_at", "user_cloud_authorized_at"):
        value = observed[key]
        instant = datetime.fromisoformat(value) if isinstance(value, str) else value
        observed[key] = instant.astimezone(timezone(timedelta(hours=-7))).isoformat()
    assert await repo.claim_image_upgrade(user_id=_USER, target_image=_TARGET, observed=observed)


@pytest.mark.asyncio
async def test_files_checkpoint_advancement_fences_stale_recovery(pg, engine):
    from db.db_client import DatabaseClient

    _row(pg)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    lease = await repo.claim_image_upgrade(
        user_id=_USER, target_image=_TARGET, observed=await repo.get(_USER)
    )
    stale = await repo.get(_USER)
    advanced = {**stale["backend_metadata"], "filesUpgradeCheckpoint": {"phase": "intent"}}
    assert await repo.record_image_upgrade(
        user_id=_USER,
        observed=stale,
        expected_lease=lease,
        previous_metadata=stale["backend_metadata"],
        backend_metadata=advanced,
        retain_lease=True,
    )
    assert not await repo.record_image_upgrade(
        user_id=_USER,
        observed=stale,
        expected_lease=lease,
        previous_metadata=stale["backend_metadata"],
        backend_metadata={"image": "stale-success"},
    )
    current = await repo.get(_USER)
    assert current["backend_metadata"] == advanced


@pytest.mark.asyncio
@pytest.mark.parametrize("changed_key", ["upgradeApproval", "upgradeAcknowledgement", "erasure"])
async def test_recovery_refuses_concurrent_authority_change(pg, engine, changed_key):
    import json

    from db.db_client import DatabaseClient

    _row(pg)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    lease = await repo.claim_image_upgrade(
        user_id=_USER, target_image=_TARGET, observed=await repo.get(_USER)
    )
    observed = await repo.get(_USER)
    pg.execute(
        "UPDATE personal_agent_registry SET backend_metadata=backend_metadata || %s::jsonb "
        "WHERE user_id=%s",
        (json.dumps({changed_key: {"operationId": "concurrent-operation"}}), _USER),
    )
    assert not await repo.record_image_upgrade(
        user_id=_USER,
        observed=observed,
        expected_lease=lease,
        previous_metadata=observed["backend_metadata"],
        backend_metadata=observed["backend_metadata"],
        require_unchanged_metadata=True,
    )
    current = await repo.get(_USER)
    assert current["backend_metadata"]["upgradeLease"] == lease
    assert current["backend_metadata"][changed_key]["operationId"] == "concurrent-operation"
    # A fresh, unchanged snapshot can publish; this method does not decide recovery safety.
    assert await repo.record_image_upgrade(
        user_id=_USER,
        observed=current,
        expected_lease=lease,
        previous_metadata=current["backend_metadata"],
        backend_metadata=current["backend_metadata"],
        require_unchanged_metadata=True,
    )


@pytest.mark.asyncio
async def test_uncertain_upgrade_retains_admission_until_terminal_publication(pg, engine):
    from db.db_client import DatabaseClient

    _row(pg)
    repo = PersonalAgentRegistryRepo(client=DatabaseClient(engine=engine))
    lease = await repo.claim_image_upgrade(
        user_id=_USER, target_image=_TARGET, observed=await repo.get(_USER)
    )
    observed = await repo.get(_USER)
    receipt = {"attemptId": "synthetic-attempt", "generation": 4}
    assert await repo.record_image_upgrade(
        user_id=_USER,
        observed=observed,
        expected_lease=lease,
        previous_metadata=observed["backend_metadata"],
        backend_metadata={**observed["backend_metadata"], "upgradeAcknowledgement": receipt},
        retain_lease=True,
    )
    # The worker's pre-ack snapshot must not erase the durable acknowledgement
    # when it subsequently records a polling timeout.
    assert await repo.record_image_upgrade(
        user_id=_USER,
        observed=observed,
        expected_lease=lease,
        previous_metadata=observed["backend_metadata"],
        backend_metadata={"upgrade": {"outcome": "unresolved"}},
        retain_lease=True,
    )
    assert (
        await repo.claim_image_upgrade(
            user_id=_USER, target_image=_TARGET, observed=await repo.get(_USER)
        )
        is None
    )
    observed = await repo.get(_USER)
    assert observed["backend_metadata"]["upgradeLease"] == lease
    assert observed["backend_metadata"]["upgradeAcknowledgement"] == receipt
    assert await repo.record_image_upgrade(
        user_id=_USER,
        observed=observed,
        expected_lease=lease,
        previous_metadata=observed["backend_metadata"],
        backend_metadata={"image": "terminal"},
    )
    assert await repo.claim_image_upgrade(
        user_id=_USER, target_image=_TARGET, observed=await repo.get(_USER)
    )
    for delayed_metadata in ({"image": "old-success"}, {"upgrade": {"outcome": "unresolved"}}):
        assert not await repo.record_image_upgrade(
            user_id=_USER,
            observed=observed,
            expected_lease=lease,
            previous_metadata=observed["backend_metadata"],
            backend_metadata=delayed_metadata,
            retain_lease="upgrade" in delayed_metadata,
        )


@pytest.mark.asyncio
async def test_host_binding_migration_blocks_legacy_and_guards_forward_rollback_replay(
    pg_before_host_guard, engine_before_host_guard
):
    await _upgrade_lease_cases.host_binding_migration_blocks_legacy_and_guards_replay(
        pg_before_host_guard,
        engine_before_host_guard,
        _REGISTRY_SCHEMA,
        _row,
        _USER,
        _TARGET,
        pytest,
    )
