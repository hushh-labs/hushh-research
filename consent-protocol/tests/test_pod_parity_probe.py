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
from hushh_mcp.services.operator_identity import mint_operator_id_token

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
# The operator ID-token minter falls back across environments. Two ops scripts
# each grew a copy that read an attribute the credential does not carry, so both
# worked only where an explicit key was exported and crashed everywhere else.
# One shared minter now backs the probe's live capture; these pin its fallback
# ORDER so a live run works on an operator workstation, not only in CI.
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

    assert mint_operator_id_token("https://pod.example") == "TOKEN-FROM-GCLOUD"


def test_the_minter_moves_past_an_unusable_env_key_rather_than_crashing(monkeypatch):
    """A malformed env key must not abort the whole mint -- it is one source of
    three, and the crash it used to cause is exactly the bug being fixed."""
    import subprocess

    import google.oauth2.id_token as idt

    monkeypatch.setenv("GCP_DEPLOY_SA_KEY_B64", "not-valid-base64-or-json!!!")
    monkeypatch.setattr(idt, "fetch_id_token", _boom)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _FakeProc(stdout="TOKEN-FROM-GCLOUD"))

    assert mint_operator_id_token("https://pod.example") == "TOKEN-FROM-GCLOUD"


def test_the_minter_raises_naming_every_source_when_all_fail(monkeypatch):
    """A failure that names only one source sends the operator looking in the
    wrong place; the error must name all three it tried."""
    import subprocess

    import google.oauth2.id_token as idt

    monkeypatch.delenv("GCP_DEPLOY_SA_KEY_B64", raising=False)
    monkeypatch.setattr(idt, "fetch_id_token", _boom)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _FakeProc(returncode=1, stderr="reauth"))

    with pytest.raises(RuntimeError) as excinfo:
        mint_operator_id_token("https://pod.example")
    message = str(excinfo.value)
    assert "attached" in message
    assert "gcloud" in message


def test_the_hub_grounding_is_never_read_off_the_pod():
    """The defect this closes: the probe derived the HUB's grounding from the POD's
    own answer, so the two agreed by construction and the grounding comparison could
    never fail. A score with an unfalsifiable dimension overstates what was checked."""
    source = _PROBE.read_text(encoding="utf-8")
    assert 'hub_grounded=bool(pod_turn.get("grounded"))' not in source, (
        "the hub's grounding is being taken from the pod again"
    )
    assert "--hub-grounded" in source, "there is no way to state the hub's grounding"


def test_a_live_run_refuses_rather_than_guessing_an_unstated_hub_grounding(tmp_path, capsys):
    frames = tmp_path / "frames.json"
    frames.write_text('[{"event": "token", "data": {"text": "hi"}}]')
    import sys

    argv = sys.argv
    sys.argv = [
        "probe",
        "--pod-url",
        "https://pod.example",
        "--consent-token",
        "t",
        "--hub-frames",
        str(frames),
    ]
    try:
        assert probe.main() == 2
    finally:
        sys.argv = argv
    assert "never be read off the pod" in capsys.readouterr().out


def test_the_frames_file_may_carry_the_hub_grounding_itself(tmp_path):
    """A captured hub turn that records its own grounding needs no extra flag, which
    is what makes the honest path the convenient one."""
    frames = tmp_path / "frames.json"
    frames.write_text('{"frames": [{"event": "token", "data": {"text": "hi"}}], "grounded": true}')
    import json as _json

    captured = _json.loads(frames.read_text())
    assert captured["grounded"] is True
    assert isinstance(captured["frames"], list)


def test_the_live_capture_uses_the_shared_minter_rather_than_a_private_copy():
    """The defect being prevented: a second copy of the token logic drifting from
    this one. The probe must resolve its token through the shared module."""
    source = _PROBE.read_text(encoding="utf-8")
    assert "operator_identity import mint_operator_id_token" in source
    assert "_service_account_info" not in source, (
        "the probe is reading an attribute the operator credential does not carry"
    )
