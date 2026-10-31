"""Legacy recovery evidence cannot adopt resources or race owner lifecycle."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from threading import Event

import pytest
from sqlalchemy import text

from hushh_mcp.services.byoc_inventory_reconciliation import (
    InventoryReconciliationRefused,
    qualified_inventory,
    reconcile_legacy_gcp_inventory,
)
from hushh_mcp.services.byoc_substrate import RECEIPT_VERSION, plan_digest, resource_ids
from tests.helpers.pod_browser_capability import (
    browser_capability_fixture,
    browser_registry_fixture,
)
from tests.pkm_conformance.postgres_harness import find_pg_bin

NOW = datetime(2026, 10, 22, 4, tzinfo=timezone.utc)


def fixture():
    row, *_ = browser_capability_fixture()
    row.update(
        backend="user_gcp",
        created_at="2026-09-03T17:01:00+00:00",
        provisioned_at="2026-09-03T17:06:00+00:00",
    )
    metadata = row["backend_metadata"]
    storage = metadata["substrateReceipt"]["plannedResources"][:2]
    planned = storage + [
        {"type": kind, "id": rid}
        for kind, rid in (
            ("cloud_run_service", row["external_agent_id"]),
            ("service_account", metadata["runtime_service_account"]),
            ("secret", "one-signing-key"),
            ("artifact_repository", "one-pod"),
            ("pubsub_topic", "one-mail"),
            ("pubsub_subscription", "one-mail-sub"),
            ("cloud_scheduler_job", "one-mail-watch-renew"),
        )
    ]
    original = {
        "version": RECEIPT_VERSION,
        "applied": True,
        "grantRef": "",
        "tenantRef": "owner-project/us-central1",
        "resourceIds": resource_ids({"resources": planned}),
        "planDigest": plan_digest({"resources": planned}),
    }
    metadata["substrateReceipt"] = original
    metadata["unrelated"] = {"preserve": True}
    evidence = {
        "ownerId": row["user_id"],
        "hushhId": row["hushh_id"],
        "serviceUid": metadata["serviceUid"],
        "project": "owner-project",
        "region": "us-central1",
        "projectNumber": "123456789",
        "retentionDays": 400,
        "observedAt": NOW.isoformat(),
    }
    key_id = next(item["id"] for item in storage if item["type"] == "kms_key")
    key = f"projects/owner-project/locations/us-central1/keyRings/hushh-one/cryptoKeys/{key_id}"
    for item in storage:
        kind, rid = item["type"], item["id"]
        current = {"name": key, "purpose": "ENCRYPT_DECRYPT", "createTime": "2026-09-03T17:02:11Z"}
        if kind == "gcs_bucket":
            current = {
                "name": rid,
                "generation": "1788454937307312615",
                "projectNumber": "123456789",
                "timeCreated": "2026-09-03T17:02:11Z",
                "defaultKmsKeyName": key,
            }
        evidence[kind] = {
            "current": current,
            "history": {
                "http": 200,
                "complete": True,
                "from": row["created_at"],
                "through": NOW.isoformat(),
                "entries": [
                    {
                        "insertId": kind + "-create",
                        "timestamp": "2026-09-03T17:02:10Z",
                        "method": "storage.buckets.create"
                        if kind == "gcs_bucket"
                        else "CreateCryptoKey",
                        "resource": f"projects/_/buckets/{rid}" if kind == "gcs_bucket" else key,
                        "principal": row["user_cloud_bootstrap_sa"],
                        "statusCode": 0,
                    }
                ],
            },
        }
    return row, planned, evidence


def test_only_audited_resources_gain_evidence_and_original_receipt_survives():
    row, planned, evidence = fixture()
    original = deepcopy(row)
    result = qualified_inventory(row, planned, evidence, now=NOW)
    assert row == original
    assert (
        result["provenance"]["originalReceipt"] == original["backend_metadata"]["substrateReceipt"]
    )
    assert (
        result["inventory"]["planDigest"]
        == original["backend_metadata"]["substrateReceipt"]["planDigest"]
    )
    assert len(result["inventory"]["plannedResources"]) == 9
    assert {item["type"] for item in result["inventory"]["resourceObservations"]} == {
        "gcs_bucket",
        "kms_key",
    }


@pytest.mark.parametrize(
    "fault",
    [
        "wrong-owner",
        "wrong-incarnation",
        "wrong-project",
        "incomplete",
        "history-gap",
        "wrong-creator",
        "recreated",
        "outside-window",
        "wrong-cmek",
        "invalid-generation",
        "changed-key",
        "wrong-plan",
        "stale",
        "erasure",
        "provision",
        "upgrade",
    ],
)
def test_unqualified_evidence_refuses_without_a_metadata_change(fault):
    row, planned, evidence = fixture()
    if fault == "wrong-owner":
        evidence["ownerId"] = "another-owner"
    elif fault == "wrong-incarnation":
        evidence["serviceUid"] = "replacement"
    elif fault == "wrong-project":
        evidence["project"] = "another-project"
    elif fault == "incomplete":
        evidence["kms_key"]["history"]["complete"] = False
    elif fault == "history-gap":
        evidence["gcs_bucket"]["history"]["from"] = "2026-09-04T00:00:00Z"
    elif fault == "wrong-creator":
        evidence["kms_key"]["history"]["entries"][0]["principal"] = "another@example.com"
    elif fault == "recreated":
        entry = deepcopy(evidence["gcs_bucket"]["history"]["entries"][0])
        entry["insertId"] = "second-create"
        evidence["gcs_bucket"]["history"]["entries"].append(entry)
    elif fault == "outside-window":
        evidence["kms_key"]["current"]["createTime"] = "2026-09-04T17:02:11Z"
    elif fault == "wrong-cmek":
        evidence["gcs_bucket"]["current"]["defaultKmsKeyName"] += "-other"
    elif fault == "invalid-generation":
        evidence["gcs_bucket"]["current"]["generation"] = "0"
    elif fault == "changed-key":
        evidence["kms_key"]["current"]["name"] += "-other"
    elif fault == "wrong-plan":
        row["backend_metadata"]["substrateReceipt"]["planDigest"] = "0" * 16
    elif fault == "stale":
        evidence["observedAt"] = "2026-10-21T00:00:00Z"
    elif fault == "erasure":
        row["backend_metadata"]["erasure"] = {}
    elif fault == "provision":
        row["backend_metadata"]["provisionAttempt"] = {"phase": "reserved"}
    elif fault == "upgrade":
        row["backend_metadata"]["upgradeLease"] = "retained"
    before = deepcopy(row)
    with pytest.raises(InventoryReconciliationRefused):
        qualified_inventory(row, planned, evidence, now=NOW)
    assert row == before


@pytest.fixture
def registry(monkeypatch):
    if find_pg_bin() is None:
        pytest.skip("PostgreSQL unavailable")
    row, planned, evidence = fixture()
    with browser_registry_fixture(monkeypatch, row) as (server, repo, _):
        engine = repo._db()._engine
        with engine.begin() as connection:
            connection.execute(
                text("""UPDATE personal_agent_registry SET backend='user_gcp',
                created_at=:created,provisioned_at=:provisioned WHERE user_id=:owner"""),
                {
                    "created": row["created_at"],
                    "provisioned": row["provisioned_at"],
                    "owner": row["user_id"],
                },
            )

        def read():
            with engine.connect() as connection:
                return dict(
                    connection.execute(
                        text("SELECT * FROM personal_agent_registry WHERE user_id=:o"),
                        {"o": row["user_id"]},
                    )
                    .mappings()
                    .one()
                )

        yield engine, read, read(), planned, evidence


def test_real_guarded_transaction_preserves_state_and_replays_idempotently(registry):
    engine, read, observed, planned, evidence = registry
    args = dict(
        observed=observed,
        planned=planned,
        evidence=evidence,
        now=NOW,
        connection_factory=engine.begin,
    )
    result = reconcile_legacy_gcp_inventory(**args)
    after = read()
    assert after["backend_metadata"]["substrateReceipt"] == result["inventory"]
    assert after["backend_metadata"]["inventoryReconciliation"] == result["provenance"]
    assert after["backend_metadata"]["unrelated"] == {"preserve": True}
    assert {k: v for k, v in after.items() if k not in {"backend_metadata", "updated_at"}} == {
        k: v for k, v in observed.items() if k not in {"backend_metadata", "updated_at"}
    }
    assert "provisionAttempt" not in after["backend_metadata"]
    assert reconcile_legacy_gcp_inventory(**{**args, "now": NOW + timedelta(days=2)}) == result
    assert read() == after
    changed = deepcopy(evidence)
    changed["kms_key"]["history"]["entries"][0]["insertId"] = "changed-proof"
    with pytest.raises(InventoryReconciliationRefused, match="INVENTORY_HOST_CHANGED"):
        reconcile_legacy_gcp_inventory(**{**args, "evidence": changed})
    assert read() == after


@pytest.mark.parametrize(
    "fault",
    [
        "account-tombstone",
        "pod-tombstone",
        "setup",
        "stale-image",
        "unsettled-move",
        "unsettled-authorization",
        "disabled-guard",
    ],
)
def test_actual_lifecycle_guards_refuse_without_partial_publication(registry, fault):
    engine, read, observed, planned, evidence = registry
    with engine.begin() as connection:
        if fault == "account-tombstone":
            import hashlib

            connection.execute(
                text("INSERT INTO account_deletion_tombstones(user_id_hash) VALUES (:h)"),
                {"h": "sha256:" + hashlib.sha256(observed["user_id"].encode()).hexdigest()},
            )
        elif fault == "pod-tombstone":
            connection.execute(
                text("""INSERT INTO personal_agent_deletion_tombstones(hushh_id,status)
                VALUES (:pod,'deleted')"""),
                {"pod": observed["hushh_id"]},
            )
        elif fault in {"setup", "unsettled-authorization"}:
            connection.execute(
                text("""INSERT INTO byoc_setup_jobs(user_id,job_id,project_id,status)
                VALUES (:o,'retained-job','owner-project','running')"""),
                {"o": observed["user_id"]},
            )
            if fault == "unsettled-authorization":
                intent = {
                    "ownerId": observed["user_id"],
                    "jobId": "retained-job",
                    "project": "owner-project",
                    "bootstrapEmail": observed["user_cloud_bootstrap_sa"],
                    "callerEmail": "runtime@hub-project.iam.gserviceaccount.com",
                }
                assert connection.execute(
                    text(
                        "SELECT public.retain_byoc_authorization(:o,'retained-job',CAST(:i AS jsonb))"
                    ),
                    {"o": observed["user_id"], "i": json.dumps(intent)},
                ).scalar_one()
                connection.execute(
                    text("UPDATE byoc_setup_jobs SET status='failed' WHERE user_id=:o"),
                    {"o": observed["user_id"]},
                )
        elif fault == "unsettled-move":
            connection.execute(
                text("""INSERT INTO pod_migration_jobs
                (user_id,job_id,hushh_id,target_project,status,error_code)
                VALUES (:o,'uncertain-move',:pod,'owner-project','failed','SWITCH_OUTCOME_UNKNOWN')"""),
                {"o": observed["user_id"], "pod": observed["hushh_id"]},
            )
        elif fault == "disabled-guard":
            connection.execute(
                text(
                    "ALTER TABLE personal_agent_registry DISABLE TRIGGER zy_personal_agent_provision_registry"
                )
            )
        else:
            connection.execute(
                text("""UPDATE personal_agent_registry SET backend_metadata=
                jsonb_set(backend_metadata,'{image}','\"replacement\"') WHERE user_id=:o"""),
                {"o": observed["user_id"]},
            )
    before = read()
    with pytest.raises(InventoryReconciliationRefused):
        reconcile_legacy_gcp_inventory(
            observed=observed,
            planned=planned,
            evidence=evidence,
            now=NOW,
            connection_factory=engine.begin,
        )
    assert read() == before


def test_old_transaction_snapshot_cannot_publish(registry):
    engine, read, observed, planned, evidence = registry

    @contextmanager
    def old_snapshot():
        with engine.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
            with connection.begin():
                yield connection

    with pytest.raises(InventoryReconciliationRefused, match="INVENTORY_GUARDS_UNAVAILABLE"):
        reconcile_legacy_gcp_inventory(
            observed=observed,
            planned=planned,
            evidence=evidence,
            now=NOW,
            connection_factory=old_snapshot,
        )
    assert read() == observed


def test_failed_commit_rolls_back_both_inventory_and_provenance(registry):
    engine, read, observed, planned, evidence = registry

    @contextmanager
    def abort():
        with engine.begin() as connection:
            yield connection
            raise RuntimeError("synthetic lost transaction")

    with pytest.raises(RuntimeError, match="lost transaction"):
        reconcile_legacy_gcp_inventory(
            observed=observed, planned=planned, evidence=evidence, now=NOW, connection_factory=abort
        )
    assert read() == observed


def test_lifecycle_lock_serializes_reconciliation_and_rechecks_after_wait(registry):
    engine, read, observed, planned, evidence = registry
    started, entered = Event(), Event()

    @contextmanager
    def connect():
        with engine.begin() as connection:
            entered.set()
            yield connection

    def publish():
        started.set()
        return reconcile_legacy_gcp_inventory(
            observed=observed,
            planned=planned,
            evidence=evidence,
            now=NOW,
            connection_factory=connect,
        )

    with ThreadPoolExecutor(max_workers=1) as pool:
        with engine.begin() as holder:
            holder.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:o,171))"),
                {"o": observed["user_id"]},
            )
            future = pool.submit(publish)
            assert started.wait(5) and entered.wait(5)
            assert not future.done()
            holder.execute(
                text("""UPDATE personal_agent_registry SET backend_metadata=
                jsonb_set(backend_metadata,'{image}','\"replacement\"') WHERE user_id=:o"""),
                {"o": observed["user_id"]},
            )
        with pytest.raises(InventoryReconciliationRefused, match="INVENTORY_HOST_CHANGED"):
            future.result(timeout=5)
    assert "inventoryReconciliation" not in read()["backend_metadata"]
