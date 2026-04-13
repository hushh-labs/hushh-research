"use client";

import { resolveAppEnvironment } from "@/lib/app-env";
import type {
  MarketplaceInvestor,
  RiaAccountBranch,
  RiaAvailableScopeMetadata,
  RiaClientAccess,
  RiaClientDetail,
  RiaClientWorkspace,
  RiaKaiSpecializedBundle,
  RiaRequestScopeTemplate,
} from "@/lib/services/ria-service";

export const RIA_KAI_SPECIALIZED_TEMPLATE_ID = "ria_kai_specialized_v1";
export const RIA_KAI_SPECIALIZED_BUNDLE_KEY = "ria_kai_specialized";

const KAI_TEST_DISPLAY_NAME = "Kai Test User";
const KAI_TEST_EMAIL = "test@hushh.ai";
const KAI_TEST_SECONDARY_LABEL = "Data explorer example";
const KAI_TEST_HEADLINE =
  "Sanitized investor example for access management, Kai parity, and portfolio explorer validation.";
const KAI_TEST_STRATEGY_SUMMARY =
  "Preloaded PKM-aligned portfolio, profile, analysis history, and runtime context for advisor-side explorer rehearsal.";
const KAI_TEST_LOCATION_HINT = "Reusable PKM payload rehearsal";

const TEST_ACCOUNT_BRANCHES: RiaAccountBranch[] = [
  {
    branch_id: "acct_demo_taxable_main",
    account_id: "acct_demo_taxable_main",
    item_id: "item_demo_taxable",
    institution_name: "Schwab",
    name: "Taxable brokerage",
    official_name: "Individual brokerage",
    mask: "4821",
    type: "investment",
    subtype: "brokerage",
    status: "approved",
    granted_by_bundle_key: RIA_KAI_SPECIALIZED_BUNDLE_KEY,
  },
  {
    branch_id: "acct_demo_retirement",
    account_id: "acct_demo_retirement",
    item_id: "item_demo_retirement",
    institution_name: "Fidelity",
    name: "Rollover IRA",
    official_name: "Retirement account",
    mask: "9124",
    type: "investment",
    subtype: "ira",
    status: "approved",
    granted_by_bundle_key: RIA_KAI_SPECIALIZED_BUNDLE_KEY,
  },
];

const TEST_REQUEST_ID = "request_demo_kai_specialized_bundle";

function testRequestHistory() {
  return [
    {
      request_id: TEST_REQUEST_ID,
      scope: "attr.financial.portfolio.*",
      action: "approved",
      issued_at: "2026-04-06T18:30:00.000Z",
      expires_at: "2026-04-13T18:30:00.000Z",
      bundle_id: RIA_KAI_SPECIALIZED_BUNDLE_KEY,
      bundle_label: "Kai specialized access",
      scope_metadata: {
        scope: "attr.financial.portfolio.*",
        label: "Portfolio",
        description: "Positions, allocation, and holdings summaries.",
        kind: "kai_specialized",
        summary_only: false,
      },
    },
  ];
}

function testAvailableScopeMetadata(): RiaAvailableScopeMetadata[] {
  return [
    {
      scope: "attr.financial.portfolio.*",
      label: "Portfolio",
      description: "Positions, allocation, and holdings summaries.",
      kind: "kai_specialized",
      summary_only: false,
      available: true,
      domain_key: "financial",
      bundle_key: RIA_KAI_SPECIALIZED_BUNDLE_KEY,
      presentations: ["kai", "explorer"],
      requires_account_selection: true,
    },
    {
      scope: "attr.financial.profile.*",
      label: "Profile",
      description: "Risk profile, objectives, and household profile cues.",
      kind: "kai_specialized",
      summary_only: false,
      available: true,
      domain_key: "financial",
      bundle_key: RIA_KAI_SPECIALIZED_BUNDLE_KEY,
      presentations: ["kai", "explorer"],
      requires_account_selection: true,
    },
    {
      scope: "attr.financial.analysis_history.*",
      label: "Analysis history",
      description: "Saved decisions and prior Kai review history.",
      kind: "kai_specialized",
      summary_only: false,
      available: true,
      domain_key: "financial",
      bundle_key: RIA_KAI_SPECIALIZED_BUNDLE_KEY,
      presentations: ["kai", "explorer"],
      requires_account_selection: true,
    },
    {
      scope: "attr.financial.runtime.*",
      label: "Runtime context",
      description: "Live portfolio runtime context and summary state.",
      kind: "kai_specialized",
      summary_only: false,
      available: true,
      domain_key: "financial",
      bundle_key: RIA_KAI_SPECIALIZED_BUNDLE_KEY,
      presentations: ["kai", "explorer"],
      requires_account_selection: true,
    },
  ];
}

function testKaiBundle(): RiaKaiSpecializedBundle {
  const approvedAccountIds = TEST_ACCOUNT_BRANCHES.map((branch) => branch.branch_id);
  return {
    bundle_key: RIA_KAI_SPECIALIZED_BUNDLE_KEY,
    template_id: RIA_KAI_SPECIALIZED_TEMPLATE_ID,
    label: "Kai specialized access",
    description:
      "Advisor-side Kai and explorer access for portfolio, profile, analysis history, and runtime context.",
    presentations: ["kai", "explorer"],
    requires_account_selection: true,
    status: "active",
    approved_account_ids: approvedAccountIds,
    pending_account_ids: [],
    selected_account_ids: approvedAccountIds,
    legacy_grant_compatible: false,
    scopes: testAvailableScopeMetadata().map((scope) => ({ ...scope, status: "active" })),
  };
}

