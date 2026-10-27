"""Hosted-copy release, maintenance, revision and rollback authority contracts."""

import json
import os
import re
import subprocess
import sys

import pytest
import yaml

from tests.helpers.deployment_cli import cloudrun_revision
from tests.test_prod_drive_deploy_contract import ROOT, _module


def test_hosted_maintenance_selects_only_sharing_without_legacy_admission():
    script = (ROOT / "deploy/drive/deploy_worker_service_prod.sh").read_text()
    block = (
        "legacy_drive=" + script.split("legacy_drive=", 1)[1].split("# An existing service", 1)[0]
    )
    for legacy, hosted, expected in (
        ("false", "true", ["drive-work-sharing-prod"]),
        (
            "true",
            "false",
            ["drive-work-drain-prod", "drive-work-suggestions-prod", "drive-work-sharing-prod"],
        ),
        ("false", "false", None),
        ("false", "arbitrary", None),
    ):
        result = subprocess.run(  # noqa: S603 -- Execute the authored profile block with fixed synthetic flags and no cloud commands.
            [
                "bash",
                "-c",
                "set -euo pipefail\nPROJECT_ID=hushh-pda\n"
                + block
                + '\nprintf "%s\\n" "${fixed_jobs[@]}"',
            ],
            env={
                **os.environ,
                "GCP_PROJECT_ID": "hushh-pda",
                "ENABLE_PRODUCTION_DRIVE_LIVE": legacy,
                "PROTECTED_DOCUMENT_MAINTENANCE": hosted,
            },
            capture_output=True,
            text=True,
            check=False,
        )
        if expected is None:
            assert result.returncode != 0
        else:
            assert result.returncode == 0
            assert result.stdout.splitlines() == expected


def test_hosted_release_mode_retains_maintenance_and_withholds_runtime_payload(
    monkeypatch, tmp_path, capsys
):
    module = _module("resolve_protected_document_release.py")
    runtime = {
        "environment": "production",
        "google_cloud_project": "hushh-pda",
        "protected_document_delivery": False,
        "document_delivery_bucket": "hushh-pda-document-delivery",
        "document_delivery_bucket_identity": "a" * 64,
        "drive_document_sharing": "false",
        "unrelated_secret": "sentinel-do-not-print",
    }
    original = dict(runtime)
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, json.dumps(runtime), ""),
    )
    output = tmp_path / "github-output"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "resolve",
            "--project",
            "hushh-pda",
            "--environment",
            "production",
            "--github-output",
            str(output),
        ],
    )
    assert module.main() == 0
    assert json.loads(capsys.readouterr().out) == {"configured": True, "enabled": False}
    assert output.read_text() == "configured=true\nenabled=false\n"
    assert runtime == original
    assert module.resolve({}, project="hushh-pda", environment="production") == {
        "configured": False,
        "enabled": False,
    }
    with pytest.raises(ValueError):
        module.resolve(runtime, project="hushh-pda-uat", environment="uat")


@pytest.fixture
def reader_repository(monkeypatch, tmp_path):
    module = _module("resolve_protected_document_release.py")
    monkeypatch.chdir(tmp_path)

    def git(*args):
        return subprocess.run(  # noqa: S603 -- Fixed synthetic Git fixture operations; no shell or external input.
            ["git", *args], capture_output=True, text=True, check=True
        ).stdout.strip()

    git("init", "-q")
    git("config", "user.name", "Reader Compatibility Test")
    git("config", "user.email", "reader@example.test")
    (tmp_path / "old").write_text("pre-reader")
    git("add", ".")
    git("commit", "-qm", "Old application")
    old = git("rev-parse", "HEAD")
    for relative in module.READER_FILES:
        source = tmp_path / relative
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text("reader contract v1")
    git("add", ".")
    git("commit", "-qm", "Reader implementation")
    reader = git("rev-parse", "HEAD")
    assert module.reader_supported(reader, reader)
    assert not module.reader_supported(old, reader)
    return module, old, reader, git


