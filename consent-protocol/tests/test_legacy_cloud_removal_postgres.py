"""Existing fenced legacy removals require native identity, custody and settlement."""

import json
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import psycopg2
import pytest

from db.migration_authority import build_manifest_entries
from db.private_agent_adoption import execution_sql
from hushh_mcp.services.azure_teardown_inventory import AzureTeardownRefused
from tests.helpers.private_agent_adoption import canonical_database
from tests.test_migrations_are_replay_safe import replay_pg as replay_pg
from tests.test_personal_agent_cloud_removal_postgres import _row, _value

MIGRATIONS = Path(__file__).resolve().parents[1] / "db/migrations"
FOUNDATION = "420_private_agent_lifecycle_foundation.sql"


@pytest.fixture
def legacy_recovery_pg(monkeypatch):
    from tests.standby_postgres_support import seed_primary
    from tests.test_personal_agent_notification_checkpoint import _notification_server

    server = _notification_server(monkeypatch)
    root = Path(__file__).resolve().parents[1]
    try:
        for name in (
            "960_owner_erasure_provider_outcomes.sql",
            "961_azure_setup_erasure_binding.sql",
            "962_azure_owner_cleanup_admission.sql",
            "963_personal_agent_operator_mail_custody.sql",
            "972_personal_agent_cloud_removal.sql",
        ):
            server.apply_file(root / "db/migrations/parked" / name)
        server.apply_file(root / "db/migrations/421_cloud_removal_recovery.sql")
        server.apply_file(root / "db/migrations/parked/985_legacy_cloud_removal_recovery.sql")
        owner, project = "legacy-owner", "owner-project"
        resources = [
            {"type": "cloud_run_service", "id": "svc-legacy-owner"},
            {"type": "gcs_bucket", "id": "legacy-bucket"},
            {"type": "service_account", "id": "runtime@owner-project.iam.gserviceaccount.com"},
            {"type": "pubsub_topic", "id": "projects/hushh-pda/topics/legacy-gone"},
        ]
        image = "registry.example/pod@sha256:" + "a" * 64
        seed_primary(
            server,
            owner=owner,
            project=project,
            metadata={
                "image": image,
                "image_digest": "sha256:" + "a" * 64,
                "runtime_service_account": resources[2]["id"],
                "substrateReceipt": {
                    "plannedResources": resources,
                    "applied": True,
                    "version": "byoc.substrate.receipt.v1",
                    "resourceIds": [r["id"] for r in resources],
                },
            },
        )
        server.execute(
            "UPDATE personal_agent_registry SET user_cloud_bootstrap_sa='bootstrap@owner-project.iam.gserviceaccount.com' WHERE user_id=%s",
            (owner,),
        )
        server.execute(
            "INSERT INTO byoc_setup_jobs(user_id,job_id,project_id,status) VALUES (%s,'legacy-setup',%s,'recorded')",
            (owner, project),
        )
        snapshot = server.execute(
            "SELECT to_jsonb(p) FROM personal_agent_registry p WHERE user_id=%s", (owner,)
        )[0][0]
        snapshot_hash = server.execute(
            "SELECT encode(sha256(convert_to(%s::jsonb::text,'UTF8')),'hex')",
            (json.dumps(snapshot),),
        )[0][0]
        reservation = server.execute(
            "SELECT reserve_personal_agent_cloud_removal(%s,%s)", (owner, snapshot_hash)
        )[0][0]
        assert reservation is not None
        review = server.execute(
            "SELECT encode(sha256(convert_to(personal_agent_cloud_removal_review(%s::jsonb)::text,'UTF8')),'hex')",
            (json.dumps(reservation),),
        )[0][0]
        assert (
            server.execute(
                "SELECT approve_personal_agent_cloud_removal(%s,%s,%s,%s)",
                (owner, reservation["attemptId"], review, project),
            )[0][0]
            is True
        )
        assert (
            server.execute(
                "SELECT begin_personal_agent_cloud_removal(%s,%s,%s)",
                (owner, reservation["attemptId"], review),
            )[0][0]
            is True
        )
        engine = f"projects/{project}/locations/us-central1/reasoningEngines/91"
        plan = {
            "version": 1,
            "controlProject": "hushh-pda-dev",
            "ownerId": owner,
            "accountGeneration": 0,
            "attemptId": reservation["attemptId"],
            "placementEpoch": 0,
            "snapshotSha256": snapshot_hash,
            "sourceRevision": "a" * 40,
            "actor": "synthetic-operator@example.test",
            "observedAt": "2026-11-05T00:00:00Z",
            "termsVersion": "gcp-legacy-native-removal-v1",
            "project": {
                "projectId": project,
                "projectNumber": "123456789012",
                "createTime": "2026-09-03T00:00:00Z",
            },
            "runtime": {
                "serviceName": f"projects/{project}/locations/us-central1/services/svc-legacy-owner",
                "serviceUid": "incarnation-1",
                "revision": "svc-legacy-owner-00021",
                "image": image,
                "generation": 21,
                "etag": "native-etag",
                "principal": {
                    "projectId": project,
                    "email": resources[2]["id"],
                    "uniqueId": "123456789012345",
                },
            },
            "memory": {
                "bucket": "legacy-bucket",
                "object": "log/memory_bank.json",
                "generation": "123",
                "sha256": "b" * 64,
                "engineName": engine,
                "engineCreateTime": "2026-09-03T01:00:00Z",
            },
            "resources": [
                {
                    **item,
                    "identity": {"name": item["id"]},
                    "authority": "observe_only"
                    if item["id"].startswith("projects/hushh-pda/")
                    else "owner_reviewed",
                }
                for item in resources
            ]
            + [
                {
                    "type": "reasoning_engine",
                    "id": engine,
                    "identity": {"name": engine, "createTime": "2026-09-03T01:00:00Z"},
                    "authority": "owner_reviewed",
                },
                {
                    "type": "project_iam_policy",
                    "id": project,
                    "identity": {"bindings": []},
                    "authority": "owner_reviewed",
                },
                {
                    "type": "bootstrap_access",
                    "id": "bootstrap@owner-project.iam.gserviceaccount.com",
                    "identity": {
                        "account": {
                            "email": "bootstrap@owner-project.iam.gserviceaccount.com",
                            "uniqueId": "123456789012346",
                            "projectId": project,
                        },
                        "bindings": [],
                    },
                    "authority": "owner_reviewed",
                },
            ],
        }
        yield server, owner, reservation, plan
    finally:
        server.stop()


