"""The owner-direct acceptance producer: its dry run proves the sequence, its live mode refuses.

The receipt the ledger judges must be a deployed one; the dry run here writes a
``local`` receipt on purpose so nothing can mistake it for that. What the dry run
DOES prove is that the sequence holds end to end over the real code with faked
dependencies, and that a run whose assertions fail produces a failing receipt.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "ops"))

import owner_direct_acceptance as acceptance  # noqa: E402

SCRIPT = Path(acceptance.__file__)


async def test_the_dry_run_holds_every_assertion_and_writes_a_local_receipt(tmp_path):
    run = await acceptance.run_dry_run(tmp_path)
    receipt = acceptance.build_receipt(run, mode="local", environment="dry-run")

    observations = receipt["observations"]
    assert observations["hub_calls"] == 0
    assert observations["provider_puppy"] is True
    assert observations["runtime_mode_puppy_relay"] is True
    assert observations["revoked_device_refused"] is True
    assert observations["old_incarnation_publications"] == 0
    assert observations["wall_refused_pod_info_without_identity"] is True
    assert observations["fenced_incarnation_admits_nobody"] is True
    assert observations["credential_is_session_marker"] is True
    assert observations["endpoint_version_monotonic"] is True
    assert receipt["result"] == "pass" and receipt["exit_code"] == 0
    assert receipt["assertion_id"] == "owner-direct-inference-without-hub"
    assert receipt["target"] == {"mode": "local", "environment": "dry-run"}
    assert set(receipt["source_sha256"]) == set(acceptance.SOURCE_PATHS)


def test_the_receipt_carries_no_secret_material(tmp_path):
    import asyncio

    run = asyncio.run(acceptance.run_dry_run(tmp_path))
    text = json.dumps(acceptance.build_receipt(run, mode="local", environment="dry-run"))
    for forbidden in ("pst1.", "HCT:", "BEGIN", "private", "nonce", "proof", "signature"):
        assert forbidden not in text, forbidden


def test_a_failing_observation_is_a_failing_receipt():
    run = {
        "observations": {
            "hub_calls": 1,
            "provider_puppy": True,
            "runtime_mode_puppy_relay": True,
            "revoked_device_refused": True,
            "old_incarnation_publications": 0,
            "wall_refused_pod_info_without_identity": True,
        },
        "commands": [],
    }
    receipt = acceptance.build_receipt(run, mode="local", environment="dry-run")
    assert receipt["result"] == "fail" and receipt["exit_code"] == 1


@pytest.mark.parametrize(
    "argv",
    [
        ["--live"],
        ["--live", "--i-understand-dev-only"],
        ["--live", "--i-understand-dev-only", "--allow-public-pod", "--pod-url", "https://p"],
        ["--live", "--i-understand-dev-only", "--allow-public-pod", "--environment", "dev"],
    ],
)
def test_live_refuses_without_every_explicit_flag(argv, capsys):
    assert acceptance.main(argv) == 2
    assert "refusing live acceptance" in capsys.readouterr().err


def test_live_with_every_flag_still_stops_because_the_live_leg_is_not_wired(capsys):
    code = acceptance.main(
        [
            "--live",
            "--i-understand-dev-only",
            "--allow-public-pod",
            "--pod-url",
            "https://one-pod-x.a.run.app",
            "--environment",
            "dev",
        ]
    )
    assert code == 2
    assert "not wired" in capsys.readouterr().err


def test_no_mode_is_a_usage_error(capsys):
    assert acceptance.main([]) == 2


def test_the_script_runs_as_a_process_in_dry_run_mode(tmp_path):
    out = tmp_path / "receipt.json"
    env = os.environ.copy()
    # Exercise the same clean-process path used by the operational command. The producer must
    # install its synthetic settings before importing runtime modules; a developer's local .env
    # must not be required for this receipt.
    for name in (
        "APP_SIGNING_KEY",
        "CONSENT_ED25519_KID",
        "CONSENT_ED25519_PRIVATE_KEY",
        "CONSENT_ED25519_PUBLIC_KEYS",
        "GENAI_GOOGLE_CLOUD_PROJECT",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "HUSHH_DEPLOY_ENV",
        "HUSHH_GENAI_AUTH_MODE",
        "HUSSH_HUB_BASE_URL",
        "HUSSH_ID",
        "HUSSH_POD_MODE",
        "HUSSH_POD_TURN_ENABLED",
    ):
        env.pop(name, None)
    completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
        [sys.executable, str(SCRIPT), "--dry-run", "--out", str(out)],
        cwd=SCRIPT.parents[2],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert completed.returncode == 0, completed.stderr[-2000:]
    receipt = json.loads(out.read_text())
    assert receipt["result"] == "pass" and receipt["target"]["mode"] == "local"