def test_effective_intake_off_requires_known_api_absence_or_literal_false(reader_repository):
    module, old, reader, _git = reader_repository
    # A mutable :latest payload cannot prove a running process has intake off.
    backend = {"metadata": {"labels": {"deploy-sha": old}}, "spec": {"containers": []}}
    assert module._serving_intake_off("hushh-pda", backend, reader)
    backend["metadata"]["labels"]["deploy-sha"] = "f" * 40
    assert not module._serving_intake_off("hushh-pda", backend, reader)
    backend["metadata"]["labels"]["deploy-sha"] = reader
    assert not module._serving_intake_off("hushh-pda", backend, reader)
    flag = {
        "name": "PROTECTED_DOCUMENT_DELIVERY_ENABLED",
        "valueFrom": {"secretKeyRef": {"name": "runtime", "key": "latest"}},
    }
    backend["spec"]["containers"] = [{"env": [flag]}]
    assert not module._serving_intake_off("hushh-pda", backend, reader)
    flag.pop("valueFrom")
    flag["value"] = "false"
    assert module._serving_intake_off("hushh-pda", backend, reader)
    flag["value"] = "true"
    assert not module._serving_intake_off("hushh-pda", backend, reader)


def test_hosted_reader_target_and_rollback_use_actual_source_not_current_tooling(
    monkeypatch, tmp_path, reader_repository
):
    module, old, reader, git = reader_repository
    previous = {
        service: {"revision": service + "-old", "sha": old, "image": "image@sha256:" + "a" * 64}
        for service in module.SERVICES
    }
    monkeypatch.setattr(
        module,
        "_previous_sources",
        lambda _project: ({name: dict(value) for name, value in previous.items()}, None),
    )
    monkeypatch.setattr(module, "_serving_intake_off", lambda *_args: True)
    monkeypatch.setattr(module, "_database_empty", lambda _project, **_kwargs: True)
    active = {"configured": True, "enabled": True}
    closed = {**active, "enabled": False}
    with pytest.raises(ValueError, match="reader-capable target"):
        module.verify_readers(closed, project="hushh-pda", target=old, ancestor=reader)
    with pytest.raises(ValueError, match="rollback baseline"):
        module.verify_readers(active, project="hushh-pda", target=reader, ancestor=reader)
    bootstrap = module.verify_readers(closed, project="hushh-pda", target=reader, ancestor=reader)
    assert bootstrap["bootstrapEmpty"] is True
    module.assert_rollback(
        bootstrap, project="hushh-pda", service="hushh-webapp", revision="hushh-webapp-old"
    )
    monkeypatch.setattr(
        module, "_database_empty", lambda _project, **kwargs: kwargs.get("background_only", False)
    )
    with pytest.raises(ValueError, match="no longer empty"):
        module.assert_rollback(
            bootstrap, project="hushh-pda", service="hushh-webapp", revision="hushh-webapp-old"
        )
    with pytest.raises(ValueError, match="rollback baseline"):
        module.verify_readers(closed, project="hushh-pda", target=reader, ancestor=reader)
    for value in previous.values():
        value["sha"] = reader
    ready = module.verify_readers(active, project="hushh-pda", target=reader, ancestor=reader)
    assert ready["bootstrapEmpty"] is False
    assert all(value["readerCompatible"] for value in ready["previous"].values())
    with pytest.raises(ValueError, match="verified baseline"):
        module.assert_rollback(
            ready, project="hushh-pda", service="hushh-webapp", revision="unrelated"
        )
    # Descending from the feature commit is insufficient if the route is gone.
    (tmp_path / module.READER_FILES[1]).unlink()
    git("add", ".")
    git("commit", "-qm", "Remove reader route")
    assert not module.reader_supported(git("rev-parse", "HEAD"), reader)


