from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/ci/uat_one_chat_backend_release.py"
ROOT = SCRIPT.parents[2]


def load_release_script():
    spec = importlib.util.spec_from_file_location("uat_one_chat_release", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_service_only_preflight_accepts_only_the_cutover_delta(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = load_release_script()
    command = Mock()
    monkeypatch.setattr(module, "command", command)
    monkeypatch.setattr(
        module,
        "output",
        lambda *_args: "\n".join(
            [
                "consent-protocol/api/routes/one/agent_chat.py",
                "consent-protocol/hushh_mcp/runtime_providers/factory.py",
                ".github/workflows/deploy-uat-one-chat.yml",
            ]
        ),
    )
    assert len(module.release_paths("a" * 40, "b" * 40)) == 3
    command.assert_called_once_with("git", "merge-base", "--is-ancestor", "a" * 40, "b" * 40)

    monkeypatch.setattr(
        module,
        "output",
        lambda *_args: "\n".join(
            [
                "consent-protocol/api/routes/one/agent_chat.py",
                "consent-protocol/migrations/versions/999_test.py",
            ]
        ),
    )
    with pytest.raises(RuntimeError, match="refuses changed paths"):
        module.release_paths("a" * 40, "b" * 40)

    monkeypatch.setattr(
        module,
        "output",
        lambda *_args: "\n".join(
            [
                "consent-protocol/api/routes/one/agent_chat.py",
                "hushh-webapp/app/one/location/page.tsx",
                "docs/reference/architecture/api-contracts.md",
            ]
        ),
    )
    assert len(module.release_paths("a" * 40, "b" * 40)) == 3


def test_candidate_must_be_zero_traffic_and_have_its_own_tag() -> None:
    module = load_release_script()
    service = {
        "status": {
            "latestReadyRevisionName": "new",
            "traffic": [
                {"revisionName": "old", "percent": 100},
                {
                    "revisionName": "new",
                    "percent": 0,
                    "tag": "one-chat-123",
                    "url": "https://tag.example",
                },
            ],
        }
    }
    assert module.candidate_from_service(service, "old", "one-chat-123") == (
        "new",
        "https://tag.example",
    )
    service["status"]["traffic"][0]["percent"] = 90
    with pytest.raises(RuntimeError, match="changed backend traffic"):
        module.candidate_from_service(service, "old", "one-chat-123")


def test_service_only_workflow_keeps_main_gate_and_full_uat_baseline() -> None:
    workflow = (ROOT / ".github/workflows/deploy-uat-one-chat.yml").read_text()
    selector = (ROOT / "hushh-webapp/scripts/ci/select-uat-target.mjs").read_text()
    assert "group: deploy-uat" in workflow
    assert "environment: uat" in workflow
    assert "require-deploy-sha-on-main.sh" in workflow
    assert "Main Post-Merge Smoke Gate" in workflow
    assert "uat_one_chat_backend_release.py" in workflow
    assert 'String(run?.path || "").split("@", 1)[0]' in selector
    assert "workflowFile(run) === CHAT_ONLY_WORKFLOW" in selector


def test_candidate_tag_cleanup_preserves_primary_traffic(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_release_script()
    states = iter(
        [
            {
                "status": {
                    "traffic": [{"revisionName": "new", "percent": 100, "tag": "one-chat-1-1"}]
                }
            },
            {"status": {"traffic": [{"revisionName": "new", "percent": 100}]}},
        ]
    )
    command = Mock()
    monkeypatch.setattr(module, "service_state", lambda: next(states))
    monkeypatch.setattr(module, "live_traffic", lambda: {"new": 100})
    monkeypatch.setattr(module, "command", command)
    assert module.remove_candidate_tag("one-chat-1-1") is True
    assert "--remove-tags=one-chat-1-1" in command.call_args.args


def test_promotion_uses_live_verifier_without_candidate_only_image_flag(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    module = load_release_script()
    revisions = iter(["old", "new"])
    command = Mock()
    monkeypatch.setattr(module, "service_state", lambda: {})
    monkeypatch.setattr(module, "serving_revision", lambda _service: next(revisions))
    monkeypatch.setattr(module, "command", command)
    module.promote("new", "old", "a" * 40, "123", tmp_path)
    verifier_args = command.call_args.args
    assert "verify-cloudrun-revision-provenance.py" in verifier_args[1]
    assert "--expected-image-reference" not in verifier_args
    assert "--candidate-revision" not in verifier_args


def test_final_traffic_is_required_for_success(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    module = load_release_script()
    monkeypatch.setenv("TARGET_SHA", "a" * 40)
    monkeypatch.setenv("GITHUB_RUN_ID", "123")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    monkeypatch.setattr(module, "preflight", lambda _sha: ("old", "b" * 40))
    monkeypatch.setattr(module, "build_image", lambda *_args: "image@sha256:" + "c" * 64)
    monkeypatch.setattr(module, "deploy_candidate", lambda *_args: ("new", "https://tag.example"))
    monkeypatch.setattr(module, "probe_runtime", lambda *_args: {"one_chat_probe_ok": True})
    monkeypatch.setattr(module, "promote", lambda *_args: None)
    monkeypatch.setattr(module, "remove_candidate_tag", lambda _tag: True)
    monkeypatch.setattr(module, "live_traffic", lambda: {})
    monkeypatch.setattr(module, "service_state", lambda: {"status": {"traffic": []}})
    assert module.main() == 1
    receipt = json.loads((tmp_path / "uat-one-chat-release.json").read_text())
    assert receipt["status"] != "success"
