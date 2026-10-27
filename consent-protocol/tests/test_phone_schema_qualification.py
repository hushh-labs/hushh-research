# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Pre-DDL absence and immutable continuation cannot become rollback authority."""

import copy
import hashlib
import importlib
import io
import json
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock
from zipfile import ZipFile

import pytest

from tests.test_phone_bootstrap import _artifact_case
from tests.test_phone_bootstrap import bootstrap_case as shared_bootstrap_case
from tests.test_phone_rollback_release import PRIMARY, ROOT

pytest_plugins = ["tests.test_phone_rollback_release", "tests.test_phone_transfer_authority"]
pytestmark = pytest.mark.feature_auth_reliability
bootstrap_case = shared_bootstrap_case


@pytest.fixture
def schema_case(bootstrap_case):
    state = bootstrap_case
    module = importlib.import_module("schema_qualification")
    state.schema = module
    state.schema_owner = {
        "run_id": "42",
        "run_attempt": 2,
        "workflow_sha": PRIMARY,
        "workflow": module.WORKFLOW,
    }
    state.inventory = {
        "services": {
            "consent-protocol": {
                "uid": "service-uid",
                "generation": 1,
                "controls": "controls",
                "iam": "iam",
                "traffic": "traffic",
            }
        },
        "revisions": {"consent-protocol-old": {"uid": "old-uid"}},
        "jobs": {},
    }
    state.database = {
        "relations_empty": True,
        "phone_unlink_empty": True,
        "database_identity": "database",
        "catalog": "catalog",
        "owned_proxy_exited": True,
    }
    state.database_reads = []

    def database(installed):
        state.database_reads.append(installed)
        return {**state.database, "installed": installed}

    state.schema_ports = SimpleNamespace(
        owner=lambda: copy.deepcopy(state.schema_owner),
        submissions=lambda: {
            "qualification": "passed",
            "authority": "injected-canonical-test-port",
        },
        snapshot=lambda: copy.deepcopy(state.inventory),
        database=database,
        workos=lambda: {"qualification": "passed", "digest": "closed"},
        reference=lambda: {"run_id": "41", "source": "d" * 40, "digest": "healthy"},
    )
    state.baseline = module.preflight(state.prepared, ports=state.schema_ports)
    state.checks = _canonical_checks()
    return state


def _canonical_checks():
    contract = json.loads(
        (ROOT / "consent-protocol/db/contracts/prod_core_schema.json").read_text()
    )
    guard = {
        "status": "ok",
        "violations": [],
        "policy": {"skip_db_check": False, "release_environment": "production"},
        "migrations": {
            "selected_lane_head": contract["expected_schema_head"],
            "expected_contract_version": contract["expected_migration_version"],
        },
    }
    return {
        "guard": guard,
        "backup": {
            "status": "ok",
            "project_id": "hushh-pda",
            "instance": "hushh-vault-db",
            "failures": [],
            "latest_backup": {"id": "backup"},
            "checked_at": datetime.now(timezone.utc).isoformat(),
        },
        "observe": {"mode": "observe", "qualification": "passed", "run_id": "42", "run_attempt": 2},
        "manifest": {
            "environment": "production",
            "git_sha": PRIMARY,
            "release": {"run_id": "42", "run_attempt": "2"},
            "backup_gate": {"backup_report_status": "ok"},
            "migrations": {
                "files": [
                    {
                        "filename": name,
                        "sha256": hashlib.sha256(
                            (ROOT / "consent-protocol/db/migrations" / name).read_bytes()
                        ).hexdigest(),
                    }
                    for name in (
                        "425_account_phone_transfers.sql",
                        "431_phone_recovery_actions.sql",
                    )
                ]
            },
        },
    }


def test_pre_ddl_retry_keeps_original_absence_and_requires_fresh_canonical_checks(
    schema_case,
):
    state = schema_case
    state.schema_owner.update(run_id="43", run_attempt=1)
    recovered = state.schema.continue_preflight(
        state.prepared,
        state.baseline,
        {"artifact_id": 4, "artifact_digest": "immutable"},
        ports=state.schema_ports,
    )
    assert state.database_reads == [False, False]
    assert recovered["database"]["installed"] is False
    assert recovered["current_database"]["installed"] is False
    assert recovered["initial_origin"] == state.baseline["origin"]
    state.checks["observe"].update(run_id="43", run_attempt=1)
    state.checks["manifest"]["release"].update(run_id="43", run_attempt="1")
    proof = state.schema.installed(
        state.prepared, recovered, state.checks, ports=state.schema_ports
    )
    assert state.database_reads == [False, False, True]
    assert proof["dimensions"] == {"installed_schema": "passed", "producer_closure": "passed"}
    assert proof["advance_anchor"] is proof["healthy_release"] is False
    assert "protected_documents_join" in proof["pending"]


