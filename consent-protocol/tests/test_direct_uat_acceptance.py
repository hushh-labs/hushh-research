# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Direct UAT pins its CI base and preserves historical acceptance authority."""

from pathlib import Path
from unittest import mock

import pytest
import yaml

from tests.helpers.predecessor_acceptance import SHA, _acceptance_fixture

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("job", ["protocol-check", "web-full-suite-check"])
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
