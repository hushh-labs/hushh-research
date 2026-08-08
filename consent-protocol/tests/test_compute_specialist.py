# SPDX-FileCopyrightText: 2026 Hushh Labs
# SPDX-License-Identifier: Apache-2.0

"""The Compute specialist: registration, and the boundary it must not cross.

The specialist runs in the person's pod; their machine is elsewhere. Most of
these tests exist to keep it from answering as though it could see that machine.
"""

from __future__ import annotations

from hushh_mcp.adk_bridge.dispatch import is_wired_specialist
from hushh_mcp.agents.compute.tools import (
    describe_burst_capability,
    explain_placement_decision,
)
from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.one_adk.specialist_availability import (
    _SPECIALIST_LABELS,
    resolve_specialist_availability,
    specialist_label,
)

_MANIFEST = "hushh_mcp/agents/compute/agent.yaml"


# --------------------------------------------------------------------------
# Registration
# --------------------------------------------------------------------------


def test_manifest_declares_the_expected_agent():
    manifest = ManifestLoader.load(_MANIFEST)
    assert manifest.id == "agent_compute"
    assert manifest.parent == "agent_one"
    assert {t.name for t in manifest.tools} == {
        "describe_burst_capability",
        "explain_placement_decision",
    }


def test_manifest_tools_resolve_to_real_functions():
    """A py_func that does not import is a manifest that lies."""
    import importlib

    for tool in ManifestLoader.load(_MANIFEST).tools:
        module_path, _, attr = tool.py_func.rpartition(".")
        assert callable(getattr(importlib.import_module(module_path), attr))


def test_specialist_has_a_label():
    assert "agent_compute" in _SPECIALIST_LABELS
    assert specialist_label("agent_compute") == "Compute"


def test_specialist_is_in_the_one_roster():
    from hushh_mcp.one_adk.agent_tree import ask_compute_agent

    assert callable(ask_compute_agent)
    assert ask_compute_agent.__doc__


def test_specialist_reports_itself_unwired_until_the_device_channel_exists():
    """Honest by construction: registered, and not pretending to be callable.

    The device transport is not built, so dispatch has no handler. The
    availability layer must say so rather than letting One call into nothing.
    """
    assert is_wired_specialist("agent_compute") is False
    availability = resolve_specialist_availability(
        agent_id="agent_compute",
        user_id="u",
        consent_token="t",
        voice_context={},
    )
    assert availability.state == "unavailable"
    assert availability.reason_code == "specialist_unwired"


def test_specialist_requires_no_new_consent_scope():
    """It reads no records, so it must not widen the consent surface."""
    manifest = ManifestLoader.load(_MANIFEST)
    for scope in list(manifest.required_scopes) + [t.required_scope for t in manifest.tools]:
        assert scope.startswith("agent."), f"{scope} looks like a record scope"


# --------------------------------------------------------------------------
# The boundary: explain, never measure
# --------------------------------------------------------------------------


def test_capability_description_admits_it_cannot_measure():
    described = describe_burst_capability()
    cannot = " ".join(described["what_this_agent_cannot_do"]).lower()
    assert "measure" in cannot
    assert "decide" in cannot
    assert "your machine" in described["where_the_decision_happens"].lower()


def test_explains_a_cloud_decision_with_cost_and_teardown():
    result = explain_placement_decision(
        target="cloud",
        reason="Needs ~640GB memory; MacBook offers ~12GB usable.",
        workload="finetune-70b",
        accelerator="4x NVIDIA B200",
        estimated_cost_usd=126.0,
    )
    assert result["status"] == "explained"
    assert result["target"] == "cloud"
    assert result["estimated_cost_usd"] == 126.0
    assert "teardown" in result
    assert "not a quote" in result["cost_note"]
    assert result["decided_by"] == "the person's own device"


def test_explains_a_device_decision_without_inventing_cost():
    result = explain_placement_decision(target="device", reason="Fits with headroom.")
    assert result["target"] == "device"
    assert "estimated_cost_usd" not in result
    assert "teardown" not in result


def test_rejects_the_husshone_vocabulary_rather_than_guessing():
    """``puppy``/``gcp`` are the other repo's names. Silently mapping them would
    re-create the divergence the migration record exists to prevent."""
    for stale in ("puppy", "gcp"):
        assert explain_placement_decision(stale, "x")["status"] == "unknown_target"


def test_rejects_an_empty_or_nonsense_target():
    for bad in ("", "   ", "somewhere-else"):
        assert explain_placement_decision(bad, "x")["status"] == "unknown_target"


def test_target_matching_is_case_and_space_insensitive():
    assert explain_placement_decision("  CLOUD ", "x")["target"] == "cloud"
