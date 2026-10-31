"""Read-only measurement projection of the existing action and agent catalogs.

This catalog never registers an executor or grants invocation/action authority.
"""

from __future__ import annotations

import hashlib
import json
import re
from functools import lru_cache

from hushh_mcp.services.generated_contracts import generated_contract_path
from hushh_mcp.services.plg_outcomes import outcome_coverage


def _runtime_name(value: str) -> str:
    return re.sub(r"[^a-z0-9_]", "_", value.lower()).strip("_")


@lru_cache(maxsize=1)
def activity_catalog() -> dict:
    registry = json.loads(
        generated_contract_path("agents", "product-agent-registry.v2.json").read_text()
    )
    graph = json.loads(generated_contract_path("kai", "one-capability-graph.v1.json").read_text())
    agents: list[dict] = []
    actions: dict[str, dict] = {}
    aliases: dict[str, dict] = {}
    for agent in registry["agents"]:
        agent_id = agent["id"]
        exposure = agent.get("one_exposure") or {}
        public = agent_id == "agent_one" or bool(exposure)
        enabled = (
            public
            and "production" in agent["availability"]["environments"]
            and exposure.get("exposure_status") != "disabled"
        )
        agents.append(
            {
                "id": agent_id,
                "label": agent["name"],
                "public": public,
                "available": enabled,
                "outcome": outcome_coverage(agent_id, public=public),
            }
        )

        def add_execution(node, agent_id=agent_id, exposure=exposure):
            node_id = node["id"]
            names = {
                node_id.replace("-", "_").replace(".", "_"),
                _runtime_name(node.get("name", "")),
            }
            if node_id == agent_id and exposure.get("service_id"):
                names.add(exposure["service_id"])
            for name in names - {""}:
                if name in aliases and aliases[name]["agentId"] != agent_id:
                    raise ValueError("Ambiguous product agent measurement identity")
                aliases[name] = {"agentId": agent_id, "actionId": f"agent:{node_id}"}
            actions[f"agent:{node_id}"] = {
                "id": f"agent:{node_id}",
                "agentId": agent_id,
                "label": node.get("name", node_id),
                "kind": "agent",
                "proof": "execution_observed",
            }
            actions[f"runtime-tool:{node_id}"] = {
                "id": f"runtime-tool:{node_id}",
                "agentId": agent_id,
                "label": "Other admitted tools",
                "kind": "tool",
                "proof": "execution_observed",
            }
            for tool in node.get("tools", []):
                key = f"tool:{node_id}:{tool['name']}"
                actions[key] = {
                    "id": key,
                    "agentId": agent_id,
                    "label": tool["name"],
                    "kind": "tool",
                    "proof": "execution_observed",
                }
            for child in node.get("subagents", []):
                add_execution(child)

        add_execution(agent)
    ownership = {}
    for service in graph["services"]:
        owner = service.get("specialist_agent_id") or "agent_one"
        for action_id in service.get("action_ids", []):
            ownership[action_id] = owner
    for action in graph["actions"]:
        key = action["capability_id"]
        actions[key] = {
            "id": key,
            "agentId": ownership.get(key, "agent_one"),
            "label": action["label"],
            "kind": "action",
            "proof": "client_reported",
        }
    # The graph excludes some authored compatibility/setup actions. Measure
    # them without restoring Search visibility or execution eligibility.
    gateway = json.loads(
        generated_contract_path("kai", "kai-action-gateway.vnext.json").read_text()
    )
    agent_ids = {agent["id"] for agent in agents}
    for action in gateway["actions"]:
        key = action["action_id"]
        if key in actions:
            continue
        owner = action.get("delegate_agent_id") or aliases.get(action["surface_id"], {}).get(
            "agentId", "agent_one"
        )
        actions[key] = {
            "id": key,
            "agentId": owner if owner in agent_ids else "agent_one",
            "label": action["label"],
            "kind": "action",
            "proof": "client_reported",
        }
    observations = json.loads(
        generated_contract_path("plg", "observability-actions.v1.json").read_text()
    )
    # Explicit measurement ownership, not semantic product routing. A new
    # unclassified feature stays with One until its authored owner is declared.
    owners = {
        "one_memory_": "agent_personal_information",
        "one_wallet_": "agent_wallet",
        "one_calendar_": "agent_calendar",
        "one_kyc_": "agent_kyc",
        "one_crm_": "agent_connected_systems",
        "one_location_": "agent_location",
        "gmail_": "agent_email",
        "consent_": "agent_nav",
        "analysis_": "agent_kai",
        "portfolio_": "agent_kai",
        "import_": "agent_portfolio_import",
        "market_": "agent_kai",
        "recommendation_": "agent_kai",
        "ria_": "agent_kai",
        "drive_": "agent_documents",
        "career_": "agent_career",
        "connect_": "agent_connections",
    }
    for event, tokens in observations["events"].items():
        owner = next(
            (agent for prefix, agent in owners.items() if event.startswith(prefix)), "agent_one"
        )
        for token in tokens or [""]:
            key = f"observation:{event}" + (f":{token}" if token else "")
            actions[key] = {
                "id": key,
                "agentId": owner,
                "label": (event + " " + token).replace("_", " ").strip(),
                "kind": "action",
                "proof": "client_reported",
            }
    public = {"agents": agents, "actions": sorted(actions.values(), key=lambda row: row["id"])}
    revision = hashlib.sha256(json.dumps(public, sort_keys=True).encode()).hexdigest()
    return {"revision": revision, **public, "aliases": aliases}


def public_activity_catalog() -> dict:
    catalog = activity_catalog()
    return {key: catalog[key] for key in ("revision", "agents", "actions")}


def action_descriptor(action_id: str) -> dict | None:
    return next((row for row in activity_catalog()["actions"] if row["id"] == action_id), None)


def runtime_descriptor(agent_name: str, tool_name: str | None = None) -> dict | None:
    identity = activity_catalog()["aliases"].get(_runtime_name(agent_name))
    if not identity:
        return None
    action_id = identity["actionId"]
    if tool_name is not None:
        action_id = "tool:" + action_id.removeprefix("agent:") + ":" + tool_name
    return action_descriptor(action_id) or (
        action_descriptor("runtime-tool:" + identity["actionId"].removeprefix("agent:"))
        if tool_name is not None
        else None
    )
