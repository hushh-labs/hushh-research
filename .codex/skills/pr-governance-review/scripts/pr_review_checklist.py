#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import OrderedDict
from itertools import combinations
from datetime import datetime, timezone
from pathlib import Path
import re
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[4]
SALVAGEABLE_HIGH_FINDINGS = {
    "backend_contract_without_caller_change",
    "dual_auth_dependency_overlap",
}
SALVAGEABLE_MEDIUM_FINDINGS = {
    "runtime_dependency_not_pinned_in_manifest",
    "ignore_surface_changed",
    "sensitive_runtime_change_without_supporting_proof",
    "marketplace_flow_overlap_on_main",
}
CONCEPT_RULES: tuple[dict[str, Any], ...] = (
    {
        "id": "parallel_decision_card_path",
        "severity": "high",
        "summary": (
            "PR introduces a second decision-card component family while main already has "
            "a Kai decision-card surface under the views path."
        ),
        "changed_any": [
            "hushh-webapp/components/kai/decision-card.tsx",
            "hushh-webapp/components/kai/decision-cards-grid.tsx",
        ],
        "main_paths": [
            "hushh-webapp/components/kai/views/decision-card.tsx",
        ],
    },
    {
        "id": "parallel_pkm_product_surface",
        "severity": "high",
        "summary": (
            "PR introduces a standalone PKM browsing route while main already has PKM "
            "exploration surfaces in profile or agent-lab flows."
        ),
        "changed_any": [
            "hushh-webapp/app/pkm-explorer/page.tsx",
        ],
        "main_paths": [
            "hushh-webapp/components/profile/pkm-explorer-panel.tsx",
            "hushh-webapp/app/profile/pkm-agent-lab/page-client.tsx",
        ],
    },
    {
        "id": "marketplace_flow_overlap_on_main",
        "severity": "medium",
        "summary": (
            "Marketplace advisory/request-entry flow already exists on main; review this PR "
            "as a delta extraction rather than a title-only merge."
        ),
        "changed_any": [
            "hushh-webapp/app/marketplace/page.tsx",
            "hushh-webapp/app/marketplace/ria/page-client.tsx",
        ],
        "main_contains": [
            {
                "path": "hushh-webapp/app/marketplace/page.tsx",
                "needle": "investor_advisor_disclosure_v1",
            },
            {
                "path": "hushh-webapp/app/marketplace/ria/page-client.tsx",
                "needle": "Continue browsing",
            },
        ],
    },
    {
        "id": "public_email_ingress_without_live_contract",
        "severity": "high",
        "summary": (
            "PR introduces a public inbound email ingress surface. Green CI is not enough; "
            "this requires explicit rollout, abuse-control, and authority-model review."
        ),
        "changed_any": [
            "consent-protocol/api/routes/email_agent.py",
        ],
    },
)

