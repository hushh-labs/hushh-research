# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Cold qualification cannot become release, retirement or successor authority."""

import copy
import hashlib
import importlib.util
import io
import json
import subprocess
from types import SimpleNamespace
from zipfile import ZipFile

import pytest
import yaml

from tests.test_phone_rollback_release import FALLBACK, IMAGE, PRIMARY, REVISION, ROOT

pytest_plugins = ["tests.test_phone_rollback_release", "tests.test_phone_transfer_authority"]
pytestmark = pytest.mark.feature_auth_reliability


@pytest.fixture
def bootstrap_case(release_plan, monkeypatch, tmp_path):
    state = release_plan
    state.args.current_json.write_text(
        json.dumps({"metadata": {"labels": {"deploy-sha": "d" * 40}}})
    )
    state.args.fallback_sha = FALLBACK
    prepared = state.plan.prepare(state.args)
    monkeypatch.syspath_prepend(str(ROOT / "scripts/ci"))
    spec = importlib.util.spec_from_file_location(
        "phone_bootstrap", ROOT / "deploy/phone/bootstrap.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "plan", state.plan)
    state.service["metadata"].update(uid="service-uid", generation=1)
    state.service["status"].update(
        observedGeneration=1, conditions=[{"type": "Ready", "status": "True"}]
    )
    state.service["spec"] = {"traffic": [{"revisionName": REVISION, "percent": 100}]}
    before = copy.deepcopy(state.service)
    state.revision["metadata"].update(name="consent-protocol-00002-cold", uid="cold-uid")
    state.revision["metadata"]["labels"].update(
        {"deploy-source": "deploy-production-phone-rollback", "github-run-id": "42"}
    )
    values = state.revision["spec"]["containers"][0]["env"]
    for row in values:
        if row["name"] == "HUSHH_DEPLOY_SOURCE":
            row["value"] = "deploy-production-phone-rollback"
        elif row["name"] == "HUSHH_DEPLOY_RUN_ID":
            row["value"] = "42"
    values.extend(
        [
            {"name": "AUTH_PHONE_RECOVERY_ENABLED", "value": "false"},
            {"name": "WORKOS_SSO_ENABLED", "value": "false"},
        ]
    )
    tag = {
        "tag": "phone-rollback-42",
        "revisionName": state.revision["metadata"]["name"],
        "percent": 0,
    }
    state.service["status"]["traffic"].append(
        {**tag, "url": "https://phone-rollback-42---consent-protocol-example-uc.a.run.app"}
    )
    state.service["spec"]["traffic"].append(tag)
    state.owner = {"id": 42, "run_attempt": 2, "head_sha": PRIMARY}
    state.mutations = []

    def mutation(flag):
        state.mutations.append(flag)
        for field in (state.service["spec"], state.service["status"]):
            field["traffic"] = [row for row in field["traffic"] if row.get("tag") != tag["tag"]]
            if flag.startswith("--update-tags="):
                field["traffic"].append(copy.deepcopy(tag))
        if flag.startswith("--update-tags="):
            state.service["status"]["traffic"][-1]["url"] = (
                "https://phone-rollback-42---consent-protocol-example-uc.a.run.app"
            )
        state.service["metadata"]["generation"] += 1
        state.service["status"]["observedGeneration"] = state.service["metadata"]["generation"]

    state.iam = {
        "bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}],
        "etag": "same",
    }
    state.ports = SimpleNamespace(
        iam=lambda: copy.deepcopy(state.iam),
        service=lambda: copy.deepcopy(state.service),
        revision=lambda _name: copy.deepcopy(state.revision),
        lock_owner=lambda: copy.deepcopy(state.owner),
        mutation=mutation,
    )
    state.module = module
    state.prepared = prepared
    state.checkpoint = module.checkpoint(prepared, before, before_iam=state.iam, ports=state.ports)
    state.checkpoint["health_tag"] = "retired"
    state.lease = tmp_path / "lease.json"
    return state


def test_cold_checkpoint_is_not_schema_retirement_or_release_authority(bootstrap_case):
    receipt = bootstrap_case.checkpoint
    assert receipt["kind"] == "phone-cold-qualification"
    assert receipt["status"] == "qualified"
    assert receipt["readiness"]["installed_schema"] == "unverified"
    assert receipt["readiness"]["anchor_retirement"] == "blocked"
    assert receipt["origin"] == {"run_id": "42", "run_attempt": 2, "workflow_sha": PRIMARY}
    assert set(receipt["pending"]) == {
        "installed_schema",
        "retirement",
        "worker",
        "production_release",
    }
    assert receipt["plan"]["recovery_enabled"] is False


def test_retained_cold_health_lease_restores_traffic_without_relabelling_origin(bootstrap_case):
    state = bootstrap_case
    state.ports.mutation("--remove-tags=phone-rollback-42")
    state.mutations.clear()
    for field in (state.service["spec"], state.service["status"]):
        field["traffic"].append({"revisionName": REVISION, "percent": 0, "tag": "existing-health"})
    before = copy.deepcopy(state.service)
    state.owner.update(id=99, run_attempt=1)
    checked = state.module.requalify(state.checkpoint, lease_state=state.lease, ports=state.ports)
    assert checked["revision"] == state.checkpoint["qualification"]["revision"]
    assert checked["run_id"] == "42"
    assert state.checkpoint["origin"]["run_attempt"] == 2
    assert state.mutations == [
        "--update-tags=phone-rollback-42=consent-protocol-00002-cold",
        "--remove-tags=phone-rollback-42",
    ]
    assert state.service["spec"]["traffic"] == before["spec"]["traffic"]
    assert state.service["status"]["traffic"] == before["status"]["traffic"]
    assert not state.lease.exists()


@pytest.mark.parametrize(
    "forgery", ["schema", "status", "origin", "revision", "service", "tag", "retained-route"]
)
def test_checkpoint_forgery_or_replaced_resource_never_acquires_a_health_route(
    bootstrap_case, forgery
):
    state = bootstrap_case
    state.ports.mutation("--remove-tags=phone-rollback-42")
    state.mutations.clear()
    if forgery == "schema":
        state.checkpoint["readiness"]["anchor_retirement"] = "allowed"
    elif forgery == "status":
        state.checkpoint["status"] = "healthy"
    elif forgery == "origin":
        state.checkpoint["origin"]["run_id"] = "99"
    elif forgery == "revision":
        state.revision["metadata"]["uid"] = "recreated-resource"
    elif forgery == "service":
        state.service["metadata"]["uid"] = "recreated-service"
    else:
        for field in (state.service["spec"], state.service["status"]):
            field["traffic"].append(
                {
                    "revisionName": state.revision["metadata"]["name"]
                    if forgery == "retained-route"
                    else REVISION,
                    "percent": 0,
                    "tag": "phone-rollback-42",
                }
            )
    with pytest.raises(ValueError):
        state.module.requalify(state.checkpoint, lease_state=state.lease, ports=state.ports)
    assert not state.mutations


def test_altered_successor_releases_only_its_temporary_route(bootstrap_case, monkeypatch):
    state = bootstrap_case
    state.ports.mutation("--remove-tags=phone-rollback-42")
    before = copy.deepcopy(state.service["status"]["traffic"])
    monkeypatch.setattr(
        state.module,
        "_verify_plan",
        lambda _plan: {**state.checkpoint["qualification"], "revision": "consent-protocol-other"},
    )
    with pytest.raises(ValueError, match="altered_successor"):
        state.module.requalify(state.checkpoint, lease_state=state.lease, ports=state.ports)
    assert state.service["status"]["traffic"] == before
    assert not state.lease.exists()


def test_uncertain_health_tag_outcome_is_checkpointed_and_never_retried(bootstrap_case):
    state = bootstrap_case
    state.ports.mutation("--remove-tags=phone-rollback-42")
    state.mutations.clear()

    def unknown(flag):
        state.mutations.append(flag)
        raise TimeoutError("provider outcome unknown")

    state.ports.mutation = unknown
    with pytest.raises(RuntimeError, match="reconciliation"):
        state.module.requalify(state.checkpoint, lease_state=state.lease, ports=state.ports)
    assert state.lease.exists()
    with pytest.raises(ValueError, match="prior_lease"):
        state.module.requalify(state.checkpoint, lease_state=state.lease, ports=state.ports)
    assert len(state.mutations) == 1


def test_unowned_lock_refuses_without_mutation(bootstrap_case):
    state = bootstrap_case

    def unowned():
        raise ValueError("unowned production lock")

    state.ports.lock_owner = unowned
    with pytest.raises(ValueError, match="unowned"):
        state.module.requalify(state.checkpoint, lease_state=state.lease, ports=state.ports)
    assert not state.mutations


@pytest.mark.parametrize("misroute", ["workflow", "job", "attempt", "job-replay", "actor", None])
def test_runtime_requires_the_exact_running_canonical_production_job(
    bootstrap_case, monkeypatch, misroute
):
    state = bootstrap_case
    owner = {
        **state.owner,
        "path": state.module.WORKFLOW,
        "status": "in_progress",
        "head_branch": "main",
        "event": "workflow_dispatch",
        "repository": {"full_name": state.module.REPOSITORY},
        "head_repository": {"full_name": state.module.REPOSITORY},
        "actor": {
            "login": json.loads((ROOT / "config/ci-governance.json").read_text())["production"][
                "manual_dispatch_users"
            ][0]
        },
    }
    monkeypatch.setenv("GITHUB_RUN_ID", "42")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "2")
    monkeypatch.setenv("GITHUB_JOB", "deploy")
    if misroute == "workflow":
        owner["path"] = ".github/workflows/deploy-uat.yml"
    elif misroute == "job":
        monkeypatch.setenv("GITHUB_JOB", "other-job")
    elif misroute == "attempt":
        owner["run_attempt"] = 3
    elif misroute == "actor":
        owner["actor"]["login"] = "synthetic-unapproved-actor"
    job = {
        "name": "Deploy Production Scope",
        "status": "in_progress",
        "run_id": 42,
        "run_attempt": 99 if misroute == "job-replay" else 2,
        "head_sha": PRIMARY,
        "head_branch": "main",
    }
    ports_module = __import__("bootstrap_ports")
    monkeypatch.setattr(
        ports_module,
        "_api",
        lambda endpoint: {"total_count": 1, "jobs": [job]} if "/jobs?" in endpoint else owner,
    )
    if misroute is None:
        assert state.module.Runtime().lock_owner() == owner
    else:
        with pytest.raises(ValueError, match="production_(lock|job)_unproved"):
            state.module.Runtime().lock_owner()


