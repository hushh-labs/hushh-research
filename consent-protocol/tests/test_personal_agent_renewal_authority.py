"""Real PostgreSQL ordering for renewable private-agent consent authority."""

from __future__ import annotations

# ruff: noqa: S106, S107 -- synthetic ledger labels, never usable credentials.
import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import AsyncMock

import psycopg2
import pytest

from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin

pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="PostgreSQL binaries unavailable")
ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "db/migrations/parked/915_personal_agent_renewal_authority.sql"


@pytest.fixture
def pg(monkeypatch):
    monkeypatch.setattr(postgres_harness, "MIGRATIONS", [])
    server = TempPostgres()
    try:
        server.start()
        schema = (ROOT / "db/legacy/init_legacy_schema.sql").read_text()
        table = schema.split("CREATE TABLE IF NOT EXISTS consent_audit (", 1)[1].split(";", 1)[0]
        server.execute("CREATE TABLE IF NOT EXISTS consent_audit (" + table)
        server.execute("CREATE TABLE IF NOT EXISTS actor_profiles (user_id TEXT PRIMARY KEY)")
        server.apply_file(ROOT / "db/migrations/201_account_deletion_tombstones.sql")
        server.apply_file(MIGRATION)
        yield server
    finally:
        server.stop()


def event(
    action="CONSENT_GRANTED", *, automatic=True, owner="synthetic-owner", token="grant", **extra
):
    return {
        "user_id": owner,
        "agent_id": "personal_agent",
        "scope": "pkm.read",
        "action": action,
        "token_id": token,
        "issued_at": 100,
        "metadata": json.dumps({"automatic_renewal": automatic}),
        **extra,
    }


def insert(conn, item, *, renewal=False):
    with conn.cursor() as cursor:
        if renewal:
            cursor.execute(
                "SELECT id FROM insert_personal_agent_renewal(%s::jsonb)", (json.dumps(item),)
            )
        else:
            cursor.execute(
                """INSERT INTO consent_audit
                   (user_id,agent_id,scope,action,token_id,issued_at,expires_at,metadata)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb) RETURNING id""",
                tuple(
                    item.get(k)
                    for k in (
                        "user_id",
                        "agent_id",
                        "scope",
                        "action",
                        "token_id",
                        "issued_at",
                        "expires_at",
                        "metadata",
                    )
                ),
            )
        return cursor.fetchone()[0]


def connect(pg, **kwargs):
    return psycopg2.connect(
        host=str(pg.dir), port=pg.port, user="hushh", dbname="postgres", **kwargs
    )


@pytest.mark.parametrize("denial", ["REVOKED", "CONSENT_DENIED"])
def test_revocation_blocks_renewal_until_explicit_reapproval(pg, denial):
    with connect(pg) as conn:
        insert(conn, event(), renewal=True)
        insert(conn, event(denial, token="denial"))
    with connect(pg) as conn, pytest.raises(psycopg2.errors.InsufficientPrivilege):
        insert(conn, event(token="replacement"), renewal=True)
    with connect(pg) as conn:
        insert(conn, event(automatic=False, token="owner-approved"))
        insert(conn, event(token="renewed"), renewal=True)
    assert pg.execute("SELECT token_id FROM consent_audit ORDER BY issued_at DESC LIMIT 1") == [
        ("renewed",)
    ]


def test_expiry_is_renewable_but_stale_expiry_cannot_override_revoke(pg):
    expiry = json.dumps({"reason": "expired", "source": "consent_revocation_worker"})
    with connect(pg) as conn:
        insert(conn, event(expires_at=1), renewal=True)
        insert(conn, event("REVOKED", expires_at=1, metadata=expiry))
        insert(conn, event(token="renewed", expires_at=1), renewal=True)
        insert(conn, event("REVOKED", token="owner-revoke"))
    with connect(pg) as conn, pytest.raises(psycopg2.errors.SerializationFailure):
        insert(conn, event("REVOKED", token="renewed", expires_at=1, metadata=expiry))
    with connect(pg) as conn, pytest.raises(psycopg2.errors.InsufficientPrivilege):
        insert(conn, event(token="resurrected"), renewal=True)


def test_missing_guard_refuses_instead_of_using_plain_insert(pg):
    pg.execute("ALTER TABLE consent_audit DISABLE TRIGGER zz_personal_agent_renewal_authority")
    with connect(pg) as conn, pytest.raises(psycopg2.errors.InsufficientPrivilege):
        insert(conn, event(), renewal=True)
    assert pg.execute("SELECT count(*) FROM consent_audit") == [(0,)]


@pytest.mark.parametrize("account_deletion", [False, True])
def test_inflight_revocation_serializes_renewal_without_affecting_another_owner(
    pg, account_deletion
):
    pg.execute("INSERT INTO actor_profiles(user_id) VALUES ('synthetic-owner')")
    with connect(pg) as conn:
        insert(conn, event(), renewal=True)
    revoker = connect(pg)
    started = Event()
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        if account_deletion:
            with revoker.cursor() as cursor:
                cursor.execute("DELETE FROM actor_profiles WHERE user_id='synthetic-owner'")
        else:
            insert(revoker, event("REVOKED", token="owner-revoke"))

        def renew():
            with connect(pg, application_name="private-renewal-race") as conn:
                started.set()
                error = (
                    psycopg2.errors.CheckViolation
                    if account_deletion
                    else psycopg2.errors.InsufficientPrivilege
                )
                with pytest.raises(error):
                    insert(conn, event(token="racing-renewal"), renewal=True)

        result = pool.submit(renew)
        assert started.wait(5)
        deadline = time.monotonic() + 5
        while not pg.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='private-renewal-race' AND wait_event_type='Lock')"
        )[0][0]:
            assert time.monotonic() < deadline, "renewal never reached the lock"
            time.sleep(0.01)
        with connect(pg) as conn:
            insert(conn, event(owner="other-owner"), renewal=True)
        revoker.commit()
        result.result(timeout=5)
    finally:
        revoker.rollback()
        revoker.close()
        pool.shutdown(wait=True)
    assert pg.execute("SELECT count(*) FROM consent_audit WHERE token_id='racing-renewal'") == [
        (0,)
    ]


@pytest.mark.asyncio
async def test_existing_ledger_adapter_uses_guard_and_receipts_persisted_order(pg, monkeypatch):
    from sqlalchemy import create_engine, text

    from hushh_mcp.services import consent_audit_chain_service
    from hushh_mcp.services.consent_db import ConsentDBService

    engine = create_engine(f"postgresql+psycopg2://hushh@/postgres?host={pg.dir}&port={pg.port}")

    class Database:
        def execute_raw(self, sql, params):
            with engine.begin() as conn:
                return SimpleNamespace(
                    data=[dict(row) for row in conn.execute(text(sql), params).mappings()]
                )

        def table(self, _name):
            raise AssertionError("automatic issuance must not fall back to ordinary INSERT")

    receipt = AsyncMock()
    monkeypatch.setattr(consent_audit_chain_service, "append_consent_receipt_safe", receipt)
    ledger = ConsentDBService()
    monkeypatch.setattr(ledger, "_get_db", lambda: Database())
    args = dict(
        user_id="synthetic-owner",
        agent_id="personal_agent",
        scope="pkm.read",
        action="CONSENT_GRANTED",
        token_id="synthetic-token",
        metadata={"automatic_renewal": True},
    )
    try:
        await ledger.insert_event(**args)
        saved = pg.execute("SELECT issued_at FROM consent_audit WHERE token_id='synthetic-token'")[
            0
        ][0]
        assert receipt.call_args.kwargs["issued_at_ms"] == saved
        with connect(pg) as conn:
            insert(conn, event("REVOKED", token="owner-revoke"))
        receipt.reset_mock()
        with pytest.raises(PermissionError, match="renewal authority unavailable"):
            await ledger.insert_event(**args)
        receipt.assert_not_awaited()
        assert pg.execute(
            "SELECT count(*) FROM consent_audit WHERE token_id='synthetic-token'"
        ) == [(1,)]
    finally:
        engine.dispose()