def test_unfinished_submission_blocks_schema_mutations_before_database_inspection(
    schema_case, monkeypatch
):
    state = schema_case
    origin = importlib.import_module("schema_origin")

    def unfinished(_start):
        raise ValueError("phone_schema_build_producer_unfinished")

    monkeypatch.setattr(origin, "_builds", unfinished)
    runtime = state.schema.Runtime(state.prepared, "")
    monkeypatch.setattr(runtime, "owner", state.schema_ports.owner)
    state.schema_ports.submissions = runtime.submissions
    state.database_reads.clear()
    for action in (
        lambda: state.schema.preflight(state.prepared, ports=state.schema_ports),
        lambda: state.schema.continue_preflight(
            state.prepared, state.baseline, {}, ports=state.schema_ports
        ),
        lambda: state.schema.installed(
            state.prepared, state.baseline, state.checks, ports=state.schema_ports
        ),
    ):
        with pytest.raises(ValueError, match="producer_unfinished"):
            action()
    assert not state.database_reads


def test_partial_catalog_cannot_reuse_original_absence_intent(schema_case):
    state = schema_case
    state.schema_ports.database = lambda installed: state.schema.inspect_database(
        _database(state.schema, installed=True)[0], installed
    )
    with pytest.raises(ValueError, match="relation_boundary"):
        state.schema.continue_preflight(
            state.prepared, state.baseline, {}, ports=state.schema_ports
        )


def test_owner_change_during_workos_qualification_invalidates_installed_proof(schema_case):
    state = schema_case

    def workos():
        state.schema_owner["run_attempt"] += 1
        return {"qualification": "passed"}

    state.schema_ports.workos = workos
    with pytest.raises(ValueError, match="postmigration_changed"):
        state.schema.installed(
            state.prepared, state.baseline, state.checks, ports=state.schema_ports
        )


@pytest.mark.parametrize(
    "changed", ["issuer", "job", "controls", "database", "rows", "unlink", "source"]
)
def test_continuation_never_replaces_original_absence_with_todays_empty_count(schema_case, changed):
    state = schema_case
    if changed == "issuer":
        state.inventory["revisions"]["consent-protocol-old"]["uid"] = "recreated"
    elif changed == "job":
        state.inventory["jobs"]["unknown"] = {"launcher": "unknown"}
    elif changed == "controls":
        state.inventory["services"]["consent-protocol"]["controls"] = "changed"
    elif changed == "database":
        state.database["database_identity"] = "other-database"
    elif changed == "rows":
        state.database["relations_empty"] = False
    elif changed == "unlink":
        state.database["phone_unlink_empty"] = False
    else:
        state.prepared["source"] = "a" * 40
    with pytest.raises(ValueError):
        state.schema.continue_preflight(
            state.prepared, state.baseline, {}, ports=state.schema_ports
        )


@pytest.mark.parametrize(
    "changed",
    ["lock", "observe", "ledger-policy", "backup", "migration", "new-issuer", "schema-floor"],
)
def test_installed_schema_requires_canonical_migration_and_continuous_producer_boundary(
    schema_case, changed
):
    state = schema_case
    if changed == "lock":
        state.schema_owner["run_attempt"] = 3
    elif changed == "observe":
        state.checks["observe"]["run_attempt"] = 3
    elif changed == "ledger-policy":
        state.checks["guard"]["policy"]["skip_db_check"] = True
    elif changed == "backup":
        state.checks["backup"]["status"] = "failed"
    elif changed == "migration":
        state.checks["manifest"]["migrations"]["files"][0]["sha256"] = "0" * 64
    elif changed == "schema-floor":
        state.checks["guard"]["migrations"] = {
            "selected_lane_head": 428,
            "expected_contract_version": 428,
        }
    else:
        state.inventory["revisions"]["consent-protocol-unowned"] = {"uid": "new"}
    with pytest.raises(ValueError):
        state.schema.installed(
            state.prepared, state.baseline, state.checks, ports=state.schema_ports
        )


