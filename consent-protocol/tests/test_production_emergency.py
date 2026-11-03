"""Explicit production incident authority and paired-baseline refusal boundaries."""

import importlib
import importlib.util
import os
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SHA = "a" * 40


def _emergency_fixture(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "scripts/ci"))
    module = importlib.import_module("production_emergency")
    environment = {
        "GITHUB_REPOSITORY": "hushh-labs/hushh-research",
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_WORKFLOW_REF": "hushh-labs/hushh-research/.github/workflows/deploy-production.yml@refs/heads/main",
        "GITHUB_SHA": "b" * 40,
        "GITHUB_ACTOR": "operator",
        "GITHUB_TRIGGERING_ACTOR": "operator",
        "GITHUB_RUN_ID": "100",
        "GITHUB_RUN_ATTEMPT": "1",
    }
    inputs = {
        "sha": SHA,
        "emergency_source_ref": "hotfix/incident-123",
        "emergency_reason": "Incident 123: restore the serving account route",
    }
    policy = {"production": {"manual_dispatch_users": ["operator"]}}
    return module, environment, inputs, policy


@pytest.mark.parametrize(
    "defect",
    [
        None,
        "actor",
        "workflow",
        "reason",
        "branch",
        "sha",
        "phone",
        "recovery",
        "cadence",
    ],
)
def test_manual_emergency_preserves_authority_and_refuses_mixed_modes(monkeypatch, defect):
    module, environment, inputs, policy = _emergency_fixture(monkeypatch)
    if defect == "actor":
        environment["GITHUB_TRIGGERING_ACTOR"] = "outsider"
    elif defect == "workflow":
        environment["GITHUB_WORKFLOW_REF"] = environment["GITHUB_WORKFLOW_REF"].replace(
            "main", "hotfix/x"
        )
    elif defect == "reason":
        inputs["emergency_reason"] = ""
    elif defect == "branch":
        inputs["emergency_source_ref"] = "hotfix/a\nINJECTED=value"
    elif defect == "sha":
        inputs["sha"] = "main"
    elif defect == "phone":
        inputs["phone_phase"] = "worker"
    elif defect == "recovery":
        inputs["restoration_activation_run_id"] = "200"
    elif defect == "cadence":
        inputs["cadence_origin"] = "200"
    if defect:
        with pytest.raises(ValueError):
            module.dispatch({"inputs": inputs}, environment, policy)
    else:
        assert module.dispatch({"inputs": inputs}, environment, policy)["application_sha"] == SHA
        assert module.dispatch({"inputs": {"sha": SHA}}, environment, policy) == {
            "mode": "ordinary"
        }


def test_emergency_receipt_binds_both_baselines_and_never_supplies_uat_acceptance(monkeypatch):
    module, environment, inputs, policy = _emergency_fixture(monkeypatch)
    authority = module.dispatch({"inputs": inputs}, environment, policy)
    baselines = {"backend": {"source": "c" * 40}, "frontend": {"source": "d" * 40}}
    calls = []
    receipt = module.admit(authority, baselines, "backend", run=lambda *args: calls.append(args))
    assert receipt["ordinary_promotion_evidence"] is False
    assert "uat-deployment-acceptance" in receipt["waived"]
    assert {call[-2] for call in calls if call[1] == "merge-base"} == {"c" * 40, "d" * 40}
    module.recheck(receipt, authority, baselines)
    with pytest.raises(ValueError, match="baseline changed"):
        module.recheck(receipt, authority, {**baselines, "frontend": {"source": "e" * 40}})
    with pytest.raises(ValueError, match="baseline changed"):
        module.recheck(receipt, {**authority, "run_attempt": "2"}, baselines)


def test_auth_emergency_recheck_revalidates_the_pinned_operational_reference(monkeypatch):
    module, *_ = _emergency_fixture(monkeypatch)
    control = importlib.import_module("production_backend_successor_control")
    authority = {
        "mode": "manual-emergency",
        "frontend_auth_domain_refresh": True,
        "application_sha": "c" * 40,
        "run_id": "100",
        "run_attempt": "1",
        "workflow_sha": "b" * 40,
    }
    observed = {
        "backend": {"source": "d" * 40, "revision": "consent-protocol-00309-nir"},
        "frontend": {"source": "d" * 40, "revision": "hushh-webapp-restored"},
    }
    operational = {"ref": "refs/tags/deployed/production-latest", "tag_oid": "e" * 40}
    receipt = {
        "schema_version": 1,
        "kind": "manual-production-predecessor-exception",
        "authority": authority,
        "baseline": observed,
        "ordinary_promotion_evidence": False,
        "backend_acceptance_origin": {"operational_reference": operational},
    }
    verified = []
    monkeypatch.setattr(
        control,
        "revalidate_auth_domain_reference",
        lambda expected, current: verified.append((expected, current)),
    )
    module.recheck(receipt, authority, observed)
    assert verified == [(operational, observed)]
    receipt["backend_acceptance_origin"].pop("operational_reference")
    with pytest.raises(ValueError, match="operational reference is missing"):
        module.recheck(receipt, authority, observed)


