# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Immutable phone rollback plans and retained-reader activation boundaries."""

import hashlib
import json
import subprocess
from unittest.mock import MagicMock

import pytest
from helpers.phone_rollback_release import (
    FALLBACK,
    IMAGE,
    PRIMARY,
    REVISION,
    ROOT,
    _revision,
    _verify_args,
)
from helpers.phone_rollback_release import (
    closed_workos as closed_workos,
)
from helpers.phone_rollback_release import (
    release_plan as release_plan,
)

pytestmark = pytest.mark.feature_auth_reliability


def test_existing_plan_rechecks_actual_revision_and_propagates_identity(release_plan):
    state = release_plan
    prepared = state.plan.prepare(state.args)
    assert prepared["primary_sha"] == PRIMARY
    assert prepared["source"] == FALLBACK
    assert prepared["image"] == IMAGE
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
        "db/migrations/431_phone_recovery_actions.sql",
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


@pytest.mark.parametrize(
    ("changed", "mutation"),
    [
        (None, None),
        *(
            (path, mutation)
            for path in (
                "api/routes/account.py",
                "hushh_mcp/services/account_deletion_lifecycle_service.py",
            )
            for mutation in ("wrong_old", "wrong_new", "reversed")
        ),
    ],
)
def test_cleanup_reporting_pair_is_exact(release_plan, monkeypatch, changed, mutation):
    compat = release_plan.compat
    original = compat._source
    before = "0c32dc1cba0e5a0a4d7a3f9c257baf32e2e4b14b"
    after = "d5f5175957cecbfa1ba0394d5dcf7621cb6385b2"
    fallback, primary = "a" * 40, "e" * 40
    paths = (
        "api/routes/account.py",
        "hushh_mcp/services/account_deletion_lifecycle_service.py",
    )

    def source(sha, path):
        if path in paths:
            if sha in {before, fallback}:
                body = b"old complete file"
            elif sha in {after, primary}:
                body = b"new reporting file"
            else:
                return original(sha, path)
            if path == changed:
                if mutation == "wrong_old" and sha == fallback:
                    body += b"!"
                elif mutation == "wrong_new" and sha == primary:
                    body += b"!"
                elif mutation == "reversed" and sha in {fallback, primary}:
                    body = b"new reporting file" if sha == fallback else b"old complete file"
            return body
        if sha in {before, fallback}:
            sha = FALLBACK
        elif sha in {after, primary}:
            sha = PRIMARY
        return original(sha, path)

    monkeypatch.setattr(compat, "_source", source)
    if mutation is not None:
        with pytest.raises(ValueError, match="consumer_change_unqualified"):
            compat.qualify_consumers(fallback, primary)
        return
    proof = compat.qualify_consumers(fallback, primary)
    assert compat.ERASURE_REPORTING_EXCEPTIONS == paths
    assert len(proof["source_sha256"]) == 28
    assert all(
        proof["source_sha256"][path] == hashlib.sha256(b"new reporting file").hexdigest()
        for path in paths
    )


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
