"""Bounded UAT recovery execution and processor receipt contracts."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _text_recovery_module():
    path = REPO_ROOT / "scripts/ops/run_uat_text_recovery_job.py"
    spec = importlib.util.spec_from_file_location("uat_text_recovery", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _text_recovery_service(sha: str):
    return {
        "status": {
            "latestReadyRevisionName": "serving",
            "traffic": [{"percent": 100, "revisionName": "serving"}],
        },
        "spec": {
            "template": {
                "metadata": {"annotations": {"run.googleapis.com/cloudsql-instances": "uat-sql"}},
                "spec": {
                    "serviceAccountName": "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com",
                    "containers": [
                        {
                            "image": "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "b" * 64,
                            "env": [
                                {"name": "ENVIRONMENT", "value": "uat"},
                                {"name": "HUSHH_DEPLOY_SHA", "value": sha},
                            ],
                        }
                    ],
                },
            }
        },
    }


def _recovery_harness(monkeypatch, tmp_path, elapsed_seconds, receipt_valid):
    module = _text_recovery_module()
    sha = "a" * 40
    source = tmp_path / "service.json"
    source.write_text(json.dumps(_text_recovery_service(sha)))
    evidence = tmp_path / "proof.json"
    generation = "reviewed-policy-generation"
    counts = dict(
        inspected=0, migrated=0, resumed=0, out_of_scope=0, already_current=0, legacy=0, refused=0
    )
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        assert kwargs["check"] is True
        if command[1:4] == ["run", "jobs", "replace"]:
            task = json.loads(Path(command[4]).read_text())["spec"]["template"]["spec"]["template"][
                "spec"
            ]
            assert task["timeoutSeconds"] == "120" and task["maxRetries"] == 0
            assert task["containers"][0]["args"] == [
                "scripts/recover_uat_text_requests.py",
                "--apply",
                "--limit=20",
            ]
            result = {}
        elif command[1:4] == ["run", "jobs", "execute"]:
            assert "--wait" in command
            assert 0 < kwargs["timeout"] <= 900
            if kwargs["timeout"] < elapsed_seconds:
                raise subprocess.TimeoutExpired(command, kwargs["timeout"])
            result = {"metadata": {"name": "text-policy-recovery-123-execution"}}
        elif command[1:3] == ["logging", "read"]:
            result = [
                {
                    "jsonPayload": {
                        "uat_processor_recovery": "completed",
                        "mode": "apply",
                        "policy_generation": generation if receipt_valid else "other-generation",
                        "limit": 20,
                        "scan_limit": 200,
                        "counts": counts,
                    }
                }
            ]
        else:
            result = {}
        return subprocess.CompletedProcess(command, 0, json.dumps(result), "")

    monkeypatch.setattr(
        sys, "argv", ["recovery", "--service-json", str(source), "--sha", sha, "--run-id", "123"]
    )
    monkeypatch.setattr(module.subprocess, "run", run)
    monkeypatch.setattr(module.time, "sleep", lambda _: None)
    monkeypatch.setattr(module, "expected_policy_generation", lambda _: generation)
    monkeypatch.setattr(
        module,
        "Path",
        lambda value: (
            evidence
            if str(value) == "/tmp/uat-text-recovery-proof.json"  # noqa: S108 -- match the production path; redirect writes into pytest's isolated directory.
            else Path(value)
        ),
    )
    return module, sha, evidence, calls, counts


@pytest.mark.parametrize("elapsed_seconds,receipt_valid", [(210, True), (210, False), (1000, True)])
def test_text_recovery_wait_includes_cold_start_without_reexecuting(
    monkeypatch, tmp_path, capsys, elapsed_seconds, receipt_valid
):
    module, sha, evidence, calls, counts = _recovery_harness(
        monkeypatch, tmp_path, elapsed_seconds, receipt_valid
    )
    if elapsed_seconds == 210 and receipt_valid:
        module.main()
        proof = json.loads(evidence.read_text())
        assert proof["uat_processor_recovery_job"] == "completed"
        assert proof["sha"] == sha and proof["receipts"][0]["counts"] == counts
        assert any(command[1:3] == ["logging", "read"] for command in calls)
    elif elapsed_seconds == 210:
        with pytest.raises(ValueError, match="receipt is not yet available"):
            module.main()
        assert not evidence.exists()
        assert sum(command[1:3] == ["logging", "read"] for command in calls) == 6
    else:
        with pytest.raises(subprocess.TimeoutExpired):
            module.main()
        assert not evidence.exists()
        assert not any(command[1:3] == ["logging", "read"] for command in calls)
        assert json.loads(capsys.readouterr().out) == {
            "uat_processor_recovery_job": "wait_timed_out",
            "job": "text-policy-recovery-123",
            "sha": sha,
            "outcome": "unverified",
        }
    assert sum(command[1:4] == ["run", "jobs", "execute"] for command in calls) == 1
    assert calls[-1][1:5] == ["run", "jobs", "delete", "text-policy-recovery-123"]


def test_text_recovery_generation_matches_the_selected_runtime_processor(monkeypatch):
    module = _text_recovery_module()
    # Derive the expectation from the actual producer, not a second test formula.
    from hushh_mcp.runtime_providers.managed_text import managed_text_policy

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    generations = []
    for provider in ("azure_openai", "vertex"):
        monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", provider)
        monkeypatch.setenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", provider)
        job = {
            "spec": {
                "template": {
                    "spec": {
                        "template": {
                            "spec": {
                                "containers": [
                                    {
                                        "env": [
                                            {
                                                "name": "HUSHH_UAT_MANAGED_AI_PROVIDER",
                                                "value": provider,
                                            },
                                            {
                                                "name": "HUSHH_UAT_MANAGED_TEXT_PROVIDER",
                                                "value": provider,
                                            },
                                        ]
                                    }
                                ]
                            }
                        }
                    }
                }
            }
        }
        actual = module.expected_policy_generation(job)
        assert actual == managed_text_policy()["generation"]
        generations.append(actual)
        job["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]["env"][1]["value"] = (
            "invalid"
        )
        with pytest.raises(ValueError, match="bindings disagree"):
            module.expected_policy_generation(job)
    assert generations[0] != generations[1]
