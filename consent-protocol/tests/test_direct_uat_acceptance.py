# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Direct UAT preserves exact application authority and historical acceptance."""

from unittest import mock

import pytest

from tests.helpers.predecessor_acceptance import SHA, _acceptance_fixture


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