def test_legacy_recovery_preserves_original_history_and_refuses_foreign_identity(
    legacy_recovery_pg,
):
    from copy import deepcopy

    pg, owner, reservation, plan = legacy_recovery_pg
    before = _row(pg, owner)
    for path, value in (("ownerId", "foreign"), ("attemptId", "foreign")):
        bad = {**plan, path: value}
        assert (
            _value(
                pg,
                "SELECT retain_legacy_cloud_removal(%s,%s,%s,%s::jsonb)",
                owner,
                reservation["attemptId"],
                plan["snapshotSha256"],
                json.dumps(bad),
            )
            is None
        )
    changed = deepcopy(plan)
    changed["runtime"]["serviceUid"] = "foreign-incarnation"
    assert (
        _value(
            pg,
            "SELECT legacy_cloud_removal_plan_valid(%s::jsonb,%s::jsonb)",
            json.dumps(reservation),
            json.dumps(changed),
        )
        is False
    )
    recovery = _value(
        pg,
        "SELECT retain_legacy_cloud_removal(%s,%s,%s,%s::jsonb)",
        owner,
        reservation["attemptId"],
        plan["snapshotSha256"],
        json.dumps(plan),
    )
    assert recovery is not None
    assert _row(pg, owner) == before
    assert recovery["events"] == []
    assert (
        _value(pg, "SELECT legacy_cloud_removal_complete(%s,%s)", owner, reservation["attemptId"])
        is False
    )
    with pytest.raises(psycopg2.Error, match="forward recovery required"):
        pg.apply_file(
            Path(__file__).resolve().parents[1]
            / "db/migrations/rollback/985_legacy_cloud_removal_recovery.rollback.sql"
        )


