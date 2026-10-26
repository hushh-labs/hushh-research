# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Immutable phone rollback plans and retained-reader activation boundaries."""

import copy
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

pytestmark = pytest.mark.feature_auth_reliability
ROOT = Path(__file__).resolve().parents[2]
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


def test_existing_plan_rechecks_actual_revision_and_propagates_identity(release_plan):
    state = release_plan
    prepared = state.plan.prepare(state.args)
    assert prepared["primary_sha"] == PRIMARY
    assert prepared["source"] == FALLBACK
    assert prepared["image"] == IMAGE
    assert prepared["run_id"] == "42"
    assert prepared["production"]["run_id"] == "41"
    assert prepared["runtime"]["revision"] == REVISION
    result = state.plan.verify(_verify_args(state))
    assert (result["revision"], result["source"], result["image"]) == (REVISION, FALLBACK, IMAGE)
    assert result["probe"] == prepared["probe"]
    assert _verify_args(state).github_output.read_text() == f"revision={REVISION}\n"
    assert sum(command[:3] == ["gh", "run", "download"] for command in state.calls) == 2


@pytest.mark.parametrize(
    "qualified,explicit,enabled",
    [(False, "true", False), (True, "false", False), (True, "true", True)],
)
def test_recovery_activation_requires_all_retained_readers_and_explicit_enable(
    release_plan, qualified, explicit, enabled
):
    state = release_plan
    state.args.enable_recovery = explicit
    if not qualified:
        state.readers.append({"metadata": {"labels": {"deploy-sha": "d" * 40}}})
    prepared = state.plan.prepare(state.args)
    assert prepared["recovery_enabled"] is enabled
    assert f"recovery_enabled={str(enabled).lower()}\n" in state.args.github_output.read_text()


def test_retry_requalifies_cold_rollback_after_failed_run(release_plan):
    state = release_plan
    labels = state.revision["metadata"]["labels"]
    labels["deploy-source"] = "deploy-production-phone-rollback"
    labels["github-run-id"] = "40"
    state.args.current_json.write_text(json.dumps(state.revision))
    state.args.fallback_sha = FALLBACK
    prepared = state.plan.prepare(state.args)
    assert prepared["mode"] == "cold"
    assert prepared["predecessor"]["sha"] == FALLBACK
    assert any("verify-predecessor-acceptance.py" in row[1] for row in state.calls)
    assert not any(row[:2] == ["gh", "api"] for row in state.calls)


@pytest.mark.parametrize("same_source", [True, False])
def test_cold_plan_requires_independent_source_before_writing(release_plan, same_source):
    state = release_plan
    state.args.current_json.write_text(
        json.dumps({"metadata": {"labels": {"deploy-sha": "d" * 40}}})
    )
    state.args.fallback_sha = FALLBACK
    state.args.primary_sha = FALLBACK if same_source else "d" * 40
    reason = "requires_independent_source" if same_source else "primary_lacks_current_admission"
    with pytest.raises(ValueError, match=reason):
        state.plan.prepare(state.args)
    if not same_source:
        assert not state.calls
    assert not state.args.output.exists()
    assert not state.args.github_output.exists()


def test_cold_plan_propagates_the_freshly_qualified_zero_traffic_revision(release_plan):
    state = release_plan
    state.args.current_json.write_text(
        json.dumps({"metadata": {"labels": {"deploy-sha": "d" * 40}}})
    )
    state.args.fallback_sha = FALLBACK
    prepared = state.plan.prepare(state.args)
    assert prepared["mode"] == "cold"
    cold_name = "consent-protocol-00002-def"
    state.revision["metadata"]["name"] = cold_name
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
    state.service["status"]["traffic"].append(
        {
            "tag": "phone-rollback-42",
            "revisionName": cold_name,
            "percent": 0,
            "url": "https://phone-rollback-42---consent-protocol-example-uc.a.run.app",
        }
    )
    result = state.plan.verify(_verify_args(state))
    assert (result["revision"], result["source"], result["image"]) == (cold_name, FALLBACK, IMAGE)
    assert result["recovery"] is False
    assert result["health"] == "passed"
    assert _verify_args(state).github_output.read_text() == f"revision={cold_name}\n"


@pytest.mark.parametrize("forgery", ["run", "primary", "image", "probe", "verdict", "generation"])
def test_forged_plan_evidence_refuses_before_qualification_output(release_plan, forgery):
    state = release_plan
    prepared = state.plan.prepare(state.args)
    if forgery == "run":
        prepared["run_id"] = "43"
    elif forgery == "primary":
        prepared["primary_sha"] = "e" * 40
    elif forgery == "image":
        prepared["probe"]["image"] = IMAGE[:-1] + "c"
    elif forgery == "probe":
        prepared["probe"]["probe_sha256"] = "0" * 64
    elif forgery == "verdict":
        prepared["probe"]["phone_reader"]["retired"] = "admitted"
    else:
        prepared["probe"]["probe_generation_admission"] = True
    state.args.output.write_text(json.dumps(prepared))
    args = _verify_args(state)
    with pytest.raises(ValueError, match="preparation_evidence_mismatch"):
        state.plan.verify(args)
    assert not args.output.exists()
    assert not args.github_output.exists()