def test_final_schema_proof_allows_only_the_exact_retired_cold_runtime(schema_case):
    state = schema_case
    checkpoint = state.checkpoint
    state.inventory["revisions"][checkpoint["qualification"]["revision"]] = {
        "uid": checkpoint["cold_uid"],
        "source": checkpoint["plan"]["source"],
        "image": checkpoint["plan"]["image"],
    }
    state.inventory["services"]["consent-protocol"]["generation"] = 3
    proof = state.schema.installed(
        state.prepared,
        state.baseline,
        state.checks,
        ports=state.schema_ports,
        checkpoint=checkpoint,
    )
    assert proof["runtime_checkpoint"] == state.schema.fingerprint(checkpoint)
    checkpoint["health_tag"] = "leased"
    with pytest.raises(ValueError, match="identity_invalid"):
        state.schema.installed(
            state.prepared,
            state.baseline,
            state.checks,
            ports=state.schema_ports,
            checkpoint=checkpoint,
        )


def _database(module, *, installed=False, occupied=False, unlink=False):
    connection, cursor = MagicMock(), MagicMock()
    connection.cursor.return_value.__enter__.return_value = cursor
    answers = [("hushh_vault", 42)]
    for _table in module.TABLES:
        answers.append((installed,))
        if installed:
            answers.append((occupied,))
    answers.extend([(True,), (unlink,), (installed,), ({"schema": "metadata"},)])
    cursor.fetchone.side_effect = answers
    return connection, cursor


@pytest.mark.parametrize("installed", [False, True])
def test_database_absence_and_empty_are_distinct_read_only_contracts(schema_case, installed):
    module = schema_case.schema
    connection, cursor = _database(module, installed=installed)
    evidence = module.inspect_database(connection, installed)
    assert evidence["installed"] is installed
    assert evidence["relations_empty"] is evidence["phone_unlink_empty"] is True
    assert all(
        call.args[0].lstrip().startswith(("SELECT", "SET LOCAL"))
        for call in cursor.execute.call_args_list
    )
    connection.set_session.assert_called_once_with(
        isolation_level="REPEATABLE READ", readonly=True, autocommit=False
    )
    if installed:
        with pytest.raises(ValueError, match="relation_boundary"):
            module.inspect_database(_database(module, installed=True)[0], False)


@pytest.mark.parametrize("changed", ["authority", "unlink"])
def test_database_rejects_any_authority_or_provider_mutation_receipt(schema_case, changed):
    connection, _ = _database(
        schema_case.schema,
        installed=True,
        occupied=changed == "authority",
        unlink=changed == "unlink",
    )
    with pytest.raises(ValueError, match="(authority_not_empty|unlink_receipt)"):
        schema_case.schema.inspect_database(connection, None)


def _event(service="consent-protocol", method="ReplaceService"):
    return {
        "timestamp": "2026-10-26T01:12:07Z",
        "logName": "projects/hushh-pda/logs/cloudaudit.googleapis.com%2Factivity",
        "resource": {"labels": {"service_name": service}},
        "protoPayload": {
            "serviceName": "run.googleapis.com",
            "methodName": "google.cloud.run.v1.Services." + method,
        },
    }


@pytest.mark.parametrize("changed", [None, "unknown", "deleted", "truncated"])
def test_global_history_cannot_drop_a_deleted_or_unprofiled_issuer(
    schema_case, monkeypatch, changed
):
    module = importlib.import_module("schema_producers")
    event = _event(
        "unprofiled" if changed == "unknown" else "consent-protocol",
        "DeleteService" if changed == "deleted" else "ReplaceService",
    )
    events = [event] * (module.closed.LIMIT if changed == "truncated" else 1)
    monkeypatch.setattr(module.closed, "_document", lambda _command: events)
    if changed is None:
        assert (
            module._service_history({"consent-protocol"}, {"hushh-webapp"}, "2026-10-27T00:00:00Z")
            == 1
        )
    else:
        with pytest.raises(ValueError):
            module._service_history({"consent-protocol"}, {"hushh-webapp"}, "2026-10-27T00:00:00Z")


