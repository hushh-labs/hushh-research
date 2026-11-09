# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Direct UAT pins its CI base and preserves historical acceptance authority."""

from pathlib import Path
from unittest import mock

import pytest
import yaml

from tests.helpers.predecessor_acceptance import SHA, _acceptance_fixture

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize(
    "job",
    ["protocol-check", "web-full-suite-check", "web-targeted-check"],
)
def test_direct_uat_ci_lanes_fetch_full_history_and_resolve_the_reviewed_base(
    job: str,
) -> None:
    workflow = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
    steps = workflow["jobs"][job]["steps"]
    checkout = next(
        step for step in steps if (step.get("uses") or "").startswith("actions/checkout@")
    )
    assert checkout.get("with", {}).get("fetch-depth") == 0
    graph_steps = [step for step in steps if "CAPABILITY_GRAPH_BASE_REF" in (step.get("env") or {})]
    assert len(graph_steps) == 1
    base_ref = graph_steps[0]["env"]["CAPABILITY_GRAPH_BASE_REF"]
    assert all(
        fragment in base_ref
        for fragment in (
            "format('origin/{0}'",
            "github.base_ref || 'main'",
            "inputs.uat_base_sha",
            "github.ref == 'refs/heads/dev'",
            "inputs.scope == 'all'",
        )
    ), f"{job} must resolve the reviewed PR or exact direct-UAT base"


def predecessor():
    return {
        "schema_version": 1,
        "kind": "uat-exact-ci",
        "status": "accepted",
        "environment": "uat",
        "repository": "hushh-labs/hushh-research",
        "sha": SHA,
        "tree": "b" * 40,
        "base_sha": "c" * 40,
        "authority_sha": "a" * 40,
        "services": ["backend", "frontend"],
        "run_id": 42,
        "run_attempt": 2,
    }


def test_historical_uat_ci_receipt_does_not_require_a_dev_deployment_or_current_uat_tip(
    monkeypatch,
):
    module, client, receipts, responses, pins = _acceptance_fixture()
    receipts["uat"]["predecessor"] = predecessor()
    run, artifact, _ = client._receipt(pins["uat"], "uat")
    monkeypatch.setattr(client, "_receipt", lambda *args: (run, artifact, receipts["uat"]))
    with mock.patch.object(module, "_verify_direct_uat") as verified:
        accepted = client.accept(pins["uat"], "uat", SHA, "backend")
    verified.assert_called_once_with(
        receipts["uat"]["predecessor"], SHA, {"backend"}, current=False
    )
    assert accepted["run_id"] == 20
    receipts["uat"]["predecessor"]["authority_sha"] = "e" * 40
    with pytest.raises(module.Refused, match="authority"):
        client.accept(pins["uat"], "uat", SHA, "backend")


@pytest.mark.parametrize(
    "changed",
    [
        {"sha": "e" * 40},
        {"kind": "dev"},
        {"schema_version": 2},
        {"services": ["frontend"]},
        {"run_attempt": 0},
        {"repository": "other/repository"},
        {"tree": ""},
        {"status": "pending"},
    ],
)
def test_direct_receipt_rejects_wrong_source_scope_attempt_or_shape(changed):
    module, *_ = _acceptance_fixture()
    module._provenance.validate_uat_ci_predecessor(predecessor(), SHA, {"backend"})
    with pytest.raises(module.Refused):
        module._provenance.validate_uat_ci_predecessor(
            {**predecessor(), **changed}, SHA, {"backend"}
        )


def prerequisite_fixture(monkeypatch):
    from copy import deepcopy

    monkeypatch.syspath_prepend(str(ROOT / "scripts/ci"))
    import uat_release_prerequisites as subject
    from uat_exact_ci_fixture import AttemptAPI, attempt_check, attempt_jobs, attempt_run

    base = "c" * 40
    run = attempt_run(SHA)
    transport = AttemptAPI(run, attempt_jobs(SHA, base), [run], attempt_check(SHA))

    class API:
        reads = 0
        changed_tip = False

        def read(self, path):
            if path.endswith("/branches/uat"):
                self.reads += 1
                sha = "e" * 40 if self.changed_tip and self.reads > 2 else SHA
                return {"protected": True, "commit": {"sha": sha}}
            return deepcopy(transport.read(path))

    monkeypatch.setattr(subject.exact, "verify_git_authority", lambda *args, **kwargs: "b" * 40)
    serving = {
        name: {"sha": base, "revision": name + "-00001-abc"} for name in ("backend", "frontend")
    }
    return subject, API(), transport, serving


