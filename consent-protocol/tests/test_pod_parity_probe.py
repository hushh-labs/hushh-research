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
