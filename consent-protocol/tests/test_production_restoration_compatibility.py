"""Exact-source and installed-schema boundaries for production restoration."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from zipfile import ZipFile

import pytest

ROOT = Path(__file__).resolve().parents[2]
pytestmark = [pytest.mark.feature_account_deletion, pytest.mark.trace_loop]


def _reviewed_record():
    policy = '{"version": 1}\n'
    record = {
        "schemaVersion": 1,
        "project": "hushh-pda",
        "region": "us-central1",
        "sourceSha": "a" * 40,
        "baselineSha": "b" * 40,
        "previousSha": "c" * 40,
        "providerContractVersion": 2,
        "migrations": "none",
        "replacementAccounts": 0,
        "services": ["consent-protocol", "hushh-webapp"],
        "authorityPolicySha256": hashlib.sha256(policy.encode()).hexdigest(),
        "requiredAbsentTables": [
            "account_phone_transfers",
            "account_phone_auth_fences",
            "account_phone_recovery_continuations",
            "account_device_actions",
        ],
        "requiredEmptyTables": [
            "document_delivery_contracts",
            "document_delivery_financial_bindings",
            "document_delivery_cleanup",
        ],
    }
    return policy, record


@pytest.mark.parametrize(
    "failure",
    [
        None,
        "source",
        "policy",
        "writable",
        "database",
        "contract",
        "phone",
        "phone_actions",
        "generation",
        "documents",
    ],
)
def test_production_restoration_requires_exact_source_and_read_only_compatible_schema(
    monkeypatch, tmp_path, failure
):
    spec = importlib.util.spec_from_file_location(
        "restoration_contract", ROOT / "deploy/account-deletion/compatibility_restoration.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    policy, record = _reviewed_record()
    path = tmp_path / "reviewed.json"
    path.write_text(json.dumps(record))
    monkeypatch.setattr(module, "RECORD", path)
    monkeypatch.setattr(
        module,
        "git",
        lambda *args: (
            ('{"version": 0}' if failure == "policy" else policy) if args[0] == "show" else ""
        ),
    )
    answers = iter(
        [
            ("off" if failure == "writable" else "on",),
            ("postgres" if failure == "database" else "hushh_vault",),
            (1 if failure == "contract" else 2, True),
            ("account_phone_transfers" if failure == "phone" else None,),
            (None,),
            (None,),
            ("account_device_actions" if failure == "phone_actions" else None,),
            (failure == "generation",),
            (failure == "documents",),
            (False,),
            (False,),
        ]
    )
    statements = []

    class Cursor:
        def execute(self, statement, parameters=None):
            statements.append(statement)

        def fetchone(self):
            return next(answers)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    connection = SimpleNamespace(cursor=Cursor)

    def qualify():
        approved = module.qualify_source("d" * 40 if failure == "source" else "a" * 40)
        return module.qualify_schema(connection, approved, require_empty_documents=True)

    if failure:
        with pytest.raises(module.Refused):
            qualify()
    else:
        assert qualify() == {
            "providerContractVersion": 2,
            "replacementAccounts": 0,
            "documentsChecked": True,
        }
    assert all(
        str(statement).startswith(("SELECT", "SHOW", "Composed([SQL('SELECT"))
        for statement in statements
    )


def test_recovery_validation_keeps_authority_before_candidate_and_separate_verdict():
    import yaml

    workflow = yaml.safe_load((ROOT / ".github/workflows/main-post-merge-smoke.yml").read_text())
    assert workflow["permissions"] == {"contents": "read"}
    job = workflow["jobs"]["smoke-gate"]
    assert "Production Recovery Validation Gate" in job["name"]
    assert "environment" not in job
    steps = job["steps"]
    names = [step.get("name") for step in steps]
    assert names.index("Admit exact validation source") < names.index("Checkout admitted candidate")
    admission = next(step for step in steps if step.get("id") == "source")
    assert 'test "$GITHUB_REF" = refs/heads/main' in admission["run"]
    assert 'authority["qualify_source"](sha)' in admission["run"]
    assert "assert-governed-actor.py --surface production" in admission["run"]
    for step in steps:
        if step.get("uses", "").startswith("actions/checkout@"):
            assert step["with"]["persist-credentials"] is False
        if step.get("uses", "").startswith("actions/cache/save@"):
            assert "!inputs.production_restoration" in step["if"]
    assert "source-secret-scan" in next(
        step["run"] for step in steps if step.get("name") == "Record exact recovery validation"
    )


def _artifact_receipt(module, receipt, run, failure):
    archive = BytesIO()
    with ZipFile(archive, "w") as bundle:
        bundle.writestr("acceptance.json", json.dumps(receipt))
    payload = archive.getvalue()
    digest = "sha256:" + hashlib.sha256(payload).hexdigest()
    artifact = module.select_artifact(
        {
            "total_count": 1,
            "artifacts": [
                {
                    "id": 34,
                    "expired": failure == "artifact",
                    "name": "production-restoration-validation-12-2",
                    "workflow_run": {"id": 12},
                    "size_in_bytes": len(payload),
                    "digest": digest,
                }
            ],
        },
        run,
    )
    return module.acceptance.unpack(
        payload, "sha256:" + "0" * 64 if failure == "digest" else artifact["digest"]
    )


@pytest.mark.parametrize(
    "failure", [None, "attempt", "actor", "verdict", "step", "receipt", "artifact", "digest"]
)
def test_hosted_recovery_proof_refuses_incomplete_or_misattributed_authority(failure):
    spec = importlib.util.spec_from_file_location(
        "recovery_validation", ROOT / "deploy/account-deletion/restoration_validation.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    run = {
        "id": 12,
        "path": module.WORKFLOW,
        "event": "workflow_dispatch",
        "head_branch": "main",
        "repository": {"full_name": module.acceptance.REPOSITORY},
        "status": "completed",
        "conclusion": "failure" if failure == "attempt" else "success",
        "head_sha": "a" * 40,
        "run_attempt": 2,
        "actor": {"login": "owner"},
        "triggering_actor": {"login": "other" if failure == "actor" else "owner"},
    }
    job = {
        "run_id": 12,
        "head_sha": "a" * 40,
        "name": "Main Post-Merge Smoke Gate" if failure == "verdict" else module.GATE,
        "status": "completed",
        "conclusion": "success",
        "steps": [
            {
                "name": name,
                "status": "completed",
                "conclusion": "skipped" if failure == "step" else "success",
            }
            for name in module.STEPS
        ],
    }
    _, record = _reviewed_record()
    receipt = {
        "schemaVersion": 1,
        "status": "passed",
        "candidateSha": record["sourceSha"],
        "baselineSha": record["baselineSha"],
        "workflowSha": "a" * 40,
        "recordSha256": "d" * 64,
        "repository": module.acceptance.REPOSITORY,
        "runId": 12,
        "runAttempt": 1 if failure == "receipt" else 2,
        "checks": module.CHECKS,
    }

    def verify():
        module.qualify_run(run, run_id=12, allowed={"owner"})
        module.qualify_jobs({"total_count": 1, "jobs": [job]}, run)
        unpacked = _artifact_receipt(module, receipt, run, failure)
        module.qualify_receipt(unpacked, record, run, "d" * 64)

    if failure:
        with pytest.raises((module.authority.Refused, module.acceptance.Refused)):
            verify()
    else:
        verify()


def test_document_restoration_fence_drains_real_writers_and_preserves_empty_cascades():
    import threading
    import time
    from unittest.mock import patch

    import psycopg2

    from tests.pkm_conformance import postgres_harness

    if postgres_harness.find_pg_bin() is None:
        pytest.fail("Restoration writer barrier requires disposable PostgreSQL")
    spec = importlib.util.spec_from_file_location(
        "document_fence", ROOT / "deploy/account-deletion/document_restoration_fence.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    server = postgres_harness.TempPostgres()
    writer = installer = observer = None
    thread = None
    try:
        with patch.object(postgres_harness, "MIGRATIONS", []):
            server.start()
        dsn = f"postgresql://hushh@/postgres?host={server.dir}&port={server.port}"
        writer, installer, observer = [psycopg2.connect(dsn) for _ in range(3)]
        with writer:
            with writer.cursor() as cursor:
                cursor.execute("CREATE TABLE drive_share_requests(id int PRIMARY KEY)")
                cursor.execute(
                    "CREATE TABLE document_delivery_contracts("
                    "id int PRIMARY KEY REFERENCES drive_share_requests(id) ON DELETE CASCADE)"
                )
                for table in module.TABLES[1:]:
                    cursor.execute(f"CREATE TABLE {table}(id int PRIMARY KEY)")
                cursor.execute("INSERT INTO drive_share_requests VALUES(1),(2)")
        with writer.cursor() as cursor:
            cursor.execute("INSERT INTO document_delivery_contracts VALUES(1)")
        outcomes = []

        def install():
            try:
                outcomes.append(
                    module.install(installer, source="a" * 40, run_id="12", database="postgres")
                )
            except module.Refused as exc:
                outcomes.append(str(exc))

        thread = threading.Thread(target=install)
        thread.start()
        deadline = time.monotonic() + 5
        with observer.cursor() as cursor:
            while time.monotonic() < deadline:
                cursor.execute(
                    "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=%s AND NOT granted)",
                    (installer.get_backend_pid(),),
                )
                if cursor.fetchone()[0]:
                    break
                time.sleep(0.02)
            else:
                pytest.fail("Installer did not wait for the uncommitted writer")
        writer.commit()
        thread.join(timeout=5)
        assert not thread.is_alive()
        assert outcomes == ["retained_documents_require_reader"]
        with writer:
            with writer.cursor() as cursor:
                cursor.execute("DELETE FROM drive_share_requests WHERE id=1")
        proof = module.install(installer, source="a" * 40, run_id="12", database="postgres")
        assert proof["status"] == "installed"
        module.verify(observer, source="a" * 40, run_id="12")
        with pytest.raises(module.Refused, match="unconfirmed"):
            module.verify(observer, source="a" * 40, run_id="13")
        assert (
            module.install(installer, source="a" * 40, run_id="12", database="postgres")["status"]
            == "confirmed"
        )
        with pytest.raises(module.Refused, match="another_operation"):
            module.install(installer, source="a" * 40, run_id="13", database="postgres")
        with pytest.raises(psycopg2.Error) as refused, writer, writer.cursor() as cursor:
            cursor.execute("INSERT INTO document_delivery_contracts VALUES(2)")
        assert refused.value.pgcode == "55000"
        with writer, writer.cursor() as cursor:
            cursor.execute("DELETE FROM drive_share_requests WHERE id=2")
            assert cursor.rowcount == 1
        with writer, writer.cursor() as cursor:
            cursor.execute(f"DROP TRIGGER {module.TRIGGER} ON document_delivery_contracts")
            cursor.execute(
                f"CREATE TRIGGER {module.TRIGGER} BEFORE INSERT ON document_delivery_contracts "
                f"FOR EACH STATEMENT WHEN(false) EXECUTE FUNCTION public.{module.FUNCTION}()"
            )
            cursor.execute(
                f"ALTER TABLE document_delivery_contracts ENABLE ALWAYS TRIGGER {module.TRIGGER}"
            )
        with pytest.raises(module.Refused, match="registration_changed"):
            module.install(installer, source="a" * 40, run_id="12", database="postgres")
    finally:
        if writer:
            writer.rollback()
        if thread and thread.is_alive():
            if installer:
                installer.cancel()
            thread.join(timeout=5)
        for connection in (writer, installer, observer):
            if connection:
                connection.close()
        server.stop()
