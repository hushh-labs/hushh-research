#!/usr/bin/env python3
"""Verify the One agent hierarchy doc against backend agent wiring."""

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

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print("Agent hierarchy contract verified.")
    print(f"Scope-gated A2A specialists: {', '.join(sorted(scope_map))}")
    print(f"In-process dispatch specialists: {', '.join(sorted(registered_agents))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