def test_legacy_recovery_session_loss_never_supplies_exit_or_provider_ack(legacy_recovery_pg):
    from uuid import uuid4

    from hushh_mcp.services.legacy_cloud_removal import LegacyRemovalJournal, resource_key

    pg, owner, reservation, plan = legacy_recovery_pg
    attempt = reservation["attemptId"]
    with closing(
        psycopg2.connect(host=pg.dir, port=pg.port, user="hushh", dbname="postgres")
    ) as worker:
        worker.autocommit = True
        journal = LegacyRemovalJournal(worker, owner, attempt)
        recovery = journal.prepare(plan)
        journal.append(
            "$approval",
            "approval",
            {
                "planSha256": recovery["planSha256"],
                "ownerId": owner,
                "confirmation": "owner-project",
            },
        )
        started = journal.start(uuid4().hex, plan["sourceRevision"])
        resource = next(item for item in plan["resources"] if item["type"] == "service_account")
        identity = journal.identity_sha256(resource)
        journal.append(
            resource_key(resource),
            "writer_intent",
            {"identitySha256": identity, "requestId": uuid4().hex, "method": "POST"},
        )
        request = {
            "identitySha256": identity,
            "requestId": uuid4().hex,
            "targetSha256": "c" * 64,
            "method": "POST",
        }
        journal.append(resource_key(resource), "provider_dispatch", request)
        supervisor = LegacyRemovalJournal(pg._conn, owner, attempt)
        with pytest.raises(AzureTeardownRefused):
            supervisor.start(uuid4().hex, plan["sourceRevision"])
        with pytest.raises(AzureTeardownRefused):
            supervisor.append(
                resource_key(resource),
                "writer_disabled",
                {
                    "identitySha256": identity,
                    "status": "disabled",
                    "nativeReadbackSha256": "d" * 64,
                    "credentialDenied": True,
                },
            )
        with pytest.raises(AzureTeardownRefused):
            supervisor.append(
                "$executor",
                "executor_exit",
                {
                    **started,
                    "supervisorVerified": True,
                    "processExitCode": 0,
                    "outcome": "returned",
                },
            )
        with pytest.raises(AzureTeardownRefused):
            journal.append(
                resource_key(resource), "provider_dispatch", {**request, "requestId": uuid4().hex}
            )
        worker.close()
    # Loss of the original SQL session is still neither worker exit nor settlement.
    assert _value(pg, "SELECT legacy_cloud_removal_complete(%s,%s)", owner, attempt) is False
    with pytest.raises(AzureTeardownRefused):
        supervisor.start(uuid4().hex, plan["sourceRevision"])
    supervisor.append(
        "$executor",
        "executor_exit",
        {**started, "supervisorVerified": True, "processExitCode": 1, "outcome": "failed"},
    )
    supervisor.start(uuid4().hex, plan["sourceRevision"])
    assert _value(pg, "SELECT legacy_cloud_removal_complete(%s,%s)", owner, attempt) is False