RELATED_SURFACE_RULES: tuple[dict[str, Any], ...] = (
    {
        "id": "ria_verification",
        "match_prefixes": (
            "consent-protocol/api/routes/ria.py",
            "consent-protocol/hushh_mcp/services/ria_iam_service.py",
            "consent-protocol/hushh_mcp/services/ria_verification.py",
            "hushh-webapp/app/ria/",
            "hushh-webapp/components/ria/",
        ),
        "files": (
            "consent-protocol/api/routes/ria.py",
            "consent-protocol/hushh_mcp/services/ria_iam_service.py",
            "consent-protocol/hushh_mcp/services/ria_verification.py",
            "hushh-webapp/app/ria/page.tsx",
        ),
        "docs": (
            "docs/reference/iam/architecture.md",
            "docs/reference/iam/runtime-surface.md",
            "docs/reference/iam/README.md",
        ),
    },
    {
        "id": "consent_handshake",
        "match_prefixes": (
            "consent-protocol/api/routes/consent.py",
            "consent-protocol/hushh_mcp/services/consent_center_service.py",
            "hushh-webapp/components/consent/",
            "hushh-webapp/lib/services/consent-center-service.ts",
        ),
        "files": (
            "consent-protocol/api/routes/consent.py",
            "consent-protocol/hushh_mcp/services/consent_center_service.py",
            "hushh-webapp/components/consent/consent-center-page.tsx",
            "hushh-webapp/components/consent/handshake-timeline.tsx",
            "hushh-webapp/lib/services/consent-center-service.ts",
        ),
        "docs": (
            "docs/reference/iam/architecture.md",
            "docs/reference/architecture/api-contracts.md",
            "consent-protocol/docs/reference/developer-api.md",
        ),
    },
    {
        "id": "consent_scope_bundles",
        "match_prefixes": (
            "consent-protocol/tests/test_scope_bundle_contract.py",
            "consent-protocol/hushh_mcp/consent/",
            "consent-protocol/mcp_modules/tools/consent_tools.py",
        ),
        "files": (
            "consent-protocol/hushh_mcp/consent/scope_bundles.py",
            "consent-protocol/mcp_modules/tools/consent_tools.py",
            "consent-protocol/tests/test_scope_bundle_contract.py",
        ),
        "docs": (
            "docs/reference/iam/consent-scope-catalog.md",
            "docs/reference/iam/architecture.md",
        ),
    },
    {
        "id": "marketplace_flow",
        "match_prefixes": (
            "hushh-webapp/app/marketplace/ria/",
            "hushh-webapp/lib/services/ria-service.ts",
        ),
        "files": (
            "hushh-webapp/app/marketplace/page.tsx",
            "hushh-webapp/app/marketplace/ria/page-client.tsx",
            "hushh-webapp/lib/services/ria-service.ts",
        ),
        "docs": (
            "docs/reference/iam/marketplace-contract.md",
            "docs/reference/architecture/route-contracts.md",
            "docs/reference/iam/architecture.md",
        ),
    },
    {
        "id": "portfolio_normalization",
        "match_prefixes": (
            "consent-protocol/hushh_mcp/kai_import/normalize_v2.py",
            "consent-protocol/tests/test_normalize_v2.py",
        ),
        "files": (
            "consent-protocol/hushh_mcp/kai_import/normalize_v2.py",
            "consent-protocol/tests/test_normalize_v2.py",
        ),
        "docs": (
            "docs/reference/architecture/api-contracts.md",
        ),
    },
    {
        "id": "frontend_credentials",
        "match_prefixes": (
            "hushh-webapp/lib/services/account-service.ts",
            "hushh-webapp/lib/notifications/fcm-service.ts",
        ),
        "files": (
            "hushh-webapp/lib/services/account-service.ts",
            "hushh-webapp/lib/notifications/fcm-service.ts",
        ),
        "docs": (
            "docs/reference/operations/env-and-secrets.md",
            "consent-protocol/docs/reference/fcm-notifications.md",
        ),
    },
    {
        "id": "email_kyc_future_plan",
        "match_prefixes": (
            "consent-protocol/api/routes/email_agent.py",
            "consent-protocol/hushh_mcp/services/email_agent_service.py",
        ),
        "files": (
            "consent-protocol/api/routes/email_agent.py",
            "consent-protocol/hushh_mcp/services/email_agent_service.py",
            "consent-protocol/api/routes/kai/support.py",
        ),
        "docs": (
            "docs/future/kai/email-kyc-pkm-assistant.md",
            "docs/reference/architecture/api-contracts.md",
        ),
    },
)