@pytest.mark.asyncio
async def test_denial_cannot_reuse_an_older_unexpired_grant(pg, monkeypatch):
    from sqlalchemy import create_engine

    from db.db_client import DatabaseClient
    from hushh_mcp.services import personal_agent_grant_service as grants
    from hushh_mcp.services.consent_db import ConsentDBService

    expiry = int(time.time() * 1000) + 86400000
    with connect(pg) as conn:
        insert(conn, event(token="old", expires_at=expiry), renewal=True)
        insert(conn, event("CONSENT_DENIED", token="denial"))
    engine = create_engine(f"postgresql+psycopg2://hushh@/postgres?host={pg.dir}&port={pg.port}")
    ledger = ConsentDBService()
    monkeypatch.setattr(ledger, "_get_db", lambda: DatabaseClient(engine))
    monkeypatch.setattr(grants, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(
        grants, "issue_token", lambda **_: SimpleNamespace(token="candidate", expires_at=expiry)
    )
    validator = AsyncMock(return_value=(True, None, object()))
    try:
        assert (
            await ledger.get_active_tokens(
                "synthetic-owner", agent_id="personal_agent", scope="pkm.read"
            )
            == []
        )
        assert not await ledger.is_token_active(
            "synthetic-owner", "pkm.read", "personal_agent", token_id="old"
        )
        with pytest.raises(PermissionError, match="renewal authority unavailable"):
            await grants.PersonalAgentGrantService().issue_or_reuse_standing_pkm_read(
                "synthetic-owner",
                ledger=ledger,
                lookup=ledger.get_active_tokens,
                validator=validator,
            )
        validator.assert_not_awaited()
        assert pg.execute("SELECT count(*) FROM consent_audit WHERE token_id='candidate'") == [(0,)]
    finally:
        engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("later_insert_issued_at", [100, 200])
async def test_historical_event_order_uses_timestamp_then_id(
    pg, monkeypatch, later_insert_issued_at
):
    from sqlalchemy import create_engine

    from db.db_client import DatabaseClient
    from hushh_mcp.services.consent_db import ConsentDBService

    # Legacy/imported rows need not have timestamps increasing with insertion id.
    # Updating fixtures bypasses the new INSERT guard's monotonic timestamp rule.
    with connect(pg) as conn:
        insert(conn, event(token="grant", expires_at=int(time.time() * 1000) + 86400000))
        insert(conn, event("CONSENT_DENIED", token="denial"))
        with conn.cursor() as cursor:
            cursor.execute("UPDATE consent_audit SET issued_at=200 WHERE token_id='grant'")
            cursor.execute(
                "UPDATE consent_audit SET issued_at=%s WHERE token_id='denial'",
                (later_insert_issued_at,),
            )
    engine = create_engine(f"postgresql+psycopg2://hushh@/postgres?host={pg.dir}&port={pg.port}")
    ledger = ConsentDBService()
    monkeypatch.setattr(ledger, "_get_db", lambda: DatabaseClient(engine))
    try:
        active = await ledger.get_active_tokens(
            "synthetic-owner", agent_id="personal_agent", scope="pkm.read"
        )
        assert bool(active) is (later_insert_issued_at < 200)
        assert await ledger.is_token_active(
            "synthetic-owner", "pkm.read", "personal_agent", token_id="grant"
        ) is (later_insert_issued_at < 200)
    finally:
        engine.dispose()


def test_erasure_reservation_blocks_grants_and_registry_replacement(pg):
    pg.apply_file(ROOT / "db/migrations/parked/900_personal_agent_registry.sql")
    pg.apply_file(ROOT / "db/migrations/parked/912_personal_agent_status_migrating.sql")
    pg.apply_file(ROOT / "db/migrations/parked/916_personal_agent_erasure_admission.sql")
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status,external_agent_id,backend_metadata) VALUES ('synthetic-owner','ha1_erasure','provisioned','pod-service','{\"serviceUid\":\"incarnation\",\"upgradeLease\":\"synthetic|operation|synthetic/target\"}')"
    )
    receipt = pg.execute("SELECT reserve_personal_agent_erasure('synthetic-owner','attempt-one')")[
        0
    ][0]
    assert receipt["phase"] == "reserved"
    assert (
        receipt["registrySnapshot"]["backend_metadata"]["upgradeLease"]
        == "synthetic|operation|synthetic/target"
    )
    assert (
        pg.execute("SELECT reserve_personal_agent_erasure('synthetic-owner','attempt-two')")[0][0]
        == receipt
    )
    assert pg.execute(
        "SELECT status FROM personal_agent_registry WHERE user_id='synthetic-owner'"
    ) == [("suspended",)]
    for statement in (
        "UPDATE personal_agent_registry SET status='provisioned' WHERE user_id='synthetic-owner'",
        "UPDATE personal_agent_registry SET backend_metadata='{}' WHERE user_id='synthetic-owner'",
        "DELETE FROM personal_agent_registry WHERE user_id='synthetic-owner'",
    ):
        with pytest.raises(psycopg2.errors.InsufficientPrivilege):
            pg.execute(statement)
    for automatic in (True, False):
        with connect(pg) as conn, pytest.raises(psycopg2.errors.InsufficientPrivilege):
            insert(conn, event(automatic=automatic), renewal=automatic)
    # Revocation and other owners remain admitted through existing authority.
    with connect(pg) as conn:
        insert(conn, event("REVOKED"))
        insert(conn, event(owner="another-owner"), renewal=True)

    ack = {
        "version": 1,
        "generation": 4,
        "serviceUid": "incarnation",
        "service": "pod-service",
        "attemptId": hashlib.sha256(b"synthetic|operation|synthetic/target").hexdigest(),
        "image": "synthetic/image",
        "targetImage": "synthetic/target",
    }
    retain_sql = "SELECT retain_erasure_upgrade_ack('synthetic-owner',%s,%s::jsonb)"
    assert pg.execute(retain_sql, ("foreign-token", json.dumps(ack))) == [(False,)]
    assert pg.execute(retain_sql, ("synthetic|operation|synthetic/target", json.dumps(ack))) == [
        (True,)
    ]
    assert pg.execute(retain_sql, ("synthetic|operation|synthetic/target", json.dumps(ack))) == [
        (True,)
    ]
    assert pg.execute(
        retain_sql, ("synthetic|operation|synthetic/target", json.dumps({**ack, "generation": 5}))
    ) == [(False,)]
    saved = pg.execute(
        "SELECT status,backend_metadata->'erasure' FROM personal_agent_registry WHERE user_id='synthetic-owner'"
    )[0]
    assert saved[0] == "suspended"
    assert saved[1] == {**receipt, "lateUpgradeAcknowledgement": ack}

    pg.execute(
        "ALTER TABLE personal_agent_registry DISABLE TRIGGER zz_personal_agent_erasure_registry"
    )
    with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="guards unavailable"):
        pg.execute("SELECT reserve_personal_agent_erasure('synthetic-owner','attempt-three')")


@pytest.mark.parametrize("writer", ["grant", "registry"])
def test_erasure_reservation_serializes_concurrent_owner_writers(pg, writer):
    pg.apply_file(ROOT / "db/migrations/parked/900_personal_agent_registry.sql")
    pg.apply_file(ROOT / "db/migrations/parked/912_personal_agent_status_migrating.sql")
    pg.apply_file(ROOT / "db/migrations/parked/916_personal_agent_erasure_admission.sql")
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status) VALUES ('synthetic-owner','ha1_erasure','provisioned')"
    )
    reserver = connect(pg)
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        with reserver.cursor() as cursor:
            cursor.execute("SELECT reserve_personal_agent_erasure('synthetic-owner','attempt')")

        def write():
            with connect(pg, application_name="synthetic-erasure-race") as conn:
                if writer == "grant":
                    insert(conn, event(automatic=False))
                else:
                    with conn.cursor() as cursor:
                        cursor.execute(
                            "UPDATE personal_agent_registry SET status='provisioning' WHERE user_id='synthetic-owner'"
                        )

        future = pool.submit(write)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if pg.execute(
                "SELECT count(*) FROM pg_stat_activity WHERE application_name='synthetic-erasure-race' AND wait_event_type='Lock'"
            )[0][0]:
                break
            time.sleep(0.02)
        else:
            pytest.fail("concurrent writer did not reach the reservation lock")
        reserver.commit()
        with pytest.raises(psycopg2.errors.InsufficientPrivilege):
            future.result(timeout=5)
    finally:
        reserver.rollback()
        reserver.close()
        pool.shutdown(wait=True)


