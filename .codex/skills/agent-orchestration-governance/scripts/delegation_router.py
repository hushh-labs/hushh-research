#!/usr/bin/env python3
"""Recommend repo-scoped read-only subagent lanes from prompt intent or changed paths."""

from __future__ import annotations

import argparse
import json
from collections import OrderedDict
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError as exc:  # pragma: no cover
    raise SystemExit(f"tomllib is required: {exc}") from exc


DEFAULT_ROOT = Path(__file__).resolve().parents[4]
AGENTS_DIR = Path(".codex/agents")
WORKFLOWS_DIR = Path(".codex/workflows")
REPO_GLOBAL_AUTO_SPAWN_MARKER = "repo_global_auto_spawn"
REPO_INTENT_LANE_MATCH_MARKER = "repo_intent_lane_match"

PARENT_ONLY_TERMS = {
    "approve",
    "approval",
    "merge",
    "queue",
    "deploy",
    "push",
    "force-push",
    "credential",
    "secret",
    "branch switch",
    "checkout",
}

LANE_RULES: tuple[dict[str, Any], ...] = (
    {
        "agent": "analytics_observability_architect",
        "terms": (
            "analytics",
            "observability",
            "ga4",
            "firebase analytics",
            "bigquery",
            "growth dashboard",
            "datalayer",
            "gtag",
            "event taxonomy",
            "measurement id",
            "kpi",
            "metric",
        ),
        "path_prefixes": (
            "docs/reference/operations/observability",
            "docs/reference/quality/analytics",
            "hushh-webapp/lib/observability/",
            "hushh-webapp/__tests__/services/observability",
            "hushh-webapp/scripts/testing/run-observability",
            "hushh-webapp/scripts/testing/run-uat-analytics",
            "consent-protocol/scripts/observability/",
            "deploy/observability/",
        ),
        "evidence_target": "analytics event contract, telemetry topology, dashboard proof, and governed smoke coverage",
    },
    {
        "agent": "repo_operator",
        "terms": (
            "ci",
            "workflow",
            "deploy",
            "uat",
            "production",
            "queue",
            "dco",
            "smoke",
            "vercel",
            "cloud run",
            "release",
        ),
        "path_prefixes": (
            ".github/",
            "scripts/ci/",
            "deploy/",
            "config/ci-governance.json",
        ),
        "evidence_target": "CI/deploy/merge-chain state and environment parity",
    },
    {
        "agent": "rca_investigator",
        "terms": (
            "rca",
            "root cause",
            "incident",
            "crash",
            "failed",
            "failing",
            "regression",
            "error",
        ),
        "path_prefixes": (),
        "evidence_target": "failure boundary, blast radius, and smallest safe remediation",
    },
    {
        "agent": "backend_architect",
        "terms": (
            "backend",
            "api",
            "api route",
            "fastapi",
            "service boundary",
            "proxy",
            "schema",
            "migration",
            "database",
        ),
        "path_prefixes": (
            "consent-protocol/api/",
            "consent-protocol/hushh_mcp/",
            "consent-protocol/db/",
            "packages/",
        ),
        "evidence_target": "backend route, service, proxy, schema, and caller contract",
    },
    {
        "agent": "data_model_architect",
        "terms": (
            "data model",
            "schema",
            "migration",
            "database",
            "db",
            "release manifest",
            "uat schema",
            "runtime-db",
            "pkm_index",
            "pkm_blobs",
            "pkm_manifests",
            "cloud projection",
            "local-first",
            "cache coherence",
        ),
        "path_prefixes": (
            "consent-protocol/db/",
            "docs/reference/architecture/data-model",
            "docs/reference/architecture/runtime-db",
            "scripts/ops/data_model_audit.py",
            "tmp/uat-runtime-parity",
        ),
        "evidence_target": "schema contract, migration readiness, UAT parity, and local-first data authority",
    },
    {
        "agent": "frontend_architect",
        "terms": (
            "frontend",
            "ui",
            "route",
            "navigation",
            "onboarding",
            "shell",
            "component",
            "layout",
            "playwright",
        ),
        "path_prefixes": (
            "hushh-webapp/app/",
            "hushh-webapp/components/",
            "hushh-webapp/lib/",
            "hushh-webapp/playwright",
        ),
        "evidence_target": "route reachability, shell integrity, component ownership, and browser-flow proof",
    },
    {
        "agent": "mobile_native_architect",
        "terms": (
            "mobile",
            "native",
            "ios",
            "android",
            "capacitor",
            "xcode",
            "swift",
            "kotlin",
            "app store",
            "plugin registration",
            "native bridge",
        ),
        "path_prefixes": (
            "hushh-webapp/ios/",
            "hushh-webapp/android/",
            "docs/reference/mobile/",
            "hushh-webapp/scripts/native/",
        ),
        "evidence_target": "iOS/Android parity, Capacitor bridge safety, and native release readiness",
    },
    {
        "agent": "security_consent_auditor",
        "terms": (
            "security",
            "consent",
            "iam",
            "vault",
            "pkm",
            "privacy",
            "token",
            "scope",
            "byok",
            "on-device",
            "cache",
        ),
        "path_prefixes": (
            "docs/reference/iam/",
            "consent-protocol/hushh_mcp/consent/",
            "consent-protocol/api/routes/consent",
            "consent-protocol/api/routes/pkm",
            "hushh-webapp/lib/vault/",
            "hushh-webapp/lib/pkm/",
            "hushh-webapp/components/vault/",
        ),
        "evidence_target": "trust boundary, consent authority, vault/PKM safety, and cache coherence",
    },
    {
        "agent": "voice_systems_architect",
        "terms": (
            "voice",
            "speech",
            "dictation",
            "action gateway",
            "action_id",
            "typed search",
            "orchestrator",
            "manifest",
        ),
        "path_prefixes": (
            "contracts/kai/",
            "hushh-webapp/lib/voice/",
            "hushh-webapp/scripts/voice/",
            "hushh-webapp/components/kai/",
            "consent-protocol/hushh_mcp/services/voice",
            "consent-protocol/api/routes/kai/voice",
        ),
        "evidence_target": "generated action contracts, voice runtime state, and typed-search parity",
    },
    {
        "agent": "product_docs_architect",
        "terms": (
            "docs",
            "documentation",
            "founder",
            "vision",
            "roadmap",
            "future",
            "ontology",
            "hussh",
            "agent one",
            "one/nav",
            "one kai nav",
            "community",
            "discord",
            "copy",
        ),
        "path_prefixes": (
            "docs/vision/",
            "docs/future/",
            "docs/reference/kai/",
            "docs/reference/architecture/founder-language",
            "docs/reference/quality/app-surface-design-system",
            ".codex/skills/docs-governance/",
            ".codex/skills/founder-brief-curation/",
            ".codex/skills/future-planner/",
            ".codex/skills/comms-community/",
        ),
        "evidence_target": "canonical product language, docs placement, current/future-state boundary, and founder-copy drift",
    },
    {
        "agent": "reviewer",
        "terms": (
            "review",
            "pr",
            "pull request",
            "regression",
            "duplicate",
            "tests",
            "risk",
            "governance",
        ),
        "path_prefixes": (
            ".codex/",
            "tests/",
            "hushh-webapp/__tests__/",
            "consent-protocol/tests/",
        ),
        "evidence_target": "correctness, regression risk, duplicate paths, and missing proof",
    },
)