function testScopeTemplate(): RiaRequestScopeTemplate {
  return {
    template_id: RIA_KAI_SPECIALIZED_TEMPLATE_ID,
    template_name: "Kai specialized access",
    description:
      "Bundle investor portfolio, profile, history, and runtime context into the advisor workspace.",
    default_duration_hours: 24 * 7,
    max_duration_hours: 24 * 365,
    bundle_key: RIA_KAI_SPECIALIZED_BUNDLE_KEY,
    presentations: ["kai", "explorer"],
    requires_account_selection: true,
    scopes: testAvailableScopeMetadata().map((scope) => ({
      scope: scope.scope,
      label: scope.label,
      description: scope.description,
      kind: scope.kind,
      summary_only: scope.summary_only,
      bundle_key: scope.bundle_key,
      presentations: scope.presentations,
      requires_account_selection: scope.requires_account_selection,
    })),
  };
}

export function getKaiTestUserId() {
  return sanitizeConfiguredValue(process.env.NEXT_PUBLIC_KAI_TEST_USER_ID);
}

export function canShowKaiTestProfile() {
  return resolveAppEnvironment() !== "production" && Boolean(getKaiTestUserId());
}

export function isKaiTestProfileUser(userId?: string | null) {
  const kaiTestUserId = getKaiTestUserId();
  return Boolean(kaiTestUserId && String(userId || "").trim() === kaiTestUserId);
}

export function buildKaiTestClientAccess(userId: string): RiaClientAccess {
  return {
    id: `demo-kai-test-client-${userId}`,
    investor_user_id: userId,
    investor_display_name: KAI_TEST_DISPLAY_NAME,
    investor_email: KAI_TEST_EMAIL,
    investor_secondary_label: KAI_TEST_SECONDARY_LABEL,
    investor_headline: KAI_TEST_HEADLINE,
    status: "approved",
    relationship_status: "approved",
    granted_scope: "attr.financial.portfolio.*",
    disconnect_allowed: false,
    is_invite_only: false,
    is_self_relationship: false,
  };
}

export function buildKaiTestClientDetail(userId: string): RiaClientDetail {
  return {
    investor_user_id: userId,
    investor_display_name: KAI_TEST_DISPLAY_NAME,
    investor_email: KAI_TEST_EMAIL,
    investor_secondary_label: KAI_TEST_SECONDARY_LABEL,
    investor_headline: KAI_TEST_HEADLINE,
    relationship_status: "approved",
    granted_scope: "attr.financial.portfolio.*",
    disconnect_allowed: false,
    is_self_relationship: false,
    next_action: "Use this example to validate the dedicated client explorer before onboarding live clients.",
    relationship_shares: [],
    picks_feed_status: "ready",
    picks_feed_granted_at: null,
    has_active_pick_upload: true,
    granted_scopes: testAvailableScopeMetadata().map((scope) => ({
      scope: scope.scope,
      label: scope.label,
    })),
    request_history: testRequestHistory(),
    invite_history: [],
    requestable_scope_templates: [testScopeTemplate()],
    available_scope_metadata: testAvailableScopeMetadata(),
    kai_specialized_bundle: testKaiBundle(),
    account_branches: TEST_ACCOUNT_BRANCHES,
    available_domains: ["financial"],
    domain_summaries: {
      financial: {
        holdings_count: 8,
        risk_profile: "Moderate",
        account_count: TEST_ACCOUNT_BRANCHES.length,
        asset_allocation_pct: {
          equities: 0.64,
          bonds: 0.21,
          cash: 0.15,
        },
      },
    },
    total_attributes: 8,
    workspace_ready: true,
    pkm_updated_at: null,
    consent_granted_at: null,
    consent_expires_at: null,
    revoked_at: null,
    created_at: null,
    updated_at: null,
    last_request_id: null,
  };
}

export function buildKaiTestClientWorkspace(userId: string): RiaClientWorkspace {
  return {
    investor_user_id: userId,
    investor_display_name: KAI_TEST_DISPLAY_NAME,
    investor_email: KAI_TEST_EMAIL,
    investor_secondary_label: KAI_TEST_SECONDARY_LABEL,
    investor_headline: KAI_TEST_HEADLINE,
    workspace_ready: true,
    available_domains: ["financial"],
    domain_summaries: {
      financial: {
        holdings_count: 8,
        risk_profile: "Moderate",
        account_count: TEST_ACCOUNT_BRANCHES.length,
        asset_allocation_pct: {
          equities: 0.64,
          bonds: 0.21,
          cash: 0.15,
        },
      },
    },
    total_attributes: 8,
    relationship_status: "approved",
    scope: "attr.financial.portfolio.*",
    relationship_shares: [],
    picks_feed_status: "ready",
    picks_feed_granted_at: null,
    has_active_pick_upload: true,
    granted_scopes: testAvailableScopeMetadata().map((scope) => ({
      scope: scope.scope,
      label: scope.label,
    })),
    consent_expires_at: null,
    updated_at: "2026-04-06T18:45:00.000Z",
    kai_specialized_bundle: testKaiBundle(),
    account_branches: TEST_ACCOUNT_BRANCHES,
  };
}

export function buildKaiTestMarketplaceInvestor(userId: string): MarketplaceInvestor {
  return {
    user_id: userId,
    display_name: KAI_TEST_DISPLAY_NAME,
    headline: "Advisor-side Kai and Explorer rehearsal for the current PKM payload contract.",
    location_hint: KAI_TEST_LOCATION_HINT,
    strategy_summary: KAI_TEST_STRATEGY_SUMMARY,
    is_test_profile: true,
  };
}
function sanitizeConfiguredValue(value?: string | null) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const lower = normalized.toLowerCase();
  if (lower.includes("replace_with") || lower.includes("your_") || lower === "placeholder") {
    return "";
  }
  return normalized;
}
