"""Exact-SHA predecessor acceptance across the dev, UAT and production lanes."""

import hashlib
import importlib
import json
import os
import re
import shutil
import subprocess
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from zipfile import ZipFile

import pytest
import yaml

from tests.helpers.predecessor_acceptance import SHA as SHA
from tests.helpers.predecessor_acceptance import _acceptance_fixture as _acceptance_fixture
from tests.helpers.predecessor_acceptance import _serving_receipt as _serving_receipt

ROOT = Path(__file__).resolve().parents[2]


def test_distinct_main_approval_requires_identical_uat_content_and_incorporation(
    tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(ROOT / "scripts/ci"))
    approval = importlib.import_module("promotion_approval")

    def git(*arguments):
        # Fixed synthetic Git history, isolated from developer branches.
        return subprocess.check_output(["git", "-C", str(tmp_path), *arguments], text=True).strip()  # noqa: S603

    git("init", "-b", "main")
    git("config", "user.email", "synthetic@example.invalid")
    git("config", "user.name", "Synthetic release fixture")
    artifact = tmp_path / "application.txt"
    artifact.write_text("baseline\n")
    git("add", ".")
    git("commit", "-m", "baseline")
    base = git("rev-parse", "HEAD")
    git("update-ref", "refs/remotes/origin/main", base)
    git("checkout", "-b", "uat")
    artifact.write_text("curated application\n")
    git("commit", "-am", "curated")
    application = git("rev-parse", "HEAD")
    git("update-ref", "refs/remotes/origin/uat", application)
    assert approval.uat_source(application, resolve=git)[0] == "uat"
    git("checkout", "main")
    git("merge", "--no-ff", "uat", "-m", "approve identical application")
    accepted = git("rev-parse", "HEAD")
    git("update-ref", "refs/remotes/origin/main", accepted)
    record = approval.verify(application, accepted, resolve=git)
    assert approval.uat_source(application, resolve=git) == ("main", "Main Post-Merge Smoke Gate")
    assert approval.uat_source(accepted, resolve=git) == ("main", "Main Post-Merge Smoke Gate")
    assert record["application_sha"] == application
    assert record["main_approval_sha"] == accepted
    assert record["predecessor_acceptance_required"] == "uat-exact-application-sha"
    with pytest.raises(ValueError, match="incorporate"):
        approval.verify(application, base, resolve=git)
    # Even an incorporated UAT source cannot cover additional Main content.
    artifact.write_text("unaccepted extra behavior\n")
    git("add", ".")
    changed = git(
        "commit-tree", git("write-tree"), "-p", base, "-p", application, "-m", "changed approval"
    )
    git("update-ref", "refs/remotes/origin/main", changed)
    with pytest.raises(ValueError, match="changes"):
        approval.verify(application, changed, resolve=git)


def _bash() -> str:
    bash = shutil.which("bash")
    assert bash is not None
    return bash


@pytest.mark.parametrize("supports_escape_flag", [True, False])
def test_bounded_reader_keeps_raw_job_logs_in_its_pipe_and_rejects_other_paths(
    tmp_path, monkeypatch, supports_escape_flag
):
    module, *_ = _acceptance_fixture()
    executable = tmp_path / "gh"
    executable.write_text(
        "#!/usr/bin/env python3\n"
        "import sys\n"
        f"supports = {supports_escape_flag!r}\n"
        "if '--help' in sys.argv:\n"
        "    print('--allow-escape-sequences' if supports else 'usage'); sys.exit(0)\n"
        "if supports != ('--allow-escape-sequences' in sys.argv): sys.exit(1)\n"
        "sys.stdout.buffer.write(b'\\x1b[31mfixed synthetic log\\x1b[0m\\n')\n"
    )
    executable.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ["PATH"])
    if supports_escape_flag:
        with pytest.raises(module.Refused, match="GitHub lookup failed"):
            module.bounded_github_read("jobs/42/logs", 5)
    assert module.bounded_github_read("jobs/42/logs", 5, allow_escape_sequences=True) == (
        b"\x1b[31mfixed synthetic log\x1b[0m\n"
    )
    for path in ("jobs/0/logs", "jobs/42/logs?redirect=1", "artifacts/42/zip"):
        with pytest.raises(module.Refused, match="exact job log"):
            module.bounded_github_read(path, 5, allow_escape_sequences=True)


