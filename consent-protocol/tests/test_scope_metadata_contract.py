"""Regression tests for scope metadata contract.

Ensures get_scope_display_metadata returns rich metadata only for scopes
that actually exist as ConsentScope enum members, preventing the drift
that left agent.kai.execute metadata behind after the enum dropped it.
"""

from __future__ import annotations

from hushh_mcp.consent.scope_helpers import get_scope_display_metadata
from hushh_mcp.constants import ConsentScope

# Static scope keys that should return rich metadata from scope_helpers.
# Must match the _STATIC_SCOPE_META dict keys inside get_scope_display_metadata.
KNOWN_STATIC_SCOPES = {
    "vault.owner",
    "pkm.read",
    "pkm.write",
    "agent.kai.analyze",
}


def _consent_scope_values() -> set[str]:
    return {s.value for s in ConsentScope}


# ---------------------------------------------------------------------------
# Every static scope key maps to a real ConsentScope value
# ---------------------------------------------------------------------------


def test_every_known_static_scope_is_a_real_consent_scope() -> None:
    enum_values = _consent_scope_values()
    for scope in KNOWN_STATIC_SCOPES:
        assert scope in enum_values, (
            f"Static metadata references {scope!r} but no ConsentScope has that value. "
            "This is the drift pattern that left agent.kai.execute behind."
        )


# ---------------------------------------------------------------------------
# Each known static scope returns rich metadata (non-default values)
# ---------------------------------------------------------------------------


def test_vault_owner_returns_rich_metadata() -> None:
    meta = get_scope_display_metadata("vault.owner")
    assert meta["label"] == "Full Vault Access"
    assert meta["icon_name"] == "shield"
    assert meta["color_hex"] == "#D4AF37"


def test_pkm_read_returns_rich_metadata() -> None:
    meta = get_scope_display_metadata("pkm.read")
    assert meta["label"] == "Read All Personal Data"
    assert meta["icon_name"] == "book-open"
    assert meta["color_hex"] == "#3B82F6"


def test_pkm_write_returns_rich_metadata() -> None:
    meta = get_scope_display_metadata("pkm.write")
    assert meta["label"] == "Write Personal Data"
    assert meta["icon_name"] == "pencil"
    assert meta["color_hex"] == "#3B82F6"


def test_agent_kai_analyze_returns_rich_metadata() -> None:
    meta = get_scope_display_metadata("agent.kai.analyze")
    assert meta["label"] == "Kai Analysis"
    assert meta["icon_name"] == "brain"
    assert meta["color_hex"] == "#D4AF37"


# ---------------------------------------------------------------------------
# Orphan protection: removed scope falls through to generic default
# ---------------------------------------------------------------------------


def test_removed_agent_kai_execute_falls_through_to_default() -> None:
    # agent.kai.execute is not a real ConsentScope and must not expose
    # rich metadata. It should fall through to the generic formatter.
    assert "agent.kai.execute" not in _consent_scope_values()
    meta = get_scope_display_metadata("agent.kai.execute")
    assert meta["label"] == "Agent Kai Execute"  # generic title-cased
    assert meta["description"] == "Access: agent.kai.execute"
    assert meta["icon_name"] is None
    assert meta["color_hex"] is None


def test_unknown_scope_falls_through_to_default() -> None:
    meta = get_scope_display_metadata("unknown.custom.scope")
    assert meta["icon_name"] is None
    assert meta["color_hex"] is None
    assert "unknown.custom.scope" in meta["description"]


# ---------------------------------------------------------------------------
# Shape contract: every metadata result has the same four fields
# ---------------------------------------------------------------------------


def test_metadata_shape_consistent_across_known_and_unknown() -> None:
    required_keys = {"label", "description", "icon_name", "color_hex"}
    for scope in [*KNOWN_STATIC_SCOPES, "agent.kai.execute", "unknown.scope"]:
        meta = get_scope_display_metadata(scope)
        assert set(meta.keys()) >= required_keys, (
            f"{scope} missing fields: {required_keys - set(meta.keys())}"
        )
