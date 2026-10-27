"""Production activation preserves incompatible readers until governed retirement."""

import copy
import importlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.test_account_deletion_release_workflow import (
    _activation_adapter,
    _activation_module,
    _assert_no_uat_target,
    _production_step,
    _production_workflow,
    _step,
)

pytestmark = [pytest.mark.feature_account_deletion, pytest.mark.trace_loop]
ROOT = Path(__file__).resolve().parents[2]


def test_production_activation_uses_the_same_qualified_lifecycle_owner() -> None:
    activation = _production_step("Activate tombstone-aware account deletion")
    assert activation["if"] == (
        "env.PHONE_DEPLOY_PHASE != 'cold' && (steps.classify.outputs.release_failed == 'false' && "
        "steps.scope.outputs.deploy_backend == 'true')"
    )
    # The recovery schema driver belongs to the verified project environment.
    assert (
        '"${{ env.PROTOCOL_PYTHON }}" deploy/account-deletion/activate_release.py'
        in activation["run"]
    )
    assert '--expected-sha "${{ github.event.inputs.sha }}"' in activation["run"]
    assert '--cloudsql-instance "${{ env.PROD_CLOUDSQL_INSTANCE }}"' in activation["run"]
    assert _production_workflow()["env"]["CONSENT_API_PUBLIC_ORIGIN"] == "https://api.hushh.ai"
    _assert_no_uat_target(activation["run"])


@pytest.fixture
def activation_case(monkeypatch, tmp_path):
    module = _activation_module()
    args = SimpleNamespace(
        project="hushh-pda",
        region="us-central1",
        backend_service="consent-protocol",
        backend_url="https://api.hushh.ai",
        oidc_audience="https://api.hushh.ai",
        scheduler_job="account-deletion-cleanup",
        scheduler_service_account="account-deletion-cleanup",
        expected_sha="a" * 40,
        expected_run_id="123",
        fence_required=True,
        evidence_prefix=str(tmp_path / "activation"),
    )
    calls, deleted = _activation_adapter(module, args, None, monkeypatch, phone_floor=True)
    return module, args, calls, deleted


def test_production_pending_activation_is_durable_and_never_mutates_readers_or_fence(
    activation_case, monkeypatch, tmp_path
):
    module, args, calls, deleted = activation_case
    monkeypatch.setattr(module, "parse_arguments", lambda: args)
    # A later continuation must preserve the original serving candidate origin.
    monkeypatch.setenv("GITHUB_RUN_ID", "999")
    assert module.main() == 0
    evidence = json.loads((tmp_path / "activation-activation.json").read_text())
    assert evidence == {
        "schema_version": 1,
        "kind": "account-lifecycle-activation",
        "status": "pending_activation",
        "fence_required": True,
        "project": "hushh-pda",
        "region": "us-central1",
        "service": "consent-protocol",
        "service_uid": "fixture-service",
        "sha": args.expected_sha,
        "run_id": "123",
        "candidate_revision": "consent-protocol-current",
        "candidate_uid": "fixture-current",
        "required_provider_contract": 2,
        "database_preflight": "qualified",
        "retirement": {
            "status": "pending",
            "pending_count": 2,
            "phone_admission_floor_required": True,
            "pending_revisions": [
                {
                    "revision": "consent-protocol-legacy",
                    "uid": "fixture-legacy",
                    "source": "c" * 40,
                    "traffic_percent": 0,
                    "tags": ["legacy-test"],
                },
                {
                    "revision": "consent-protocol-prephone",
                    "uid": "fixture-prephone",
                    "source": "d" * 40,
                    "traffic_percent": 0,
                    "tags": ["prephone-test"],
                },
            ],
        },
    }
    assert not deleted
    assert all(call[0] != "bash" and "scheduler" not in call for call in calls)
    assert not any("update-traffic" in call or "delete" in call for call in calls)
    assert not any("remove_release_fence.sql" in arg for call in calls for arg in call)


def test_production_activates_only_after_actual_retirement_is_observed(
    activation_case, monkeypatch
):
    module, args, calls, deleted = activation_case
    # Model the subsequent canonical maintenance result, without deleting here.
    deleted.extend(["consent-protocol-legacy", "consent-protocol-prephone"])
    original = module.run

    def run(argv, **kwargs):
        value = original(argv, **kwargs)
        if argv[:4] == ["gcloud", "run", "services", "describe"]:
            service = json.loads(value)
            service["status"]["traffic"] = [
                row for row in service["status"]["traffic"] if row["revisionName"] not in deleted
            ]
            return json.dumps(service)
        return value

    monkeypatch.setattr(module, "run", run)
    evidence = {"status": "blocked"}
    module.activate(args, evidence)
    assert evidence["status"] == "activated"
    assert evidence["candidate_uid"] == "fixture-current"
    assert evidence["retirement"]["retired_count"] == 0
    assert evidence["retirement"]["remaining_pre_phone431_count"] == 0
    assert evidence["scheduler"]["completion"]["http_status"] == 200
    assert evidence["fence_removal"] == "confirmed_absent"
    assert not any("update-traffic" in call or "delete" in call for call in calls)