@pytest.fixture
def provision_pg(pg):
    for name in (
        "900_personal_agent_registry.sql",
        "905_personal_agent_liveness.sql",
        "906_personal_agent_user_cloud.sql",
        "912_personal_agent_status_migrating.sql",
        "914_personal_agent_billing_space_id.sql",
        "916_personal_agent_erasure_admission.sql",
        "917_personal_agent_provision_admission.sql",
    ):
        pg.apply_file(ROOT / "db/migrations/parked" / name)
    return pg


def claim_provision(pg, *, attempt="a" * 32, observed=None, owner="synthetic-owner"):
    return pg.execute(
        "SELECT claim_personal_agent_provision(%s,%s,%s::jsonb,%s::jsonb)",
        (
            owner,
            attempt,
            json.dumps(observed),
            json.dumps(
                {
                    "user_id": owner,
                    "hushh_id": "ha1_provision",
                    "phone_e164_hash": "synthetic-hash",
                }
            ),
        ),
    )[0][0]


def test_setup_authorization_survives_retry_and_rejects_foreign_receipts(provision_pg):
    pg = provision_pg
    pg.apply_file(ROOT / "db/migrations/parked/909_byoc_setup_jobs.sql")
    for path in sorted((ROOT / "db/migrations/parked").glob("*.sql")):
        if 918 <= int(path.name.split("_", 1)[0]) <= 928:
            pg.apply_file(path)
    pg.apply_file(ROOT / "db/migrations/rollback/928_byoc_authorization_receipts.rollback.sql")
    pg.apply_file(ROOT / "db/migrations/parked/928_byoc_authorization_receipts.sql")
    pg.execute(
        "INSERT INTO byoc_setup_jobs(user_id,job_id,project_id) VALUES ('synthetic-owner','first','synthetic-project')"
    )
    intent = {
        "ownerId": "synthetic-owner",
        "jobId": "first",
        "project": "synthetic-project",
        "bootstrapEmail": "one-bootstrap@synthetic-project.iam.gserviceaccount.com",
        "callerEmail": "hub@synthetic-hub.iam.gserviceaccount.com",
    }

    def retain(receipt=None, owner="synthetic-owner"):
        return pg.execute(
            "SELECT retain_byoc_authorization(%s,'first',%s::jsonb,%s::jsonb)",
            (owner, json.dumps(intent), json.dumps(receipt) if receipt is not None else None),
        )[0][0]

    with connect(pg) as admission, ThreadPoolExecutor(max_workers=1) as pool:
        with admission.cursor() as cursor:
            cursor.execute(
                "SELECT retain_byoc_authorization('synthetic-owner','first',%s::jsonb)",
                (json.dumps(intent),),
            )
            assert cursor.fetchone()[0]

        def rollback_schema():
            with connect(pg, application_name="synthetic-authorization-rollback") as conn:
                with conn.cursor() as cursor:
                    cursor.execute("SET statement_timeout='5s'")
                    cursor.execute(
                        (
                            ROOT
                            / "db/migrations/rollback/928_byoc_authorization_receipts.rollback.sql"
                        ).read_text()
                    )

        rollback = pool.submit(rollback_schema)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if pg.execute(
                "SELECT count(*) FROM pg_stat_activity WHERE application_name='synthetic-authorization-rollback' AND wait_event_type='Lock'"
            )[0][0]:
                break
            time.sleep(0.02)
        else:
            pytest.fail("rollback did not wait for authorization retention")
        admission.commit()
        with pytest.raises(psycopg2.errors.RaiseException, match="require preservation"):
            rollback.result(timeout=5)
    assert not retain()  # An admitted attempt cannot replay provider authorization.
    pg.execute(
        "UPDATE byoc_setup_jobs SET job_id='second',stages='[]',stage='starting' WHERE user_id='synthetic-owner'"
    )
    identity = {
        "name": "projects/synthetic-project/serviceAccounts/" + intent["bootstrapEmail"],
        "projectId": "synthetic-project",
        "email": intent["bootstrapEmail"],
        "uniqueId": "123456789012345678901",
    }
    receipt = {
        "bootstrapIdentity": identity,
        "bindingObservation": {
            "step": "authorize_bootstrap_impersonation",
            "policyResource": "https://iam.googleapis.com/v1/" + identity["name"] + ":getIamPolicy",
            "role": "roles/iam.serviceAccountTokenCreator",
            "member": "serviceAccount:" + intent["callerEmail"],
            "disposition": "added",
            "beforeEtag": "before",
            "afterEtag": "after",
        },
    }
    assert not retain(receipt, owner="foreign-owner")
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        retain({**receipt, "bootstrapIdentity": {**identity, "uniqueId": "invalid"}})
    assert retain(receipt)  # Late acknowledgement remains bound to its original attempt.
    assert retain(receipt)
    for mutation in ("authorization_attempts='{}'", "user_id='foreign-owner'"):
        with pytest.raises((psycopg2.errors.InsufficientPrivilege, psycopg2.errors.CheckViolation)):
            pg.execute(
                "UPDATE byoc_setup_jobs SET " + mutation + " WHERE user_id='synthetic-owner'"
            )
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        pg.execute("DELETE FROM byoc_setup_jobs WHERE user_id='synthetic-owner'")
    pg.execute(
        "UPDATE byoc_setup_jobs SET project_id='different-project',status='recorded' WHERE user_id='synthetic-owner'"
    )
    assert (
        pg.execute("SELECT project_grant_release_is_exclusive('other-owner','synthetic-project')")[
            0
        ][0]
        is False
    )
    assert (
        pg.execute("SELECT project_grant_release_is_exclusive('other-owner','unrelated-project')")[
            0
        ][0]
        is True
    )
    pg.execute("ALTER TABLE byoc_setup_jobs DISABLE TRIGGER zz_byoc_authorization_attempts")
    assert not retain(receipt)


