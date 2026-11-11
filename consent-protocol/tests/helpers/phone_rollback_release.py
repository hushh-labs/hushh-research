# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Existing phone rollback plan fixtures and bounded external-command ports."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

ROOT = Path(__file__).resolve().parents[3]

FALLBACK = "c2a56386064f101799669a8d27a8d6af8198edec"

PRIMARY = "25759339d32e2b5b1f8f84c0d922db8abbf9f956"

IMAGE = "gcr.io/hushh-pda/consent-protocol@sha256:" + "b" * 64

REVISION = "consent-protocol-00001-abc"


def _load_plan(monkeypatch):
    directory = ROOT / "deploy/phone"
    monkeypatch.syspath_prepend(str(directory))
    spec = importlib.util.spec_from_file_location(
        "phone_rollback_release_plan", directory / "plan.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _revision():
    values = {
        "HUSHH_DEPLOY_ENV": "production",
        "ENVIRONMENT": "production",
        "GOOGLE_CLOUD_PROJECT": "hushh-pda",
        "HUSHH_DEPLOY_SOURCE": "deploy-production",
        "HUSHH_DEPLOY_SHA": FALLBACK,
        "HUSHH_DEPLOY_RUN_ID": "41",
    }
    return {
        "metadata": {
            "name": REVISION,
            "labels": {
                "serving.knative.dev/service": "consent-protocol",
                "deploy-env": "production",
                "deploy-source": "deploy-production",
                "deploy-sha": FALLBACK,
                "github-run-id": "41",
                "account-deletion-contract": "v201",
            },
        },
        "spec": {
            "serviceAccountName": "consent-protocol-runtime@hushh-pda.iam.gserviceaccount.com",
            "containers": [
                {
                    "image": IMAGE,
                    "env": [{"name": key, "value": value} for key, value in values.items()],
                }
            ],
        },
        "status": {"imageDigest": IMAGE, "conditions": [{"type": "Ready", "status": "True"}]},
    }


def _command_port(state, command, **_kwargs):
    state.calls.append(command)
    if command[:2] == ["git", "show"]:
        sha, path = command[2].split(":", 1)
        suffix = (
            sha
            if path.removeprefix("consent-protocol/") in state.compat.REVIEWED_EXCEPTIONS
            else "unchanged"
        )
        return f"{path}:{suffix}".encode()
    if command[:4] == ["gcloud", "run", "revisions", "list"]:
        return json.dumps(state.readers).encode()
    if "verify-predecessor-acceptance.py" in command[1]:
        output = Path(command[command.index("--output") + 1])
        output.write_text(
            json.dumps(
                {
                    "status": "accepted",
                    "environment": "uat",
                    "sha": FALLBACK,
                    "services": {
                        "backend": {
                            "image_reference": IMAGE.replace("hushh-pda/", "hushh-pda-uat/")
                        }
                    },
                }
            )
        )
        return b""
    if command[:4] == ["gcloud", "container", "images", "add-tag"]:
        return b""
    if command[:4] == ["gcloud", "container", "images", "describe"]:
        return IMAGE.split("@", 1)[1].encode()
    if command[:2] == ["python3", "scripts/ci/verify-cloudrun-revision-provenance.py"]:
        return b""
    raise AssertionError(f"Unexpected release command: {command}")


def cleanup_upgrade_source(state, paths, migration, changed, mutation):
    """Whole-file fixture for the coupled cleanup upgrade and its refusal controls."""
    original = state.compat._source
    before = "84b80bcab6b5b7a4de21a5a992d3c969dacba5b9"
    after = "49dafdc2f1b6e1dcd87e7badd7cf850a6e1494fc"
    fallback, primary = "a" * 40, "e" * 40

    def source(sha, path):
        if path in paths or path == migration:
            if sha in {before, fallback}:
                body = b"complete old file:" + path.encode()
            elif sha in {after, primary}:
                body = b"complete reviewed file:" + path.encode()
            else:
                return original(sha, path)
            if path == changed:
                if mutation == "wrong_old" and sha == fallback:
                    body += b"unreviewed authority"
                elif mutation == "wrong_new" and sha == primary:
                    body += b"unreviewed authority"
                elif mutation == "reversed" and sha in {fallback, primary}:
                    prefix = (
                        b"complete reviewed file:" if sha == fallback else b"complete old file:"
                    )
                    body = prefix + path.encode()
                elif mutation == "partial" and sha == primary:
                    body = b"complete old file:" + path.encode()
            return body
        if sha in {before, fallback}:
            sha = FALLBACK
        elif sha in {after, primary}:
            sha = PRIMARY
        return original(sha, path)

    return source


def _source_gate(command, **_kwargs):
    if command[:3] == ["git", "merge-base", "--is-ancestor"]:
        sha = command[-2]
    else:
        assert command[:3] == [
            "python3",
            "deploy/account-deletion/activate_release.py",
            "--qualify-rollback-source",
        ]
        sha = command[-1]
    return SimpleNamespace(returncode=0 if sha in {FALLBACK, PRIMARY} else 1)


@pytest.fixture
def release_plan(monkeypatch, tmp_path):
    plan = _load_plan(monkeypatch)
    import consumer_compatibility
    import production_receipt
    import revision_qualification

    state = SimpleNamespace(
        plan=plan,
        compat=consumer_compatibility,
        revision=_revision(),
        calls=[],
        readers=[{"metadata": {"labels": {"deploy-sha": FALLBACK}}}],
    )
    args = SimpleNamespace(
        current_json=tmp_path / "current.json",
        output=tmp_path / "plan.json",
        github_output=tmp_path / "github-output",
        run_id="42",
        primary_sha=PRIMARY,
        fallback_sha="",
        release_tools=tmp_path,
        enable_recovery="false",
    )
    args.current_json.write_text(json.dumps(state.revision))
    state.args = args
    monkeypatch.setattr(plan.subprocess, "run", _source_gate)
    monkeypatch.setattr(
        plan.qualify_image, "run", lambda command, **kwargs: _command_port(state, command, **kwargs)
    )
    monkeypatch.setattr(
        consumer_compatibility, "run", lambda command: _command_port(state, command)
    )
    monkeypatch.setattr(
        plan.qualify_image,
        "qualify",
        lambda sha, image: {
            "source": sha,
            "image": image,
            "probe_sha256": hashlib.sha256(
                (ROOT / "deploy/phone/reader_probe.py").read_bytes()
            ).hexdigest(),
            "phone_reader": copy.deepcopy(plan.qualify_image.EXPECTED),
            "probe_generation_admission": False,
        },
    )
    monkeypatch.setattr(production_receipt, "run", lambda command: _production_port(state, command))
    monkeypatch.setattr(plan, "_operational", lambda: None)
    state.service = {
        "metadata": {"name": "consent-protocol"},
        "status": {
            "url": "https://consent-protocol-example-uc.a.run.app",
            "latestReadyRevisionName": REVISION,
            "traffic": [{"revisionName": REVISION, "percent": 100}],
        },
    }

    def cloud(kind, _name):
        return copy.deepcopy(state.service if kind == "services" else state.revision)

    monkeypatch.setattr(revision_qualification, "cloud_document", cloud)
    monkeypatch.setattr(plan, "cloud_document", cloud)
    opener = MagicMock()
    opener.open.return_value.__enter__.return_value.status = 200
    monkeypatch.setattr(revision_qualification, "build_opener", lambda _handler: opener)
    return state


def _production_port(state, command):
    state.calls.append(command)
    if command[:2] == ["gh", "api"]:
        if "/artifacts?" in command[-1]:
            return json.dumps(
                {
                    "total_count": 1,
                    "artifacts": [
                        {
                            "id": 4,
                            "name": "prod-release-41",
                            "expired": False,
                            "created_at": "2026-10-26T01:00:00Z",
                        }
                    ],
                }
            ).encode()
        return json.dumps(
            {
                "id": 41,
                "status": "completed",
                "conclusion": "success",
                "event": "workflow_dispatch",
                "path": ".github/workflows/deploy-production.yml",
                "head_branch": "main",
                "run_attempt": 1,
                "run_started_at": "2026-10-26T00:00:00Z",
            }
        ).encode()
    assert command[:3] == ["gh", "run", "download"]
    destination = Path(command[command.index("--dir") + 1])
    (destination / "prod-release-status.json").write_text(
        json.dumps(
            {
                "status": "healthy",
                "sha": FALLBACK,
                "candidate": {"backend_revision": REVISION},
                "final": {"backend_revision": REVISION},
            }
        )
    )
    return b""


def _verify_args(state):
    return SimpleNamespace(
        plan=state.args.output,
        primary_sha=state.args.primary_sha,
        run_id=state.args.run_id,
        output=state.args.output.with_name("verified.json"),
        github_output=state.args.output.with_name("verified-output"),
    )


@pytest.fixture
def closed_workos(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/phone"))
    import workos_rollout

    monkeypatch.setattr(workos_rollout, "source_capable", lambda sha: sha == PRIMARY)
    return workos_rollout
