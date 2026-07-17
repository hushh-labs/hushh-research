#!/usr/bin/env python3
"""Select release verification lanes from a proven changed-SHA range.

This is the only selector for expensive PKM and reviewer-browser release lanes.
UAT compares the target with the deployed service SHAs; PR, queue, and post-merge
checks pass one verified base SHA for both services.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from dataclasses import dataclass
from pathlib import PurePosixPath


def _normalize(raw: str) -> str:
    value = str(raw or "").strip().replace("\\", "/")
    if not value:
        return ""
    normalized = PurePosixPath(value).as_posix()
    return normalized[2:] if normalized.startswith("./") else normalized


def _git_diff(base_sha: str, target_sha: str) -> set[str]:
    if not base_sha or not target_sha or base_sha == target_sha:
        return set()
    result = subprocess.run(
        ["git", "diff", "--name-only", f"{base_sha}..{target_sha}"],
        check=True,
        capture_output=True,
        text=True,
    )
    return {_normalize(item) for item in result.stdout.splitlines() if _normalize(item)}


def _is_pkm_upgrade(path: str) -> bool:
    return (
        path in {
            "consent-protocol/hushh_mcp/services/pkm_upgrade_service.py",
            "consent-protocol/hushh_mcp/services/personal_knowledge_model_service.py",
            "consent-protocol/scripts/eval_pkm_structure_agent.py",
            "consent-protocol/db/verify/pkm_v7_zero_loss_rehearsal.sql",
            "scripts/ci/run-candidate-pkm-structure-agent-eval.sh",
        }
        or path.startswith(
            (
                "hushh-webapp/lib/services/pkm-upgrade-",
                "hushh-webapp/__tests__/services/pkm-upgrade-",
                "hushh-webapp/__tests__/services/pkm-historical-rehearsal",
                "hushh-webapp/__tests__/services/financial-v7-reader-compatibility",
                "consent-protocol/tests/test_pkm_upgrade_",
                ".codex/skills/pkm-upgrade-rehearsal/",
                ".codex/workflows/pkm-upgrade-rehearsal/",
            )
        )
        or (
            path.startswith("consent-protocol/db/migrations/")
            and "pkm" in path.lower()
        )
    )


def _is_reviewer_byok(path: str) -> bool:
    return path.startswith(".codex/skills/reviewer-app-testing/") or path.startswith(
        (
            "hushh-webapp/components/app-ui/native-test-",
            "hushh-webapp/lib/testing/",
            "hushh-webapp/lib/vault/",
            "hushh-webapp/components/vault/",
            "consent-protocol/api/routes/vault",
            "consent-protocol/hushh_mcp/services/vault_",
        )
    ) or path in {
        "hushh-webapp/scripts/testing/reviewer-test-identity.mjs",
        "hushh-webapp/lib/services/vault-service.ts",
        "consent-protocol/api/routes/app_review.py",
    }


@dataclass(frozen=True)
class VerificationPlan:
    changed_files: tuple[str, ...]
    pkm_evaluator_runs: int
    run_pkm_upgrade_gate: bool
    run_reviewer_byok: bool
    reason: str

    def as_dict(self) -> dict[str, object]:
        requires_web_dependencies = self.run_pkm_upgrade_gate or self.run_reviewer_byok
        lanes = {
            "pkm_upgrade": {
                "required": self.run_pkm_upgrade_gate,
                "reason": "pkm_upgrade_contract_changed"
                if self.run_pkm_upgrade_gate
                else "no_pkm_upgrade_contract_changed",
            },
            "reviewer_byok": {
                "required": self.run_reviewer_byok,
                "reason": "vault_or_reviewer_contract_changed"
                if self.run_reviewer_byok
                else "no_vault_or_reviewer_contract_changed",
            },
        }
        if self.reason.startswith("conservative:"):
            for lane in lanes.values():
                lane["required"] = True
                lane["reason"] = "comparison_base_unproven_fail_closed"
        return {
            "schema_version": 1,
            "changed_files": list(self.changed_files),
            "pkm_evaluator_runs": self.pkm_evaluator_runs,
            "run_pkm_upgrade_gate": self.run_pkm_upgrade_gate,
            "run_reviewer_byok": self.run_reviewer_byok,
            "requires_web_dependencies": requires_web_dependencies,
            "reason": self.reason,
            "lanes": lanes,
        }


def resolve_plan(
    *,
    target_sha: str,
    backend_base_sha: str,
    frontend_base_sha: str,
    deploy_backend: bool,
    deploy_frontend: bool,
) -> VerificationPlan:
    missing_base = (deploy_backend and not backend_base_sha) or (
        deploy_frontend and not frontend_base_sha
    )
    if missing_base:
        return VerificationPlan((), 1, True, True, "conservative:comparison_base_unproven")

    changed: set[str] = set()
    try:
        if deploy_backend:
            changed.update(_git_diff(backend_base_sha, target_sha))
        if deploy_frontend:
            changed.update(_git_diff(frontend_base_sha, target_sha))
    except subprocess.CalledProcessError:
        return VerificationPlan((), 1, True, True, "conservative:comparison_base_unproven")

    pkm_upgrade = any(_is_pkm_upgrade(path) for path in changed)
    evaluator_runs = 1 if pkm_upgrade else 0
    reviewer_byok = any(_is_reviewer_byok(path) for path in changed)
    active = [
        name
        for name, enabled in (
            ("pkm_upgrade", pkm_upgrade),
            ("reviewer_byok", reviewer_byok),
        )
        if enabled
    ]
    return VerificationPlan(
        tuple(sorted(changed)),
        evaluator_runs,
        pkm_upgrade,
        reviewer_byok,
        f"changed_paths:{','.join(active) if active else 'standard'}",
    )


def _bool(raw: str) -> bool:
    return str(raw).strip().lower() == "true"


def _write_outputs(path: str, payload: dict[str, object]) -> None:
    with open(path, "a", encoding="utf-8") as handle:
        for key, value in payload.items():
            if isinstance(value, (list, dict)):
                rendered = json.dumps(value, sort_keys=True, separators=(",", ":"))
            elif isinstance(value, bool):
                rendered = str(value).lower()
            else:
                rendered = value
            handle.write(f"{key}={rendered}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-sha", required=True)
    parser.add_argument("--base-sha", default="", help="Verified shared comparison base for CI/queue/smoke.")
    parser.add_argument("--backend-base-sha", default="")
    parser.add_argument("--frontend-base-sha", default="")
    parser.add_argument("--deploy-backend", default="true")
    parser.add_argument("--deploy-frontend", default="true")
    parser.add_argument("--github-output", default="")
    parser.add_argument("--json-output", default="")
    args = parser.parse_args()
    shared_base = args.base_sha.strip()
    plan = resolve_plan(
        target_sha=args.target_sha.strip(),
        backend_base_sha=shared_base or args.backend_base_sha.strip(),
        frontend_base_sha=shared_base or args.frontend_base_sha.strip(),
        deploy_backend=_bool(args.deploy_backend),
        deploy_frontend=_bool(args.deploy_frontend),
    )
    payload = plan.as_dict()
    if args.github_output:
        _write_outputs(args.github_output, payload)
    if args.json_output:
        with open(args.json_output, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