def test_legacy_recovery_finalization_requires_every_resource_and_actual_exit(legacy_recovery_pg):
    from uuid import uuid4

    from hushh_mcp.services.legacy_cloud_removal import LegacyRemovalJournal, resource_key

    pg, owner, reservation, plan = legacy_recovery_pg
    worker = psycopg2.connect(host=pg.dir, port=pg.port, user="hushh", dbname="postgres")
    worker.autocommit = True
    try:
        journal = LegacyRemovalJournal(worker, owner, reservation["attemptId"])
        recovery = journal.prepare(plan)
        journal.append(
            "$approval",
            "approval",
            {
                "planSha256": recovery["planSha256"],
                "ownerId": owner,
                "confirmation": "owner-project",
            },
        )
        started = journal.start(uuid4().hex, plan["sourceRevision"])
        account = next(item for item in plan["resources"] if item["type"] == "service_account")
        journal.append(
            resource_key(account),
            "writer_intent",
            {
                "identitySha256": journal.identity_sha256(account),
                "requestId": uuid4().hex,
                "method": "POST",
            },
        )
        journal.append(
            resource_key(account),
            "writer_disabled",
            {
                "identitySha256": journal.identity_sha256(account),
                "status": "disabled",
                "nativeReadbackSha256": "d" * 64,
                "credentialDenied": True,
            },
        )
        order = {
            "cloud_run_service": 0,
            "reasoning_engine": 1,
            "gcs_bucket": 2,
            "service_account": 3,
            "pubsub_topic": 4,
            "project_iam_policy": 5,
            "bootstrap_access": 6,
        }
        for resource in sorted(plan["resources"], key=lambda item: order[item["type"]]):
            identity = journal.identity_sha256(resource)
            if resource["authority"] == "observe_only":
                journal.append(
                    resource_key(resource),
                    "observation",
                    {
                        "identitySha256": identity,
                        "status": "observed_absent",
                        "httpStatus": 404,
                        "nativeReadbackSha256": "d" * 64,
                        "operationName": None,
                        "operationDone": None,
                        "coverage": {},
                    },
                )
                continue
            request = uuid4().hex
            operation = (
                "projects/owner-project/locations/us-central1/operations/" + request
                if resource["type"] in {"cloud_run_service", "reasoning_engine"}
                else None
            )
            journal.append(
                resource_key(resource),
                "intent",
                {"identitySha256": identity, "requestId": request, "method": "DELETE"},
            )
            if resource["type"] == "reasoning_engine":
                with pytest.raises(AzureTeardownRefused):
                    journal.append(
                        resource_key(resource),
                        "checkpoint",
                        {
                            "identitySha256": identity,
                            "stage": "memoryBinding",
                            "value": {**plan["memory"], "generation": "foreign"},
                        },
                    )
                journal.append(
                    resource_key(resource),
                    "checkpoint",
                    {"identitySha256": identity, "stage": "memoryBinding", "value": plan["memory"]},
                )
            journal.append(
                resource_key(resource),
                "acknowledgement",
                {
                    "identitySha256": identity,
                    "requestId": request,
                    "httpStatus": 200,
                    "operationName": operation,
                },
            )
            if resource["type"] == "gcs_bucket":
                with pytest.raises(AzureTeardownRefused):
                    journal.append(
                        resource_key(resource),
                        "observation",
                        {
                            "identitySha256": identity,
                            "status": "deleted",
                            "httpStatus": 404,
                            "nativeReadbackSha256": "d" * 64,
                            "operationName": None,
                            "operationDone": False,
                            "coverage": {},
                        },
                    )
                for stage, status in [
                    ("bucketAdmission", "admitted"),
                    ("bucketAcknowledgement", "acknowledged"),
                    ("bucketDeletion", "deleted"),
                ]:
                    journal.append(
                        resource_key(resource),
                        "checkpoint",
                        {
                            "identitySha256": identity,
                            "stage": stage,
                            "value": {
                                "bucketIdentity": resource["identity"],
                                "metageneration": "1",
                                "status": status,
                            },
                        },
                    )
            journal.append(
                resource_key(resource),
                "observation",
                {
                    "identitySha256": identity,
                    "status": "deleted",
                    "httpStatus": 200
                    if resource["type"] in {"project_iam_policy", "bootstrap_access"}
                    else 404,
                    "nativeReadbackSha256": "d" * 64,
                    "operationName": operation,
                    "operationDone": bool(operation),
                    "coverage": {
                        "complete": True,
                        "pendingOperations": 0,
                        "remainingRevisions": 0,
                        "bindingsAbsent": True,
                    },
                },
            )
        assert (
            _value(
                pg, "SELECT legacy_cloud_removal_complete(%s,%s)", owner, reservation["attemptId"]
            )
            is False
        )
        with pytest.raises(
            psycopg2.errors.InsufficientPrivilege, match="project grant release reserved"
        ):
            pg.execute("SELECT assert_project_grant_admission('owner-project')")
    finally:
        worker.close()
    supervisor = LegacyRemovalJournal(pg._conn, owner, reservation["attemptId"])
    # A dead executor session releases its SQL locks, while the durable grant
    # intent continues to block a replacement setup until removal finalizes.
    with pytest.raises(
        psycopg2.errors.InsufficientPrivilege, match="project grant release reserved"
    ):
        pg.execute("SELECT assert_project_grant_admission('owner-project')")
    supervisor.append(
        "$executor",
        "executor_exit",
        {**started, "processExitCode": 0, "outcome": "returned", "supervisorVerified": True},
    )
    assert (
        _value(pg, "SELECT legacy_cloud_removal_complete(%s,%s)", owner, reservation["attemptId"])
        is True
    )
    assert (
        _value(
            pg,
            "SELECT finalize_personal_agent_cloud_removal(%s,%s,%s)",
            owner,
            reservation["attemptId"],
            recovery["planSha256"],
        )
        is True
    )
    pg.execute("SELECT assert_project_grant_admission('owner-project')")
    assert _row(pg, owner)["status"] == "unprovisioned"
    assert (
        _value(
            pg,
            "SELECT finalize_personal_agent_cloud_removal(%s,%s,%s)",
            owner,
            reservation["attemptId"],
            recovery["planSha256"],
        )
        is True
    )


