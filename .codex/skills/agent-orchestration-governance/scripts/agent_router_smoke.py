#!/usr/bin/env python3
"""Smoke-test repo-global delegation router behavior."""

from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
from typing import Any


DEFAULT_ROOT = Path(__file__).resolve().parents[4]
ROUTER_PATH = DEFAULT_ROOT / ".codex/skills/agent-orchestration-governance/scripts/delegation_router.py"


def _load_router() -> Any:
    spec = importlib.util.spec_from_file_location("delegation_router", ROUTER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load router from {ROUTER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SCENARIOS: tuple[dict[str, Any], ...] = (
    {
        "name": "frontend-vault-feature",
        "workflow": "new-feature-tri-flow",
        "phase": "start",
        "prompt": "implement a profile route change touching vault cache and frontend loading states",
        "paths": [
            "hushh-webapp/app/profile/page.tsx",
            "hushh-webapp/lib/vault/cache.ts",
        ],
        "required_agents": {"frontend_architect", "security_consent_auditor", "reviewer"},
        "forbidden_agents": {"backend_architect"},
        "should_delegate": True,
    },
    {
        "name": "api-contract-cross-surface",
        "workflow": "api-contract-change",
        "phase": "start",
        "prompt": "change backend API route response contract and Next proxy caller",
        "paths": [
            "consent-protocol/api/routes/account.py",
            "hushh-webapp/app/api/account/export/route.ts",
        ],
        "required_agents": {"backend_architect", "frontend_architect", "reviewer"},
        "forbidden_agents": set(),
        "should_delegate": True,
    },
    {
        "name": "data-model-uat-parity",
        "workflow": "data-model-audit",
        "phase": "start",
        "prompt": "review migration and UAT schema parity for PKM projection",
        "paths": [
            "consent-protocol/db/migrations/example.sql",
            "docs/reference/architecture/data-model-governance.md",
        ],
        "required_agents": {
            "data_model_architect",
            "backend_architect",
            "security_consent_auditor",
            "reviewer",
        },
        "forbidden_agents": {"product_docs_architect"},
        "should_delegate": True,
    },
    {
        "name": "product-docs-ontology",
        "workflow": "docs-sync",
        "phase": "start",
        "prompt": "update founder docs for One Kai Nav ontology and roadmap wording",
        "paths": [
            "docs/vision/agent-ontology.md",
            "docs/future/one-nav-runtime-plan.md",
        ],
        "required_agents": {"product_docs_architect"},
        "forbidden_agents": {"data_model_architect"},
        "should_delegate": True,
    },
    {
        "name": "release-readiness-parent-only-action",
        "workflow": "release-readiness",
        "phase": "start",
        "prompt": "verify UAT deploy, Cloud Run smoke, and release readiness",
        "paths": [
            ".github/workflows/deploy-uat.yml",
            "deploy/backend.cloudbuild.yaml",
            "scripts/ci/verify_uat_release.py",
        ],
        "required_agents": {"repo_operator"},
        "forbidden_agents": set(),
        "should_delegate": True,
    },
    {
        "name": "gmail-push-notifications-not-git-push",
        "workflow": "one-email-kyc-hardening",
        "phase": "start",
        "prompt": "verify One Gmail push notifications and encrypted draft storage caveats",
        "paths": [
            "consent-protocol/hushh_mcp/services/one_email_kyc_service.py",
            "docs/future/one-email-intake-roadmap.md",
        ],
        "required_agents": {
            "backend_architect",
            "security_consent_auditor",
            "product_docs_architect",
        },
        "forbidden_agents": set(),
        "should_delegate": True,
        "forbidden_parent_only_hits": {"push"},
    },
    {
        "name": "analytics-observability",
        "workflow": "analytics-observability-review",
        "phase": "start",
        "prompt": "verify GA4 event taxonomy and BigQuery dashboard contract",
        "paths": [
            "hushh-webapp/lib/observability/events.ts",
            "docs/reference/operations/observability-event-matrix.md",
        ],
        "required_agents": {"analytics_observability_architect"},
        "forbidden_agents": set(),
        "should_delegate": True,
    },
    {
        "name": "mobile-native-parity",
        "workflow": "mobile-parity-check",
        "phase": "start",
        "prompt": "audit iOS Android Capacitor native parity for vault unlock",
        "paths": [
            "hushh-webapp/ios/App/App/AppDelegate.swift",
            "hushh-webapp/android/app/build.gradle",
        ],
        "required_agents": {"mobile_native_architect"},
        "forbidden_agents": set(),
        "should_delegate": True,
    },
    {
        "name": "trivial-no-workflow",
        "workflow": None,
        "phase": "start",
        "prompt": "show the current branch",
        "paths": [],
        "required_agents": set(),
        "forbidden_agents": set(),
        "should_delegate": False,
    },
    {
        "name": "no-workflow-specialist-intent",
        "workflow": None,
        "phase": "start",
        "prompt": "investigate vault cache loading on the profile UI",
        "paths": [
            "hushh-webapp/app/profile/page.tsx",
            "hushh-webapp/lib/vault/cache.ts",
        ],
        "required_agents": {"frontend_architect", "security_consent_auditor"},
        "forbidden_agents": {"backend_architect"},
        "should_delegate": True,
    },
)


def _agent_names(payload: dict[str, Any]) -> set[str]:
    return {str(lane["agent"]) for lane in payload.get("lanes", [])}


def run(root: Path) -> list[str]:
    router = _load_router()
    errors: list[str] = []
    for scenario in SCENARIOS:
        payload = router.route_delegation(
            root=root,
            prompt=scenario["prompt"],
            paths=scenario["paths"],
            workflow_id=scenario["workflow"],
            phase=scenario["phase"],
        )
        agents = _agent_names(payload)
        missing = scenario["required_agents"] - agents
        forbidden = scenario["forbidden_agents"] & agents
        if bool(payload["should_delegate"]) is not scenario["should_delegate"]:
            errors.append(
                f"{scenario['name']}: expected should_delegate={scenario['should_delegate']}, got {payload['should_delegate']}"
            )
        forbidden_parent_only_hits = scenario.get("forbidden_parent_only_hits", set())
        if forbidden_parent_only_hits:
            reasons = "\n".join(str(reason) for reason in payload.get("reasons", []))
            unexpected = {
                hit for hit in forbidden_parent_only_hits if f"parent-only action terms present: {hit}" in reasons
            }
            if unexpected:
                errors.append(
                    f"{scenario['name']}: unexpected parent-only hits: {', '.join(sorted(unexpected))}"
                )
        if missing:
            errors.append(f"{scenario['name']}: missing required agents: {', '.join(sorted(missing))}")
        if forbidden:
            errors.append(f"{scenario['name']}: unexpected agents: {', '.join(sorted(forbidden))}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke-test delegation router scenarios.")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args()
    errors = run(args.root.resolve())
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print(f"Agent router smoke passed: {len(SCENARIOS)} scenarios")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
