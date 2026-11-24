"""Retained operational rollback authority must never become another cold deploy."""

from __future__ import annotations

import copy
import json
import os
import subprocess
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import yaml

from tests.test_phone_rollback_release import FALLBACK, IMAGE, PRIMARY, REVISION, ROOT, _verify_args
from tests.test_phone_rollback_release import release_plan as release_plan

pytestmark = pytest.mark.feature_auth_reliability


def test_operational_maintenance_prepares_locked_database_runtime_before_budget():
    workflow = yaml.safe_load((ROOT / ".github/workflows/capacity-maintenance.yml").read_text())
    steps = workflow["jobs"]["cleanup"]["steps"]
    setup = next(
        step
        for step in steps
        if step.get("uses") == "./consent-protocol/.github/actions/setup-python-uv"
    )
    select = next(step for step in steps if step.get("name") == "Select maintenance Python runtime")
    proxy = next(
        step for step in steps if step.get("name") == "Install operational Cloud SQL Auth Proxy"
    )
    budget = next(
        step for step in steps if step.get("name") == "Start the five-minute cleanup budget"
    )
    publish = next(
        step
        for step in steps
        if "production_backend_successor_control.py apply" in step.get("run", "")
    )
    assert (
        setup["if"]
        == select["if"]
        == proxy["if"]
        == "inputs.operational_backend_proof_run_id != ''"
    )
    assert setup["with"] == {
        "python-version": "3.13",
        "protocol-dir": "./consent-protocol",
        "sync-dev-group": "false",
    }
    assert 'echo "$GITHUB_WORKSPACE/consent-protocol/.venv/bin" >> "$GITHUB_PATH"' in select["run"]
    deploy = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    original = next(
        step
        for step in deploy["jobs"]["deploy"]["steps"]
        if step.get("name") == "Install Cloud SQL Auth Proxy"
    )
    assert proxy["run"] == original["run"]
    assert (
        steps.index(setup)
        < steps.index(select)
        < steps.index(proxy)
        < steps.index(budget)
        < steps.index(publish)
    )
    assert "python3 scripts/ci/production_backend_successor_control.py apply" in publish["run"]


@pytest.fixture
def operational_plan(release_plan, monkeypatch):
    import operational_reference

    state = release_plan
    state.reference = operational_reference
    state.reference_calls = []
    state.tag = {
        "commit": "d" * 40,
        "message": "canonical bound annotation",
        "tag_object": "canonical annotated tag",
        "tag_oid": "e" * 40,
    }
    state.anchor = {
        "revision": "consent-protocol-00310-cold",
        "source": FALLBACK,
        "image": IMAGE,
        "uid": "cold-runtime-uid",
        "origin": {
            "run_id": "40",
            "run_attempt": 2,
            "workflow_sha": "f" * 40,
            "artifact_id": 9,
            "artifact_digest": "sha256:" + "a" * 64,
        },
        "runtime": {
            "service_uid": "service-uid",
            "controls": "a" * 64,
            "iam": "b" * 64,
            "initial_traffic": "c" * 64,
        },
        "sealed_boundary": {
            "checkpoint": {
                "plan": {
                    "probe": state.plan.qualify_image.qualify(FALLBACK, IMAGE),
                }
            }
        },
    }

    def read_original():
        state.reference_calls.append("read")
        return copy.deepcopy(state.tag)

    def record_anchor(tag):
        assert tag == state.tag
        state.reference_calls.append("record")
        return copy.deepcopy(state.anchor)

    def live(anchor):
        assert anchor == state.anchor
        state.reference_calls.append("live")

    state.proof = SimpleNamespace(read_original=read_original)
    state.control = SimpleNamespace(record_anchor=record_anchor, live=live)
    state.image_probes = []
    qualify = state.plan.qualify_image.qualify

    def image_probe(*args):
        state.image_probes.append(args)
        return qualify(*args)

    monkeypatch.setattr(state.plan.qualify_image, "qualify", image_probe)
    monkeypatch.setattr(operational_reference, "_owners", lambda: (state.proof, state.control))
    monkeypatch.setattr(state.plan, "_operational", operational_reference.current)
    state.args.current_json.write_text(
        json.dumps({"metadata": {"labels": {"deploy-sha": "d" * 40}}})
    )
    return state