def test_legacy_operator_retains_uncertain_dispatch_and_refuses_foreign_writes(monkeypatch):
    import requests

    from hushh_mcp.services.legacy_cloud_removal_native import RecoverySession, resource_url

    resource = {
        "type": "service_account",
        "id": "runtime@owner-project.iam.gserviceaccount.com",
        "identity": {"uniqueId": "123456789012345"},
        "authority": "owner_reviewed",
    }
    plan = {
        "attemptId": "a" * 32,
        "project": {"projectId": "owner-project"},
        "runtime": {"serviceName": "projects/owner-project/locations/us-central1/services/pod"},
    }
    events = []
    journal = SimpleNamespace(
        read=lambda: {"plan": plan, "events": []},
        identity_sha256=lambda _: "a" * 64,
        append=lambda resource, stage, receipt: events.append((stage, receipt)),
    )
    submitted = []

    def lost_response(*args, **kwargs):
        submitted.append((args, kwargs))
        raise requests.Timeout("synthetic lost response")

    monkeypatch.setattr(requests.Session, "request", lost_response)
    with RecoverySession(token=uuid4().hex, project="owner-project", journal=journal) as session:
        session.resource = resource
        with pytest.raises(AzureTeardownRefused):
            session.delete(
                "https://iam.googleapis.com/v1/projects/hushh-pda/serviceAccounts/foreign"
            )
        assert submitted == events == []
        with pytest.raises(requests.Timeout):
            session.post(
                resource_url("owner-project", "us-central1", resource) + ":disable", json={}
            )
    assert [stage for stage, _ in events] == ["provider_dispatch"]
    assert len(submitted) == 1
    assert submitted[0][1]["allow_redirects"] is False


def test_legacy_probe_grant_cleanup_preserves_concurrent_iam(monkeypatch):
    from copy import deepcopy

    import requests

    from hushh_mcp.services.legacy_cloud_removal_writer import cached_writer_probe

    resource = {
        "type": "service_account",
        "id": "runtime@owner-project.iam.gserviceaccount.com",
        "identity": {"uniqueId": "123456789012345"},
    }
    policy = {
        "etag": "etag-1",
        "version": 3,
        "bindings": [{"role": "roles/viewer", "members": ["user:existing@example.test"]}],
    }
    checkpoints = {}

    def response(body):
        value = requests.Response()
        value.status_code = 200
        value._content = json.dumps(body).encode()
        return value

    def post(url, *, json=None, params=None):
        nonlocal policy
        if url.endswith(":getIamPolicy"):
            return response(policy)
        if url.endswith(":generateAccessToken"):
            policy["bindings"][-1]["members"].append("user:concurrent@example.test")
            policy["bindings"].append(
                {"role": "roles/editor", "members": ["user:another@example.test"]}
            )
            policy["etag"] = "concurrent-etag"
            return response({"accessToken": "synthetic-probe-token"})
        assert json["policy"]["etag"] == policy["etag"]
        policy = deepcopy(json["policy"])
        policy["etag"] += "-next"
        return response(policy)

    worker = SimpleNamespace(
        project="owner-project",
        region="us-central1",
        plan={"runtime": {"principal": {"email": resource["id"]}}, "attemptId": "a" * 32},
        session=SimpleNamespace(get=lambda *a, **k: response(policy), post=post),
        _resource=lambda *a: (
            resource if a[0] == "service_account" else {"type": "gcs_bucket", "id": "owner-bucket"}
        ),
        _intent=lambda *a, **k: {},
        _checkpoints=lambda _: {},
        _checkpoint=lambda _, stage, value: checkpoints.update({stage: value}),
    )
    monkeypatch.setattr(requests.Session, "get", lambda *a, **k: response({}))
    assert cached_writer_probe(worker, actor="operator@example.test") == "synthetic-probe-token"
    assert policy["bindings"][0] == {
        "role": "roles/viewer",
        "members": ["user:existing@example.test"],
    }
    assert policy["bindings"][1]["members"] == ["user:concurrent@example.test"]
    assert policy["bindings"][2] == {
        "role": "roles/editor",
        "members": ["user:another@example.test"],
    }
    assert "temporaryGrantRemoved" in checkpoints


