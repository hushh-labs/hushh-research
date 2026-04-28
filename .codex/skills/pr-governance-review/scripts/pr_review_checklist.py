#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from collections import OrderedDict
from itertools import combinations
from datetime import datetime, timezone
from pathlib import Path
import re
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[4]
SALVAGEABLE_HIGH_FINDINGS = {
    "account_export_schema_contract_mismatch",
    "backend_contract_without_caller_change",
    "db_contract_without_matching_migration",
    "db_migration_missing_release_manifest",
    "dual_auth_dependency_overlap",
}
SALVAGEABLE_MEDIUM_FINDINGS = {
    "account_export_backend_error_detail_leak",
    "account_export_proxy_raw_error_leak",
    "account_export_missing_schema_happy_path_tests",
    "background_task_without_failure_logging",
    "db_migration_missing_schema_contract_update",
    "frontend_error_sanitizer_403_permission_mismatch",
    "service_layer_browser_download_side_effect",
    "runtime_dependency_not_pinned_in_manifest",
    "ignore_surface_changed",
    "sensitive_runtime_change_without_supporting_proof",
    "marketplace_flow_overlap_on_main",
}
ACCOUNT_EXPORT_CORE_FILES = {
    "consent-protocol/api/routes/account.py",
    "consent-protocol/hushh_mcp/services/account_service.py",
    "hushh-webapp/app/api/account/export/route.ts",
    "hushh-webapp/lib/services/account-service.ts",
}
DB_CONTRACT_FILES = {
    "consent-protocol/db/contracts/uat_integrated_schema.json",
    "consent-protocol/db/contracts/prod_integrated_schema.json",
}
DB_RELEASE_MANIFEST_FILE = "consent-protocol/db/release_migration_manifest.json"
SCHEMA_CONTRACT_PATH = REPO_ROOT / "consent-protocol/db/contracts/uat_integrated_schema.json"
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
    "consent-protocol/api/routes/email_agent.py": "Inbound email webhook surface proposed for One-led KYC workflows.",
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
    "docs/future/kai/email-kyc-pkm-assistant.md": "Superseded planning history for One-led KYC workflow and consent-scoped rollout.",
}


def _run(cmd: list[str]) -> str:
    attempts = 3 if cmd and cmd[0] == "gh" else 1
    last_message = ""
    for attempt in range(attempts):
        completed = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if completed.returncode == 0:
            return completed.stdout
        last_message = completed.stderr.strip() or completed.stdout.strip() or "command failed"
        retryable = "504" in last_message or "Gateway Timeout" in last_message
        if not retryable or attempt == attempts - 1:
            break
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{' '.join(cmd)}: {last_message}")


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


def _load_schema_contract_columns() -> dict[str, set[str]]:
    if not SCHEMA_CONTRACT_PATH.exists():
        return {}
    try:
        payload = json.loads(SCHEMA_CONTRACT_PATH.read_text())
    except json.JSONDecodeError:
        return {}
    required_tables = payload.get("required_tables", {})
    if not isinstance(required_tables, dict):
        return {}
    return {
        table: set(columns)
        for table, columns in required_tables.items()
        if isinstance(columns, list)
    }


def _contract_set(files: list[str], patch_map: dict[str, str]) -> str:
    patch_text = "\n".join(patch_map.values())
    if any(path.startswith("consent-protocol/db/") for path in files):
        return "db-release-contract"
    if any(path in ACCOUNT_EXPORT_CORE_FILES for path in files) and (
        "/account/export" in patch_text
        or "exportData" in patch_text
        or "export_data" in patch_text
    ):
        return "account-export"
    if any(path.endswith("error-sanitizer.ts") for path in files):
        return "frontend-error-safety"
    if any(path.startswith("consent-protocol/api/routes/kai/") for path in files):
        return "kai-route"
    if any("voice" in path for path in files):
        return "voice"
    if any("pkm" in path.lower() or "personal-knowledge-model" in path for path in files):
        return "pkm-privacy"
    if any(path.startswith("hushh-webapp/") for path in files):
        return "frontend"
    if any(path.startswith("consent-protocol/") for path in files):
        return "backend"
    if any(path.startswith(".codex/") or path.startswith("scripts/") or path.startswith("config/") for path in files):
        return "ops-governance"
    if any(path.startswith("docs/") for path in files):
        return "content"
    return "general"


def _duplicate_group(contract_set: str, files: list[str]) -> str | None:
    if contract_set == "account-export":
        return "account-export"
    if any(path.startswith("hushh-webapp/app/api/account/export/") for path in files):
        return "account-export"
    return None


def _normal_text(*values: str | None) -> str:
    return " ".join(str(value or "").lower() for value in values)


def _semantic_duplicate_group(
    left: dict[str, Any],
    right: dict[str, Any],
    shared_files: list[str],
) -> str | None:
    shared = set(shared_files)
    left_text = _normal_text(left["pr"]["title"], left["pr"].get("summary"))
    right_text = _normal_text(right["pr"]["title"], right["pr"].get("summary"))
    combined = f"{left_text} {right_text}"

    if {
        "hushh-webapp/components/navbar.tsx",
        "hushh-webapp/components/theme-toggle.tsx",
    } <= shared and all(
        token in combined for token in ("theme", "toggle")
    ) and any(
        token in combined for token in ("top-right", "top right", "compact", "dropdown")
    ):
        return "semantic-duplicate:theme-toggle-top-right"

    return None


def _theme_toggle_duplicate_factors(patch_map: dict[str, str]) -> OrderedDict[str, Any]:
    patch_text = "\n".join(patch_map.values())
    normalized = _normal_text(patch_text)
    factors = OrderedDict(
        scope_containment="themetogglecompact" in normalized,
        design_system_fit="dropdownmenu" in normalized
        and "@/components/ui/dropdown-menu" in normalized,
        accessibility="aria-label" in normalized,
        layout_safety="app-safe-area-top-effective" in normalized,
        contract_preservation="export function themetogglecompact" in normalized,
        type_readiness="nouncheckedindexedaccess" in normalized
        or "typeof theme_options)[number]" in normalized,
        hover_dependent="onmouseenter" in normalized or "onmouseleave" in normalized,
        fixed_top_right="top-4 right-4" in normalized,
        rewrites_shared_toggle="export function themetoggle" in normalized
        and "export function themetogglecompact" not in normalized,
    )
    score = sum(
        1
        for key in (
            "scope_containment",
            "design_system_fit",
            "accessibility",
            "layout_safety",
            "contract_preservation",
            "type_readiness",
        )
        if factors[key]
    )
    score -= sum(
        1
        for key in ("hover_dependent", "fixed_top_right", "rewrites_shared_toggle")
        if factors[key]
    )
    factors["score"] = score
    return factors