PATH_SUMMARIES: dict[str, str] = {
    "consent-protocol/api/routes/consent.py": "Route contract for consent lifecycle, relationship events, and timeline-facing APIs.",
    "consent-protocol/api/routes/ria.py": "Advisor-facing route surface that enforces RIA verification and access gating.",
    "consent-protocol/api/routes/email_agent.py": "Inbound email webhook surface proposed for Kai-owned email/KYC workflows.",
    "consent-protocol/api/routes/kai/support.py": "Existing support ingress used as the comparison point for shared transport primitives.",
    "consent-protocol/hushh_mcp/services/ria_iam_service.py": "Canonical RIA access-control service for verified access and relationship-scoped authorization.",
    "consent-protocol/hushh_mcp/services/ria_verification.py": "Verification policy service that determines whether an RIA is eligible for protected flows.",
    "consent-protocol/hushh_mcp/services/consent_center_service.py": "Consent-center aggregation layer that builds relationship and handshake history views.",
    "consent-protocol/hushh_mcp/services/email_agent_service.py": "Email agent orchestration layer behind the proposed inbound KYC flow.",
    "consent-protocol/hushh_mcp/services/support_email_service.py": "Current support-email execution path that may share transport primitives but not trust rules.",
    "consent-protocol/hushh_mcp/consent/scope_bundles.py": "Canonical scope bundle registry that defines reusable consent bundle grammar.",
    "consent-protocol/mcp_modules/tools/consent_tools.py": "Developer-facing consent tooling that consumes the canonical bundle registry.",
    "consent-protocol/hushh_mcp/kai_import/normalize_v2.py": "Portfolio normalization pipeline where numeric coercion and financial math safety are enforced.",
    "consent-protocol/tests/test_normalize_v2.py": "Regression coverage for portfolio number parsing and normalization edge cases.",
    "consent-protocol/tests/test_scope_bundle_contract.py": "Contract suite that guards scope bundle structure, wildcard matching, and cross-domain isolation.",
    "consent-protocol/docs/reference/developer-api.md": "Developer-facing contract reference for consent and runtime APIs.",
    "consent-protocol/docs/reference/env-vars.md": "Environment-variable contract for backend email and runtime configuration surfaces.",
    "consent-protocol/docs/reference/fcm-notifications.md": "Notification integration reference tied to the frontend FCM client logging surface.",
    "hushh-webapp/app/ria/page.tsx": "Top-level RIA surface that reflects verification and gated advisor flows.",
    "hushh-webapp/app/marketplace/page.tsx": "Marketplace investor entry surface for advisory request and persona-aware actions.",
    "hushh-webapp/app/marketplace/ria/page-client.tsx": "RIA public-profile browsing surface for verification-aware actions and request entry.",
    "hushh-webapp/app/pkm-explorer/page.tsx": "Standalone PKM route proposed by the rejected parallel product-surface PR.",
    "hushh-webapp/app/profile/pkm-agent-lab/page-client.tsx": "Existing PKM exploration surface that remains the canonical product path.",
    "hushh-webapp/components/profile/pkm-explorer-panel.tsx": "Reusable PKM browser panel already embedded in the current profile flow.",
    "hushh-webapp/lib/personal-knowledge-model/natural-language.ts": "Current natural-language PKM presentation layer used instead of a separate explorer route.",
    "hushh-webapp/components/consent/consent-center-page.tsx": "Consent-center UI shell that hosts relationship and handshake detail views.",
    "hushh-webapp/components/consent/handshake-timeline.tsx": "Timeline renderer for investor/RIA consent lifecycle events.",
    "hushh-webapp/lib/services/consent-center-service.ts": "Frontend service that calls the consent-center relationship and history APIs.",
    "hushh-webapp/lib/services/ria-service.ts": "Frontend RIA data service used by marketplace and advisor-facing flows.",
    "hushh-webapp/lib/services/account-service.ts": "Frontend account service where credential fragments were previously logged.",
    "hushh-webapp/lib/notifications/fcm-service.ts": "Frontend FCM client surface where notification-token fragments were previously logged.",
    "hushh-webapp/components/kai/decision-card.tsx": "Parallel decision-card component path introduced by the rejected duplicate-architecture PR.",
    "hushh-webapp/components/kai/views/decision-card.tsx": "Canonical Kai decision-card renderer used by the current product flow.",
    "hushh-webapp/components/kai/views/history-detail-view.tsx": "History detail surface that composes the canonical decision-card family.",
    "hushh-webapp/components/kai/debate-stream-view.tsx": "Streaming Kai surface that feeds into the canonical decision-card path.",
    "docs/reference/iam/architecture.md": "High-level IAM and consent architecture defining verified access and relationship boundaries.",
    "docs/reference/iam/runtime-surface.md": "Runtime ownership map for IAM routes and services.",
    "docs/reference/iam/README.md": "Index into the IAM reference set and canonical governance docs.",
    "docs/reference/iam/ria-verification-policy.md": "Policy reference for RIA verification and fail-closed gating behavior.",
    "docs/reference/iam/consent-scope-catalog.md": "Canonical catalog of consent scopes and scope-bundle semantics.",
    "docs/reference/iam/marketplace-contract.md": "Marketplace contract defining investor/RIA request-entry and persona-aware behavior.",
    "docs/reference/operations/env-and-secrets.md": "Operational contract for frontend and backend environment-secret handling.",
    "docs/reference/architecture/api-contracts.md": "System-level API contract reference for shared route semantics.",
    "docs/reference/architecture/route-contracts.md": "Frontend route and navigation contract reference for product surfaces.",
    "docs/reference/architecture/pkm-storage-adr.md": "ADR describing PKM storage and canonical product-surface assumptions.",
    "docs/reference/architecture/pkm-cutover-runbook.md": "Runbook for PKM product migration and current ownership path.",
    "docs/reference/kai/kai-interconnection-map.md": "High-level Kai subsystem map including the canonical decision-card surface.",
    "docs/reference/kai/kai-change-impact-matrix.md": "Kai change-governance matrix describing decision-card and stream-contract impacts.",
    "docs/future/kai/email-kyc-pkm-assistant.md": "Future-plan contract for Kai-owned email/KYC workflow and consent-scoped rollout.",
}


def _run(cmd: list[str]) -> str:
    completed = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or "command failed"
        raise RuntimeError(f"{' '.join(cmd)}: {message}")
    return completed.stdout


def _gh_json(repo: str, pr: int, fields: list[str]) -> dict[str, Any]:
    output = _run(
        [
            "gh",
            "pr",
            "view",
            str(pr),
            "--repo",
            repo,
            "--json",
            ",".join(fields),
        ]
    )
    return json.loads(output)


