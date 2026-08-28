"""The live parity probe's classify pipeline is sound, guarded in CI.

The probe's live capture needs a real pod and a session, but the pipeline it
feeds -- reduce both delivered contracts, classify in STRUCTURAL mode -- is pure
and must never regress, because a probe whose classifier is wrong would report
false parity on a broken pod (or false alarms on a working one) and teach the
team to ignore it. These pin exactly that pipeline.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from hushh_mcp.observability.parity_oracle import EquivalenceMode

_PROBE = Path(__file__).resolve().parents[1] / "scripts" / "ops" / "pod_parity_probe.py"
_spec = importlib.util.spec_from_file_location("pod_parity_probe", _PROBE)
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)  # type: ignore[union-attr]


def _matched_pair():
    pod_turn = {
        "text": "Running a full analysis on NVIDIA.",
        "grounded": True,
        "runtimeMode": "user_adc",
        "directiveCount": 1,
        "directives": [
            {
                "kind": "action",
                "payload": {"actionId": "analysis.start", "execution": "frontend"},
                "delegateAgentId": None,
            }
        ],
    }
    hub_frames = [
        {"event": "token", "data": {"text": "Let me analyze NVIDIA."}},
        {"event": "tool_start", "data": {"action_id": "analysis.start", "execution": "frontend"}},
    ]
    return pod_turn, hub_frames


def test_the_self_test_passes():
    """The whole offline pipeline check, the same one the operator runs first."""
    assert probe._self_test() == 0


def test_structural_mode_calls_a_matched_pair_at_parity():
    pod_turn, hub_frames = _matched_pair()
    diff = probe.classify_pair(
        pod_turn=pod_turn,
        hub_frames=hub_frames,
        hub_grounded=True,
        mode=EquivalenceMode.STRUCTURAL,
    )
    assert diff.at_parity


def test_a_live_pod_that_dropped_a_directive_is_not_parity():
    """The reason the probe exists: catch a pod that answered but failed to carry
    the action the hub carried."""
    _, hub_frames = _matched_pair()
    dropped = {"text": "ok", "grounded": True, "directiveCount": 1}  # count, no payload
    diff = probe.classify_pair(pod_turn=dropped, hub_frames=hub_frames, hub_grounded=True)
    assert not diff.at_parity


def test_a_silent_pod_is_not_parity_with_a_speaking_hub():
    _, hub_frames = _matched_pair()
    silent = {"text": "", "grounded": False}
    diff = probe.classify_pair(pod_turn=silent, hub_frames=hub_frames, hub_grounded=True)
    assert not diff.at_parity


def test_the_report_renders_without_error():
    pod_turn, hub_frames = _matched_pair()
    diff = probe.classify_pair(pod_turn=pod_turn, hub_frames=hub_frames, hub_grounded=True)
    text = probe.render_report(diff, prompt="analyze NVIDIA")
    assert "LIVE PARITY" in text
    assert "at parity" in text


# --------------------------------------------------------------------------- #
# The operator ID-token minter falls back across environments. The probe used to
# assume an env key and crash without one; these pin the fallback ORDER so a live
# capture works on an operator workstation (gcloud), not only where the key is set.
# --------------------------------------------------------------------------- #


def _boom(*_a, **_k):
    raise RuntimeError("source unavailable")


class _FakeProc:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout, self.returncode, self.stderr = stdout, returncode, stderr


def test_the_minter_falls_back_to_gcloud_when_no_key_and_no_attached_identity(monkeypatch):
    """The posture that broke the probe: no env key, and ADC is a user credential
    that cannot mint an audience-bound ID token -- so gcloud's active account is
    the only source, and the minter must reach it."""
    import subprocess

    import google.oauth2.id_token as idt

    monkeypatch.delenv("GCP_DEPLOY_SA_KEY_B64", raising=False)
    monkeypatch.setattr(idt, "fetch_id_token", _boom)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _FakeProc(stdout="TOKEN-FROM-GCLOUD\n"))

    assert probe.mint_pod_id_token("https://pod.example") == "TOKEN-FROM-GCLOUD"


def test_the_minter_moves_past_an_unusable_env_key_rather_than_crashing(monkeypatch):
    """A malformed env key must not abort the whole mint -- it is one source of
    three, and the crash it used to cause is exactly the bug being fixed."""
    import subprocess

    import google.oauth2.id_token as idt

    monkeypatch.setenv("GCP_DEPLOY_SA_KEY_B64", "not-valid-base64-or-json!!!")
    monkeypatch.setattr(idt, "fetch_id_token", _boom)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _FakeProc(stdout="TOKEN-FROM-GCLOUD"))

    assert probe.mint_pod_id_token("https://pod.example") == "TOKEN-FROM-GCLOUD"


def test_the_minter_raises_naming_every_source_when_all_fail(monkeypatch):
    """A failure that names only one source sends the operator looking in the
    wrong place; the error must name all three it tried."""
    import subprocess

    import google.oauth2.id_token as idt

    monkeypatch.delenv("GCP_DEPLOY_SA_KEY_B64", raising=False)
    monkeypatch.setattr(idt, "fetch_id_token", _boom)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _FakeProc(returncode=1, stderr="reauth"))

    with pytest.raises(RuntimeError) as excinfo:
        probe.mint_pod_id_token("https://pod.example")
    message = str(excinfo.value)
    assert "attached" in message
    assert "gcloud" in message
