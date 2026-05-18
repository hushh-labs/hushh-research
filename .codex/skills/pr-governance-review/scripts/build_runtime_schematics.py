#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[4]


def _read_json(path: Path) -> Any | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return None


def _path(path: Path) -> str:
    return path.relative_to(REPO_ROOT).as_posix()


def _existing(paths: list[str]) -> list[str]:
    return [path for path in paths if (REPO_ROOT / path).exists()]


def _skill_payloads() -> list[dict[str, Any]]:
    skills: list[dict[str, Any]] = []
    for path in sorted((REPO_ROOT / ".codex/skills").glob("*/skill.json")):
        payload = _read_json(path)
        if not isinstance(payload, dict):
            continue
        skills.append(
            OrderedDict(
                id=payload.get("id") or path.parent.name,
                path=_path(path),
                description=payload.get("description", ""),
                owned_paths=payload.get("owned_paths", []),
                required_reads=payload.get("required_reads", []),
                required_commands=payload.get("required_commands", []),
                risk_tags=payload.get("risk_tags", []),
                handoff_targets=payload.get("handoff_targets", []),
            )
        )
    return skills


def _workflow_payloads() -> list[dict[str, Any]]:
    workflows: list[dict[str, Any]] = []
    for path in sorted((REPO_ROOT / ".codex/workflows").glob("*/workflow.json")):
        payload = _read_json(path)
        if not isinstance(payload, dict):
            continue
        workflows.append(
            OrderedDict(
                id=payload.get("id") or path.parent.name,
                path=_path(path),
                owner_skill=payload.get("owner_skill"),
                affected_surfaces=payload.get("affected_surfaces", []),
                required_reads=payload.get("required_reads", []),
                required_commands=payload.get("required_commands", []),
            )
        )
    return workflows


def _skill_by_id(skills: list[dict[str, Any]], skill_id: str) -> dict[str, Any]:
    for skill in skills:
        if skill.get("id") == skill_id:
            return skill
    return OrderedDict(id=skill_id, owned_paths=[], required_reads=[], required_commands=[], risk_tags=[])


def _voice_family(skills: list[dict[str, Any]]) -> OrderedDict[str, Any]:
    root_gateway = REPO_ROOT / "contracts/kai/kai-action-gateway.vnext.json"
    root_manifest = REPO_ROOT / "contracts/kai/voice-action-manifest.v1.json"
    web_contracts = sorted(REPO_ROOT.glob("hushh-webapp/**/*.voice-action-contract.json"))
    gateway = _read_json(root_gateway) or {}
    manifest = _read_json(root_manifest) or {}
    skill = _skill_by_id(skills, "kai-voice-governance")
    source_contracts = gateway.get("source_contracts") if isinstance(gateway, dict) else []
    generated_artifacts = _existing(
        [
            "contracts/kai/kai-action-gateway.vnext.json",
            "contracts/kai/voice-action-manifest.v1.json",
            "hushh-webapp/contracts/kai/kai-action-gateway.vnext.json",
            "hushh-webapp/contracts/kai/voice-action-manifest.v1.json",
        ]
    )
    return OrderedDict(
        id="voice-action-runtime",
        owner_skill=skill.get("id"),
        source_contracts=[_path(path) for path in web_contracts],
        generated_artifacts=generated_artifacts,
        generated_action_count=len(gateway.get("actions", [])) if isinstance(gateway, dict) else 0,
        manifest_action_count=len(manifest.get("actions", [])) if isinstance(manifest, dict) else 0,
        gateway_source_contracts=source_contracts if isinstance(source_contracts, list) else [],
        runtime_sources=_existing(
            [
                "hushh-webapp/lib/voice/kai-action-gateway.ts",
                "hushh-webapp/lib/voice/voice-action-dispatcher.ts",
                "hushh-webapp/lib/voice/voice-turn-orchestrator.ts",
                "hushh-webapp/lib/voice/voice-action-manifest.ts",
                "hushh-webapp/components/kai/voice/voice-console-sheet.tsx",
                "consent-protocol/hushh_mcp/services/voice_action_manifest.py",
                "consent-protocol/hushh_mcp/services/voice_intent_service.py",
            ]
        ),
        docs=skill.get("required_reads", []),
        verification_commands=[
            command
            for command in skill.get("required_commands", [])
            if "voice" in command or "typecheck" in command
        ],
        risk_tags=skill.get("risk_tags", []),
    )


def _db_family() -> OrderedDict[str, Any]:
    manifest_path = REPO_ROOT / "consent-protocol/db/release_migration_manifest.json"
    manifest = _read_json(manifest_path) or {}
    contracts = sorted(REPO_ROOT.glob("consent-protocol/db/contracts/*.json"))
    migrations = sorted(REPO_ROOT.glob("consent-protocol/db/migrations/*.sql"))
    return OrderedDict(
        id="db-release-contract",
        manifest=_path(manifest_path) if manifest_path.exists() else "",
        ordered_migrations=manifest.get("ordered_migrations", []) if isinstance(manifest, dict) else [],
        migration_groups=manifest.get("groups", {}) if isinstance(manifest, dict) else {},
        checked_schema_contracts=[_path(path) for path in contracts],
        migration_files=[_path(path) for path in migrations],
        latest_migration=_path(migrations[-1]) if migrations else "",
        verification_commands=[
            "./bin/hushh db verify-release-contract",
            "./bin/hushh db verify-uat-schema",
        ],
    )