def _extract_summary(body: str | None) -> str:
    if not body:
        return ""
    text = body.strip()
    summary_match = re.search(
        r"^## Summary\s*(.*?)(?=^##\s|\Z)",
        text,
        flags=re.MULTILINE | re.DOTALL,
    )
    section = summary_match.group(1).strip() if summary_match else text
    lines: list[str] = []
    for raw_line in section.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        line = re.sub(r"^[-*]\s*", "", line)
        lines.append(line)
        if len(lines) == 3:
            break
    return " | ".join(lines)


def _extract_closed_issues(body: str | None) -> list[str]:
    if not body:
        return []
    return re.findall(r"(?:Closes|Close|Fixes|Fix|Resolves|Resolve)\s+#(\d+)", body, flags=re.IGNORECASE)


def _gh_diff_name_only(repo: str, pr: int) -> list[str]:
    output = _run(["gh", "pr", "diff", str(pr), "--repo", repo, "--name-only"])
    return [line.strip() for line in output.splitlines() if line.strip()]


def _gh_diff_patch(repo: str, pr: int) -> str:
    return _run(["gh", "pr", "diff", str(pr), "--repo", repo, "--patch", "--color=never"])


def _git_show_origin_main(path: str) -> str | None:
    completed = subprocess.run(
        ["git", "show", f"origin/main:{path}"],
        capture_output=True,
        text=True,
        check=False,
        cwd=REPO_ROOT,
    )
    if completed.returncode != 0:
        return None
    return completed.stdout


def _iso_or_empty(value: str | None) -> str:
    return value or ""