@pytest.mark.parametrize(
    "invalid", [None, "owner", "attempt", "engine", "extra", "guard", "provenance"]
)
def test_erasure_memory_binding_is_append_only_and_attempt_bound(provision_pg, invalid):
    pg = provision_pg
    pg.apply_file(ROOT / "db/migrations/parked/918_personal_agent_erasure_memory_binding.sql")
    pg.apply_file(ROOT / "db/migrations/parked/919_personal_agent_compute_erasure.sql")
    pg.apply_file(ROOT / "db/migrations/parked/920_personal_agent_substrate_inventory.sql")
    pg.apply_file(ROOT / "db/migrations/parked/921_personal_agent_writer_revocation.sql")
    pg.apply_file(ROOT / "db/migrations/parked/922_personal_agent_bucket_erasure.sql")
    pg.apply_file(ROOT / "db/migrations/parked/923_personal_agent_mail_erasure.sql")
    pg.apply_file(ROOT / "db/migrations/parked/924_personal_agent_kms_erasure.sql")
    pg.apply_file(ROOT / "db/migrations/parked/925_personal_agent_secret_erasure.sql")
    pg.apply_file(ROOT / "db/migrations/parked/926_personal_agent_runtime_account_erasure.sql")
    pg.apply_file(ROOT / "db/migrations/parked/909_byoc_setup_jobs.sql")
    pg.apply_file(ROOT / "db/migrations/parked/927_personal_agent_project_grant_fence.sql")
    pg.apply_file(ROOT / "db/migrations/parked/928_byoc_authorization_receipts.sql")
    pg.apply_file(ROOT / "db/migrations/parked/929_personal_agent_runtime_grant_erasure.sql")
    pg.apply_file(
        ROOT / "db/migrations/rollback/929_personal_agent_runtime_grant_erasure.rollback.sql"
    )
    pg.apply_file(ROOT / "db/migrations/parked/929_personal_agent_runtime_grant_erasure.sql")
    pg.apply_file(ROOT / "db/migrations/parked/930_personal_agent_repository_grant_erasure.sql")
    pg.apply_file(
        ROOT / "db/migrations/rollback/930_personal_agent_repository_grant_erasure.rollback.sql"
    )
    pg.apply_file(ROOT / "db/migrations/parked/930_personal_agent_repository_grant_erasure.sql")
    pg.apply_file(ROOT / "db/migrations/parked/931_personal_agent_repository_inventory.sql")
    pg.apply_file(
        ROOT / "db/migrations/rollback/931_personal_agent_repository_inventory.rollback.sql"
    )
    pg.apply_file(ROOT / "db/migrations/parked/931_personal_agent_repository_inventory.sql")
    pg.apply_file(ROOT / "db/migrations/parked/932_personal_agent_repository_retention.sql")
    pg.apply_file(
        ROOT / "db/migrations/rollback/932_personal_agent_repository_retention.rollback.sql"
    )
    pg.apply_file(ROOT / "db/migrations/parked/932_personal_agent_repository_retention.sql")
    bucket_identity = {
        "name": "synthetic-bucket",
        "generation": "10",
        "projectNumber": "123",
        "timeCreated": "2026-09-01T00:00:00Z",
    }
    runtime_email = "runtime@synthetic-project.iam.gserviceaccount.com"
    runtime_identity = {
        "name": f"projects/synthetic-project/serviceAccounts/{runtime_email}",
        "email": runtime_email,
        "projectId": "synthetic-project",
        "uniqueId": "123456789",
    }
    bootstrap_email = "bootstrap@synthetic-project.iam.gserviceaccount.com"
    bootstrap_identity = {
        "name": f"projects/synthetic-project/serviceAccounts/{bootstrap_email}",
        "email": bootstrap_email,
        "projectId": "synthetic-project",
        "uniqueId": "987654321",
    }
    inventory = {
        "version": "byoc.substrate.receipt.v1",
        "applied": True,
        "bindingObservations": [
            {
                "step": "iam_pod_sa_vertex",
                "policyResource": "https://cloudresourcemanager.googleapis.com/v1/projects/synthetic-project:getIamPolicy",
                "role": "roles/aiplatform.user",
                "member": f"serviceAccount:{runtime_email}",
                "disposition": "added",
                "beforeEtag": "before",
                "afterEtag": "after",
            }
        ],
        "plannedResources": [
            {"type": "service_account", "id": runtime_email},
            {"type": "gcs_bucket", "id": "synthetic-bucket"},
            {"type": "artifact_repository", "id": "shared-repository"},
        ],
        "resourceObservations": [
            {
                "type": "service_account",
                "id": runtime_email,
                "disposition": "created",
                "identity": runtime_identity,
            }
        ],
    }
    repository_identity = {
        "name": "projects/synthetic-project/locations/us-central1/repositories/one-pod",
        "format": "DOCKER",
        "createTime": "2026-09-08T00:00:00Z",
    }
    repository_binding = {
        "step": "artifact_repo_grant_copy_writer",
        "policyResource": "https://artifactregistry.googleapis.com/v1/"
        + repository_identity["name"]
        + ":getIamPolicy",
        "role": "roles/artifactregistry.writer",
        "member": "serviceAccount:original-hub@hub-project.iam.gserviceaccount.com",
        "disposition": "added",
        "beforeEtag": "before",
        "afterEtag": "after",
    }
    inventory["plannedResources"].append({"type": "artifact_repository", "id": "one-pod"})
    inventory["resourceObservations"].append(
        {
            "type": "artifact_repository",
            "id": "one-pod",
            "disposition": "created",
            "identity": repository_identity,
        }
    )
    inventory["bindingObservations"].append(repository_binding)
    inventory["resourceObservations"].append(
        {
            "type": "gcs_bucket",
            "id": "synthetic-bucket",
            "disposition": "created",
            "identity": bucket_identity,
        }
    )
    kms_name = (
        "projects/synthetic-project/locations/us-central1/keyRings/hushh-one/cryptoKeys/key-one"
    )
    kms_observation = {
        "type": "kms_key",
        "id": "key-one",
        "disposition": "created",
        "identity": {
            "name": kms_name,
            "purpose": "ENCRYPT_DECRYPT",
            "createTime": "2026-09-08T00:00:00Z",
        },
    }
    inventory["plannedResources"].append({"type": "kms_key", "id": "key-one"})
    inventory["resourceObservations"].append(kms_observation)
    secret_observation = {
        "type": "secret",
        "id": "signing-key",
        "disposition": "created",
        "identity": {
            "name": "projects/synthetic-project/secrets/signing-key",
            "projectId": "synthetic-project",
            "createTime": "2026-09-08T00:00:00Z",
        },
    }
    inventory["plannedResources"].append({"type": "secret", "id": "signing-key"})
    inventory["resourceObservations"].append(secret_observation)
    mail_observations = []
    for kind, segment in (
        ("cloud_scheduler_job", "locations/us-central1/jobs"),
        ("pubsub_subscription", "subscriptions"),
        ("pubsub_topic", "topics"),
    ):
        identity = {"name": f"projects/synthetic-project/{segment}/mail-one"}
        if kind == "pubsub_subscription":
            identity["topic"] = "projects/synthetic-project/topics/mail-one"
        elif kind == "cloud_scheduler_job":
            identity.update(
                pubsubTarget={"topicName": "projects/synthetic-project/topics/mail-one"},
                schedule="0 4 * * *",
                timeZone="Etc/UTC",
            )
        observation = {
            "type": kind,
            "id": "mail-one",
            "disposition": "created",
            "identity": identity,
        }
        mail_observations.append(observation)
        inventory["plannedResources"].append({"type": kind, "id": "mail-one"})
        inventory["resourceObservations"].append(observation)
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status,external_agent_id,backend_metadata) "
        "VALUES ('synthetic-owner','ha1_erasure','provisioned','pod-service',%s::jsonb)",
        (
            json.dumps(
                {
                    "serviceUid": "incarnation",
                    "substrateReceipt": inventory,
                    "runtime_service_account": runtime_email,
                    "provisionAttempt": {
                        "version": 1,
                        "ownerId": "synthetic-owner",
                        "phase": "provisioned",
                        "evidence": {
                            "host_requested": {
                                "creationAcknowledgement": {
                                    "backend": "gcp",
                                    "project": "synthetic-project",
                                    "region": "us-central1",
                                    "service": "pod-service",
                                    "serviceUid": "incarnation",
                                    "initialGeneration": 1,
                                    "initialImage": "repo/pod@sha256:" + "a" * 64,
                                }
                            }
                        },
                    },
                }
            ),
        ),
    )
    pg.execute(
        "UPDATE personal_agent_registry SET backend='gcp', user_cloud_project='synthetic-project', user_cloud_region='us-central1', "
        "user_cloud_bootstrap_sa=%s WHERE user_id='synthetic-owner'",
        (bootstrap_email,),
    )
    reservation = pg.execute(
        "SELECT reserve_personal_agent_erasure('synthetic-owner','attempt-one')"
    )[0][0]
    receipt = dict(
        hushhId="ha1_erasure",
        attemptId="attempt-one",
        service="pod-service",
        serviceUid="incarnation",
        revision="pod-service-00001",
        memoryBinding=dict(
            project="synthetic-project",
            location="us-central1",
            engineId="91",
            generationProtocol=2,
            engineIncarnation=dict(
                name="projects/123/locations/us-central1/reasoningEngines/91",
                createTime="2026-09-01T00:00:00Z",
            ),
        ),
    )
    receipt["memoryBinding"]["creationProvenance"] = {
        "version": 1,
        "reservationGeneration": 1,
        "engineIncarnation": dict(receipt["memoryBinding"]["engineIncarnation"]),
    }
    if invalid == "provenance":
        receipt["memoryBinding"]["creationProvenance"]["reservationGeneration"] = True
    elif invalid == "attempt":
        receipt["attemptId"] = "foreign"
    elif invalid == "engine":
        receipt["memoryBinding"]["engineId"] = "other"
    elif invalid == "extra":
        receipt["privateContent"] = "must never persist"
    elif invalid == "guard":
        pg.execute(
            "ALTER TABLE personal_agent_registry DISABLE TRIGGER zz_personal_agent_erasure_registry"
        )
    before = provision_row(pg)

    def retain(value):
        return pg.execute(
            "SELECT retain_erasure_memory_binding(%s,'attempt-one',%s::jsonb,%s::jsonb)",
            (
                "foreign" if invalid == "owner" else "synthetic-owner",
                json.dumps(reservation),
                json.dumps(value),
            ),
        )[0][0]

    assert retain(receipt) is (invalid is None)
    if invalid:
        assert provision_row(pg) == before
        return
    saved = provision_row(pg)
    assert saved["status"] == "suspended"
    assert saved["backend_metadata"]["erasure"] == {**reservation, "memoryBinding": receipt}
    assert retain(receipt)  # Lost caller response is idempotent.
    completed = {"status": "provider_deleted", **receipt}

    def retain_deletion(value):
        return pg.execute(
            "SELECT retain_erasure_memory_deletion('synthetic-owner','attempt-one',%s::jsonb,%s::jsonb)",
            (json.dumps(saved["backend_metadata"]["erasure"]), json.dumps(value)),
        )[0][0]

    assert not retain_deletion({**completed, "status": "pending"})
    assert not retain_deletion({**completed, "serviceUid": "foreign"})
    assert retain_deletion(completed)
    assert retain_deletion(completed)
    saved = provision_row(pg)
    assert saved["backend_metadata"]["erasure"]["memoryDeletion"] == completed

    def retain_inventory(owner="synthetic-owner", attempt="attempt-one", expected=None):
        return pg.execute(
            "SELECT retain_erasure_substrate_inventory(%s,%s,%s::jsonb)",
            (
                owner,
                attempt,
                json.dumps(expected or provision_row(pg)["backend_metadata"]["erasure"]),
            ),
        )[0][0]

    assert not retain_inventory()  # Compute deletion is not yet qualified.
    compute = {
        "serviceName": "projects/synthetic-project/locations/us-central1/services/pod-service",
        "serviceUid": "incarnation",
        "etag": "v1",
        "generation": 1,
        "image": "repo/pod@sha256:" + "a" * 64,
    }

    def retain_compute(stage, value, expected=None):
        return pg.execute(
            "SELECT retain_erasure_compute_receipt('synthetic-owner','attempt-one',%s::jsonb,%s,%s::jsonb)",
            (
                json.dumps(expected or provision_row(pg)["backend_metadata"]["erasure"]),
                stage,
                json.dumps(value),
            ),
        )[0][0]

    for bad in (
        {**compute, "generation": 2},
        {**compute, "serviceUid": "foreign"},
        {**compute, "image": "mutable:tag"},
        {**compute, "extra": "private"},
    ):
        assert not retain_compute("computeAdmission", bad)
    expected = provision_row(pg)["backend_metadata"]["erasure"]
    assert retain_compute("computeAdmission", compute, expected)
    assert not retain_compute(
        "computeAdmission", compute, expected
    )  # Never authorize a second DELETE.
    ack = {
        **compute,
        "operationName": "projects/synthetic-project/locations/us-central1/operations/delete-1",
    }
    assert not retain_compute("computeAcknowledgement", {**ack, "etag": "other"})
    assert not retain_compute(
        "computeAcknowledgement",
        {**ack, "operationName": "projects/foreign/locations/us-central1/operations/delete-1"},
    )
    assert retain_compute("computeAcknowledgement", ack)
    assert retain_compute("computeAcknowledgement", ack)
    assert not retain_compute("computeDeletion", {**ack, "status": "pending"})
    assert retain_compute("computeDeletion", {**ack, "status": "compute_deleted"})
    assert not retain_inventory(owner="foreign")
    assert not retain_inventory(attempt="foreign")
    assert not retain_inventory(expected={"ownerId": "synthetic-owner"})
    before_inventory = provision_row(pg)["backend_metadata"]["erasure"]
    assert not pg.execute(
        "SELECT valid_erasure_substrate_inventory(%s::jsonb,%s::jsonb)",
        (json.dumps(before_inventory), json.dumps({**inventory, "plannedResources": []})),
    )[0][0]
    assert retain_inventory()
    assert retain_inventory()
    saved = provision_row(pg)
    assert saved["backend_metadata"]["erasure"]["substrateInventory"] == inventory
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,"
            "'{erasure,substrateInventory}', '{}'::jsonb) WHERE user_id='synthetic-owner'"
        )
    writer = {
        "ownerId": "synthetic-owner",
        "attemptId": "attempt-one",
        "runtimeIdentity": runtime_identity,
        "bootstrapIdentity": bootstrap_identity,
        "status": "admitted",
    }

    def retain_writer(stage, value, expected=None):
        return pg.execute(
            "SELECT retain_erasure_writer_receipt('synthetic-owner','attempt-one',%s::jsonb,%s,%s::jsonb)",
            (
                json.dumps(
                    expected
                    if expected is not None
                    else provision_row(pg)["backend_metadata"]["erasure"]
                ),
                stage,
                json.dumps(value),
            ),
        )[0][0]

    disabled = {**writer, "status": "disabled"}

    def bucket_preflight():
        return pg.execute(
            "SELECT verify_erasure_bucket_preflight('synthetic-owner','attempt-one',%s::jsonb)",
            (json.dumps(provision_row(pg)["backend_metadata"]["erasure"]),),
        )[0][0]

    assert not bucket_preflight()
    assert not retain_writer("writerDisabled", disabled)
    for bad in (
        {**writer, "ownerId": "foreign"},
        {**writer, "attemptId": "foreign"},
        {**writer, "bootstrapIdentity": runtime_identity},
        {**writer, "runtimeIdentity": {**runtime_identity, "uniqueId": "111111111"}},
        {**writer, "extra": "must-not-retain"},
    ):
        assert not retain_writer("writerAdmission", bad)
    assert not retain_writer("writerAdmission", writer, expected={})
    assert retain_writer("writerAdmission", writer)
    assert not retain_writer("writerAdmission", writer)
    assert retain_writer("writerDisabled", disabled)
    assert retain_writer("writerDisabled", disabled)
    assert bucket_preflight()

    def retain_mail(observation, stage, status):
        return pg.execute(
            "SELECT retain_erasure_mail_receipt('synthetic-owner','attempt-one',%s::jsonb,%s,%s,%s::jsonb)",
            (
                json.dumps(provision_row(pg)["backend_metadata"]["erasure"]),
                observation["type"],
                stage,
                json.dumps(
                    {
                        "ownerId": "synthetic-owner",
                        "attemptId": "attempt-one",
                        "resourceObservation": observation,
                        "status": status,
                    }
                ),
            ),
        )[0][0]

    assert not retain_mail(mail_observations[-1], "admission", "admitted")
    for observation in mail_observations:
        assert not retain_mail(observation, "deletion", "absent")
        assert retain_mail(observation, "admission", "admitted")
        assert not retain_mail(observation, "admission", "admitted")
        assert not retain_mail(observation, "deletion", "absent")
        assert retain_mail(observation, "acknowledgement", "acknowledged")
        assert retain_mail(observation, "deletion", "absent")
        assert retain_mail(observation, "deletion", "absent")
    bucket = {
        "ownerId": "synthetic-owner",
        "attemptId": "attempt-one",
        "bucketIdentity": bucket_identity,
        "metageneration": "4",
        "status": "admitted",
    }

    def retain_bucket(stage, value):
        return pg.execute(
            "SELECT retain_erasure_bucket_receipt('synthetic-owner','attempt-one',%s::jsonb,%s,%s::jsonb)",
            (
                json.dumps(provision_row(pg)["backend_metadata"]["erasure"]),
                stage,
                json.dumps(value),
            ),
        )[0][0]

    assert not retain_bucket("bucketDeletion", {**bucket, "status": "deleted"})
    assert not retain_bucket("bucketAdmission", {**bucket, "ownerId": "foreign"})
    assert not retain_bucket(
        "bucketAdmission", {**bucket, "bucketIdentity": {**bucket_identity, "generation": "11"}}
    )
    assert retain_bucket("bucketAdmission", bucket)
    assert not retain_bucket("bucketAdmission", bucket)
    assert not retain_bucket("bucketDeletion", {**bucket, "status": "deleted"})
    assert retain_bucket("bucketAcknowledgement", {**bucket, "status": "acknowledged"})
    assert retain_bucket("bucketAcknowledgement", {**bucket, "status": "acknowledged"})
    version_name = kms_name + "/cryptoKeyVersions/1"
    kms_inventory = {
        "ownerId": "synthetic-owner",
        "attemptId": "attempt-one",
        "resourceObservation": kms_observation,
        "versionNames": [version_name],
    }

    def retain_kms(stage, receipt):
        return pg.execute(
            "SELECT retain_erasure_kms_receipt('synthetic-owner','attempt-one',%s::jsonb,%s,%s::jsonb)",
            (
                json.dumps(provision_row(pg)["backend_metadata"]["erasure"]),
                stage,
                json.dumps(receipt),
            ),
        )[0][0]

    assert not retain_kms("inventory", kms_inventory)  # Bucket acknowledgement is insufficient.
    assert retain_bucket("bucketDeletion", {**bucket, "status": "deleted"})
    assert not retain_kms("inventory", {**kms_inventory, "ownerId": "foreign"})
    assert not retain_kms("inventory", {**kms_inventory, "versionNames": ["foreign"]})
    assert not retain_kms(
        "inventory", {**kms_inventory, "versionNames": [version_name, version_name]}
    )
    assert retain_kms("inventory", kms_inventory)
    assert retain_kms("inventory", kms_inventory)
    kms_version = {key: value for key, value in kms_inventory.items() if key != "versionNames"}
    kms_version["versionName"] = version_name
    assert not retain_kms("completion", {**kms_inventory, "status": "destroyed"})
    assert not retain_kms("acknowledgement", {**kms_version, "status": "scheduled"})
    assert retain_kms("admission", {**kms_version, "status": "admitted"})
    assert not retain_kms("admission", {**kms_version, "status": "admitted"})
    assert retain_kms("acknowledgement", {**kms_version, "status": "scheduled"})
    assert not retain_kms("completion", {**kms_inventory, "status": "destroyed"})
    assert retain_kms("destruction", {**kms_version, "status": "destroyed"})
    secret_receipt = {
        "ownerId": "synthetic-owner",
        "attemptId": "attempt-one",
        "resourceObservation": secret_observation,
        "etag": "synthetic-etag",
        "status": "admitted",
    }

    def retain_secret(stage, receipt):
        return pg.execute(
            "SELECT retain_erasure_secret_receipt('synthetic-owner','attempt-one',%s::jsonb,%s,%s::jsonb)",
            (
                json.dumps(provision_row(pg)["backend_metadata"]["erasure"]),
                stage,
                json.dumps(receipt),
            ),
        )[0][0]

    assert not retain_secret("admission", secret_receipt)
    assert retain_kms("completion", {**kms_inventory, "status": "destroyed"})
    assert not retain_secret("admission", {**secret_receipt, "ownerId": "foreign"})
    assert not retain_secret("admission", {**secret_receipt, "etag": ""})
    assert not retain_secret("deletion", {**secret_receipt, "status": "absent"})
    assert retain_secret("admission", secret_receipt)
    assert not retain_secret("admission", secret_receipt)
    assert not retain_secret(
        "acknowledgement", {**secret_receipt, "etag": "changed", "status": "acknowledged"}
    )
    assert retain_secret("acknowledgement", {**secret_receipt, "status": "acknowledged"})
    account_receipt = {
        "ownerId": "synthetic-owner",
        "attemptId": "attempt-one",
        "resourceObservation": {
            "type": "service_account",
            "id": runtime_email,
            "disposition": "created",
            "identity": runtime_identity,
        },
        "status": "admitted",
    }

    def retain_account(stage, receipt):
        return pg.execute(
            "SELECT retain_erasure_account_receipt('synthetic-owner','attempt-one',%s::jsonb,%s,%s::jsonb)",
            (
                json.dumps(provision_row(pg)["backend_metadata"]["erasure"]),
                stage,
                json.dumps(receipt),
            ),
        )[0][0]

    assert not retain_account("admission", account_receipt)
    assert retain_secret("deletion", {**secret_receipt, "status": "absent"})
    assert not retain_account("admission", {**account_receipt, "ownerId": "foreign"})
    assert not retain_account(
        "admission",
        {
            **account_receipt,
            "resourceObservation": {
                **account_receipt["resourceObservation"],
                "identity": bootstrap_identity,
            },
        },
    )
    assert not retain_account("deletion", {**account_receipt, "status": "absent"})
    assert retain_account("admission", account_receipt)
    assert not retain_account("admission", account_receipt)
    assert retain_account("acknowledgement", {**account_receipt, "status": "acknowledged"})
    assert retain_account("deletion", {**account_receipt, "status": "absent"})

    def reserve_grants():
        return pg.execute(
            "SELECT reserve_erasure_grant_release('synthetic-owner','attempt-one',%s::jsonb)",
            (json.dumps(provision_row(pg)["backend_metadata"]["erasure"]),),
        )[0][0]

    pg.execute(
        "INSERT INTO byoc_setup_jobs(user_id,job_id,project_id) VALUES ('other-owner','setup-one','synthetic-project')"
    )
    assert not reserve_grants()
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata, "
            "'{erasure,grantRelease}',%s::jsonb) WHERE user_id='synthetic-owner'",
            (
                json.dumps(
                    {
                        "ownerId": "synthetic-owner",
                        "attemptId": "attempt-one",
                        "project": "synthetic-project",
                        "status": "reserved",
                    }
                ),
            ),
        )
    pg.execute("DELETE FROM byoc_setup_jobs WHERE user_id='other-owner'")
    pg.execute(
        "INSERT INTO byoc_setup_jobs(user_id,job_id,project_id,status) VALUES ('synthetic-owner','failed-setup','synthetic-project','failed')"
    )
    assert not reserve_grants()  # A failed setup may retain an uncertain provider call.
    pg.execute("DELETE FROM byoc_setup_jobs WHERE user_id='synthetic-owner'")
    # Hold setup admission uncommitted. Release must wait for its project fence,
    # then see the newly committed dependency instead of revoking underneath it.
    with connect(pg) as setup_conn:
        with setup_conn.cursor() as cursor:
            cursor.execute(
                "INSERT INTO byoc_setup_jobs(user_id,job_id,project_id) VALUES ('other-owner','racing-setup','synthetic-project')"
            )
        started = Event()

        def racing_release():
            started.set()
            return reserve_grants()

        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(racing_release)
            assert started.wait(2)
            try:
                pending.result(timeout=0.2)
                pytest.fail("release bypassed setup project lock")
            except TimeoutError:
                pass
            setup_conn.commit()
            assert pending.result(timeout=5) is False
    pg.execute("DELETE FROM byoc_setup_jobs WHERE user_id='other-owner'")
    # A legacy upsert must not hold the project lock while waiting on the
    # release owner's row. Exercise the ordering with both transactions live.
    expected_release = provision_row(pg)["backend_metadata"]["erasure"]
    with connect(pg) as release_conn, ThreadPoolExecutor(max_workers=1) as pool:
        with release_conn.cursor() as cursor:
            cursor.execute("SET LOCAL statement_timeout='5s'")
            cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended('synthetic-owner',171))")
            cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended('synthetic-owner',198))")
            cursor.execute(
                "SELECT 1 FROM personal_agent_registry WHERE user_id='synthetic-owner' FOR UPDATE"
            )

            def legacy_upsert():
                with connect(pg, application_name="synthetic-grant-upsert") as conn:
                    with conn.cursor() as writer:
                        writer.execute("SET LOCAL statement_timeout='5s'")
                        writer.execute(
                            "INSERT INTO personal_agent_registry(user_id,hushh_id,status,user_cloud_project) "
                            "VALUES ('synthetic-owner','ha1_erasure','provisioning','synthetic-project') "
                            "ON CONFLICT(user_id) DO UPDATE SET status=EXCLUDED.status"
                        )

            upsert = pool.submit(legacy_upsert)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                if pg.execute(
                    "SELECT count(*) FROM pg_stat_activity WHERE application_name='synthetic-grant-upsert' AND wait_event_type='Lock'"
                )[0][0]:
                    break
                time.sleep(0.02)
            else:
                pytest.fail("legacy upsert did not reach the release lock")
            cursor.execute(
                "SELECT reserve_erasure_grant_release('synthetic-owner','attempt-one',%s::jsonb)",
                (json.dumps(expected_release),),
            )
            assert cursor.fetchone()[0] is True
        release_conn.commit()
        with pytest.raises(psycopg2.errors.InsufficientPrivilege):
            upsert.result(timeout=5)
    assert reserve_grants()
    grant_receipt = {
        "ownerId": "synthetic-owner",
        "attemptId": "attempt-one",
        "runtimeIdentity": runtime_identity,
        "bindingObservation": inventory["bindingObservations"][0],
        "status": "admitted",
    }

    def retain_runtime_grant(stage, receipt):
        return pg.execute(
            "SELECT retain_erasure_runtime_grant_receipt('synthetic-owner','attempt-one',%s::jsonb,%s,%s::jsonb)",
            (
                json.dumps(provision_row(pg)["backend_metadata"]["erasure"]),
                stage,
                json.dumps(receipt),
            ),
        )[0][0]

    assert not retain_runtime_grant("deletion", {**grant_receipt, "status": "observed_absent"})
    assert not retain_runtime_grant("admission", {**grant_receipt, "ownerId": "foreign-owner"})
    assert not retain_runtime_grant(
        "admission",
        {
            **grant_receipt,
            "bindingObservation": {
                **grant_receipt["bindingObservation"],
                "disposition": "already_present",
            },
        },
    )
    repository_receipt = {
        "ownerId": "synthetic-owner",
        "attemptId": "attempt-one",
        "repositoryIdentity": repository_identity,
        "bindingObservation": repository_binding,
        "status": "admitted",
    }

    def retain_repository(stage, receipt):
        return pg.execute(
            "SELECT retain_erasure_repository_grant_receipt('synthetic-owner','attempt-one',%s::jsonb,%s,%s::jsonb)",
            (
                json.dumps(provision_row(pg)["backend_metadata"]["erasure"]),
                stage,
                json.dumps(receipt),
            ),
        )[0][0]

    assert not retain_repository("admission", repository_receipt)
    assert retain_runtime_grant("admission", grant_receipt)
    assert not retain_runtime_grant("admission", grant_receipt)
    assert retain_runtime_grant("deletion", {**grant_receipt, "status": "observed_absent"})
    assert retain_runtime_grant("deletion", {**grant_receipt, "status": "observed_absent"})
    assert (
        "acknowledgement"
        not in provision_row(pg)["backend_metadata"]["erasure"]["runtimeGrantErasure"]
    )
    assert not retain_repository("admission", {**repository_receipt, "ownerId": "foreign-owner"})
    assert not retain_repository(
        "admission",
        {
            **repository_receipt,
            "repositoryIdentity": {**repository_identity, "createTime": "2026-09-09T00:00:00Z"},
        },
    )
    assert not retain_repository(
        "admission",
        {
            **repository_receipt,
            "bindingObservation": {
                **repository_binding,
                "member": "serviceAccount:foreign@hub-project.iam.gserviceaccount.com",
            },
        },
    )
    assert retain_repository("admission", repository_receipt)
    assert not retain_repository("admission", repository_receipt)
    repository_inventory = {
        "ownerId": "synthetic-owner",
        "attemptId": "attempt-one",
        "repositoryIdentity": repository_identity,
        "images": [
            {
                "name": repository_identity["name"]
                + "/dockerImages/consent-protocol-pod@sha256:"
                + "a" * 64,
                "uri": "us-central1-docker.pkg.dev/synthetic-project/one-pod/consent-protocol-pod@sha256:"
                + "a" * 64,
            }
        ],
        "paginationComplete": True,
        "classification": "unresolved",
    }

    def retain_image_inventory(receipt):
        return pg.execute(
            "SELECT retain_erasure_repository_inventory('synthetic-owner','attempt-one',%s::jsonb,%s::jsonb)",
            (json.dumps(provision_row(pg)["backend_metadata"]["erasure"]), json.dumps(receipt)),
        )[0][0]

    retention = {
        "ownerId": "synthetic-owner",
        "attemptId": "attempt-one",
        "repositoryIdentity": repository_identity,
        "disposition": "retained_shared",
        "reason": "application_distribution_storage",
    }

    def retain_shared(receipt):
        return pg.execute(
            "SELECT retain_erasure_repository_retention('synthetic-owner','attempt-one',%s::jsonb,%s::jsonb)",
            (json.dumps(provision_row(pg)["backend_metadata"]["erasure"]), json.dumps(receipt)),
        )[0][0]

    assert not retain_shared(retention)
    assert not retain_image_inventory(repository_inventory)
    assert retain_repository("deletion", {**repository_receipt, "status": "observed_absent"})
    assert retain_repository("deletion", {**repository_receipt, "status": "observed_absent"})
    for mutation in (
        {"ownerId": "foreign"},
        {"attemptId": "foreign"},
        {"classification": "complete"},
        {"paginationComplete": False},
        {"repositoryIdentity": {**repository_identity, "createTime": "2026-09-09T00:00:00Z"}},
        {"images": [{"name": "foreign", "uri": "foreign"}]},
        {
            "images": [
                {
                    **repository_inventory["images"][0],
                    "name": repository_inventory["images"][0]["name"].replace(
                        "consent-protocol-pod@", "other-package@"
                    ),
                }
            ]
        },
        {"images": repository_inventory["images"] * 2},
    ):
        assert not retain_image_inventory({**repository_inventory, **mutation})
    assert retain_image_inventory(repository_inventory)
    assert retain_image_inventory(repository_inventory)
    for change in (
        {"ownerId": "foreign"},
        {"attemptId": "foreign"},
        {"repositoryIdentity": {}},
        {"disposition": "deleted"},
        {"reason": "all_information_erased"},
        {"extra": True},
    ):
        assert not retain_shared({**retention, **change})
    assert retain_shared(retention)
    assert retain_shared(retention)
    with pytest.raises(psycopg2.errors.RaiseException):
        with connect(pg) as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    (
                        ROOT
                        / "db/migrations/rollback/932_personal_agent_repository_retention.rollback.sql"
                    ).read_text()
                )
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=backend_metadata #- '{erasure,repositoryInventory}' WHERE user_id='synthetic-owner'"
        )
    with pytest.raises(psycopg2.errors.RaiseException, match="requires preservation"):
        with connect(pg) as rollback_conn, rollback_conn.cursor() as cursor:
            cursor.execute(
                (
                    ROOT
                    / "db/migrations/rollback/931_personal_agent_repository_inventory.rollback.sql"
                ).read_text()
            )
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        pg.execute(
            "INSERT INTO byoc_setup_jobs(user_id,job_id,project_id) VALUES ('other-owner','setup-two','synthetic-project')"
        )
    pg.execute(
        "INSERT INTO byoc_setup_jobs(user_id,job_id,project_id) VALUES ('other-owner','setup-two','unrelated-project')"
    )
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        pg.execute(
            "INSERT INTO personal_agent_registry(user_id,hushh_id,status,user_cloud_project) VALUES ('other-owner','ha1_other','provisioned','synthetic-project')"
        )
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status,user_cloud_project) VALUES ('other-owner','ha1_other','provisioned','unrelated-project')"
    )
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        pg.execute(
            "UPDATE personal_agent_registry SET user_cloud_project='synthetic-project' WHERE user_id='other-owner'"
        )
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        pg.execute(
            "UPDATE byoc_setup_jobs SET project_id='synthetic-project' WHERE user_id='other-owner'"
        )
    assert retain_account("deletion", {**account_receipt, "status": "absent"})
    assert retain_secret("deletion", {**secret_receipt, "status": "absent"})
    saved = provision_row(pg)
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=backend_metadata #- "
            "'{erasure,writerAdmission}' WHERE user_id='synthetic-owner'"
        )
    pg.execute(
        "ALTER TABLE personal_agent_registry DISABLE TRIGGER zz_personal_agent_erasure_registry"
    )
    assert not retain_writer("writerDisabled", disabled)
    assert not retain_runtime_grant("deletion", {**grant_receipt, "status": "observed_absent"})
    assert not retain_repository("deletion", {**repository_receipt, "status": "observed_absent"})
    assert not retain_image_inventory(repository_inventory)
    assert not retain_shared(retention)
    assert not bucket_preflight()
    assert not retain_inventory()  # Even identical retries need the active guard.
    assert not retain(receipt)  # Stored evidence cannot substitute for active fencing.
    assert not retain_deletion(completed)
    pg.execute(
        "ALTER TABLE personal_agent_registry ENABLE TRIGGER zz_personal_agent_erasure_registry"
    )
    receipt["revision"] = "pod-service-00002"
    assert not retain(receipt)
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=backend_metadata #- '{erasure,memoryBinding}' WHERE user_id='synthetic-owner'"
        )
    assert provision_row(pg) == saved