def test_legacy_cloud_removal_successor_survives_replay_and_refuses_drift(replay_pg, monkeypatch):
    from db.legacy_cloud_removal_adoption import PINS, qualification_sql

    entries = build_manifest_entries(MIGRATIONS, [FOUNDATION, "421_cloud_removal_recovery.sql"])
    [recovery] = build_manifest_entries(
        MIGRATIONS / "parked", ["985_legacy_cloud_removal_recovery.sql"]
    )
    [resume] = build_manifest_entries(
        MIGRATIONS / "parked", ["986_legacy_cloud_removal_resume.sql"]
    )
    connection, _ = canonical_database(replay_pg, monkeypatch)
    with closing(connection), connection.cursor() as cursor:
        for entry in entries:
            cursor.execute(execution_sql(entry))
        cursor.execute(execution_sql(recovery))
        cursor.execute(execution_sql(resume))
        before = {
            signature: cursor.execute("SELECT pg_get_functiondef(%s::regprocedure)", (signature,))
            or cursor.fetchone()[0]
            for signature in PINS
        }
        for entry in [resume, recovery, *entries]:
            cursor.execute(execution_sql(entry))
        for signature, definition in before.items():
            cursor.execute("SELECT pg_get_functiondef(%s::regprocedure)", (signature,))
            assert cursor.fetchone()[0] == definition
        # The original replay really rejects this successor; a relaxed column
        # allowance without complete-family qualification is not the solution.
        with pytest.raises(psycopg2.Error):
            cursor.execute(entries[0].sql)
        cursor.execute("ROLLBACK")
        for mutation in (
            "GRANT EXECUTE ON FUNCTION legacy_cloud_removal_complete(text,text) TO authenticated",
            "ALTER FUNCTION legacy_cloud_removal_complete(text,text) SECURITY DEFINER",
            "ALTER TABLE personal_agent_cloud_removals DISABLE TRIGGER zz_personal_agent_cloud_removal",
        ):
            cursor.execute("BEGIN")
            cursor.execute(mutation)
            with pytest.raises(psycopg2.Error, match="Unqualified legacy removal"):
                cursor.execute(qualification_sql())
            cursor.execute("ROLLBACK")
        cursor.execute(
            (MIGRATIONS / "rollback/986_legacy_cloud_removal_resume.rollback.sql").read_text()
        )
        cursor.execute(
            (MIGRATIONS / "rollback/985_legacy_cloud_removal_recovery.rollback.sql").read_text()
        )
        cursor.execute("SELECT to_regprocedure('public.legacy_cloud_removal_complete(text,text)')")
        assert cursor.fetchone()[0] is None
        for entry in entries:
            cursor.execute(execution_sql(entry))


