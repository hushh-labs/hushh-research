# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Authenticated original issuer observations survive canonical revision retirement."""

import copy
import importlib
import os
import subprocess
from unittest.mock import MagicMock

import pytest
import yaml
from helpers.phone_rollback_release import ROOT
from helpers.phone_rollback_release import closed_workos as closed_workos
from helpers.workos_observations import (
    discovery_ports,
    original_ports,
    original_receipt_case,
    restoration_observation,
    sealed_cold_case,
)

pytestmark = pytest.mark.feature_auth_reliability


@pytest.fixture(autouse=True)
def workos_paths(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "scripts/ci"))
    monkeypatch.syspath_prepend(str(ROOT / "deploy/phone"))


def test_workos_archive_callers_receive_the_scoped_workflow_token(tmp_path):
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    callers = []
    for job in workflow["jobs"].values():
        for step in job.get("steps", []):
            if "deploy/phone/workos_rollout.py" in step.get("run", ""):
                env = {**workflow.get("env", {}), **job.get("env", {}), **step.get("env", {})}
                callers.append((step, env))
    step, env = next(
        (step, env)
        for step, env in callers
        if step["name"] == "Qualify WorkOS non-activation before production mutation"
    )
    python = tmp_path / "qualified-python"
    python.write_text(
        '#!/bin/sh\n[ "${GH_TOKEN:-}" = "synthetic-actions-read-token" ] || exit 17\n'
    )
    python.chmod(0o755)
    script = (
        step["run"]
        .replace("${{ env.PROTOCOL_PYTHON }}", str(python))
        .replace("${{ env.GCP_PROJECT_ID }}", "hushh-pda")
    )
    runtime_env = {"PATH": os.environ["PATH"], "RESTORATION_SOURCE": "d" * 40}
    if env.get("GH_TOKEN") in {"${{ github.token }}", "${{ secrets.GITHUB_TOKEN }}"}:
        runtime_env["GH_TOKEN"] = "synthetic-actions-read-token"
    result = subprocess.run(  # noqa: S603 -- authored workflow, hermetic Python/token port.
        ["bash", "-euc", script], env=runtime_env, capture_output=True, timeout=10
    )
    assert result.returncode == 0, "Archive lookup requires the current workflow token"
    assert all(
        env.get("GH_TOKEN") in {"${{ github.token }}", "${{ secrets.GITHUB_TOKEN }}"}
        for _, env in callers
    )


@pytest.mark.parametrize(
    "defect",
    [
        None,
        "newer_event",
        "new_source",
        "new_issuer",
        "creation",
        "uid",
        "reappeared",
        "birth_open",
        "birth_missing",
        "birth_secret",
        "truncated",
        "retained_only",
        "other_flag",
        "row",
        "anchor",
    ],
)
@pytest.mark.parametrize("kind", ["restoration", "operational"])
def test_retired_restoration_observation_never_replaces_unknown_or_contrary_history(
    closed_workos, defect, kind
):
    module = closed_workos
    historical, observation, event, template = restoration_observation(module)
    key = "historical_observation"
    if kind == "operational":
        import operational_workos_observation as historical

        observation["row"].update(revision=historical.REVISION, created_at=historical.CREATED)
        template["metadata"]["name"] = historical.REVISION
        event["timestamp"] = "2026-10-27T04:00:00Z"
        key = "operational_observation"
    source = observation["row"]["source"]
    options = dict(
        project="hushh-pda",
        until="2026-10-29T06:00:00Z",
        restoration_sha=source,
        check=lambda sha: True,
        **{key: observation},
    )
    inventory = {}
    events = [event]
    if defect == "newer_event":
        event["timestamp"] = "2026-10-28T00:00:00Z"
    elif defect == "new_source":
        template["metadata"]["labels"]["deploy-sha"] = "a" * 40
    elif defect == "new_issuer":
        template["metadata"]["name"] = "consent-protocol-unknown"
    elif defect == "creation":
        template["metadata"]["creationTimestamp"] = "2026-10-27T01:33:00Z"
    elif defect == "uid":
        template["metadata"]["uid"] = "unrecorded-incarnation"
    elif defect == "reappeared":
        inventory[historical.REVISION] = observation["row"]
    elif defect in {"birth_open", "birth_missing", "birth_secret"}:
        flags = (
            [] if defect == "birth_missing" else [{"name": "WORKOS_SSO_ENABLED", "value": "true"}]
        )
        if defect == "birth_secret":
            flags = [
                {"name": "WORKOS_SSO_ENABLED", "valueFrom": {"secretKeyRef": {"name": "mutable"}}}
            ]
        template["spec"]["containers"][0]["env"] = flags
        event["protoPayload"]["response"] = {
            "kind": "Service",
            "spec": {"template": template},
            "status": {"latestCreatedRevisionName": historical.REVISION},
        }
    elif defect == "truncated":
        events *= module.LIMIT
    elif defect == "retained_only":
        options["require_retained"] = True
    elif defect == "other_flag":
        options["flag"] = "AUTH_PHONE_RECOVERY_ENABLED"
    elif defect == "row":
        observation["row"]["direct_sso_false"] = 1
    elif defect == "anchor":
        observation["source_anchor"] = "b" * 40
    if defect:
        with pytest.raises(ValueError):
            module.review_history(events, inventory, **options)
    else:
        # Negative control: these redacted requests alone never established closure.
        with pytest.raises(ValueError, match="historical_issuer"):
            module.review_history(
                events,
                inventory,
                **{k: v for k, v in options.items() if k != key},
            )
        assert module.review_history(events, inventory, **options) == 1
        assert inventory == {}