def _artifact_case(state):
    origin = {
        "id": 42,
        "run_attempt": 2,
        "head_sha": PRIMARY,
        "head_branch": "main",
        "repository": {"id": 1},
        "head_repository": {"id": 1},
        "path": state.module.WORKFLOW,
        "status": "completed",
        "conclusion": "success",
    }
    archive = io.BytesIO()
    with ZipFile(archive, "w") as bundle:
        bundle.writestr("bootstrap.json", json.dumps(state.checkpoint))
    payload = archive.getvalue()
    artifact = {
        "id": 4,
        "name": "prod-phone-bootstrap-42-2",
        "expired": False,
        "created_at": "2026-10-26T01:00:01Z",
        "size_in_bytes": len(payload),
        "digest": "sha256:" + hashlib.sha256(payload).hexdigest(),
        "workflow_run": {
            "id": 42,
            "head_sha": PRIMARY,
            "head_branch": "main",
            "repository_id": 1,
            "head_repository_id": 1,
        },
    }
    job = {
        "run_id": 42,
        "run_attempt": 2,
        "head_sha": PRIMARY,
        "head_branch": "main",
        "name": "Deploy Production Scope",
        "status": "completed",
        "steps": [
            {
                "name": state.module.UPLOAD,
                "status": "completed",
                "conclusion": "success",
                "started_at": "2026-10-26T01:00:00Z",
                "completed_at": "2026-10-26T01:00:03Z",
            }
        ],
    }
    return origin, artifact, job, payload