@pytest.mark.parametrize(
    "case,reason",
    [
        ("ready", "qualified_current_ci"),
        ("static_bound", "qualified_current_ci"),
        ("missing", "qualification_missing"),
        ("no_exact_job", "qualification_missing"),
        ("empty_base", "qualification_missing"),
        ("pending", "qualification_in_flight"),
        ("failed", "qualification_failed"),
        ("legacy", "qualification_base_unpublished"),
        ("wrong_base", "qualification_base_changed"),
        ("missing_job", "qualification_unverified"),
        ("advanced", "qualification_unverified"),
        ("newer_failed", "qualification_failed"),
    ],
)
def test_actions_inspection_offers_only_current_full_exact_source_ci(monkeypatch, case, reason):
    from copy import deepcopy

    subject, api, transport, serving = prerequisite_fixture(monkeypatch)
    if case == "missing":
        transport.runs = []
    elif case in {"pending", "failed"}:
        transport.run.update(
            status="in_progress" if case == "pending" else "completed",
            conclusion=None if case == "pending" else "failure",
        )
    elif case in {"no_exact_job", "empty_base"}:
        if case == "no_exact_job":
            transport.jobs = [
                job for job in transport.jobs if not job["name"].startswith("Exact UAT Candidate")
            ]
        else:
            next(job for job in transport.jobs if job["name"].startswith("Exact UAT Candidate"))[
                "name"
            ] = "Exact UAT Candidate ()"
    elif case in {"legacy", "wrong_base"}:
        job = next(job for job in transport.jobs if job["name"].startswith("Exact UAT Candidate"))
        job["name"] = (
            "Exact UAT Candidate" if case == "legacy" else f"Exact UAT Candidate ({'d' * 40})"
        )
    elif case == "static_bound":
        job = next(job for job in transport.jobs if job["name"].startswith("Exact UAT Candidate"))
        job["name"] = "Exact UAT Candidate"
        job["steps"].insert(
            0,
            {
                "name": f"Verify exact serving base ({'c' * 40})",
                "conclusion": "success",
            },
        )
    elif case == "missing_job":
        transport.jobs = [job for job in transport.jobs if job["name"] != "Secret Scan"]
    elif case == "advanced":
        original = subject.exact.verify_attempt

        def racing(*args, **kwargs):
            transport.runs[0]["run_attempt"] = 2
            return original(*args, **kwargs)

        monkeypatch.setattr(subject.exact, "verify_attempt", racing)
    elif case == "newer_failed":
        other = {
            **deepcopy(transport.run),
            "id": 124,
            "conclusion": "failure",
            "run_started_at": "2026-10-29T00:00:00Z",
            "updated_at": "2026-10-29T00:01:00Z",
        }
        transport.runs.append(other)
    result = subject.inspect(api, "a" * 40, read_live=lambda _: deepcopy(serving))
    assert result["ready"] == (case in {"ready", "static_bound"})
    assert result["reason_code"] == reason
    rendered = subject.render(result)
    assert ("Run workflow:" in rendered) == (
        case in {"missing", "no_exact_job", "empty_base", "legacy", "wrong_base"}
    )
    if case == "pending":
        assert "do not dispatch a replacement" in rendered
    if case == "ready":
        assert result["ci_run_id"] == 123 and result["ci_run_attempt"] == 1
        assert f"ci_base_sha={'c' * 40}" in rendered