@pytest.mark.parametrize("failure", [None, "database", "inventory_changed", "unavailable_archive"])
def test_workos_preserved_observation_keeps_fresh_database_and_inventory_gates(
    closed_workos, monkeypatch, failure
):
    module = closed_workos
    historical, observation, event, _ = restoration_observation(module)
    source = observation["row"]["source"]
    monkeypatch.setattr(module, "_capable", lambda *_: True)
    inventories = iter([{}, {"changed": {}} if failure == "inventory_changed" else {}])
    monkeypatch.setattr(module, "_revisions", lambda *_: next(inventories))
    monkeypatch.setattr(module, "_document", lambda *_: [event])
    database = MagicMock(return_value={"memberships_empty": True, "sso_receipts_empty": True})
    if failure == "database":
        database.side_effect = ValueError("workos_mutation_authority_already_exists")
    monkeypatch.setattr(module, "database_evidence", database)
    loader = MagicMock(return_value=copy.deepcopy(observation))
    if failure == "unavailable_archive":
        loader.side_effect = ValueError("workos_historical_observation_unqualified")
    monkeypatch.setattr(historical, "load", loader)
    if failure:
        with pytest.raises(ValueError):
            module.qualify("hushh-pda", source)
    else:
        receipt = module.qualify("hushh-pda", source)
        assert receipt["qualification"] == "passed" and receipt["revisions"] == []
        assert receipt["audit_event_count"] == 1
        assert receipt["historical_observation"] == {
            **observation["provenance"],
            "reused_revision_count": 1,
        }
        assert receipt["sso_activation_qualified"] is False
    loader.assert_called_once_with(source)
    assert database.call_count == (0 if failure == "unavailable_archive" else 1)


@pytest.mark.parametrize(
    "defect",
    [
        None,
        "attempt",
        "workflow",
        "failed",
        "artifact",
        "digest",
        "member",
        "source",
        "row",
        "duplicate",
        "closure",
        "step",
        "captured",
        "authority",
        "refresh",
    ],
)
def test_preserved_workos_observation_authenticates_exact_original_receipt(
    closed_workos, monkeypatch, defect
):
    case = original_receipt_case(closed_workos)
    historical, observation, source = case.historical, case.observation, case.source
    run, artifact, receipt, step = case.run, case.artifact, case.receipt, case.step
    if defect == "attempt":
        run["run_attempt"] += 1
    elif defect == "workflow":
        run["head_sha"] = "a" * 40
    elif defect == "failed":
        run["conclusion"] = "failure"
    elif defect == "artifact":
        artifact["id"] += 1
    elif defect == "digest":
        artifact["digest"] = "sha256:" + "a" * 64
    elif defect == "source":
        receipt["restoration_source"] = "a" * 40
    elif defect == "row":
        receipt["revisions"][0]["created_at"] = "2026-10-27T01:33:00Z"
    elif defect == "duplicate":
        receipt["revisions"] *= 2
    elif defect == "closure":
        receipt["revisions"][0]["direct_sso_false"] = False
    elif defect == "step":
        step["conclusion"] = "skipped"
    elif defect == "captured":
        receipt["captured_at"] = "2026-10-27T08:54:30Z"
    owner, continuation = original_ports(case, monkeypatch, defect)
    if defect:
        with pytest.raises(ValueError):
            historical.load(source)
    else:
        result = historical.load(source)
        assert result["row"] == observation["row"]
        assert result["provenance"]["artifact_digest"] == historical.DIGEST
        owner.serving_reference.assert_called_once()
        continuation.manual.assert_called_once_with(run)
        assert continuation.fresh_run.call_count == 2