def test_operational_plan_reuses_exact_reference_without_extra_deploy_or_health_claim(
    operational_plan,
):
    state = operational_plan
    prepared = state.plan.prepare(state.args)
    assert prepared["mode"] == "operational"
    assert prepared["revision"] == state.anchor["revision"]
    assert prepared["operational_reference"] == {
        "tag": state.tag,
        **{key: state.anchor[key] for key in ("origin", "uid", "runtime")},
    }
    assert prepared["probe"] == state.anchor["sealed_boundary"]["checkpoint"]["plan"]["probe"]
    assert (
        state.args.github_output.read_text()
        == "fallback_sha=\nfallback_image=\nrecovery_enabled=false\n"
    )
    result = state.plan.verify(_verify_args(state))
    assert result["mode"] == "operational" and result["uid"] == state.anchor["uid"]
    assert result["operational_reference"] == prepared["operational_reference"]
    assert result["recovery"] is False and result["sso"] is False
    assert "health" not in result and "production" not in prepared
    assert state.reference_calls == ["read", "record", "live"] * 2
    assert all(call[:2] == ["git", "show"] for call in state.calls)
    assert state.image_probes == []  # Retain the original executable image proof.


def test_healthy_existing_selection_precedes_operational_reference(operational_plan):
    state = operational_plan
    state.args.current_json.write_text(json.dumps(state.revision))
    assert state.plan.prepare(state.args)["mode"] == "existing"
    assert state.reference_calls == []


@pytest.mark.parametrize("serving_cold", [False, True])
def test_explicit_fallback_cannot_replace_active_operational_reference(
    operational_plan, serving_cold
):
    state = operational_plan
    if serving_cold:
        state.revision["metadata"]["labels"]["deploy-source"] = "deploy-production-phone-rollback"
        state.args.current_json.write_text(json.dumps(state.revision))
    state.args.fallback_sha = FALLBACK
    with pytest.raises(ValueError, match="independent_source_unnecessary"):
        state.plan.prepare(state.args)
    assert not state.calls and not state.args.output.exists()


@pytest.mark.parametrize("failure", ["read_original", "record_anchor", "live"])
def test_present_or_unavailable_operational_proof_never_falls_back(
    operational_plan, monkeypatch, failure
):
    state = operational_plan
    state.args.fallback_sha = FALLBACK

    def unavailable(*_args):
        raise RuntimeError("canonical operational proof unavailable")

    owner = state.proof if failure == "read_original" else state.control
    monkeypatch.setattr(owner, failure, unavailable)
    with pytest.raises(RuntimeError):
        state.plan.prepare(state.args)
    assert not state.calls and not state.args.output.exists()
    assert not state.args.github_output.exists()


def test_only_canonical_absence_allows_independent_cold_plan(operational_plan):
    state = operational_plan
    state.anchor = None
    state.args.fallback_sha = FALLBACK
    assert state.plan.prepare(state.args)["mode"] == "cold"
    assert state.reference_calls == ["read", "record"]
    assert any(call[:4] == ["gcloud", "container", "images", "add-tag"] for call in state.calls)


@pytest.mark.parametrize(
    "phase,scope,allowed",
    [("cold", "backend", True), ("standard", "backend", False)]
    + [("cold", scope, False) for scope in ("all", "frontend", "auto")],
)
def test_cold_scope_selects_qualification_without_waiving_ordinary_atomicity(
    tmp_path, phase, scope, allowed
):
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    steps = {step["name"]: step for step in workflow["jobs"]["deploy"]["steps"]}
    script = steps["Resolve deployment scope"]["run"]
    values = {
        "github.event.inputs.scope": scope,
        "github.event.inputs.sha": PRIMARY,
        "steps.predeploy-state.outputs.backend_sha": FALLBACK,
        "steps.predeploy-state.outputs.frontend_sha": "d" * 40,
        "inputs.cadence_origin != ''": "false",
    }
    for key, value in values.items():
        script = script.replace("${{ " + key + " }}", value)
    assert "${{" not in script
    tools = tmp_path / "release-tools"
    tools.mkdir()
    calls = tmp_path / "resolver-calls.json"
    (tools / "resolve-deploy-scope.py").write_text(
        "import json,os,sys\nfrom pathlib import Path\n"
        "Path(os.environ['RESOLVER_CALLS']).write_text(json.dumps(sys.argv[1:]))\n"
        "sys.exit('A narrow manual deploy would split the account-lifecycle boundary')\n"
    )
    output = tmp_path / "outputs"
    result = subprocess.run(  # noqa: S603 - Actual workflow shell with a rejecting scope-owner port.
        ["bash", "-euo", "pipefail", "-c", script],
        env={
            **os.environ,
            "PHONE_DEPLOY_PHASE": phase,
            "RUNNER_TEMP": str(tmp_path),
            "GITHUB_OUTPUT": str(output),
            "RESOLVER_CALLS": str(calls),
        },
        text=True,
        capture_output=True,
        timeout=20,
    )
    assert (result.returncode == 0) is allowed, result.stderr
    if allowed:
        assert dict(line.split("=", 1) for line in output.read_text().splitlines()) == {
            "scope": "backend",
            "deploy_backend": "true",
            "deploy_frontend": "false",
            "reason": "cold:qualification",
        }
    else:
        assert not output.exists()
    if phase == "standard":
        args = json.loads(calls.read_text())
        assert args[args.index("--backend-base-sha") + 1] == FALLBACK
        assert args[args.index("--frontend-base-sha") + 1] == "d" * 40
        assert "account-lifecycle boundary" in result.stderr
    else:
        assert not calls.exists()