@pytest.mark.parametrize("case", ["tip", "serving", "mixed", "unknown", "authority"])
def test_inspection_refuses_changed_or_unprovable_source_and_live_base(monkeypatch, case):
    from copy import deepcopy

    subject, api, _, serving = prerequisite_fixture(monkeypatch)
    api.changed_tip = case == "tip"
    if case == "tip":

        def missing_history(*_args):
            raise subject.Refused("The replacement tip does not contain the selected source")

        monkeypatch.setattr(subject.exact, "git", missing_history)
    if case in {"mixed", "unknown"}:
        serving["frontend"]["sha"] = "d" * 40 if case == "mixed" else ""
    if case == "authority":

        def unreviewed(*args, branch):
            assert branch == "uat"
            raise subject.Refused("UAT CI authority differs from reviewed Main")

        monkeypatch.setattr(subject.exact, "verify_git_authority", unreviewed)
    calls = 0

    def live(_):
        nonlocal calls
        calls += 1
        result = deepcopy(serving)
        if case == "serving" and calls > 1:
            result["backend"]["revision"] = "backend-00002-abc"
        return result

    if case == "mixed":
        result = subject.inspect(api, "a" * 40, read_live=live)
        assert result["serving"] == serving
        assert result["ready"] is True
    else:
        with pytest.raises(subject.Refused):
            subject.inspect(api, "a" * 40, read_live=live)


@pytest.mark.parametrize(
    "key,value",
    [
        ("sha", SHA),
        ("ci_run_id", "123"),
        ("ci_base_sha", "c" * 40),
        ("scope", "backend"),
        ("backend_image_source", "build-from-source"),
        ("run_live_model_checks", True),
        ("preserve_paused_drive_worker", "true"),
    ],
)
def test_inspection_refuses_release_overrides_before_authentication(monkeypatch, key, value):
    subject, *_ = prerequisite_fixture(monkeypatch)
    inputs = {
        "operation": "inspect",
        "target": "shared-uat",
        "scope": "auto",
        "backend_image_source": "auto",
        "sha": "",
        "run_live_model_checks": False,
    }
    subject.validate_inspection(inputs)
    with pytest.raises(subject.Refused):
        subject.validate_inspection({**inputs, key: value})


@pytest.mark.parametrize(
    "pins", [("", "", ""), ("123", "", "c" * 40), ("123", "1", "bad"), ("123", "0", "c" * 40)]
)
def test_deploy_missing_or_malformed_pins_fail_before_any_api_read(monkeypatch, pins):
    subject, *_ = prerequisite_fixture(monkeypatch)
    api = mock.Mock()
    with pytest.raises(subject.Refused):
        subject.validate_deployment(api, SHA, *pins)
    api.read.assert_not_called()


def test_actions_inspection_and_early_validation_cannot_enter_release_jobs():
    workflow = yaml.safe_load(
        (ROOT / ".github/workflows/deploy-uat-implementation.yml").read_text()
    )
    jobs = workflow["jobs"]
    inspector = jobs["inspect-prerequisites"]
    for name in ("inspect-prerequisites", "select-target"):
        assert jobs[name]["environment"] == {"name": "uat", "deployment": False}
        assert (
            jobs[name]["env"]["UAT_EMAIL_AUTH_ENABLED"]
            == "${{ vars.EMAIL_AUTH_ENABLED_UAT || 'false' }}"
        )
    assert inspector["environment"] == {"name": "uat", "deployment": False}
    assert inspector["if"] == (
        "${{ !cancelled() && needs.deployment-security.result == 'success' && inputs.operation == 'inspect' }}"
    )
    assert inspector["permissions"] == {
        "contents": "read",
        "actions": "write",
        "checks": "read",
        "id-token": "write",
    }
    steps = inspector["steps"]
    validate = next(
        i for i, step in enumerate(steps) if "validate-inspection" in step.get("run", "")
    )
    auth = next(
        i for i, step in enumerate(steps) if "google-github-actions/auth@" in step.get("uses", "")
    )
    assert validate < auth
    assert not any("upload-artifact" in step.get("uses", "") for step in steps)
    assert jobs["select-target"]["if"] == "inputs.operation == 'deploy'"
    security_condition = jobs["deployment-security"]["if"]
    assert "inputs.operation == 'inspect-routing'" in security_condition
    assert "needs.select-target.result == 'success'" in security_condition
    assert "needs.select-target.outputs.decision != 'NO_OP'" in security_condition
    for name in ("deploy", "wait-capacity"):
        assert (
            "select-target" in jobs[name]["needs"] and "deployment-security" in jobs[name]["needs"]
        )
        assert "decision == 'DEPLOY_EXACT_SHA'" in jobs[name]["if"]
    steps = jobs["select-target"]["steps"]
    early = next(step for step in steps if "validate-deployment" in step.get("run", ""))
    assert early["if"] == "steps.resolve-sha.outputs.decision != 'NO_OP'"
    assert "secrets.GH_SECURITY_ALERTS_TOKEN" not in str(inspector)
    ci = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
    exact = ci["jobs"]["uat-exact-source"]
    assert exact["name"] == "Exact UAT Candidate"
    step_names = [step.get("name") for step in exact["steps"]]
    assert "Verify exact serving base (${{ inputs.uat_base_sha }})" in step_names
    assert step_names.index(
        "Verify exact serving base (${{ inputs.uat_base_sha }})"
    ) < step_names.index("Verify the exact UAT checkout")