def _route_family(skills: list[dict[str, Any]]) -> OrderedDict[str, Any]:
    app_route_contract = REPO_ROOT / "hushh-webapp/lib/navigation/app-route-layout.contract.json"
    route_contract = _read_json(app_route_contract)
    route_entries = 0
    if isinstance(route_contract, dict):
        routes = route_contract.get("routes")
        if isinstance(routes, list):
            route_entries = len(routes)
        elif isinstance(routes, dict):
            route_entries = len(routes)
    skill = _skill_by_id(skills, "frontend-architecture")
    return OrderedDict(
        id="route-shell-onboarding-runtime",
        owner_skill=skill.get("id"),
        route_sources=_existing(
            [
                "hushh-webapp/lib/navigation/routes.ts",
                "hushh-webapp/lib/navigation/app-route-layout.contract.json",
                "hushh-webapp/lib/navigation/app-route-layout.ts",
                "hushh-webapp/lib/observability/route-map.ts",
                "hushh-webapp/proxy.ts",
            ]
        ),
        contract_route_count=route_entries,
        docs=_existing(
            [
                "docs/reference/architecture/route-contracts.md",
                "docs/reference/quality/app-surface-design-system.md",
            ]
        ),
        verification_commands=[
            "cd hushh-webapp && npm run typecheck",
            "cd hushh-webapp && npm run test",
            "cd hushh-webapp && node scripts/testing/verify-signed-in-routes.mjs",
        ],
    )


def _family_from_skill(skill: dict[str, Any], family_id: str, extra_docs: list[str] | None = None) -> OrderedDict[str, Any]:
    return OrderedDict(
        id=family_id,
        owner_skill=skill.get("id"),
        owned_paths=skill.get("owned_paths", []),
        docs=_existing([*skill.get("required_reads", []), *(extra_docs or [])]),
        verification_commands=skill.get("required_commands", []),
        risk_tags=skill.get("risk_tags", []),
    )


def build_schematics() -> OrderedDict[str, Any]:
    skills = _skill_payloads()
    workflows = _workflow_payloads()
    ci = _read_json(REPO_ROOT / "config/ci-governance.json") or {}
    families = [
        _voice_family(skills),
        _family_from_skill(
            _skill_by_id(skills, "vault-pkm-governance"),
            "pkm-vault-runtime",
            [
                "docs/reference/architecture/cache-coherence.md",
                "consent-protocol/db/contracts/uat_integrated_schema.json",
            ],
        ),
        _family_from_skill(
            _skill_by_id(skills, "iam-consent-governance"),
            "consent-iam-runtime",
            [
                "consent-protocol/hushh_mcp/consent/token.py",
                "consent-protocol/hushh_mcp/consent/scope_bundles.py",
                "consent-protocol/hushh_mcp/constants.py",
            ],
        ),
        _family_from_skill(
            _skill_by_id(skills, "backend-api-contracts"),
            "backend-api-contract-runtime",
        ),
        _route_family(skills),
        _family_from_skill(
            _skill_by_id(skills, "kai-voice-governance"),
            "kai-finance-runtime",
            [
                "docs/reference/kai/kai-accuracy-contract.md",
                "docs/reference/kai/kai-change-impact-matrix.md",
                "docs/reference/streaming/streaming-contract.md",
                "consent-protocol/api/routes/kai/market_insights.py",
                "consent-protocol/api/routes/kai/stream.py",
                "hushh-webapp/lib/kai/kai-financial-resource.ts",
            ],
        ),
        _db_family(),
    ]
    return OrderedDict(
        schema_version="pr-governance-runtime-schematics.v1",
        generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        repo_root=str(REPO_ROOT),
        ci=OrderedDict(
            required_status_check=((ci.get("main") or {}).get("required_status_check") if isinstance(ci, dict) else None)
            or "CI Status Gate",
            merge_queue_required=bool((ci.get("main") or {}).get("merge_queue_required")) if isinstance(ci, dict) else False,
            required_post_merge_check=((ci.get("uat") or {}).get("required_post_merge_check") if isinstance(ci, dict) else None)
            or "",
            source="config/ci-governance.json" if (REPO_ROOT / "config/ci-governance.json").exists() else "fallback",
        ),
        governance=OrderedDict(
            skills_count=len(skills),
            workflows_count=len(workflows),
            agent_config="read-only evidence lanes; parent retains branch, merge, deploy, and approval authority",
        ),
        runtime_families=families,
        skills=skills,
        workflows=workflows,
    )


def _text_report(schematics: dict[str, Any]) -> str:
    lines = [
        "Project runtime schematics",
        f"Generated: {schematics['generated_at']}",
        f"Required status check: {schematics['ci']['required_status_check']} ({schematics['ci']['source']})",
        f"Skills/workflows indexed: {schematics['governance']['skills_count']} / {schematics['governance']['workflows_count']}",
        "Runtime families:",
    ]
    for family in schematics["runtime_families"]:
        owner = family.get("owner_skill") or "repo contract"
        sources = (
            family.get("source_contracts")
            or family.get("runtime_sources")
            or family.get("owned_paths")
            or family.get("route_sources")
            or family.get("checked_schema_contracts")
            or []
        )
        lines.append(f"- {family['id']} ({owner}): {len(sources)} current source(s)")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a repo-derived runtime schematics snapshot for PR governance.")
    parser.add_argument("--json", action="store_true", help="Emit JSON.")
    parser.add_argument("--text", action="store_true", help="Emit a compact text summary.")
    args = parser.parse_args()
    schematics = build_schematics()
    if args.text and not args.json:
        print(_text_report(schematics))
    else:
        print(json.dumps(schematics, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