def test_exited_probe_adopts_source_then_admits_only_compute_until_native_writer_proof(
    legacy_recovery_pg,
):
    from copy import deepcopy
    from datetime import datetime, timezone

    from hushh_mcp.services.legacy_cloud_removal import (
        LegacyRemovalJournal,
        operator_source,
        resource_key,
    )

    pg, owner, reservation, plan = legacy_recovery_pg
    [resume] = build_manifest_entries(
        MIGRATIONS / "parked", ["986_legacy_cloud_removal_resume.sql"]
    )
    # This older lifecycle fixture retains predecessor PUBLIC ACLs. The
    # canonical-database replay test above qualifies the complete ACL family.
    pg.execute(resume.sql)
    attempt = reservation["attemptId"]
    supervisor = LegacyRemovalJournal(pg._conn, owner, attempt)
    original = supervisor.prepare(plan)
    supervisor.append(
        "$approval",
        "approval",
        {
            "planSha256": original["planSha256"],
            "ownerId": owner,
            "confirmation": "owner-project",
        },
    )
    adoption = {
        "previousSourceRevision": plan["sourceRevision"],
        "sourceRevision": "f" * 40,
        "planSha256": original["planSha256"],
        "actor": plan["actor"],
    }
    account = next(r for r in plan["resources"] if r["type"] == "service_account")
    compute = next(r for r in plan["resources"] if r["type"] == "cloud_run_service")
    memory = next(r for r in plan["resources"] if r["type"] == "reasoning_engine")
    account_key, compute_key = resource_key(account), resource_key(compute)
    identity = supervisor.identity_sha256(account)

    def connect():
        conn = psycopg2.connect(host=pg.dir, port=pg.port, user="hushh", dbname="postgres")
        conn.autocommit = True
        return conn

    with closing(connect()) as conn:
        old = LegacyRemovalJournal(conn, owner, attempt)
        started = old.start(uuid4().hex, plan["sourceRevision"])
        intent = {"identitySha256": identity, "requestId": uuid4().hex, "method": "POST"}
        old.append(account_key, "writer_intent", intent)
        dispatch = {**intent, "targetSha256": "b" * 64}
        old.append(account_key, "provider_dispatch", dispatch)
        old.append(
            account_key,
            "provider_ack",
            {
                "identitySha256": identity,
                "requestId": intent["requestId"],
                "targetSha256": dispatch["targetSha256"],
                "httpStatus": 200,
                "bodySha256": "c" * 64,
                "operationName": None,
            },
        )
        old.append(
            account_key,
            "writer_acknowledgement",
            {
                **{k: v for k, v in intent.items() if k != "method"},
                "httpStatus": 200,
                "operationName": None,
            },
        )
        with pytest.raises(AzureTeardownRefused):
            supervisor.append("$executor", "operator_source", adoption)
    # A vanished database session is insufficient: require the real supervisor receipt.
    with pytest.raises(AzureTeardownRefused):
        supervisor.append("$executor", "operator_source", adoption)
    supervisor.append(
        "$executor",
        "executor_exit",
        {
            **started,
            "supervisorVerified": True,
            "processExitCode": 1,
            "outcome": "failed",
        },
    )
    prefix = supervisor.read()

    def valid(prefix, receipt=adoption):
        event = {
            "sequence": len(prefix["events"]),
            "stage": "operator_source",
            "resource": "$executor",
            "receipt": receipt,
            "recordedAt": datetime.now(timezone.utc).isoformat(),
        }
        return _value(
            pg,
            "SELECT legacy_cloud_removal_event_valid(%s::jsonb,%s::jsonb)",
            json.dumps(prefix),
            json.dumps(event),
        )

    assert valid(prefix) is True
    for changed in ("sourceRevision", "previousSourceRevision", "actor", "planSha256"):
        assert valid(prefix, {**adoption, changed: "foreign"}) is False
    for mutation in ("lost_ack", "pending_operation", "stale_approval"):
        bad = deepcopy(prefix)
        if mutation == "lost_ack":
            bad["events"] = [e for e in bad["events"] if e["stage"] != "provider_ack"]
        elif mutation == "pending_operation":
            next(e for e in bad["events"] if e["stage"] == "provider_ack")["receipt"][
                "operationName"
            ] = "pending"
        else:
            next(e for e in bad["events"] if e["stage"] == "approval")["recordedAt"] = (
                "2020-01-01T00:00:00Z"
            )
        assert valid(bad) is False
    supervisor.append("$executor", "operator_source", adoption)
    assert supervisor.read()["plan"] == original["plan"]
    assert operator_source(supervisor.read()) == adoption["sourceRevision"]
    with closing(connect()) as conn:
        journal = LegacyRemovalJournal(conn, owner, attempt)
        with pytest.raises(AzureTeardownRefused):
            journal.start(uuid4().hex, plan["sourceRevision"])
        journal.start(uuid4().hex, adoption["sourceRevision"])

        def admit(resource):
            journal.append(
                resource_key(resource),
                "intent",
                {
                    "identitySha256": journal.identity_sha256(resource),
                    "requestId": uuid4().hex,
                    "method": "DELETE",
                },
            )

        with pytest.raises(AzureTeardownRefused):
            admit(compute)
        value = {
            "runtimeIdentity": plan["runtime"]["principal"],
            "status": "disabled",
            "nativeReadbackSha256": "d" * 64,
        }
        with pytest.raises(AzureTeardownRefused):
            journal.append(
                account_key,
                "checkpoint",
                {
                    "identitySha256": identity,
                    "stage": "disabledWriterComputeAdmission",
                    "value": {**value, "runtimeIdentity": {"uniqueId": "foreign"}},
                },
            )
        journal.append(
            account_key,
            "checkpoint",
            {
                "identitySha256": identity,
                "stage": "disabledWriterComputeAdmission",
                "value": value,
            },
        )
        admit(compute)
        with pytest.raises(AzureTeardownRefused):
            admit(memory)
        writer = {
            "identitySha256": identity,
            "status": "disabled",
            "runtimeIdentity": plan["runtime"]["principal"],
            "bootstrapIdentity": next(
                r for r in plan["resources"] if r["type"] == "bootstrap_access"
            )["identity"]["account"],
            "computeReceiptSha256": "e" * 64,
        }
        with pytest.raises(AzureTeardownRefused):
            journal.append(account_key, "native_writer_disabled_after_compute", writer)
        intent = next(e["receipt"] for e in journal.read()["events"] if e["stage"] == "intent")
        operation = "projects/owner-project/locations/us-central1/operations/delete"
        journal.append(
            compute_key,
            "acknowledgement",
            {
                "identitySha256": intent["identitySha256"],
                "requestId": intent["requestId"],
                "httpStatus": 200,
                "operationName": operation,
            },
        )
        observation = {
            "identitySha256": intent["identitySha256"],
            "status": "deleted",
            "httpStatus": 404,
            "nativeReadbackSha256": "d" * 64,
            "operationName": operation,
            "operationDone": True,
            "coverage": {"complete": True, "pendingOperations": 0, "remainingRevisions": 0},
        }
        with pytest.raises(AzureTeardownRefused):
            journal.append(compute_key, "observation", {**observation, "operationDone": False})
        journal.append(compute_key, "observation", observation)
        writer["computeReceiptSha256"] = journal.identity_sha256({"identity": observation})
        with pytest.raises(AzureTeardownRefused):
            journal.append(
                account_key,
                "native_writer_disabled_after_compute",
                {**writer, "bootstrapIdentity": {}},
            )
        journal.append(account_key, "native_writer_disabled_after_compute", writer)
        assert "credentialDenied" not in writer
        admit(memory)
        assert not any(e["stage"] == "writer_disabled" for e in journal.read()["events"])
        with pytest.raises(psycopg2.Error, match="forward recovery required"):
            pg.apply_file(MIGRATIONS / "rollback/986_legacy_cloud_removal_resume.rollback.sql")