def _load_toml(path: Path) -> dict[str, Any]:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def _load_agents(root: Path) -> dict[str, dict[str, Any]]:
    agents: dict[str, dict[str, Any]] = {}
    for path in sorted((root / AGENTS_DIR).glob("*.toml")):
        payload = _load_toml(path)
        name = payload.get("name") or path.stem
        agents[str(name)] = payload
    return agents


def _load_workflow(root: Path, workflow_id: str | None) -> dict[str, Any]:
    if not workflow_id:
        return {}
    path = root / WORKFLOWS_DIR / workflow_id / "workflow.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _terms_match(text: str, terms: tuple[str, ...]) -> list[str]:
    lowered = text.lower()
    return [term for term in terms if term in lowered]


def _paths_match(paths: list[str], prefixes: tuple[str, ...]) -> list[str]:
    return [
        path
        for path in paths
        if any(path == prefix.rstrip("/") or path.startswith(prefix) for prefix in prefixes)
    ]


def _workflow_allows_auto_spawn(workflow: dict[str, Any], workflow_id: str | None) -> tuple[bool, str]:
    policy = workflow.get("delegation_policy")
    if isinstance(policy, dict):
        return bool(policy.get("auto_spawn_read_only_evidence_lanes")), "workflow delegation_policy"
    if workflow_id and workflow:
        return True, REPO_GLOBAL_AUTO_SPAWN_MARKER
    return False, "no workflow policy"