@pytest.mark.parametrize(
    "changed", ["tag", "uid", "source", "image", "run", "artifact", "runtime", "probe", "absent"]
)
def test_verify_rebinds_operational_reference_before_any_qualification_output(
    operational_plan, changed
):
    state = operational_plan
    state.plan.prepare(state.args)
    if changed == "tag":
        state.tag["tag_oid"] = "f" * 40
    elif changed in {"uid", "source", "image"}:
        state.anchor[changed] += "changed"
    elif changed == "run":
        state.anchor["origin"]["run_attempt"] = 3
    elif changed == "artifact":
        state.anchor["origin"]["artifact_digest"] = "sha256:" + "b" * 64
    elif changed == "runtime":
        state.anchor["runtime"]["controls"] = "c" * 64
    elif changed == "probe":
        state.anchor["sealed_boundary"]["checkpoint"]["plan"]["probe"]["probe_sha256"] = "d" * 64
    else:
        state.anchor = None
    args = _verify_args(state)
    with pytest.raises(ValueError, match="operational_reference_changed"):
        state.plan.verify(args)
    assert not args.output.exists() and not args.github_output.exists()
    assert all(call[:2] == ["git", "show"] for call in state.calls)


def test_new_primary_consumer_drift_cannot_reuse_old_operational_proof(
    operational_plan, monkeypatch
):
    state = operational_plan
    state.plan.prepare(state.args)
    original = state.plan.qualify_consumers
    monkeypatch.setattr(
        state.plan, "qualify_consumers", lambda *args: {**original(*args), "unreviewed": True}
    )
    with pytest.raises(ValueError, match="preparation_evidence_mismatch"):
        state.plan.verify(_verify_args(state))


def test_operational_target_must_remain_independent_and_source_admitted(operational_plan):
    state = operational_plan
    state.anchor["source"] = PRIMARY
    with pytest.raises(ValueError, match="requires_independent_source"):
        state.plan.prepare(state.args)
    state.anchor["source"] = "e" * 40
    with pytest.raises(ValueError, match="source_lacks_current_admission"):
        state.plan.prepare(state.args)
    assert not state.args.output.exists()


def test_continuation_requires_retained_operational_reference_without_requalifying_pending_as_healthy(
    operational_plan,
    monkeypatch,
):
    state = operational_plan
    state.args.operational_only = True
    state.args.current_json.write_text(json.dumps(state.revision))

    def no_existing(*_args):
        raise AssertionError("pending primary cannot be treated as an existing healthy release")

    monkeypatch.setattr(state.plan, "_existing", no_existing)
    assert state.plan.prepare(state.args)["mode"] == "operational"
    monkeypatch.setattr(state.plan, "_operational", lambda: None)
    with pytest.raises(ValueError, match="operational_reference_required"):
        state.plan.prepare(state.args)


