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
        "requiredAbsentTables": ["account_phone_transfers", "account_phone_auth_fences"],
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
