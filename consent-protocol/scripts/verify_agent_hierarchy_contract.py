#!/usr/bin/env python3
"""Verify the One agent hierarchy doc against backend agent wiring.

Also enforces the tile->agent binding contract: every dashboard tile in
hushh-webapp/lib/onboarding/one-capabilities.ts declares an agentId that
must exist in SPECIALIST_A2A_SCOPE_MAP (or be an explicit null), and the
delegate_to_agent MCP tool enum must stay a subset of the scope map.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CONSENT_ROOT = REPO_ROOT / "consent-protocol"
sys.path.insert(0, str(CONSENT_ROOT))

DOC_PATH = REPO_ROOT / "docs/reference/one/one-agent-hierarchy.md"
DISPATCH_INIT_PATH = REPO_ROOT / "consent-protocol/hushh_mcp/adk_bridge/__init__.py"
KAI_A2A_PATH = REPO_ROOT / "consent-protocol/hushh_mcp/adk_bridge/kai_agent.py"
CAPABILITIES_PATH = REPO_ROOT / "hushh-webapp/lib/onboarding/one-capabilities.ts"
TOOL_DEFINITIONS_PATH = REPO_ROOT / "consent-protocol/mcp_modules/tools/definitions.py"
REQUIRED_RUNTIME_IDS = {
    "agent_one",
    "agent_orchestrator",
    "agent_kai",
    "agent_nav",
    "agent_kyc",
    "agent_location",
    "agent_connected_systems",
    "agent_email",
    "agent_personal_information",
}
REQUIRED_MEMORY_IDS = {
    "memory_intent",
    "memory_segmentation",
    "memory_merge",
    "pkm_structure",
    "summary_reducer",
}


def _registered_dispatch_agents() -> set[str]:
    text = DISPATCH_INIT_PATH.read_text(encoding="utf-8")
    return set(re.findall(r"register_specialist\(\s*\"([^\"]+)\"", text))


def _specialist_a2a_scope_map() -> dict[str, object]:
    from hushh_mcp.adk_bridge.delegation import SPECIALIST_A2A_SCOPE_MAP

    return SPECIALIST_A2A_SCOPE_MAP


def _tile_agent_bindings() -> dict[str, str | None]:
    """Parse tile id -> agentId bindings from the capability catalog."""
    text = CAPABILITIES_PATH.read_text(encoding="utf-8")
    bindings: dict[str, str | None] = {}
    # Each tile entry declares id then agentId (order enforced by review + this
    # parser failing when agentId is missing between two ids).
    entry_pattern = re.compile(r"id:\s*\"([^\"]+)\",.*?agentId:\s*(null|\"[^\"]+\")", re.DOTALL)
    for match in entry_pattern.finditer(text):
        tile_id, raw_agent = match.group(1), match.group(2)
        bindings[tile_id] = None if raw_agent == "null" else raw_agent.strip('"')
    return bindings


def _delegate_enum_agents() -> set[str]:
    """Extract the delegate_to_agent to_agent enum from tool definitions."""
    text = TOOL_DEFINITIONS_PATH.read_text(encoding="utf-8")
    match = re.search(r"\"to_agent\":\s*\{.*?\"enum\":\s*\[(.*?)\]", text, re.DOTALL)
    if not match:
        return set()
    return set(re.findall(r"\"([^\"]+)\"", match.group(1)))


def _fail(message: str) -> int:
    print(f"ERROR: {message}", file=sys.stderr)
    return 1


def main() -> int:
    if not DOC_PATH.exists():
        return _fail(f"missing hierarchy doc: {DOC_PATH}")
    doc = DOC_PATH.read_text(encoding="utf-8")
    errors: list[str] = []

    for agent_id in sorted(REQUIRED_RUNTIME_IDS | REQUIRED_MEMORY_IDS):
        if f"`{agent_id}`" not in doc:
            errors.append(f"{DOC_PATH}: missing runtime id `{agent_id}`")

    scope_map = _specialist_a2a_scope_map()
    for agent_id, scope in sorted(scope_map.items()):
        if f"`{agent_id}`" not in doc:
            errors.append(f"{DOC_PATH}: missing scoped A2A id `{agent_id}`")
        if f"`{scope.value}`" not in doc:
            errors.append(f"{DOC_PATH}: missing scope `{scope.value}` for `{agent_id}`")

    registered_agents = _registered_dispatch_agents()
    for agent_id in sorted(registered_agents):
        if f"`{agent_id}`" not in doc:
            errors.append(f"{DOC_PATH}: missing in-process dispatch agent `{agent_id}`")

    required_markers = [
        "## Wiring Modes",
        "Scope-gated A2A specialists",
        "In-process dispatch registry",
        "Kai has a dedicated A2A server",
        "KYC is manifest/service-backed",
        "not every scope-gated specialist is registered in the in-process dispatch table",
    ]
    for marker in required_markers:
        if marker not in doc:
            errors.append(f"{DOC_PATH}: missing marker `{marker}`")

    if not KAI_A2A_PATH.exists():
        errors.append(f"missing Kai A2A server file: {KAI_A2A_PATH}")

    # Tile -> agent binding contract (dashboard tiles ARE agents).
    if not CAPABILITIES_PATH.exists():
        errors.append(f"missing capability catalog: {CAPABILITIES_PATH}")
    else:
        bindings = _tile_agent_bindings()
        if not bindings:
            errors.append(f"{CAPABILITIES_PATH}: no tile agentId bindings parsed")
        catalog_text = CAPABILITIES_PATH.read_text(encoding="utf-8")
        tile_ids = re.findall(r"^\s{4}id:\s*\"([^\"]+)\"", catalog_text, re.MULTILINE)
        for tile_id in tile_ids:
            if tile_id not in bindings:
                errors.append(
                    f"{CAPABILITIES_PATH}: tile `{tile_id}` missing an explicit "
                    "agentId binding (use null for agent-less surfaces)"
                )
        for tile_id, agent_id in sorted(bindings.items()):
            if agent_id is not None and agent_id not in scope_map:
                errors.append(
                    f"{CAPABILITIES_PATH}: tile `{tile_id}` binds unknown agent "
                    f"`{agent_id}` (not in SPECIALIST_A2A_SCOPE_MAP)"
                )

    # delegate_to_agent enum must stay a subset of the scope map.
    enum_agents = _delegate_enum_agents()
    if not enum_agents:
        errors.append(f"{TOOL_DEFINITIONS_PATH}: delegate_to_agent to_agent enum not found")
    for agent_id in sorted(enum_agents):
        if agent_id not in scope_map:
            errors.append(
                f"{TOOL_DEFINITIONS_PATH}: delegate_to_agent enum entry `{agent_id}` "
                "is not in SPECIALIST_A2A_SCOPE_MAP"
            )

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print("Agent hierarchy contract verified.")
    print(f"Scope-gated A2A specialists: {', '.join(sorted(scope_map))}")
    print(f"In-process dispatch specialists: {', '.join(sorted(registered_agents))}")
    bound = {t: a for t, a in _tile_agent_bindings().items() if a}
    print(f"Tile->agent bindings: {', '.join(f'{t}={a}' for t, a in sorted(bound.items()))}")
    print(f"delegate_to_agent enum: {', '.join(sorted(_delegate_enum_agents()))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