def test_hosted_only_serving_drain_preserves_legacy_drive_off():
    module = _module("resolve_prod_release_mode.py")
    revision = {
        "spec": {
            "containers": [
                {
                    "env": [
                        {"name": "HUSHH_DEPLOY_ENV", "value": "production"},
                        {"name": "DRIVE_WORK_DRAIN_ENABLED", "value": "true"},
                        {
                            "name": "BACKEND_RUNTIME_CONFIG_JSON",
                            "valueFrom": {
                                "secretKeyRef": {"name": "BACKEND_RUNTIME_CONFIG_JSON_DRIVE_123_1"}
                            },
                        },
                    ]
                }
            ]
        }
    }
    runtime = {
        "environment": "production",
        "google_cloud_project": "hushh-pda",
        **dict.fromkeys(module.DRIVE_FLAGS, "false"),
        "protected_document_delivery": False,
        "document_delivery_bucket": "hushh-pda-document-delivery",
        "document_delivery_bucket_identity": "a" * 64,
    }
    assert module.resolve_mode(
        requested_mode="preserve", backend_deploy=True, revision=revision, runtime=runtime
    ) == (False, False)
    runtime["document_delivery_bucket_identity"] = "invalid"
    with pytest.raises(module.DriveReleaseStateError):
        module.resolve_mode(
            requested_mode="preserve", backend_deploy=True, revision=revision, runtime=runtime
        )
    runtime["document_delivery_bucket_identity"] = "a" * 64
    runtime["google_drive_live"] = "true"
    with pytest.raises(module.DriveReleaseStateError):
        module.resolve_mode(
            requested_mode="preserve", backend_deploy=True, revision=revision, runtime=runtime
        )


@pytest.mark.parametrize("value", ["true", "false", "invalid", "duplicate", "legacy"])
def test_protected_intake_is_pinned_on_the_revision(value: str) -> None:
    config = yaml.safe_load((ROOT / "deploy/backend.cloudbuild.yaml").read_text())
    step = next(s for s in config["steps"] if s.get("id") == "deploy-backend")
    packed = next(e for e in step["env"] if e.startswith("_DRIVE_WORK_DRAIN_SETTINGS="))
    defaults = {**config["substitutions"], "_PROTECTED_DOCUMENT_DELIVERY_ENABLED": value}
    rendered = re.sub(r"\$\{(_[A-Z0-9_]+)\}", lambda m: defaults[m[1]], packed).split("=", 1)[1]
    if value == "legacy":
        rendered = rendered.replace(",protected_documents=legacy", "")
    if value == "duplicate":
        rendered = rendered.replace(
            "protected_documents=duplicate", "protected_documents=false,protected_documents=true"
        )
    script = (ROOT / "scripts/deploy/backend-deploy.sh").read_text()
    start = script.index('_PKM_ANSWER_REQUESTS_ENABLED=""')
    parser = script[start : script.index("# Every added control", start)]
    result = subprocess.run(  # noqa: S603 -- Authored parser, synthetic settings, no provider commands.
        ["bash", "-c", parser + '\nprintf "%s" "${_PROTECTED_DOCUMENT_DELIVERY_ENABLED}"'],
        env={**os.environ, "_DRIVE_WORK_DRAIN_SETTINGS": rendered},
        text=True,
        capture_output=True,
        check=False,
    )
    if value in ("invalid", "duplicate"):
        assert result.returncode != 0
        assert result.stdout == ""
    else:
        assert result.returncode == 0, result.stderr
        assert result.stdout == ("false" if value == "legacy" else value)
    assert (
        'append_optional_env "PROTECTED_DOCUMENT_DELIVERY_ENABLED" "${_PROTECTED_DOCUMENT_DELIVERY_ENABLED}"'
        in script
    )
    assert config["substitutions"]["_PROTECTED_DOCUMENT_DELIVERY_ENABLED"] == "false"


@pytest.fixture
def manual_rollback_target(monkeypatch, reader_repository):
    module, old, reader, _git = reader_repository
    target = cloudrun_revision(name="hushh-webapp-target", service="hushh-webapp", sha=reader)
    calls = []

    def cloud(*args):
        calls.append(args)
        assert args[:4] == ("run", "revisions", "describe", "hushh-webapp-target")
        assert "--project=hushh-pda" in args and "--region=us-central1" in args
        return json.dumps(target)

    monkeypatch.setattr(module, "_cloud", cloud)
    return module, old, reader, target, calls


def test_manual_reader_rollback_requires_no_bootstrap_exception(
    monkeypatch, manual_rollback_target
):
    module, _old, reader, _target, calls = manual_rollback_target

    def background_inventory(_project, *, background_only=False):
        assert background_only, "A v1 target still reads v1 retained contracts"
        return True

    monkeypatch.setattr(module, "_previous_sources", lambda _project: ({}, None))
    monkeypatch.setattr(module, "_database_empty", background_inventory)
    module.assert_manual_rollback(
        project="hushh-pda", service="hushh-webapp", revision="hushh-webapp-target", ancestor=reader
    )
    assert len(calls) == 1