@pytest.mark.parametrize("changed", ["uid", "source", "candidate-origin", "database", "fence"])
def test_production_pending_refuses_unknown_identity_or_unqualified_database(
    activation_case, monkeypatch, changed
):
    module, args, calls, _deleted = activation_case
    if changed == "fence":
        args.fence_required = False
    original = module.run

    def run(argv, **kwargs):
        value = original(argv, **kwargs)
        if argv[:4] == ["gcloud", "run", "revisions", "list"]:
            rows = json.loads(value)
            if changed in {"uid", "source"}:
                metadata = rows[1]["metadata"]
                if changed == "uid":
                    metadata.pop("uid")
                else:
                    metadata["labels"].pop("deploy-sha")
            if changed == "candidate-origin":
                rows[0]["metadata"]["labels"]["github-run-id"] = "999"
            return json.dumps(rows)
        if changed == "database" and "--command" in argv and "contract_version()" in argv[-1]:
            return "1"
        return value

    monkeypatch.setattr(module, "run", run)
    evidence = {"status": "blocked"}
    with pytest.raises((ValueError, RuntimeError)):
        module.activate(args, evidence)
    assert evidence["status"] == "blocked"
    assert all(call[0] != "bash" and "scheduler" not in call for call in calls)
    assert not any("update-traffic" in call or "delete" in call for call in calls)


def test_explicit_restoration_cannot_satisfy_phone_reader_floor(monkeypatch):
    module = _activation_module()
    current, historical = "a" * 40, "c" * 40
    monkeypatch.setattr(module, "supports_current_contract", lambda sha, **_: sha == current)
    monkeypatch.setattr(module, "supports_restoration_source", lambda sha: sha == historical)
    service = {
        "status": {
            "traffic": [
                {"revisionName": "current", "percent": 100},
                {"revisionName": "historical", "percent": 0, "tag": "rollback"},
            ]
        }
    }
    revisions = [
        {
            "metadata": {
                "name": name,
                "labels": {
                    "deploy-sha": sha,
                    "account-deletion-contract": "v201",
                },
            }
        }
        for name, sha in (("current", current), ("historical", historical))
    ]
    assert module.legacy_inventory(service, revisions, "current", restoration=True) == ([], [])
    assert module.legacy_inventory(
        service, revisions, "current", restoration=True, phone_floor=True
    ) == (["historical"], ["rollback"])


@pytest.fixture
def uat_retirement(activation_case):
    module, args, _calls, deleted = activation_case
    args.project = "hushh-pda-uat"
    args.backend_url = args.oidc_audience = "https://api.uat.hushh.ai"
    evidence = {"status": "blocked"}
    module.activate(args, evidence)
    assert evidence["retirement"]["retired_revisions"] == deleted
    return module.retirement_owner(), args, evidence


def _tags_binding(args):
    return {
        "activation_succeeded": True,
        "project": args.project,
        "region": args.region,
        "service": args.backend_service,
        "candidate": "consent-protocol-current",
        "source": args.expected_sha,
        "run_id": args.expected_run_id,
        "rollback": "consent-protocol-legacy",
    }


@pytest.mark.parametrize("changed", [None, "absent", "skipped", "unrecorded"])
def test_uat_cleanup_keeps_missing_rollback_strict_except_proven_own_retirement(
    uat_retirement, monkeypatch, changed
):
    owner, args, evidence = uat_retirement
    binding = _tags_binding(args)
    if changed == "absent":
        evidence = None
    elif changed == "skipped":
        binding["activation_succeeded"] = False
    elif changed == "unrecorded":
        evidence["retirement"].update(retired_revisions=[], retired_count=0)
    rollback = owner.uat_tags_rollback(evidence, **binding)
    monkeypatch.syspath_prepend(str(ROOT / "scripts/ci"))
    retention = importlib.import_module("cloudrun-retention")
    service = {"status": {"traffic": [{"revisionName": binding["candidate"], "percent": 100}]}}
    revisions = [
        {"metadata": {"name": binding["candidate"], "creationTimestamp": "2026-10-27T01:00:00Z"}}
    ]
    protected = {binding["candidate"]} | ({rollback} if rollback else set())
    if changed:
        assert rollback == binding["rollback"]
        with pytest.raises(retention.UnsafeState, match="protected revision absent"):
            retention.plan_cleanup(service, revisions, 2, protected)
    else:
        plan = retention.plan_cleanup(service, revisions, 2, protected)
        assert rollback == ""
        assert binding["candidate"] in plan.protected