def _current_checks(status_check_rollup: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest_by_name: dict[str, dict[str, Any]] = {}
    for item in status_check_rollup:
        if item.get("__typename") != "CheckRun":
            continue
        name = item.get("name") or "unknown"
        current = latest_by_name.get(name)
        current_ts = max(_iso_or_empty(current.get("completedAt") if current else ""), _iso_or_empty(current.get("startedAt") if current else ""))
        candidate_ts = max(_iso_or_empty(item.get("completedAt")), _iso_or_empty(item.get("startedAt")))
        if current is None or candidate_ts >= current_ts:
            latest_by_name[name] = item
    return sorted(latest_by_name.values(), key=lambda item: item.get("name") or "")


def _surface_tags(files: list[str]) -> list[str]:
    tags: list[str] = []
    if any(path.startswith("consent-protocol/api/") for path in files):
        tags.append("backend-api")
    if any(path.startswith("hushh-webapp/lib/services/") or path.startswith("hushh-webapp/app/api/") for path in files):
        tags.append("frontend-caller")
    if any(path.startswith("deploy/") or path.endswith("Dockerfile") for path in files):
        tags.append("deploy-runtime")
    if any(path.endswith(".gitignore") for path in files):
        tags.append("ignore-surface")
    if any(path.startswith(".github/") or path.startswith("scripts/ci/") or path.startswith("config/") for path in files):
        tags.append("governance")
    if any("/tests/" in path or path.startswith("consent-protocol/tests/") or path.startswith("hushh-webapp/__tests__/") for path in files):
        tags.append("tests")
    if any(path.startswith("docs/") or path.startswith("consent-protocol/docs/") or path.startswith("hushh-webapp/docs/") for path in files):
        tags.append("docs")
    return tags


def _path_exists(path: str) -> bool:
    return (REPO_ROOT / path).exists()


def _github_blob_url(repo: str, ref: str, path: str) -> str:
    return f"https://github.com/{repo}/blob/{ref}/{path}"


def _github_link_ref(report: dict[str, Any], path: str) -> str:
    return "main" if _git_show_origin_main(path) is not None else report["pr"]["head_sha"]


def _markdown_path_link(repo: str, ref: str, path: str) -> str:
    return f"[`{path}`]({_github_blob_url(repo, ref, path)})"


def _path_summary(path: str) -> str:
    return PATH_SUMMARIES.get(path, "Related reviewed surface for this change.")


def _preferred_related_files(files: list[str], limit: int = 4) -> list[str]:
    preferred: list[str] = []
    for path in files:
        if path.startswith("docs/") or path.startswith("consent-protocol/docs/") or path.startswith("hushh-webapp/docs/"):
            continue
        if "/tests/" in path or path.startswith("consent-protocol/tests/") or path.startswith("hushh-webapp/__tests__/"):
            continue
        preferred.append(path)
    if not preferred:
        preferred = [path for path in files if not path.startswith("docs/")]
    return preferred[:limit]


def _related_surfaces(files: list[str]) -> OrderedDict[str, list[OrderedDict[str, str]]]:
    related_files: list[str] = []
    related_docs: list[str] = []

    for rule in RELATED_SURFACE_RULES:
        if not any(any(path.startswith(prefix) for prefix in rule["match_prefixes"]) for path in files):
            continue
        for path in rule["files"]:
            if _path_exists(path) and path not in related_files:
                related_files.append(path)
        for path in rule["docs"]:
            if _path_exists(path) and path not in related_docs:
                related_docs.append(path)

    for path in _preferred_related_files(files):
        if _path_exists(path) and path not in related_files:
            related_files.append(path)

    return OrderedDict(
        files=[
            OrderedDict(path=path, summary=_path_summary(path))
            for path in related_files[:5]
        ],
        docs=[
            OrderedDict(path=path, summary=_path_summary(path))
            for path in related_docs[:4]
        ],
    )


def _route_files_without_caller_changes(files: list[str]) -> bool:
    backend_routes = any(path.startswith("consent-protocol/api/routes/") for path in files)
    caller_changes = any(
        path.startswith("hushh-webapp/lib/services/")
        or path.startswith("hushh-webapp/app/api/")
        or path.startswith("hushh-webapp/components/")
        for path in files
    )
    return backend_routes and not caller_changes


def _has_sensitive_runtime_change(files: list[str]) -> bool:
    return any(
        path.endswith("Dockerfile")
        or path.startswith("deploy/")
        or path.startswith(".github/workflows/")
        or path.startswith("scripts/ci/")
        for path in files
    )


def _has_test_or_doc_change(files: list[str]) -> bool:
    return any(
        "/tests/" in path
        or path.startswith("consent-protocol/tests/")
        or path.startswith("hushh-webapp/__tests__/")
        or path.startswith("docs/")
        or path.startswith("consent-protocol/docs/")
        or path.startswith("hushh-webapp/docs/")
        for path in files
    )


def _file_patch_map(patch: str) -> dict[str, str]:
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for line in patch.splitlines():
        if line.startswith("diff --git "):
            parts = line.split()
            if len(parts) >= 4:
                current = parts[3][2:]
                sections[current] = [line]
            else:
                current = None
            continue
        if current is not None:
            sections[current].append(line)
    return {key: "\n".join(value) for key, value in sections.items()}


def _build_findings(files: list[str], patch_map: dict[str, str]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    explicit_dual_auth_support = (
        "consent-protocol/api/middleware.py" in files
        and "X-Hushh-Consent" in patch_map.get("consent-protocol/api/middleware.py", "")
        and any(
            path.startswith("hushh-webapp/lib/services/") or path.startswith("hushh-webapp/app/api/")
            for path in files
        )
    )

    if _route_files_without_caller_changes(files):
        findings.append(
            {
                "id": "backend_contract_without_caller_change",
                "severity": "high",
                "summary": "Backend route files changed without matching caller or proxy changes.",
                "files": [path for path in files if path.startswith("consent-protocol/api/routes/")],
            }
        )

    for path, section in patch_map.items():
        if (
            path.startswith("consent-protocol/api/routes/")
            and "require_firebase_auth" in section
            and "require_vault_owner_token" in section
            and not explicit_dual_auth_support
        ):
            findings.append(
                {
                    "id": "dual_auth_dependency_overlap",
                    "severity": "high",
                    "summary": "A route now depends on both Firebase auth and VAULT_OWNER token review on the same surface; verify caller token shape and header semantics explicitly.",
                    "files": [path],
                }
            )

        if path.endswith("Dockerfile") and "gunicorn" in section and not any(
            dependency_path.endswith("requirements.txt")
            or dependency_path.endswith("pyproject.toml")
            for dependency_path in files
        ):
            findings.append(
                {
                    "id": "runtime_dependency_not_pinned_in_manifest",
                    "severity": "medium",
                    "summary": "Runtime dependency behavior changed in Docker without a matching dependency-manifest change.",
                    "files": [path],
                }
            )

        if path.endswith(".gitignore"):
            findings.append(
                {
                    "id": "ignore_surface_changed",
                    "severity": "medium",
                    "summary": "Ignore rules changed; verify that secrets, credentials, or local validation files are not being hidden in a way that weakens review.",
                    "files": [path],
                }
            )

    if _has_sensitive_runtime_change(files) and not _has_test_or_doc_change(files):
        findings.append(
            {
                "id": "sensitive_runtime_change_without_supporting_proof",
                "severity": "medium",
                "summary": "Deploy/runtime or governance surfaces changed without matching tests or docs in the same PR.",
                "files": [path for path in files if _has_sensitive_runtime_change([path])],
            }
        )

    changed_set = set(files)
    for rule in CONCEPT_RULES:
        changed_any = set(rule.get("changed_any", []))
        if changed_any and not (changed_set & changed_any):
            continue
        main_paths = rule.get("main_paths", [])
        main_contains = rule.get("main_contains", [])
        main_match = any(_git_show_origin_main(path) is not None for path in main_paths)
        if not main_match and main_contains:
            for item in main_contains:
                content = _git_show_origin_main(item["path"])
                if content and item["needle"] in content:
                    main_match = True
                    break
        if main_paths or main_contains:
            if not main_match:
                continue
        findings.append(
            {
                "id": rule["id"],
                "severity": rule["severity"],
                "summary": rule["summary"],
                "files": sorted(changed_set & changed_any) or sorted(changed_set),
            }
        )

    return findings


def _recommend_merge_lane(
    ci_status_gate: str,
    findings: list[dict[str, Any]],
    surface_tags: list[str],
    changed_files: list[str],
) -> dict[str, Any]:
    if ci_status_gate != "SUCCESS":
        return OrderedDict(
            lane="block",
            rationale="Current required PR gate is not green on the reviewed head SHA.",
            next_steps=[
                "Wait for the current head SHA to reach a green `CI Status Gate` before deciding merge readiness.",
                "Review only the current head SHA after the gate is terminal.",
            ],
        )

    if not findings:
        return OrderedDict(
            lane="merge_now",
            rationale="Current head SHA is green and no blocker or review-risk findings were detected.",
            next_steps=[
                "Proceed with normal maintainer review and merge flow.",
            ],
        )

    high_ids = {finding["id"] for finding in findings if finding["severity"] == "high"}
    medium_ids = {finding["id"] for finding in findings if finding["severity"] == "medium"}
    if not high_ids and medium_ids and medium_ids <= {"ignore_surface_changed"}:
        return OrderedDict(
            lane="merge_now",
            rationale=(
                "Current head SHA is green and the only remaining review note is ignore-surface hygiene. "
                "That should be reviewed, but it does not require a maintainer patch before merge."
            ),
            next_steps=[
                "Do one quick maintainer sanity check on the ignore rules.",
                "Proceed with normal review and merge flow if the ignore additions are intentional.",
            ],
        )
    unsupported_high = high_ids - SALVAGEABLE_HIGH_FINDINGS
    unsupported_medium = medium_ids - SALVAGEABLE_MEDIUM_FINDINGS
    governance_heavy = "governance" in surface_tags and len(changed_files) > 5

    if (
        not unsupported_high
        and not unsupported_medium
        and not governance_heavy
    ):
        return OrderedDict(
            lane="patch_then_merge",
            rationale=(
                "The direction appears useful, but the current head is not merge-safe. "
                "The remaining findings are bounded integration or reproducibility issues "
                "that should be corrected by a small maintainer patch before merge."
            ),
            next_steps=[
                "Do not merge the contributor head directly.",
                "Apply the smallest maintainer integration patch on the contributor branch when maintainers can modify it.",
                "If direct patching is not possible, use a short-lived `temp/pr-<number>-patch` branch and delete it after the merge path is resolved.",
                "Rerun PR Validation on the updated merge candidate and re-review the new head SHA.",
                "Then thank the author and explain the integration fix that was needed.",
            ],
        )

    return OrderedDict(
        lane="block",
        rationale=(
            "The remaining findings are too broad or too risky for a small maintainer integration patch. "
            "This PR should stay blocked until the contributor or maintainer narrows the change."
        ),
        next_steps=[
            "Keep the PR blocked.",
            "Respond with blocker-first findings tied to the current head SHA.",
            "Only reconsider merge after the risky surface is narrowed or independently proven safe.",
        ],
    )


def _text_report(report: dict[str, Any]) -> str:
    lines: list[str] = []
    pr = report["pr"]
    lines.append(f"PR #{pr['number']}: {pr['title']}")
    lines.append(f"URL: {pr['url']}")
    lines.append(f"Head SHA: {pr['head_sha']}")
    lines.append(
        f"Size: +{pr['additions']} / -{pr['deletions']} across {pr['changed_files_count']} files"
    )
    lines.append(f"Mergeable: {pr['mergeable']} ({pr['merge_state_status']})")
    if pr.get("closed_issues"):
        lines.append(f"Issue linkage: {', '.join('#' + item for item in pr['closed_issues'])}")
    if pr.get("summary"):
        lines.append(f"Summary: {pr['summary']}")
    lines.append(f"Current CI Status Gate: {report['current_ci_status_gate']}")
    lines.append(f"Recommended lane: {report['decision']['lane']}")
    lines.append(f"Decision rationale: {report['decision']['rationale']}")
    lines.append(f"Changed surfaces: {', '.join(report['surface_tags']) or 'none'}")
    lines.append("Current checks:")
    for check in report["current_checks"]:
        lines.append(f"- {check['name']}: {check['conclusion']}")
    if report["findings"]:
        lines.append("Findings:")
        for finding in report["findings"]:
            files = ", ".join(finding["files"])
            lines.append(f"- [{finding['severity']}] {finding['id']}: {finding['summary']} ({files})")
    else:
        lines.append("Findings: none")
    related = report["related_surfaces"]
    if related["files"] or related["docs"]:
        lines.append("Related surfaces:")
        if related["files"]:
            lines.append("- Files:")
            for entry in related["files"]:
                lines.append(f"  - {entry['path']}: {entry['summary']}")
        if related["docs"]:
            lines.append("- Docs:")
            for entry in related["docs"]:
                lines.append(f"  - {entry['path']}: {entry['summary']}")
    lines.append("Next steps:")
    for step in report["decision"]["next_steps"]:
        lines.append(f"- {step}")
    lines.append("Suggested PR note:")
    lines.append(report["communication_markdown"])
    return "\n".join(lines)


def _top_roots(files: list[str]) -> list[str]:
    roots: list[str] = []
    for path in files:
        root = path.split("/", 1)[0]
        if root not in roots:
            roots.append(root)
    return roots


def build_batch_report(repo: str, prs: list[int]) -> dict[str, Any]:
    reports = [build_report(repo, pr) for pr in prs]
    overlaps: list[dict[str, Any]] = []
    for left, right in combinations(reports, 2):
        shared = sorted(set(left["changed_files"]) & set(right["changed_files"]))
        if not shared:
            continue
        overlaps.append(
            OrderedDict(
                pair=[left["pr"]["number"], right["pr"]["number"]],
                shared_files=shared,
            )
        )

    surface_counts: dict[str, int] = {}
    root_counts: dict[str, int] = {}
    lane_counts: dict[str, int] = {}
    for report in reports:
        lane = report["decision"]["lane"]
        lane_counts[lane] = lane_counts.get(lane, 0) + 1
        for tag in report["surface_tags"]:
            surface_counts[tag] = surface_counts.get(tag, 0) + 1
        for root in _top_roots(report["changed_files"]):
            root_counts[root] = root_counts.get(root, 0) + 1

    return OrderedDict(
        generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        repo=repo,
        prs=prs,
        lane_counts=lane_counts,
        surface_counts=OrderedDict(sorted(surface_counts.items())),
        root_counts=OrderedDict(sorted(root_counts.items())),
        overlaps=overlaps,
        reports=reports,
    )


def _batch_text_report(batch: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(
        f"Batch PR review: {', '.join('#' + str(pr) for pr in batch['prs'])}"
    )
    lines.append(f"Lane counts: {json.dumps(batch['lane_counts'], sort_keys=True)}")
    lines.append(f"Surface counts: {json.dumps(batch['surface_counts'], sort_keys=True)}")
    lines.append(f"Root counts: {json.dumps(batch['root_counts'], sort_keys=True)}")
    if batch["overlaps"]:
        lines.append("Cross-PR file overlaps:")
        for overlap in batch["overlaps"]:
            lines.append(
                f"- #{overlap['pair'][0]} <-> #{overlap['pair'][1]}: "
                + ", ".join(overlap["shared_files"])
            )
    else:
        lines.append("Cross-PR file overlaps: none")
    lines.append("")
    for report in batch["reports"]:
        lines.append(_text_report(report))
        lines.append("")
    return "\n".join(lines).rstrip()


def _communication_markdown(report: dict[str, Any]) -> str:
    pr = report["pr"]
    repo = report["repo"]
    lane = report["decision"]["lane"]
    acknowledgment = (
        f"Thanks @{pr['author']} for the contribution and for pushing this direction forward."
        if pr.get("author")
        else "Thanks for the contribution and for pushing this direction forward."
    )

    if lane == "merge_now":
        adopted = "The current head is aligned with the existing caller, runtime, and trust-boundary contracts."
        patch_or_blockers = "No maintainer patch is needed on this head SHA."
        why = "The required gate is green and the review did not find contract or governance regressions."
    elif lane == "patch_then_merge":
        findings = report["findings"]
        adopted = "We are taking the direction in this PR, but not merging the current head unchanged."
        patch_or_blockers = (
            "A small maintainer integration patch is required first to close the remaining bounded gaps: "
            + ", ".join(finding["id"] for finding in findings)
            + "."
        )
        why = report["decision"]["rationale"]
        next_step = "Patch the contributor branch, rerun PR Validation on the updated head SHA, then re-review for merge."
    else:
        findings = report["findings"]
        adopted = "The intent may still be useful, but the current merge candidate is not safe to land."
        patch_or_blockers = (
            "The current blockers are: "
            + ", ".join(finding["id"] for finding in findings)
            + "."
        ) if findings else "The current required gate is not green yet."
        why = report["decision"]["rationale"]
        next_step = "Keep the PR open, narrow the risky surface, and rerun the gate on the next head SHA."

    sections = [
        "## Acknowledgment",
        acknowledgment,
        "",
        "## What We Adopted",
        adopted,
        "",
        (
            "## Merge Decision"
            if lane == "merge_now"
            else "## Maintainer Patch" if lane == "patch_then_merge" else "## Blockers"
        ),
        patch_or_blockers,
    ]
    related = report["related_surfaces"]
    if related["files"] or related["docs"]:
        sections.extend([
            "",
            "## Related Surfaces",
        ])
        if related["files"]:
            sections.append("Files:")
            for entry in related["files"]:
                path = entry["path"]
                sections.append(
                    f"- {_markdown_path_link(repo, _github_link_ref(report, path), path)}: {entry['summary']}"
                )
        if related["docs"]:
            sections.append("Docs:")
            for entry in related["docs"]:
                path = entry["path"]
                sections.append(
                    f"- {_markdown_path_link(repo, _github_link_ref(report, path), path)}: {entry['summary']}"
                )
    sections.extend([
        "",
        "## Why",
        why,
    ])
    if lane != "merge_now":
        sections.extend([
            "",
            "## Next",
            next_step,
        ])
    return "\n".join(sections)


def build_report(repo: str, pr: int) -> dict[str, Any]:
    pr_view = _gh_json(
        repo,
        pr,
        [
            "number",
            "title",
            "url",
            "author",
            "headRefOid",
            "headRefName",
            "baseRefName",
            "mergeable",
            "mergeStateStatus",
            "reviewDecision",
            "statusCheckRollup",
            "additions",
            "deletions",
            "changedFiles",
            "body",
        ],
    )
    files = _gh_diff_name_only(repo, pr)
    patch = _gh_diff_patch(repo, pr)
    patch_map = _file_patch_map(patch)
    current_checks = _current_checks(pr_view.get("statusCheckRollup", []))
    ci_status_gate = next(
        (item.get("conclusion", "UNKNOWN") for item in current_checks if item.get("name") == "CI Status Gate"),
        "MISSING",
    )
    report = OrderedDict(
        generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        repo=repo,
        pr=OrderedDict(
            number=pr_view["number"],
            title=pr_view["title"],
            url=pr_view["url"],
            author=pr_view.get("author", {}).get("login"),
            summary=_extract_summary(pr_view.get("body")),
            closed_issues=_extract_closed_issues(pr_view.get("body")),
            head_sha=pr_view["headRefOid"],
            head_ref=pr_view["headRefName"],
            base_ref=pr_view["baseRefName"],
            additions=pr_view.get("additions", 0),
            deletions=pr_view.get("deletions", 0),
            changed_files_count=pr_view.get("changedFiles", len(files)),
            mergeable=pr_view["mergeable"],
            merge_state_status=pr_view["mergeStateStatus"],
            review_decision=pr_view.get("reviewDecision") or "",
        ),
        changed_files=files,
        surface_tags=_surface_tags(files),
        current_ci_status_gate=ci_status_gate,
        current_checks=[
            OrderedDict(
                name=item.get("name"),
                conclusion=item.get("conclusion"),
                workflow=item.get("workflowName"),
                details_url=item.get("detailsUrl"),
            )
            for item in current_checks
        ],
        findings=_build_findings(files, patch_map),
        related_surfaces=_related_surfaces(files),
    )
    report["decision"] = _recommend_merge_lane(
        ci_status_gate=ci_status_gate,
        findings=report["findings"],
        surface_tags=report["surface_tags"],
        changed_files=files,
    )
    report["communication_markdown"] = _communication_markdown(report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize current-head PR review risks.")
    parser.add_argument("--repo", default="hushh-labs/hushh-research")
    parser.add_argument("--pr", type=int)
    parser.add_argument("--prs", help="Comma-separated PR numbers for batch review.")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    if not args.pr and not args.prs:
        parser.error("one of --pr or --prs is required")
    if args.pr and args.prs:
        parser.error("use either --pr or --prs, not both")

    try:
        if args.prs:
            prs = [int(item.strip()) for item in args.prs.split(",") if item.strip()]
            report = build_batch_report(args.repo, prs)
            is_batch = True
        else:
            report = build_report(args.repo, args.pr)
            is_batch = False
    except Exception as exc:
        print(f"pr_review_checklist failed: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(_batch_text_report(report) if is_batch else _text_report(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
