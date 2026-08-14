#!/usr/bin/env python3
"""Verify One hierarchy, authored product agents, tiles, and MCP separation."""

from __future__ import annotations

import json
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
ACTION_GATEWAY_PATH = REPO_ROOT / "contracts/kai/kai-action-gateway.vnext.json"
ONE_ACTION_TOOLS_PATH = CONSENT_ROOT / "hushh_mcp/one_adk/action_tools.py"
ONE_AGENT_TREE_PATH = CONSENT_ROOT / "hushh_mcp/one_adk/agent_tree.py"
NAV_BRIDGE_PATH = CONSENT_ROOT / "hushh_mcp/adk_bridge/nav_agent.py"
LEGACY_ORCHESTRATOR_AGENT_PATH = CONSENT_ROOT / "hushh_mcp/agents/orchestrator/agent.py"
LEGACY_ORCHESTRATOR_TOOLS_PATH = CONSENT_ROOT / "hushh_mcp/agents/orchestrator/tools.py"
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
DELEGATE_AGENT_ALIASES = {
    "one": "agent_one",
    "kai": "agent_kai",
    "nav": "agent_nav",
}


def _registered_dispatch_agents() -> set[str]:
    text = DISPATCH_INIT_PATH.read_text(encoding="utf-8")
    return set(re.findall(r'register_specialist\(\s*"([^"]+)"', text))


def _specialist_a2a_scope_map() -> dict[str, object]:
    from hushh_mcp.adk_bridge.delegation import SPECIALIST_A2A_SCOPE_MAP

    return SPECIALIST_A2A_SCOPE_MAP


def _manifests_by_id() -> dict[str, object]:
    from hushh_mcp.hushh_adk.manifest import ManifestLoader

    manifests = {
        manifest.id: manifest
        for manifest in (
            ManifestLoader.load(str(path)) for path in MANIFEST_ROOT.glob("*/agent.yaml")
        )
    }
    return manifests


def _parent_chain(agent_id: str, manifests: dict[str, object]) -> list[str]:
    """Return a manifest-backed ancestor chain and reject a hierarchy cycle."""
    chain: list[str] = []
    current = agent_id
    while current:
        if current in chain:
            raise ValueError(f"agent parent cycle: {' -> '.join([*chain, current])}")
        chain.append(current)
        manifest = manifests.get(current)
        if manifest is None:
            raise ValueError(f"agent `{current}` has no authored manifest")
        current = str(getattr(manifest, "parent", "") or "").strip()
    return chain


