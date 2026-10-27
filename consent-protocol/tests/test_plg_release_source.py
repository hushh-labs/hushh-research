"""A recorded PLG source cannot smuggle unrelated code or grant deployment."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "deploy/plg/release_source.py"


def _load():
    spec = importlib.util.spec_from_file_location("plg_source_contract", MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _source_tools(repository):
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment.update(
        GIT_AUTHOR_NAME="Source fixture",
        GIT_COMMITTER_NAME="Source fixture",
        GIT_AUTHOR_EMAIL="source@example.invalid",
        GIT_COMMITTER_EMAIL="source@example.invalid",
    )

    def git(*args, input=None):
        return subprocess.run(  # noqa: S603 -- fixed Git executable in a disposable test repository.
            ["git", *args],
            cwd=repository,
            env=environment,
            input=input,
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        ).stdout.strip()

    def put(path, content):
        target = repository / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def commit(parent=None):
        git("add", "--all")
        tree = git("write-tree")
        parents = ["-p", parent] if parent else []
        return git("commit-tree", tree, *parents, "-m", "Synthetic source fixture")

    return git, put, commit


@pytest.fixture
def source_repo(tmp_path, monkeypatch, request):
    module = _load()
    repository = tmp_path / "synthetic-source"
    repository.mkdir()
    git, put, commit = _source_tools(repository)
    git("init", "--quiet")
    policy = '{"version":1}\n'
    before = 'MEMORY_SQL = "SELECT 1"\n'
    after = 'MEMORY_SQL = "SELECT 1 FROM source CROSS JOIN LATERAL (SELECT 1) event"\n'
    put(module.RUNTIME, before)
    put(module.POLICY, policy)
    put(module.MANIFEST, "# Blocking tests\ntests/existing.py\n")
    put("hushh-webapp/lib/auth/session-owner.ts", "export const owner = 'existing';\n")
    put("contracts/plg/observations.json", '{"version":1}\n')
    put("deploy/backend-image.cloudbuild.yaml", "steps: []\n")
    for path, content in getattr(request, "param", {}).items():
        put(path, content)
    baseline = commit()
    put(module.RUNTIME, after)
    put(module.SOURCE_TEST, "def test_existing_contract():\n    assert True\n")
    put(
        module.MANIFEST,
        "# Blocking tests\ntests/existing.py\n"
        + module.SOURCE_TEST.removeprefix("consent-protocol/")
        + "\n",
    )
    source = commit(baseline)
    digest = hashlib.sha256(policy.encode()).hexdigest()
    monkeypatch.setattr(module, "ROOT", repository)
    monkeypatch.setattr(module, "BASELINE_SHA", baseline)
    monkeypatch.setattr(module, "POLICY_SHA256", digest)
    monkeypatch.setattr(
        module,
        "RUNTIME_SHA256",
        {
            "before": hashlib.sha256(before.encode()).hexdigest(),
            "after": hashlib.sha256(after.encode()).hexdigest(),
        },
    )
    monkeypatch.setattr(
        module,
        "FIXED_RECORD",
        {
            **module.FIXED_RECORD,
            "baselineSha": baseline,
            "frontendSha": baseline,
            "authorityPolicySha256": digest,
        },
    )
    record_path = tmp_path / "main-owned-production-source.json"
    monkeypatch.setattr(module, "RECORD", record_path)

    def record_for(sha):
        changes = []
        for path, status in module.ALLOWED_CHANGES.items():
            changes.append(
                {
                    "path": path,
                    "status": status,
                    "beforeBlob": None if status == "A" else git("rev-parse", f"{baseline}:{path}"),
                    "afterBlob": git("rev-parse", f"{sha}:{path}"),
                }
            )
        return {**module.FIXED_RECORD, "sourceSha": sha, "changes": changes}

    def write_record(record):
        record_path.write_text(json.dumps(record), encoding="utf-8")

    record = record_for(source)
    write_record(record)
    return module, source, record, put, commit, record_for, write_record


def test_only_exact_recorded_source_qualifies_without_traffic_authority(source_repo):
    module, source, _, _, _, _, _ = source_repo
    proof = module.qualify_source(source)
    assert proof["sourceSha"] == source
    assert proof["sourceQualified"] is True
    assert proof["trafficAuthorized"] is False
    assert proof["migrations"] == "none"
    assert proof["protectedPaths"]["hushh-webapp"] is not None
    assert module.qualify_recorded_source() == proof
    with pytest.raises(module.Refused):
        module.qualify_source("f" * 40)


@pytest.mark.parametrize(
    "path",
    [
        "consent-protocol/api/routes/new_product.py",
        "hushh-webapp/lib/auth/session-owner.ts",
        "contracts/plg/observations.json",
        "consent-protocol/config/account-deletion-authority.json",
        "consent-protocol/requirements.txt",
    ],
)
def test_even_a_resealed_record_cannot_admit_unrelated_source(source_repo, path):
    module, source, _, put, commit, record_for, write_record = source_repo
    put(path, "unreviewed change\n")
    changed = commit(source)
    write_record(record_for(changed))
    with pytest.raises(module.Refused, match="Unreviewed changes outside"):
        module.qualify_source(changed)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("baselineSha", "0" * 40),
        ("frontendSha", "0" * 40),
        ("authorityPolicySha256", "0" * 64),
        ("project", "hushh-pda-uat"),
        ("migrations", "replay"),
        ("replacementAccounts", 1),
        ("services", ["consent-protocol", "hushh-webapp"]),
    ],
)
def test_canonical_record_cannot_expand_the_fixed_boundary(source_repo, field, value):
    module, source, record, _, _, _, write_record = source_repo
    write_record({**record, field: value})
    with pytest.raises(module.Refused):
        module.qualify_source(source)


def test_record_cannot_supply_an_additional_allowlist(source_repo):
    module, source, record, _, _, _, write_record = source_repo
    write_record({**record, "allowedPaths": ["consent-protocol/api/routes/new_product.py"]})
    with pytest.raises(module.Refused, match="fields changed"):
        module.qualify_source(source)


def test_exact_runtime_pin_rejects_a_different_change_in_the_allowed_file(source_repo):
    module, source, _, put, commit, record_for, write_record = source_repo
    put(module.RUNTIME, 'MEMORY_SQL = "SELECT unrelated_information"\n')
    changed = commit(source)
    write_record(record_for(changed))
    with pytest.raises(module.Refused, match="runtime body changed"):
        module.qualify_source(changed)


@pytest.mark.parametrize(
    "lines",
    [
        ["tests/existing.py", "{test}", "{test}"],
        ["{test}"],
        ["tests/existing.py", "tests/other.py"],
    ],
)
def test_manifest_preserves_existing_tests_and_registers_regression_once(source_repo, lines):
    module, source, _, put, commit, record_for, write_record = source_repo
    entry = module.SOURCE_TEST.removeprefix("consent-protocol/")
    put(
        module.MANIFEST,
        "# Blocking tests\n" + "\n".join(line.format(test=entry) for line in lines) + "\n",
    )
    changed = commit(source)
    write_record(record_for(changed))
    with pytest.raises(module.Refused):
        module.qualify_source(changed)


def test_record_blob_pins_and_duplicate_json_keys_are_not_ambiguous(source_repo):
    module, source, record, _, _, _, write_record = source_repo
    record["changes"][0]["afterBlob"] = "f" * 40
    write_record(record)
    with pytest.raises(module.Refused, match="blob or file mode"):
        module.qualify_source(source)
    module.RECORD.write_text('{"sourceSha":"a","sourceSha":"b"}', encoding="utf-8")
    with pytest.raises(module.Refused, match="Duplicate"):
        module.qualify_source(source)


@pytest.mark.parametrize(
    "source_repo",
    [
        {"consent-protocol/api/retained.py": "phone_unlink\n"},
        {"consent-protocol/api/retained.py": "account_phone_transfers\n"},
    ],
    indirect=True,
)
def test_even_unchanged_phone_producers_cannot_inherit_source_admission(source_repo):
    module, source, _, _, _, _, _ = source_repo
    with pytest.raises(module.Refused, match="phone producer absence"):
        module.qualify_source(source)


@pytest.mark.parametrize(
    "source_repo",
    [
        {"consent-protocol/config/account-deletion-authority.json": '{"version":2}\n'},
    ],
    indirect=True,
)
def test_unchanged_but_incompatible_authority_policy_cannot_qualify(source_repo):
    module, source, _, _, _, _, _ = source_repo
    with pytest.raises(module.Refused, match="authority policy changed"):
        module.qualify_source(source)


@pytest.fixture
def hosted_validation():
    spec = importlib.util.spec_from_file_location(
        "plg_hosted_contract", ROOT / "deploy/plg/validation.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    run = {
        "id": 19,
        "path": module.WORKFLOW,
        "event": "workflow_dispatch",
        "head_branch": "main",
        "head_sha": "a" * 40,
        "run_attempt": 2,
        "status": "completed",
        "conclusion": "success",
        "updated_at": "fixed",
        "repository": {"full_name": module.transport.REPOSITORY},
        "actor": {"login": "operator"},
        "triggering_actor": {"login": "operator"},
    }
    record = {"sourceSha": "b" * 40, "baselineSha": "c" * 40}
    receipt = {
        "schemaVersion": 1,
        "status": "passed",
        "candidateSha": record["sourceSha"],
        "baselineSha": record["baselineSha"],
        "workflowSha": run["head_sha"],
        "recordSha256": "d" * 64,
        "repository": module.transport.REPOSITORY,
        "runId": run["id"],
        "runAttempt": 2,
        "checks": module.CHECKS,
        "postgresRegression": {
            "path": module.authority.SOURCE_TEST,
            "passed": 1,
            "failed": 0,
            "skipped": 0,
        },
        "backendTests": {"passed": 100, "failed": 0, "errors": 0, "skipped": 3},
    }
    return module, run, record, receipt


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("event", "push"),
        ("head_branch", "feature"),
        ("path", "other.yml"),
        ("conclusion", "failure"),
        ("run_attempt", True),
        ("actor", {"login": "outsider"}),
        ("triggering_actor", {"login": "outsider"}),
    ],
)
def test_hosted_validation_requires_main_authority_and_both_actors(hosted_validation, field, value):
    module, run, _, _ = hosted_validation
    module.qualify_run(run, run_id=19, allowed={"operator"})
    with pytest.raises(module.authority.Refused):
        module.qualify_run({**run, field: value}, run_id=19, allowed={"operator"})


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("candidateSha", "e" * 40),
        ("baselineSha", "e" * 40),
        ("runAttempt", 1),
        ("schemaVersion", True),
        ("checks", ["full-backend"]),
        ("postgresRegression", {"path": "other.py", "passed": 1, "failed": 0, "skipped": 0}),
        (
            "postgresRegression",
            {
                "path": "consent-protocol/tests/test_plg_memory_query_postgres.py",
                "passed": True,
                "failed": 0,
                "skipped": 0,
            },
        ),
        ("backendTests", {"passed": 1, "failed": 0, "errors": 1, "skipped": 0}),
        ("backendTests", {"passed": 0, "failed": 0, "errors": 0, "skipped": 1}),
    ],
)
def test_receipt_cannot_substitute_source_attempt_or_executed_tests(
    hosted_validation, field, value
):
    module, run, record, receipt = hosted_validation
    module.qualify_receipt(receipt, record, run, "d" * 64)
    with pytest.raises(module.authority.Refused):
        module.qualify_receipt({**receipt, field: value}, record, run, "d" * 64)


def test_skipped_gate_step_and_prior_attempt_artifact_cannot_qualify(hosted_validation):
    module, run, _, _ = hosted_validation
    job = {
        "run_id": run["id"],
        "head_sha": run["head_sha"],
        "name": module.GATE,
        "status": "completed",
        "conclusion": "success",
        "steps": [
            {"name": name, "status": "completed", "conclusion": "success"} for name in module.STEPS
        ],
    }
    module.qualify_jobs({"total_count": 1, "jobs": [job]}, run)
    job["steps"][0]["conclusion"] = "skipped"
    with pytest.raises(module.authority.Refused):
        module.qualify_jobs({"total_count": 1, "jobs": [job]}, run)
    artifact = {
        "id": 23,
        "name": "plg-source-validation-19-1",
        "expired": False,
        "size_in_bytes": 500,
        "digest": "sha256:" + "d" * 64,
        "workflow_run": {"id": 19},
    }
    with pytest.raises(module.authority.Refused):
        module.select_artifact({"total_count": 1, "artifacts": [artifact]}, run)


def test_later_failed_rerun_invalidates_earlier_success(hosted_validation, monkeypatch, tmp_path):
    import copy
    from io import BytesIO
    from zipfile import ZipFile

    module, run, record, receipt = hosted_validation
    policy = tmp_path / "config/ci-governance.json"
    policy.parent.mkdir()
    policy.write_text(json.dumps({"production": {"manual_dispatch_users": ["operator"]}}))
    source_record = tmp_path / "record.json"
    source_record.write_text("reviewed record")
    receipt["recordSha256"] = hashlib.sha256(source_record.read_bytes()).hexdigest()
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module.authority, "RECORD", source_record)
    monkeypatch.setattr(module.authority, "qualify_source", lambda sha: record)
    monkeypatch.setattr(module, "_qualify_definition", lambda *args: None)
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("acceptance.json", json.dumps(receipt))
    raw = buffer.getvalue()
    artifact = {
        "id": 23,
        "name": "plg-source-validation-19-2",
        "expired": False,
        "size_in_bytes": len(raw),
        "digest": "sha256:" + hashlib.sha256(raw).hexdigest(),
        "workflow_run": {"id": 19},
    }
    job = {
        "run_id": 19,
        "head_sha": run["head_sha"],
        "name": module.GATE,
        "status": "completed",
        "conclusion": "success",
        "steps": [
            {"name": name, "status": "completed", "conclusion": "success"} for name in module.STEPS
        ],
    }

    class GitHub:
        def __init__(self):
            self.cache = {}
            self.reads = 0
            self.invalidate = False

        def read(self, path, *, binary=False):
            if path == "runs/19":
                self.reads += 1
                if self.reads == 2 and self.invalidate:
                    return {**run, "run_attempt": 3, "conclusion": "failure"}
                return copy.deepcopy(run)
            if path.endswith("/jobs?per_page=100"):
                return {"total_count": 1, "jobs": [job]}
            if path.endswith("/artifacts?per_page=100"):
                return {"total_count": 1, "artifacts": [artifact]}
            assert binary and path == "artifacts/23/zip"
            return raw

    accepted = module.verify(19, record["sourceSha"], GitHub())
    assert accepted["trafficAuthorized"] is False and accepted["runAttempt"] == 2
    client = GitHub()
    client.invalidate = True
    with pytest.raises(module.authority.Refused):
        module.verify(19, record["sourceSha"], client)


@pytest.mark.parametrize(
    "changed",
    [
        ".github/workflows/validate-plg-source.yml",
        "deploy/plg/release_source.py",
        "scripts/ci/assert-governed-actor.py",
        "config/ci-governance.json",
        "scripts/ci/check-dco-signoff.sh",
        ".gitleaks.toml",
        "consent-protocol/.github/actions/setup-python-uv/action.yml",
    ],
)
def test_different_hosted_authority_bytes_cannot_qualify(
    hosted_validation, monkeypatch, tmp_path, changed
):
    module, run, _, _ = hosted_validation
    for path in module.AUTHORITY_PATHS:
        file = tmp_path / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b"reviewed authority\n")
    monkeypatch.setattr(module, "ROOT", tmp_path)

    def git(*args):
        if args[0] == "merge-base":
            return b""
        assert args[0] == "show"
        return (tmp_path / args[1].split(":", 1)[1]).read_bytes()

    monkeypatch.setattr(module.authority, "_git", git)
    digest = hashlib.sha256(b"reviewed authority\n").hexdigest()
    module._qualify_definition(run, digest)
    with pytest.raises(module.authority.Refused):
        module._qualify_definition(run, "f" * 64)

    def changed_git(*args):
        return (
            b"superseded authority"
            if args[0] == "show" and args[1].endswith(changed)
            else git(*args)
        )

    monkeypatch.setattr(module.authority, "_git", changed_git)
    with pytest.raises(module.authority.Refused):
        module._qualify_definition(run, digest)