def _duplicate_selection_factors(
    contract_set: str,
    files: list[str],
    patch_map: dict[str, str],
) -> OrderedDict[str, Any] | None:
    if contract_set == "frontend" and {
        "hushh-webapp/components/navbar.tsx",
        "hushh-webapp/components/theme-toggle.tsx",
    } <= set(files):
        return _theme_toggle_duplicate_factors(patch_map)
    return None


def _canonical_selection_rationale(group: str, preferred: dict[str, Any]) -> str:
    factors = preferred.get("duplicate_selection_factors") or {}
    if group.startswith("semantic-duplicate:theme-toggle-top-right") and factors:
        strengths = []
        if factors.get("scope_containment"):
            strengths.append("adds a narrow compact variant instead of rewriting the shared toggle")
        if factors.get("design_system_fit"):
            strengths.append("uses the existing DropdownMenu primitive")
        if factors.get("accessibility"):
            strengths.append("keeps explicit trigger labeling")
        if factors.get("layout_safety"):
            strengths.append("preserves safe-area-aware onboarding chrome placement")
        if factors.get("contract_preservation"):
            strengths.append("keeps the segmented ThemeToggle available for wider settings surfaces")
        if factors.get("type_readiness"):
            strengths.append("accounts for strict TypeScript fallback handling")
        if strengths:
            return "; ".join(strengths) + "."
    return "Selected by duplicate-governance ranking; diff size is only a tie-breaker."


def _duplicate_preference_key(report: dict[str, Any], group: str) -> tuple[int, int, int]:
    factors = report.get("duplicate_selection_factors") or {}
    score = int(factors.get("score", 0)) if group.startswith("semantic-duplicate:") else 0
    churn = report["pr"]["additions"] + report["pr"]["deletions"]
    return (score, -churn, -int(report["pr"]["number"]))


def _what_this_is_about(
    title: str,
    summary: str | None,
    files: list[str],
    patch_map: dict[str, str],
    contract_set: str,
) -> str:
    text = _normal_text(title, summary, "\n".join(patch_map.values()))

    if "consent-protocol/hushh_mcp/services/kai_chat_service.py" in files:
        if "get_initial_chat_state" in text and "get_portfolio" in text:
            return (
                "Kai chat startup performance: derive portfolio presence from PKM metadata "
                "instead of making a second portfolio DB call when opening chat."
            )
        if "extract_and_store" in text and ("create_task" in text or "background" in text):
            return (
                "Kai chat response latency: move attribute learning behind the response so "
                "Gemini-backed memory extraction does not block the user-visible answer."
            )
        if "validate_response" in text or "safe_fallback" in text or "grounded" in text:
            return (
                "Kai chat answer safety: validate generated assistant text, retry malformed output, "
                "and return a stable fallback when the model response is not usable."
            )
        return "Kai chat service behavior: review runtime effect before treating file overlap as duplication."

    if {
        "hushh-webapp/components/navbar.tsx",
        "hushh-webapp/components/theme-toggle.tsx",
    } <= set(files):
        return "Frontend shell polish: move theme switching into a compact top-right control."

    if any(path.startswith("hushh-webapp/lib/portfolio-share/") for path in files):
        return (
            "Portfolio share token security: fail closed in production when signing secrets are "
            "missing while preserving local development fallback behavior."
        )

    if contract_set == "account-export":
        return "Account export contract: package user-owned export data without leaking raw backend failures."
    if contract_set == "frontend-error-safety":
        return "Frontend error safety: normalize user-facing error messages without exposing raw service details."
    if contract_set == "db-release-contract":
        return "DB release contract: advance migrations, schema contracts, and UAT/prod migration readiness together."
    if contract_set == "voice":
        return "Kai voice capability: expand or refine voice-driven action coverage."
    if contract_set == "pkm-privacy":
        return "PKM privacy/runtime contract: adjust personal knowledge storage, access, or projection behavior."
    if contract_set == "backend":
        return "Backend runtime behavior: change service-side behavior under existing API contracts."
    if contract_set == "frontend":
        return "Frontend behavior: change user-facing UI without an obvious backend contract shift."
    return "General repo change: review product intent, changed surfaces, and proof before merge."


def _author_group(author: str | None) -> str:
    return f"author:{author}" if author else "author:unknown"


def _select_columns_for_table(section: str, table_name: str) -> set[str]:
    columns: set[str] = set()
    pattern = re.compile(
        r"SELECT\s+(?P<columns>.*?)\s+FROM\s+" + re.escape(table_name) + r"\b",
        flags=re.IGNORECASE | re.DOTALL,
    )
    for match in pattern.finditer(section):
        raw_columns = match.group("columns")
        for raw_column in raw_columns.split(","):
            column = raw_column.strip()
            if not column or column == "*":
                continue
            if "(" in column or ")" in column:
                continue
            column = re.sub(r"\s+AS\s+.*$", "", column, flags=re.IGNORECASE)
            column = column.split()[-1]
            column = column.split(".")[-1].strip('"')
            if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", column):
                columns.add(column)
    return columns


def _account_export_schema_mismatches(patch_map: dict[str, str]) -> list[dict[str, Any]]:
    schema_columns = _load_schema_contract_columns()
    if not schema_columns:
        return []
    sections = [
        patch_map.get("consent-protocol/hushh_mcp/services/account_service.py", ""),
        patch_map.get("consent-protocol/api/routes/account.py", ""),
    ]
    mismatches: list[dict[str, Any]] = []
    for table_name, allowed_columns in schema_columns.items():
        referenced: set[str] = set()
        for section in sections:
            referenced |= _select_columns_for_table(section, table_name)
        unknown = sorted(referenced - allowed_columns)
        if unknown:
            mismatches.append(
                OrderedDict(
                    table=table_name,
                    unknown_columns=unknown,
                    allowed_columns=sorted(allowed_columns),
                )
            )
    return mismatches


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
    if any(path.startswith("consent-protocol/hushh_mcp/services/") for path in files):
        tags.append("backend-service")
    if any(path.startswith("consent-protocol/db/") for path in files):
        tags.append("db-contract")
    if any(
        path.startswith("hushh-webapp/lib/services/")
        or path.startswith("hushh-webapp/app/api/")
        or path.startswith("hushh-webapp/lib/portfolio-share/")
        for path in files
    ):
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