@pytest.mark.parametrize("changed", [None, "enabled", "secret", "deleted"])
def test_phone_capable_birth_and_retained_inventory_require_literal_recovery_false(
    schema_case, monkeypatch, changed
):
    module = importlib.import_module("schema_producers")
    row = copy.deepcopy(schema_case.revision)
    row["metadata"]["creationTimestamp"] = "2026-10-26T01:12:07Z"
    monkeypatch.setattr(module, "source_capable", lambda _sha: True)
    flag = next(item for item in row["spec"]["containers"][0]["env"] if item["name"] == module.FLAG)
    if changed == "enabled":
        flag["value"] = "true"
    elif changed == "secret":
        flag.pop("value")
        flag["valueFrom"] = {"secretKeyRef": {"name": "flag", "key": "latest"}}
    options = {"check": module.source_capable, "flag": module.FLAG, "closed_key": module.CLOSED_KEY}
    if changed in {"enabled", "secret"}:
        with pytest.raises(ValueError, match="not_directly_closed"):
            module.closed.revision_inventory([row], **options)
        return
    inventory = module.closed.revision_inventory([row], **options)
    event = _event()
    event["protoPayload"]["response"] = {
        "kind": "Service",
        "spec": {
            "template": {
                "metadata": row["metadata"],
                "spec": row["spec"],
            }
        },
        "status": {"latestCreatedRevisionName": row["metadata"]["name"]},
    }
    if changed == "deleted":
        inventory.clear()

    def call():
        return module.closed.review_history(
            [event],
            inventory,
            project="hushh-pda",
            until="2026-10-27T00:00:00Z",
            start=module.HISTORY_START,
            require_retained=True,
            **options,
        )

    if changed:
        with pytest.raises(ValueError, match="historical_issuer"):
            call()
    else:
        assert call() == 1


def test_schema_origin_requires_published_exact_attempt_and_no_started_runtime(
    schema_case, monkeypatch
):
    state = schema_case
    module = importlib.import_module("schema_origin")
    origin, artifact, job, _ = _artifact_case(state)
    artifact["name"] = "prod-phone-schema-intent-42-2"
    job["steps"][0]["name"] = module.UPLOAD
    job["steps"].append({"name": "Deploy backend using Cloud Build", "conclusion": "skipped"})
    archive = io.BytesIO()
    with ZipFile(archive, "w") as bundle:
        bundle.writestr("schema-preflight.json", json.dumps(state.baseline))
    payload = archive.getvalue()
    artifact.update(
        size_in_bytes=len(payload), digest="sha256:" + hashlib.sha256(payload).hexdigest()
    )
    monkeypatch.setattr(module._authorities(), "governed_dispatch", lambda *_args: True)
    monkeypatch.setattr(
        module,
        "_api",
        lambda endpoint: (
            {"total_count": 1, "artifacts": [artifact]}
            if "/artifacts?" in endpoint
            else {"total_count": 1, "jobs": [job]}
            if "/jobs?" in endpoint
            else copy.deepcopy(origin)
        ),
    )
    monkeypatch.setattr(
        module._authorities().retention,
        "run_command",
        lambda *_args, **_kwargs: SimpleNamespace(stdout=payload),
    )
    proof, reference = module.load("42", 2)
    assert proof == state.baseline
    assert reference["artifact_digest"] == artifact["digest"]
    artifact["digest"] = "sha256:" + "0" * 64
    with pytest.raises(RuntimeError, match="digest"):
        module.load("42", 2)
    job["steps"][-1]["conclusion"] = "cancelled"
    with pytest.raises(ValueError, match="requires_reconciliation"):
        module.load("42", 2)


@pytest.mark.parametrize("changed", ["adapter", "schema-contract"])
def test_continuation_binding_covers_replay_adapter_not_only_immutable_sql(
    schema_case, monkeypatch, tmp_path, changed
):
    directory = tmp_path / "consent-protocol/db"
    directory.mkdir(parents=True)
    (directory / "release_migration_manifest.json").write_text('{"ordered_migrations": []}')
    adapter = directory / "firebase_mutation_replay.py"
    adapter.write_text("original replay guard")
    contract = directory / "contracts/prod_core_schema.json"
    contract.parent.mkdir()
    contract.write_text("{}")
    monkeypatch.setattr(schema_case.schema, "ROOT", tmp_path)
    before = schema_case.schema.canonical_binding()
    (adapter if changed == "adapter" else contract).write_text("altered contract")
    assert schema_case.schema.canonical_binding() != before
