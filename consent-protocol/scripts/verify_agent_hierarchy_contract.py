#!/usr/bin/env python3
"""Verify One hierarchy, authored product agents, tiles, and MCP separation."""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CONSENT_ROOT = REPO_ROOT / "consent-protocol"
sys.path.insert(0, str(CONSENT_ROOT))

DOC_PATH = REPO_ROOT / "docs/reference/one/one-agent-hierarchy.md"
DISPATCH_INIT_PATH = CONSENT_ROOT / "hushh_mcp/adk_bridge/__init__.py"
MANIFEST_ROOT = CONSENT_ROOT / "hushh_mcp/agents"
CAPABILITIES_PATH = REPO_ROOT / "hushh-webapp/lib/onboarding/one-capabilities.ts"
TOOL_DEFINITIONS_PATH = CONSENT_ROOT / "mcp_modules/tools/definitions.py"
REQUIRED_RUNTIME_IDS = {
    "agent_one",
    "agent_kai",
    "agent_nav",
    "agent_kyc",
    "agent_location",
    "agent_connected_systems",
    "agent_email",
    "agent_gmail",
    "agent_personal_information",
}
REQUIRED_MEMORY_IDS = {
    "agent_memory_intent",
    "agent_memory_segmentation",
    "agent_memory_merge",
    "agent_pkm_structure",
    "agent_summary_reducer",
}


def _registered_dispatch_agents() -> set[str]:
    text = DISPATCH_INIT_PATH.read_text(encoding="utf-8")
    return set(re.findall(r'register_specialist\(\s*"([^"]+)"', text))


def _specialist_a2a_scope_map() -> dict[str, object]:
    from hushh_mcp.adk_bridge.delegation import SPECIALIST_A2A_SCOPE_MAP

    return SPECIALIST_A2A_SCOPE_MAP


def _manifest_agent_ids() -> set[str]:
    from hushh_mcp.hushh_adk.manifest import ManifestLoader

    return {ManifestLoader.load(str(path)).id for path in MANIFEST_ROOT.glob("*/agent.yaml")}


def _tile_agent_bindings() -> dict[str, str | None]:
    text = CAPABILITIES_PATH.read_text(encoding="utf-8")
    bindings: dict[str, str | None] = {}
    pattern = re.compile(r'id:\s*"([^"]+)",.*?agentId:\s*(null|"[^"]+")', re.DOTALL)
    for match in pattern.finditer(text):
        tile_id, raw_agent = match.group(1), match.group(2)
        bindings[tile_id] = None if raw_agent == "null" else raw_agent.strip('"')
    return bindings


def main() -> int:
    errors: list[str] = []
    if not DOC_PATH.exists():
        print(f"ERROR: missing hierarchy doc: {DOC_PATH}", file=sys.stderr)
        return 1
    doc = DOC_PATH.read_text(encoding="utf-8")
    manifest_ids = _manifest_agent_ids()

    for agent_id in sorted(REQUIRED_RUNTIME_IDS | REQUIRED_MEMORY_IDS):
        if agent_id not in manifest_ids:
            errors.append(f"missing authored AgentManifestV2 for `{agent_id}`")
        if f"`{agent_id}`" not in doc:
            errors.append(f"{DOC_PATH}: missing runtime id `{agent_id}`")

    scope_map = _specialist_a2a_scope_map()
    for agent_id, scope in sorted(scope_map.items()):
        if agent_id not in manifest_ids:
            errors.append(f"scope map references unauthored agent `{agent_id}`")
        if f"`{scope.value}`" not in doc:
            errors.append(f"{DOC_PATH}: missing scope `{scope.value}` for `{agent_id}`")

    registered_agents = _registered_dispatch_agents()
    for agent_id in sorted(registered_agents):
        if agent_id not in manifest_ids:
            errors.append(f"dispatch registry references unauthored agent `{agent_id}`")
        if f"`{agent_id}`" not in doc:
            errors.append(f"{DOC_PATH}: missing in-process dispatch agent `{agent_id}`")

    for marker in (
        "## Wiring Modes",
        "Scope-gated A2A specialists",
        "In-process dispatch registry",
        "Official A2A v1",
        "not every scope-gated specialist is registered in the in-process dispatch table",
    ):
        if marker not in doc:
            errors.append(f"{DOC_PATH}: missing marker `{marker}`")

    bindings = _tile_agent_bindings()
    if not bindings:
        errors.append(f"{CAPABILITIES_PATH}: no tile agentId bindings parsed")
    catalog_text = CAPABILITIES_PATH.read_text(encoding="utf-8")
    tile_ids = re.findall(r'^\s{4}id:\s*"([^"]+)"', catalog_text, re.MULTILINE)
    for tile_id in tile_ids:
        if tile_id not in bindings:
            errors.append(f"{CAPABILITIES_PATH}: tile `{tile_id}` lacks explicit agentId")
    for tile_id, agent_id in sorted(bindings.items()):
        if agent_id is not None and agent_id not in manifest_ids:
            errors.append(
                f"{CAPABILITIES_PATH}: tile `{tile_id}` binds unauthored agent `{agent_id}`"
            )

    if "delegate_to_agent" in TOOL_DEFINITIONS_PATH.read_text(encoding="utf-8"):
        errors.append(f"{TOOL_DEFINITIONS_PATH}: retired public delegate_to_agent tool returned")

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print("Agent hierarchy contract verified.")
    print(f"Authored product agents: {', '.join(sorted(manifest_ids))}")
    print(f"Scope-gated specialists: {', '.join(sorted(scope_map))}")
    print(f"In-process specialists: {', '.join(sorted(registered_agents))}")
    print("Public MCP delegate_to_agent: absent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
