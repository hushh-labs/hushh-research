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
                "consent-protocol/hushh_mcp/one_adk/agui_turn_timing.py",
                "consent-protocol/hushh_mcp/runtime_providers/factory.py",
                "consent-protocol/hushh_mcp/services/information_chat_service.py",
                "consent-protocol/hushh_mcp/services/location_chat_service.py",
                ".github/workflows/deploy-uat-one-chat.yml",
            ]
        ),
    )
    assert len(module.release_paths("a" * 40, "b" * 40)) == 6
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


def test_service_only_preflight_rejects_packaged_agent_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = load_release_script()
    monkeypatch.setattr(module, "command", Mock())
    monkeypatch.setattr(
        module,
        "output",
        lambda *_args: "\n".join(
            [
                "consent-protocol/api/routes/one/agent_chat.py",
                "consent-protocol/hushh_mcp/agents/pkm_memory_kernel.v3.md",
            ]
        ),
    )
    with pytest.raises(RuntimeError, match="pkm_memory_kernel.v3.md"):
        module.release_paths("a" * 40, "b" * 40)


def test_service_only_preflight_accepts_only_pinned_location_baseline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = load_release_script()
    monkeypatch.setattr(module, "command", Mock())
    target_sha = "b" * 40
    paths = [
        "consent-protocol/api/routes/one/agent_chat.py",
        *module.KNOWN_LOCATION_BLOBS,
    ]
    drifted = None

    def git_output(*args: str) -> str:
        if args[1] == "diff":
            return "\n".join(paths)
        path = args[2].split(":", 1)[1]
        if path == drifted:
            return "0" * 40
        return module.KNOWN_LOCATION_BLOBS[path]

    monkeypatch.setattr(module, "output", git_output)
    assert module.release_paths("a" * 40, target_sha) == paths
    drifted = paths[-1]
    with pytest.raises(RuntimeError, match="one_location_sms_readiness.py"):
        module.release_paths("a" * 40, target_sha)


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


@pytest.mark.parametrize(
    ("key", "drifted"),
    [
        ("HUSSH_GEMINI_TEXT_MODEL", "gemini-3.7-flash"),
        ("ENVIRONMENT", "production"),
    ],
)
def test_candidate_rejects_readiness_probe_runtime_drift(
    monkeypatch: pytest.MonkeyPatch, key: str, drifted: str
) -> None:
    module = load_release_script()
    image = "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "c" * 64
    tag = "one-chat-123-1"
    service = {
        "status": {
            "latestReadyRevisionName": "consent-protocol-new",
            "traffic": [
                {"revisionName": "consent-protocol-old", "percent": 100},
                {
                    "revisionName": "consent-protocol-new",
                    "percent": 0,
                    "tag": tag,
                    "url": "https://tag.example",
                },
            ],
        }
    }
    env = {**module.PROBE_RUNTIME_ENV, key: drifted}
    revision = {
        "spec": {
            "serviceAccountName": module.RUNTIME_SA,
            "containers": [
                {
                    "image": image,
                    "env": [{"name": name, "value": value} for name, value in env.items()],
                }
            ],
        }
    }
    command = Mock()
    monkeypatch.setattr(module, "service_state", lambda: service)
    monkeypatch.setattr(module, "revision_state", lambda _revision: revision)
    monkeypatch.setattr(module, "command", command)
    with pytest.raises(RuntimeError, match="differs from readiness probe"):
        module.deploy_candidate(image, "a" * 40, "123", "1", "consent-protocol-old")
    command.assert_called_once()


