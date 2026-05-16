#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import signal
import subprocess
import sys
import time
import tempfile
from collections import OrderedDict
from itertools import combinations
from datetime import datetime, timezone
from pathlib import Path
import re
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_ACTIVE_LIMIT = 100
DEFAULT_CANDIDATE_LIMIT = 40
DEFAULT_QUEUE_COHORT_SIZE = 4
DEFAULT_PER_PR_TIMEOUT_SECONDS = 25
DEFAULT_MAX_PARALLEL_PATCH_TRAINS = 3
DEFAULT_TRAIN_POOL_SIZE = 5
DEFAULT_SELECTION_ORDER = "oldest"
DECISION_WAVE_HIGH_RISK_SIZE = 5
DECISION_WAVE_MIXED_TOPIC_SIZE = 10
DECISION_WAVE_DEFAULT_SIZE = 20
DECISION_WAVE_LOW_RISK_SIZE = 40
SCAN_MODES = {"active", "hybrid", "full"}
SELECTION_ORDERS = {"oldest", "latest"}
FAILED_CHECK_CONCLUSIONS = {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"}
PATCH_ATTACHMENT_BLOCKER_FINDINGS = {
    "frontend_component_without_reachable_caller",
    "new_agent_without_runtime_wiring",
    "new_export_without_app_or_backend_caller",
    "pkm_agent_llm_boundary_without_runtime_contract",
    "standalone_unreachable_runtime_root",
}
SENSITIVE_RUNTIME_CONTRACTS = {
    "account-export",
    "db-release-contract",
    "voice",
    "pkm-privacy",
    "kai-route",
    "frontend-error-safety",
}
HIGH_RISK_DECISION_WAVE_CONTRACTS = SENSITIVE_RUNTIME_CONTRACTS | {
    "backend",
    "frontend-error-safety",
    "ops-governance",
}
SENSITIVE_RUNTIME_FINDING_CAPABILITIES = {
    "auth-token-session-runtime",
    "backend-api-contract-runtime",
    "consent-iam-runtime",
    "db-release-contract",
    "kai-finance-runtime",
    "pkm-vault-runtime",
    "route-shell-onboarding-runtime",
    "streaming-runtime",
    "voice-action-runtime",
    "voice-runtime",
}
TRAIN_SUBAGENT_DEFAULT = ("regression/proof", "reviewer")
TRAIN_SUBAGENT_LANE_BY_CONTRACT = {
    "account-export": ("security/consent/vault/pkm", "security_consent_auditor"),
    "backend": ("backend/contracts", "backend_architect"),
    "content": ("product/docs/founder-language", "product_docs_architect"),
    "db-release-contract": ("data-model/schema/uat", "data_model_architect"),
    "frontend": ("frontend/reachability", "frontend_architect"),
    "frontend-error-safety": ("observability/security", "analytics_observability_architect"),
    "kai-route": ("backend/contracts", "backend_architect"),
    "ops-governance": ("ci/deploy/release", "repo_operator"),
    "pkm-privacy": ("security/consent/vault/pkm", "security_consent_auditor"),
    "voice": ("voice/action", "voice_systems_architect"),
}
TRAIN_SUBAGENT_LANE_BY_FAMILY = {
    "auth-token-session-runtime": ("security/consent/vault/pkm", "security_consent_auditor"),
    "backend-api-contract-runtime": ("backend/contracts", "backend_architect"),
    "consent-iam-runtime": ("security/consent/vault/pkm", "security_consent_auditor"),
    "db-release-contract": ("data-model/schema/uat", "data_model_architect"),
    "kai-finance-runtime": ("security/consent/vault/pkm", "security_consent_auditor"),
    "pkm-vault-runtime": ("security/consent/vault/pkm", "security_consent_auditor"),
    "route-shell-onboarding-runtime": ("frontend/reachability", "frontend_architect"),
    "streaming-runtime": ("backend/contracts", "backend_architect"),
    "voice-action-runtime": ("voice/action", "voice_systems_architect"),
    "voice-runtime": ("voice/action", "voice_systems_architect"),
}
HARD_COLLISION_PATH_MARKERS = (
    "/migrations/",
    "/contracts/",
    "/generated/",
)
HARD_COLLISION_FILENAMES = {
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "requirements.txt",
    "poetry.lock",
    "release_migration_manifest.json",
    "uat_integrated_schema.json",
    "prod_integrated_schema.json",
}
HIGH_SIGNAL_INVENTORY_KEYWORDS = (
    "auth",
    "ci",
    "consent",
    "contract",
    "finance",
    "fix",
    "iam",
    "kai",
    "migration",
    "pkm",
    "security",
    "schema",
    "test",
    "vault",
    "voice",
)
SALVAGEABLE_HIGH_FINDINGS = {
    "account_export_schema_contract_mismatch",
    "backend_contract_without_caller_change",
    "db_contract_without_matching_migration",
    "db_migration_missing_release_manifest",
    "dual_auth_dependency_overlap",
    "existing_runtime_contract_bypass",
    "voice_navigation_namespace_drift",
    "voice_tool_contract_bypass",
}
SALVAGEABLE_MEDIUM_FINDINGS = {
    "account_export_backend_error_detail_leak",
    "account_export_proxy_raw_error_leak",
    "account_export_missing_schema_happy_path_tests",
    "background_task_without_failure_logging",
    "db_migration_missing_schema_contract_update",
    "frontend_error_sanitizer_403_permission_mismatch",
    "frontend_component_without_reachable_caller",
    "kai_finance_direct_action_language_requires_review",
    "commercial_consent_gate_missing_db_backed_validation",
    "existing_capability_overlap_requires_review",
    "mock_consent_history_on_trust_surface",
    "one_kai_runtime_identity_boundary_requires_review",
    "pkm_cloud_projection_authority_boundary_requires_review",
    "service_layer_browser_download_side_effect",
    "runtime_dependency_not_pinned_in_manifest",
    "ignore_surface_changed",
    "sensitive_runtime_change_without_supporting_proof",
    "marketplace_flow_overlap_on_main",
}
CANONICAL_VOICE_RUNTIME_PATHS = (
    "hushh-webapp/components/kai/kai-search-bar.tsx",
    "hushh-webapp/components/kai/voice/voice-console-sheet.tsx",
    "hushh-webapp/lib/voice/voice-session-manager.ts",
    "hushh-webapp/lib/voice/voice-turn-orchestrator.ts",
    "hushh-webapp/lib/voice/voice-action-dispatcher.ts",
    "hushh-webapp/lib/voice/kai-action-gateway.ts",
    "contracts/kai/kai-action-gateway.vnext.json",
    "contracts/kai/voice-action-manifest.v1.json",
)
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
SCHEMATICS_SCRIPT_PATH = Path(__file__).with_name("build_runtime_schematics.py")
PROJECT_SCHEMATICS: dict[str, Any] | None = None
GENERATED_OR_RUNTIME_ARTIFACT_SUFFIXES = (
    ".bin",
    ".db",
    ".sqlite",
    ".sqlite3",
)
GENERATED_OR_RUNTIME_ARTIFACT_NAMES = {
    "audit_logs.json",
}
ROOT_SETUP_FILES = {
    ".env.example",
    "package-lock.json",
    "requirements.txt",
}
CANONICAL_TOP_LEVEL_ROOTS = {
    ".codex",
    ".devcontainer",
    ".github",
    "android",
    "bin",
    "consent-protocol",
    "contracts",
    "docs",
    "hushh-webapp",
    "ios",
    "scripts",
    "tests",
    "tmp",
}
FOUNDER_WIKI_PRODUCT_CANON = (
    "hussh://docs/non-negotiables",
    "hussh://wiki/index",
    "wiki/products/one.md",
    "wiki/products/kai.md",
    "wiki/products/nav.md",
    "wiki/products/pchp.md",
    "wiki/concepts/personal-operating-layer.md",
    "wiki/concepts/byoa.md",
    "wiki/concepts/world-model.md",
    "wiki/concepts/aha-moment.md",
    "wiki/concepts/mlx-on-one-surfaces.md",
    "wiki/concepts/app-intents-conformance.md",
    "wiki/concepts/llm-wiki-pattern.md",
    "wiki/concepts/openclaw.md",
    "wiki/concepts/hu-ssh.md",
    "wiki/concepts/signature-vault.md",
    "wiki/concepts/north-star-user-persona.md",
    "wiki/concepts/one-lens.md",
    "wiki/concepts/pchp-brand-side-endpoint.md",
    "wiki/products/ibrokerage.md",
    "wiki/projects/one-email-kyc-wiki-integration.md",
)
FOUNDER_WIKI_PROBE_KEYWORDS = (
    "one",
    "kai",
    "nav",
    "pchp",
    "byoa",
    "byok",
    "mlx",
    "on-device",
    "on device",
    "app intents",
    "world model",
    "pkm",
    "vault",
    "consent",
    "privacy",
    "personal agent",
    "personal operating layer",
    "aha moment",
    "ibrokerage",
    "openclaw",
    "open claw",
    "hu-ssh",
    "human secure socket",
    "one lens",
    "north-star user",
    "north star user",
    "one email kyc",
    "email kyc",
    "pchp brand-side",
    "brand-side endpoint",
    "signature vault",
    "founder",
    "north-star",
    "north star",
)
PARALLEL_RUNTIME_ROOTS = {
    "agents",
    "audit_logging",
    "consentgrid_agent",
    "policy_engine",
    "privacy_engine",
    "recommendation_engine",
    "semantic_search",
    "trust_scoring",
}
CANONICAL_CAPABILITY_BASELINES: tuple[dict[str, Any], ...] = (
    {
        "id": "voice-runtime",
        "severity": "medium",
        "keywords": (
            "voice",
            "speechrecognition",
            "dictation",
            "microphone",
            "mcp tool",
            "action_id",
        ),
        "path_markers": (
            "voice",
            "kai-command-palette",
            "mcp_modules/tools",
        ),
        "canonical_paths": (
            "hushh-webapp/lib/voice/voice-turn-orchestrator.ts",
            "hushh-webapp/lib/voice/voice-action-dispatcher.ts",
            "hushh-webapp/lib/voice/kai-action-gateway.ts",
            "hushh-webapp/components/kai/voice/voice-console-sheet.tsx",
            "contracts/kai/kai-action-gateway.vnext.json",
            "contracts/kai/voice-action-manifest.v1.json",
            "consent-protocol/hushh_mcp/services/voice_intent_service.py",
        ),
        "summary": (
            "Voice capability overlaps the existing generated action gateway, realtime "
            "orchestrator, dispatcher, and voice console. Treat it as an integration review, "
            "not an isolated new feature."
        ),
    },
    {
        "id": "pkm-vault-runtime",
        "severity": "medium",
        "keywords": (
            "pkm",
            "personal knowledge",
            "vault",
            "memory",
            "domain summary",
            "encrypted",
        ),
        "path_markers": (
            "pkm",
            "personal-knowledge-model",
            "vault",
        ),
        "canonical_paths": (
            "consent-protocol/hushh_mcp/services/personal_knowledge_model_service.py",
            "hushh-webapp/lib/services/personal-knowledge-model-service.ts",
            "hushh-webapp/lib/cache/cache-sync-service.ts",
            "hushh-webapp/lib/pkm/pkm-domain-resource.ts",
            "hushh-webapp/components/vault/vault-lock-guard.tsx",
            "hushh-webapp/components/profile/pkm-explorer-panel.tsx",
            "consent-protocol/docs/reference/personal-knowledge-model.md",
            "docs/reference/architecture/cache-coherence.md",
        ),
        "summary": (
            "PKM/vault/memory changes overlap encrypted storage, metadata projection, "
            "and vault-gated frontend state. Review against the canonical PKM runtime."
        ),
    },
    {
        "id": "auth-token-session-runtime",
        "severity": "medium",
        "keywords": (
            "auth",
            "firebase",
            "apple",
            "google",
            "phone",
            "recaptcha",
            "session",
            "bearer",
            "token",
            "revocation",
            "validate_token_with_db",
        ),
        "path_markers": (
            "auth",
            "firebase",
            "session",
            "middleware",
            "phone-verification-flow",
            "phone-mandate-guard",
        ),
        "canonical_paths": (
            "hushh-webapp/lib/services/auth-service.ts",
            "hushh-webapp/lib/firebase/auth-context.tsx",
            "hushh-webapp/lib/auth/session.ts",
            "hushh-webapp/lib/auth/validate.ts",
            "hushh-webapp/proxy.ts",
            "hushh-webapp/app/api/auth/session/route.ts",
            "consent-protocol/api/middleware.py",
            "consent-protocol/api/utils/firebase_auth.py",
        ),
        "summary": (
            "Auth, token, or session changes overlap Firebase sign-in, phone verification, "
            "bearer/session handling, and DB-backed revocation checks. Review against the "
            "canonical auth runtime instead of accepting an isolated route fix."
        ),
    },
    {
        "id": "streaming-runtime",
        "severity": "medium",
        "keywords": (
            "sse",
            "stream",
            "streaming",
            "backoff",
            "envelope",
            "parser",
            "parseSSEBlocks",
        ),
        "path_markers": (
            "streaming",
            "sse-parser",
            "kai-stream-client",
        ),
        "canonical_paths": (
            "hushh-webapp/lib/streaming/sse-parser.ts",
            "hushh-webapp/lib/streaming/kai-stream-client.ts",
            "hushh-webapp/components/kai/kai-flow.tsx",
            "hushh-webapp/components/consent/notification-provider.tsx",
            "hushh-webapp/app/kai/optimize/page.tsx",
            "hushh-webapp/ios/App/App/Plugins/KaiPlugin.swift",
            "hushh-webapp/__tests__/streaming/sse-parser.test.ts",
        ),
        "summary": (
            "Streaming parser/client changes overlap Kai and consent live event consumers. "
            "Review against canonical event-name, id, multiline data, remainder, and native parity semantics."
        ),
    },
    {
        "id": "consent-iam-runtime",
        "severity": "medium",
        "keywords": (
            "consent",
            "scope",
            "vault_owner",
            "permission",
            "commercial",
            "token",
        ),
        "path_markers": (
            "consent",
            "scope",
            "iam",
        ),
        "canonical_paths": (
            "consent-protocol/hushh_mcp/consent/token.py",
            "consent-protocol/hushh_mcp/consent/scope_bundles.py",
            "consent-protocol/api/routes/consent.py",
            "docs/reference/iam/consent-scope-catalog.md",
            "docs/reference/iam/architecture.md",
        ),
        "summary": (
            "Consent/IAM changes overlap signed token semantics, scope bundles, and "
            "relationship access rules. Review against the canonical trust boundary."
        ),
    },
    {
        "id": "route-shell-onboarding-runtime",
        "severity": "medium",
        "keywords": (
            "onboarding",
            "route",
            "navigation",
            "persona",
            "vault guard",
            "protected route",
            "playwright",
            "page.goto",
            "router.push",
        ),
        "path_markers": (
            "onboarding",
            "route-map",
            "proxy",
            "playwright",
        ),
        "canonical_paths": (
            "hushh-webapp/proxy.ts",
            "hushh-webapp/lib/observability/route-map.ts",
            "hushh-webapp/components/vault/vault-lock-guard.tsx",
            "hushh-webapp/components/auth/phone-mandate-guard.tsx",
            "hushh-webapp/components/kai/onboarding/kai-onboarding-guard.tsx",
            "hushh-webapp/app/ria/onboarding/page.tsx",
            "hushh-webapp/app/kai/onboarding/page.tsx",
            "hushh-webapp/playwright.config.ts",
        ),
        "summary": (
            "Route shell or onboarding changes overlap protected-route state, persona switching, "
            "vault/phone guards, route-map observability, and sequential browser navigation. "
            "Review against the canonical route-shell runtime."
        ),
    },
    {
        "id": "kai-market-analysis-runtime",
        "severity": "medium",
        "keywords": (
            "market",
            "stock",
            "ticker",
            "analysis",
            "buy",
            "sell",
            "not-buy",
            "financial chart",
        ),
        "path_markers": (
            "market",
            "analysis",
            "financial",
            "renaissance",
        ),
        "canonical_paths": (
            "consent-protocol/api/routes/kai/market_insights.py",
            "hushh-webapp/components/kai/views/kai-market-preview-view.tsx",
            "hushh-webapp/components/kai/cards/renaissance-market-list.tsx",
            "docs/reference/kai/kai-accuracy-contract.md",
            "docs/reference/kai/kai-change-impact-matrix.md",
        ),
        "summary": (
            "Kai market or analysis changes overlap financial advice, accuracy, and "
            "market-data presentation contracts. Review against the canonical Kai runtime."
        ),
    },
    {
        "id": "ria-marketplace-runtime",
        "severity": "medium",
        "keywords": (
            "ria",
            "advisor",
            "marketplace",
            "relationship",
            "verification",
        ),
        "path_markers": (
            "ria",
            "marketplace",
            "advisor",
        ),
        "canonical_paths": (
            "consent-protocol/api/routes/ria.py",
            "consent-protocol/hushh_mcp/services/ria_iam_service.py",
            "hushh-webapp/app/marketplace/page.tsx",
            "hushh-webapp/app/marketplace/ria/page-client.tsx",
            "docs/reference/iam/marketplace-contract.md",
        ),
        "summary": (
            "RIA/marketplace changes overlap verified advisor access, relationship "
            "requests, and marketplace consent entry. Review against the existing flow."
        ),
    },
)
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
            "docs/reference/architecture/one-email-kyc.md",
            "docs/reference/architecture/api-contracts.md",
        ),
    },
    {
        "id": "kai_voice_runtime",
        "match_prefixes": (
            "hushh-webapp/lib/voice/",
            "hushh-webapp/components/kai/voice/",
            "hushh-webapp/components/kai/kai-command-palette.tsx",
            "consent-protocol/mcp_modules/tools/kai_tools.py",
            "consent-protocol/hushh_mcp/services/voice_",
            "consent-protocol/api/routes/kai/voice.py",
        ),
        "files": (
            "hushh-webapp/lib/voice/voice-turn-orchestrator.ts",
            "hushh-webapp/lib/voice/voice-action-dispatcher.ts",
            "hushh-webapp/lib/voice/kai-action-gateway.ts",
            "hushh-webapp/components/kai/voice/voice-console-sheet.tsx",
            "consent-protocol/hushh_mcp/services/voice_intent_service.py",
        ),
        "docs": (
            "docs/reference/kai/kai-action-gateway-vnext.md",
            "docs/reference/kai/kai-voice-runtime-architecture.md",
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
    "consent-protocol/docs/reference/personal-knowledge-model.md": "Current PKM storage contract: encrypted blobs/manifests are authoritative and pkm_index is discovery-only metadata.",
    "docs/reference/architecture/cache-coherence.md": "Frontend cache coherence contract for local write-through, encrypted device cache, and mutation invalidation.",
    "docs/reference/kai/kai-interconnection-map.md": "High-level Kai subsystem map including the canonical decision-card surface.",
    "docs/reference/kai/kai-change-impact-matrix.md": "Kai change-governance matrix describing decision-card and stream-contract impacts.",
    "docs/reference/architecture/one-email-kyc.md": "Current One-led KYC mailbox, consent, draft, send, and PKM writeback contract.",
    "hushh-webapp/lib/voice/voice-turn-orchestrator.ts": "Current frontend voice turn coordinator for realtime voice flow and action execution.",
    "hushh-webapp/lib/voice/voice-action-dispatcher.ts": "Current action dispatcher that maps generated voice actions to UI/runtime handlers.",
    "hushh-webapp/lib/voice/kai-action-gateway.ts": "Generated frontend action gateway used as the semantic authority for Kai voice actions.",
    "hushh-webapp/components/kai/voice/voice-console-sheet.tsx": "Current voice console UI surface for realtime Kai voice interaction.",
    "consent-protocol/hushh_mcp/services/voice_intent_service.py": "Backend voice intent mapping service that defines canonical voice action semantics.",
    "docs/reference/kai/kai-action-gateway-vnext.md": "Canonical generated-action contract for Kai voice and typed action parity.",
    "docs/reference/kai/kai-voice-runtime-architecture.md": "Runtime architecture for Kai voice, realtime flow, settlement, and action boundaries.",
}


def _run(cmd: list[str], timeout: int | None = None) -> str:
    attempts = 3 if cmd and cmd[0] == "gh" else 1
    last_message = ""
    for attempt in range(attempts):
        try:
            completed = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=False,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            last_message = f"command timed out after {timeout}s"
            if attempt == attempts - 1:
                raise RuntimeError(f"{' '.join(cmd)}: {last_message}") from exc
            time.sleep(1.5 * (attempt + 1))
            continue
        if completed.returncode == 0:
            return completed.stdout
        last_message = completed.stderr.strip() or completed.stdout.strip() or "command failed"
        retryable = "504" in last_message or "Gateway Timeout" in last_message
        if not retryable or attempt == attempts - 1:
            break
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{' '.join(cmd)}: {last_message}")


def _local_worktree_changed_paths() -> set[str]:
    """Return repo-relative paths with local, uncommitted changes."""
    output = _run(["git", "status", "--porcelain", "--untracked-files=all"])
    paths: set[str] = set()
    for raw_line in output.splitlines():
        if not raw_line:
            continue
        entry = raw_line[3:].strip()
        if not entry:
            continue
        if " -> " in entry:
            old_path, new_path = entry.split(" -> ", 1)
            paths.add(old_path.strip())
            paths.add(new_path.strip())
        else:
            paths.add(entry)
    return paths


def _project_schematics() -> dict[str, Any]:
    global PROJECT_SCHEMATICS
    if PROJECT_SCHEMATICS is not None:
        return PROJECT_SCHEMATICS
    if not SCHEMATICS_SCRIPT_PATH.exists():
        PROJECT_SCHEMATICS = {}
        return PROJECT_SCHEMATICS
    spec = importlib.util.spec_from_file_location(
        "pr_governance_runtime_schematics",
        SCHEMATICS_SCRIPT_PATH,
    )
    if spec is None or spec.loader is None:
        PROJECT_SCHEMATICS = {}
        return PROJECT_SCHEMATICS
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    PROJECT_SCHEMATICS = module.build_schematics()
    return PROJECT_SCHEMATICS


def _required_status_check() -> str:
    ci = _project_schematics().get("ci")
    if isinstance(ci, dict) and ci.get("required_status_check"):
        return str(ci["required_status_check"])
    return "CI Status Gate"


def _schematics_summary() -> OrderedDict[str, Any]:
    schematics = _project_schematics()
    families = schematics.get("runtime_families", [])
    return OrderedDict(
        schema_version=schematics.get("schema_version", ""),
        generated_at=schematics.get("generated_at", ""),
        required_status_check=_required_status_check(),
        runtime_family_count=len(families) if isinstance(families, list) else 0,
        runtime_families=[
            family.get("id")
            for family in families
            if isinstance(family, dict) and family.get("id")
        ],
        skills_count=(schematics.get("governance") or {}).get("skills_count", 0)
        if isinstance(schematics.get("governance"), dict)
        else 0,
        workflows_count=(schematics.get("governance") or {}).get("workflows_count", 0)
        if isinstance(schematics.get("governance"), dict)
        else 0,
    )


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
    if any("voice" in path for path in files):
        return "voice"
    if any(path.startswith("consent-protocol/api/routes/kai/") for path in files):
        if "voice" in patch_text.lower() or "action_id" in patch_text.lower():
            return "voice"
        return "kai-route"
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


def _founder_wiki_probe(
    *,
    title: str,
    summary: str | None,
    files: list[str],
    patch_map: dict[str, str],
    contract_set: str,
) -> OrderedDict[str, Any]:
    patch_text = "\n".join(patch_map.values())
    normalized = _normal_text(title, summary, patch_text, " ".join(files))
    path_trigger = any(
        path.startswith("docs/vision/")
        or path.startswith("docs/future/")
        or path.startswith("docs/reference/architecture/")
        or path.startswith("hushh-webapp/components/kai/")
        or path.startswith("hushh-webapp/app/kai/")
        or path.startswith("hushh-webapp/lib/voice/")
        or path.startswith("contracts/kai/")
        or path.startswith("consent-protocol/hushh_mcp/agents/")
        or "voice" in path.lower()
        or "pkm" in path.lower()
        or "vault" in path.lower()
        or "consent" in path.lower()
        for path in files
    )
    keyword_trigger = any(keyword in normalized for keyword in FOUNDER_WIKI_PROBE_KEYWORDS)
    contract_trigger = contract_set in {"voice", "pkm-privacy", "content"}
    required = path_trigger or keyword_trigger or contract_trigger
    reasons: list[str] = []
    if path_trigger:
        reasons.append("changed paths touch product, trust, voice, PKM, or founder-language surfaces")
    if keyword_trigger:
        reasons.append("title, body, or diff uses Product Canon terms")
    if contract_trigger:
        reasons.append(f"contract set `{contract_set}` is material to north-star alignment")
    return OrderedDict(
        required=required,
        status="needs_founder_wiki_probe" if required else "not_required_for_mechanical_review",
        reason="; ".join(reasons) if reasons else "no material product-direction trigger detected",
        product_canon=list(FOUNDER_WIKI_PRODUCT_CANON if required else []),
        north_star_alignment="needs_verification" if required else "not_applicable",
        drift_classification="current_state_vs_north_star_drift" if required else "none",
        public_comment_policy=(
            "private_wiki_evidence_local_only"
            if required
            else "no_private_wiki_evidence_needed"
        ),
    )


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


def _pkm_projection_authority_boundary_missing(
    files: list[str],
    patch_map: dict[str, str],
) -> bool:
    patch_text = "\n".join(patch_map.values()).lower()
    changed = set(files)
    touches_projection = (
        "merge_pkm_domain_summary" in patch_text
        or (
            "pkm_index" in patch_text
            and (
                "domain_summaries" in patch_text
                or "summary_projection" in patch_text
                or "available_domains" in patch_text
            )
        )
        or any(path == "consent-protocol/hushh_mcp/services/personal_knowledge_model_service.py" for path in files)
    )
    if not touches_projection:
        return False
    if not (
        any(path.startswith("consent-protocol/db/") for path in files)
        or "update_domain_summary" in patch_text
        or "store_domain_data" in patch_text
    ):
        return False

    proof_paths = {
        "consent-protocol/docs/reference/personal-knowledge-model.md",
        "docs/reference/architecture/cache-coherence.md",
        "docs/reference/kai/kai-interconnection-map.md",
        "hushh-webapp/lib/cache/cache-sync-service.ts",
        "hushh-webapp/lib/pkm/pkm-domain-resource.ts",
        "hushh-webapp/__tests__/services/cache-sync-mutation-cascade.test.ts",
        "hushh-webapp/__tests__/services/pkm-cache.test.ts",
    }
    if changed & proof_paths:
        return False

    boundary_terms = (
        "discovery-only",
        "discovery only",
        "cloud projection",
        "projection only",
        "not authoritative",
        "not the source of truth",
        "on-device",
        "local-first",
        "device cache",
        "cachesyncservice",
        "pkmdomainresource",
        "manifests are authoritative",
        "pkm manifests",
    )
    return not any(term in patch_text for term in boundary_terms)


def _commercial_consent_gate_missing_db_backed_validation(
    files: list[str],
    patch_map: dict[str, str],
) -> bool:
    if "consent-protocol/hushh_mcp/consent/token.py" not in files:
        return False

    section = patch_map.get("consent-protocol/hushh_mcp/consent/token.py", "")
    normalized = section.lower()
    if "commercial" not in normalized or "require_commercial" not in normalized:
        return False

    db_signature = re.search(
        r"async\s+def\s+validate_token_with_db\s*\([^)]*require_commercial",
        section,
        flags=re.IGNORECASE | re.DOTALL,
    )
    db_forward = re.search(
        r"validate_token\s*\([^)]*require_commercial\s*=",
        section,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return not (db_signature and db_forward)


def _mock_consent_history_on_trust_surface(
    files: list[str],
    patch_map: dict[str, str],
) -> bool:
    patch_text = "\n".join(patch_map.values())
    normalized = patch_text.lower()
    changed = set(files)
    consent_ui_added = any(
        path.startswith("hushh-webapp/src/components/privacy/")
        or path.startswith("hushh-webapp/components/privacy/")
        or path.startswith("hushh-webapp/components/consent/")
        for path in files
    )
    if not consent_ui_added:
        return False

    hardcoded_data_file = any(
        path.endswith("consentEvents.ts") or path.endswith("consent-events.ts")
        for path in files
    )
    hardcoded_event_terms = (
        "portfolio valuation access",
        "analytics scope",
        "export permission",
        "third-party data access",
        "today,",
        "yesterday,",
        "consentevents",
    )
    hardcoded_history = hardcoded_data_file or any(term in normalized for term in hardcoded_event_terms)
    if not hardcoded_history:
        return False

    existing_history_paths = {
        "hushh-webapp/lib/services/api-service.ts",
        "hushh-webapp/lib/services/consent-center-service.ts",
        "hushh-webapp/components/consent/consent-center-page.tsx",
        "hushh-webapp/app/api/consent/history/route.ts",
        "consent-protocol/api/routes/consent.py",
        "consent-protocol/hushh_mcp/services/consent_center_service.py",
    }
    production_route_touch = (
        "hushh-webapp/app/kai/page.tsx" in changed
        or "hushh-webapp/app/consents/page.tsx" in changed
        or "hushh-webapp/components/consent/consent-center-page.tsx" in changed
    )
    return production_route_touch and not (changed & existing_history_paths)


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


def _git_grep_origin_main(pattern: str) -> list[str]:
    completed = subprocess.run(
        ["git", "grep", "-n", pattern, "origin/main", "--", "hushh-webapp"],
        capture_output=True,
        text=True,
        check=False,
        cwd=REPO_ROOT,
    )
    if completed.returncode not in (0, 1):
        return []
    return [line for line in completed.stdout.splitlines() if line.strip()]


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


def _failed_non_required_checks(
    current_checks: list[dict[str, Any]],
    required_status_check: str,
) -> list[dict[str, Any]]:
    failed: list[dict[str, Any]] = []
    for check in current_checks:
        name = str(check.get("name") or "")
        conclusion = str(check.get("conclusion") or "UNKNOWN").upper()
        if name != required_status_check and conclusion in FAILED_CHECK_CONCLUSIONS:
            failed.append(check)
    return failed


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


def _is_test_path(path: str) -> bool:
    return (
        "/tests/" in path
        or path.startswith("consent-protocol/tests/")
        or path.startswith("hushh-webapp/__tests__/")
        or path.endswith((".test.ts", ".test.tsx", ".test.py"))
    )


def _is_doc_path(path: str) -> bool:
    return (
        path.startswith("docs/")
        or path.startswith("consent-protocol/docs/")
        or path.startswith("hushh-webapp/docs/")
    )


def _pascal_from_component_path(path: str) -> str:
    stem = Path(path).stem
    return "".join(part[:1].upper() + part[1:] for part in re.split(r"[-_]+", stem) if part)


def _frontend_component_reachability_findings(
    files: list[str],
    patch_map: dict[str, str],
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    changed_set = set(files)
    for path in files:
        if not (
            path.startswith("hushh-webapp/components/")
            and path.endswith((".tsx", ".ts"))
            and "/__tests__/" not in path
        ):
            continue
        component_name = _pascal_from_component_path(path)
        if not component_name:
            continue
        import_token = path
        if import_token.startswith("hushh-webapp/"):
            import_token = f"@/{import_token[len('hushh-webapp/'):]}"
        import_token = import_token.rsplit(".", 1)[0]
        basename_token = Path(path).stem

        other_changed_refs = [
            changed_path
            for changed_path, section in patch_map.items()
            if changed_path != path
            and (
                component_name in section
                or import_token in section
                or basename_token in section
            )
        ]
        origin_refs = [
            line
            for token in (component_name, import_token, basename_token)
            for line in _git_grep_origin_main(token)
            if f":{path}:" not in line
        ]
        if other_changed_refs or origin_refs:
            continue

        if any(
            candidate.startswith("hushh-webapp/__tests__/")
            and component_name in patch_map.get(candidate, "")
            for candidate in changed_set
        ):
            continue

        findings.append(
            {
                "id": "frontend_component_without_reachable_caller",
                "severity": "medium",
                "summary": (
                    "Frontend component changed without a reachable app, route, or caller import. "
                    "Do not treat this as a live app improvement until the PR proves where the "
                    "component renders or narrows the claim to component-level hygiene."
                ),
                "files": [path],
            }
        )
    return findings


def _new_export_reachability_findings(
    files: list[str],
    patch_map: dict[str, str],
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for path in files:
        if _is_test_path(path) or _is_doc_path(path):
            continue
        if not path.startswith(("hushh-webapp/", "consent-protocol/", "packages/")):
            continue
        section = patch_map.get(path, "")
        exported_symbols = sorted(
            set(
                re.findall(
                    r"^\+export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)",
                    section,
                    flags=re.MULTILINE,
                )
            )
        )
        if not exported_symbols:
            continue

        unreachable: list[str] = []
        for symbol in exported_symbols:
            changed_non_test_refs = [
                changed_path
                for changed_path, changed_section in patch_map.items()
                if changed_path != path
                and not _is_test_path(changed_path)
                and not _is_doc_path(changed_path)
                and symbol in changed_section
            ]
            origin_refs = [
                line
                for line in _git_grep_origin_main(symbol)
                if f":{path}:" not in line
                and "/__tests__/" not in line
                and "/tests/" not in line
            ]
            if not changed_non_test_refs and not origin_refs:
                unreachable.append(symbol)

        if unreachable:
            findings.append(
                {
                    "id": "new_export_without_app_or_backend_caller",
                    "severity": "medium",
                    "summary": (
                        "A new exported helper/API is only proven by tests or local code, not by a "
                        "reachable app, backend, package, or existing caller. Treat the PR as "
                        "standalone utility work until it links to a canonical use case or narrows "
                        "the claim to internal test coverage."
                    ),
                    "files": [path],
                    "details": {"symbols": unreachable},
                }
            )
    return findings


CLAIM_SURFACE_RULES: tuple[dict[str, Any], ...] = (
    {
        "id": "vault",
        "keywords": (
            "vault",
            "encrypt",
            "decrypt",
            "zero key",
            "zero-key",
            "all-zero",
            "zero-salt",
            "salt coercion",
            "recovery key",
        ),
        "path_markers": (
            "/vault/",
            "vault-web",
            "encrypt.ts",
            "prf-auth",
            "recovery-key",
            "lib/capacitor/plugins/vault",
        ),
    },
    {
        "id": "streaming",
        "keywords": (
            "sse",
            "stream",
            "streaming",
            "parser",
            "backoff",
            "envelope",
            "oom",
        ),
        "path_markers": (
            "/streaming/",
            "sse-parser",
            "kai-stream",
        ),
    },
    {
        "id": "consent",
        "keywords": (
            "consent",
            "scope",
            "session",
            "token",
            "logout",
            "revoke",
        ),
        "path_markers": (
            "/consent",
            "/session",
            "consent/",
            "token.py",
        ),
    },
)


def _claim_surface_mismatch_findings(
    title: str,
    summary: str | None,
    files: list[str],
) -> list[dict[str, Any]]:
    text = _normal_text(title, summary)
    touched = "\n".join(files).lower()
    claimed = [
        rule
        for rule in CLAIM_SURFACE_RULES
        if any(keyword in text for keyword in rule["keywords"])
    ]
    if len(claimed) < 1:
        return []

    findings: list[dict[str, Any]] = []
    for rule in claimed:
        touches_claimed_surface = any(marker in touched for marker in rule["path_markers"])
        if touches_claimed_surface:
            continue
        findings.append(
            {
                "id": "pr_claim_changed_surface_mismatch",
                "severity": "high",
                "summary": (
                    f"The PR title/body claims `{rule['id']}` behavior, but the changed files do "
                    "not touch that canonical surface. Do not merge on the stated premise until "
                    "the contributor retitles/rescopes the PR or the diff is replaced with the "
                    "claimed implementation."
                ),
                "files": files,
                "details": {"claimed_surface": rule["id"]},
            }
        )
    return findings


def _stacked_branch_findings(
    title: str,
    summary: str | None,
    files: list[str],
) -> list[dict[str, Any]]:
    text = _normal_text(title, summary)
    stack_markers = (
        "stacked pr",
        "stacked branch",
        "created from the previous",
        "created from previous",
        "once earlier pr",
        "once earlier prs",
        "after earlier pr",
        "after earlier prs",
        "diff against main will collapse",
        "extends pr",
        "previous fix",
        "relies on",
    )
    if not any(marker in text for marker in stack_markers):
        return []

    non_test_doc_files = [
        path for path in files if not _is_test_path(path) and not _is_doc_path(path)
    ]
    top_dirs = sorted(
        {
            "/".join(path.split("/")[:3])
            for path in non_test_doc_files
            if "/" in path
        }
    )
    broad_or_unstable = len(non_test_doc_files) > 2 or len(top_dirs) > 1
    if not broad_or_unstable and "diff against main will collapse" not in text:
        return []

    return [
        {
            "id": "stacked_branch_diff_not_reviewable",
            "severity": "high",
            "summary": (
                "The PR describes itself as stacked or dependent on earlier work, and the current "
                "diff against main includes prior/unrelated surfaces. Do not merge or judge it as "
                "the stated feature until it is rebased/split so the diff is reviewable."
            ),
            "files": files,
            "details": {"top_dirs": top_dirs},
        }
    ]


def _kai_finance_action_language_findings(
    files: list[str],
    patch_map: dict[str, str],
) -> list[dict[str, Any]]:
    finance_surface = any(
        path.startswith("hushh-webapp/components/kai/")
        or path.startswith("hushh-webapp/app/kai/")
        or path.startswith("hushh-webapp/lib/services/")
        or path.startswith("marketing/")
        for path in files
    )
    if not finance_surface:
        return []

    added_lines: list[str] = []
    removed_lines: set[str] = set()
    for path, section in patch_map.items():
        if path.startswith("hushh-webapp/__tests__/"):
            continue
        for line in section.splitlines():
            if line.startswith("+++") or line.startswith("---"):
                continue
            if line.startswith("+"):
                added_lines.append(line[1:])
            elif line.startswith("-"):
                removed_lines.add(line[1:])
    added_text = "\n".join(line for line in added_lines if line not in removed_lines)
    risky_patterns = (
        r"\bdo not buy\b",
        r"\brated a buy\b",
        r"\bbefore adding\b",
        r"\bhigher returns\b",
        r"\bfaster growth\b",
        r"return\s+['\"]buy['\"]",
        r"return\s+['\"]sell['\"]",
    )
    if not any(re.search(pattern, added_text, flags=re.IGNORECASE) for pattern in risky_patterns):
        return []

    return [
        {
            "id": "kai_finance_direct_action_language_requires_review",
            "severity": "medium",
            "summary": (
                "Kai finance UI or content introduces direct trading-action language. "
                "User-facing market surfaces should present signals, evidence, confidence, "
                "and uncertainty, not personalized buy/sell instructions or return promises."
            ),
            "files": [
                path
                for path in files
                if path.startswith("hushh-webapp/components/kai/")
                or path.startswith("hushh-webapp/app/kai/")
                or path.startswith("marketing/")
            ]
            or files,
        }
    ]


def _kai_finance_runtime_llm_findings(
    files: list[str],
    patch_map: dict[str, str],
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    kai_runtime_files = [
        path
        for path in files
        if path.startswith("consent-protocol/hushh_mcp/agents/kai/")
        or path.startswith("consent-protocol/hushh_mcp/operons/kai/")
        or path.startswith("consent-protocol/api/routes/kai/")
    ]
    if not kai_runtime_files:
        return findings

    added_lines: list[str] = []
    for path in kai_runtime_files:
        for line in patch_map.get(path, "").splitlines():
            if line.startswith("+") and not line.startswith("+++"):
                added_lines.append(line[1:])
    added_text = "\n".join(added_lines)
    if not added_text:
        return findings

    adds_llm_call = any(
        marker in added_text
        for marker in (
            "stream_gemini_response",
            ".run(",
            "generate_content",
            "llm",
            "LLM",
        )
    )
    adds_timeout_mediation = "asyncio.wait_for" in added_text or "timeout=" in added_text
    changes_consensus = any(
        marker in added_text
        for marker in (
            "_build_consensus",
            "_resolve_conflict",
            "confidence +=",
            "dissenting_opinions.append",
        )
    )
    if adds_llm_call and (adds_timeout_mediation or changes_consensus):
        findings.append(
            {
                "id": "kai_finance_extra_llm_call_requires_review",
                "severity": "high",
                "summary": (
                    "Kai finance runtime adds a new LLM call or mediator path inside analysis, "
                    "consensus, or route execution. This can change latency, rate-limit behavior, "
                    "and financial decision semantics, so it requires explicit runtime review before merge."
                ),
                "files": kai_runtime_files,
            }
        )
    return findings


def _new_agent_runtime_boundary_findings(
    files: list[str],
    patch_map: dict[str, str],
) -> list[dict[str, Any]]:
    agent_files = [
        path
        for path in files
        if path.startswith("consent-protocol/hushh_mcp/agents/")
        and path.endswith((".py", ".yaml"))
        and "/tests/" not in path
        and (_git_show_origin_main(path) is None or "new file mode" in patch_map.get(path, ""))
    ]
    if not agent_files:
        return []

    patch_text = "\n".join(patch_map.get(path, "") for path in agent_files)
    creates_agent = any(
        marker in patch_text
        for marker in (
            "class ",
            "HushhAgent",
            "agent_id",
            "system_prompt",
            "agent.yaml",
        )
    )
    if not creates_agent:
        return []

    non_test_files = [path for path in files if not path.startswith("consent-protocol/tests/")]
    integration_files = [
        path
        for path in non_test_files
        if path.startswith("consent-protocol/api/routes/")
        or path.startswith("consent-protocol/hushh_mcp/services/")
        or path.startswith("consent-protocol/hushh_mcp/adk_bridge/")
        or path.startswith("consent-protocol/hushh_mcp/agents/one/")
        or path.startswith("hushh-webapp/")
        or path.startswith("docs/")
        or path.startswith("consent-protocol/docs/")
    ]
    if integration_files:
        return []

    finding_id = "new_agent_without_runtime_wiring"
    summary = (
        "PR adds a new backend agent but does not wire it into a canonical route, "
        "service, planner, manifest, docs contract, or current product flow. Treat this "
        "as a deeper architecture review, not a green-gate merge."
    )
    severity = "high"
    if "pkm" in patch_text.lower() or "summary" in patch_text.lower() or ".run(" in patch_text:
        finding_id = "pkm_agent_llm_boundary_without_runtime_contract"
        summary = (
            "PR adds a PKM/memory-facing agent with an LLM boundary but does not prove how "
            "it preserves the on-device-first PKM authority, consent scope, cache coherence, "
            "or canonical service integration."
        )

    return [
        {
            "id": finding_id,
            "severity": severity,
            "summary": summary,
            "files": agent_files,
        }
    ]


def _db_migration_files(files: list[str]) -> list[str]:
    return sorted(
        path
        for path in files
        if path.startswith("consent-protocol/db/migrations/")
        and path.endswith(".sql")
    )


def _db_contract_files(files: list[str]) -> list[str]:
    return sorted(path for path in files if path in DB_CONTRACT_FILES)


def _sql_migration_patch_changes_runtime(section: str) -> bool:
    """Return true when a migration diff changes SQL, not only comments."""
    for line in section.splitlines():
        if not line.startswith(("+", "-")):
            continue
        if line.startswith(("+++", "---")):
            continue
        content = line[1:].strip()
        if not content:
            continue
        if content.startswith("--"):
            continue
        return True
    return False


def _path_touches_capability(path: str, markers: tuple[str, ...]) -> bool:
    lowered = path.lower()
    for root in ("consent-protocol/", "hushh-webapp/"):
        if lowered.startswith(root):
            lowered = lowered[len(root):]
            break
    tokens = set(re.split(r"[^a-z0-9]+", lowered))
    return any(marker in tokens or f"/{marker}/" in lowered for marker in markers)


def _text_contains_capability_keyword(text: str, keyword: str) -> bool:
    escaped = re.escape(keyword.lower())
    if re.search(r"\W", keyword):
        return re.search(rf"(?<![a-z0-9]){escaped}(?![a-z0-9])", text) is not None
    return re.search(rf"\b{escaped}\b", text) is not None


def _runtime_family_paths(family: dict[str, Any]) -> tuple[str, ...]:
    paths: list[str] = []
    for key in (
        "source_contracts",
        "generated_artifacts",
        "runtime_sources",
        "route_sources",
        "owned_paths",
        "checked_schema_contracts",
        "docs",
    ):
        value = family.get(key)
        if isinstance(value, list):
            paths.extend(path for path in value if isinstance(path, str))
    return tuple(dict.fromkeys(paths))


def _schematic_capability_baselines() -> tuple[dict[str, Any], ...]:
    schematics = _project_schematics()
    families = schematics.get("runtime_families", [])
    if not isinstance(families, list):
        return CANONICAL_CAPABILITY_BASELINES

    keyword_markers: dict[str, tuple[tuple[str, ...], tuple[str, ...], str]] = {
        "voice-action-runtime": (
            ("voice", "speechrecognition", "dictation", "microphone", "mcp tool", "action_id"),
            ("voice", "kai-command-palette", "mcp_modules/tools"),
            "Voice capability overlaps the current generated action gateway, realtime orchestrator, dispatcher, and voice console. Treat it as an integration review, not an isolated new feature.",
        ),
        "pkm-vault-runtime": (
            ("pkm", "personal knowledge", "vault", "memory", "domain summary", "encrypted"),
            ("pkm", "personal-knowledge-model", "vault"),
            "PKM/vault/memory changes overlap encrypted storage, metadata projection, and vault-gated frontend state. Review against the repo-derived PKM runtime.",
        ),
        "consent-iam-runtime": (
            ("consent", "scope", "vault_owner", "permission", "commercial", "token"),
            ("consent", "scope", "iam"),
            "Consent/IAM changes overlap signed token semantics, scope bundles, and relationship access rules. Review against the repo-derived trust boundary.",
        ),
        "route-shell-onboarding-runtime": (
            ("onboarding", "route", "navigation", "persona", "vault guard", "protected route", "playwright", "page.goto", "router.push"),
            ("onboarding", "route-map", "proxy", "playwright"),
            "Route shell or onboarding changes overlap protected-route state, persona switching, vault/phone guards, route-map observability, and sequential browser navigation.",
        ),
        "kai-finance-runtime": (
            ("market", "stock", "ticker", "analysis", "buy", "sell", "not-buy", "financial chart"),
            ("market", "analysis", "financial", "renaissance"),
            "Kai market or analysis changes overlap financial advice, accuracy, and market-data presentation contracts. Review against the repo-derived Kai runtime.",
        ),
        "backend-api-contract-runtime": (
            ("api", "route", "proxy", "response", "request", "http"),
            ("api", "routes", "services"),
            "Backend API changes overlap route, service, and caller contracts. Review against the repo-derived backend API contract surface.",
        ),
        "db-release-contract": (
            ("migration", "schema", "table", "column", "index", "uat", "release"),
            ("db", "migrations", "contracts"),
            "DB changes overlap migration ordering, checked schema contracts, and live runtime readiness.",
        ),
    }
    rules: list[dict[str, Any]] = []
    for family in families:
        if not isinstance(family, dict):
            continue
        family_id = str(family.get("id") or "")
        if family_id not in keyword_markers:
            continue
        keywords, markers, summary = keyword_markers[family_id]
        canonical_paths = _runtime_family_paths(family)
        if not canonical_paths:
            continue
        rules.append(
            {
                "id": family_id,
                "severity": "medium",
                "keywords": keywords,
                "path_markers": markers,
                "canonical_paths": canonical_paths,
                "summary": summary,
            }
        )
    return tuple(rules) if rules else CANONICAL_CAPABILITY_BASELINES


def _existing_capability_overlap_findings(
    files: list[str],
    patch_text: str,
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    lowered_patch = patch_text.lower()
    changed_set = set(files)

    for rule in _schematic_capability_baselines():
        keywords = tuple(rule["keywords"])
        path_markers = tuple(rule["path_markers"])
        canonical_paths = tuple(rule["canonical_paths"])
        keyword_match = any(
            _text_contains_capability_keyword(lowered_patch, keyword)
            for keyword in keywords
        )
        path_match = any(_path_touches_capability(path, path_markers) for path in files)
        if rule["id"] != "voice-runtime" and not path_match:
            continue
        if not keyword_match and not path_match:
            continue

        existing_canonical = [
            path
            for path in canonical_paths
            if _path_exists(path) or _git_show_origin_main(path) is not None
        ]
        if not existing_canonical:
            continue

        touched_canonical = sorted(changed_set & set(existing_canonical))
        if touched_canonical:
            continue

        related_changed = sorted(
            path
            for path in files
            if _path_touches_capability(path, path_markers)
            or any(
                _text_contains_capability_keyword(path.lower().replace("-", " "), keyword)
                for keyword in keywords
            )
        )
        findings.append(
            {
                "id": "existing_capability_overlap_requires_review",
                "severity": rule["severity"],
                "summary": rule["summary"],
                "files": related_changed or files,
                "details": {
                    "capability": rule["id"],
                    "canonical_paths": existing_canonical[:5],
                },
            }
        )

    return findings


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

    new_roots = _new_top_level_roots(files)
    if new_roots:
        findings.append(
            {
                "id": "new_top_level_parallel_root",
                "severity": "high",
                "summary": (
                    "PR creates a new top-level root that is not present on `origin/main`. "
                    "New root subsystems require explicit canonical ownership, route/service "
                    "reachability, and north-star fit before merge."
                ),
                "files": [
                    path
                    for path in files
                    if path.split("/", 1)[0] in new_roots
                ],
                "details": {"new_roots": new_roots},
            }
        )

    setup_files = _root_setup_files(files)
    if setup_files:
        findings.append(
            {
                "id": "root_setup_surface_added",
                "severity": "high",
                "summary": (
                    "PR adds generic root setup files such as `.env.example`, root "
                    "`requirements.txt`, or root `package-lock.json`. Hussh setup and "
                    "dependencies must stay in canonical package/runtime surfaces."
                ),
                "files": setup_files,
            }
        )

    generated_artifacts = _generated_or_runtime_artifact_files(files)
    if generated_artifacts:
        findings.append(
            {
                "id": "checked_in_generated_runtime_artifact",
                "severity": "high",
                "summary": (
                    "PR checks in generated/runtime data such as vector-store binaries, "
                    "SQLite databases, or logs. These artifacts do not belong in source review."
                ),
                "files": generated_artifacts,
            }
        )

    parallel_runtime_files = _parallel_runtime_root_files(files)
    if parallel_runtime_files:
        findings.append(
            {
                "id": "standalone_unreachable_runtime_root",
                "severity": "high",
                "summary": (
                    "PR introduces a standalone runtime subsystem outside the canonical app, "
                    "protocol, vault, consent, or Kai surfaces. Green tests for the new path "
                    "alone are not proof that the current product calls or owns it."
                ),
                "files": parallel_runtime_files,
                "details": {
                    "roots": sorted(
                        {path.split("/", 1)[0] for path in parallel_runtime_files}
                    )
                },
            }
        )

    personal_memory_files = [
        path for path in files if path.startswith("agents/personal-memory-agent/")
    ]
    if personal_memory_files:
        findings.append(
            {
                "id": "pkm_memory_outside_vault_consent_boundaries",
                "severity": "high",
                "summary": (
                    "PR adds personal-memory/PKM behavior outside the canonical vault, cache, "
                    "consent, and PKM projection contracts. Memory intelligence must extend "
                    "the existing encrypted/vault-gated PKM path, not create a parallel agent root."
                ),
                "files": personal_memory_files,
            }
        )

    cot_paths = _chain_of_thought_persistence_paths(patch_map)
    if cot_paths:
        findings.append(
            {
                "id": "direct_chain_of_thought_persistence",
                "severity": "high",
                "summary": (
                    "PR appears to persist reasoning traces or chain-of-thought-like data. "
                    "Persist durable receipts, evidence, decisions, and evaluation metadata, "
                    "not hidden reasoning traces."
                ),
                "files": cot_paths,
            }
        )

    empty_files = _empty_new_files(patch_map)
    if empty_files:
        findings.append(
            {
                "id": "empty_new_file_without_behavior",
                "severity": "high",
                "summary": (
                    "PR adds an empty new file. Green CI only proves there is no executable "
                    "behavior to validate; this should not be merged as a functional contribution."
                ),
                "files": empty_files,
            }
        )

    language_mismatches = _script_language_mismatch_files(patch_map)
    if language_mismatches:
        findings.append(
            {
                "id": "script_language_extension_mismatch",
                "severity": "high",
                "summary": (
                    "PR writes content in the wrong script language for the file extension or "
                    "replaces an existing script with a different language. This can silently "
                    "break developer tooling even when lightweight CI passes."
                ),
                "files": language_mismatches,
            }
        )

    if _devex_env_validation_unwired(files):
        findings.append(
            {
                "id": "devex_validation_script_unwired",
                "severity": "medium",
                "summary": (
                    "PR adds environment-validation scripts without wiring them to the canonical "
                    "`./bin/hushh` onboarding/doctor path or updating contributor docs. Devex checks "
                    "should extend the existing operator entrypoint instead of adding isolated scripts."
                ),
                "files": [path for path in files if path.startswith("scripts/validate-env")],
            }
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

    findings.extend(_frontend_component_reachability_findings(files, patch_map))
    findings.extend(_new_export_reachability_findings(files, patch_map))
    findings.extend(_kai_finance_action_language_findings(files, patch_map))
    findings.extend(_kai_finance_runtime_llm_findings(files, patch_map))
    findings.extend(_new_agent_runtime_boundary_findings(files, patch_map))
    findings.extend(_existing_capability_overlap_findings(files, patch_text))

    migration_files = _db_migration_files(files)
    runtime_migration_files = [
        path
        for path in migration_files
        if _sql_migration_patch_changes_runtime(patch_map.get(path, ""))
    ]
    contract_files = _db_contract_files(files)
    release_manifest_changed = DB_RELEASE_MANIFEST_FILE in files
    if runtime_migration_files:
        if not release_manifest_changed:
            findings.append(
                {
                    "id": "db_migration_missing_release_manifest",
                    "severity": "high",
                    "summary": (
                        "DB migration files changed without updating the release migration "
                        "manifest, so UAT/prod operators may not apply the migration in order."
                    ),
                    "files": runtime_migration_files,
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
                    "files": runtime_migration_files,
                }
            )
    if contract_files and not runtime_migration_files:
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
    if _pkm_projection_authority_boundary_missing(files, patch_map):
        findings.append(
            {
                "id": "pkm_cloud_projection_authority_boundary_requires_review",
                "severity": "medium",
                "summary": (
                    "PKM index/domain-summary projection changed without proving the on-device "
                    "and local-cache authority boundary. `pkm_index` must remain discovery-only "
                    "cloud metadata; encrypted domain data, manifests, and local write-through "
                    "cache stay authoritative for user memory."
                ),
                "files": [
                    path
                    for path in files
                    if path.startswith("consent-protocol/db/")
                    or path == "consent-protocol/hushh_mcp/services/personal_knowledge_model_service.py"
                    or path in {
                        "consent-protocol/docs/reference/personal-knowledge-model.md",
                        "docs/reference/architecture/cache-coherence.md",
                        "hushh-webapp/lib/cache/cache-sync-service.ts",
                        "hushh-webapp/lib/pkm/pkm-domain-resource.ts",
                    }
                ]
                or files,
                "details": {
                    "required_boundary": (
                        "Cloud summary/index writes are sync projections only. Local encrypted "
                        "domain data, manifests, mutation events, and cache write-through remain "
                        "the user-memory authority."
                    )
                },
            }
        )

    if _commercial_consent_gate_missing_db_backed_validation(files, patch_map):
        findings.append(
            {
                "id": "commercial_consent_gate_missing_db_backed_validation",
                "severity": "medium",
                "summary": (
                    "Commercial consent-token gating was added only to the in-memory validator. "
                    "Critical runtime paths now use DB-backed revocation validation, so "
                    "`validate_token_with_db` must accept and forward `require_commercial` before "
                    "commercial enforcement is actually usable."
                ),
                "files": ["consent-protocol/hushh_mcp/consent/token.py"],
            }
        )

    if _mock_consent_history_on_trust_surface(files, patch_map):
        findings.append(
            {
                "id": "mock_consent_history_on_trust_surface",
                "severity": "medium",
                "summary": (
                    "Consent audit UI adds hardcoded consent events to a production trust surface. "
                    "Consent history must come from the canonical consent-center/history contract "
                    "or render an honest empty/loading state; fake grants, revokes, actors, or "
                    "timestamps cannot ship on authenticated app routes."
                ),
                "files": [
                    path
                    for path in files
                    if path.startswith("hushh-webapp/src/components/privacy/")
                    or path.startswith("hushh-webapp/components/privacy/")
                    or path.endswith("consentEvents.ts")
                    or path in {
                        "hushh-webapp/app/kai/page.tsx",
                        "hushh-webapp/app/consents/page.tsx",
                    }
                ]
                or files,
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

    if _adds_parallel_voice_input_surface(files, patch_text):
        findings.append(
            {
                "id": "parallel_voice_input_surface",
                "severity": "high",
                "summary": (
                    "PR adds a new browser speech/dictation entry point while the Kai realtime "
                    "voice runtime already owns microphone UX, vault gating, transcript handling, "
                    "and action execution. This is a product-surface duplicate unless explicitly "
                    "approved as an accessibility fallback and integrated with the canonical voice state."
                ),
                "files": [
                    path
                    for path in files
                    if path == "hushh-webapp/components/kai/kai-command-palette.tsx"
                    or path.endswith("use-voice-dictation.ts")
                    or "speech" in path.lower()
                    or "dictation" in path.lower()
                ],
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

    if contract_set == "voice":
        voice_text = patch_text.lower()
        if (
            (
                "hushh-webapp/components/kai/kai-command-palette.tsx" in files
                or any(path.endswith("use-voice-dictation.ts") for path in files)
            )
            and (
                "speechrecognition" in voice_text
                or "webkitspeechrecognition" in voice_text
                or "dictation" in voice_text
            )
            and _path_exists("hushh-webapp/lib/voice/voice-turn-orchestrator.ts")
            and _path_exists("hushh-webapp/components/kai/voice/voice-console-sheet.tsx")
        ):
            findings.append(
                {
                    "id": "parallel_voice_input_surface",
                    "severity": "medium",
                    "summary": (
                        "PR adds browser SpeechRecognition/dictation beside the existing Kai voice "
                        "runtime; verify it is an intentional fallback integrated with current voice "
                        "state, action parity, and permission UX rather than a parallel voice path."
                    ),
                    "files": [
                        path
                        for path in files
                        if path == "hushh-webapp/components/kai/kai-command-palette.tsx"
                        or path.endswith("use-voice-dictation.ts")
                    ],
                }
            )

        introduces_tool_handlers = any(
            path in {
                "consent-protocol/mcp_modules/tools/kai_tools.py",
                "consent-protocol/mcp_modules/tools/definitions.py",
                "consent-protocol/mcp_server.py",
            }
            for path in files
        )
        updates_generated_voice_contract = any(
            path.endswith(".voice-action-contract.json")
            or path.startswith("contracts/kai/")
            or path.startswith("hushh-webapp/contracts/kai/")
            for path in files
        )
        if introduces_tool_handlers and "action_id" in voice_text and not updates_generated_voice_contract:
            findings.append(
                {
                    "id": "voice_tool_contract_bypass",
                    "severity": "high",
                    "summary": (
                        "PR adds backend voice/MCP tool action IDs without updating the local "
                        "voice-action contracts or generated gateway that are the current semantic "
                        "authority."
                    ),
                    "files": [
                        path
                        for path in files
                        if path.startswith("consent-protocol/mcp_modules/tools/")
                        or path == "consent-protocol/mcp_server.py"
                    ],
                }
            )

        if re.search(r"action[_-]?id[^\n]*['\"]nav\.", patch_text, flags=re.IGNORECASE):
            findings.append(
                {
                    "id": "voice_navigation_namespace_drift",
                    "severity": "high",
                    "summary": (
                        "Voice action IDs use `nav.*` for ordinary route navigation; current "
                        "voice governance reserves `nav.*` for Nav privacy/consent guardian "
                        "actions and uses `route.*` for routing."
                    ),
                    "files": [
                        path
                        for path, section in patch_map.items()
                        if re.search(
                            r"action[_-]?id[^\n]*['\"]nav\.",
                            section,
                            flags=re.IGNORECASE,
                        )
                    ],
                }
            )

        identity_runtime_files = {
            "consent-protocol/hushh_mcp/services/voice_app_knowledge.py",
            "consent-protocol/hushh_mcp/agents/kai/agent.yaml",
            "consent-protocol/hushh_mcp/agents/one/agent.yaml",
            "consent-protocol/hushh_mcp/agents/one/manifest.py",
        }
        changed_file_set = set(files)
        if changed_file_set & identity_runtime_files and (
            "one is the top personal agent" in voice_text
            or "app_name" in voice_text and "one" in voice_text
            or "kai is the app" in voice_text
        ):
            findings.append(
                {
                    "id": "one_kai_runtime_identity_boundary_requires_review",
                    "severity": "medium",
                    "summary": (
                        "PR changes One/Kai runtime identity language on a voice or agent surface. "
                        "Verify current-state wording against the canonical ontology so One is not "
                        "claimed as fully shipped where the runtime remains Kai-first, and Kai is not "
                        "treated as the full platform identity."
                    ),
                    "files": sorted(changed_file_set & identity_runtime_files),
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


def _adds_parallel_voice_input_surface(files: list[str], patch_text: str) -> bool:
    changed_paths = set(files)
    if any(path in changed_paths for path in CANONICAL_VOICE_RUNTIME_PATHS):
        return False
    lowered_patch = patch_text.lower()
    adds_browser_speech = (
        "speechrecognition" in lowered_patch
        or "webkitspeechrecognition" in lowered_patch
        or "dictation" in lowered_patch
    )
    touches_voice_like_ui = any(
        path == "hushh-webapp/components/kai/kai-command-palette.tsx"
        or path.endswith("use-voice-dictation.ts")
        or "voice" in path.lower()
        or "speech" in path.lower()
        or "dictation" in path.lower()
        for path in files
    )
    canonical_voice_exists = all(
        _path_exists(path) or _git_show_origin_main(path) is not None
        for path in (
            "hushh-webapp/components/kai/kai-search-bar.tsx",
            "hushh-webapp/lib/voice/voice-session-manager.ts",
            "hushh-webapp/lib/voice/voice-turn-orchestrator.ts",
            "hushh-webapp/lib/voice/kai-action-gateway.ts",
        )
    )
    return adds_browser_speech and touches_voice_like_ui and canonical_voice_exists


def _recommend_merge_lane(
    ci_status_gate: str,
    review_decision: str,
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
    if review_decision == "CHANGES_REQUESTED":
        return OrderedDict(
            lane="block",
            rationale=(
                "Current GitHub review decision is CHANGES_REQUESTED on the reviewed head SHA. "
                "A green gate cannot override unresolved reviewer authority."
            ),
            next_steps=[
                "Inspect the active requested-changes review and resolve it before merge.",
                "Only reclassify after the review state changes on the current head SHA.",
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
                "The remaining findings are bounded integration or reproducibility issues. "
                "Prefer a small maintainer patch over contributor round trips when maintainers "
                "can safely fix it without changing product intent."
            ),
            next_steps=[
                "Do not merge the contributor head directly.",
                "Apply the smallest maintainer integration patch on the contributor branch when maintainers can modify it without changing product intent.",
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


def _finding_ids(report: dict[str, Any]) -> set[str]:
    return {str(finding.get("id") or "") for finding in report.get("findings", [])}


def _canonical_patch_attach_point(report: dict[str, Any]) -> str:
    finding_ids = _finding_ids(report)
    if finding_ids & PATCH_ATTACHMENT_BLOCKER_FINDINGS:
        return ""

    related = report.get("related_surfaces") or {}
    for entry in related.get("files", []):
        path = str(entry.get("path") or "")
        if path and not _is_test_path(path) and not _is_doc_path(path):
            return path

    for path in report.get("changed_files", []):
        if not _is_test_path(path) and not _is_doc_path(path):
            return path
    return ""


def _smallest_patch_proof(report: dict[str, Any], attach_point: str) -> str:
    contract_set = report.get("contract_set")
    if contract_set == "db-release-contract":
        return "./bin/hushh db verify-release-contract"
    if contract_set == "voice":
        return "run the smallest voice/action contract test covering the changed gateway or intent path"
    if contract_set == "pkm-privacy":
        return "run the smallest PKM/vault/cache test covering the accepted attach point"
    if contract_set == "account-export":
        return "run the smallest account export service or route test covering the patched response contract"
    if attach_point.startswith("hushh-webapp/"):
        return "run the smallest frontend unit/type or route proof covering the patched surface"
    if attach_point.startswith("consent-protocol/"):
        return "run the smallest backend unit or route proof covering the patched surface"
    return "rerun the current PR gate plus the smallest surface-specific proof"


def _patch_attachment_plan(report: dict[str, Any]) -> OrderedDict[str, Any]:
    finding_ids = _finding_ids(report)
    blockers = sorted(finding_ids & PATCH_ATTACHMENT_BLOCKER_FINDINGS)
    attach_point = _canonical_patch_attach_point(report)
    patch_files = [
        path
        for path in report.get("changed_files", [])
        if not _is_doc_path(path) and not path.startswith("tmp/")
    ][:8]

    if blockers:
        denied = (
            "Maintainer patch is denied because the PR contains standalone helper, "
            "component, export, agent, or runtime code without a proven canonical caller. "
            f"Blocking findings: {', '.join(blockers)}."
        )
    elif not attach_point:
        denied = (
            "Maintainer patch is denied because no canonical app, backend, package, "
            "route, generated contract, test contract, or documented devex attach point was identified."
        )
    else:
        denied = ""

    if denied:
        return OrderedDict(
            accepted_value="none accepted until reachability is proven",
            canonical_attach_point="",
            files_codex_will_patch=[],
            dropped_or_deferred=(
                "standalone exports/helpers/components and any future-state wiring that is not "
                "reachable from the current repo"
            ),
            smallest_proof_command="contributor must provide reachable caller or narrow the PR to test/devex hygiene",
            patch_allowed_reason="",
            patch_denied_reason=denied,
        )

    return OrderedDict(
        accepted_value=(
            "bounded integration or proof value that can be attached to the existing "
            f"`{report.get('contract_set')}` surface without changing product intent"
        ),
        canonical_attach_point=attach_point,
        files_codex_will_patch=patch_files,
        dropped_or_deferred=(
            "any unrelated, future-state, duplicate, or unreachable pieces outside the attach point"
        ),
        smallest_proof_command=_smallest_patch_proof(report, attach_point),
        patch_allowed_reason=(
            f"Patch allowed because the accepted value has a canonical attach point at `{attach_point}` "
            "and no standalone reachability blocker was detected."
        ),
        patch_denied_reason="",
    )


def _apply_patch_attachment_policy(report: dict[str, Any]) -> None:
    plan = _patch_attachment_plan(report)
    if report.get("lane") != "patch_then_merge":
        plan["patch_allowed_reason"] = ""
        if not (_finding_ids(report) & PATCH_ATTACHMENT_BLOCKER_FINDINGS):
            plan["patch_denied_reason"] = ""
    report["canonical_attach_point"] = plan["canonical_attach_point"]
    report["patch_allowed_reason"] = plan["patch_allowed_reason"]
    report["patch_denied_reason"] = plan["patch_denied_reason"]
    report["patch_attachment_plan"] = plan
    report["north_star_probe_required"] = bool(
        (report.get("founder_wiki_probe") or {}).get("required")
    )

    if report.get("lane") != "patch_then_merge" or not plan["patch_denied_reason"]:
        return

    report["decision"] = OrderedDict(
        lane="block",
        rationale=(
            "Maintainer patch is not permitted without a concrete attachment plan. "
            + plan["patch_denied_reason"]
        ),
        next_steps=[
            "Request changes that name the reachable app/backend/package route or current canonical surface.",
            "Do not invent product intent to save standalone code.",
            "Reclassify only after the PR proves reachability or narrows itself to test/devex hygiene.",
        ],
    )
    report["lane"] = "block"


def _public_comment_policy(lane: str) -> str:
    if lane == "merge_now":
        return "no_pre_merge_comment; required_post_merge_closeout_after_smoke"
    if lane == "patch_then_merge":
        return "operator_explicit_maintainer_patch_only; required_post_merge_closeout_after_smoke"
    if lane in {"harvest_then_close", "close_duplicate"}:
        return "standard_closed_or_superseded_comment"
    return "standard_changes_requested_comment_before_merge"


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
        f"- Draft: `{str(bool(pr.get('is_draft'))).lower()}`",
        f"- Mergeability: `{pr['mergeable']}` / `{pr['merge_state_status']}`",
        f"- Review decision: `{pr.get('review_decision') or 'none'}`",
        f"- Required gate: `{report.get('current_ci_status_gate') or 'UNKNOWN'}`",
        f"- Contract/lane: `{report['contract_set']}` / `{report['lane']}`",
        f"- Lean/core risk: `{_lean_core_risk(report)}`",
        f"- Size/surfaces: `+{pr['additions']}` / `-{pr['deletions']}` across `{pr['changed_files_count']}` files; tags `{', '.join(report['surface_tags']) or 'none'}`",
        f"- What this is about: {report['what_this_is_about']}",
        f"- Summary: {pr.get('summary') or 'No PR summary extracted.'}",
        f"- Findings: {_findings_summary(report)}",
        f"- Overlap: {_overlap_summary(report)}",
        f"- Train graph: collision `{report.get('collision_group_id') or 'none'}`; can queue with `{report.get('can_queue_with') or []}`; must wait for `{report.get('must_wait_for') or []}`; queue cohort `{report.get('queue_cohort_id') or 'none'}`; patch train `{report.get('parallel_patch_train_id') or 'none'}`",
        f"- Reviewed state: `{report.get('reviewed_train_state') or 'remaining'}`; train terminal state `{report.get('train_terminal_state') or 'awaiting train action'}`",
        f"- Related surfaces: {_related_surface_summary(report)}",
        f"- Patch gate: attach `{report.get('canonical_attach_point') or 'none'}`; allowed `{report.get('patch_allowed_reason') or 'no'}`; denied `{report.get('patch_denied_reason') or 'no'}`",
        (
            f"- Founder Wiki North-Star Probe: `{report['founder_wiki_probe']['status']}`; "
            f"policy `{report['founder_wiki_probe']['public_comment_policy']}`"
            if report.get("founder_wiki_probe")
            else "- Founder Wiki North-Star Probe: `not_evaluated`"
        ),
        f"- Decision rationale: {report['decision']['rationale']}",
        f"- SOP action: `{report['live_report_action']}`; public comment policy `{report['public_comment_policy']}`",
        f"- Next proof: {' '.join(report['decision']['next_steps'][:2])}",
    ]
    if reason and reason != report["decision"]["rationale"]:
        lines.append(f"- Patch/close reason: {reason}")
    return lines


def _is_actionable_live_candidate(report: dict[str, Any]) -> bool:
    pr = report["pr"]
    if _has_current_check_failure(report):
        return False
    if report["lane"] in {"harvest_then_close", "close_duplicate"}:
        return True
    if pr.get("is_draft"):
        return False
    if pr.get("review_decision") == "CHANGES_REQUESTED":
        return False
    if pr.get("mergeable") not in {"MERGEABLE", "UNKNOWN"}:
        return False
    return report["lane"] in {"merge_now", "patch_then_merge", "harvest_then_close", "close_duplicate"}


def _live_actionable_queue_lines(reports: list[dict[str, Any]]) -> list[str]:
    actionable = [report for report in reports if _is_actionable_live_candidate(report)]
    lines: list[str] = [
        "## Actionable Next Queue",
        "",
        "This queue separates mergeable work from duplicate/harvest-close work. Merge candidates still require non-draft, green-gate, non-conflicting state; close/harvest actions can be actionable when duplicate proof is already present.",
        "",
    ]
    if not actionable:
        lines.append("- No open PR is currently actionable without contributor rework, CI/DCO repair, conflict resolution, draft promotion, or a maintainer decision to override an existing block.")
        return lines

    for report in actionable:
        pr = report["pr"]
        reason = report.get("patch_then_merge_reason") or report["decision"]["rationale"]
        lines.append(
            f"- [#{pr['number']}]({pr['url']}) - `{report['contract_set']}` / `{report['lane']}` / risk `{_lean_core_risk(report)}`: {reason}"
        )
    return lines


def _blocked_live_register_lines(reports: list[dict[str, Any]]) -> list[str]:
    blocked = [report for report in reports if not _is_actionable_live_candidate(report)]
    lines: list[str] = [
        "",
        "## Blocked / Waiting Register",
        "",
        "These PRs remain live because they are open, but they should not be offered as the next fresh batch until the block changes.",
        "",
    ]
    if not blocked:
        lines.append("- none")
        return lines
    for report in blocked:
        pr = report["pr"]
        reason = report.get("patch_then_merge_reason") or report["decision"]["rationale"]
        check_failure_reason = _current_check_failure_reason(report)
        if check_failure_reason:
            reason = f"check_failure_hold: {check_failure_reason}. Excluded from executable trains until checks are clean."
        review = pr.get("review_decision") or "none"
        lines.append(
            f"- [#{pr['number']}]({pr['url']}) - review `{review}`, mergeable `{pr.get('mergeable')}`, lane `{report['lane']}`: {reason}"
        )
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


def _train_sequence_sort_key(report: dict[str, Any]) -> tuple[int, str, int]:
    pr = report["pr"]
    created_at = str(pr.get("created_at") or "")
    if created_at:
        return (0, created_at, int(pr["number"]))
    return (1, "", int(pr["number"]))


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
    if any("package.json" in path or "package-lock.json" in path for path in shared):
        return "Dependency/test surface alignment: sequence package-lock changes before dependent test infrastructure."
    if {
        "hushh-webapp/components/navbar.tsx",
        "hushh-webapp/components/theme-toggle.tsx",
    } <= shared:
        return "Theme toggle shell placement: choose one compact top-right UI implementation."
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


def _operator_batch_solution(batch: dict[str, Any]) -> list[str]:
    lane_items = list(batch.get("lanes", {}).items())
    merge_now = [pr for pr, lane in lane_items if lane == "merge_now"]
    patch_then_merge = [pr for pr, lane in lane_items if lane == "patch_then_merge"]
    closure = [pr for pr, lane in lane_items if lane in {"harvest_then_close", "close_duplicate"}]
    blocked = [pr for pr, lane in lane_items if lane == "block"]
    ordered = merge_now + patch_then_merge + closure + blocked
    ordered_label = ", ".join(ordered) if ordered else "manual review order required"

    lines = [
        f"  - Input: {', '.join(_operator_batch_links(batch))}.",
        f"  - Output target: {batch['action']}",
        f"  - Execution order: {ordered_label}.",
    ]
    if merge_now:
        lines.append(
            f"  - Merge train: approve and queue {', '.join(merge_now)} one at a time after locking the current head SHA and required gate."
        )
    if patch_then_merge:
        lines.append(
            f"  - Patch train: rebase/patch {', '.join(patch_then_merge)} only after earlier merge-train items land, then rerun the shared checks before queueing."
        )
    if closure:
        lines.append(
            f"  - Closure wave: harvest unique tests or evidence from {', '.join(closure)}, then close with the standard maintainer decision record."
        )
    if blocked:
        lines.append(
            f"  - Hold: keep {', '.join(blocked)} out of the merge train until the blocker changes or a maintainer patch is explicitly approved."
        )
    lines.extend(
        [
            "  - Stop condition: if any PR changes head SHA, loses CI Status Gate, gains conflicts, or reveals a trust/runtime regression, pause that PR and continue only with independent safe items.",
            "  - Branch return: record the developer branch before temporary PR checkout/worktree or detached-HEAD review, and return the parent worktree to that branch before closing the train.",
            "  - Reporting: refresh `tmp/pr-governance-live-report.md` and `tmp/contributor-impact-dashboard.md` after each merge, close, or requested-changes action.",
        ]
    )
    return lines


def _operator_batch_after_merge_kickoff(batch: dict[str, Any]) -> list[str]:
    return [
        "  - After each merge, monitor Queue Validation and Main Post-Merge Smoke before treating dependent PRs as unblocked.",
        "  - While queue/smoke runs, start review preparation for the next independent `Recommended Operator Batches` item that does not share this train's files or runtime contract.",
        "  - After smoke passes, refresh `tmp/pr-governance-live-report.md` and `tmp/contributor-impact-dashboard.md`, then rerun the checklist for the next train before any GitHub write.",
        "  - Before the final handoff, return the parent worktree to the recorded developer branch or report the exact blocker.",
        "  - Automatic next train means automatic discovery and review preparation; approval, merge, close, deploy, and maintainer patch actions still require explicit operator intent.",
    ]


def _operator_batch_research_basis(batch: dict[str, Any]) -> list[str]:
    prs = ", ".join(_operator_batch_links(batch))
    shared_files = _compact_file_list(batch.get("shared_files", []), limit=6)
    lanes = json.dumps(batch.get("lanes", {}))
    risks = json.dumps(batch.get("risks", {}))
    return [
        f"  - Current truth: {prs} are grouped because {batch['reason']} Lanes: `{lanes}`. Risk: `{risks}`. Shared files: {shared_files}.",
        f"  - Recommended path: {batch['action']}",
        "  - Risk if accepted blindly: green or previously green CI does not override conflicts, stale heads, duplicate runtime paths, trust-boundary regressions, or schema/runtime contract drift.",
    ]


def _operator_batch_decision_questions(batch: dict[str, Any]) -> list[str]:
    return [
        "  - Decision needed: accept the recommended operator path or override it with a product/runtime reason not visible in repo evidence.",
        f"  - Recommended option: follow the researched path for {', '.join(_operator_batch_links(batch))}; expected output is `{batch['action']}`",
        "  - Alternative option: hold or split the batch; expected output is no merge until the new product/runtime constraint is recorded.",
    ]


def _operator_batch_pr_assessment_lines(batch: dict[str, Any]) -> list[str]:
    roles = batch.get("pr_roles") or []
    if not roles:
        return ["  - Per-PR assessment unavailable; rerun the batch report with current PR metadata."]
    lines: list[str] = []
    for role in roles:
        number = role["number"]
        lines.extend(
            [
                f"  - [#{number}]({role['url']}) `{role['lane']}` / risk `{role['risk']}` / head `{role['head_sha'][:8]}` / mergeable `{role['mergeable']}` / gate `{role['ci_status_gate']}`",
                f"    - What changed: {role['change_summary']}",
                f"    - Why in batch: {role['batch_reason']}",
                f"    - Blind-merge risk: {role['blind_merge_risk']}",
                f"    - Planned action: {role['planned_action']}",
                f"    - Smallest proof: {role['smallest_proof']}",
            ]
        )
    return lines


def _operator_batch_pr_roles(reports: list[dict[str, Any]]) -> list[OrderedDict[str, Any]]:
    roles: list[OrderedDict[str, Any]] = []
    for report in reports:
        pr = report["pr"]
        lane = report["lane"]
        changed_files = report.get("changed_files") or []
        related_files = _compact_file_list(changed_files, limit=4)
        findings = [finding["id"] for finding in report["findings"][:2]]
        if lane == "merge_now":
            planned_action = "lock current head, verify green required gate, queue one at a time, then post closeout after smoke"
            smallest_proof = "current GitHub required checks plus shared-file targeted check when overlap exists"
        elif lane == "patch_then_merge":
            planned_action = "rebase or maintainer-patch only the bounded defect, then rerun contract-specific checks before queue"
            smallest_proof = "targeted test proving the patched boundary, not just green stale CI"
        elif lane in {"harvest_then_close", "close_duplicate"}:
            planned_action = "harvest unique useful proof or small code only if canonical, then close with decision record"
            smallest_proof = "manual duplicate/harvest comparison against canonical surface"
        elif lane == "block":
            planned_action = "request changes or hold until blocker evidence changes"
            smallest_proof = "contributor-side rewrite, split, or missing contract proof"
        else:
            planned_action = "manual review required before operator action"
            smallest_proof = "fresh checklist plus maintainer review"

        finding_label = ", ".join(findings) if findings else "none detected by checklist"
        batch_reason = (
            f"contract `{report['contract_set']}`, risk `{_lean_core_risk(report)}`, "
            f"overlap/related files `{related_files or 'none'}`"
        )
        blind_merge_risk = (
            f"checklist findings `{finding_label}`; exact overlap can still create merge-order drift even when CI is green"
        )
        roles.append(
            OrderedDict(
                number=pr["number"],
                url=pr["url"],
                title=pr["title"],
                lane=lane,
                risk=_lean_core_risk(report),
                head_sha=pr["head_sha"],
                mergeable=pr.get("mergeable") or "UNKNOWN",
                ci_status_gate=report.get("current_ci_status_gate") or "UNKNOWN",
                change_summary=(
                    f"{pr['title']} (+{pr['additions']}/-{pr['deletions']} across "
                    f"{pr['changed_files_count']} files; related `{related_files or 'none'}`)"
                ),
                batch_reason=batch_reason,
                blind_merge_risk=blind_merge_risk,
                planned_action=planned_action,
                smallest_proof=smallest_proof,
            )
        )
    return roles


def _operator_batch_links(batch: dict[str, Any]) -> list[str]:
    links = batch.get("pr_links", {})
    return [
        f"[#{number}]({links.get(str(number)) or links.get(number) or '#'})"
        for number in batch["prs"]
    ]


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
            key=_train_sequence_sort_key,
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
                pr_links=OrderedDict(
                    (report["pr"]["number"], report["pr"]["url"])
                    for report in component_reports
                ),
                pr_roles=_operator_batch_pr_roles(component_reports),
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
    for report in sorted(reports, key=_report_sort_key):
        if report["pr"]["number"] in batched_numbers:
            continue
        if report["lane"] not in {"harvest_then_close", "close_duplicate"}:
            continue
        pr_number = report["pr"]["number"]
        batches.append(
            OrderedDict(
                title=f"Single-PR Closure: #{pr_number}",
                prs=[pr_number],
                pr_links=OrderedDict([(pr_number, report["pr"]["url"])]),
                pr_roles=_operator_batch_pr_roles([report]),
                preferred_pr=pr_number,
                contract_sets=[report["contract_set"]],
                lanes=OrderedDict([(f"#{pr_number}", report["lane"])]),
                risks=OrderedDict([(f"#{pr_number}", _lean_core_risk(report))]),
                intent="Close or harvest a PR whose current value is duplicate/superseded rather than mergeable runtime change.",
                shared_files=[],
                action="Compare for unique tests or observability, then close with the standard superseded/duplicate comment if no unique value remains.",
                reason="The PR is actionable as a close/harvest decision even though it is not a merge candidate.",
                confidence="medium",
            )
        )
        batched_numbers.add(pr_number)

    narrow_contracts = {
        "docs/devex",
        "tests/CI/devex",
        "frontend/UI",
    }
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
        if contract_set in narrow_contracts and lane_set <= {"merge_now"} and risk_set <= {"low", "low-medium", "non-runtime"}:
            batches.append(
                OrderedDict(
                    title=f"Adjacent {contract_set} Review Pair",
                    prs=[report["pr"]["number"] for report in grouped],
                    pr_links=OrderedDict(
                        (report["pr"]["number"], report["pr"]["url"])
                        for report in grouped
                    ),
                    pr_roles=_operator_batch_pr_roles(grouped),
                    preferred_pr=grouped[0]["pr"]["number"],
                    contract_sets=[contract_set],
                    lanes=OrderedDict((f"#{report['pr']['number']}", report["lane"]) for report in grouped),
                    risks=OrderedDict((f"#{report['pr']['number']}", _lean_core_risk(report)) for report in grouped),
                    intent=f"Adjacent {contract_set} review: same narrow contract, separate files, low current risk.",
                    shared_files=[],
                    action="Review together for product/context coherence, then split into merge, patch, request-changes, or close outcomes per PR. Merge separately unless manual review proves a shared proof surface.",
                    reason="Same narrow contract, green gate, low/low-medium risk, and no exact file overlap; this is a review batch, not an automatic merge batch.",
                    confidence="medium",
                )
            )
        elif contract_set not in {"backend", "frontend", "general"}:
            batches.append(
                OrderedDict(
                    title=f"Do Not Batch Yet: {contract_set}",
                    prs=[report["pr"]["number"] for report in grouped],
                    pr_links=OrderedDict(
                        (report["pr"]["number"], report["pr"]["url"])
                        for report in grouped
                    ),
                    pr_roles=_operator_batch_pr_roles(grouped),
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
        prs = ", ".join(_operator_batch_links(batch))
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
                "- Research Basis:",
                *_operator_batch_research_basis(batch),
                "- Per-PR Assessment:",
                *_operator_batch_pr_assessment_lines(batch),
                "- Solution:",
                *_operator_batch_solution(batch),
                "- After-Merge Kickoff:",
                *_operator_batch_after_merge_kickoff(batch),
                "- Decision Questions:",
                *_operator_batch_decision_questions(batch),
                f"- Shared files: {_compact_file_list(batch['shared_files'], limit=8)}",
                "",
            ]
        )
    return lines


MASS_CLOSURE_FINDINGS = {
    "checked_in_generated_runtime_artifact",
    "direct_chain_of_thought_persistence",
    "new_top_level_parallel_root",
    "pkm_memory_outside_vault_consent_boundaries",
    "root_setup_surface_added",
    "standalone_unreachable_runtime_root",
}


def _mass_operator_lane(report: dict[str, Any]) -> str:
    finding_ids = {finding["id"] for finding in report["findings"]}
    if finding_ids & MASS_CLOSURE_FINDINGS:
        return "mass_closure"
    if report["lane"] == "merge_now" and _lean_core_risk(report) in {"low", "low-medium", "non-runtime"}:
        return "merge_train"
    if report["lane"] == "patch_then_merge":
        return "patch_train"
    if report["lane"] == "block":
        return "changes_requested"
    return "do_not_batch_yet"


def _mass_operator_section_lines(
    title: str,
    reports: list[dict[str, Any]],
    empty: str,
) -> list[str]:
    lines = ["", f"## {title}", ""]
    if not reports:
        lines.append(f"- {empty}")
        return lines
    for report in sorted(reports, key=_report_sort_key):
        pr = report["pr"]
        finding_ids = ", ".join(finding["id"] for finding in report["findings"][:4]) or "none"
        reason = report.get("patch_then_merge_reason") or report["decision"]["rationale"]
        lines.append(
            f"- [#{pr['number']}]({pr['url']}) - `{report['contract_set']}`, "
            f"lane `{report['lane']}`, risk `{_lean_core_risk(report)}`; "
            f"flags `{finding_ids}`; {reason}"
        )
    return lines


def _review_research_basis_lines(report: dict[str, Any]) -> list[str]:
    pr = report["pr"]
    related_files = ", ".join(entry["path"] for entry in report["related_surfaces"]["files"][:4])
    finding_ids = ", ".join(finding["id"] for finding in report["findings"][:4]) or "none"
    overlap = report.get("exact_file_overlap") or []
    overlap_label = (
        "; ".join(
            f"#{item['other_pr']} shares {', '.join(item['shared_files'][:3])}"
            for item in overlap[:3]
        )
        if overlap
        else "none"
    )
    founder_probe = report.get("founder_wiki_probe") or {}
    founder_probe_line = (
        f"- Founder Wiki North-Star Probe: `{founder_probe.get('status')}`; "
        f"reason `{founder_probe.get('reason')}`; public policy `{founder_probe.get('public_comment_policy')}`."
        if founder_probe
        else "- Founder Wiki North-Star Probe: `not_evaluated`."
    )
    return [
        "Research Basis:",
        f"- Current truth: head `{pr['head_sha'][:8]}`, mergeable `{pr['mergeable']}` / `{pr['merge_state_status']}`, CI Status Gate `{report['current_ci_status_gate']}`.",
        f"- Surfaces checked: contract `{report['contract_set']}`, changed surfaces `{', '.join(report['surface_tags']) or 'none'}`, related files `{related_files or 'none'}`.",
        f"- Overlap/duplicate evidence: duplicate group `{report['duplicate_group'] or 'none'}`, exact overlap `{overlap_label}`.",
        founder_probe_line,
        f"- Risk if accepted blindly: flags `{finding_ids}`; green CI does not override duplicate, trust-boundary, schema/runtime, or reachability findings.",
    ]


def _reasoned_review_steps_lines(report: dict[str, Any]) -> list[str]:
    decision = report["decision"]
    lines = [
        "Reasoned Review Steps:",
        f"- Locked the reviewed head SHA and current CI gate before using any PR claim.",
        f"- Classified the runtime contract as `{report['contract_set']}` and checked related canonical surfaces before selecting a lane.",
        f"- Applied blocker order: north-star drift, duplicate/parallel architecture, trust boundary, contract mismatch, reachability/use-case proof, stacked-branch contamination, deploy/schema reproducibility, then proof gaps.",
        f"- Derived lane `{decision['lane']}` because: {decision['rationale']}",
    ]
    founder_probe = report.get("founder_wiki_probe") or {}
    if founder_probe.get("required"):
        lines.insert(
            3,
            "- Marked founder wiki pages for local-only north-star review and "
            "`current_state_vs_north_star_drift` classification before public comment or merge action.",
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
    lines.append(f"Review decision: {pr.get('review_decision') or 'none'}")
    schematics = report.get("schematics") or {}
    if schematics:
        lines.append(
            "Schematic provenance: "
            f"{schematics.get('schema_version') or 'unknown'}; "
            f"{schematics.get('runtime_family_count', 0)} runtime families; "
            f"required check `{schematics.get('required_status_check') or 'CI Status Gate'}`"
        )
    if pr.get("closed_issues"):
        lines.append(f"Issue linkage: {', '.join('#' + item for item in pr['closed_issues'])}")
    if pr.get("summary"):
        lines.append(f"Summary: {pr['summary']}")
    lines.append(f"What this is about: {report['what_this_is_about']}")
    lines.extend(_review_research_basis_lines(report))
    lines.extend(_reasoned_review_steps_lines(report))
    lines.append(f"Current CI Status Gate: {report['current_ci_status_gate']}")
    lines.append(f"Contract set: {report['contract_set']}")
    lines.append(f"Duplicate group: {report['duplicate_group'] or 'none'}")
    if report.get("canonical_selection_rationale"):
        lines.append(f"Canonical selection rationale: {report['canonical_selection_rationale']}")
    lines.append(f"Author group: {report['author_group']}")
    lines.append(f"Recommended lane: {report['decision']['lane']}")
    lines.append(f"Decision rationale: {report['decision']['rationale']}")
    lines.append(f"Collision group: {report.get('collision_group_id') or 'none'}")
    if report.get("collision_reasons"):
        lines.append(f"Collision reasons: {'; '.join(report['collision_reasons'])}")
    if report.get("can_queue_with"):
        lines.append(f"Can queue with: {', '.join('#' + str(item) for item in report['can_queue_with'])}")
    if report.get("must_wait_for"):
        lines.append(f"Must wait for: {', '.join('#' + str(item) for item in report['must_wait_for'])}")
    if report.get("queue_cohort_id"):
        lines.append(f"Queue cohort: {report['queue_cohort_id']}")
    if report.get("parallel_patch_train_id"):
        lines.append(f"Parallel patch train: {report['parallel_patch_train_id']}")
    lines.append(f"Canonical attach point: {report.get('canonical_attach_point') or 'none'}")
    if report.get("patch_allowed_reason"):
        lines.append(f"Patch allowed reason: {report['patch_allowed_reason']}")
    if report.get("patch_denied_reason"):
        lines.append(f"Patch denied reason: {report['patch_denied_reason']}")
    if report.get("patch_then_merge_reason"):
        lines.append(f"Patch/close reason: {report['patch_then_merge_reason']}")
    lines.append(f"Public comment policy: {report['public_comment_policy']}")
    lines.append(f"Live report action: {report['live_report_action']}")
    lines.append(f"Changed surfaces: {', '.join(report['surface_tags']) or 'none'}")
    if report.get("founder_wiki_probe"):
        probe = report["founder_wiki_probe"]
        lines.append(
            "Founder Wiki North-Star Probe: "
            f"{probe['status']} ({probe['public_comment_policy']}); "
            f"alignment `{probe['north_star_alignment']}`; drift `{probe['drift_classification']}`"
        )
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


def _path_exists_on_origin_main(path: str) -> bool:
    completed = subprocess.run(
        ["git", "cat-file", "-e", f"origin/main:{path}"],
        capture_output=True,
        text=True,
        check=False,
        cwd=REPO_ROOT,
    )
    return completed.returncode == 0


def _generated_or_runtime_artifact_files(files: list[str]) -> list[str]:
    result: list[str] = []
    for path in files:
        name = path.rsplit("/", 1)[-1]
        if name in GENERATED_OR_RUNTIME_ARTIFACT_NAMES or path.endswith(
            GENERATED_OR_RUNTIME_ARTIFACT_SUFFIXES
        ):
            result.append(path)
        elif "/logs/" in path and path.endswith((".json", ".log", ".txt")):
            result.append(path)
    return result


def _new_top_level_roots(files: list[str]) -> list[str]:
    roots: list[str] = []
    for root in _top_roots(files):
        if root in CANONICAL_TOP_LEVEL_ROOTS:
            continue
        if _path_exists_on_origin_main(root):
            continue
        roots.append(root)
    return roots


def _parallel_runtime_root_files(files: list[str]) -> list[str]:
    return [
        path
        for path in files
        if path.split("/", 1)[0] in PARALLEL_RUNTIME_ROOTS
    ]


def _root_setup_files(files: list[str]) -> list[str]:
    return [path for path in files if "/" not in path and path in ROOT_SETUP_FILES]


def _chain_of_thought_persistence_paths(patch_map: dict[str, str]) -> list[str]:
    risky_paths: list[str] = []
    for path, section in patch_map.items():
        lowered = section.lower()
        if (
            "chain-of-thought" in lowered
            or "chain of thought" in lowered
            or "reasoningstep" in section
            or "log_reasoning_to_pkm" in section
            or (
                ("reasoning" in lowered or "trace" in lowered)
                and ("pkm" in lowered or "personal knowledge" in lowered)
            )
        ):
            risky_paths.append(path)
    return risky_paths


def _empty_new_files(patch_map: dict[str, str]) -> list[str]:
    return [
        path
        for path, section in patch_map.items()
        if "new file mode" in section and "index 000000000..e69de29bb" in section
    ]


def _script_language_mismatch_files(patch_map: dict[str, str]) -> list[str]:
    mismatches: list[str] = []
    for path, section in patch_map.items():
        if path.endswith(".ps1") and (
            re.search(r"^\+#!\s*/bin/(?:ba)?sh", section, re.MULTILINE)
            or re.search(r"^\+if \[\[", section, re.MULTILINE)
            or re.search(r"^\+OS=\"\\$\\(uname\\)\"", section, re.MULTILINE)
        ):
            mismatches.append(path)
        if path.endswith(".py") and "-#!/usr/bin/env python3" in section and "+#!/bin/bash" in section:
            mismatches.append(path)
    return mismatches


def _devex_env_validation_unwired(files: list[str]) -> bool:
    touches_env_validation = any(path.startswith("scripts/validate-env") for path in files)
    touches_canonical_entrypoint = any(
        path in files
        for path in (
            "bin/hushh",
            "docs/guides/getting-started.md",
            "docs/reference/operations/README.md",
            "docs/reference/operations/env-and-secrets.md",
        )
    )
    return touches_env_validation and not touches_canonical_entrypoint


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
        review_decision=report["pr"].get("review_decision", ""),
        findings=report["findings"],
        surface_tags=report["surface_tags"],
        changed_files=report["changed_files"],
    )
    report["lane"] = report["decision"]["lane"]
    _apply_patch_attachment_policy(report)
    report["patch_then_merge_reason"] = _patch_then_merge_reason(
        report["findings"], report["lane"]
    )
    if report.get("patch_denied_reason"):
        report["patch_then_merge_reason"] = report["patch_denied_reason"]
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


def _hard_collision_categories(files: list[str]) -> set[str]:
    categories: set[str] = set()
    for path in files:
        name = path.rsplit("/", 1)[-1]
        if name in {"package-lock.json", "pnpm-lock.yaml", "yarn.lock"}:
            categories.add("lockfile")
        if name in {"requirements.txt", "poetry.lock"}:
            categories.add("dependency-manifest")
        if path.startswith("consent-protocol/db/") or path in DB_CONTRACT_FILES:
            categories.add("schema-or-migration")
        if path.startswith("contracts/") or "/generated/" in path:
            categories.add("generated-contract")
    return categories


def _runtime_collision_families(report: dict[str, Any]) -> set[str]:
    families: set[str] = set()
    contract_set = str(report.get("contract_set") or "")
    if contract_set in SENSITIVE_RUNTIME_CONTRACTS:
        families.add(contract_set)

    for finding in report.get("findings", []):
        details = finding.get("details")
        if isinstance(details, dict):
            capability = str(details.get("capability") or "")
            if capability in SENSITIVE_RUNTIME_FINDING_CAPABILITIES:
                families.add(capability)

    lowered_paths = "\n".join(report.get("changed_files", [])).lower()
    if "consent" in lowered_paths or "/iam" in lowered_paths or "scope" in lowered_paths:
        families.add("consent-iam-runtime")
    if "vault" in lowered_paths or "pkm" in lowered_paths or "personal-knowledge-model" in lowered_paths:
        families.add("pkm-vault-runtime")
    if "voice" in lowered_paths or "action-gateway" in lowered_paths:
        families.add("voice-action-runtime")
    if "market" in lowered_paths or "finance" in lowered_paths or "portfolio" in lowered_paths:
        families.add("kai-finance-runtime")
    if "stream" in lowered_paths or "sse" in lowered_paths:
        families.add("streaming-runtime")
    if "auth" in lowered_paths or "session" in lowered_paths or "token" in lowered_paths:
        families.add("auth-token-session-runtime")
    if any(path.startswith("consent-protocol/db/") for path in report.get("changed_files", [])):
        families.add("db-release-contract")
    return families


def _subagent_lane_for_reports(reports: list[dict[str, Any]]) -> tuple[str, str, list[str]]:
    contracts = sorted({str(report.get("contract_set") or "general") for report in reports})
    families = sorted(
        {
            family
            for report in reports
            for family in _runtime_collision_families(report)
        }
    )
    files_text = "\n".join(
        path.lower()
        for report in reports
        for path in report.get("changed_files", [])
    )

    for family in families:
        if family in TRAIN_SUBAGENT_LANE_BY_FAMILY:
            lane, agent = TRAIN_SUBAGENT_LANE_BY_FAMILY[family]
            return lane, agent, [f"runtime family `{family}`"]

    if any(token in files_text for token in ("observability", "analytics", "logging", "logger", "redact")):
        return (
            "observability/security",
            "analytics_observability_architect",
            ["observability or logging surface"],
        )

    for contract in contracts:
        if contract in TRAIN_SUBAGENT_LANE_BY_CONTRACT:
            lane, agent = TRAIN_SUBAGENT_LANE_BY_CONTRACT[contract]
            return lane, agent, [f"contract set `{contract}`"]

    if "hushh-webapp/" in files_text:
        return "frontend/reachability", "frontend_architect", ["frontend path"]
    if "consent-protocol/" in files_text:
        return "backend/contracts", "backend_architect", ["backend path"]
    if any(token in files_text for token in (".codex/", "scripts/", "config/", ".github/")):
        return "ci/deploy/release", "repo_operator", ["repo-governance or devex path"]
    return (*TRAIN_SUBAGENT_DEFAULT, ["default regression/proof review"])


def _train_subagent_map_entry(
    *,
    train_id: str,
    train_type: str,
    reports: list[dict[str, Any]],
    hard_edge_reasons: list[str],
    sequential_prs: list[int],
) -> OrderedDict[str, Any]:
    lane, agent, signals = _subagent_lane_for_reports(reports)
    prs = [int(report["pr"]["number"]) for report in reports]
    return OrderedDict(
        id=train_id,
        train_type=train_type,
        subagent_lane=lane,
        agent=agent,
        prs=prs,
        sequential_prs=sequential_prs,
        parallel_with=[],
        hard_edge_reasons=hard_edge_reasons,
        routing_signals=signals,
    )


def _entry_train_sort_key(
    entry: dict[str, Any],
    reports_by_number: dict[int, dict[str, Any]],
) -> tuple[int, str, int]:
    numbers = [int(number) for number in entry.get("sequential_prs") or entry.get("prs") or []]
    reports = [reports_by_number[number] for number in numbers if number in reports_by_number]
    if not reports:
        return (1, "", min(numbers) if numbers else 0)
    return min(_train_sequence_sort_key(report) for report in reports)


def _train_terminal_state(entry: dict[str, Any]) -> str:
    train_type = str(entry.get("train_type") or "")
    if train_type == "queue_cohort":
        return "ready_to_queue"
    if train_type == "parallel_patch_train":
        return "ready_to_patch"
    if train_type == "decision_wave":
        return "ready_to_write_record"
    if train_type == "sequential_collision_train":
        return "sequential_pending"
    return "needs_review"


def _apply_train_pool_fields(
    entries: list[OrderedDict[str, Any]],
    *,
    reports_by_number: dict[int, dict[str, Any]],
    train_pool_size: int,
) -> OrderedDict[str, Any]:
    pool_size = max(1, train_pool_size)
    entries.sort(key=lambda entry: _entry_train_sort_key(entry, reports_by_number))
    active_entries: list[OrderedDict[str, Any]] = []
    active_prs: set[int] = set()
    queued_entries: list[OrderedDict[str, Any]] = []
    for entry in entries:
        entry_prs = {int(number) for number in entry.get("prs", [])}
        if len(active_entries) < pool_size and not (entry_prs & active_prs):
            active_entries.append(entry)
            active_prs |= entry_prs
        else:
            queued_entries.append(entry)
    active_ids = [str(entry["id"]) for entry in active_entries]
    refill_entry = next(
        (entry for entry in queued_entries if not ({int(number) for number in entry.get("prs", [])} & active_prs)),
        queued_entries[0] if queued_entries else None,
    )
    next_refill = str(refill_entry["id"]) if refill_entry else ""
    for index, entry in enumerate(entries):
        entry["worker_slot"] = active_entries.index(entry) + 1 if entry in active_entries else None
        entry["train_terminal_state"] = _train_terminal_state(entry)
        entry["next_refill_train"] = next_refill if index < pool_size else ""
    return OrderedDict(
        train_pool_size=pool_size,
        active_train_workers=active_ids,
        worker_refill_policy=(
            "keep five PR-governance train workers hot by default; when a worker "
            "finishes or blocks a train, immediately assign the next oldest "
            "non-touching train from the reviewed scope"
        ),
        next_refill_train=next_refill,
    )


def _build_train_to_subagent_map(
    *,
    reports_by_number: dict[int, dict[str, Any]],
    queue_cohorts: list[OrderedDict[str, Any]],
    collision_groups: list[OrderedDict[str, Any]],
    parallel_patch_trains: list[OrderedDict[str, Any]],
    decision_waves: list[OrderedDict[str, Any]],
) -> list[OrderedDict[str, Any]]:
    entries: list[OrderedDict[str, Any]] = []

    for cohort in queue_cohorts:
        reports = [reports_by_number[int(number)] for number in cohort.get("prs", []) if int(number) in reports_by_number]
        if reports:
            entry = _train_subagent_map_entry(
                train_id=str(cohort["id"]),
                train_type="queue_cohort",
                reports=reports,
                hard_edge_reasons=[],
                sequential_prs=[],
            )
            entry["subagent_lane"] = "ci/deploy/release"
            entry["agent"] = "repo_operator"
            entry["routing_signals"] = ["queue validation and smoke monitor"]
            entries.append(entry)

    for group in collision_groups:
        reports = [reports_by_number[int(number)] for number in group.get("prs", []) if int(number) in reports_by_number]
        if reports:
            entries.append(
                _train_subagent_map_entry(
                    train_id=str(group["id"]),
                    train_type="sequential_collision_train",
                    reports=reports,
                    hard_edge_reasons=list(group.get("reasons", [])),
                    sequential_prs=[int(number) for number in group.get("sequence", [])],
                )
            )

    for train in parallel_patch_trains:
        reports = [reports_by_number[int(number)] for number in train.get("prs", []) if int(number) in reports_by_number]
        if reports:
            entries.append(
                _train_subagent_map_entry(
                    train_id=str(train["id"]),
                    train_type="parallel_patch_train",
                    reports=reports,
                    hard_edge_reasons=[],
                    sequential_prs=[],
                )
            )

    for wave in decision_waves:
        reports = [reports_by_number[int(number)] for number in wave.get("prs", []) if int(number) in reports_by_number]
        if reports:
            entry = _train_subagent_map_entry(
                train_id=str(wave["id"]),
                train_type="decision_wave",
                reports=reports,
                hard_edge_reasons=[],
                sequential_prs=[],
            )
            entry["subagent_lane"] = "decision-wave communications"
            entry["agent"] = "reviewer"
            entry["routing_signals"] = ["GitHub write posture and comment edit-vs-new review"]
            entries.append(entry)

    for entry in entries:
        entry["parallel_with"] = [
            str(other["id"])
            for other in entries
            if other is not entry and not (set(entry["prs"]) & set(other["prs"]))
        ]
    return entries


def _hard_collision_reasons(left: dict[str, Any], right: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    left_files = set(left.get("changed_files", []))
    right_files = set(right.get("changed_files", []))
    shared_files = sorted(left_files & right_files)
    if shared_files:
        reasons.append(f"exact_file_overlap:{', '.join(shared_files[:6])}")

    left_categories = _hard_collision_categories(list(left_files))
    right_categories = _hard_collision_categories(list(right_files))
    shared_categories = sorted(left_categories & right_categories)
    if shared_categories:
        reasons.append(f"shared_hard_surface:{', '.join(shared_categories)}")

    left_runtime = _runtime_collision_families(left)
    right_runtime = _runtime_collision_families(right)
    shared_runtime = sorted(left_runtime & right_runtime)
    if shared_runtime:
        reasons.append(f"sensitive_runtime_overlap:{', '.join(shared_runtime)}")

    return reasons


def _has_local_dirty_overlap(report: dict[str, Any]) -> bool:
    return any(finding.get("id") == "local_worktree_overlap" for finding in report.get("findings", []))


def _current_check_failure_reason(report: dict[str, Any]) -> str:
    required_gate = str(report.get("current_ci_status_gate") or "UNKNOWN").upper()
    if required_gate != "SUCCESS":
        return f"required CI Status Gate is `{required_gate}`"

    failed_checks = [
        str(check.get("name") or "unknown")
        for check in report.get("current_checks", [])
        if str(check.get("conclusion") or "UNKNOWN").upper() in FAILED_CHECK_CONCLUSIONS
    ]
    if failed_checks:
        return f"current auxiliary check failure: {', '.join(sorted(failed_checks))}"
    return ""


def _has_current_check_failure(report: dict[str, Any]) -> bool:
    return bool(_current_check_failure_reason(report))


def _wave_top_roots(reports: list[dict[str, Any]]) -> set[str]:
    roots: set[str] = set()
    for report in reports:
        roots.update(_top_roots(report.get("changed_files", [])))
    return roots


def _wave_finding_signatures(reports: list[dict[str, Any]]) -> set[tuple[str, ...]]:
    signatures: set[tuple[str, ...]] = set()
    for report in reports:
        signatures.add(tuple(sorted(finding.get("id", "") for finding in report.get("findings", []))))
    return signatures


def _decision_wave_size_plan(
    reports: list[dict[str, Any]],
    *,
    scan_complete: bool = True,
    scan_fresh: bool = True,
    editable_records_safe: bool = True,
) -> OrderedDict[str, Any]:
    if not reports:
        return OrderedDict(size=0, reason="No PRs in this wave.", next_action="hold")
    if not scan_fresh:
        return OrderedDict(size=0, reason="Live report is stale; refresh before any GitHub write.", next_action="refresh_scan")
    if not scan_complete:
        return OrderedDict(size=0, reason="Scan is incomplete for this wave; refresh before any GitHub write.", next_action="refresh_scan")
    if not editable_records_safe:
        return OrderedDict(size=0, reason="Existing maintainer records cannot be safely edited.", next_action="hold")

    contracts = {str(report.get("contract_set") or "general") for report in reports}
    roots = _wave_top_roots(reports)
    risks = {_lean_core_risk(report) for report in reports}
    runtime_families = {
        family
        for report in reports
        for family in _runtime_collision_families(report)
    }
    sensitive_surface = bool(
        contracts & HIGH_RISK_DECISION_WAVE_CONTRACTS
        or runtime_families
        or any(
            token in " ".join(report.get("surface_tags", [])).lower()
            for report in reports
            for token in ("security", "consent", "vault", "pkm", "voice", "finance", "policy")
        )
    )
    mixed_topic = len(contracts) > 1 or len(roots) > 1
    low_risk_same_template = (
        len(contracts) == 1
        and len(roots) <= 1
        and len(_wave_finding_signatures(reports)) <= 1
        and risks <= {"low", "low-medium", "non-runtime"}
    )

    if sensitive_surface or "high" in risks:
        return OrderedDict(
            size=DECISION_WAVE_HIGH_RISK_SIZE,
            reason="High-risk or sensitive runtime/policy wave; keep the operator question small.",
            next_action="ask_operator",
        )
    if mixed_topic:
        return OrderedDict(
            size=DECISION_WAVE_MIXED_TOPIC_SIZE,
            reason="Mixed-topic acknowledgement/comment wave; cap for reviewability.",
            next_action="ask_operator",
        )
    if low_risk_same_template:
        return OrderedDict(
            size=DECISION_WAVE_LOW_RISK_SIZE,
            reason="Low-risk same-template same-surface acknowledgement wave with clean current evidence.",
            next_action="ask_operator",
        )
    return OrderedDict(
        size=DECISION_WAVE_DEFAULT_SIZE,
        reason="Normal homogeneous acknowledgement or changes-requested wave.",
        next_action="ask_operator",
    )


def _decision_wave_record(
    *,
    wave_id: str,
    action: str,
    reports: list[dict[str, Any]],
    rule: str,
) -> OrderedDict[str, Any]:
    size_plan = _decision_wave_size_plan(reports)
    candidate_prs = [int(report["pr"]["number"]) for report in reports]
    selected_prs = candidate_prs[: int(size_plan["size"])]
    remaining_prs = candidate_prs[len(selected_prs):]
    return OrderedDict(
        id=wave_id,
        action=action,
        prs=selected_prs,
        candidate_prs=candidate_prs,
        total_candidate_prs=len(candidate_prs),
        remaining_prs=remaining_prs,
        recommended_wave_size=int(size_plan["size"]),
        why_this_size=size_plan["reason"],
        next_action=size_plan["next_action"],
        comment_edit_policy="inspect existing maintainer-authored records first; edit existing records when possible, otherwise post the lane-specific record",
        question_before_wave=OrderedDict(
            current_truth=(
                f"{len(candidate_prs)} candidate PRs for `{action}`; "
                f"recommended first wave is {len(selected_prs)} PRs."
            ),
            recommended_path=(
                "Ask the operator before GitHub writes, then apply the lane-specific comment/edit policy "
                f"to the selected PRs: {', '.join('#' + str(number) for number in selected_prs) or 'none'}."
            ),
            risk_if_accepted_blindly="Bulk comments can become noisy, stale, or unfair if head state, checks, or existing maintainer records changed.",
            decision_needed="Approve the recommended wave, reduce/split it, or refresh before writing.",
            recommended_option="approve_recommended_wave_after_comment_record_inspection",
        ),
        rule=rule,
    )


def _queue_eligible(report: dict[str, Any], hard_edges: dict[int, dict[int, list[str]]]) -> bool:
    pr = report["pr"]
    number = pr["number"]
    return (
        report.get("lane") == "merge_now"
        and report.get("current_ci_status_gate") == "SUCCESS"
        and not _has_current_check_failure(report)
        and pr.get("mergeable") == "MERGEABLE"
        and not pr.get("is_draft")
        and not hard_edges.get(number)
        and not _has_local_dirty_overlap(report)
    )


def _initialize_train_fields(report: dict[str, Any]) -> None:
    report["collision_group_id"] = ""
    report["collision_reasons"] = []
    report["can_queue_with"] = []
    report["must_wait_for"] = []
    report["queue_cohort_id"] = ""
    report["parallel_patch_train_id"] = ""
    report["north_star_probe_required"] = bool(
        (report.get("founder_wiki_probe") or {}).get("required")
    )


def _component_numbers(start: int, graph: dict[int, dict[int, list[str]]]) -> set[int]:
    stack = [start]
    component: set[int] = set()
    while stack:
        current = stack.pop()
        if current in component:
            continue
        component.add(current)
        stack.extend(sorted(set(graph.get(current, {})) - component))
    return component


def _build_train_graph(
    reports: list[dict[str, Any]],
    *,
    queue_cohort_size: int,
    max_parallel_patch_trains: int,
    train_pool_size: int = DEFAULT_TRAIN_POOL_SIZE,
) -> OrderedDict[str, Any]:
    for report in reports:
        _initialize_train_fields(report)

    train_reports = [
        report for report in reports if not _has_current_check_failure(report)
    ]
    check_failure_holds = [
        OrderedDict(
            pr=report["pr"]["number"],
            reason=_current_check_failure_reason(report),
        )
        for report in sorted(reports, key=lambda item: item["pr"]["number"])
        if _has_current_check_failure(report)
    ]

    by_number = {report["pr"]["number"]: report for report in train_reports}
    hard_edges: dict[int, dict[int, list[str]]] = {
        number: {} for number in by_number
    }

    for left, right in combinations(train_reports, 2):
        reasons = _hard_collision_reasons(left, right)
        if not reasons:
            continue
        left_number = left["pr"]["number"]
        right_number = right["pr"]["number"]
        hard_edges[left_number][right_number] = reasons
        hard_edges[right_number][left_number] = reasons

    seen: set[int] = set()
    collision_groups: list[OrderedDict[str, Any]] = []
    for number in sorted(by_number):
        if number in seen:
            continue
        component = _component_numbers(number, hard_edges)
        seen |= component
        component_reports = sorted(
            (by_number[item] for item in component),
            key=_train_sequence_sort_key,
        )
        group_id = f"collision-group-{len(collision_groups) + 1}" if len(component) > 1 else f"independent-{number}"
        group_reasons = sorted(
            {
                reason
                for left, right in combinations(sorted(component), 2)
                for reason in hard_edges.get(left, {}).get(right, [])
            }
        )
        if len(component) > 1:
            collision_groups.append(
                OrderedDict(
                    id=group_id,
                    prs=sorted(component),
                    reasons=group_reasons,
                    sequence=[
                        report["pr"]["number"]
                        for report in component_reports
                    ],
                )
            )
        for index, report in enumerate(component_reports):
            report["collision_group_id"] = group_id
            report["collision_reasons"] = list(group_reasons)
            if _has_local_dirty_overlap(report):
                report["collision_reasons"].append("local_dirty_worktree_overlap")
            if len(component) > 1:
                report["must_wait_for"] = [
                    previous["pr"]["number"]
                    for previous in component_reports[:index]
                ]

    queue_candidates = [
        report
        for report in sorted(train_reports, key=_report_sort_key)
        if _queue_eligible(report, hard_edges)
    ]
    queue_cohorts: list[OrderedDict[str, Any]] = []
    if queue_candidates:
        cohort_reports = queue_candidates[: max(0, queue_cohort_size)]
        if cohort_reports:
            cohort_id = "queue-cohort-1"
            cohort_numbers = [report["pr"]["number"] for report in cohort_reports]
            for report in cohort_reports:
                report["queue_cohort_id"] = cohort_id
            queue_cohorts.append(
                OrderedDict(
                    id=cohort_id,
                    prs=cohort_numbers,
                    rule=(
                        "independent merge_now PRs with exact head SHA, green CI Status Gate, "
                        "MERGEABLE state, and no hard collision edges"
                    ),
                )
            )

    queue_number_set = {report["pr"]["number"] for report in queue_candidates}
    for report in train_reports:
        number = report["pr"]["number"]
        if report.get("lane") != "merge_now":
            continue
        report["can_queue_with"] = sorted(
            other
            for other in queue_number_set
            if other != number and other not in hard_edges.get(number, {})
        )

    patch_trains: list[OrderedDict[str, Any]] = []
    claimed_patch_files: set[str] = set()
    claimed_patch_families: set[str] = set()
    for report in sorted(train_reports, key=_report_sort_key):
        if len(patch_trains) >= max_parallel_patch_trains:
            break
        if report.get("lane") != "patch_then_merge":
            continue
        if report.get("patch_denied_reason"):
            continue
        files = set(report.get("patch_attachment_plan", {}).get("files_codex_will_patch", []))
        families = _runtime_collision_families(report)
        if files & claimed_patch_files or families & claimed_patch_families:
            continue
        train_id = f"patch-train-{len(patch_trains) + 1}"
        report["parallel_patch_train_id"] = train_id
        claimed_patch_files |= files
        claimed_patch_families |= families
        patch_trains.append(
            OrderedDict(
                id=train_id,
                prs=[report["pr"]["number"]],
                canonical_attach_point=report.get("canonical_attach_point") or "",
                files=sorted(files),
                runtime_families=sorted(families),
                proof=report.get("patch_attachment_plan", {}).get("smallest_proof_command", ""),
            )
        )

    decision_waves: list[OrderedDict[str, Any]] = []
    closure_reports = [
        report
        for report in sorted(train_reports, key=_train_sequence_sort_key)
        if report.get("lane") in {"harvest_then_close", "close_duplicate"}
    ]
    changes_requested_reports = [
        report
        for report in sorted(train_reports, key=_train_sequence_sort_key)
        if report.get("lane") == "block"
    ]
    if closure_reports:
        decision_waves.append(
            _decision_wave_record(
                wave_id="closure-wave-1",
                action="close_or_harvest_then_close",
                rule="can run while queue validation is pending after duplicate/closure proof is confirmed",
                reports=closure_reports,
            )
        )
    if changes_requested_reports:
        decision_waves.append(
            _decision_wave_record(
                wave_id="changes-requested-wave-1",
                action="request_changes_or_hold",
                rule="can run while queue validation is pending; no branch mutation required",
                reports=changes_requested_reports,
            )
        )

    train_to_subagent_map = _build_train_to_subagent_map(
        reports_by_number=by_number,
        queue_cohorts=queue_cohorts,
        collision_groups=collision_groups,
        parallel_patch_trains=patch_trains,
        decision_waves=decision_waves,
    )
    train_pool = _apply_train_pool_fields(
        train_to_subagent_map,
        reports_by_number=by_number,
        train_pool_size=train_pool_size,
    )

    return OrderedDict(
        train_pool_size=train_pool["train_pool_size"],
        active_train_workers=train_pool["active_train_workers"],
        worker_refill_policy=train_pool["worker_refill_policy"],
        next_refill_train=train_pool["next_refill_train"],
        hard_edges=OrderedDict(
            (
                str(number),
                OrderedDict((str(other), reasons) for other, reasons in sorted(edges.items()))
            )
            for number, edges in sorted(hard_edges.items())
            if edges
        ),
        queue_cohorts=queue_cohorts,
        collision_groups=collision_groups,
        parallel_patch_trains=patch_trains,
        decision_waves=decision_waves,
        train_to_subagent_map=train_to_subagent_map,
        check_failure_holds=check_failure_holds,
    )


def _scan_failure_report(repo: str, pr: int, error_kind: str, message: str) -> OrderedDict[str, Any]:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    report = OrderedDict(
        generated_at=now,
        repo=repo,
        schematics=_schematics_summary(),
        pr=OrderedDict(
            number=pr,
            title=f"PR #{pr} scan incomplete",
            url=f"https://github.com/{repo}/pull/{pr}",
            author=None,
            summary="",
            closed_issues=[],
            head_sha="",
            head_ref="",
            base_ref="",
            is_draft=False,
            additions=0,
            deletions=0,
            changed_files_count=0,
            mergeable="UNKNOWN",
            merge_state_status="UNKNOWN",
            review_decision="",
        ),
        changed_files=[],
        contract_set="unknown",
        what_this_is_about="PR scan did not complete; do not classify or queue from this incomplete record.",
        duplicate_group=None,
        duplicate_selection_factors=None,
        canonical_selection_rationale=None,
        author_group="author:unknown",
        exact_file_overlap=[],
        concept_overlap=[],
        surface_tags=[],
        current_ci_status_gate="UNKNOWN",
        current_checks=[],
        findings=[
            _finding(
                f"review_scan_{error_kind}",
                "high",
                "The PR governance scanner could not complete this PR. Treat it as blocked until refreshed.",
                [],
                details={"message": message},
            )
        ],
        related_surfaces=OrderedDict(files=[], docs=[]),
        founder_wiki_probe=OrderedDict(
            required=False,
            status="not_evaluated_scan_incomplete",
            reason=message,
            product_canon=[],
            north_star_alignment="needs_verification",
            drift_classification="needs_verification",
            public_comment_policy="no_private_wiki_evidence_needed",
        ),
        scan_error=OrderedDict(kind=error_kind, message=message),
    )
    _refresh_report_decision(report)
    report["public_comment_policy"] = "no_comment_review_only_scan_incomplete"
    report["live_report_action"] = "hold_until_scan_refresh"
    report["decision"]["rationale"] = (
        "Scan incomplete; refresh this PR before posting public review, queueing, or closing."
    )
    report["communication_markdown"] = ""
    return report


class _PRReviewTimeout(RuntimeError):
    pass


def _timeout_handler(signum: int, frame: Any) -> None:
    raise _PRReviewTimeout("per-PR review timed out")


def _build_report_guarded(repo: str, pr: int, per_pr_timeout_seconds: int) -> dict[str, Any]:
    if per_pr_timeout_seconds <= 0:
        return build_report(repo, pr)
    previous_handler = signal.signal(signal.SIGALRM, _timeout_handler)
    signal.setitimer(signal.ITIMER_REAL, per_pr_timeout_seconds)
    try:
        return build_report(repo, pr)
    except _PRReviewTimeout as exc:
        return _scan_failure_report(repo, pr, "timeout", str(exc))
    except Exception as exc:
        return _scan_failure_report(repo, pr, "github_or_scan_error", str(exc))
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)


def _scan_completeness(
    scan_scope: dict[str, Any] | None,
    reports: list[dict[str, Any]],
) -> OrderedDict[str, Any]:
    scope = scan_scope or {}
    failed = [
        report["pr"]["number"]
        for report in reports
        if report.get("scan_error")
    ]
    reviewed = [report["pr"]["number"] for report in reports]
    inventory_error = str(scope.get("inventory_error") or "")
    mode = str(scope.get("mode") or "explicit")
    inventory_open_count = scope.get("inventory_open_count")
    full_inventory_complete = not inventory_error and inventory_open_count is not None
    if mode == "full" and isinstance(inventory_open_count, int):
        complete = not failed and len(reviewed) >= inventory_open_count
    else:
        complete = not failed

    if failed:
        status = "partial_review_scan_failed"
    elif mode == "active":
        status = "complete_for_reviewed_subset"
    elif mode == "hybrid" and isinstance(inventory_open_count, int) and len(reviewed) < inventory_open_count:
        status = "complete_for_reviewed_subset"
    elif complete:
        status = "complete"
    else:
        status = "partial_inventory_unknown"

    message = (
        f"Reviewed {len(reviewed)} PRs"
        + (f" out of {inventory_open_count} open PRs" if isinstance(inventory_open_count, int) else "")
        + (f"; failed PRs: {failed}" if failed else "")
        + (f"; inventory error: {inventory_error}" if inventory_error else "")
        + "."
    )
    return OrderedDict(
        status=status,
        complete=complete,
        reviewed_count=len(reviewed),
        reviewed_prs=reviewed,
        failed_prs=failed,
        inventory_open_count=inventory_open_count,
        full_inventory_complete=full_inventory_complete,
        subset_description=scope.get("subset_description") or "explicit PR subset",
        message=message,
    )


def _reviewed_state_for_report(report: dict[str, Any]) -> tuple[str, str]:
    if report.get("scan_error"):
        return "blocked", "scan incomplete"
    check_failure = _current_check_failure_reason(report)
    if check_failure:
        return "blocked", check_failure
    pr = report.get("pr") or {}
    if pr.get("review_decision") == "CHANGES_REQUESTED":
        return "terminal", "current maintainer changes-requested record"
    if pr.get("is_draft"):
        return "blocked", "draft PR"
    if pr.get("mergeable") not in {"MERGEABLE", "UNKNOWN"}:
        return "blocked", f"mergeability `{pr.get('mergeable') or 'UNKNOWN'}`"
    if report.get("must_wait_for"):
        return "blocked", f"must wait for {report.get('must_wait_for')}"
    return "remaining", str(report.get("live_report_action") or "awaiting train action")


def _reviewed_state_summary(reports: list[dict[str, Any]]) -> OrderedDict[str, Any]:
    buckets: dict[str, list[OrderedDict[str, Any]]] = {
        "terminal": [],
        "blocked": [],
        "remaining": [],
    }
    for report in sorted(reports, key=_train_sequence_sort_key):
        state, reason = _reviewed_state_for_report(report)
        report["reviewed_train_state"] = state
        report["train_terminal_state"] = reason
        buckets.setdefault(state, []).append(
            OrderedDict(
                pr=int(report["pr"]["number"]),
                url=report["pr"]["url"],
                reason=reason,
            )
        )
    return OrderedDict(
        terminal_count=len(buckets["terminal"]),
        blocked_count=len(buckets["blocked"]),
        remaining_count=len(buckets["remaining"]),
        terminal=buckets["terminal"],
        blocked=buckets["blocked"],
        remaining=buckets["remaining"],
    )


def build_batch_report(
    repo: str,
    prs: list[int],
    *,
    scan_scope: dict[str, Any] | None = None,
    per_pr_timeout_seconds: int = DEFAULT_PER_PR_TIMEOUT_SECONDS,
    queue_cohort_size: int = DEFAULT_QUEUE_COHORT_SIZE,
    max_parallel_patch_trains: int = DEFAULT_MAX_PARALLEL_PATCH_TRAINS,
    train_pool_size: int = DEFAULT_TRAIN_POOL_SIZE,
) -> dict[str, Any]:
    raw_reports = [
        _build_report_guarded(repo, pr, per_pr_timeout_seconds)
        for pr in prs
    ]
    reports = _apply_batch_context(raw_reports)
    train_graph = _build_train_graph(
        reports,
        queue_cohort_size=queue_cohort_size,
        max_parallel_patch_trains=max_parallel_patch_trains,
        train_pool_size=train_pool_size,
    )
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
    actionable_reports = [
        report for report in reports if _is_actionable_live_candidate(report)
    ]
    actionable_numbers = {report["pr"]["number"] for report in actionable_reports}
    actionable_overlaps = [
        overlap
        for overlap in overlaps
        if set(overlap.get("pair", [])) <= actionable_numbers
    ]

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

    reviewed_state = _reviewed_state_summary(reports)
    effective_scan_scope = OrderedDict(
        scan_scope or OrderedDict(
            mode="explicit",
            selection_order="explicit",
            reviewed_prs=prs,
            reviewed_count=len(prs),
            inventory_open_count=None,
            active_limit=None,
            candidate_limit=None,
            per_pr_timeout_seconds=per_pr_timeout_seconds,
        )
    )
    effective_scan_scope["train_pool_size"] = train_graph["train_pool_size"]
    effective_scan_scope["active_train_workers"] = train_graph["active_train_workers"]
    effective_scan_scope["worker_refill_policy"] = train_graph["worker_refill_policy"]
    effective_scan_scope["next_refill_train"] = train_graph["next_refill_train"]
    effective_scan_scope["reviewed_terminal_count"] = reviewed_state["terminal_count"]
    effective_scan_scope["reviewed_blocked_count"] = reviewed_state["blocked_count"]
    effective_scan_scope["reviewed_remaining_count"] = reviewed_state["remaining_count"]

    return OrderedDict(
        generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        repo=repo,
        prs=prs,
        scan_scope=effective_scan_scope,
        scan_completeness=_scan_completeness(effective_scan_scope, reports),
        lane_counts=lane_counts,
        surface_counts=OrderedDict(sorted(surface_counts.items())),
        root_counts=OrderedDict(sorted(root_counts.items())),
        overlaps=overlaps,
        train_graph=train_graph,
        train_pool_size=train_graph["train_pool_size"],
        active_train_workers=train_graph["active_train_workers"],
        worker_refill_policy=train_graph["worker_refill_policy"],
        next_refill_train=train_graph["next_refill_train"],
        reviewed_terminal_count=reviewed_state["terminal_count"],
        reviewed_blocked_count=reviewed_state["blocked_count"],
        reviewed_remaining_count=reviewed_state["remaining_count"],
        train_terminal_state=OrderedDict(
            (str(report["pr"]["number"]), report.get("train_terminal_state", "not_recorded"))
            for report in reports
        ),
        reviewed_state=reviewed_state,
        queue_cohorts=train_graph["queue_cohorts"],
        collision_groups=train_graph["collision_groups"],
        parallel_patch_trains=train_graph["parallel_patch_trains"],
        decision_waves=train_graph["decision_waves"],
        train_to_subagent_map=train_graph["train_to_subagent_map"],
        check_failure_holds=train_graph["check_failure_holds"],
        reports=reports,
        operator_batches=_operator_batches(actionable_reports, actionable_overlaps),
    )


def _batch_text_report(batch: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(
        f"Batch PR review: {_linked_prs(batch, [int(pr) for pr in batch['prs']])}"
    )
    if batch.get("operator_batches"):
        lines.append(
            "What this batch is about: "
            + str(batch["operator_batches"][0].get("intent", "Shared PR sequencing."))
        )
        lines.append("")
        lines.append("Recommended operator solution:")
        lines.extend(_operator_batch_lines(batch["operator_batches"]))
    lines.append(f"Lane counts: {json.dumps(batch['lane_counts'], sort_keys=True)}")
    lines.append(f"Surface counts: {json.dumps(batch['surface_counts'], sort_keys=True)}")
    lines.append(f"Root counts: {json.dumps(batch['root_counts'], sort_keys=True)}")
    if batch["overlaps"]:
        lines.append("Cross-PR file overlaps:")
        for overlap in batch["overlaps"]:
            left, right = overlap["pair"]
            lines.append(
                f"- {_linked_prs(batch, [int(left)])} <-> {_linked_prs(batch, [int(right)])}: "
                + ", ".join(overlap["shared_files"])
            )
    else:
        lines.append("Cross-PR file overlaps: none")
    if batch.get("check_failure_holds"):
        lines.append("Check failure holds:")
        for hold in batch["check_failure_holds"]:
            lines.append(f"- {_linked_prs(batch, [int(hold['pr'])])}: {hold['reason']}")
    lines.append("")
    for report in batch["reports"]:
        lines.append(_text_report(report))
        lines.append("")
    return "\n".join(lines).rstrip()


def _open_live_pr_numbers(repo: str, limit: int) -> list[int]:
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
            "number,isDraft",
        ]
    )
    rows = json.loads(output)
    return [int(row["number"]) for row in rows]


def _open_pr_inventory(repo: str) -> list[OrderedDict[str, Any]]:
    rows: list[OrderedDict[str, Any]] = []
    page = 1
    while True:
        output = _run(
            [
                "gh",
                "api",
                f"/repos/{repo}/pulls?state=open&per_page=100&page={page}",
            ]
        )
        page_rows = json.loads(output)
        if not page_rows:
            break
        for row in page_rows:
            rows.append(
                OrderedDict(
                    number=int(row["number"]),
                    title=row.get("title") or "",
                    author=(row.get("user") or {}).get("login"),
                    is_draft=bool(row.get("draft")),
                    created_at=row.get("created_at") or "",
                    updated_at=row.get("updated_at") or "",
                    head_sha=((row.get("head") or {}).get("sha") or ""),
                    base_ref=((row.get("base") or {}).get("ref") or ""),
                    url=row.get("html_url") or f"https://github.com/{repo}/pull/{row['number']}",
                )
            )
        if len(page_rows) < 100:
            break
        page += 1
    rows.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
    return rows


def _ordered_inventory(
    inventory: list[OrderedDict[str, Any]],
    selection_order: str,
) -> list[OrderedDict[str, Any]]:
    if selection_order == "oldest":
        return sorted(
            inventory,
            key=lambda item: (
                str(item.get("created_at") or ""),
                int(item["number"]),
            ),
        )
    return sorted(
        inventory,
        key=lambda item: (
            str(item.get("updated_at") or item.get("created_at") or ""),
            int(item["number"]),
        ),
        reverse=True,
    )


def _high_signal_inventory_numbers(
    inventory: list[OrderedDict[str, Any]],
    active_numbers: set[int],
    candidate_limit: int,
) -> list[int]:
    candidates: list[int] = []
    for row in inventory:
        number = int(row["number"])
        if number in active_numbers:
            continue
        text = _normal_text(row.get("title"), row.get("author"), row.get("base_ref"))
        if any(keyword in text for keyword in HIGH_SIGNAL_INVENTORY_KEYWORDS):
            candidates.append(number)
        if len(candidates) >= candidate_limit:
            break
    return candidates


def _select_live_scan_prs(
    repo: str,
    *,
    scan_mode: str,
    selection_order: str = DEFAULT_SELECTION_ORDER,
    active_limit: int,
    candidate_limit: int,
    per_pr_timeout_seconds: int,
    train_pool_size: int = DEFAULT_TRAIN_POOL_SIZE,
) -> tuple[list[int], OrderedDict[str, Any]]:
    active_limit = max(1, active_limit)
    candidate_limit = max(0, candidate_limit)
    scope = OrderedDict(
        mode=scan_mode,
        selection_order=selection_order,
        train_pool_size=train_pool_size,
        active_train_workers=[],
        worker_refill_policy="",
        next_refill_train="",
        active_limit=active_limit,
        candidate_limit=candidate_limit,
        per_pr_timeout_seconds=per_pr_timeout_seconds,
        inventory_open_count=None,
        active_window_prs=[],
        older_candidate_prs=[],
        reviewed_prs=[],
        reviewed_count=0,
        inventory_error="",
        subset_description="",
    )

    if scan_mode == "active" and selection_order == "latest":
        prs = _open_live_pr_numbers(repo, active_limit)
        scope["active_window_prs"] = prs
        scope["reviewed_prs"] = prs
        scope["reviewed_count"] = len(prs)
        scope["subset_description"] = (
            f"active mode deep-reviewed the latest {len(prs)} open PRs; "
            "all-open inventory was intentionally skipped for speed"
        )
        return prs, scope

    if scan_mode == "active":
        try:
            inventory = _ordered_inventory(_open_pr_inventory(repo), selection_order)
            prs = [int(row["number"]) for row in inventory[:active_limit]]
            scope["inventory_open_count"] = len(inventory)
            scope["active_window_prs"] = prs
            scope["reviewed_prs"] = prs
            scope["reviewed_count"] = len(prs)
            scope["subset_description"] = (
                f"active mode inventoried all {len(inventory)} open PRs to deep-review "
                f"the {selection_order} {len(prs)} PRs"
            )
            return prs, scope
        except Exception as exc:
            prs = _open_live_pr_numbers(repo, active_limit)
            scope["active_window_prs"] = prs
            scope["reviewed_prs"] = prs
            scope["reviewed_count"] = len(prs)
            scope["inventory_error"] = str(exc)
            scope["subset_description"] = (
                f"oldest-first active inventory failed; fallback deep-reviewed latest {len(prs)} open PRs only"
            )
            return prs, scope

    try:
        inventory = _ordered_inventory(_open_pr_inventory(repo), selection_order)
    except Exception as exc:
        prs = _open_live_pr_numbers(repo, active_limit)
        scope["active_window_prs"] = prs
        scope["reviewed_prs"] = prs
        scope["reviewed_count"] = len(prs)
        scope["inventory_error"] = str(exc)
        scope["subset_description"] = (
            f"inventory failed; fallback deep-reviewed latest {len(prs)} open PRs only"
        )
        return prs, scope

    active = [int(row["number"]) for row in inventory[:active_limit]]
    if scan_mode == "full":
        prs = [int(row["number"]) for row in inventory]
        candidates: list[int] = []
        subset = "full mode deep-reviewed every open PR from cheap inventory"
    else:
        candidates = _high_signal_inventory_numbers(
            inventory,
            set(active),
            candidate_limit,
        )
        prs = list(dict.fromkeys(active + candidates))
        subset = (
            f"hybrid mode inventoried all {len(inventory)} open PRs, deep-reviewed "
            f"{selection_order} {len(active)} plus {len(candidates)} high-signal candidates"
        )

    scope["inventory_open_count"] = len(inventory)
    scope["active_window_prs"] = active
    scope["older_candidate_prs"] = candidates
    scope["reviewed_prs"] = prs
    scope["reviewed_count"] = len(prs)
    scope["subset_description"] = subset
    return prs, scope


def _report_gate_counts(reports: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for report in reports:
        status = str(report.get("current_ci_status_gate") or "UNKNOWN")
        counts[status] = counts.get(status, 0) + 1
    return dict(sorted(counts.items()))


def _batch_report_by_number(batch: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return {report["pr"]["number"]: report for report in batch.get("reports", [])}


def _linked_prs(batch: dict[str, Any], numbers: list[int]) -> str:
    by_number = _batch_report_by_number(batch)
    parts: list[str] = []
    for number in numbers:
        report = by_number.get(number)
        url = report["pr"]["url"] if report else f"https://github.com/{batch['repo']}/pull/{number}"
        parts.append(f"[#{number}]({url})")
    return ", ".join(parts) if parts else "none"


def _scan_scope_lines(batch: dict[str, Any]) -> list[str]:
    scope = batch.get("scan_scope") or {}
    completeness = batch.get("scan_completeness") or {}
    lines = [
        "## Scan Scope",
        "",
        f"- Mode: `{scope.get('mode', 'explicit')}`.",
        f"- Selection order: `{scope.get('selection_order', DEFAULT_SELECTION_ORDER)}`.",
        f"- Reviewed subset: {scope.get('subset_description') or completeness.get('subset_description') or 'explicit PR subset'}.",
        f"- Reviewed PRs: {_linked_prs(batch, [int(item) for item in scope.get('reviewed_prs', batch.get('prs', []))])}.",
        f"- Open PR inventory count: `{scope.get('inventory_open_count') if scope.get('inventory_open_count') is not None else 'not inventoried'}`.",
        f"- Per-PR timeout: `{scope.get('per_pr_timeout_seconds', DEFAULT_PER_PR_TIMEOUT_SECONDS)}s`.",
        f"- Train pool size: `{scope.get('train_pool_size', batch.get('train_pool_size', DEFAULT_TRAIN_POOL_SIZE))}`.",
        f"- Active train workers: `{scope.get('active_train_workers', batch.get('active_train_workers', []))}`.",
        f"- Next refill train: `{scope.get('next_refill_train') or batch.get('next_refill_train') or 'none'}`.",
        f"- Reviewed state counts: terminal `{scope.get('reviewed_terminal_count', batch.get('reviewed_terminal_count', 0))}`, blocked `{scope.get('reviewed_blocked_count', batch.get('reviewed_blocked_count', 0))}`, remaining `{scope.get('reviewed_remaining_count', batch.get('reviewed_remaining_count', 0))}`.",
        f"- Completeness: `{completeness.get('status', 'unknown')}` - {completeness.get('message', 'no completeness record')}",
    ]
    if scope.get("older_candidate_prs"):
        lines.append(f"- Older high-signal candidates included: {_linked_prs(batch, [int(item) for item in scope['older_candidate_prs']])}.")
    if scope.get("inventory_error"):
        lines.append(f"- Inventory error: `{scope['inventory_error']}`.")
    return lines


def _queue_cohort_lines(batch: dict[str, Any]) -> list[str]:
    lines = ["", "## Queue Cohort", ""]
    cohorts = batch.get("queue_cohorts") or []
    if not cohorts:
        lines.append("- No independent `merge_now` cohort is currently queueable from the reviewed subset.")
        return lines
    for cohort in cohorts:
        lines.append(
            f"- `{cohort['id']}`: {_linked_prs(batch, [int(item) for item in cohort['prs']])}. Rule: {cohort['rule']}."
        )
    return lines


def _subagent_taskforce_lines(batch: dict[str, Any]) -> list[str]:
    lines = ["", "## All Async Trains", ""]
    entries = batch.get("train_to_subagent_map") or []
    if not entries:
        lines.append("- No executable train-to-subagent map from the reviewed subset. Use the delegation router before any manual GitHub write.")
        return lines
    lines.append("Subagent taskforce map: one independent train maps to one evidence lane; independent trains run in parallel and each train sequence runs oldest PR first.")
    lines.append(f"Train worker pool: `{batch.get('train_pool_size', DEFAULT_TRAIN_POOL_SIZE)}` active slots; active workers `{batch.get('active_train_workers', [])}`; next refill train `{batch.get('next_refill_train') or 'none'}`.")
    lines.append(f"Refill policy: {batch.get('worker_refill_policy') or 'refill the next oldest non-touching train after a worker finishes or blocks'}.")
    lines.append("")
    for entry in entries:
        lines.append(
            f"- `{entry['id']}` / `{entry['train_type']}`: {_linked_prs(batch, [int(item) for item in entry['prs']])}; "
            f"lane `{entry['subagent_lane']}` via `{entry['agent']}`; "
            f"worker slot `{entry.get('worker_slot') or 'queued'}`; "
            f"terminal state `{entry.get('train_terminal_state') or 'needs_review'}`; "
            f"oldest-first sequence `{entry.get('sequential_prs') or []}`; "
            f"parallel with `{entry.get('parallel_with') or []}`; "
            f"signals `{'; '.join(entry.get('routing_signals') or [])}`."
        )
    return lines


def _collision_group_lines(batch: dict[str, Any]) -> list[str]:
    lines = ["", "## Collision Groups", ""]
    groups = batch.get("collision_groups") or []
    if not groups:
        lines.append("- No hard collision groups detected in the reviewed subset.")
        return lines
    for group in groups:
        lines.append(
            f"- `{group['id']}`: {_linked_prs(batch, [int(item) for item in group['prs']])}; "
            f"sequence `{group['sequence']}`; reasons `{'; '.join(group['reasons'])}`."
        )
    return lines


def _parallel_patch_train_lines(batch: dict[str, Any]) -> list[str]:
    lines = ["", "## Parallel Patch Trains", ""]
    trains = batch.get("parallel_patch_trains") or []
    if not trains:
        lines.append("- No maintainer patch train is currently eligible. Standalone/unreachable helpers stay in changes-requested until an attach point is proven.")
        return lines
    for train in trains:
        lines.append(
            f"- `{train['id']}`: {_linked_prs(batch, [int(item) for item in train['prs']])}; "
            f"attach `{train.get('canonical_attach_point') or 'none'}`; files {_compact_file_list(train.get('files', []), limit=6)}; proof `{train.get('proof') or 'surface proof required'}`."
        )
    return lines


def _decision_wave_lines(batch: dict[str, Any]) -> list[str]:
    lines = ["", "## Decision Waves", ""]
    waves = batch.get("decision_waves") or []
    if not waves:
        lines.append("- No closure or changes-requested wave detected in the reviewed subset.")
        return lines
    for wave in waves:
        selected = [int(item) for item in wave.get("prs", [])]
        candidates = [int(item) for item in wave.get("candidate_prs", selected)]
        remaining = [int(item) for item in wave.get("remaining_prs", [])]
        question = wave.get("question_before_wave") or {}
        lines.extend(
            [
                f"### `{wave['id']}` / `{wave['action']}`",
                "",
                f"- Exact PR links: {_linked_prs(batch, selected)}.",
                f"- Candidate PRs: `{len(candidates)}`; remaining after this wave: `{len(remaining)}`.",
                f"- Recommended Wave Size: `{wave.get('recommended_wave_size', len(selected))}`.",
                f"- Why This Size: {wave.get('why_this_size') or 'not recorded'}.",
                f"- Next action: `{wave.get('next_action') or 'ask_operator'}`.",
                f"- Comment/Edit Policy: {wave.get('comment_edit_policy') or 'inspect existing maintainer records first'}.",
                f"- Stop Conditions: head SHA change, CI state loss, incomplete scan, unsafe existing-record edit, or new hard collision.",
                f"- Rule: {wave['rule']}.",
                "- Question Before Wave:",
                f"  - Current truth: {question.get('current_truth') or 'not recorded'}",
                f"  - Recommended path: {question.get('recommended_path') or 'not recorded'}",
                f"  - Risk if accepted blindly: {question.get('risk_if_accepted_blindly') or 'not recorded'}",
                f"  - Decision needed: {question.get('decision_needed') or 'not recorded'}",
                f"  - Recommended option: `{question.get('recommended_option') or 'approve_recommended_wave'}`",
                "",
            ]
        )
    return lines


def _check_failure_hold_lines(batch: dict[str, Any]) -> list[str]:
    lines = ["", "## Check Failure Holds", ""]
    holds = batch.get("check_failure_holds") or []
    if not holds:
        lines.append("- none")
        return lines
    lines.append(
        "- These PRs are excluded from queue cohorts, patch trains, collision trains, decision waves, and recommended operator batches until their current checks are clean."
    )
    for hold in holds:
        number = int(hold["pr"])
        lines.append(f"- {_linked_prs(batch, [number])}: {hold['reason']}.")
    return lines


def _reviewed_state_bucket_lines(batch: dict[str, Any]) -> list[str]:
    state = batch.get("reviewed_state") or {}
    lines = ["", "## Reviewed State Buckets", ""]
    lines.append(
        f"- Reviewed: `{len(batch.get('prs', []))}`; acted in this live report: `0`; "
        f"terminal `{batch.get('reviewed_terminal_count', 0)}`; "
        f"blocked `{batch.get('reviewed_blocked_count', 0)}`; "
        f"remaining `{batch.get('reviewed_remaining_count', 0)}`."
    )
    lines.append("- `acted` is `0` in scanner output because GitHub writes happen after operator approval; final chat handoffs must replace it with actual merge/close/comment counts.")
    for key, label in (
        ("terminal", "Terminal / already handled"),
        ("blocked", "Blocked"),
        ("remaining", "Remaining train work"),
    ):
        rows = state.get(key) or []
        if rows:
            links = _linked_prs(batch, [int(row["pr"]) for row in rows])
            reasons = "; ".join(f"#{int(row['pr'])}: {row.get('reason') or 'not recorded'}" for row in rows[:10])
            if len(rows) > 10:
                reasons += f"; +{len(rows) - 10} more"
            lines.append(f"- {label}: {links}. Reasons: {reasons}.")
        else:
            lines.append(f"- {label}: none.")
    return lines


def _live_report_text(batch: dict[str, Any]) -> str:
    generated_at = batch["generated_at"]
    actionable_reports = [
        report for report in batch["reports"] if _is_actionable_live_candidate(report)
    ]
    actionable_grouped: dict[str, list[dict[str, Any]]] = {}
    for report in actionable_reports:
        actionable_grouped.setdefault(report["contract_set"], []).append(report)

    lines: list[str] = [
        "# Temporary PR Governance Live Report",
        "",
        "Status: live operational record",
        f"Last refreshed: {generated_at}",
        f"Repo: https://github.com/{batch['repo']}",
        f"Scope: {(batch.get('scan_scope') or {}).get('subset_description') or 'explicit reviewed PR subset'}",
        "",
        "This file is live-only. Merged and closed PRs belong in GitHub comments, final handoff notes, or a separate audit ledger.",
        "",
        "## Index",
        "",
        "- [Scan Scope](#scan-scope)",
        "- [Live Summary](#live-summary)",
        "- [Live Risk Matrix](#live-risk-matrix)",
        "- [All Async Trains](#all-async-trains)",
        "- [Queue Cohort](#queue-cohort)",
        "- [Collision Groups](#collision-groups)",
        "- [Parallel Patch Trains](#parallel-patch-trains)",
        "- [Decision Waves](#decision-waves)",
        "- [Check Failure Holds](#check-failure-holds)",
        "- [Reviewed State Buckets](#reviewed-state-buckets)",
        "- [Actionable Next Queue](#actionable-next-queue)",
        "- [Blocked / Waiting Register](#blocked--waiting-register)",
        "- [Contract Intake Sets](#contract-intake-sets)",
        "- [Recommended Operator Batches](#recommended-operator-batches)",
        "- [Mass Closure Candidates](#mass-closure-candidates)",
        "- [Mass Changes Requested Candidates](#mass-changes-requested-candidates)",
        "- [Merge Train Candidates](#merge-train-candidates)",
        "- [Patch Train Candidates](#patch-train-candidates)",
        "- [Do Not Batch Yet](#do-not-batch-yet)",
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
            *_scan_scope_lines(batch),
            "",
            "## Live Summary",
            "",
            f"- Current open PRs: {(batch.get('scan_scope') or {}).get('inventory_open_count') if (batch.get('scan_scope') or {}).get('inventory_open_count') is not None else 'not inventoried'}.",
            f"- Reviewed PRs: {len(batch['prs'])}.",
            f"- Required gate counts: `{json.dumps(_report_gate_counts(batch['reports']), sort_keys=True)}`.",
            f"- Actionable fresh-batch candidates: {len(actionable_reports)}.",
            f"- Train pool: `{batch.get('train_pool_size', DEFAULT_TRAIN_POOL_SIZE)}` workers; active `{batch.get('active_train_workers', [])}`; next refill `{batch.get('next_refill_train') or 'none'}`.",
            f"- Reviewed state: terminal `{batch.get('reviewed_terminal_count', 0)}`, blocked `{batch.get('reviewed_blocked_count', 0)}`, remaining `{batch.get('reviewed_remaining_count', 0)}`.",
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
    lines.extend([""])
    lines.extend(_subagent_taskforce_lines(batch))
    lines.extend(_queue_cohort_lines(batch))
    lines.extend(_collision_group_lines(batch))
    lines.extend(_parallel_patch_train_lines(batch))
    lines.extend(_decision_wave_lines(batch))
    lines.extend(_check_failure_hold_lines(batch))
    lines.extend(_reviewed_state_bucket_lines(batch))
    lines.extend([""])
    lines.extend(_live_actionable_queue_lines(batch["reports"]))
    lines.extend(_blocked_live_register_lines(batch["reports"]))
    lines.extend(
        [
            "",
            "## Contract Intake Sets",
            "",
            "These are broad intake buckets grouped from the Actionable Next Queue by product/runtime contract. They are not merge batches by themselves. Use them to choose which domain to inspect next, then use Recommended Operator Batches for actual merge/close execution.",
            "",
        ]
    )
    if not actionable_grouped:
        lines.append("- none; every current open PR is blocked, failing checks, conflicting, draft-only, or waiting on contributor action.")
    for contract_set, reports in sorted(actionable_grouped.items()):
        prs = _linked_prs(batch, [int(report["pr"]["number"]) for report in reports])
        lanes = ", ".join(
            f"{_linked_prs(batch, [int(report['pr']['number'])])}={report['lane']}" for report in reports
        )
        risks = ", ".join(
            f"{_linked_prs(batch, [int(report['pr']['number'])])}={_lean_core_risk(report)}" for report in reports
        )
        lines.append(f"- `{contract_set}`: {prs} ({lanes}; risk {risks})")
    lines.extend(
        [
            "",
            "## Recommended Operator Batches",
            "",
            "These are the execution groups to take at once. They are derived from exact file overlap, duplicate/superseded outcomes, shared implementation dependencies, or narrow adjacent contracts with the same proof surface. Broad contract labels alone are not enough.",
            "",
        ]
    )
    actionable_numbers = {report["pr"]["number"] for report in actionable_reports}
    actionable_overlaps = [
        overlap
        for overlap in batch.get("overlaps", [])
        if set(overlap.get("pair", [])) <= actionable_numbers
    ]
    lines.extend(_operator_batch_lines(_operator_batches(actionable_reports, actionable_overlaps)))
    mass_groups: dict[str, list[dict[str, Any]]] = {
        "mass_closure": [],
        "changes_requested": [],
        "merge_train": [],
        "patch_train": [],
        "do_not_batch_yet": [],
    }
    for report in actionable_reports:
        lane = _mass_operator_lane(report)
        mass_groups.setdefault(lane, []).append(report)
    lines.extend(
        _mass_operator_section_lines(
            "Mass Closure Candidates",
            mass_groups["mass_closure"],
            "none detected from current actionable PRs.",
        )
    )
    lines.extend(
        _mass_operator_section_lines(
            "Mass Changes Requested Candidates",
            mass_groups["changes_requested"],
            "none detected from current actionable PRs.",
        )
    )
    lines.extend(
        _mass_operator_section_lines(
            "Merge Train Candidates",
            mass_groups["merge_train"],
            "none detected from current actionable PRs.",
        )
    )
    lines.extend(
        _mass_operator_section_lines(
            "Patch Train Candidates",
            mass_groups["patch_train"],
            "none detected from current actionable PRs.",
        )
    )
    lines.extend(
        _mass_operator_section_lines(
            "Do Not Batch Yet",
            mass_groups["do_not_batch_yet"],
            "none detected from current actionable PRs.",
        )
    )
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
            left, right = overlap["pair"]
            lines.append(
                f"- {_linked_prs(batch, [int(left)])} <-> {_linked_prs(batch, [int(right)])}: "
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
    decision_basis = (
        f"Current head `{pr['head_sha'][:8]}` has CI Status Gate "
        f"`{report['current_ci_status_gate']}`."
    )

    if lane == "merge_now":
        return "\n".join(
            [
                f"## Merged: {contract_title}",
                "",
                "### What Landed",
                "The current head is aligned with the existing caller, runtime, and trust-boundary contracts.",
                "",
                "### Why It Matters",
                "This keeps the merged surface aligned with Hussh runtime and trust-boundary expectations.",
                "",
                "### Outcome",
                "Post-merge closeout is required after Main Post-Merge Smoke is green.",
            ]
        )

    elif lane == "patch_then_merge":
        plan = report.get("patch_attachment_plan") or {}
        return "\n".join(
            [
                f"## Merged: {contract_title}",
                "",
                "### What Landed",
                "The direction is useful, but the current head should not be merged unchanged.",
                "",
                "### Why It Matters",
                report["decision"]["rationale"],
                "",
                "### Maintainer Patch",
                f"Maintainer-owned patch was explicitly chosen for: {finding_ids}.",
                f"Accepted value: {plan.get('accepted_value') or 'bounded integration value only'}.",
                f"Attach point: `{plan.get('canonical_attach_point') or 'not set'}`.",
                f"Files to patch: `{', '.join(plan.get('files_codex_will_patch') or []) or 'not set'}`.",
                f"Dropped/deferred: {plan.get('dropped_or_deferred') or 'unreachable or unrelated pieces'}",
                f"Proof: `{plan.get('smallest_proof_command') or 'surface proof required'}`.",
                "",
                "### Outcome",
                "Post-merge closeout is required after Main Post-Merge Smoke is green.",
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
                "### Decision Basis",
                decision_basis,
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


def _write_text_atomic(path: str, text: str) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        delete=False,
        dir=str(output_path.parent),
        prefix=f".{output_path.name}.",
        suffix=".tmp",
    ) as handle:
        handle.write(text)
        handle.write("\n")
        temp_name = handle.name
    Path(temp_name).replace(output_path)


def build_report(repo: str, pr: int) -> dict[str, Any]:
    schematics = _schematics_summary()
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
            "createdAt",
            "isDraft",
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
    required_status_check = str(schematics.get("required_status_check") or "CI Status Gate")
    ci_status_gate = next(
        (item.get("conclusion", "UNKNOWN") for item in current_checks if item.get("name") == required_status_check),
        "MISSING",
    )
    failed_non_required_checks = _failed_non_required_checks(current_checks, required_status_check)
    report = OrderedDict(
        generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        repo=repo,
        schematics=schematics,
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
            created_at=pr_view.get("createdAt") or "",
            is_draft=bool(pr_view.get("isDraft")),
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
        founder_wiki_probe=_founder_wiki_probe(
            title=pr_view["title"],
            summary=_extract_summary(pr_view.get("body")),
            files=files,
            patch_map=patch_map,
            contract_set=contract_set,
        ),
    )
    local_overlap = sorted(set(files) & _local_worktree_changed_paths())
    if local_overlap:
        _append_finding(
            report,
            _finding(
                "local_worktree_overlap",
                "high",
                (
                    "PR touches files with uncommitted local maintainer changes. "
                    "Do not merge the PR head until the local branch is committed, "
                    "stashed, rebased, or the useful PR content is explicitly harvested."
                ),
                local_overlap,
                details={"local_changed_paths": local_overlap},
            ),
        )
    if ci_status_gate == "SUCCESS" and failed_non_required_checks:
        _append_finding(
            report,
            _finding(
                "auxiliary_check_failing",
                "high",
                (
                    "A non-required current check is failing while the aggregate required gate is green. "
                    "Do not treat this PR as merge-ready until the failing check is fixed, removed, or "
                    "explicitly classified as intentionally advisory."
                ),
                files,
                details=[
                    {
                        "name": item.get("name"),
                        "conclusion": item.get("conclusion"),
                        "details_url": item.get("detailsUrl"),
                    }
                    for item in failed_non_required_checks
                ],
            ),
        )
    for finding in _claim_surface_mismatch_findings(
        pr_view["title"],
        pr_view.get("body"),
        files,
    ):
        _append_finding(report, finding)
    for finding in _stacked_branch_findings(
        pr_view["title"],
        pr_view.get("body"),
        files,
    ):
        _append_finding(report, finding)
    if report["pr"]["review_decision"] == "CHANGES_REQUESTED":
        _append_finding(
            report,
            _finding(
                "active_changes_requested_review",
                "high",
                "The current PR head has an active changes-requested review. Green CI cannot override maintainer-requested changes.",
                files,
                details={"review_decision": report["pr"]["review_decision"]},
            ),
        )
    report["decision"] = _recommend_merge_lane(
        ci_status_gate=ci_status_gate,
        review_decision=report["pr"].get("review_decision", ""),
        findings=report["findings"],
        surface_tags=report["surface_tags"],
        changed_files=files,
    )
    report["lane"] = report["decision"]["lane"]
    _apply_patch_attachment_policy(report)
    report["patch_then_merge_reason"] = _patch_then_merge_reason(
        report["findings"], report["lane"]
    )
    if report.get("patch_denied_reason"):
        report["patch_then_merge_reason"] = report["patch_denied_reason"]
    report["public_comment_policy"] = _public_comment_policy(report["lane"])
    report["live_report_action"] = _live_report_action(report["lane"])
    report["communication_markdown"] = _communication_markdown(report)
    _initialize_train_fields(report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize current-head PR review risks.")
    parser.add_argument("--repo", default="hushh-labs/hushh-research")
    parser.add_argument("--pr", type=int)
    parser.add_argument("--prs", help="Comma-separated PR numbers for batch review.")
    parser.add_argument("--live-report", action="store_true", help="Build a live-only report from current open PRs, including drafts.")
    parser.add_argument("--limit", type=int, default=DEFAULT_ACTIVE_LIMIT, help="Active-window PR limit for --live-report.")
    parser.add_argument("--scan-mode", choices=sorted(SCAN_MODES), default="hybrid", help="Live-report scan mode: active, hybrid, or full.")
    parser.add_argument("--selection-order", choices=sorted(SELECTION_ORDERS), default=DEFAULT_SELECTION_ORDER, help="Live-report backlog selection order for active/hybrid windows.")
    parser.add_argument("--candidate-limit", type=int, default=DEFAULT_CANDIDATE_LIMIT, help="Older high-signal PR candidate limit for hybrid live reports.")
    parser.add_argument("--queue-cohort-size", type=int, default=DEFAULT_QUEUE_COHORT_SIZE, help="Maximum independent merge_now PRs in the first queue cohort.")
    parser.add_argument("--per-pr-timeout-seconds", type=int, default=DEFAULT_PER_PR_TIMEOUT_SECONDS, help="Maximum seconds to spend deep-scanning one PR before marking it incomplete.")
    parser.add_argument("--max-parallel-patch-trains", type=int, default=DEFAULT_MAX_PARALLEL_PATCH_TRAINS, help="Maximum disjoint maintainer patch trains to surface.")
    parser.add_argument("--train-pool-size", type=int, default=DEFAULT_TRAIN_POOL_SIZE, help="Active async train worker slots for live reports.")
    parser.add_argument("--output", help="Write output atomically to this path instead of stdout.")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--text", action="store_true")
    args = parser.parse_args()

    selected_modes = sum(bool(value) for value in (args.pr, args.prs, args.live_report))
    if selected_modes != 1:
        parser.error("use exactly one of --pr, --prs, or --live-report")

    try:
        if args.live_report:
            prs, scan_scope = _select_live_scan_prs(
                args.repo,
                scan_mode=args.scan_mode,
                selection_order=args.selection_order,
                active_limit=args.limit,
                candidate_limit=args.candidate_limit,
                per_pr_timeout_seconds=args.per_pr_timeout_seconds,
                train_pool_size=args.train_pool_size,
            )
            report = build_batch_report(
                args.repo,
                prs,
                scan_scope=scan_scope,
                per_pr_timeout_seconds=args.per_pr_timeout_seconds,
                queue_cohort_size=args.queue_cohort_size,
                max_parallel_patch_trains=args.max_parallel_patch_trains,
                train_pool_size=args.train_pool_size,
            )
            is_batch = True
            is_live_report = True
        elif args.prs:
            prs = [int(item.strip()) for item in args.prs.split(",") if item.strip()]
            report = build_batch_report(
                args.repo,
                prs,
                per_pr_timeout_seconds=args.per_pr_timeout_seconds,
                queue_cohort_size=args.queue_cohort_size,
                max_parallel_patch_trains=args.max_parallel_patch_trains,
                train_pool_size=args.train_pool_size,
            )
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
        rendered = json.dumps(report, indent=2)
    elif is_live_report:
        rendered = _live_report_text(report)
    else:
        rendered = _batch_text_report(report) if is_batch else _text_report(report)
    if args.output:
        _write_text_atomic(args.output, rendered)
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