@pytest.mark.parametrize(
    "changed",
    [
        "run_id",
        "sha",
        "project",
        "region",
        "service",
        "candidate_revision",
        "candidate_uid",
        "service_uid",
        "status",
        "retired_revisions",
        "retired_count",
    ],
)
def test_uat_retirement_cannot_omit_rollback_from_foreign_or_incomplete_proof(
    uat_retirement, changed
):
    owner, args, evidence = uat_retirement
    evidence = copy.deepcopy(evidence)
    if changed == "retired_revisions":
        evidence["retirement"].pop(changed)
    elif changed == "retired_count":
        evidence["retirement"][changed] += 1
    elif changed in {"candidate_uid", "service_uid"}:
        evidence.pop(changed)
    else:
        evidence[changed] = "different"
    with pytest.raises(ValueError, match="unqualified"):
        owner.uat_tags_rollback(evidence, **_tags_binding(args))


def test_uat_tag_cleanup_executes_bound_retirement_projection_and_preserves_frontend(
    uat_retirement, tmp_path
):
    _owner, args, evidence = uat_retirement
    step = _step("Retire old UAT revision tags after a healthy release")
    script = step["run"]
    for name, document in (
        ("uat-release-status", {"status": "healthy"}),
        ("uat-account-deletion-activation", evidence),
    ):
        path = tmp_path / (name + ".json")
        path.write_text(json.dumps(document))
        script = script.replace("/tmp/" + name + ".json", str(path))  # noqa: S108 -- workflow literal replaced by pytest-owned path.
    script = script.replace("${{ inputs.preserve_paused_drive_worker }}", "true")
    capture = tmp_path / "retention.jsonl"
    fake = tmp_path / "bash"
    fake.write_text(
        "#!/usr/bin/env python3\nimport json,sys\n"
        f"with open({str(capture)!r},'a') as stream: stream.write(json.dumps(sys.argv[1:])+'\\n')\n"
    )
    fake.chmod(0o755)
    bash = shutil.which("bash")
    environment = {
        **os.environ,
        "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"],
        "GCP_PROJECT_ID": args.project,
        "GCP_REGION": args.region,
        "BACKEND_SERVICE": args.backend_service,
        "FRONTEND_SERVICE": "hushh-webapp",
        "BACKEND_REVISION_RETENTION": "2",
        "FRONTEND_REVISION_RETENTION": "2",
        "BACKEND_CURRENT": "consent-protocol-current",
        "BACKEND_ROLLBACK": "consent-protocol-legacy",
        "FRONTEND_CURRENT": "hushh-webapp-current",
        "FRONTEND_ROLLBACK": "hushh-webapp-previous",
        "DEPLOY_SHA": args.expected_sha,
        "GITHUB_RUN_ID": args.expected_run_id,
        "ACTIVATION_RESULT": "success",
    }
    subprocess.run([bash, "-euc", script], env=environment, cwd=ROOT, check=True)  # noqa: S603
    backend, frontend = [json.loads(row) for row in capture.read_text().splitlines()]
    assert backend[backend.index("--rollback-revision") + 1] == ""
    assert frontend[frontend.index("--rollback-revision") + 1] == "hushh-webapp-previous"
    assert backend[-3:] == frontend[-3:] == ["--apply", "--healthy", "--tags-only"]


def test_uat_retirement_owner_survives_checkout_without_the_new_helper(tmp_path):
    preserved = _step("Preserve current release tooling")["run"]
    copy = re.search(
        r"(?ms)^cp deploy/account-deletion/\{install,remove\}_release_fence.sql \\\n"
        r'.*?"\$\{RUNNER_TEMP\}/release-tools/account-deletion/"',
        preserved,
    ).group(0)
    runner = tmp_path / "runner"
    (runner / "release-tools/account-deletion").mkdir(parents=True)
    environment = {**os.environ, "RUNNER_TEMP": str(runner)}
    subprocess.run([shutil.which("bash"), "-euc", copy], cwd=ROOT, env=environment, check=True)  # noqa: S603
    historical = tmp_path / "checkout"
    target = historical / "deploy/account-deletion"
    target.mkdir(parents=True)
    (target / "activate_release.py").write_text(
        "# historical candidate without retirement helper\n"
    )
    restore = 'cp "${RUNNER_TEMP}/release-tools/account-deletion/"* deploy/account-deletion/'
    assert restore in _step("Checkout deployment SHA")["run"]
    subprocess.run(  # noqa: S603 -- exact authored restoration command, isolated synthetic checkout.
        [shutil.which("bash"), "-euc", restore], cwd=historical, env=environment, check=True
    )
    assert (target / "activation_retirement.py").read_bytes() == (
        ROOT / "deploy/account-deletion/activation_retirement.py"
    ).read_bytes()
    assert (target / "activate_release.py").read_bytes() == (
        ROOT / "deploy/account-deletion/activate_release.py"
    ).read_bytes()