def _db_migration_files(files: list[str]) -> list[str]:
    return sorted(
        path
        for path in files
        if path.startswith("consent-protocol/db/migrations/")
        and path.endswith(".sql")
    )


def _db_contract_files(files: list[str]) -> list[str]:
    return sorted(path for path in files if path in DB_CONTRACT_FILES)


def _file_patch_map(patch: str) -> dict[str, str]:
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for line in patch.splitlines():
        if line.startswith("diff --git "):
            parts = line.split()
            if len(parts) >= 4:
                current = parts[3][2:]
                sections.setdefault(current, [])
                if sections[current]:
                    sections[current].append("")
                sections[current].append(line)
            else:
                current = None
            continue
        if current is not None:
            sections[current].append(line)
    return {key: "\n".join(value) for key, value in sections.items()}


def _build_findings(files: list[str], patch_map: dict[str, str]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    contract_set = _contract_set(files, patch_map)
    patch_text = "\n".join(patch_map.values())
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

    migration_files = _db_migration_files(files)
    contract_files = _db_contract_files(files)
    release_manifest_changed = DB_RELEASE_MANIFEST_FILE in files
    if migration_files:
        if not release_manifest_changed:
            findings.append(
                {
                    "id": "db_migration_missing_release_manifest",
                    "severity": "high",
                    "summary": (
                        "DB migration files changed without updating the release migration "
                        "manifest, so UAT/prod operators may not apply the migration in order."
                    ),
                    "files": migration_files,
                }
            )
        if not contract_files:
            findings.append(
                {
                    "id": "db_migration_missing_schema_contract_update",
                    "severity": "medium",
                    "summary": (
                        "DB migration files changed without a checked-in schema contract update; "
                        "verify whether the migration changes live UAT/prod contract shape."
                    ),
                    "files": migration_files,
                }
            )
    if contract_files and not migration_files:
        findings.append(
            {
                "id": "db_contract_without_matching_migration",
                "severity": "high",
                "summary": (
                    "DB schema contract files changed without a matching SQL migration in the PR."
                ),
                "files": contract_files,
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

        if (
            path == "consent-protocol/hushh_mcp/services/kai_chat_service.py"
            and "asyncio.create_task(" in section
            and ".add_done_callback" not in section
            and "logger.exception" not in section
        ):
            findings.append(
                {
                    "id": "background_task_without_failure_logging",
                    "severity": "medium",
                    "summary": "Kai chat schedules background work without an explicit completion callback or exception logger.",
                    "files": [path],
                }
            )

    if contract_set == "frontend-error-safety":
        sanitizer_section = patch_map.get("hushh-webapp/lib/services/error-sanitizer.ts", "")
        if (
            "status === 401 || status === 403" in sanitizer_section
            and 'return "authentication"' in sanitizer_section
            and "status === 403" in sanitizer_section
            and 'return "permission"' in sanitizer_section
        ):
            findings.append(
                {
                    "id": "frontend_error_sanitizer_403_permission_mismatch",
                    "severity": "medium",
                    "summary": "403 is classified as authentication before the permission branch can run, so permission failures can look like expired sessions.",
                    "files": ["hushh-webapp/lib/services/error-sanitizer.ts"],
                }
            )

    if contract_set == "account-export":
        schema_mismatches = _account_export_schema_mismatches(patch_map)
        if schema_mismatches:
            findings.append(
                {
                    "id": "account_export_schema_contract_mismatch",
                    "severity": "high",
                    "summary": "Account export SQL references columns that are not present in the checked-in UAT DB schema contract.",
                    "files": ["consent-protocol/hushh_mcp/services/account_service.py"],
                    "details": schema_mismatches,
                }
            )

        proxy_section = patch_map.get("hushh-webapp/app/api/account/export/route.ts", "")
        if (
            "responseText" in proxy_section
            and re.search(r"\{\s*error:\s*responseText", proxy_section)
        ):
            findings.append(
                {
                    "id": "account_export_proxy_raw_error_leak",
                    "severity": "medium",
                    "summary": "The account export proxy can return raw backend response text to the client on non-OK responses.",
                    "files": ["hushh-webapp/app/api/account/export/route.ts"],
                }
            )

        route_section = patch_map.get("consent-protocol/api/routes/account.py", "")
        if "HTTPException" in route_section and "result.get('error')" in route_section:
            findings.append(
                {
                    "id": "account_export_backend_error_detail_leak",
                    "severity": "medium",
                    "summary": "The backend account export route can expose raw export failure detail in HTTPException responses.",
                    "files": ["consent-protocol/api/routes/account.py"],
                }
            )

        if (
            any(path in files for path in ACCOUNT_EXPORT_CORE_FILES)
            and "consent-protocol/tests/services/test_account_service_export.py" not in files
        ):
            findings.append(
                {
                    "id": "account_export_missing_schema_happy_path_tests",
                    "severity": "medium",
                    "summary": "Account export changes do not include a happy-path export test that proves the response shape against current schema columns.",
                    "files": [path for path in files if path.startswith("consent-protocol/tests/")],
                }
            )

        service_section = patch_map.get("hushh-webapp/lib/services/account-service.ts", "")
        if (
            "exportData" in service_section
            and ("new Blob" in service_section or "URL.createObjectURL" in service_section or ".click()" in service_section)
        ):
            findings.append(
                {
                    "id": "service_layer_browser_download_side_effect",
                    "severity": "medium",
                    "summary": "AccountService.exportData adds browser download side effects inside the service layer instead of returning data for the UI/native caller to handle.",
                    "files": ["hushh-webapp/lib/services/account-service.ts"],
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
        if "db-contract" in surface_tags:
            return OrderedDict(
                lane="merge_now",
                rationale=(
                    "Current head SHA is green and the DB migration package appears "
                    "internally complete: migration, release manifest, and schema contract "
                    "move together."
                ),
                next_steps=[
                    "Run `./bin/hushh db verify-release-contract` before merge.",
                    "Before any UAT-ready claim, run live `./bin/hushh db verify-uat-schema`; if it fails, apply the specific missing migration and rerun the guard.",
                ],
            )
        return OrderedDict(
            lane="merge_now",
            rationale="Current head SHA is green and no blocker or review-risk findings were detected.",
            next_steps=[
                "Proceed with normal maintainer review and merge flow.",
            ],
        )

    high_ids = {finding["id"] for finding in findings if finding["severity"] == "high"}
    medium_ids = {finding["id"] for finding in findings if finding["severity"] == "medium"}
    close_ids = {
        "duplicate_product_contract",
        "duplicate_exact_file_overlap",
    }
    if high_ids & close_ids:
        return OrderedDict(
            lane="harvest_then_close",
            rationale=(
                "This PR overlaps a preferred canonical implementation for the same product contract. "
                "Harvest only unique tests or observability value, then close it as superseded."
            ),
            next_steps=[
                "Do not merge this PR directly.",
                "Compare against the preferred PR in the duplicate group.",
                "Move any unique low-risk proof into the preferred PR if it is still needed.",
                "Close this PR with a concise superseded-by comment.",
            ],
        )
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


def _patch_then_merge_reason(findings: list[dict[str, Any]], lane: str) -> str:
    if lane == "merge_now":
        return ""
    if not findings:
        return "Current required gate or mergeability state is not ready."
    return ", ".join(finding["id"] for finding in findings)


def _public_comment_policy(lane: str) -> str:
    if lane == "merge_now":
        return "no_pre_merge_comment; post_merge_only_if_useful"
    if lane == "patch_then_merge":
        return "no_approval_comment; post_merge_comment_only_if_maintainer_patch_lands"
    if lane in {"harvest_then_close", "close_duplicate"}:
        return "post_close_superseded_comment"
    return "comment_before_merge_only_if_contributor_action_required"


def _live_report_action(lane: str) -> str:
    if lane in {"harvest_then_close", "close_duplicate"}:
        return "remove_after_close"
    if lane == "merge_now":
        return "remove_after_merge"
    return "keep_live_until_patched_or_block_resolved"


def _markdown_cell(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def _lean_core_risk(report: dict[str, Any]) -> str:
    lane = report["lane"]
    if lane in {"harvest_then_close", "close_duplicate"}:
        return "duplicate"
    severities = {finding["severity"] for finding in report["findings"]}
    if "high" in severities:
        return "high"
    if "medium" in severities:
        return "medium"
    runtime_tags = {
        "backend-api",
        "backend-service",
        "db-contract",
        "frontend-caller",
        "deploy-runtime",
        "governance",
    }
    if not (set(report["surface_tags"]) & runtime_tags):
        return "non-runtime"
    return "low"


def _compact_file_list(files: list[str], limit: int = 8) -> str:
    if not files:
        return "none"
    visible = [f"`{path}`" for path in files[:limit]]
    remaining = len(files) - limit
    if remaining > 0:
        visible.append(f"`+{remaining} more`")
    return ", ".join(visible)


def _findings_summary(report: dict[str, Any]) -> str:
    if not report["findings"]:
        return "none"
    return "; ".join(
        f"`{finding['severity']}/{finding['id']}`: {finding['summary']}"
        for finding in report["findings"]
    )


def _overlap_summary(report: dict[str, Any]) -> str:
    pieces: list[str] = []
    for overlap in report.get("exact_file_overlap", []):
        pieces.append(
            f"exact with `#{overlap['other_pr']}` on "
            f"{_compact_file_list(overlap['shared_files'], limit=4)}"
        )
    for overlap in report.get("concept_overlap", []):
        pieces.append(str(overlap))
    return "; ".join(pieces) if pieces else "none detected"


def _related_surface_summary(report: dict[str, Any]) -> str:
    related = report["related_surfaces"]
    files = [entry["path"] for entry in related["files"]]
    docs = [entry["path"] for entry in related["docs"]]
    parts: list[str] = []
    if files:
        parts.append(f"files: {_compact_file_list(files, limit=4)}")
    if docs:
        parts.append(f"docs: {_compact_file_list(docs, limit=3)}")
    return "; ".join(parts) if parts else "none mapped"


def _single_pr_live_assessment(report: dict[str, Any]) -> list[str]:
    pr = report["pr"]
    reason = report.get("patch_then_merge_reason") or report["decision"]["rationale"]
    lines = [
        f'<a id="pr-{pr["number"]}"></a>',
        f"### #{pr['number']} - {pr['title']}",
        "",
        f"- PR: {pr['url']}",
        f"- Author/head: `{pr['author']}` / `{pr['head_sha'][:8]}` on `{pr['head_ref']}` -> `{pr['base_ref']}`",
        f"- Contract/lane: `{report['contract_set']}` / `{report['lane']}`",
        f"- Lean/core risk: `{_lean_core_risk(report)}`",
        f"- Size/surfaces: `+{pr['additions']}` / `-{pr['deletions']}` across `{pr['changed_files_count']}` files; tags `{', '.join(report['surface_tags']) or 'none'}`",
        f"- What this is about: {report['what_this_is_about']}",
        f"- Summary: {pr.get('summary') or 'No PR summary extracted.'}",
        f"- Findings: {_findings_summary(report)}",
        f"- Overlap: {_overlap_summary(report)}",
        f"- Related surfaces: {_related_surface_summary(report)}",
        f"- Decision rationale: {report['decision']['rationale']}",
        f"- SOP action: `{report['live_report_action']}`; public comment policy `{report['public_comment_policy']}`",
        f"- Next proof: {' '.join(report['decision']['next_steps'][:2])}",
    ]
    if reason and reason != report["decision"]["rationale"]:
        lines.append(f"- Patch/close reason: {reason}")
    return lines


def _report_sort_key(report: dict[str, Any]) -> tuple[int, int, int]:
    lane_rank = {
        "merge_now": 0,
        "patch_then_merge": 1,
        "harvest_then_close": 2,
        "close_duplicate": 2,
        "block": 3,
    }
    pr = report["pr"]
    return (
        lane_rank.get(report["lane"], 9),
        pr["additions"] + pr["deletions"],
        pr["number"],
    )


def _operator_component_sort_key(report: dict[str, Any]) -> tuple[int, int, int, int]:
    if "consent-protocol/hushh_mcp/services/kai_chat_service.py" in report["changed_files"]:
        intent = report.get("what_this_is_about", "")
        if "startup performance" in intent:
            return (0, 0, report["pr"]["additions"] + report["pr"]["deletions"], report["pr"]["number"])
        if "response latency" in intent:
            return (0, 1, report["pr"]["additions"] + report["pr"]["deletions"], report["pr"]["number"])
        if "answer safety" in intent:
            return (0, 2, report["pr"]["additions"] + report["pr"]["deletions"], report["pr"]["number"])
    lane_rank, size, number = _report_sort_key(report)
    return (1, lane_rank, size, number)


def _report_has_duplicate_finding(report: dict[str, Any]) -> bool:
    return any(
        finding["id"] in {"duplicate_exact_file_overlap", "duplicate_product_contract"}
        for finding in report["findings"]
    )


def _operator_batch_intent(reports: list[dict[str, Any]], shared_files: list[str]) -> str:
    shared = set(shared_files)
    if len({report["pr"]["head_sha"] for report in reports}) == 1:
        return "Exact duplicate cleanup: one head SHA is represented by multiple open PRs."
    if "consent-protocol/hushh_mcp/services/kai_chat_service.py" in shared:
        return (
            "Kai chat service evolution: coordinate startup latency, response latency, "
            "and answer-safety changes that share one service file but affect different runtime behaviors."
        )
    if {
        "hushh-webapp/components/navbar.tsx",
        "hushh-webapp/components/theme-toggle.tsx",
    } <= shared:
        return "Theme toggle shell placement: choose one compact top-right UI implementation."
    if any("package.json" in path or "package-lock.json" in path for path in shared):
        return "Dependency/test surface alignment: sequence package-lock changes before dependent test infrastructure."
    if any(_report_has_duplicate_finding(report) for report in reports):
        return "Shared contract cleanup: select the canonical implementation and harvest only unique proof."
    return "Shared-file sequencing: same files require ordered merge or rebase, but are not automatically duplicate work."


def _operator_batch_title(reports: list[dict[str, Any]], preferred: dict[str, Any]) -> str:
    if len({report["pr"]["head_sha"] for report in reports}) == 1:
        return f"Exact Duplicate Cleanup: #{preferred['pr']['number']}"
    if any(
        "consent-protocol/hushh_mcp/services/kai_chat_service.py" in report["changed_files"]
        for report in reports
    ):
        return "Kai Chat Service Evolution Batch"
    if any(_report_has_duplicate_finding(report) for report in reports):
        return f"Shared-File Harvest Cluster: #{preferred['pr']['number']}"
    if any(
        "package.json" in path or "package-lock.json" in path
        for report in reports
        for path in report["changed_files"]
    ):
        return "Dependency/Test Surface Overlap"
    return f"Shared-File Operator Batch: #{preferred['pr']['number']}"


def _operator_batch_action(reports: list[dict[str, Any]], preferred: dict[str, Any]) -> str:
    preferred_number = preferred["pr"]["number"]
    rest = [report["pr"]["number"] for report in reports if report is not preferred]
    rest_label = ", ".join("#" + str(number) for number in rest)
    if len({report["pr"]["head_sha"] for report in reports}) == 1:
        duplicate_noun = "an exact duplicate" if len(rest) == 1 else "exact duplicates"
        return f"Review and merge `#{preferred_number}` as the canonical PR, then close {rest_label} as {duplicate_noun}."
    if any(
        "consent-protocol/hushh_mcp/services/kai_chat_service.py" in report["changed_files"]
        for report in reports
    ):
        return (
            "Merge in runtime-evolution order: startup optimization first, response-latency change second, "
            "answer-safety change last; rebase and rerun shared Kai chat service checks after each step."
        )
    if any(_report_has_duplicate_finding(report) for report in reports):
        return f"Review `#{preferred_number}` as canonical first; harvest only unique proof from {rest_label} before closing duplicates."
    return "Review these PRs together because they touch the same files; merge one at a time with the shared checks rerun after each merge."


def _operator_batches(
    reports: list[dict[str, Any]],
    overlaps: list[dict[str, Any]],
) -> list[OrderedDict[str, Any]]:
    by_number = {report["pr"]["number"]: report for report in reports}
    graph: dict[int, set[int]] = {number: set() for number in by_number}
    overlap_files: dict[tuple[int, int], list[str]] = {}
    for overlap in overlaps:
        left, right = overlap["pair"]
        graph.setdefault(left, set()).add(right)
        graph.setdefault(right, set()).add(left)
        overlap_files[tuple(sorted((left, right)))] = overlap["shared_files"]

    seen: set[int] = set()
    batches: list[OrderedDict[str, Any]] = []
    for number in sorted(graph):
        if number in seen or not graph[number]:
            continue
        stack = [number]
        component: set[int] = set()
        while stack:
            current = stack.pop()
            if current in component:
                continue
            component.add(current)
            stack.extend(sorted(graph.get(current, set()) - component))
        seen |= component
        component_reports = sorted(
            (by_number[item] for item in component),
            key=_operator_component_sort_key,
        )
        preferred = component_reports[0]
        shared_files = sorted(
            {
                path
                for left, right in combinations(sorted(component), 2)
                for path in overlap_files.get(tuple(sorted((left, right))), [])
            }
        )
        batches.append(
            OrderedDict(
                title=_operator_batch_title(component_reports, preferred),
                prs=[report["pr"]["number"] for report in component_reports],
                preferred_pr=preferred["pr"]["number"],
                contract_sets=sorted({report["contract_set"] for report in component_reports}),
                lanes=OrderedDict(
                    (f"#{report['pr']['number']}", report["lane"])
                    for report in component_reports
                ),
                risks=OrderedDict(
                    (f"#{report['pr']['number']}", _lean_core_risk(report))
                    for report in component_reports
                ),
                intent=_operator_batch_intent(component_reports, shared_files),
                shared_files=shared_files,
                action=_operator_batch_action(component_reports, preferred),
                reason="Exact file overlap creates a real sequencing or duplicate-resolution dependency.",
                confidence="high" if len({report["pr"]["head_sha"] for report in component_reports}) == 1 else "medium",
            )
        )

    batched_numbers = {number for batch in batches for number in batch["prs"]}
    narrow_contracts = {"pkm-privacy", "voice"}
    contract_groups: dict[str, list[dict[str, Any]]] = {}
    for report in reports:
        if report["pr"]["number"] in batched_numbers:
            continue
        contract_groups.setdefault(report["contract_set"], []).append(report)

    for contract_set, grouped in sorted(contract_groups.items()):
        if len(grouped) < 2:
            continue
        grouped = sorted(grouped, key=_report_sort_key)
        lane_set = {report["lane"] for report in grouped}
        risk_set = {_lean_core_risk(report) for report in grouped}
        if contract_set in narrow_contracts and lane_set <= {"merge_now"} and risk_set <= {"low", "non-runtime"}:
            batches.append(
                OrderedDict(
                    title=f"Adjacent {contract_set} Review Pair",
                    prs=[report["pr"]["number"] for report in grouped],
                    preferred_pr=grouped[0]["pr"]["number"],
                    contract_sets=[contract_set],
                    lanes=OrderedDict((f"#{report['pr']['number']}", report["lane"]) for report in grouped),
                    risks=OrderedDict((f"#{report['pr']['number']}", _lean_core_risk(report)) for report in grouped),
                    intent=f"Adjacent {contract_set} review: same narrow contract, separate files, low current risk.",
                    shared_files=[],
                    action="Review together for product/context coherence, but merge separately unless manual review finds a shared proof surface.",
                    reason="Same narrow contract, green gate, low/non-runtime risk, and no exact file overlap.",
                    confidence="medium",
                )
            )
        elif contract_set not in {"backend", "frontend", "general"}:
            batches.append(
                OrderedDict(
                    title=f"Do Not Batch Yet: {contract_set}",
                    prs=[report["pr"]["number"] for report in grouped],
                    preferred_pr=None,
                    contract_sets=[contract_set],
                    lanes=OrderedDict((f"#{report['pr']['number']}", report["lane"]) for report in grouped),
                    risks=OrderedDict((f"#{report['pr']['number']}", _lean_core_risk(report)) for report in grouped),
                    intent=f"{contract_set} intake warning: broad shared label is not enough to form a merge batch.",
                    shared_files=[],
                    action="Keep as separate reviews until manual inspection proves these PRs share a real implementation or product dependency.",
                    reason="Same broad contract label, but no exact file overlap and lane/risk profile is not a low-risk adjacent batch.",
                    confidence="low",
                )
            )

    return batches


def _operator_batch_lines(batches: list[OrderedDict[str, Any]]) -> list[str]:
    if not batches:
        return ["- No actionable operator batches detected from current live overlap and narrow-contract rules."]
    lines: list[str] = []
    for index, batch in enumerate(batches, start=1):
        prs = ", ".join(f"#{number}" for number in batch["prs"])
        lines.extend(
            [
                f"### Batch {index}: {batch['title']}",
                "",
                f"- PRs: {prs}",
                f"- Contracts: `{', '.join(batch['contract_sets'])}`",
                f"- Lanes: `{json.dumps(batch['lanes'])}`",
                f"- Lean/core risk: `{json.dumps(batch['risks'])}`",
                f"- Confidence: `{batch['confidence']}`",
                f"- What this is about: {batch.get('intent', 'Shared PR sequencing.')}",
                f"- Why together: {batch['reason']}",
                f"- Operator action: {batch['action']}",
                f"- Shared files: {_compact_file_list(batch['shared_files'], limit=8)}",
                "",
            ]
        )
    return lines


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
    lines.append(f"What this is about: {report['what_this_is_about']}")
    lines.append(f"Current CI Status Gate: {report['current_ci_status_gate']}")
    lines.append(f"Contract set: {report['contract_set']}")
    lines.append(f"Duplicate group: {report['duplicate_group'] or 'none'}")
    if report.get("canonical_selection_rationale"):
        lines.append(f"Canonical selection rationale: {report['canonical_selection_rationale']}")
    lines.append(f"Author group: {report['author_group']}")
    lines.append(f"Recommended lane: {report['decision']['lane']}")
    lines.append(f"Decision rationale: {report['decision']['rationale']}")
    if report.get("patch_then_merge_reason"):
        lines.append(f"Patch/close reason: {report['patch_then_merge_reason']}")
    lines.append(f"Public comment policy: {report['public_comment_policy']}")
    lines.append(f"Live report action: {report['live_report_action']}")
    lines.append(f"Changed surfaces: {', '.join(report['surface_tags']) or 'none'}")
    if report.get("exact_file_overlap"):
        lines.append("Exact file overlap:")
        for overlap in report["exact_file_overlap"]:
            lines.append(
                f"- #{overlap['other_pr']}: " + ", ".join(overlap["shared_files"])
            )
    if report.get("concept_overlap"):
        lines.append("Concept overlap:")
        for overlap in report["concept_overlap"]:
            lines.append(f"- {overlap}")
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


def _finding(
    finding_id: str,
    severity: str,
    summary: str,
    files: list[str],
    details: Any | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": finding_id,
        "severity": severity,
        "summary": summary,
        "files": files,
    }
    if details is not None:
        payload["details"] = details
    return payload


def _append_finding(report: dict[str, Any], finding: dict[str, Any]) -> None:
    if any(existing["id"] == finding["id"] for existing in report["findings"]):
        return
    report["findings"].append(finding)


def _refresh_report_decision(report: dict[str, Any]) -> None:
    report["decision"] = _recommend_merge_lane(
        ci_status_gate=report["current_ci_status_gate"],
        findings=report["findings"],
        surface_tags=report["surface_tags"],
        changed_files=report["changed_files"],
    )
    report["lane"] = report["decision"]["lane"]
    report["patch_then_merge_reason"] = _patch_then_merge_reason(
        report["findings"], report["lane"]
    )
    report["public_comment_policy"] = _public_comment_policy(report["lane"])
    report["live_report_action"] = _live_report_action(report["lane"])
    report["communication_markdown"] = _communication_markdown(report)


def _account_export_response_shape_marker(report: dict[str, Any]) -> str:
    files = set(report["changed_files"])
    if "consent-protocol/tests/services/test_account_service_export.py" in files:
        return "schema_version_export_bundle"
    if "consent-protocol/tests/services/test_account_service_cleanup_tables.py" in files:
        return "success_data_bundle"
    return "unknown"


def _apply_batch_context(reports: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_number = {report["pr"]["number"]: report for report in reports}
    for left, right in combinations(reports, 2):
        shared = sorted(set(left["changed_files"]) & set(right["changed_files"]))
        if not shared:
            continue
        left["exact_file_overlap"].append(
            OrderedDict(other_pr=right["pr"]["number"], shared_files=shared)
        )
        right["exact_file_overlap"].append(
            OrderedDict(other_pr=left["pr"]["number"], shared_files=shared)
        )
        same_head = left["pr"]["head_sha"] == right["pr"]["head_sha"]
        semantic_group = _semantic_duplicate_group(left, right, shared)
        if same_head or semantic_group:
            signature_source = left["pr"]["head_sha"] if same_head else semantic_group
            duplicate_signature = hashlib.sha1(signature_source.encode("utf-8")).hexdigest()[:10]
            duplicate_group = (
                f"exact-duplicate:{duplicate_signature}"
                if same_head
                else f"{semantic_group}:{duplicate_signature}"
            )
            if not left.get("duplicate_group"):
                left["duplicate_group"] = duplicate_group
            if not right.get("duplicate_group"):
                right["duplicate_group"] = duplicate_group
        elif set(left["changed_files"]) == set(right["changed_files"]):
            left["concept_overlap"].append(
                f"shared_file_sequence with #{right['pr']['number']}: same files, different head; manual diff review required before calling this duplicate"
            )
            right["concept_overlap"].append(
                f"shared_file_sequence with #{left['pr']['number']}: same files, different head; manual diff review required before calling this duplicate"
            )

    duplicate_groups: dict[str, list[dict[str, Any]]] = {}
    for report in reports:
        group = report.get("duplicate_group")
        if not group:
            continue
        duplicate_groups.setdefault(group, []).append(report)

    for group, grouped_reports in duplicate_groups.items():
        if len(grouped_reports) < 2:
            continue
        group_label = (
            "exact duplicate"
            if group.startswith("exact-duplicate:")
            else "semantic duplicate"
            if group.startswith("semantic-duplicate:")
            else group
        )
        preferred = max(
            grouped_reports,
            key=lambda item: _duplicate_preference_key(item, group),
        )
        preferred_number = preferred["pr"]["number"]
        rationale = _canonical_selection_rationale(group, preferred)
        for report in grouped_reports:
            report["canonical_selection_rationale"] = rationale
            report["concept_overlap"].append(
                f"{group_label}: preferred canonical candidate is #{preferred_number} ({rationale})"
            )
            if report["pr"]["number"] == preferred_number:
                continue
            shared_with_preferred = sorted(
                set(report["changed_files"]) & set(preferred["changed_files"])
            )
            _append_finding(
                report,
                _finding(
                    "duplicate_exact_file_overlap",
                    "high",
                    f"This PR shares implementation files with preferred #{preferred_number} for the same contract.",
                    shared_with_preferred,
                    details={"preferred_pr": preferred_number},
                ),
            )
            _append_finding(
                report,
                _finding(
                    "duplicate_product_contract",
                    "high",
                    f"This PR implements the same {group_label} contract as preferred #{preferred_number}.",
                    report["changed_files"],
                    details={"preferred_pr": preferred_number},
                ),
            )
            if _account_export_response_shape_marker(report) != _account_export_response_shape_marker(preferred):
                _append_finding(
                    report,
                    _finding(
                        "account_export_response_shape_differs_from_preferred",
                        "medium",
                        "This PR returns a different account export response shape from the preferred canonical candidate.",
                        [
                            path
                            for path in report["changed_files"]
                            if path in ACCOUNT_EXPORT_CORE_FILES or path.endswith(".test.ts")
                        ],
                        details={
                            "preferred_pr": preferred_number,
                            "this_shape": _account_export_response_shape_marker(report),
                            "preferred_shape": _account_export_response_shape_marker(preferred),
                        },
                    ),
                )

    for report in reports:
        # Keep lookup stable for callers that inspect reports by number after augmentation.
        by_number[report["pr"]["number"]] = report
        _refresh_report_decision(report)
    return list(by_number.values())


def build_batch_report(repo: str, prs: list[int]) -> dict[str, Any]:
    reports = _apply_batch_context([build_report(repo, pr) for pr in prs])
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
        operator_batches=_operator_batches(reports, overlaps),
    )


def _batch_text_report(batch: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(
        f"Batch PR review: {', '.join('#' + str(pr) for pr in batch['prs'])}"
    )
    if batch.get("operator_batches"):
        lines.append(
            "What this batch is about: "
            + str(batch["operator_batches"][0].get("intent", "Shared PR sequencing."))
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


def _open_green_pr_numbers(repo: str, limit: int) -> list[int]:
    output = _run(
        [
            "gh",
            "pr",
            "list",
            "--repo",
            repo,
            "--state",
            "open",
            "--limit",
            str(limit),
            "--json",
            "number,statusCheckRollup,isDraft",
        ]
    )
    rows = json.loads(output)
    numbers: list[int] = []
    for row in rows:
        if row.get("isDraft"):
            continue
        current_checks = _current_checks(row.get("statusCheckRollup", []))
        ci_gate = next(
            (
                item.get("conclusion", "UNKNOWN")
                for item in current_checks
                if item.get("name") == "CI Status Gate"
            ),
            "MISSING",
        )
        if ci_gate == "SUCCESS":
            numbers.append(int(row["number"]))
    return numbers


def _live_report_text(batch: dict[str, Any]) -> str:
    generated_at = batch["generated_at"]
    grouped: dict[str, list[dict[str, Any]]] = {}
    for report in batch["reports"]:
        grouped.setdefault(report["contract_set"], []).append(report)

    lines: list[str] = [
        "# Temporary PR Governance Live Report",
        "",
        "Status: live operational record",
        f"Last refreshed: {generated_at}",
        f"Repo: https://github.com/{batch['repo']}",
        "Scope: open non-draft PRs where `CI Status Gate == SUCCESS` at refresh time",
        "",
        "This file is live-only. Merged and closed PRs belong in GitHub comments, final handoff notes, or a separate audit ledger.",
        "",
        "## Index",
        "",
        "- [Live Summary](#live-summary)",
        "- [Live Risk Matrix](#live-risk-matrix)",
        "- [Recommended PR Sets](#recommended-pr-sets)",
        "- [Operator Batches](#operator-batches)",
        "- [Individual PR Assessments](#individual-pr-assessments)",
        "- [Cross-PR File Overlaps](#cross-pr-file-overlaps)",
        "",
        "### PR Assessment Links",
        "",
    ]
    for report in batch["reports"]:
        pr = report["pr"]
        lines.append(
            f"- [#{pr['number']} - {pr['title']}](#pr-{pr['number']})"
        )
    lines.extend(
        [
            "",
            "## Live Summary",
            "",
            f"- Current open green-gate PRs: {len(batch['prs'])}.",
            f"- Lane counts: `{json.dumps(batch['lane_counts'], sort_keys=True)}`.",
            "- Merge rule: green CI is intake only; merge requires contract-safe, non-duplicate, lean/core-aligned proof.",
            "",
            "## Live Risk Matrix",
            "",
        ]
    )
    lines.append("| PR | Link | Author | Contract | Lane | Lean/Core Risk | Reason |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- |")
    for report in batch["reports"]:
        pr = report["pr"]
        reason = report.get("patch_then_merge_reason") or "green gate, no helper finding"
        lines.append(
            f"| [`#{pr['number']}`](#pr-{pr['number']}) | {pr['url']} | `{_markdown_cell(pr['author'])}` | "
            f"`{_markdown_cell(report['contract_set'])}` | `{_markdown_cell(report['lane'])}` | "
            f"`{_markdown_cell(_lean_core_risk(report))}` | {_markdown_cell(reason)} |"
        )
    lines.extend(
        [
            "",
            "## Recommended PR Sets",
            "",
            "Recommended sets are grouped by contract first, then annotated with lane and lean/core risk so batching starts from product/runtime coherence before author convenience.",
            "",
        ]
    )
    for contract_set, reports in sorted(grouped.items()):
        prs = ", ".join(f"#{report['pr']['number']}" for report in reports)
        lanes = ", ".join(
            f"#{report['pr']['number']}={report['lane']}" for report in reports
        )
        risks = ", ".join(
            f"#{report['pr']['number']}={_lean_core_risk(report)}" for report in reports
        )
        lines.append(f"- `{contract_set}`: {prs} ({lanes}; risk {risks})")
    lines.extend(
        [
            "",
            "## Operator Batches",
            "",
            "Operator batches are the smaller execution groups derived from exact overlap, duplicate groups, or narrow adjacent contracts. Use these for actual merge/close planning; broad recommended sets remain intake buckets.",
            "",
        ]
    )
    lines.extend(_operator_batch_lines(batch.get("operator_batches", [])))
    lines.extend(
        [
            "## Individual PR Assessments",
            "",
            "Each assessment follows the PR governance SOP: contract set, lane, lean/core risk, overlap, findings, related surfaces, and live-report action.",
            "",
        ]
    )
    for report in batch["reports"]:
        lines.extend(_single_pr_live_assessment(report))
        lines.append("")
    lines.extend(["", "## Cross-PR File Overlaps", ""])
    if batch["overlaps"]:
        for overlap in batch["overlaps"]:
            lines.append(
                f"- `#{overlap['pair'][0]}` <-> `#{overlap['pair'][1]}`: "
                f"{_compact_file_list(overlap['shared_files'], limit=8)}"
            )
    else:
        lines.append("- none detected")
    return "\n".join(lines)


def _communication_markdown(report: dict[str, Any]) -> str:
    pr = report["pr"]
    lane = report["decision"]["lane"]
    contract_title = report["contract_set"].replace("-", " ").title()
    findings = report["findings"]
    finding_ids = ", ".join(finding["id"] for finding in findings) if findings else "none"
    proof = (
        f"Current head `{pr['head_sha'][:8]}` has CI Status Gate "
        f"`{report['current_ci_status_gate']}`."
    )

    if lane == "merge_now":
        return "\n".join(
            [
                f"## Approved: {contract_title}",
                "",
                "### What Landed",
                "The current head is aligned with the existing caller, runtime, and trust-boundary contracts.",
                "",
                "### Why This Is Safe",
                "The required gate is green and the review did not find contract or governance regressions.",
                "",
                "### Proof",
                proof,
            ]
        )

    elif lane == "patch_then_merge":
        return "\n".join(
            [
                f"## Approved With Maintainer Patch: {contract_title}",
                "",
                "### What Landed",
                "The direction is useful, but the current head should not be merged unchanged.",
                "",
                "### Maintainer Patch",
                f"Patch required for: {finding_ids}.",
                "",
                "### Why This Path",
                report["decision"]["rationale"],
                "",
                "### Proof",
                proof,
            ]
        )

    if lane in {"harvest_then_close", "close_duplicate"}:
        preferred = None
        for finding in findings:
            details = finding.get("details")
            if isinstance(details, dict) and details.get("preferred_pr"):
                preferred = details["preferred_pr"]
                break
        reason = (
            f"Superseded by preferred `#{preferred}` for the same contract."
            if preferred
            else "Superseded by the canonical implementation for the same contract."
        )
        return "\n".join(
            [
                f"## Closed: {contract_title} Duplicate",
                "",
                "### Decision",
                reason,
                "",
                "### What We Kept",
                "The direction is valid, but only unique tests or observability value should be harvested into the canonical PR.",
                "",
                "### Proof",
                proof,
                "",
                "### Outcome",
                "Closing this avoids two implementation paths for one product contract.",
            ]
        )

    return "\n".join(
        [
            f"## Changes Requested: {contract_title}",
            "",
            "### Direction",
            "The intent may still be useful, but the current merge candidate is not safe to land.",
            "",
            "### Blocker",
            f"Current blockers: {finding_ids}.",
            "",
            "### Path To Merge",
            report["decision"]["rationale"],
            "",
            "### Proof Needed",
            "Rerun the required gate after the risky surface is narrowed or independently proven safe.",
        ]
    )


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
    contract_set = _contract_set(files, patch_map)
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
        contract_set=contract_set,
        what_this_is_about=_what_this_is_about(
            pr_view["title"],
            _extract_summary(pr_view.get("body")),
            files,
            patch_map,
            contract_set,
        ),
        duplicate_group=_duplicate_group(contract_set, files),
        duplicate_selection_factors=_duplicate_selection_factors(contract_set, files, patch_map),
        canonical_selection_rationale=None,
        author_group=_author_group(pr_view.get("author", {}).get("login")),
        exact_file_overlap=[],
        concept_overlap=[],
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
    report["lane"] = report["decision"]["lane"]
    report["patch_then_merge_reason"] = _patch_then_merge_reason(
        report["findings"], report["lane"]
    )
    report["public_comment_policy"] = _public_comment_policy(report["lane"])
    report["live_report_action"] = _live_report_action(report["lane"])
    report["communication_markdown"] = _communication_markdown(report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize current-head PR review risks.")
    parser.add_argument("--repo", default="hushh-labs/hushh-research")
    parser.add_argument("--pr", type=int)
    parser.add_argument("--prs", help="Comma-separated PR numbers for batch review.")
    parser.add_argument("--live-report", action="store_true", help="Build a live-only report from current open green-gate PRs.")
    parser.add_argument("--limit", type=int, default=100, help="Open PR query limit for --live-report.")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    selected_modes = sum(bool(value) for value in (args.pr, args.prs, args.live_report))
    if selected_modes != 1:
        parser.error("use exactly one of --pr, --prs, or --live-report")

    try:
        if args.live_report:
            prs = _open_green_pr_numbers(args.repo, args.limit)
            report = build_batch_report(args.repo, prs) if prs else OrderedDict(
                generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
                repo=args.repo,
                prs=[],
                lane_counts={},
                surface_counts={},
                root_counts={},
                overlaps=[],
                reports=[],
            )
            is_batch = True
            is_live_report = True
        elif args.prs:
            prs = [int(item.strip()) for item in args.prs.split(",") if item.strip()]
            report = build_batch_report(args.repo, prs)
            is_batch = True
            is_live_report = False
        else:
            report = build_report(args.repo, args.pr)
            is_batch = False
            is_live_report = False
    except Exception as exc:
        print(f"pr_review_checklist failed: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(report, indent=2))
    elif is_live_report:
        print(_live_report_text(report))
    else:
        print(_batch_text_report(report) if is_batch else _text_report(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