@pytest.mark.parametrize("intake_off,empty", [(True, True), (True, False), (False, True)])
def test_manual_old_reader_rechecks_live_intake_and_inventory(
    monkeypatch, manual_rollback_target, intake_off, empty
):
    module, old, reader, target, calls = manual_rollback_target
    target["metadata"]["labels"]["deploy-sha"] = old
    backend, checks = {"metadata": {"labels": {"deploy-sha": reader}}}, []
    monkeypatch.setattr(module, "_previous_sources", lambda project: ({}, backend))

    def off(project, current, ancestor):
        assert (project, current, ancestor) == ("hushh-pda", backend, reader)
        checks.append("intake")
        return intake_off

    def inventory(project, *, background_only=False):
        assert project == "hushh-pda"
        if background_only:
            return True
        checks.append("inventory")
        return empty

    monkeypatch.setattr(module, "_serving_intake_off", off)
    monkeypatch.setattr(module, "_database_empty", inventory)
    arguments = dict(
        project="hushh-pda", service="hushh-webapp", revision="hushh-webapp-target", ancestor=reader
    )
    if intake_off and empty:
        module.assert_manual_rollback(**arguments)
        # An earlier successful check cannot authorize a later issued copy.
        empty = False
    with pytest.raises(ValueError, match="remove issued document readers"):
        module.assert_manual_rollback(**arguments)
    assert checks == (["intake", "inventory"] * len(calls) if intake_off else ["intake"])


@pytest.mark.parametrize("invalid", ["service", "name", "sha", "unknown", "image"])
def test_manual_rollback_refuses_wrong_revision_or_mutable_provenance(
    monkeypatch, manual_rollback_target, invalid
):
    module, _old, reader, target, _calls = manual_rollback_target
    if invalid == "service":
        target["metadata"]["labels"]["serving.knative.dev/service"] = "consent-protocol"
    elif invalid == "name":
        target["metadata"]["name"] = "hushh-webapp-other"
    elif invalid == "sha":
        target["metadata"]["labels"]["deploy-sha"] = "f" * 39
    elif invalid == "unknown":
        target["metadata"]["labels"]["deploy-sha"] = "f" * 40
    else:
        target["spec"]["containers"][0]["image"] = "image:latest"
    monkeypatch.setattr(module, "_previous_sources", lambda _project: ({}, None))
    monkeypatch.setattr(module, "_serving_intake_off", lambda *_args: True)
    monkeypatch.setattr(module, "_database_empty", lambda _project, **_kwargs: True)
    with pytest.raises(ValueError):
        module.assert_manual_rollback(
            project="hushh-pda",
            service="hushh-webapp",
            revision="hushh-webapp-target",
            ancestor=reader,
        )


@pytest.mark.parametrize("flag", ["true", "false"])
def test_manual_nonreader_backend_must_itself_keep_intake_off(
    monkeypatch, tmp_path, reader_repository, flag
):
    module, _old, reader, git = reader_repository
    (tmp_path / module.READER_FILES[1]).unlink()
    git("add", ".")
    git("commit", "-qm", "Remove frontend reader while retaining API")
    sha = git("rev-parse", "HEAD")
    assert not module.reader_supported(sha, reader)
    target = cloudrun_revision(
        name="consent-protocol-target", service="consent-protocol", sha=sha, intake="false"
    )
    current = json.loads(json.dumps(target))
    target["spec"]["containers"][0]["env"][0]["value"] = flag
    monkeypatch.setattr(module, "_cloud", lambda *_args: json.dumps(target))
    monkeypatch.setattr(module, "_previous_sources", lambda _project: ({}, current))
    monkeypatch.setattr(module, "_database_empty", lambda _project, **_kwargs: True)
    arguments = dict(
        project="hushh-pda",
        service="consent-protocol",
        revision="consent-protocol-target",
        ancestor=reader,
    )
    if flag == "true":
        with pytest.raises(ValueError, match="target can issue document copies"):
            module.assert_manual_rollback(**arguments)
    else:
        module.assert_manual_rollback(**arguments)