@pytest.fixture
def sealed_workos_case(monkeypatch):
    return sealed_cold_case(monkeypatch)


@pytest.mark.parametrize(
    "defect",
    [
        None,
        "summary",
        "digest",
        "scope",
        "source",
        "flag",
        "duplicate",
        "carried_only",
        "uid",
        "snapshot_source",
        "database",
        "step",
        "timestamp",
        "upload",
    ],
)
def test_sealed_cold_workos_observation_preserves_only_original_direct_evidence(
    sealed_workos_case, defect
):
    state = sealed_workos_case
    receipt = state.report.get("receipt")
    assert receipt is not None, "Cold proof must retain its full original WorkOS receipt"
    if defect == "summary":
        state.report.pop("receipt")
    elif defect == "scope":
        receipt["project"] = "hushh-pda-uat"
    elif defect == "source":
        receipt["revisions"][0]["source"] = "b" * 40
    elif defect == "flag":
        receipt["revisions"][0]["direct_sso_false"] = 1
    elif defect == "duplicate":
        receipt["revisions"] *= 2
    elif defect == "carried_only":
        receipt["historical_observation"]["row"] = receipt["revisions"].pop()
    elif defect == "uid":
        state.anchor["sealed_boundary"]["installed_schema"]["snapshot"]["revisions"][
            state.module.REVISION
        ].pop("uid")
    elif defect == "snapshot_source":
        state.anchor["sealed_boundary"]["installed_schema"]["snapshot"]["revisions"][
            state.module.REVISION
        ]["source"] = "b" * 40
    elif defect == "database":
        receipt["database"]["memberships_empty"] = False
    elif defect == "step":
        state.job["steps"][0]["conclusion"] = "skipped"
    elif defect == "timestamp":
        receipt["captured_at"] = "2026-10-29T06:00:16Z"
    elif defect == "upload":
        state.artifact["created_at"] = "2026-10-29T06:00:14Z"
    state.report["digest"] = (
        "changed"
        if defect == "digest"
        else importlib.import_module("production_backend_successor_proof").digest(receipt)
    )
    if defect:
        with pytest.raises((ValueError, KeyError)):
            state.module.from_anchor(state.anchor, state.source, state.job, state.artifact)
    else:
        observed = state.module.from_anchor(state.anchor, state.source, state.job, state.artifact)
        assert observed["row"] == receipt["revisions"][0]
        assert observed["revision_uid"] == "original-revision-uid"
        assert observed["provenance"]["origin"] == state.anchor["origin"]
        event = {
            "timestamp": "2026-10-27T11:07:48Z",
            "resource": {"labels": {"service_name": "consent-protocol"}},
            "logName": "projects/hushh-pda/logs/cloudaudit.googleapis.com%2Factivity",
            "protoPayload": {
                "serviceName": "run.googleapis.com",
                "methodName": "/Services.ReplaceService",
                "request": {
                    "service": {
                        "spec": {
                            "template": {
                                "metadata": {
                                    "name": state.module.REVISION,
                                    "labels": {"deploy-sha": state.source},
                                },
                                "spec": {"containers": [{"env": []}]},
                            }
                        }
                    }
                },
            },
        }
        args = dict(
            project="hushh-pda",
            until="2026-10-29T06:01:00Z",
            restoration_sha=state.source,
            check=lambda _: True,
            operational_observation=observed,
        )
        assert state.closed.review_history([event], {}, **args) == 1
        event["timestamp"] = "2026-10-29T06:00:11Z"
        with pytest.raises(ValueError):
            state.closed.review_history([event], {}, **args)


@pytest.mark.parametrize(
    "kind,defect",
    [
        (kind, defect)
        for kind in ("operational", "activation", "ordinary")
        for defect in (None, "authority", "attempt", "tag")
    ]
    + [(kind, "discovery_attempt") for kind in ("activation", "ordinary")],
)
def test_retired_workos_observation_follows_authenticated_original_cold_pointer(
    sealed_workos_case, monkeypatch, kind, defect
):
    state = sealed_workos_case
    module, anchor = state.module, state.anchor
    proof, owner, continuation = discovery_ports(state, kind, defect, monkeypatch)
    if defect:
        with pytest.raises(ValueError):
            module.load(state.source)
    else:
        observed = module.load(state.source)
        assert observed["provenance"]["origin"] == anchor["origin"]
        assert observed["row"]["revision"] == module.REVISION
        assert proof.load.call_count == (0 if kind == "operational" else 1)
        assert owner.find_release.call_count == (0 if kind == "operational" else 1)
        if kind != "operational":
            proof.load.assert_called_once_with("42", 2, **module._ports(owner))
            continuation.archive_context.assert_called_once()