@pytest.mark.parametrize(
    "case",
    [
        "later_queued",
        "later_failed",
        "later_success",
        "inventory_race",
        "advanced",
        "attempt_race",
        "pending",
        "failed_job",
        "pending_job",
        "incomplete_inventory",
    ],
)
def test_real_historical_acceptance_keeps_pinned_run_authority(monkeypatch, case):
    import hashlib
    import json
    from copy import deepcopy
    from io import BytesIO
    from zipfile import ZipFile

    subject, api, transport, _ = prerequisite_fixture(monkeypatch)
    module, client, receipts, responses, pins = _acceptance_fixture()
    prior = {**predecessor(), "run_id": 123, "run_attempt": 1}
    receipts["uat"]["predecessor"] = prior
    archive = BytesIO()
    with ZipFile(archive, "w") as bundle:
        bundle.writestr("acceptance.json", json.dumps(receipts["uat"]))
    digest = "sha256:" + hashlib.sha256(archive.getvalue()).hexdigest()
    responses["artifacts/21/zip"] = archive.getvalue()
    responses["artifacts/21"].update(digest=digest, size_in_bytes=len(archive.getvalue()))
    pins["uat"]["artifact_digest"] = digest
    monkeypatch.setattr(subject.exact, "GitHub", lambda *_: api)
    if case.startswith("later_"):
        conclusion = case.removeprefix("later_")
        transport.runs.append(
            {
                **deepcopy(transport.run),
                "id": 124,
                "status": "queued" if conclusion == "queued" else "completed",
                "conclusion": {"failed": "failure", "queued": None}.get(conclusion, "success"),
                "run_started_at": "2026-10-29T00:00:00Z",
                "updated_at": "2026-10-29T00:01:00Z",
            }
        )
    elif case == "advanced":
        transport.runs[0]["run_attempt"] = 2
    elif case == "pending":
        transport.run.update(status="in_progress", conclusion=None)
    elif case in {"failed_job", "pending_job"}:
        transport.jobs[0].update(
            status="completed" if case == "failed_job" else "in_progress",
            conclusion="failure" if case == "failed_job" else None,
        )
    original_read, reads = api.read, 0

    def racing_read(path):
        nonlocal reads
        value = original_read(path)
        if "/workflows/ci.yml/runs?" in path:
            reads += 1
            if case == "incomplete_inventory":
                value["total_count"] += 1
            elif case == "inventory_race" and reads > 1:
                value["workflow_runs"].append({**deepcopy(transport.run), "id": 124})
                value["total_count"] += 1
            elif case == "attempt_race" and reads > 1:
                value["workflow_runs"][0]["run_attempt"] = 2
        return value

    api.read = racing_read
    if case.startswith("later_") or case == "inventory_race":
        accepted = client.accept(pins["uat"], "uat", SHA, "backend")
        assert accepted["run_id"] == 20
        if case.startswith("later_"):
            with pytest.raises(subject.Refused):
                subject.exact.verify_attempt(api, SHA, "c" * 40, 123, 1)
    else:
        with pytest.raises(module.Refused):
            client.accept(pins["uat"], "uat", SHA, "backend")