def route_delegation(
    root: Path,
    prompt: str,
    paths: list[str],
    workflow_id: str | None,
    phase: str,
) -> OrderedDict[str, Any]:
    agents = _load_agents(root)
    workflow = _load_workflow(root, workflow_id)
    text = prompt.lower()
    parent_only_hits = sorted(term for term in PARENT_ONLY_TERMS if term in text)
    auto_allowed, auto_source = _workflow_allows_auto_spawn(workflow, workflow_id)
    lanes: list[OrderedDict[str, Any]] = []

    for rule in LANE_RULES:
        term_hits = _terms_match(prompt, rule["terms"])
        path_hits = _paths_match(paths, rule["path_prefixes"])
        if not term_hits and not path_hits:
            continue
        agent_name = rule["agent"]
        agent = agents.get(agent_name, {})
        lanes.append(
            OrderedDict(
                agent=agent_name,
                reasoning_effort=agent.get("default_reasoning_effort", "high"),
                sandbox_mode=agent.get("sandbox_mode", "read-only"),
                evidence_target=rule["evidence_target"],
                prompt_signals=term_hits,
                path_signals=path_hits,
            )
        )

    if len(lanes) >= 3 and "governor" in agents:
        lanes.insert(
            0,
            OrderedDict(
                agent="governor",
                reasoning_effort=agents["governor"].get("default_reasoning_effort", "xhigh"),
                sandbox_mode=agents["governor"].get("sandbox_mode", "read-only"),
                evidence_target="cross-lane synthesis after specialist evidence returns",
                prompt_signals=["multi-lane"],
                path_signals=[],
            ),
        )

    user_delegation_intent = (
        "subagent" in text
        or "delegate" in text
        or "parallel" in text
        or "agent" in text
    )
    intent_lane_match = bool(lanes)
    effective_auto_allowed = auto_allowed or intent_lane_match
    should_delegate = bool(lanes) and (
        effective_auto_allowed
        or user_delegation_intent
    )
    if not auto_allowed and intent_lane_match and not user_delegation_intent:
        auto_source = REPO_INTENT_LANE_MATCH_MARKER

    reasons: list[str] = []
    if should_delegate:
        reasons.append(f"{auto_source} or user intent allows read-only evidence lanes")
        if phase == "mid":
            reasons.append("mid-execution checkpoint found a specialist evidence lane")
    elif lanes:
        reasons.append("specialist lane detected, but workflow/user authorization is not present or parent-only action dominates")
    else:
        reasons.append("no specialist evidence lane detected")
    if parent_only_hits:
        reasons.append(f"parent-only action terms present: {', '.join(parent_only_hits)}")

    return OrderedDict(
        schema_version="agent-delegation-router.v1",
        phase=phase,
        workflow=workflow_id or "",
        auto_spawn_authorized=effective_auto_allowed,
        auto_spawn_source=auto_source,
        should_delegate=should_delegate,
        parent_authority="branch, patch, approval, merge, deploy, secrets, and final decision remain parent-only",
        reasons=reasons,
        lanes=lanes,
    )


def _text(payload: dict[str, Any]) -> str:
    lines = [
        "Delegation router",
        f"Phase: {payload['phase']}",
        f"Workflow: {payload['workflow'] or 'none'}",
        f"Auto-spawn authorized: {payload['auto_spawn_authorized']}",
        f"Auto-spawn source: {payload['auto_spawn_source']}",
        f"Should delegate: {payload['should_delegate']}",
        f"Parent authority: {payload['parent_authority']}",
        "Reasons:",
    ]
    lines.extend(f"- {reason}" for reason in payload["reasons"])
    lines.append("Lanes:")
    if payload["lanes"]:
        for lane in payload["lanes"]:
            lines.append(
                f"- {lane['agent']} ({lane['reasoning_effort']}, {lane['sandbox_mode']}): {lane['evidence_target']}"
            )
    else:
        lines.append("- none")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Route prompt/path intent to repo-scoped evidence subagents.")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--workflow", help="Workflow id, for example pr-governance-review.")
    parser.add_argument("--phase", choices=("start", "mid"), default="start")
    parser.add_argument("--prompt", default="")
    parser.add_argument("--paths", default="", help="Comma-separated changed or implicated paths.")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    paths = [item.strip() for item in args.paths.split(",") if item.strip()]
    payload = route_delegation(
        root=args.root.resolve(),
        prompt=args.prompt,
        paths=paths,
        workflow_id=args.workflow,
        phase=args.phase,
    )
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(_text(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