async def test_gcp_legacy_incompatibility_refuses_before_reservation_or_fence(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock

    from hushh_mcp.services import (
        personal_agent_hosting_inspection,
        personal_agent_provisioning_service,
        pod_migration_transport,
    )
    from hushh_mcp.services.personal_agent_cloud_removal import inspect_gcp

    row = {
        "user_id": "legacy-owner",
        "hushh_id": "ha1_legacy",
        "status": "provisioned",
        "backend_metadata": {
            "serviceUid": "uid",
            "service": "legacy-service",
            "url": "https://legacy.run.app",
        },
    }
    backend = SimpleNamespace(
        observe_erasure_target=AsyncMock(
            return_value={
                "serviceUid": "uid",
                "service": "legacy-service",
                "podUrl": "https://legacy.run.app",
                "revision": "legacy-service-00021",
            }
        )
    )
    store = SimpleNamespace(
        registry=object(), candidate_digest=AsyncMock(return_value="a" * 64), reserve=AsyncMock()
    )
    monkeypatch.setattr(
        personal_agent_provisioning_service,
        "PersonalAgentProvisioningService",
        lambda **kw: object(),
    )
    monkeypatch.setattr(
        personal_agent_hosting_inspection,
        "recorded_owner_backend",
        lambda *a, **kw: (backend, object()),
    )
    preflight = Mock()
    monkeypatch.setattr(pod_migration_transport, "verify_erasure_compatibility", preflight)
    with pytest.raises(
        pod_migration_transport.PodMigrationTransportError, match="compatibility repair"
    ):
        await inspect_gcp(store, "legacy-owner", row)
    store.reserve.assert_not_awaited()
    preflight.assert_not_called()