def provision_row(pg):
    return pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id='synthetic-owner'"
    )[0][0]


def publish_provision(pg, before, after, evidence=None, *, attempt="a" * 32):
    return pg.execute(
        "SELECT publish_personal_agent_provision('synthetic-owner',%s,%s,%s,%s::jsonb)",
        (attempt, before, after, json.dumps(evidence or {})),
    )[0][0]


def test_provision_claim_survives_failure_and_rejects_retry(provision_pg):
    pg = provision_pg
    reservation = claim_provision(pg)
    assert reservation["phase"] == "reserved"
    assert publish_provision(pg, "reserved", "failed", {"failureClass": "TimeoutError"})
    row = provision_row(pg)
    assert row["status"] == "suspended"
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        claim_provision(pg, attempt="b" * 32, observed=row)
    assert provision_row(pg) == row
    assert not publish_provision(pg, "reserved", "substrate")
    assert not publish_provision(pg, "failed", "reserved")


def test_provision_claim_refuses_changed_cloud_and_missing_guard(provision_pg):
    pg = provision_pg
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status) VALUES ('synthetic-owner','ha1_provision','pending')"
    )
    before = provision_row(pg)
    pg.execute(
        "UPDATE personal_agent_registry SET user_cloud_region='changed' WHERE user_id='synthetic-owner'"
    )
    with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="observation changed"):
        claim_provision(pg, observed=before)
    pg.execute(
        "ALTER TABLE personal_agent_registry DISABLE TRIGGER zy_personal_agent_provision_registry"
    )
    with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="guards unavailable"):
        claim_provision(pg, observed=provision_row(pg))