def test_exact_attempt_artifact_is_digest_verified_before_acceptance(bootstrap_case, monkeypatch):
    state = bootstrap_case
    module = state.module
    authority = module._authorities()
    monkeypatch.setattr(authority, "governed_dispatch", lambda *_args, **_kwargs: True)
    origin, artifact, job, payload = _artifact_case(state)
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
        authority.retention,
        "run_command",
        lambda *_args, **_kwargs: SimpleNamespace(stdout=payload),
    )
    assert module.load_checkpoint("42", 2) == state.checkpoint
    artifact["digest"] = "sha256:" + "0" * 64
    with pytest.raises(RuntimeError, match="digest"):
        module.load_checkpoint("42", 2)
    origin["run_attempt"] = 3
    with pytest.raises(ValueError, match="origin_unqualified"):
        module.load_checkpoint("42", 2)


@pytest.mark.parametrize("phase,expected", [("cold", "cold"), ("standard", "coldprimary")])
def test_cold_phase_dispatch_cannot_reach_primary(phase, expected):
    helper = ROOT / "scripts/deploy/backend-phone-rollback.sh"
    script = 'source "$1"; stage_phone_rollback() { printf cold; }; gcloud() { printf primary; }; deploy_phone_phase "$2" "$3" "$4" production hushh-pda true gcloud run deploy consent-protocol'
    result = subprocess.run(  # noqa: S603 - Fixed repository helper and synthetic arguments; provider calls are stubs.
        ["bash", "-euo", "pipefail", "-c", script, "phase", str(helper), phase, FALLBACK, IMAGE],
        text=True,
        capture_output=True,
        check=True,
    )
    assert result.stdout == expected