def test_explicit_deploy_cannot_claim_an_unrecorded_base_from_static_ci(monkeypatch):
    subject, api, transport, _ = prerequisite_fixture(monkeypatch)
    job = next(job for job in transport.jobs if job["name"].startswith("Exact UAT Candidate"))
    job["name"] = "Exact UAT Candidate"
    with pytest.raises(subject.Refused):
        subject.validate_deployment(api, SHA, "123", "1", "d" * 40)


@pytest.mark.parametrize("environment", ["dev", "uat"])
def test_branch_acceptance_producer_authenticates_main_authority_lookup(environment):
    workflow = yaml.safe_load(
        (ROOT / f".github/workflows/deploy-{environment}-implementation.yml").read_text()
    )
    producers = [
        step
        for step in workflow["jobs"]["deploy"]["steps"]
        if step.get("name", "").startswith("Produce exact-SHA")
    ]
    assert len(producers) == 1
    producer = producers[0]
    assert 'verify-predecessor-acceptance.py" create' in producer["run"]
    assert producer.get("env", {}).get("GH_TOKEN") == "${{ github.token }}"


@pytest.mark.parametrize(
    "expires", [2000, 1000, 999, True, "2000", None, float("inf"), float("nan")]
)
def test_email_risk_freshness_reads_immutable_source_not_the_checkout(
    monkeypatch, tmp_path, expires
):
    import json
    import subprocess

    subject, *_ = prerequisite_fixture(monkeypatch)
    monkeypatch.setenv("UAT_EMAIL_AUTH_ENABLED", "true")
    monkeypatch.setattr(subject.time, "time", lambda: 1000)
    monkeypatch.chdir(tmp_path)

    def git(*args):
        return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL)  # noqa: S603 - authored fixture arguments

    git("init", "-q")
    path = tmp_path / "consent-protocol/config/email-auth/risk-manifest.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"expires_at": expires}))
    git("add", ".")
    git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-qm",
        "pinned snapshot",
    )
    source = git("rev-parse", "HEAD").decode().strip()
    path.write_text(json.dumps({"expires_at": 3000 if expires != 2000 else 0}))
    if expires == 2000:
        subject.require_fresh_email_risk(source)
    else:
        with pytest.raises(subject.Refused, match="snapshot is expired or invalid"):
            subject.require_fresh_email_risk(source)


@pytest.mark.parametrize(
    "flag,payload,refused",
    [
        ("false", None, False),
        ("TRUE", None, True),
        ("true", None, True),
        ("true", b"{", True),
        ("true", b"[]", True),
        ("true", b"x" * 65537, True),
    ],
)
def test_email_risk_disabled_and_unreadable_inputs(monkeypatch, flag, payload, refused):
    subject, *_ = prerequisite_fixture(monkeypatch)
    monkeypatch.setenv("UAT_EMAIL_AUTH_ENABLED", flag)

    def read(*args):
        assert args == ("show", f"{SHA}:consent-protocol/config/email-auth/risk-manifest.json")
        if payload is None:
            raise subject.Refused("Git authority lookup failed")
        return payload

    with mock.patch.object(subject.exact, "git", side_effect=read) as observed:
        if refused:
            with pytest.raises(subject.Refused):
                subject.require_fresh_email_risk(SHA)
        else:
            subject.require_fresh_email_risk(SHA)
        if flag != "true":
            observed.assert_not_called()


def test_expired_email_risk_stops_inspection_and_deploy_before_qualification(monkeypatch):
    subject, api, _, serving = prerequisite_fixture(monkeypatch)
    monkeypatch.setenv("UAT_EMAIL_AUTH_ENABLED", "true")
    monkeypatch.setattr(subject.exact, "git", lambda *args: b'{"expires_at": 0}')
    with mock.patch.object(subject.exact, "verify_attempt") as verify:
        for action in (
            lambda: subject.inspect(api, "a" * 40, read_live=lambda _: serving),
            lambda: subject.validate_deployment(api, SHA, "123", "1", "c" * 40),
        ):
            with pytest.raises(subject.Refused, match="snapshot is expired or invalid"):
                action()
        verify.assert_not_called()
