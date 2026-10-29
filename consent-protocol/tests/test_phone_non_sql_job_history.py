# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""The reviewed monitoring program cannot widen database producer authority."""

import importlib
import json

import pytest

from tests.test_phone_schema_job_history import ROOT
from tests.test_phone_schema_job_history import history as shared_history

pytestmark = pytest.mark.feature_auth_reliability
history = shared_history


@pytest.mark.parametrize("changed", [None, "birth", "override", "outcome", "unknown"])
def test_native_monitor_history_retains_failed_outcomes_without_admitting_sql_issuers(
    history, changed, monkeypatch
):
    module, _producer, _events_unused, proof = history
    budget = importlib.import_module("runtime-capacity-budget")
    health = budget._inventory._health_module()
    # This fixture tests native history, not the caller's Git fetch depth.
    monkeypatch.setattr(health, "reviewed_source", lambda: None)
    fixture = json.loads(
        (ROOT / "consent-protocol/tests/fixtures/protected_configuration_job.json")
        .read_text()
        .replace("<reviewed-source-sha>", health.SOURCE)
    )

    def read(*args):
        return (
            fixture["build"]
            if args[0] == "builds"
            else ([] if args[2] == "executions" else fixture["job"])
        )

    qualified = health.qualify(fixture["job"], read)
    events = fixture["events"]
    if changed == "birth":
        events.pop(1)
    elif changed == "override":
        events[-1]["protoPayload"]["response"]["spec"]["template"]["spec"]["containers"][0][
            "command"
        ] = ["sh"]
    elif changed == "outcome":
        events[-1]["protoPayload"]["status"]["code"] = 0
    elif changed == "unknown":
        events[-1]["resource"]["labels"]["job_name"] = "unreviewed"

    def review():
        return module.review(
            events,
            {},
            {},
            fixture["until"],
            submissions=lambda: proof,
            project_number="1006304528804",
            non_sql=qualified,
        )

    if changed:
        with pytest.raises(ValueError):
            review()
    else:
        result = review()
        assert result["event_count"] == 5 and result["closed_jobs"] == []
        assert result["verified_non_sql_job"]["failed_execution_count"] == 3
