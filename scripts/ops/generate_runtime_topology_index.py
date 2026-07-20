#!/usr/bin/env python3
"""Generate and validate the metadata-only Hussh runtime topology index.

The index is a maintenance projection over existing contracts. It is not an
action authority, a product agent, a route resolver, or a store of user
information.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
AUTHORED_CONTRACT = REPO_ROOT / "config/runtime-topology-maintenance.json"
OUTPUT = REPO_ROOT / "contracts/architecture/runtime-topology-index.v1.json"
INPUTS = {
    "topology_contract": AUTHORED_CONTRACT,
    "route_layout": REPO_ROOT / "hushh-webapp/lib/navigation/app-route-layout.contract.json",
    "surface_map": REPO_ROOT / "hushh-webapp/frontend-native-surface-map.generated.json",
    "cache_manifest": REPO_ROOT / "hushh-webapp/cache-coherence-screen-manifest.generated.json",
    "route_index": REPO_ROOT / "contracts/kai/one-route-orchestration-index.v1.json",
    "action_gateway": REPO_ROOT / "contracts/kai/kai-action-gateway.vnext.json",
    "agent_registry": REPO_ROOT / "contracts/agents/product-agent-registry.v2.json",
    "a2a_scope_map": REPO_ROOT / "consent-protocol/hushh_mcp/adk_bridge/delegation.py",
    "in_process_dispatch": REPO_ROOT / "consent-protocol/hushh_mcp/adk_bridge/__init__.py",
    "one_specialist_tools": REPO_ROOT / "consent-protocol/hushh_mcp/one_adk/action_tools.py",
    "data_plane": REPO_ROOT / "docs/reference/architecture/runtime-db-data-plane-contract.json",
    "world_model_compat": REPO_ROOT / "consent-protocol/api/routes/world_model.py",
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def source_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stable_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def route_path(url: str) -> str:
    return url.split("?", 1)[0]


def parse_runtime_wiring() -> dict[str, dict[str, Any]]:
    """Read narrow, static wiring declarations without importing runtime code."""

    scope_source = INPUTS["a2a_scope_map"].read_text(encoding="utf-8")
    dispatch_source = INPUTS["in_process_dispatch"].read_text(encoding="utf-8")
    tool_source = INPUTS["one_specialist_tools"].read_text(encoding="utf-8")

    scopes = {
        match.group("agent_id"): match.group("scope")
        for match in re.finditer(
            r'^\s*"(?P<agent_id>agent_[a-z_]+)":\s*ConsentScope\.(?P<scope>[A-Z0-9_]+),',
            scope_source,
            flags=re.MULTILINE,
        )
    }
    in_process = set(
        re.findall(r'register_specialist\(\s*"(agent_[a-z_]+)"', dispatch_source)
    )
    specialist_tools = {
        match.group("agent_id"): match.group("tool_name")
        for match in re.finditer(
            r'^\s*"(?P<agent_id>agent_[a-z_]+)":\s*"(?P<tool_name>ask_[a-z_]+)",',
            tool_source,
            flags=re.MULTILINE,
        )
    }
    return {
        agent_id: {
            "a2a_scope": scopes.get(agent_id),
            "in_process_dispatch": agent_id in in_process,
            "one_specialist_tool": specialist_tools.get(agent_id),
        }
        for agent_id in sorted(set(scopes) | in_process | set(specialist_tools))
    }


def required_strings(value: Any, *, label: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise ValueError(f"{label} must be a list of non-empty strings")
    return value


def as_map(rows: Iterable[dict[str, Any]], key: str, *, label: str) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        value = row.get(key)
        if not isinstance(value, str) or not value:
            raise ValueError(f"{label} entry is missing {key}")
        if value in result:
            raise ValueError(f"duplicate {label} {key}: {value}")
        result[value] = row
    return result


def build_index() -> dict[str, Any]:
    missing = [str(path.relative_to(REPO_ROOT)) for path in INPUTS.values() if not path.exists()]
    if missing:
        raise ValueError(f"missing required topology input(s): {', '.join(missing)}")

    authored = read_json(AUTHORED_CONTRACT)
    layout = read_json(INPUTS["route_layout"])
    surface_map = read_json(INPUTS["surface_map"])
    cache_manifest = read_json(INPUTS["cache_manifest"])
    route_index = read_json(INPUTS["route_index"])
    action_gateway = read_json(INPUTS["action_gateway"])
    agent_registry = read_json(INPUTS["agent_registry"])
    data_plane = read_json(INPUTS["data_plane"])
    world_model_source = INPUTS["world_model_compat"].read_text(encoding="utf-8")
    runtime_wiring = parse_runtime_wiring()

    if authored.get("schema_version") != "hushh.runtime_topology_maintenance.v1":
        raise ValueError("unsupported runtime topology maintenance contract version")

    layout_by_route = as_map(layout, "route", label="route layout")
    surface_by_route = as_map(surface_map.get("routes", []), "route", label="surface map route")
    cache_by_route = as_map(cache_manifest.get("screens", []), "route", label="cache screen")
    orchestration_by_route = as_map(route_index.get("routes", []), "route_pattern", label="route index")
    agents_by_id = as_map(agent_registry.get("agents", []), "id", label="agent registry")
    families_by_id = as_map(data_plane.get("table_families", []), "id", label="data-plane family")
    actions_by_id = as_map(action_gateway.get("actions", []), "action_id", label="action gateway action")

    unknown_wiring_agents = sorted(set(runtime_wiring) - set(agents_by_id))
    if unknown_wiring_agents:
        raise ValueError(f"runtime wiring references unauthored agents: {unknown_wiring_agents}")

    layout_routes = set(layout_by_route)
    for name, rows in (
        ("surface map", surface_by_route),
        ("cache manifest", cache_by_route),
        ("route orchestration index", orchestration_by_route),
    ):
        if set(rows) != layout_routes:
            missing_routes = sorted(layout_routes - set(rows))
            extra_routes = sorted(set(rows) - layout_routes)
            raise ValueError(
                f"{name} route coverage differs from route layout: "
                f"missing={missing_routes}, extra={extra_routes}"
            )

    semantic_rows = authored.get("semantic_routes", [])
    semantic_by_id = as_map(semantic_rows, "id", label="semantic route")
    semantic_urls: set[str] = set()
    for semantic_id, row in semantic_by_id.items():
        pathname = row.get("pathname")
        canonical_url = row.get("canonical_url")
        query = row.get("query")
        if not isinstance(pathname, str) or pathname not in layout_by_route:
            raise ValueError(f"semantic route {semantic_id} has unknown pathname {pathname!r}")
        if not isinstance(canonical_url, str) or route_path(canonical_url) != pathname:
            raise ValueError(f"semantic route {semantic_id} canonical_url must resolve to {pathname}")
        if not isinstance(query, dict) or not query:
            raise ValueError(f"semantic route {semantic_id} needs a non-empty query map")
        if canonical_url in semantic_urls:
            raise ValueError(f"duplicate semantic canonical_url: {canonical_url}")
        semantic_urls.add(canonical_url)

    alias_rows = authored.get("route_aliases", [])
    aliases_by_path = as_map(alias_rows, "pathname", label="route alias")
    for pathname, alias in aliases_by_path.items():
        route = layout_by_route.get(pathname)
        if not route:
            raise ValueError(f"route alias {pathname} has no physical route contract")
        if route.get("mode") != "redirect":
            raise ValueError(f"route alias {pathname} must be mode=redirect")
        canonical_url = alias.get("canonical_url")
        if canonical_url not in semantic_urls:
            raise ValueError(f"route alias {pathname} targets unregistered semantic URL {canonical_url!r}")
        for field in ("owner", "reason", "retirement_policy"):
            if not isinstance(alias.get(field), str) or not alias[field].strip():
                raise ValueError(f"route alias {pathname} requires {field}")

    overrides_by_path = as_map(
        authored.get("implementation_overrides", []), "pathname", label="implementation override"
    )
    for pathname, override in overrides_by_path.items():
        if pathname not in layout_by_route:
            raise ValueError(f"implementation override {pathname} has no physical route contract")
        if override.get("kind") not in {
            "redirect_with_shared_feature_module",
            "development_only_feature_with_production_redirect",
        }:
            raise ValueError(f"implementation override {pathname} has unsupported kind")
        canonical_url = override.get("canonical_url")
        if (
            not isinstance(canonical_url, str)
            or (canonical_url not in semantic_urls and route_path(canonical_url) not in layout_by_route)
        ):
            raise ValueError(f"implementation override {pathname} targets unknown semantic URL")

    redirect_pages: list[str] = []
    for pathname, route in layout_by_route.items():
        page_file = surface_by_route[pathname].get("page_file")
        if not isinstance(page_file, str):
            continue
        page_path = REPO_ROOT / "hushh-webapp" / page_file
        if page_path.exists() and "redirect(" in page_path.read_text(encoding="utf-8"):
            redirect_pages.append(pathname)
            override = overrides_by_path.get(pathname)
            allowed_conditional_redirect = override and override.get("kind") in {
                "redirect_with_shared_feature_module",
                "development_only_feature_with_production_redirect",
            }
            if route.get("mode") != "redirect" and not allowed_conditional_redirect:
                raise ValueError(
                    f"{pathname} calls redirect(...) but route layout mode is {route.get('mode')!r}"
                )

    all_route_delegate_ids = {
        agent_id
        for route in orchestration_by_route.values()
        for agent_id in route.get("delegation_policy", {}).get("allowed_delegate_agent_ids", [])
    }
    unknown_delegate_ids = sorted(all_route_delegate_ids - set(agents_by_id))
    if unknown_delegate_ids:
        raise ValueError(f"route index admits unauthored agents: {unknown_delegate_ids}")

    profiles = authored.get("maintenance_profiles", [])
    profiles_by_id = as_map(profiles, "id", label="maintenance profile")
    allowed_lanes = {
        "backend_architect",
        "data_model_architect",
        "frontend_architect",
        "product_docs_architect",
        "reviewer",
        "security_consent_auditor",
        "voice_systems_architect",
    }
    for profile_id, profile in profiles_by_id.items():
        required_strings(profile.get("personas"), label=f"maintenance profile {profile_id}.personas")
        prefixes = required_strings(profile.get("route_prefixes"), label=f"maintenance profile {profile_id}.route_prefixes")
        if any(not prefix.startswith("/") for prefix in prefixes):
            raise ValueError(f"maintenance profile {profile_id} has invalid route prefix")
        profile_agents = set(required_strings(profile.get("agent_ids"), label=f"maintenance profile {profile_id}.agent_ids"))
        unknown_agents = sorted(profile_agents - set(agents_by_id))
        if unknown_agents:
            raise ValueError(f"maintenance profile {profile_id} references unknown agents: {unknown_agents}")
        profile_families = set(required_strings(profile.get("table_family_ids"), label=f"maintenance profile {profile_id}.table_family_ids"))
        unknown_families = sorted(profile_families - set(families_by_id))
        if unknown_families:
            raise ValueError(f"maintenance profile {profile_id} references unknown DB families: {unknown_families}")
        lanes = set(required_strings(profile.get("evidence_lanes"), label=f"maintenance profile {profile_id}.evidence_lanes"))
        unknown_lanes = sorted(lanes - allowed_lanes)
        if unknown_lanes:
            raise ValueError(f"maintenance profile {profile_id} references unknown evidence lanes: {unknown_lanes}")

    compatibility_rows = authored.get("compatibility_surfaces", [])
    compatibility_by_id = as_map(compatibility_rows, "id", label="compatibility surface")
    findings: list[dict[str, str]] = []
    for compat_id, compat in compatibility_by_id.items():
        prefix = compat.get("pathname_prefix")
        canonical_prefix = compat.get("canonical_prefix")
        if not isinstance(prefix, str) or not prefix.startswith("/"):
            raise ValueError(f"compatibility surface {compat_id} has invalid pathname_prefix")
        if not isinstance(canonical_prefix, str) or not canonical_prefix.startswith("/"):
            raise ValueError(f"compatibility surface {compat_id} has invalid canonical_prefix")
        if compat_id == "api.world_model":
            if f'prefix="{prefix}"' not in world_model_source:
                raise ValueError("api.world_model compatibility contract no longer matches runtime router")
            sunset = compat.get("sunset_at")
            if not isinstance(sunset, str) or sunset not in world_model_source:
                raise ValueError("api.world_model sunset must match the runtime response header")
            findings.append(
                {
                    "id": "compatibility.api.world_model.expired_sunset",
                    "severity": "decision_required",
                    "message": "The mounted /api/world-model compatibility surface has passed its declared sunset. Remove it with consumer evidence or explicitly extend the contract.",
                }
            )

    retirements = authored.get("database_retirements", [])
    retirements_by_table = as_map(retirements, "table", label="database retirement")
    all_tables = {
        table
        for family in families_by_id.values()
        for table in family.get("exact_tables", [])
        if isinstance(table, str)
    }
    for table, retirement in retirements_by_table.items():
        if table not in all_tables:
            raise ValueError(f"database retirement {table} is not declared by the data-plane contract")
        if retirement.get("lifecycle") != "pending_destructive_preflight":
            raise ValueError(f"database retirement {table} must declare pending_destructive_preflight")
        preflight = required_strings(retirement.get("required_preflight"), label=f"database retirement {table}.required_preflight")
        if len(preflight) < 3:
            raise ValueError(f"database retirement {table} must list its destructive preflight")
        findings.append(
            {
                "id": f"database.{table}.retirement_pending",
                "severity": "decision_required",
                "message": "A legacy table remains in schema contracts. A forward-only drop requires live row-count, retention, and backup preflight before migration authoring.",
            }
        )

    route_rows = []
    semantic_by_path: dict[str, list[dict[str, Any]]] = {}
    for semantic in semantic_by_id.values():
        semantic_by_path.setdefault(semantic["pathname"], []).append(semantic)
    for pathname in sorted(layout_routes):
        route_index_entry = orchestration_by_route[pathname]
        route_rows.append(
            {
                "pathname": pathname,
                "lifecycle": "alias" if pathname in aliases_by_path else "canonical",
                "route_mode": layout_by_route[pathname].get("mode"),
                "page_file": surface_by_route[pathname].get("page_file"),
                "semantic_routes": sorted(
                    semantic_by_path.get(pathname, []), key=lambda row: row["id"]
                ),
                "alias": aliases_by_path.get(pathname),
                "implementation_override": overrides_by_path.get(pathname),
                "cache": {
                    "policy": cache_by_route[pathname].get("cache_policy"),
                    "resource_classes": cache_by_route[pathname].get("resource_classes", []),
                    "refresh_trigger": cache_by_route[pathname].get("refresh_trigger"),
                },
                "native_surface_id": route_index_entry.get("native_surface_id"),
                "voice": {
                    "playbook_id": route_index_entry.get("voice_playbook", {}).get("playbook_id"),
                    "action_ids": route_index_entry.get("action_ids", []),
                    "delegate_agent_ids": route_index_entry.get("delegation_policy", {}).get("allowed_delegate_agent_ids", []),
                },
                "api_dependencies": surface_by_route[pathname].get("api_dependencies", []),
            }
        )

    agent_rows = [
        {
            "id": agent_id,
            "parent": agent.get("parent"),
            "status": agent.get("status"),
            "surfaces": agent.get("surfaces", {}),
            "runtime": agent.get("runtime", {}),
            "rollout": agent.get("rollout", {}),
            "wiring": runtime_wiring.get(
                agent_id,
                {
                    "a2a_scope": None,
                    "in_process_dispatch": False,
                    "one_specialist_tool": None,
                },
            ),
        }
        for agent_id, agent in sorted(agents_by_id.items())
    ]
    table_family_rows = [
        {
            "id": family_id,
            "owner": family.get("owner"),
            "data_class": family.get("data_class"),
            "lifecycle_status": family.get("lifecycle_status"),
            "exact_tables": family.get("exact_tables", []),
            "primary_access_path": family.get("primary_access_path"),
        }
        for family_id, family in sorted(families_by_id.items())
    ]

    return {
        "schema_version": "hushh.runtime_topology_index.v1",
        "purpose": "Generated, metadata-only maintenance index joining route, cache, native, action, agent, database-family, and compatibility contracts. It is not executable authority.",
        "source_sha256": {
            name: source_digest(path) for name, path in sorted(INPUTS.items())
        },
        "summary": {
            "physical_routes": len(route_rows),
            "semantic_routes": len(semantic_by_id),
            "aliases": len(aliases_by_path),
            "actions": len(actions_by_id),
            "agents": len(agent_rows),
            "a2a_scope_gated_agents": sum(
                1 for wiring in runtime_wiring.values() if wiring["a2a_scope"] is not None
            ),
            "in_process_specialists": sum(
                1 for wiring in runtime_wiring.values() if wiring["in_process_dispatch"]
            ),
            "one_specialist_tools": sum(
                1 for wiring in runtime_wiring.values() if wiring["one_specialist_tool"] is not None
            ),
            "table_families": len(table_family_rows),
            "decision_required": len(findings),
        },
        "maintenance_profiles": [profiles_by_id[key] for key in sorted(profiles_by_id)],
        "routes": route_rows,
        "agents": agent_rows,
        "database_families": table_family_rows,
        "compatibility_surfaces": [compatibility_by_id[key] for key in sorted(compatibility_by_id)],
        "database_retirements": [retirements_by_table[key] for key in sorted(retirements_by_table)],
        "findings": findings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail when the checked-in generated index is stale")
    parser.add_argument("--profile", help="print one declared maintenance profile and exit")
    args = parser.parse_args()

    payload = build_index()
    if args.profile:
        profiles = {profile["id"]: profile for profile in payload["maintenance_profiles"]}
        profile = profiles.get(args.profile)
        if profile is None:
            available = ", ".join(sorted(profiles))
            raise SystemExit(f"unknown maintenance profile {args.profile!r}; choose one of: {available}")
        print(stable_json(profile), end="")
        return 0

    rendered = stable_json(payload)
    if args.check:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != rendered:
            print(
                f"runtime topology index is stale: {OUTPUT.relative_to(REPO_ROOT)}. "
                "Run python3 scripts/ops/generate_runtime_topology_index.py.",
                file=sys.stderr,
            )
            return 1
        print(
            "Runtime topology index is current "
            f"({payload['summary']['physical_routes']} routes, "
            f"{payload['summary']['agents']} agents, "
            f"{payload['summary']['table_families']} table families)."
        )
        return 0

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(rendered, encoding="utf-8")
    print(f"Generated {OUTPUT.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