def _action_gateway() -> list[dict[str, object]]:
    payload = json.loads(ACTION_GATEWAY_PATH.read_text(encoding="utf-8"))
    actions = payload.get("actions") if isinstance(payload, dict) else None
    if not isinstance(actions, list):
        raise ValueError("generated action gateway has no action list")
    return [action for action in actions if isinstance(action, dict)]


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
    manifests = _manifests_by_id()
    manifest_ids = set(manifests)

    for agent_id in sorted(manifest_ids):
        try:
            chain = _parent_chain(agent_id, manifests)
        except ValueError as exc:
            errors.append(str(exc))
            continue
        if agent_id != "agent_one" and chain[-1] != "agent_one":
            errors.append(
                f"agent `{agent_id}` must resolve to `agent_one`, got {' -> '.join(chain)}"
            )

    one = manifests.get("agent_one")
    if one is None:
        errors.append("missing authored AgentManifestV2 for `agent_one`")
    else:
        roster = getattr(one, "capabilities", {}).get("specialist_roster", [])
        if not isinstance(roster, list):
            errors.append("agent_one specialist_roster must be a list")
        else:
            for agent_id in roster:
                if agent_id not in manifest_ids:
                    errors.append(
                        f"agent_one specialist_roster references unauthored agent `{agent_id}`"
                    )
                    continue
                if getattr(manifests[agent_id], "parent", None) != "agent_one":
                    errors.append(
                        f"agent_one specialist_roster agent `{agent_id}` is not a direct child of One"
                    )

    nav = manifests.get("agent_nav")
    connections = manifests.get("agent_connections")
    if nav is None or connections is None:
        errors.append("Nav and Connections must both have authored AgentManifestV2 manifests")
    else:
        if getattr(nav, "parent", None) != "agent_one":
            errors.append("agent_nav must be a direct child of agent_one")
        if getattr(connections, "parent", None) != "agent_nav":
            errors.append("agent_connections must be a direct child of agent_nav")
        nav_children = getattr(nav, "capabilities", {}).get("direct_subagents", [])
        if nav_children != ["agent_connections"]:
            errors.append(
                "agent_nav capabilities.direct_subagents must declare only agent_connections"
            )
        if "agent_consent" in manifest_ids:
            errors.append("do not create agent_consent: agent_nav is the Consent Center runtime")

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
        "There is no separate `agent_consent` product head or roster entry.",
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

    try:
        actions = _action_gateway()
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(f"{ACTION_GATEWAY_PATH}: {exc}")
        actions = []
    action_ids: set[str] = set()
    for action in actions:
        action_id = str(action.get("action_id") or "").strip()
        if not action_id:
            errors.append(f"{ACTION_GATEWAY_PATH}: action without action_id")
            continue
        if action_id in action_ids:
            errors.append(f"{ACTION_GATEWAY_PATH}: duplicate action `{action_id}`")
            continue
        action_ids.add(action_id)
        if not str(action.get("meaning") or "").strip():
            errors.append(f"{ACTION_GATEWAY_PATH}: `{action_id}` lacks user-facing meaning")
        goal = action.get("goal")
        if (
            not isinstance(goal, dict)
            or not isinstance(goal.get("workflow_steps"), list)
            or not goal["workflow_steps"]
        ):
            errors.append(f"{ACTION_GATEWAY_PATH}: `{action_id}` lacks an executable goal trace")
        target = action.get("execution_target")
        if not isinstance(target, dict):
            errors.append(f"{ACTION_GATEWAY_PATH}: `{action_id}` lacks execution_target")
            continue
        status = str(target.get("status") or "").strip()
        if status not in {"wired", "unwired", "dead"}:
            errors.append(
                f"{ACTION_GATEWAY_PATH}: `{action_id}` has invalid execution status `{status}`"
            )
        if status != "wired" and not str(target.get("reason") or "").strip():
            errors.append(f"{ACTION_GATEWAY_PATH}: `{action_id}` has no safe unavailable reason")
        raw_delegate = str(action.get("delegate_agent_id") or "").strip()
        if not raw_delegate:
            continue
        agent_id = DELEGATE_AGENT_ALIASES.get(raw_delegate, raw_delegate)
        if agent_id not in manifest_ids:
            errors.append(
                f"{ACTION_GATEWAY_PATH}: `{action_id}` delegates to unauthored `{raw_delegate}`"
            )
            continue
        try:
            chain = _parent_chain(agent_id, manifests)
        except ValueError as exc:
            errors.append(f"{ACTION_GATEWAY_PATH}: `{action_id}`: {exc}")
            continue
        if agent_id == "agent_connections" and chain[:2] != ["agent_connections", "agent_nav"]:
            errors.append(
                f"{ACTION_GATEWAY_PATH}: `{action_id}` bypasses Nav on the Connections hierarchy"
            )

    by_id = {str(action.get("action_id") or ""): action for action in actions}
    consent_action = by_id.get("consent.chat.turn")
    connections_action = by_id.get("connections.chat.turn")
    if (
        not isinstance(consent_action, dict)
        or consent_action.get("delegate_agent_id") != "agent_nav"
    ):
        errors.append("consent.chat.turn must delegate to agent_nav, the Consent Center runtime")
    if not isinstance(connections_action, dict):
        errors.append("connections.chat.turn is missing from the generated action gateway")
    else:
        if connections_action.get("delegate_agent_id") != "agent_connections":
            errors.append("connections.chat.turn must identify agent_connections as Nav's child")
        if (connections_action.get("execution_target") or {}).get("status") != "unwired":
            errors.append("connections.chat.turn must remain unwired without ingress authority")
        entrypoints = (connections_action.get("goal") or {}).get("entrypoint_support", [])
        if "voice" in entrypoints:
            errors.append(
                "connections.chat.turn must not advertise voice before authority ingress exists"
            )

    action_tool_source = ONE_ACTION_TOOLS_PATH.read_text(encoding="utf-8")
    for required_fragment in (
        '"agent_connections": "ask_consent_agent"',
        '"agent_nav": "ask_consent_agent"',
        '"needsConfirmation": True',
        '"trustedActivationRequired": True',
    ):
        if required_fragment not in action_tool_source:
            errors.append(
                f"{ONE_ACTION_TOOLS_PATH}: missing action-safety contract `{required_fragment}`"
            )

    # A user request reaches Nav or its Connections child only after One's
    # semantic tool selection. These source checks intentionally guard a
    # boundary, rather than impose a second classifier: policy may validate
    # that typed selection and authority, but cannot infer it from message
    # keywords.
    one_tree_source = ONE_AGENT_TREE_PATH.read_text(encoding="utf-8")
    # Collapse runs of whitespace before matching the prose fragment. The
    # invariant is what the sentence SAYS, not how it happens to wrap, and a
    # literal carrying an embedded "\n    " asserts the line break too: the
    # 2026-08-12 main sync reworded this docstring (a genuine improvement -- it
    # now says the selection "stays One's"), the reflow moved the break, and the
    # check failed over the layout rather than the meaning. It went unnoticed on
    # `main` because tests/test_product_agent_registry_v2.py is not in that
    # branch's scripts/test-ci.manifest.txt, so the checker had never run there.
    one_tree_prose = " ".join(one_tree_source.split())
    for required_fragment in (
        'target: Literal["consent", "connections"]',
        '"consent": "agent_nav", "connections": "agent_connections"',
    ):
        if required_fragment not in one_tree_source:
            errors.append(
                f"{ONE_AGENT_TREE_PATH}: missing semantic Nav/Connections handoff contract `{required_fragment}`"
            )
    # The boundary itself: selection between subagents is One's, never inferred
    # here from the words of the request.
    #
    # Pinned to `main`'s wording, not this branch's. `main` reworded the same
    # sentence ("choose a subagent. One makes that selection" for "choose
    # *between subagents* -- that selection stays One's"): identical meaning,
    # different words, so the merge of 2026-08-14 turned this check red over
    # prose. Tracking `main` here means the next sync does not re-break it. The
    # fragment deliberately stops before the sentence's end so a later reflow or
    # a change to the FOLLOWING sentence cannot fail a contract it does not
    # state.
    handoff_contract = "It never examines request words to choose a subagent"
    if handoff_contract not in one_tree_prose:
        errors.append(
            f"{ONE_AGENT_TREE_PATH}: missing semantic Nav/Connections handoff contract `{handoff_contract}`"
        )

    nav_bridge_source = NAV_BRIDGE_PATH.read_text(encoding="utf-8")
    for prohibited_fragment in ("_is_connections_query", "get_connections_a2a"):
        if prohibited_fragment in nav_bridge_source:
            errors.append(
                f"{NAV_BRIDGE_PATH}: Nav must not lexically choose its Connections child `{prohibited_fragment}`"
            )

    legacy_orchestrator_source = LEGACY_ORCHESTRATOR_AGENT_PATH.read_text(
        encoding="utf-8"
    ) + LEGACY_ORCHESTRATOR_TOOLS_PATH.read_text(encoding="utf-8")
    for prohibited_fragment in ("classify_specialist_domain", "_SPECIALIST_ROUTES"):
        if prohibited_fragment in legacy_orchestrator_source:
            errors.append(
                f"legacy One compatibility package must not contain `{prohibited_fragment}`"
            )

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print("Agent hierarchy contract verified.")
    print(f"Authored product agents: {', '.join(sorted(manifest_ids))}")
    print(f"Scope-gated specialists: {', '.join(sorted(scope_map))}")
    print(f"In-process specialists: {', '.join(sorted(registered_agents))}")
    print(f"Generated action traces verified: {len(action_ids)}")
    print("Public MCP delegate_to_agent: absent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