@pytest.mark.parametrize("mismatch", ["", "phone_rollback_consumer_change_unqualified"])
def test_explicit_replacement_requires_an_incompatible_verified_baseline(
    release_plan, monkeypatch, mismatch
):
    state = release_plan
    state.args.fallback_sha = FALLBACK
    state.args.fallback_qualification = "main"
    existing = {
        "mode": "existing",
        "source": "d" * 40,
        "image": IMAGE,
        "revision": REVISION,
    }
    monkeypatch.setattr(state.plan, "_existing", lambda *_: existing)
    original = state.plan.qualify_consumers

    def compatibility(fallback, primary):
        if fallback == existing["source"] and mismatch:
            raise ValueError(mismatch)
        return original(FALLBACK, primary)

    monkeypatch.setattr(state.plan, "qualify_consumers", compatibility)
    monkeypatch.setattr(state.plan, "same_backend", lambda *_: True)
    builds = []

    def build(source, *_):
        builds.append(source)
        return {
            "mode": "cold",
            "source": source,
            "image": IMAGE,
            "probe": state.plan.qualify_image.qualify(source, IMAGE),
            "predecessor": {"kind": "main-qualified-source"},
        }

    monkeypatch.setattr(state.plan, "qualify_replacement_image", build)
    if not mismatch:
        with pytest.raises(ValueError, match="independent_source_unnecessary"):
            state.plan.prepare(state.args)
        assert not builds
        return
    prepared = state.plan.prepare(state.args)
    assert prepared["mode"] == "cold"
    assert prepared["source"] == FALLBACK
    assert prepared["replacement_of"] == {
        key: existing[key] for key in ("source", "image", "revision")
    }
    assert builds == [FALLBACK]


@pytest.mark.parametrize("failure", ["different_backend", "same_source", "other_error"])
def test_replacement_refuses_before_building_or_writing(release_plan, monkeypatch, failure):
    state = release_plan
    state.args.fallback_sha = PRIMARY if failure == "same_source" else FALLBACK
    state.args.fallback_qualification = "main"
    monkeypatch.setattr(
        state.plan,
        "_existing",
        lambda *_: {
            "mode": "existing",
            "source": "d" * 40,
            "image": IMAGE,
            "revision": REVISION,
        },
    )

    def incompatible(*_):
        reason = (
            "phone_image_packaged_source_mismatch"
            if failure == "other_error"
            else "phone_rollback_consumer_change_unqualified"
        )
        raise ValueError(reason)

    monkeypatch.setattr(state.plan, "qualify_consumers", incompatible)
    monkeypatch.setattr(state.plan, "same_backend", lambda *_: failure != "different_backend")
    build = MagicMock()
    monkeypatch.setattr(state.plan, "qualify_replacement_image", build)
    with pytest.raises(ValueError):
        state.plan.prepare(state.args)
    build.assert_not_called()
    assert not state.args.output.exists()
    assert not state.args.github_output.exists()


@pytest.mark.parametrize(
    "failure",
    [
        "",
        "main",
        "build",
        "output",
        "tag",
        "platform",
        "digest",
        "probe",
        "pending",
        "timeout",
        "poll_identity",
    ],
)
def test_replacement_binds_main_build_native_output_and_actual_image(
    release_plan, monkeypatch, failure
):
    import base64
    import tarfile

    import replacement_image

    source = FALLBACK
    native = {
        "kind": "backend-image-build-output-v1",
        "imageTag": "wrong" if failure == "tag" else "phone-rollback-" + source,
        "platform": "linux/arm64" if failure == "platform" else "linux/amd64",
        "indexDigest": "mutable-tag" if failure == "digest" else "sha256:" + "a" * 64,
    }
    build = {
        "id": "12345678-1234-1234-1234-123456789abc",
        "projectId": "hushh-pda",
        "status": "FAILURE" if failure == "build" else "SUCCESS",
        "steps": [{"id": "record-backend-image", "status": "SUCCESS"}],
        "results": {
            "buildStepOutputs": []
            if failure == "output"
            else [
                base64.b64encode(json.dumps(native).encode()).decode(),
            ]
        },
    }
    calls = []
    monkeypatch.setattr(
        replacement_image,
        "time",
        SimpleNamespace(
            monotonic=MagicMock(side_effect=[0, 3001] if failure == "timeout" else [0, 1]),
            sleep=lambda _: None,
        ),
    )

    def command(args, **_kwargs):
        calls.append(args)
        if args[0] == "git":
            archive = next(arg.split("=", 1)[1] for arg in args if arg.startswith("--output="))
            with tarfile.open(archive, "w"):
                pass
            return b""
        if args[:3] == ["gcloud", "builds", "submit"]:
            assert "--suppress-logs" in args
            initial = dict(build)
            if failure in {"pending", "timeout", "poll_identity"}:
                initial["status"] = "WORKING"
            return json.dumps(initial).encode()
        if args[:3] == ["gcloud", "builds", "describe"]:
            observed = dict(build)
            if failure == "poll_identity":
                observed["id"] = "87654321-1234-1234-1234-123456789abc"
            return json.dumps(observed).encode()
        if args[:3] == ["gcloud", "builds", "cancel"]:
            return b""
        if args[:3] == ["docker", "buildx", "imagetools"]:
            return b"{}"
        if args[0] == "python3" and args[1].endswith("resolve-cloud-run-image.py"):
            assert args[args.index("--image-reference") + 1].endswith("@sha256:" + "a" * 64)
            return IMAGE.encode()
        assert args[0] == "python3" and args[2] == "main-source"
        receipt = {
            "kind": "main-qualified-source",
            "environment": "production",
            "status": "refused" if failure == "main" else "qualified",
            "sha": source,
            "main_approval_sha": source,
            "resolved_services": ["backend"],
        }
        output = args[args.index("--output") + 1]
        from pathlib import Path

        if "--predecessor" in args:
            assert json.loads(Path(output).read_text()) == receipt
        Path(output).write_text(json.dumps(receipt))
        return b""

    monkeypatch.setattr(replacement_image.qualify_image, "run", command)
    probe = release_plan.plan.qualify_image.qualify

    def qualify(*args):
        if failure == "probe":
            raise ValueError("phone_image_packaged_source_mismatch")
        return probe(*args)

    monkeypatch.setattr(replacement_image.qualify_image, "qualify", qualify)
    if failure and failure != "pending":
        with pytest.raises((ValueError, TimeoutError)):
            replacement_image.qualify_replacement_image(
                source, release_plan.args.release_tools, release_plan.args.output.parent
            )
        if failure in {"timeout", "poll_identity"}:
            assert any(call[:3] == ["gcloud", "builds", "cancel"] for call in calls)
        return
    result = replacement_image.qualify_replacement_image(
        source, release_plan.args.release_tools, release_plan.args.output.parent
    )
    assert (result["mode"], result["source"], result["image"]) == ("cold", source, IMAGE)
    assert result["build_id"] == build["id"]
    assert sum(len(call) > 2 and call[2] == "main-source" for call in calls) == 2
    assert not any(call[:3] == ["gcloud", "container", "images"] for call in calls)