def test_predecessor_requires_exact_application_sha_and_pinned_dev_chain():
    module, client, _, responses, pins = _acceptance_fixture()
    assert client.accept(pins["uat"], "uat", SHA, "backend") == {
        **pins["uat"],
        "repository": module.REPOSITORY,
        "workflow": ".github/workflows/deploy-uat.yml",
    }
    # Identical tree, new merge SHA is not the accepted application.
    with pytest.raises(module.Refused, match="SHA"):
        client.accept(pins["uat"], "uat", "e" * 40, "backend")
    responses["runs/10/attempts/2"]["conclusion"] = "failure"
    with pytest.raises(module.Refused, match="governed attempt"):
        client.accept(pins["uat"], "uat", SHA, "backend")


@pytest.mark.parametrize(
    "case",
    [
        "valid",
        "historical",
        "frontend_only",
        "repository",
        "digest",
        "unverified",
        "partial",
        "pin",
        "failed_attempt",
    ],
)
def test_backend_image_is_bound_to_the_selected_accepted_attempt(case, tmp_path, monkeypatch):
    module, client, receipts, responses, pins = _acceptance_fixture()
    observed = receipts["dev"]["provenance"]["backend"]["checked_revisions"][0]
    image = "gcr.io/hushh-pda-dev/consent-protocol@sha256:" + "a" * 64
    proof = {"image_reference": image, "image_digest": "sha256:" + "a" * 64, "image_verified": True}
    if case == "frontend_only":
        receipts["dev"]["provenance"]["frontend"]["checked_revisions"][0].update(proof)
    elif case != "historical":
        observed.update(proof)
    if case == "repository":
        observed["image_reference"] = image.replace("hushh-pda-dev", "hushh-pda-uat")
    elif case == "digest":
        observed["image_digest"] = "sha256:" + "b" * 64
    elif case == "unverified":
        observed["image_verified"] = False
    elif case == "partial":
        observed.pop("image_reference")
    elif case == "pin":
        pins["dev"]["image_reference"] = image.replace("a" * 64, "b" * 64)
    elif case == "failed_attempt":
        responses["runs/10/attempts/2"]["conclusion"] = "failure"
    archive = BytesIO()
    with ZipFile(archive, "w") as bundle:
        bundle.writestr("acceptance.json", json.dumps(receipts["dev"]))
    digest = "sha256:" + hashlib.sha256(archive.getvalue()).hexdigest()
    responses["artifacts/11/zip"] = archive.getvalue()
    responses["artifacts/11"].update(digest=digest, size_in_bytes=len(archive.getvalue()))
    pins["dev"]["artifact_digest"] = digest
    predecessor = tmp_path / "predecessor.json"
    predecessor.write_text(
        json.dumps(
            {
                "status": "accepted",
                "environment": "dev",
                "sha": SHA,
                "services": {"backend": pins["dev"]},
            }
        )
    )
    monkeypatch.setattr(module, "GitHub", lambda: client)
    args = SimpleNamespace(environment="dev", sha=SHA, predecessor=predecessor)
    if case not in {"valid", "historical", "frontend_only"}:
        with pytest.raises(module.Refused):
            module.pinned_backend_image(args)
    else:
        accepted = module.pinned_backend_image(args)
        assert accepted["run_attempt"] == 2 and accepted["artifact_id"] == 11
        assert accepted.get("image_reference") == (image if case == "valid" else None)


def test_discovery_keeps_qualified_attempt_after_a_failed_rerun():
    module, client, _, responses, pins = _acceptance_fixture()
    query = "workflows/deploy-dev.yml/runs?branch=main&event=workflow_dispatch&per_page=50&page=1"
    responses[query] = {
        "workflow_runs": [{"id": 10, "run_attempt": 3, "conclusion": "failure"}],
    }
    responses["runs/10/artifacts?per_page=100"] = {
        "total_count": 2,
        "artifacts": [
            {"id": 12, "name": "release-acceptance-dev-10-3"},
            responses["artifacts/11"],
        ],
    }
    responses["runs/10/attempts/3"] = {
        **responses["runs/10/attempts/2"],
        "run_attempt": 3,
        "conclusion": "failure",
    }
    result = client.find("dev", SHA, "all")
    assert result["status"] == "accepted"
    assert set(result["services"]) == {"backend", "frontend"}
    assert all(
        pin["run_attempt"] == pins["dev"]["run_attempt"] for pin in result["services"].values()
    )
    responses["runs/10/attempts/2"]["conclusion"] = "failure"
    with pytest.raises(module.Refused, match="No complete healthy predecessor"):
        client.find("dev", SHA, "all")