def test_emergency_baseline_refuses_split_traffic_and_unqualified_identity(monkeypatch):
    module, *_ = _emergency_fixture(monkeypatch)
    service = {
        "metadata": {"name": "consent-protocol", "uid": "service-uid", "generation": 2},
        "status": {
            "observedGeneration": 2,
            "conditions": [{"type": "Ready", "status": "True"}],
            "traffic": [{"revisionName": "consent-protocol-00100-abc", "percent": 100}],
        },
    }
    revision = {
        "metadata": {
            "name": "consent-protocol-00100-abc",
            "uid": "revision-uid",
            "labels": {
                "serving.knative.dev/service": "consent-protocol",
                "deploy-env": "production",
                "deploy-source": "deploy-production",
                "deploy-sha": SHA,
            },
        },
        "spec": {
            "serviceAccountName": "consent-protocol-runtime@hushh-pda.iam.gserviceaccount.com"
        },
        "status": {
            "imageDigest": "gcr.io/hushh-pda/consent-protocol@sha256:" + "a" * 64,
            "conditions": [{"type": "Ready", "status": "True"}],
        },
    }
    assert module.baseline(service, revision, "consent-protocol")["source"] == SHA
    assert module.baseline(service, revision, "consent-protocol")["generation"] == "2"
    for missing in (None, False, 0):
        service["metadata"]["generation"] = missing
        service["status"]["observedGeneration"] = missing
        with pytest.raises(ValueError):
            module.baseline(service, revision, "consent-protocol")
    service["metadata"]["generation"] = 2
    service["status"]["observedGeneration"] = 2
    revision["spec"]["serviceAccountName"] = "foreign@other-project.iam.gserviceaccount.com"
    with pytest.raises(ValueError):
        module.baseline(service, revision, "consent-protocol")
    service["status"]["traffic"] = [
        {"revisionName": "first", "percent": 50},
        {"revisionName": "second", "percent": 50},
    ]
    with pytest.raises(ValueError):
        module.baseline(service, revision, "consent-protocol")


def test_incident_admission_precedes_runtime_mutation_and_keeps_ordinary_uat_gate():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    incident = next(step for step in steps if step.get("id") == "dispatch-authority")
    source = next(
        step for step in steps if step.get("name") == "Validate deployment SHA against main"
    )
    assert steps.index(incident) < steps.index(source)
    assert source["env"]["REQUIRED_BRANCH"] == "${{ steps.dispatch-authority.outputs.branch }}"
    predecessor = next(step for step in steps if step.get("id") == "predecessor-acceptance")
    for name in ("Preserve current release tooling", "Checkout deployment SHA"):
        owner = next(step for step in steps if step.get("name") == name)
        assert "retention_uat_guard_evidence.py" in owner["run"]
    assert 'if [ "$RELEASE_MODE" = manual-emergency ]; then' in predecessor["run"]
    assert "python3 scripts/ci/production_emergency.py admit" in predecessor["run"]
    assert (
        'else\n  python3 "${RUNNER_TEMP}/release-tools/verify-predecessor-acceptance.py" require'
        in predecessor["run"]
    )
    for mutation in (
        "Sync frontend hosted runtime secrets",
        "Sync canonical hosted runtime secrets",
    ):
        position = next(i for i, step in enumerate(steps) if step.get("name") == mutation)
        guard = steps[position - 1]
        assert "Recheck manual incident" in guard["name"]
        assert '"${RUNNER_TEMP}/release-tools/require-deploy-sha-on-main.sh"' in guard["run"]
        assert (
            "uv run --frozen --project consent-protocol python scripts/ci/production_emergency.py recheck"
            in guard["run"]
        )
    for name, job in workflow["jobs"].items():
        if name == "deployment-security":
            assert job["uses"] == "./.github/workflows/deployment-security.yml"
            continue
        if name in {"validate-dispatch", "verify-current-production"}:
            assert "uses" not in job
            continue
        boundary = next(step for step in job["steps"] if step.get("id") == "dispatch-authority")
        assert "production_emergency.py dispatch" in boundary["run"]