def test_manual_shell_blocks_traffic_on_denial_and_detects_missing_guard(tmp_path):
    tools = tmp_path / "bin"
    tools.mkdir()
    guard_args, mutation = tmp_path / "guard-args", tmp_path / "traffic-mutation"
    programs = {
        "deny-python": '#!/bin/sh\nprintf "%s\\n" "$@" > "$GUARD_ARGS"\nexit 47\n',
        "gcloud": '#!/bin/sh\nprintf "%s\\n" "$@" > "$TRAFFIC_MUTATION"\n',
        "git": '#!/bin/sh\nprintf "%s\\n" "' + "a" * 40 + '"\n',
    }
    for name, source in programs.items():
        executable = tools / name
        executable.write_text(source)
        executable.chmod(0o755)
    environment = {
        **os.environ,
        "PATH": str(tools) + os.pathsep + os.environ["PATH"],
        "PROTOCOL_PYTHON": str(tools / "deny-python"),
        "GCP_PROJECT_ID": "hushh-pda",
        "HUSHH_DOCUMENT_MANUAL_ROLLBACK_GUARD": "true",
        "HUSHH_DOCUMENT_READER_GUARD_REPORT": "",
        "GUARD_ARGS": str(guard_args),
        "TRAFFIC_MUTATION": str(mutation),
    }

    def execute(script, region="us-central1"):
        return subprocess.run(  # noqa: S603 -- Authored shell with fixed synthetic target and fake cloud/guard executables.
            ["bash", str(script), "hushh-webapp", region, "hushh-webapp-target"],
            cwd=ROOT,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )

    def assert_denied(script):
        result = execute(script)
        assert result.returncode == 47, result.stderr
        assert not mutation.exists()
        arguments = guard_args.read_text().splitlines()
        assert "--manual-rollback" in arguments
        assert arguments[arguments.index("--required-ancestor") + 1] == "a" * 40

    script = ROOT / "scripts/ci/cloudrun-rollback.sh"
    assert_denied(script)
    guard_args.unlink()
    for flag, project, region in (
        ("TRUE", "hushh-pda", "us-central1"),
        ("true", "untrusted-project", "us-central1"),
        ("true", "hushh-pda", "europe-west1"),
    ):
        environment.update(HUSHH_DOCUMENT_MANUAL_ROLLBACK_GUARD=flag, GCP_PROJECT_ID=project)
        assert execute(script, region).returncode != 0
        assert not mutation.exists() and not guard_args.exists()
    environment.update(HUSHH_DOCUMENT_MANUAL_ROLLBACK_GUARD="true", GCP_PROJECT_ID="hushh-pda")
    source = script.read_text()
    broken = tmp_path / "unguarded-rollback.sh"
    broken.write_text(
        source[: source.index("manual_reader_guard=")] + source[source.index("cmd=(") :]
    )
    with pytest.raises(AssertionError):
        assert_denied(broken)
    assert mutation.read_text().splitlines()[:4] == [
        "run",
        "services",
        "update-traffic",
        "hushh-webapp",
    ]
    assert not guard_args.exists()


def test_every_manual_rollback_job_installs_and_uses_the_reader_guard():
    jobs = yaml.safe_load((ROOT / ".github/workflows/rollback.yml").read_text())["jobs"]
    assert set(jobs) == {"rollback-uat", "rollback-production"}
    for job in jobs.values():
        assert job["env"]["HUSHH_DOCUMENT_MANUAL_ROLLBACK_GUARD"] == "true"
        steps = job["steps"]
        setup = next(
            i for i, step in enumerate(steps) if "psycopg2-binary==" in step.get("run", "")
        )
        assert "cloud-sql-proxy" in steps[setup]["run"]
        assert "PROTOCOL_PYTHON=" in steps[setup]["run"]
        rollbacks = [
            (i, step) for i, step in enumerate(steps) if step.get("id", "").startswith("rollback-")
        ]
        assert {step["id"] for _, step in rollbacks} == {"rollback-backend", "rollback-frontend"}
        for index, step in rollbacks:
            assert index > setup
            assert "scripts/ci/cloudrun-rollback.sh" in step["run"]
            assert "HUSHH_DOCUMENT_MANUAL_ROLLBACK_GUARD" not in step.get("env", {})
        assert all("update-traffic" not in step.get("run", "") for step in steps)