def test_reader_stage_regression_blocks_prepared_enable_before_output(release_plan):
    state = release_plan
    state.args.enable_recovery = "true"
    assert state.plan.prepare(state.args)["recovery_enabled"] is True
    state.readers.append({"metadata": {"labels": {"deploy-sha": "d" * 40}}})
    args = _verify_args(state)
    with pytest.raises(ValueError, match="preparation_evidence_mismatch"):
        state.plan.verify(args)
    assert not args.output.exists()
    assert not args.github_output.exists()


@pytest.mark.parametrize(
    "changed",
    (
        "hushh_mcp/services/account_firebase_mutations.py",
        *(f"api/routes/account_{route}.py" for route in ("phone_recovery", "device_revocation")),
        "hushh_mcp/services/phone_recovery_state.py",
        "hushh_mcp/services/device_action_service.py",
        "db/migrations/428_phone_recovery_actions.sql",
        "db/contracts/prod_core_schema.json",
    ),
)
def test_consumer_drift_requires_qualification(release_plan, monkeypatch, changed):
    original = release_plan.compat._source

    def modified_source(sha, path):
        if sha == "e" * 40 and path == changed:
            return b"unreviewed additional authority"
        return original(PRIMARY if sha == "e" * 40 else sha, path)

    monkeypatch.setattr(release_plan.compat, "_source", modified_source)
    with pytest.raises(ValueError, match="consumer_change_unqualified"):
        release_plan.compat.qualify_consumers(FALLBACK, "e" * 40)


@pytest.fixture
def closed_workos(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/phone"))
    import workos_rollout

    monkeypatch.setattr(workos_rollout, "source_capable", lambda sha: sha == PRIMARY)
    return workos_rollout


@pytest.mark.parametrize("flag", ["false", "true", None])
def test_workos_initial_rollout_requires_literal_closed_427_revision(closed_workos, flag):
    revision = _revision()
    revision["metadata"].update(creationTimestamp="2026-10-26T06:00:00Z")
    revision["metadata"]["labels"]["deploy-sha"] = PRIMARY
    if flag is not None:
        revision["spec"]["containers"][0]["env"].append(
            {"name": "WORKOS_SSO_ENABLED", "value": flag}
        )
    if flag == "false":
        assert closed_workos.revision_inventory([revision])[REVISION]["direct_sso_false"]
    else:
        with pytest.raises(ValueError, match="not_directly_closed"):
            closed_workos.revision_inventory([revision])


@pytest.mark.parametrize("birth_flag", ["false", "true"])
def test_workos_history_does_not_replace_creation_evidence_with_later_config(
    closed_workos, birth_flag
):
    template = {
        "metadata": {"name": REVISION, "labels": {"deploy-sha": PRIMARY}},
        "spec": {"containers": [{"env": [{"name": "WORKOS_SSO_ENABLED", "value": birth_flag}]}]},
    }
    event = {
        "resource": {"labels": {"service_name": "consent-protocol"}},
        "timestamp": "2026-10-26T06:00:00Z",
        "logName": "projects/hushh-pda/logs/cloudaudit.googleapis.com%2Factivity",
        "protoPayload": {
            "serviceName": "run.googleapis.com",
            "methodName": "/Services.ReplaceService",
            "response": {
                "kind": "Service",
                "spec": {"template": template},
                "status": {"latestCreatedRevisionName": REVISION},
            },
        },
    }
    inventory = {
        REVISION: {"source": PRIMARY, "created_at": event["timestamp"], "direct_sso_false": True}
    }
    if birth_flag == "true":
        with pytest.raises(ValueError, match="historical_issuer"):
            closed_workos.review_history(
                [event], inventory, project="hushh-pda", until="2026-10-26T07:00:00Z"
            )
    else:
        assert (
            closed_workos.review_history(
                [event], inventory, project="hushh-pda", until="2026-10-26T07:00:00Z"
            )
            == 1
        )
        with pytest.raises(ValueError, match="creation_history"):
            closed_workos.review_history(
                [], inventory, project="hushh-pda", until="2026-10-26T07:00:00Z"
            )


@pytest.mark.parametrize("authority", [False, True])
def test_workos_sql_qualifier_rejects_issued_authority(closed_workos, authority):
    connection = MagicMock()
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchone.side_effect = [(True,), (False,), (True,), (authority,)]
    if authority:
        with pytest.raises(ValueError, match="mutation_authority"):
            closed_workos._database_empty(connection)
    else:
        assert closed_workos._database_empty(connection)["sso_receipts_empty"]
    connection.set_session.assert_called_once_with(
        isolation_level="REPEATABLE READ", readonly=True, autocommit=False
    )


def test_failed_cold_qualification_prevents_the_shell_primary_deploy():
    helper = ROOT / "scripts/deploy/backend-phone-rollback.sh"
    command = 'source "$1"; stage_phone_rollback "$2" "$3" production hushh-pda true gcloud run deploy consent-protocol; printf primary-deployed'
    result = subprocess.run(  # noqa: S603 - Fixed repo shell and synthetic identities; no provider command executes.
        ["bash", "-euo", "pipefail", "-c", command, "phone-release", str(helper), FALLBACK, IMAGE],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )
    assert result.returncode != 0
    assert "primary-deployed" not in result.stdout
    assert "Phone fallback staging refused" in result.stderr