def test_provision_publication_preserves_heartbeat_and_refuses_foreign_attempt(provision_pg):
    pg = provision_pg
    claim_provision(pg)
    pg.execute(
        "UPDATE personal_agent_registry SET last_heartbeat_at=now(),health_state='healthy',backend_metadata=backend_metadata || '{\"observed\":{\"revision\":\"synthetic\"}}'::jsonb WHERE user_id='synthetic-owner'"
    )
    assert not publish_provision(pg, "reserved", "substrate", attempt="b" * 32)
    assert publish_provision(pg, "reserved", "substrate", {"resourceIds": ["synthetic-resource"]})
    row = provision_row(pg)
    assert row["backend_metadata"]["observed"] == {"revision": "synthetic"}
    assert row["last_heartbeat_at"] is not None
    assert row["backend_metadata"]["provisionAttempt"]["evidence"]["substrate"]["resourceIds"] == [
        "synthetic-resource"
    ]
    for statement in (
        "UPDATE personal_agent_registry SET status='provisioned'",
        "UPDATE personal_agent_registry SET backend_metadata='{}'",
        "UPDATE personal_agent_registry SET user_cloud_region='foreign-region'",
        "DELETE FROM personal_agent_registry",
    ):
        with pytest.raises(psycopg2.errors.InsufficientPrivilege):
            pg.execute(statement)