def test_readiness_probe_job_has_cold_start_headroom(monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_release_script()
    command = Mock(side_effect=RuntimeError("stop after job deploy"))
    monkeypatch.setattr(module, "command", command)
    image = "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "c" * 64
    with pytest.raises(RuntimeError, match="stop after job deploy"):
        module.probe_runtime(image, "123", "1")
    deploy = command.call_args.args
    assert deploy[:4] == ("gcloud", "run", "jobs", "deploy")
    for flag in ("--cpu=2", "--memory=2Gi", "--task-timeout=300s"):
        assert flag in deploy


def test_service_only_workflow_keeps_main_gate_and_full_uat_baseline() -> None:
    workflow = (ROOT / ".github/workflows/deploy-uat-one-chat.yml").read_text()
    selector = (ROOT / "hushh-webapp/scripts/ci/select-uat-target.mjs").read_text()
    assert "group: deploy-uat" in workflow
    assert "environment: uat" in workflow
    assert "require-deploy-sha-on-main.sh" in workflow
    assert "Main Post-Merge Smoke Gate" in workflow
    assert 'capacity-main/scripts/ci/runtime-capacity-budget.py" --environment uat' in workflow
    assert "uat_one_chat_backend_release.py" in workflow
    assert "steps.deploy-backend.outcome != 'success'" in workflow
    assert "--recover-interrupted" in workflow
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


def test_promotion_receipt_is_saved_before_traffic_moves(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    module = load_release_script()
    target_sha = "a" * 40
    old = "consent-protocol-old"
    candidate = "consent-protocol-new"
    monkeypatch.setenv("TARGET_SHA", target_sha)
    monkeypatch.setenv("GITHUB_RUN_ID", "123")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    monkeypatch.setattr(module, "preflight", lambda _sha: (old, "b" * 40))
    monkeypatch.setattr(module, "build_image", lambda *_args: "image@sha256:" + "c" * 64)
    monkeypatch.setattr(
        module, "deploy_candidate", lambda *_args: (candidate, "https://tag.example")
    )
    monkeypatch.setattr(module, "probe_runtime", lambda *_args: {"one_chat_probe_ok": True})

    def check_receipt_before_promotion(*_args: object) -> None:
        receipt = json.loads((tmp_path / "uat-one-chat-promotion.json").read_text())
        assert receipt["status"] == "prepared"
        assert receipt["old_revision"] == old
        assert receipt["candidate_revision"] == candidate
        assert receipt["target_sha"] == target_sha

    monkeypatch.setattr(module, "promote", check_receipt_before_promotion)
    monkeypatch.setattr(module, "remove_candidate_tag", lambda _tag: True)
    monkeypatch.setattr(module, "live_traffic", lambda: {candidate: 100})
    assert module.main() == 0


@pytest.mark.parametrize(
    ("serving", "expected_status", "mutates"),
    [
        ("consent-protocol-new", "rolled_back", True),
        ("consent-protocol-old", "already_on_previous_revision", False),
    ],
)
def test_interrupted_promotion_recovers_only_known_traffic(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    serving: str,
    expected_status: str,
    mutates: bool,
) -> None:
    module = load_release_script()
    old = "consent-protocol-old"
    candidate = "consent-protocol-new"
    target_sha = "a" * 40
    module.write_promotion_receipt(tmp_path, target_sha, "123", "1", old, candidate)
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    monkeypatch.setenv("TARGET_SHA", target_sha)
    monkeypatch.setenv("GITHUB_RUN_ID", "123")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    traffic = {"current": {serving: 100}}
    monkeypatch.setattr(module, "live_traffic", lambda: traffic["current"])
    monkeypatch.setattr(
        module,
        "revision_state",
        lambda _revision: {
            "metadata": {
                "labels": {
                    "serving.knative.dev/service": module.SERVICE,
                    "account-deletion-contract": "v201",
                    "deploy-source": module.SOURCE,
                    "deploy-sha": target_sha,
                    "github-run-id": "123",
                }
            }
        },
    )
    monkeypatch.setattr(
        module,
        "service_state",
        lambda: {"status": {"traffic": [{"revisionName": candidate, "tag": "one-chat-123-1"}]}},
    )
    monkeypatch.setattr(module, "remove_candidate_tag", lambda _tag: True)

    def move_traffic(*_args: str) -> None:
        traffic["current"] = {old: 100}

    command = Mock(side_effect=move_traffic)
    monkeypatch.setattr(module, "command", command)
    assert module.recover_interrupted() == 0
    assert (command.call_count == 1) is mutates
    if mutates:
        assert f"--to-revisions={old}=100" in command.call_args.args
    report = json.loads((tmp_path / "uat-one-chat-recovery.json").read_text())
    assert report["status"] == expected_status
    assert report["traffic_after"] == {old: 100}


def test_interrupted_promotion_refuses_unknown_traffic(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    module = load_release_script()
    module.write_promotion_receipt(
        tmp_path, "a" * 40, "123", "1", "consent-protocol-old", "consent-protocol-new"
    )
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    monkeypatch.setenv("TARGET_SHA", "a" * 40)
    monkeypatch.setenv("GITHUB_RUN_ID", "123")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    monkeypatch.setattr(module, "live_traffic", lambda: {"consent-protocol-unknown": 100})
    command = Mock()
    monkeypatch.setattr(module, "command", command)
    assert module.recover_interrupted() == 1
    command.assert_not_called()
    report = json.loads((tmp_path / "uat-one-chat-recovery.json").read_text())
    assert report["status"] == "blocked"
    assert "Unknown or split backend traffic" in report["error"]


def test_preflight_requires_canonical_fleet_before_build_or_mutation(monkeypatch):
    module = load_release_script()
    target_sha = "b" * 40
    env = {**module.PROBE_RUNTIME_ENV, "HUSHH_DEPLOY_ENV": "uat"}
    revision = {
        "metadata": {"labels": {"deploy-sha": "a" * 40, "account-deletion-contract": "v201"}},
        "spec": {"serviceAccountName": module.RUNTIME_SA, "containers": [{"env": []}]},
    }
    service = {"spec": {"template": {"spec": {"serviceAccountName": module.RUNTIME_SA}}}}
    command = Mock()
    release_paths = Mock()
    monkeypatch.setattr(module, "command", command)
    monkeypatch.setattr(module, "output", lambda *_args: target_sha)
    monkeypatch.setattr(module, "service_state", lambda: service)
    monkeypatch.setattr(module, "serving_revision", lambda _service: "old")
    monkeypatch.setattr(module, "revision_state", lambda _name: revision)
    monkeypatch.setattr(module, "release_paths", release_paths)
    with pytest.raises(RuntimeError, match="run the full UAT workflow first"):
        module.preflight(target_sha)
    command.assert_not_called()
    release_paths.assert_not_called()
    revision["spec"]["containers"][0]["env"] = [
        {"name": key, "value": value} for key, value in env.items()
    ]
    assert module.preflight(target_sha) == ("old", "a" * 40)
    release_paths.assert_called_once_with("a" * 40, target_sha)