def test_predecessor_preserves_classified_advisory_without_waiving_required_failures():
    module, _, receipts, _, _ = _acceptance_fixture()
    receipt = receipts["dev"]
    receipt["release"]["verification"]["semantic_success"] = "false"
    semantic = receipt["classification"]["semantic"]
    semantic.update(
        success=False,
        failures=["signed_in_routes:/one"],
        advisory_failures=["signed_in_routes:/one"],
    )
    module.validate(receipt, environment="dev", sha=SHA, service="backend")
    semantic["blocking_failures"] = ["frontend_login"]
    with pytest.raises(module.Refused, match="verification"):
        module.validate(receipt, environment="dev", sha=SHA, service="backend")


@pytest.mark.parametrize(
    "failure",
    [
        "preview",
        "scope",
        "sha",
        "candidate",
        "final_sha",
        "traffic",
        "schema",
        "reviewer",
        "provenance",
        "classification",
        "missing_checks",
    ],
)
def test_predecessor_refuses_incomplete_or_wrong_serving_evidence(failure):
    module, _, receipts, _, _ = _acceptance_fixture()
    receipt = receipts["dev"]
    if failure == "preview":
        receipt["target"] = "scope-commerce-sandbox"
    elif failure == "scope":
        receipt["resolved_services"] = ["frontend"]
    elif failure == "sha":
        receipt["release"]["sha"] = "e" * 40
    elif failure == "candidate":
        receipt["release"]["current"]["backend_candidate_revision"] = "old"
    elif failure == "final_sha":
        receipt["release"]["final"]["backend_sha"] = "e" * 40
    elif failure == "traffic":
        receipt["provenance"]["backend"]["checked_revisions"][0]["traffic_percent"] = 99
    elif failure == "schema":
        receipt["release"]["verification"]["db_contract"] = "skipped"
    elif failure == "reviewer":
        receipt["required_checks"]["reviewer"]["outcome"] = "skipped"
    elif failure == "provenance":
        receipt["provenance"]["backend"]["mode"] = "candidate"
    elif failure == "classification":
        receipt["release"]["verification"]["semantic_success"] = ""
    elif failure == "missing_checks":
        receipt["required_checks"] = {}
    with pytest.raises(module.Refused):
        module.validate(receipt, environment="dev", sha=SHA, service="backend")


@pytest.mark.parametrize(
    "failure", ["branch", "attempt", "origin", "expired", "digest", "wrong_run", "archive"]
)
def test_predecessor_refuses_untrusted_or_changed_github_artifacts(failure):
    module, client, _, responses, pins = _acceptance_fixture()
    run, artifact = responses["runs/10/attempts/2"], responses["artifacts/11"]
    if failure == "branch":
        run["head_branch"] = "feature"
    elif failure == "attempt":
        run["run_attempt"] = 1
    elif failure == "origin":
        run["head_repository"] = {"full_name": "another/fork"}
    elif failure == "expired":
        artifact["expired"] = True
    elif failure == "digest":
        artifact["digest"] = "sha256:" + "0" * 64
    elif failure == "wrong_run":
        artifact["workflow_run"]["id"] = 30
    else:
        responses["artifacts/11/zip"] += b"tampered"
    with pytest.raises(module.Refused):
        client.accept(pins["dev"], "dev", SHA, "backend")