def test_erasure_captures_provision_attempt_and_refuses_publication(provision_pg):
    pg = provision_pg
    claim_provision(pg)
    row = provision_row(pg)
    reservation = pg.execute(
        "SELECT reserve_personal_agent_erasure('synthetic-owner','erase-attempt')"
    )[0][0]
    assert reservation["registrySnapshot"] == row
    assert not publish_provision(pg, "reserved", "substrate")
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        claim_provision(pg, attempt="b" * 32, observed=provision_row(pg))
    assert provision_row(pg)["status"] == "suspended"


def test_provision_claim_refuses_deleted_owner(provision_pg):
    pg = provision_pg
    pg.execute(
        "INSERT INTO account_deletion_tombstones(user_id_hash) VALUES ('sha256:' || encode(digest('synthetic-owner','sha256'),'hex'))"
    )
    with pytest.raises(psycopg2.errors.InsufficientPrivilege, match="owner deleted"):
        claim_provision(pg)
    assert pg.execute("SELECT count(*) FROM personal_agent_registry") == [(0,)]


@pytest.mark.parametrize("erasure", [False, True])
def test_late_provision_ack_retains_evidence_without_reopening(provision_pg, erasure):
    pg = provision_pg
    claim_provision(pg)
    assert publish_provision(pg, "reserved", "substrate")
    assert publish_provision(pg, "substrate", "host_requested")
    if erasure:
        pg.execute("SELECT reserve_personal_agent_erasure('synthetic-owner','erase-attempt')")
    else:
        assert publish_provision(pg, "host_requested", "failed")
    before = provision_row(pg)
    ack = {
        "version": 1,
        "ownerId": "synthetic-owner",
        "attemptId": "a" * 32,
        "expectedPhase": "host_requested",
        "nextPhase": "host_requested",
        "evidence": {
            "creationAcknowledgement": {
                "service": "synthetic-service",
                "serviceUid": "synthetic-uid",
            }
        },
    }
    sql = "SELECT retain_personal_agent_provision_ack('synthetic-owner',%s::jsonb)"
    assert pg.execute(sql, (json.dumps({**ack, "attemptId": "b" * 32}),)) == [(False,)]
    assert pg.execute(sql, (json.dumps(ack),)) == [(True,)]
    assert pg.execute(sql, (json.dumps(ack),)) == [(True,)]
    assert pg.execute(sql, (json.dumps({**ack, "evidence": {"serviceUid": "replacement"}}),)) == [
        (False,)
    ]
    after = provision_row(pg)
    assert {k: v for k, v in after.items() if k != "backend_metadata"} == {
        k: v for k, v in before.items() if k != "backend_metadata"
    }
    assert not publish_provision(pg, "host_requested", "host_acknowledged")