def test_cold_workflow_is_terminal_without_producer_mutations():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    assert workflow[True]["workflow_dispatch"]["inputs"]["phone_phase"]["default"] == "standard"
    assert workflow["concurrency"]["group"] == "deploy-production"
    steps = {step["name"]: step for step in workflow["jobs"]["deploy"]["steps"]}
    for name in (
        "Install fail-closed account deletion release fence",
        "Apply production DB migrations behind account deletion fence",
        "Sync canonical hosted runtime secrets",
        "Sync frontend hosted runtime secrets",
        "Promote deployed revisions to production traffic",
        "Write production release status artifact",
        "Tag this release as last known good",
        "Retire unused production tags after a healthy release",
    ):
        assert "env.PHONE_DEPLOY_PHASE != 'cold'" in steps[name]["if"]
    upload = steps["Upload cold phone qualification checkpoint"]
    assert (
        upload["with"]["name"]
        == "prod-phone-bootstrap-${{ github.run_id }}-${{ github.run_attempt }}"
    )
    assert upload["with"]["path"] == "/tmp/phone-rollback/bootstrap.json"  # noqa: S108 - Assert authored artifact location; no file is opened.
    assert "steps.cold-lease-cleanup.outcome == 'success'" in upload["if"]
    assert "always()" in steps["Retire initial cold health-tag lease"]["if"]
    assert (
        "steps.cold-lease.outcome == 'success'" in steps["Deploy backend using Cloud Build"]["if"]
    )
    assert (
        "initial-lease.json"
        in steps["Publish cold health-tag reconciliation evidence"]["with"]["path"]
    )
    assert "always()" in steps["Require published cold qualification checkpoint"]["if"]
    assert "exit 1" in steps["Require published cold qualification checkpoint"]["run"]


