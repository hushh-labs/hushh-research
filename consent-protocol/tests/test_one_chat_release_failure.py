"""Rollback and cleanup behavior for failed One Chat UAT releases."""

import importlib.util
from pathlib import Path
from unittest.mock import Mock

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/ci/uat_one_chat_backend_release.py"


def load_release_script():
    spec = importlib.util.spec_from_file_location("uat_one_chat_release_failure_test", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("candidate", "tagged", "traffic", "expected"),
    [
        (
            "",
            [{"tag": "one-chat-7-2", "revisionName": "candidate-2"}],
            [{"candidate-2": 100}, {"old-1": 100}],
            "rolled_back",
        ),
        ("candidate-2", [], [{"unknown-3": 100}], "rollback_failed"),
    ],
)
def test_release_failure_handler_preserves_safe_rollback(candidate, tagged, traffic, expected):
    module = load_release_script()
    report = {"status": "failed"}
    command = Mock()
    result = module.handle_failed_release(
        report,
        "old-1",
        candidate,
        "one-chat-7-2",
        RuntimeError("health probe failed"),
        service_state=Mock(return_value={"status": {"traffic": tagged}}),
        remove_candidate_tag=Mock(return_value=True),
        live_traffic=Mock(side_effect=traffic),
        command=command,
        service="consent-protocol",
        project="hushh-pda-uat",
        region="us-central1",
    )
    assert result == 1
    assert report["candidate_tag_removed"] is True
    assert report["status"] == expected
    if expected == "rolled_back":
        assert report["candidate_revision"] == "candidate-2"
        assert report["rollback"] is True
        command.assert_called_once_with(
            "gcloud",
            "run",
            "services",
            "update-traffic",
            "consent-protocol",
            "--project=hushh-pda-uat",
            "--region=us-central1",
            "--to-revisions=old-1=100",
            "--quiet",
        )
    else:
        assert "Unknown revision receives backend traffic" in report["rollback_error"]
        command.assert_not_called()