def test_provision_null_arguments_never_publish_or_claim(provision_pg):
    pg = provision_pg
    assert pg.execute("SELECT publish_personal_agent_provision(NULL,NULL,NULL,NULL,'{}')") == [
        (False,)
    ]
    claim_provision(pg)
    assert pg.execute(
        "SELECT publish_personal_agent_provision('synthetic-owner',%s,'reserved',NULL,'{}')",
        ("a" * 32,),
    ) == [(False,)]
    assert provision_row(pg)["backend_metadata"]["provisionAttempt"]["phase"] == "reserved"


def test_provision_owner_claim_is_exclusive_in_postgres(provision_pg):
    pg = provision_pg
    desired = json.dumps(
        {
            "user_id": "synthetic-owner",
            "hushh_id": "ha1_provision",
            "phone_e164_hash": "synthetic-hash",
        }
    )
    with ThreadPoolExecutor(max_workers=2) as pool:

        def claim(token):
            try:
                return pg.execute(
                    "SELECT claim_personal_agent_provision('synthetic-owner',%s,NULL,%s::jsonb)",
                    (token * 32, desired),
                )[0][0]["attemptId"]
            except psycopg2.errors.InsufficientPrivilege:
                return None

        results = list(pool.map(claim, ["a", "b"]))
    assert sum(r is not None for r in results) == 1
    assert provision_row(pg)["backend_metadata"]["provisionAttempt"]["attemptId"] in results
