"""Protect recovery effects from controller timeout, cancellation and replay."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from copy import deepcopy
from functools import partial
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]


def _cloud_response(command, *, calls, execution_name, name, outcome, elapsed, **kwargs):
    calls.append(command)
    if "list" in command:
        return SimpleNamespace(
            stdout=json.dumps([{"metadata": {"name": name}}] if outcome == "retained" else [])
        )
    if "execute" in command:
        if "--wait" in command and kwargs["timeout"] < 207:
            raise subprocess.TimeoutExpired(command, kwargs["timeout"])
        return SimpleNamespace(stdout=json.dumps({"metadata": {"name": execution_name}}))
    if "describe" in command:
        assert execution_name in command
        # Reproduce the observed207s provider wall time without sleeping.
        status = "Unknown"
        if elapsed[0] >= 207 and outcome != "unconfirmed":
            status = "True" if outcome in {"success", "wrong_generation"} else "False"
        return SimpleNamespace(
            stdout=json.dumps(
                {
                    "metadata": {"name": execution_name},
                    "status": {"conditions": [{"type": "Completed", "status": status}]},
                }
            )
        )
    if "logging" in command:
        return SimpleNamespace(
            stdout=json.dumps(
                [
                    {
                        "jsonPayload": {
                            "uat_processor_recovery": "completed",
                            "mode": "apply",
                            "limit": 20,
                            "scan_limit": 200,
                            "policy_generation": "other-generation"
                            if outcome == "wrong_generation"
                            else "qualified-generation",
                            "counts": {
                                key: 0
                                for key in (
                                    "inspected",
                                    "migrated",
                                    "resumed",
                                    "out_of_scope",
                                    "already_current",
                                    "legacy",
                                    "refused",
                                )
                            },
                        }
                    }
                ]
            )
        )
    return SimpleNamespace(stdout="")


def _load_controller():
    spec = importlib.util.spec_from_file_location(
        "uat_text_recovery_wait", REPO_ROOT / "scripts/ops/run_uat_text_recovery_job.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def controller(monkeypatch, tmp_path, outcome):
    module = _load_controller()
    name = "text-policy-recovery-39949039317"
    execution_name = name + "-qualified"
    source = tmp_path / "service.json"
    source.write_text("{}")
    monkeypatch.setattr(module, "job_spec", lambda *args, **kwargs: {"metadata": {"name": name}})
    monkeypatch.setattr(module, "expected_policy_generation", lambda job: "qualified-generation")
    monkeypatch.setattr(
        module,
        "Path",
        lambda value: (
            tmp_path / "proof.json"
            if Path(value).name == "uat-text-recovery-proof.json"
            else Path(value)
        ),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["recovery", "--service-json", str(source), "--sha", "a" * 40, "--run-id", "39949039317"],
    )
    elapsed = [0]
    monkeypatch.setattr(module.time, "monotonic", lambda: elapsed[0])
    monkeypatch.setattr(
        module.time, "sleep", lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds)
    )
    calls = []

    monkeypatch.setattr(
        module.subprocess,
        "run",
        partial(
            _cloud_response,
            calls=calls,
            execution_name=execution_name,
            name=name,
            outcome=outcome,
            elapsed=elapsed,
        ),
    )
    return module, calls


@pytest.mark.parametrize(
    "outcome", ["success", "cancelled", "unconfirmed", "retained", "wrong_generation"]
)
def test_text_recovery_waits_for_provider_settlement_before_removing_job(
    controller, tmp_path, outcome
):
    module, calls = controller
    if outcome == "retained":
        with pytest.raises(ValueError, match="reconcile before retry"):
            module.main()
        assert not any(verb in call for call in calls for verb in ("replace", "execute", "delete"))
        return
    if outcome == "wrong_generation":
        with pytest.raises(ValueError, match="receipt is not yet available"):
            module.main()
        assert not (tmp_path / "proof.json").exists()
        assert sum("execute" in call for call in calls) == 1
        assert any("logging" in call for call in calls)
        assert "delete" in calls[-1]
        return
    if outcome == "success":
        module.main()
        assert (
            json.loads((tmp_path / "proof.json").read_text())["uat_processor_recovery_job"]
            == "completed"
        )
        assert "logging" in calls[-2]
    else:
        with pytest.raises(ValueError if outcome == "cancelled" else TimeoutError):
            module.main()
        assert not (tmp_path / "proof.json").exists()
        assert not any("logging" in call for call in calls)
    assert sum("execute" in call for call in calls) == 1
    assert any("delete" in call for call in calls) == (outcome != "unconfirmed")


def test_candidate_recovery_uses_pinned_unserved_revision_and_existing_policy():
    module = _load_controller()
    sha, digest, run = "a" * 40, "sha256:" + "b" * 64, "123"
    revision = {
        "metadata": {
            "name": "candidate",
            "labels": {
                "serving.knative.dev/service": "consent-protocol",
                "deploy-sha": sha,
                "deploy-env": "uat",
                "deploy-source": "deploy-uat",
                "github-run-id": run,
            },
        },
        "status": {
            "conditions": [{"type": "Ready", "status": "True"}],
            "imageDigest": digest,
        },
        "spec": {
            "serviceAccountName": "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com",
            "containers": [
                {
                    "image": f"gcr.io/hushh-pda-uat/consent-protocol@{digest}",
                    "env": [
                        {"name": "ENVIRONMENT", "value": "uat"},
                        {"name": "HUSHH_DEPLOY_SHA", "value": sha},
                        {"name": "HUSHH_DEPLOY_RUN_ID", "value": run},
                        {"name": "HUSHH_UAT_MANAGED_AI_PROVIDER", "value": "azure_openai"},
                        {"name": "HUSHH_UAT_MANAGED_TEXT_PROVIDER", "value": "azure_openai"},
                    ],
                }
            ],
        },
    }
    baseline = deepcopy(revision)
    baseline["metadata"]["name"] = "baseline"
    worker_revision = deepcopy(baseline)
    worker_revision["metadata"]["labels"]["serving.knative.dev/service"] = (
        "consent-protocol-drive-worker"
    )
    worker_revision["spec"]["containers"][0]["name"] = "drive-worker"
    service = {
        "status": {
            "latestReadyRevisionName": "candidate",
            "traffic": [
                {"revisionName": "baseline", "percent": 100},
                {"revisionName": "candidate", "tag": f"account-deletion-{run}"},
            ],
        }
    }
    job = module.job_spec(
        service,
        sha=sha,
        run_id=run,
        candidate=revision,
        baseline=baseline,
        worker=worker_revision,
        attempt="1",
    )
    worker = job["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]
    assert worker["image"] == revision["spec"]["containers"][0]["image"]
    assert worker["args"] == ["scripts/recover_uat_text_requests.py", "--apply", "--limit=20"]

    wrong_provider = deepcopy(baseline)
    wrong_provider["spec"]["containers"][0]["env"][-1]["value"] = "vertex"
    with pytest.raises(ValueError, match="serving processor binding"):
        module.job_spec(
            service,
            sha=sha,
            run_id=run,
            candidate=revision,
            baseline=wrong_provider,
            worker=worker_revision,
            attempt="1",
        )
    wrong_worker = deepcopy(worker_revision)
    wrong_worker["spec"]["containers"][0]["env"][-1]["value"] = "vertex"
    with pytest.raises(ValueError, match="same serving Drive worker processor"):
        module.job_spec(
            service,
            sha=sha,
            run_id=run,
            candidate=revision,
            baseline=baseline,
            worker=wrong_worker,
            attempt="1",
        )
    service["status"]["traffic"][0]["revisionName"] = "candidate"
    with pytest.raises(ValueError, match="serving baseline"):
        module.job_spec(
            service,
            sha=sha,
            run_id=run,
            candidate=revision,
            baseline=baseline,
            worker=worker_revision,
            attempt="1",
        )


def test_guarded_traffic_requires_candidate_verification_and_recovery():
    workflow = yaml.safe_load(
        (REPO_ROOT / ".github/workflows/deploy-uat-implementation.yml").read_text()
    )
    steps = {step["id"]: step for step in workflow["jobs"]["deploy"]["steps"] if "id" in step}
    order = list(steps)
    candidate = "verify-isolated-uat-candidates"
    recovery = "recover-isolated-uat-text-requests"
    promotion = "promote-uat-traffic"
    guard = "env.PREPROMOTION_UAT_GATES"
    assert workflow["env"]["PREPROMOTION_UAT_GATES"] == (
        "${{ inputs.source_branch == 'uat-isolated' || inputs.verify_candidate_before_promotion }}"
    )
    assert order.index(candidate) < order.index(recovery) < order.index(promotion)
    assert f"{guard} == 'true'" in steps[candidate]["if"]
    assert f"{guard} == 'true'" in steps[recovery]["if"]
    assert f"{guard} != 'true'" in steps[promotion]["if"]
    assert f"steps.{candidate}.outcome == 'success'" in steps[promotion]["if"]
    assert f"steps.{recovery}.outcome == 'success'" in steps[promotion]["if"]
    assert f"{guard} != 'true'" in steps["recover-uat-text-requests"]["if"]


@pytest.mark.parametrize(("status", "expected"), [("200", 0), ("302", 1), ("404", 1)])
def test_candidate_http_probe_refuses_redirects_and_errors(status, expected):
    workflow = yaml.safe_load(
        (REPO_ROOT / ".github/workflows/deploy-uat-implementation.yml").read_text()
    )
    step = next(
        item
        for item in workflow["jobs"]["deploy"]["steps"]
        if item.get("id") == "verify-isolated-uat-candidates"
    )
    script = step["run"]
    start = script.index("require_candidate_http()")
    end = script.index("\n}", start) + 2
    result = subprocess.run(  # noqa: S603 - authored probe with fixed synthetic HTTP statuses
        [
            "bash",
            "-c",
            f'http="$1"\ncurl() {{ printf "%s" "$http"; }}\n{script[start:end]}\nrequire_candidate_http "https://candidate.invalid/health"',
            "candidate-http",
            status,
        ],
        check=False,
    )
    assert result.returncode == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("expires_while_opening", [False, True])
async def test_recovery_observes_committed_retry_before_failing_its_deadline(
    monkeypatch, capsys, expires_while_opening
):
    from hushh_mcp.runtime_providers import managed_text
    from hushh_mcp.services import drive_owner_allowed, drive_owner_search_store

    spec = importlib.util.spec_from_file_location(
        "recovery_application", REPO_ROOT / "consent-protocol/scripts/recover_uat_text_requests.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    clock = [0]
    calls = []
    policy = {"approval_generation": "current"}
    monkeypatch.setattr(module, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(managed_text, "managed_text_policy", lambda: policy)
    monkeypatch.setattr(managed_text, "managed_text_binding", lambda: policy)
    monkeypatch.setattr(drive_owner_allowed, "semantic_search_request", lambda _: True)

    def read(statement, parameters):
        calls.append("scan")
        assert "r.request_envelope" in str(statement)
        assert parameters == {"limit": 200}
        return SimpleNamespace(
            mappings=lambda: SimpleNamespace(
                all=lambda: [
                    {
                        "user_id": "fixture-owner",
                        "client_request_id": "fixture-request",
                        "status": "failed",
                        "revision": 4,
                        "request_envelope": "fixture-envelope",
                    }
                ]
            )
        )

    async def transaction(operation):
        return operation(SimpleNamespace(execute=read))

    async def retry(**kwargs):
        assert kwargs["request_revision"] == 4
        assert kwargs["authority_mode"] == "trusted_auto"
        clock[0] = 91
        calls.append("committed")
        return {}, True

    def open_envelope(*args, **kwargs):
        if expires_while_opening:
            clock[0] = 91
        return {"semantic_model_binding": policy}

    monkeypatch.setattr(
        drive_owner_search_store,
        "DriveOwnerSearchStore",
        lambda: SimpleNamespace(
            _transaction=transaction,
            search_cipher=SimpleNamespace(open=open_envelope),
            retry_failed_request=retry,
        ),
    )
    with pytest.raises(TimeoutError, match="application budget"):
        await module.recover(apply=True, limit=20, deadline=90)
    assert calls == (["scan"] if expires_while_opening else ["scan", "committed"])
    progress = json.loads(capsys.readouterr().out)
    assert progress["uat_processor_recovery"] == "incomplete"
    assert progress["counts"]["resumed"] == int(not expires_while_opening)