def _initial_lease(state):
    state.ports.mutation("--remove-tags=phone-rollback-42")
    before = copy.deepcopy(state.service)
    state.module.begin(state.prepared, before, state.iam, state=state.lease, ports=state.ports)
    state.ports.mutation("--update-tags=phone-rollback-42=consent-protocol-00002-cold")
    state.mutations.clear()
    return before


def test_initial_health_route_is_retired_before_checkpoint_can_be_replayed(
    bootstrap_case, tmp_path
):
    state = bootstrap_case
    before = _initial_lease(state)
    receipt = state.module.checkpoint(
        state.prepared, before, before_iam=state.iam, ports=state.ports
    )
    output = tmp_path / "bootstrap.json"
    output.write_text(json.dumps(receipt))
    with pytest.raises(ValueError, match="identity_invalid"):
        state.module._identity(receipt)
    state.module.retire_initial(
        state=state.lease, checkpoint_path=output, completed=True, ports=state.ports
    )
    final = json.loads(output.read_text())
    state.module._identity(final)
    assert final["health_tag"] == "retired"
    assert json.loads(state.lease.read_text())["status"] == "retired"
    assert state.service["spec"]["traffic"] == before["spec"]["traffic"]
    assert state.service["status"]["traffic"] == before["status"]["traffic"]
    assert state.mutations == ["--remove-tags=phone-rollback-42"]


@pytest.mark.parametrize("change", ["scaling", "iam"])
def test_checkpoint_rejects_operational_or_iam_changes(bootstrap_case, change):
    state = bootstrap_case
    before = _initial_lease(state)
    policy = copy.deepcopy(state.iam)
    if change == "scaling":
        state.service["metadata"]["annotations"] = {"run.googleapis.com/maxScale": "5"}
    else:
        state.iam["bindings"][0]["members"].append("user:synthetic@example.invalid")
    with pytest.raises(ValueError, match="operational_controls_changed"):
        state.module.checkpoint(state.prepared, before, before_iam=policy, ports=state.ports)


@pytest.mark.parametrize("failure", ["unknown-build", "unknown-cleanup", "foreign-revision"])
def test_initial_cleanup_preserves_reconciliation_on_uncertain_or_unowned_outcome(
    bootstrap_case, tmp_path, failure
):
    state = bootstrap_case
    _initial_lease(state)
    if failure == "unknown-cleanup":
        state.ports.mutation = lambda _flag: (_ for _ in ()).throw(TimeoutError("synthetic"))
    elif failure == "foreign-revision":
        state.revision["metadata"]["labels"]["github-run-id"] = "99"
    with pytest.raises((RuntimeError, ValueError, TimeoutError)):
        state.module.retire_initial(
            state=state.lease,
            checkpoint_path=tmp_path / "absent.json",
            completed=failure != "unknown-build",
            ports=state.ports,
        )
    assert json.loads(state.lease.read_text())["status"] == "pending"
    if failure == "foreign-revision":
        assert not state.mutations
    elif failure == "unknown-build":
        assert state.mutations == ["--remove-tags=phone-rollback-42"]


def test_cold_only_template_cannot_change_service_scaling_or_invoker_iam(cold_deployment):
    module, command, identity = cold_deployment
    service_flags = ["--min=1", "--max=5", "--allow-unauthenticated"]
    command += service_flags
    standard = module.cold_command(command, **identity)
    cold = module.cold_command(command, **identity, qualification_only=True)
    assert all(flag in standard for flag in service_flags)
    assert not any(flag in cold for flag in service_flags)
    for flag in (
        "--min-instances=0",
        "--max-instances=8",
        "--service-account=consent-protocol-runtime@hushh-pda.iam.gserviceaccount.com",
    ):
        assert flag in cold