@pytest.mark.parametrize("environment", ["uat", "production", "uat-one-chat"])
def test_every_release_image_mode_requires_predecessor_before_mutation(environment):
    workflow = yaml.safe_load((ROOT / f".github/workflows/deploy-{environment}.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    gate = next(step for step in steps if step.get("id") == "predecessor-acceptance")
    if environment == "production":
        # The exact recorded recovery has a distinct artifact; it must never
        # masquerade as UAT acceptance or relax ordinary image-mode promotion.
        assert gate["if"] == "inputs.restoration_validation_run == ''"
        recovery = next(step for step in steps if step.get("id") == "restoration-admission")
        assert recovery["if"] == "inputs.restoration_validation_run != ''"
        assert "deploy/account-deletion/restoration_validation.py" in recovery["run"]
        assert '--scope "$REQUESTED_SCOPE"' in recovery["run"]
        assert '--image-source "$IMAGE_SOURCE"' in recovery["run"]
        assert '--actor "$GITHUB_TRIGGERING_ACTOR"' in recovery["run"]
        first_cloud = next(
            i for i, step in enumerate(steps) if step.get("name") == "Authenticate to Google Cloud"
        )
        assert steps.index(recovery) < first_cloud
        mapping = next(
            step
            for step in steps
            if step.get("name") == "Bind curated application to its Main approval"
        )
        assert steps.index(mapping) < first_cloud
        assert mapping["if"] == "inputs.main_approval_sha != ''"
        assert '--sha "$APPLICATION_SHA"' in gate["run"]
        assert gate["env"]["APPLICATION_SHA"] == "${{ inputs.sha }}"
        assert "main_approval_sha" not in gate["run"]
    else:
        assert "if" not in gate
    scoped = environment == "uat-one-chat"
    expected_scope = (
        "--scope backend"
        if scoped
        else '--scope "$RESOLVED_SCOPE"'
        if environment == "production"
        else '--scope "${{ steps.scope.outputs.scope }}"'
    )
    assert expected_scope in gate["run"]
    assert '"${RUNNER_TEMP}/release-tools/verify-predecessor-acceptance.py"' in gate["run"]
    prior_index = (
        next(
            i
            for i, step in enumerate(steps)
            if step.get("name") == "Validate exact main SHA and actor"
        )
        if scoped
        else next(i for i, step in enumerate(steps) if step.get("id") == "scope")
    )
    assert steps.index(gate) == prior_index + 1
    preserve = next(
        step for step in steps if step.get("name") == "Preserve current release tooling"
    )
    checkout = next(
        i
        for i, step in enumerate(steps)
        if step.get("name")
        == ("Validate exact main SHA and actor" if scoped else "Checkout deployment SHA")
    )
    assert steps.index(preserve) < checkout
    assert "verify-predecessor-acceptance.py" in preserve["run"]
    if scoped:
        recovery = next(
            step for step in steps if step.get("name") == "Recover interrupted backend promotion"
        )
        assert "steps.predecessor-acceptance.outcome == 'success'" in recovery["if"]


@pytest.mark.parametrize("environment", ["dev", "uat", "production"])
@pytest.mark.parametrize("classified", [False, True])
def test_release_status_never_treats_a_missing_classifier_as_healthy(
    environment, classified, tmp_path
):
    workflow = yaml.safe_load((ROOT / f".github/workflows/deploy-{environment}.yml").read_text())
    steps = [step for job in workflow["jobs"].values() for step in job.get("steps", [])]
    step = next(step for step in steps if "release status artifact" in step.get("name", ""))
    script = str(step["run"]).split("export STATUS", 1)[0]
    script = re.sub(
        r"\$\{\{(.*?)\}\}",
        lambda match: "false" if classified and ".release_failed" in match[1] else "",
        script,
    )
    environment_variables = os.environ.copy()
    environment_variables.pop("BASH_ENV", None)
    environment_variables["DEV_TARGET"] = "shared-dev"
    environment_variables["GITHUB_OUTPUT"] = str(tmp_path / "github-output")
    result = subprocess.run(  # noqa: S603 - actual classification shell with fixed synthetic observations
        [_bash(), "-c", script + '\nprintf "%s" "$STATUS"\n'],
        env=environment_variables,
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == ("healthy" if classified else "blocked")


@pytest.mark.parametrize(
    "defect", [None, "final_sha", "missing_required", "missing_classification"]
)
def test_acceptance_producer_fences_failed_final_readback_and_missing_verification(
    tmp_path, monkeypatch, defect
):
    module, _, receipts, _, _ = _acceptance_fixture()
    receipt = receipts["dev"]
    release = receipt["release"]
    release["verification_plan"] = {
        "pkm_preservation_required": "true",
        "pkm_preservation_outcome": "success",
        "reviewer_byok_required": "true",
        "reviewer_byok_outcome": "success",
    }
    if defect == "final_sha":
        release["final"]["backend_sha"] = "e" * 40
    elif defect == "missing_required":
        del release["verification_plan"]["reviewer_byok_required"]
    for service, report in receipt["provenance"].items():
        (tmp_path / f"dev-{service}-provenance.json").write_text(json.dumps(report))
    if defect != "missing_classification":
        (tmp_path / "dev-release-classification.json").write_text(
            json.dumps(receipt["classification"])
        )
    status = tmp_path / "dev-release-status.json"
    status.write_text(json.dumps(release))
    output = tmp_path / "acceptance.json"
    for key, value in {
        "GITHUB_REPOSITORY": module.REPOSITORY,
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_RUN_ID": "10",
        "GITHUB_RUN_ATTEMPT": "2",
        "DEV_TARGET": "shared-dev",
    }.items():
        monkeypatch.setenv(key, value)
    arguments = SimpleNamespace(environment="dev", status=status, output=output)
    if defect:
        with pytest.raises((module.Refused, OSError)):
            module.create(arguments)
        assert json.loads(status.read_text())["status"] == "blocked"
        assert not output.exists()
    else:
        module.create(arguments)
        module.validate(
            json.loads(output.read_text()), environment="dev", sha=SHA, service="frontend"
        )


def _maintenance_log_ports(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "scripts/ci"))
    return (
        importlib.import_module("retention_publication"),
        importlib.import_module("uat-retention-maintenance"),
        importlib.import_module("verify-predecessor-acceptance"),
    )


@pytest.mark.parametrize("supports_escape_flag", [False, True])
def test_maintenance_raw_transport_never_prints_private_log_payloads(
    monkeypatch, capsys, supports_escape_flag
):
    publication, maintenance, reader = _maintenance_log_ports(monkeypatch)
    calls = []

    def read(arguments, timeout):
        calls.append((arguments, timeout))
        if arguments == ["gh", "api", "--help"]:
            return b"--allow-escape-sequences" if supports_escape_flag else b"usage"
        return b"PRIVATE_LOG_SENTINEL"

    with mock.patch.object(reader, "_bounded_process_read", side_effect=read):
        assert publication._log(maintenance, {"id": 200}) == "PRIVATE_LOG_SENTINEL"
    assert calls[0][0] == ["gh", "api", "--help"]
    assert calls[1][0][-1] == "repos/hushh-labs/hushh-research/actions/jobs/200/logs"
    assert ("--allow-escape-sequences" in calls[1][0]) == supports_escape_flag
    assert "PRIVATE_LOG_SENTINEL" not in capsys.readouterr().out


def test_maintenance_transport_failure_keeps_private_diagnostics_closed(monkeypatch, capsys):
    publication, maintenance, reader = _maintenance_log_ports(monkeypatch)
    with mock.patch.object(
        reader, "bounded_github_read", side_effect=reader.Refused("PRIVATE_CREDENTIAL_SENTINEL")
    ):
        with pytest.raises(
            maintenance.retention.UnsafeState, match="bounded log lookup failed"
        ) as error:
            publication._log(maintenance, {"id": 200})
    assert "PRIVATE_CREDENTIAL_SENTINEL" not in str(error.value)
    assert "PRIVATE_CREDENTIAL_SENTINEL" not in capsys.readouterr().out


def test_cli_capability_probe_shares_the_original_read_deadline(monkeypatch):
    _, _, reader = _maintenance_log_ports(monkeypatch)
    with (
        mock.patch.object(reader.time, "monotonic", side_effect=[10.0, 11.0]),
        mock.patch.object(reader, "_bounded_process_read", side_effect=[b"usage", b"log"]) as read,
    ):
        assert reader.bounded_github_read("jobs/200/logs", 5, allow_escape_sequences=True) == b"log"
    assert read.call_args_list[0].args[1] == 5
    assert read.call_args_list[1].args[1] == 4