def test_main_replacement_retry_retains_main_qualification(release_plan, monkeypatch):
    state = release_plan
    state.revision["metadata"]["labels"]["deploy-source"] = "deploy-production-phone-rollback"
    state.args.current_json.write_text(json.dumps(state.revision))
    state.args.fallback_sha = FALLBACK
    state.args.fallback_qualification = "main"
    monkeypatch.setattr(state.plan, "same_backend", lambda *_: True)
    build = MagicMock(
        return_value={
            "mode": "cold",
            "source": FALLBACK,
            "image": IMAGE,
            "probe": state.plan.qualify_image.qualify(FALLBACK, IMAGE),
            "predecessor": {"kind": "main-qualified-source"},
        }
    )
    monkeypatch.setattr(state.plan, "qualify_replacement_image", build)
    original = MagicMock()
    monkeypatch.setattr(state.plan, "_independent", original)
    result = state.plan.prepare(state.args)
    assert result["predecessor"]["kind"] == "main-qualified-source"
    build.assert_called_once_with(FALLBACK, state.args.release_tools, state.args.output.parent)
    original.assert_not_called()


def test_main_fallback_is_rechecked_before_promotion(release_plan, monkeypatch):
    state = release_plan
    state.revision["metadata"]["labels"]["deploy-source"] = "deploy-production-phone-rollback"
    state.args.current_json.write_text(json.dumps(state.revision))
    state.args.fallback_sha = FALLBACK
    state.args.fallback_qualification = "main"
    monkeypatch.setattr(state.plan, "same_backend", lambda *_: True)
    monkeypatch.setattr(
        state.plan,
        "qualify_replacement_image",
        lambda *_: {
            "mode": "cold",
            "source": FALLBACK,
            "image": IMAGE,
            "probe": state.plan.qualify_image.qualify(FALLBACK, IMAGE),
            "predecessor": {"kind": "main-qualified-source"},
        },
    )
    state.plan.prepare(state.args)
    receipt = MagicMock()
    monkeypatch.setattr(state.plan, "recheck_main_source", receipt)
    monkeypatch.setattr(
        state.plan,
        "inspect_cold",
        lambda **_: {
            "source": FALLBACK,
            "image": IMAGE,
            "revision": REVISION,
        },
    )
    args = _verify_args(state)
    args.release_tools = state.args.release_tools
    assert state.plan.verify(args)["qualification"] == "passed"
    receipt.assert_called_once()
    monkeypatch.setattr(state.plan, "same_backend", lambda *_: False)
    with pytest.raises(ValueError, match="replacement_source_invalid"):
        state.plan.verify(args)