def test_workspace_release_tool_overlay_preserves_repository_relative_phone_paths(
    monkeypatch, tmp_path
):
    monkeypatch.syspath_prepend(str(ROOT / "scripts/ci"))
    runner_work = tmp_path / "runner" / "work"
    workspace = runner_work / "hushh-research" / "hushh-research"
    release_tools = runner_work / "_temp" / "release-tools"
    workspace_scripts = workspace / "scripts" / "ci"
    workspace_phone = workspace / "deploy" / "phone"
    flat_phone = release_tools / "phone"
    for directory in (workspace_scripts, workspace_phone, release_tools, flat_phone):
        directory.mkdir(parents=True, exist_ok=True)

    receipt_source = ROOT / "scripts/ci/production_phone_receipt.py"
    phone_source = ROOT / "deploy/phone/reader_probe.py"
    shutil.copy2(receipt_source, workspace_scripts / receipt_source.name)
    shutil.copy2(receipt_source, release_tools / receipt_source.name)
    shutil.copy2(phone_source, workspace_phone / phone_source.name)
    shutil.copy2(phone_source, flat_phone / phone_source.name)

    def load(name, path):
        spec = importlib.util.spec_from_file_location(name, path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    workspace_receipt = load(
        "workspace_production_phone_receipt",
        workspace_scripts / receipt_source.name,
    )
    flat_receipt = load(
        "flat_production_phone_receipt",
        release_tools / receipt_source.name,
    )

    assert workspace_receipt._constant("reader_probe.py", "SOURCE_MODULES")
    with pytest.raises(FileNotFoundError):
        flat_receipt._constant("reader_probe.py", "SOURCE_MODULES")


def test_auth_domain_refresh_requires_explicit_frontend_incident(monkeypatch):
    module, environment, inputs, policy = _emergency_fixture(monkeypatch)
    inputs.update(frontend_auth_domain_refresh=True, scope="frontend")
    authority = module.dispatch({"inputs": inputs}, environment, policy)
    assert authority["frontend_auth_domain_refresh"] is True
    for key, value in [
        ("scope", "all"),
        ("emergency_source_ref", ""),
        ("nearby_check_in_cohort", ""),
        ("run_predeploy_backup_job", "true"),
    ]:
        with pytest.raises(ValueError):
            module.dispatch({"inputs": {**inputs, key: value}}, environment, policy)


def test_auth_domain_refresh_preserves_the_entire_application(monkeypatch):
    _emergency_fixture(monkeypatch)
    module = importlib.import_module("production_auth_domain_refresh")
    receipt = {
        "kind": "manual-production-predecessor-exception",
        "scope": "frontend",
        "authority": {"application_sha": module.CANDIDATE, "frontend_auth_domain_refresh": True},
        "baseline": {
            kind: {"source": module.SOURCE, "image": image} for kind, image in module.IMAGES.items()
        },
    }
    module.validate_source(receipt, run=lambda *args: ".github/workflows/ci.yml\n")
    for changes in [
        "",
        "hushh-webapp/app/page.tsx\n",
        ".github/workflows/ci.yml\ndeploy/frontend.cloudbuild.yaml\n",
    ]:
        with pytest.raises(ValueError):
            module.validate_source(receipt, run=lambda *args, changes=changes: changes)
    receipt["baseline"]["backend"]["image"] = "changed"
    with pytest.raises(ValueError):
        module.validate_source(receipt, run=lambda *args: ".github/workflows/ci.yml\n")


def test_auth_domain_refresh_pins_all_original_build_inputs(monkeypatch):
    _emergency_fixture(monkeypatch)
    module = importlib.import_module("production_auth_domain_refresh")
    text = "\n".join(
        f"projects/$PROJECT_ID/secrets/{name}/versions/latest"
        for name in module.VERSIONS
        if name != "NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID"
    )
    text += "\ngcloud secrets versions access latest \\\n  --secret=NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID\n"
    pinned = module.pin_config(text)
    for name, version in module.VERSIONS.items():
        if name != "NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID":
            assert f"/secrets/{name}/versions/{version}" in pinned
    assert "/versions/latest" not in pinned
    assert "gcloud secrets versions access 1" in pinned
    for changed in [
        text.replace("BACKEND_URL", "FOREIGN_SECRET"),
        text.replace("--secret=NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID", "--secret=OTHER"),
    ]:
        with pytest.raises(ValueError):
            module.pin_config(changed)


def test_auth_domain_workflow_keeps_normal_security_and_rollback(monkeypatch, tmp_path):
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    source = (ROOT / ".github/workflows/deploy-production.yml").read_text()
    assert 'production_auth_domain_refresh.py" verify --receipt' in source
    assert (
        "if: steps.document-mode.outputs.configured == 'true' && !inputs.frontend_auth_domain_refresh"
        in source
    )
    assert "Require current-attempt deployment security" in source
    assert "REQUIRED_CHECK_NAME:" in source
    assert "Pin the reviewed auth-domain-only frontend inputs" in source
    steps = workflow["jobs"]["deploy"]["steps"]
    tag_index = next(
        i
        for i, step in enumerate(steps)
        if step.get("name") == "Tag this release as last known good"
    )
    upload_index = next(
        i
        for i, step in enumerate(steps)
        if step.get("name") == "Upload production deploy artifacts"
    )
    final_gate = next(
        step
        for step in steps
        if step.get("name") == "Fail workflow when production release did not end healthy"
    )
    worker = next(
        step
        for step in steps
        if step.get("name") == "Load qualified staged production Drive worker"
    )
    cleanup = next(
        step
        for step in steps
        if step.get("name") == "Retire unused production tags after a healthy release"
    )
    assert tag_index < upload_index
    assert steps[tag_index]["continue-on-error"] is True
    assert (
        steps[tag_index]["env"]["AUTH_DOMAIN_REPAIR"]
        == "${{ inputs.frontend_auth_domain_refresh && 'true' || 'false' }}"
    )
    assert final_gate["env"]["AUTH_DOMAIN_REPAIR"] == steps[tag_index]["env"]["AUTH_DOMAIN_REPAIR"]
    assert (
        "always()" in final_gate["if"] and "inputs.frontend_auth_domain_refresh" in final_gate["if"]
    )
    assert "auth-publish-verify" in final_gate["run"]
    assert 'if [ "$AUTH_DOMAIN_REPAIR" = true ]; then' in final_gate["run"]
    assert worker["env"]["AUTH_DOMAIN_REPAIR"] == final_gate["env"]["AUTH_DOMAIN_REPAIR"]
    assert worker["env"]["RELEASE_MODE"] == "${{ steps.dispatch-authority.outputs.mode }}"
    assert 'if os.environ["AUTH_DOMAIN_REPAIR"] == "true":' in worker["run"]
    assert 'os.environ["RELEASE_MODE"] != "manual-emergency"' in worker["run"]
    assert 'or os.environ["PHONE_DEPLOY_PHASE"] != "standard" or run_id' in worker["run"]
    assert 'output.write("loaded=false\\n")' in worker["run"]
    assert (
        'if anchor is not None and os.environ["PHONE_DEPLOY_PHASE"] != "cold" and not run_id:'
        in worker["run"]
    )
    assert "!inputs.frontend_auth_domain_refresh" in cleanup["if"]
    tagger = (ROOT / "scripts/ci/tag-last-known-good.sh").read_text()
    assert "production_backend_successor_control.py auth-publish" in tagger
    assert 'git push origin "refs/tags/${TAG}"' in tagger

    capacity = next(
        step
        for step in steps
        if step.get("name") == "Enforce production database connection budget before deployment"
    )
    assert capacity["env"]["AUTH_DOMAIN_REPAIR"] == final_gate["env"]["AUTH_DOMAIN_REPAIR"]
    assert capacity["env"]["REQUESTED_SCOPE"] == "${{ inputs.scope }}"
    assert "python3 scripts/ci/production_emergency.py admit" in next(
        step["run"] for step in steps if step.get("id") == "predecessor-acceptance"
    )
    setup = next(
        i for i, step in enumerate(steps) if step.get("name") == "Set up Python + uv runtime"
    )
    proxy = next(
        i for i, step in enumerate(steps) if step.get("name") == "Install Cloud SQL Auth Proxy"
    )
    recheck = next(
        i
        for i, step in enumerate(steps)
        if step.get("name") == "Recheck manual incident source and serving baseline before mutation"
    )
    assert setup < proxy < recheck
    assert "inputs.frontend_auth_domain_refresh" in steps[proxy]["if"]
    # Execute the actual gate with command-only stand-ins: scope refusal must
    # precede invocation, and ordinary/cold operations retain their reservations.
    for name, body in (
        ("timeout", '#!/bin/sh\nshift 3\nexec "$@"\n'),
        ("python3", '#!/bin/sh\nprintf "%s\\n" "$*" > "$CAPTURE"\n'),
    ):
        path = tmp_path / name
        path.write_text(body)
        path.chmod(0o700)
    cases = (
        ({}, 0, "--no-candidates"),
        ({"AUTH_DOMAIN_REPAIR": "false"}, 0, "--environment production"),
        (
            {"AUTH_DOMAIN_REPAIR": "false", "PHONE_DEPLOY_PHASE": "cold"},
            0,
            "--candidate-service consent-protocol",
        ),
        ({"REQUESTED_SCOPE": "all"}, 1, None),
        ({"STAGED_WORKER_LOADED": "true"}, 1, None),
        ({"STAGED_WORKER_LOADED": ""}, 1, None),
    )
    for index, (overrides, expected_code, suffix) in enumerate(cases):
        capture = tmp_path / f"capacity-{index}"
        environment = {
            "PATH": f"{tmp_path}:{os.environ['PATH']}",
            "CAPTURE": str(capture),
            "AUTH_DOMAIN_REPAIR": "true",
            "REQUESTED_SCOPE": "frontend",
            "PHONE_DEPLOY_PHASE": "standard",
            "STAGED_WORKER_LOADED": "false",
            "RESTORATION_RUN": "",
            "PHONE_ROLLBACK_SHA": "",
            **overrides,
        }
        result = subprocess.run(  # noqa: S603 - execute the checked-in workflow against local stubs
            ["bash", "-c", capacity["run"]],
            env=environment,
            capture_output=True,
            timeout=5,
        )
        assert result.returncode == expected_code
        if suffix is None:
            assert not capture.exists()
        else:
            assert capture.read_text().strip().endswith(suffix)
            if overrides.get("AUTH_DOMAIN_REPAIR") == "false":
                assert "--no-candidates" not in capture.read_text().split()


def test_auth_domain_refresh_refuses_runtime_configuration_drift(monkeypatch):
    import copy

    _emergency_fixture(monkeypatch)
    module = importlib.import_module("production_auth_domain_refresh")
    baseline = {
        "metadata": {"annotations": {"autoscaling.knative.dev/maxScale": "3"}},
        "spec": {
            "serviceAccountName": "frontend",
            "containers": [
                {
                    "image": "old",
                    "resources": {"limits": {"memory": "1Gi"}},
                    "env": [
                        {
                            "name": "BACKEND_URL",
                            "valueFrom": {"secretKeyRef": {"name": "BACKEND_URL", "key": "latest"}},
                        },
                        {"name": "HUSHH_DEPLOY_SHA", "value": "old"},
                    ],
                }
            ],
        },
    }
    candidate = copy.deepcopy(baseline)
    container = candidate["spec"]["containers"][0]
    container["image"] = "new"
    container["env"][0]["valueFrom"]["secretKeyRef"]["key"] = "3"
    container["env"][1]["value"] = "new"
    assert module.runtime_config(baseline, original=True) == module.runtime_config(
        candidate, original=False
    )
    container["resources"]["limits"]["memory"] = "2Gi"
    assert module.runtime_config(baseline, original=True) != module.runtime_config(
        candidate, original=False
    )
    container["env"][0]["valueFrom"]["secretKeyRef"]["key"] = "latest"
    with pytest.raises(ValueError):
        module.runtime_config(candidate, original=False)


def test_auth_domain_refresh_refuses_foreign_frontend_traffic(monkeypatch):
    _emergency_fixture(monkeypatch)
    module = importlib.import_module("production_auth_domain_refresh")
    baseline = {"service_uid": "original", "revision": "old", "generation": "10"}
    module.require_frontend_baseline({**baseline, "generation": "11"}, baseline)
    for key, value in [("service_uid", "replacement"), ("revision", "other")]:
        with pytest.raises(ValueError):
            module.require_frontend_baseline({**baseline, key: value}, baseline)


def test_auth_domain_refresh_uses_observed_intake_not_future_stored_policy(monkeypatch):
    _emergency_fixture(monkeypatch)
    module = importlib.import_module("production_auth_domain_refresh")
    mode = {"configured": True, "enabled": True}
    flag = {"name": "PROTECTED_DOCUMENT_DELIVERY_ENABLED", "value": "false"}
    backend = {"spec": {"containers": [{"env": [flag]}]}}
    assert module.effective_document_mode(mode, backend) == {
        "configured": True,
        "stored_enabled": True,
        "enabled": False,
    }
    for entries in [[], [dict(flag, value="true")], [dict(flag, valueFrom={})], [flag, flag]]:
        with pytest.raises(ValueError):
            module.effective_document_mode(mode, {"spec": {"containers": [{"env": entries}]}})
