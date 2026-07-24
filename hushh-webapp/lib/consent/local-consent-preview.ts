"use client";

import type {
  ConsentCenterActor,
  ConsentCenterEntry,
  ConsentCenterPageListResponse,
  ConsentCenterPageSummary,
  HandshakeHistoryResponse,
  PendingConsentLookupResponse,
} from "@/lib/services/consent-center-service";

type PreviewSurface = "pending" | "active" | "previous";
type PreviewMutationAction = "approve" | "deny" | "revoke";
type FixtureShape = "normal" | "long_copy" | "sparse";

interface LocalConsentPreviewState {
  pending: ConsentCenterEntry[];
  active: ConsentCenterEntry[];
  previous: ConsentCenterEntry[];
}

interface FixtureDescriptor {
  type: string;
  category: string;
  source: string;
  shape?: FixtureShape;
}

interface DensityScenario {
  category: string;
  source: string;
  scope: string;
  description: string | null;
  label: string;
}

const FIXTURE_ID = "local-consent-layout-v2";
const FIXTURE_PAGE_TOTAL = 21;

const DENSITY_SCENARIOS: DensityScenario[] = [
  {
    category: "kyc_passport",
    source: "one_email_kyc_v1",
    scope: "attr.identity.passport.*",
    description: "Passport identity fields",
    label: "ID",
  },
  {
    category: "kyc_bank",
    source: "one_email_kyc_v1",
    scope: "attr.identity.bank.*",
    description: "Bank identity and verification fields",
    label:
      "International Identity Verification and Banking Documentation Review Workspace",
  },
  {
    category: "professional",
    source: "developer_api",
    scope: "attr.professional.employment.*",
    description: null,
    label: "Career Profile Assistant",
  },
  {
    category: "portfolio",
    source: "ria_iam",
    scope: "attr.financial.portfolio.*",
    description: "Portfolio positions and allocation",
    label: "Portfolio Review",
  },
  {
    category: "financial_documents",
    source: "one_email_kyc_v1",
    scope: "attr.financial.documents.*",
    description: "Financial statements and supporting documents",
    label: "Document Review",
  },
  {
    category: "financial_analysis",
    source: "ria_iam",
    scope: "attr.financial.analysis_history.*",
    description: "Previous financial analyses",
    label: "Analysis Archive",
  },
  {
    category: "health_metrics",
    source: "developer_api",
    scope: "attr.health.metrics.*",
    description: "Health measurements and trends",
    label: "Health Metrics",
  },
  {
    category: "fitness",
    source: "developer_api",
    scope: "attr.health.fitness.*",
    description: "Fitness activity summary",
    label: "Fitness Companion",
  },
  {
    category: "food",
    source: "developer_api",
    scope: "attr.food.preferences.*",
    description: "Food and dietary preferences",
    label: "Meal Planner",
  },
  {
    category: "entertainment",
    source: "marketplace_access_request",
    scope: "attr.entertainment.preferences.*",
    description: "Entertainment preferences",
    label: "Media Discovery",
  },
  {
    category: "shopping",
    source: "marketplace_access_request",
    scope: "attr.shopping.preferences.*",
    description: "Shopping preferences",
    label: "Shopping Assistant",
  },
  {
    category: "dynamic_other",
    source: "developer_api",
    scope: "attr.education.credentials.certifications.latest.*",
    description:
      "Education credentials, certifications, and the latest verification details",
    label: "Credential Verification",
  },
];

let previewState: LocalConsentPreviewState | null = null;

function hoursFrom(now: number, hours: number) {
  return new Date(now + hours * 60 * 60 * 1000).toISOString();
}

function hoursAgo(now: number, hours: number) {
  return new Date(now - hours * 60 * 60 * 1000).toISOString();
}

function hoursAgoEpoch(now: number, hours: number) {
  return now - hours * 60 * 60 * 1000;
}

function fixtureEntry(
  entry: ConsentCenterEntry,
  descriptor: FixtureDescriptor,
): ConsentCenterEntry {
  return {
    ...entry,
    metadata: {
      ...(entry.metadata || {}),
      fixture_id: FIXTURE_ID,
      fixture_type: descriptor.type,
      fixture_category: descriptor.category,
      fixture_source: descriptor.source,
      fixture_shape: descriptor.shape || "normal",
    },
  };
}

function timestampValue(value?: number | string | null) {
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestFirst(entries: ConsentCenterEntry[]) {
  return [...entries].sort(
    (left, right) =>
      timestampValue(right.issued_at) - timestampValue(left.issued_at),
  );
}

function densityStatus(surface: PreviewSurface, index: number) {
  if (surface === "pending") {
    return index % 2 === 0 ? "pending" : "request_pending";
  }
  if (surface === "active") {
    return ["active", "approved", "granted"][index % 3] || "active";
  }
  return (
    ["denied", "revoked", "expired", "cancelled", "read"][index % 5] ||
    "denied"
  );
}

function historyAction(status: string) {
  if (status === "denied") return "CONSENT_DENIED";
  if (status === "revoked") return "REVOKED";
  if (status === "expired") return "TIMEOUT";
  if (status === "cancelled") return "CANCELLED";
  return "READ";
}

function buildDensityEntries(
  surface: PreviewSurface,
  now: number,
): ConsentCenterEntry[] {
  return DENSITY_SCENARIOS.map((scenario, index) => {
    const shape: FixtureShape =
      index === 1 ? "long_copy" : index === 2 ? "sparse" : "normal";
    const status = densityStatus(surface, index);
    const requestId = `preview-${surface}-density-${index + 1}`;
    const issuedAt =
      index % 3 === 0
        ? hoursAgoEpoch(now, 14 + index * 4)
        : hoursAgo(now, 14 + index * 4);
    const common: ConsentCenterEntry = {
      id: requestId,
      request_id: requestId,
      kind:
        surface === "pending"
          ? "incoming_request"
          : surface === "active"
            ? "active_grant"
            : "history",
      status,
      active: surface === "active",
      granted: surface === "active",
      action:
        surface === "pending"
          ? "REQUESTED"
          : surface === "active"
            ? "CONSENT_GRANTED"
            : historyAction(status),
      scope: scenario.scope,
      scope_description: scenario.description,
      counterpart_type:
        scenario.source === "ria_iam" ? "ria" : "developer",
      counterpart_id: `preview-${scenario.category}-${surface}`,
      counterpart_label: scenario.label,
      counterpart_email:
        shape === "sparse"
          ? null
          : `${scenario.category.replace(/_/g, "-")}@fixtures.example`,
      counterpart_secondary_label:
        shape === "long_copy"
          ? "A deliberately long supporting label that verifies wrapping without overlapping the status badge or action controls"
          : shape === "sparse"
            ? null
            : "Deterministic layout fixture",
      issued_at: issuedAt,
      expires_at:
        surface === "pending"
          ? hoursFrom(now, index === 0 ? 1 : 24 + index)
          : surface === "active"
            ? index === 3
              ? null
              : hoursFrom(now, index === 0 ? 2 : 48 + index * 8)
            : hoursAgo(now, Math.max(1, 8 + index)),
      approval_timeout_at:
        surface === "pending" ? hoursFrom(now, 24 + index) : null,
      reason:
        shape === "long_copy"
          ? "This intentionally long reason verifies that detailed consent explanations remain readable across narrow mobile layouts, standard desktop widths, and the slide-over detail panel without clipping or forcing horizontal scrolling."
          : shape === "sparse"
            ? null
            : `Preview ${scenario.category.replace(/_/g, " ")} consent.`,
      metadata: {
        request_source: scenario.source,
        density_index: index + 1,
        refresh_policy: index % 2 === 0 ? "snapshot" : "continuous_until_expiry",
      },
    };

    return fixtureEntry(common, {
      type: `${surface}_density`,
      category: scenario.category,
      source: scenario.source,
      shape,
    });
  });
}

function buildPendingAnchors(now: number): ConsentCenterEntry[] {
  return [
    fixtureEntry(
      {
        id: "preview-request-scope-upgrade",
        request_id: "preview-request-scope-upgrade",
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        scope: "attr.financial.portfolio.*",
        scope_description: "Portfolio positions and allocation",
        counterpart_type: "developer",
        counterpart_id: "northstar-planning",
        counterpart_label: "Northstar Planning",
        counterpart_email: "access@northstar.example",
        counterpart_secondary_label: "Connected financial planner",
        counterpart_website_url: "https://northstar.example",
        issued_at: hoursAgo(now, 2),
        expires_at: hoursFrom(now, 46),
        approval_timeout_at: hoursFrom(now, 46),
        request_url: "/one/profile/access",
        reason:
          "Prepare a consolidated allocation review before your next meeting.",
        is_scope_upgrade: true,
        existing_granted_scopes: ["attr.financial.profile.*"],
        additional_access_summary:
          "Adds portfolio positions to the financial profile access already approved.",
        chain_request_count: 2,
        consent_chain: [
          {
            id: "preview-chain-profile-approved",
            request_id: "preview-chain-profile-approved",
            status: "approved",
            action: "CONSENT_GRANTED",
            scope: "attr.financial.profile.*",
            scope_description: "Financial profile",
            issued_at: hoursAgo(now, 72),
            expires_at: hoursFrom(now, 96),
          },
          {
            id: "preview-request-scope-upgrade",
            request_id: "preview-request-scope-upgrade",
            status: "pending",
            action: "REQUESTED",
            scope: "attr.financial.portfolio.*",
            scope_description: "Portfolio positions and allocation",
            issued_at: hoursAgo(now, 2),
            expires_at: hoursFrom(now, 46),
          },
        ],
        metadata: {
          expiry_hours: 48,
          refresh_policy: "continuous_until_expiry",
          bundle_id: "preview-financial-planning-bundle",
        },
      },
      {
        type: "scope_upgrade",
        category: "portfolio",
        source: "developer_api",
      },
    ),
    fixtureEntry(
      {
        id: "preview-one-invocation",
        request_id: "preview-one-invocation",
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        scope: "cap.one.invoke",
        scope_description: "Invoke the private agent for this task",
        counterpart_type: "developer",
        counterpart_id: "agent-travel",
        counterpart_label: "Travel Agent",
        counterpart_email: "agent-travel@fixtures.example",
        issued_at: hoursAgo(now, 3),
        expires_at: hoursFrom(now, 21),
        reason: "Coordinate an itinerary through One.",
        metadata: {
          request_source: "one_a2a_invocation",
          task_id: "preview-a2a-task",
        },
      },
      {
        type: "one_a2a_request",
        category: "one_invocation",
        source: "one_a2a_invocation",
      },
    ),
    fixtureEntry(
      {
        id: "preview-kyc-identity",
        request_id: "preview-kyc-identity",
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        scope: "attr.identity.*",
        scope_description: "Identity details required for verification",
        counterpart_type: "developer",
        counterpart_id: "agent_kyc",
        counterpart_label: "One",
        counterpart_email: "one@hushh.ai",
        issued_at: hoursAgo(now, 4),
        expires_at: hoursFrom(now, 20),
        request_url: "/one/kyc?workflowId=preview-kyc-bundle",
        reason: "Complete a verification workflow from an approved email.",
        metadata: {
          request_source: "one_email_kyc_v1",
          workflow_id: "preview-kyc-bundle",
          gmail_thread_id: "preview-thread-identity",
          required_fields: ["full_name", "date_of_birth", "address"],
          bundle_id: "preview-kyc-bundle",
          bundle_label: "Verification information",
          expiry_hours: 24,
        },
      },
      {
        type: "email_kyc_bundle",
        category: "kyc_identity",
        source: "one_email_kyc_v1",
      },
    ),
    fixtureEntry(
      {
        id: "preview-kyc-documents",
        request_id: "preview-kyc-documents",
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        scope: "attr.financial.documents.*",
        scope_description: "Financial documents required for verification",
        counterpart_type: "developer",
        counterpart_id: "agent_kyc",
        counterpart_label: "One",
        counterpart_email: "one@hushh.ai",
        issued_at: hoursAgo(now, 4.1),
        expires_at: hoursFrom(now, 20),
        request_url: "/one/kyc?workflowId=preview-kyc-bundle",
        reason: "Share only the documents required by this verification step.",
        metadata: {
          request_source: "one_email_kyc_v1",
          workflow_id: "preview-kyc-bundle",
          gmail_thread_id: "preview-thread-documents",
          required_fields: ["bank_statement", "income_statement"],
          bundle_id: "preview-kyc-bundle",
          bundle_label: "Verification information",
          expiry_hours: 24,
        },
      },
      {
        type: "email_kyc_bundle",
        category: "financial_documents",
        source: "one_email_kyc_v1",
      },
    ),
    fixtureEntry(
      {
        id: "preview-ria-overview",
        request_id: "preview-ria-overview",
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        scope: "attr.financial.profile.*",
        scope_description: "Financial profile overview",
        counterpart_type: "ria",
        counterpart_id: "harbor-advisory",
        counterpart_label: "Harbor Advisory",
        counterpart_email: "team@harbor.example",
        counterpart_secondary_label: "Registered investment advisor",
        issued_at: hoursAgo(now, 5),
        expires_at: hoursFrom(now, 163),
        reason: "Review your financial profile before an advisory meeting.",
        metadata: {
          request_source: "ria_iam",
          ria_profile_id: "preview-harbor-advisory",
          expiry_hours: 168,
        },
      },
      {
        type: "ria_request",
        category: "financial_profile",
        source: "ria_iam",
      },
    ),
    fixtureEntry(
      {
        id: "preview-ria-risk",
        request_id: "preview-ria-risk",
        kind: "incoming_request",
        status: "request_pending",
        action: "REQUESTED",
        scope: "attr.financial.profile.risk_tolerance",
        scope_description: "Risk tolerance assessment",
        counterpart_type: "ria",
        counterpart_id: "ridge-capital",
        counterpart_label: "Ridge Capital",
        counterpart_email: "consent@ridge.example",
        issued_at: hoursAgo(now, 6),
        expires_at: hoursFrom(now, 66),
        reason: "Prepare a suitability review using only your risk profile.",
        metadata: {
          request_source: "ria_iam",
          expiry_hours: 72,
        },
      },
      {
        type: "ria_request",
        category: "financial_decisions",
        source: "ria_iam",
      },
    ),
    fixtureEntry(
      {
        id: "one_location_request:preview-location-request",
        request_id: "preview-location-request",
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        scope: "cap.location.live.view",
        scope_description: "Live location access request",
        counterpart_type: "investor",
        counterpart_id: "preview-location-requester",
        counterpart_label: "Anika Sharma",
        counterpart_email: "anika@example.test",
        issued_at: hoursAgo(now, 1),
        expires_at: hoursFrom(now, 23),
        approval_timeout_at: hoursFrom(now, 23),
        reason: "Coordinate the airport pickup.",
        metadata: {
          request_source: "one_location_access_request",
          request_id: "preview-location-request",
          requester_label: "Anika Sharma",
          duration_label: "1 hour",
          expiry_hours: 1,
          section: "approvals",
        },
      },
      {
        type: "location_request",
        category: "location",
        source: "one_location_access_request",
      },
    ),
    fixtureEntry(
      {
        id: "marketplace_request:preview-marketplace-request",
        request_id: "preview-marketplace-request",
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        scope: "attr.travel.preferences.*",
        scope_description: "Travel preference summary",
        counterpart_type: "investor",
        counterpart_id: "atlas-travel",
        counterpart_label: "Atlas Travel",
        counterpart_email: "requests@atlas.example",
        issued_at: hoursAgo(now, 7),
        expires_at: hoursFrom(now, 65),
        approval_timeout_at: hoursFrom(now, 65),
        reason:
          "Personalize a private itinerary without sharing raw trip records.",
        metadata: {
          request_source: "marketplace_access_request",
          request_id: "preview-marketplace-request",
          role: "owner",
          domain: "travel",
          scope_handle: "attr.travel.preferences.*",
          slice_name: "Travel preference summary",
          duration_days: 3,
        },
      },
      {
        type: "marketplace_request",
        category: "travel",
        source: "marketplace_access_request",
      },
    ),
    fixtureEntry(
      {
        id: "preview-financial-decisions",
        request_id: "preview-financial-decisions",
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        scope: "attr.financial.decisions.*",
        scope_description: "Previous financial decisions and rationale",
        counterpart_type: "developer",
        counterpart_id: "long-form-decision-workspace",
        counterpart_label:
          "Comprehensive Multi-Institution Financial Decision Review and Planning Workspace",
        counterpart_email: "privacy@decision-workspace.example",
        counterpart_secondary_label:
          "A long requester identity used to validate responsive wrapping and badge alignment",
        issued_at: hoursAgo(now, 9),
        expires_at: hoursFrom(now, 87),
        reason:
          "Compare previous decisions with the current plan while keeping the raw source information private and limiting use to this single review.",
        metadata: {
          request_source: "developer_api",
          expiry_hours: 96,
          refresh_policy: "snapshot",
        },
      },
      {
        type: "long_copy_request",
        category: "financial_decisions",
        source: "developer_api",
        shape: "long_copy",
      },
    ),
  ];
}

function locationGrant(
  now: number,
  id: string,
  label: string,
  shareKind: "share" | "check_in" | "sos" | "public_invite",
  issuedHoursAgo: number,
): ConsentCenterEntry {
  return fixtureEntry(
    {
      id: `one_location_grant:${id}`,
      kind: "active_grant",
      status: "active",
      active: true,
      granted: true,
      action: "CONSENT_GRANTED",
      scope: "cap.location.live.view",
      scope_description:
        shareKind === "public_invite"
          ? "Public location link"
          : "Live location sharing",
      counterpart_type: shareKind === "public_invite" ? "self" : "investor",
      counterpart_id: `preview-${id}`,
      counterpart_label: label,
      counterpart_email:
        shareKind === "public_invite" ? null : `${id}@example.test`,
      counterpart_secondary_label:
        shareKind === "public_invite" ? "Anyone with the private link" : null,
      issued_at: hoursAgo(now, issuedHoursAgo),
      expires_at: hoursFrom(now, shareKind === "sos" ? 1 : 20),
      request_url:
        shareKind === "public_invite" ? "/one/location?section=activity" : null,
      metadata: {
        request_source:
          shareKind === "public_invite"
            ? "one_location_public_invite"
            : "one_location_share_grant",
        grant_id: id,
        requester_label: label,
        duration_label: shareKind === "sos" ? "1 hour" : "24 hours",
        share_kind: shareKind,
        share_message:
          shareKind === "sos"
            ? "I need help getting home safely."
            : shareKind === "check_in"
              ? "Checking in after arrival."
              : null,
        section: shareKind === "public_invite" ? "activity" : "shared",
      },
    },
    {
      type: `location_${shareKind}_grant`,
      category: "location",
      source:
        shareKind === "public_invite"
          ? "one_location_public_invite"
          : "one_location_share_grant",
    },
  );
}

function buildActiveAnchors(now: number): ConsentCenterEntry[] {
  return [
    fixtureEntry(
      {
        id: "preview-active-null-description",
        request_id: "preview-active-null-description",
        kind: "active_grant",
        status: "active",
        active: true,
        granted: true,
        action: "CONSENT_GRANTED",
        scope: "attr.health.wellness_preferences.*",
        scope_description: null,
        counterpart_type: "developer",
        counterpart_id: "wellbeing-companion",
        counterpart_label: "Wellbeing Companion",
        issued_at: hoursAgo(now, 10),
        expires_at: hoursFrom(now, 38),
        metadata: {
          request_source: "developer_api",
          refresh_policy: "snapshot",
        },
      },
      {
        type: "null_description_grant",
        category: "health_wellness",
        source: "developer_api",
        shape: "sparse",
      },
    ),
    fixtureEntry(
      {
        id: "preview-active-long-label",
        request_id: "preview-active-long-label",
        kind: "active_grant",
        status: "approved",
        active: true,
        granted: true,
        action: "CONSENT_GRANTED",
        scope: "attr.financial.documents.*",
        scope_description: "Financial statements and supporting documents",
        counterpart_type: "developer",
        counterpart_id: "long-active-workspace",
        counterpart_label:
          "Cross-Border Financial Documentation Consolidation and Verification Workspace",
        counterpart_email: "privacy@cross-border-documents.example",
        counterpart_secondary_label:
          "Long labels and supporting text should wrap cleanly on every breakpoint",
        issued_at: hoursAgo(now, 11),
        expires_at: hoursFrom(now, 157),
        reason:
          "Maintain a seven-day document snapshot for a scheduled verification.",
        metadata: {
          request_source: "developer_api",
          refresh_policy: "snapshot",
        },
      },
      {
        type: "long_copy_grant",
        category: "financial_documents",
        source: "developer_api",
        shape: "long_copy",
      },
    ),
    fixtureEntry(
      {
        id: "preview-email-kyc-active",
        request_id: "preview-email-kyc-active",
        kind: "active_grant",
        status: "granted",
        active: true,
        granted: true,
        action: "CONSENT_GRANTED",
        scope: "attr.identity.name",
        scope_description: "Verified name",
        counterpart_type: "developer",
        counterpart_id: "agent_kyc",
        counterpart_label: "One",
        counterpart_email: "one@hushh.ai",
        issued_at: hoursAgo(now, 12),
        expires_at: hoursFrom(now, 12),
        request_url: "/one/kyc?workflowId=preview-email-active",
        metadata: {
          request_source: "one_email_kyc_v1",
          workflow_id: "preview-email-active",
          gmail_thread_id: "preview-email-active-thread",
          required_fields: ["full_name"],
        },
      },
      {
        type: "email_kyc_grant",
        category: "kyc_identity",
        source: "one_email_kyc_v1",
      },
    ),
    fixtureEntry(
      {
        id: "preview-ria-active",
        request_id: "preview-ria-active",
        kind: "active_grant",
        status: "approved",
        active: true,
        granted: true,
        action: "CONSENT_GRANTED",
        scope: "attr.financial.profile.*",
        scope_description: "Financial profile",
        counterpart_type: "ria",
        counterpart_id: "harbor-advisory",
        counterpart_label: "Harbor Advisory",
        counterpart_email: "team@harbor.example",
        counterpart_secondary_label: "Registered investment advisor",
        issued_at: hoursAgo(now, 13),
        expires_at: hoursFrom(now, 155),
        metadata: {
          request_source: "ria_iam",
          refresh_policy: "continuous_until_expiry",
        },
      },
      {
        type: "ria_active_grant",
        category: "financial_profile",
        source: "ria_iam",
      },
    ),
    locationGrant(now, "location-share", "Kabir Rao", "share", 0.5),
    locationGrant(now, "location-check-in", "Maya Singh", "check_in", 0.75),
    locationGrant(now, "location-sos", "Emergency contact", "sos", 0.1),
    locationGrant(
      now,
      "location-public",
      "Weekend meetup link",
      "public_invite",
      4,
    ),
    fixtureEntry(
      {
        id: "marketplace_request:preview-marketplace-active",
        request_id: "preview-marketplace-active",
        kind: "active_grant",
        status: "approved",
        active: true,
        granted: true,
        action: "CONSENT_GRANTED",
        scope: "attr.shopping.preferences.*",
        scope_description: "Shopping preference summary",
        counterpart_type: "investor",
        counterpart_id: "meridian-market",
        counterpart_label: "Meridian Market",
        counterpart_email: "privacy@meridian.example",
        issued_at: hoursAgo(now, 36),
        expires_at: null,
        metadata: {
          request_source: "marketplace_access_request",
          request_id: "preview-marketplace-active",
          role: "owner",
          domain: "shopping",
          scope_handle: "attr.shopping.preferences.*",
          slice_name: "Shopping preference summary",
        },
      },
      {
        type: "marketplace_active_grant",
        category: "shopping",
        source: "marketplace_access_request",
        shape: "sparse",
      },
    ),
  ];
}

function groupedHistory(
  now: number,
  kind: "developer" | "ria",
): ConsentCenterEntry {
  const isRia = kind === "ria";
  const counterpartId = isRia ? "harbor-advisory" : "developer-lifecycle";
  const label = isRia ? "Harbor Advisory" : "Developer Lifecycle Lab";
  const profileScope = isRia
    ? "attr.financial.profile.risk_tolerance"
    : "attr.identity.contact.*";
  const secondScope = isRia
    ? "attr.financial.portfolio.*"
    : "attr.professional.employment.*";
  return fixtureEntry(
    {
      id: `preview-history-grouped-${kind}`,
      kind: "history",
      status: isRia ? "approved" : "revoked",
      action: "CONSENT_HISTORY",
      counterpart_type: isRia ? "ria" : "developer",
      counterpart_id: counterpartId,
      counterpart_label: label,
      counterpart_email: isRia
        ? "team@harbor.example"
        : "privacy@lifecycle.example",
      counterpart_secondary_label: isRia
        ? "Registered investment advisor"
        : "Includes requested, granted, read, and revoked events",
      identifier_key: `${kind}:${counterpartId}`,
      identifier_label: label,
      trail_count: 2,
      event_count: isRia ? 5 : 4,
      issued_at: hoursAgo(now, isRia ? 6 : 16),
      identifier_request_ids: [
        `preview-${kind}-profile`,
        `preview-${kind}-secondary`,
      ],
      consent_trails: [
        {
          id: `preview-${kind}-profile`,
          trail_key: `${kind}-profile`,
          scope: profileScope,
          scope_description: isRia
            ? "Risk tolerance assessment"
            : "Contact details",
          status: isRia ? "approved" : "revoked",
          action: isRia ? "CONSENT_GRANTED" : "REVOKED",
          issued_at: hoursAgo(now, isRia ? 6 : 16),
          expires_at: isRia ? hoursFrom(now, 162) : hoursAgo(now, 4),
          latest_request_id: `preview-${kind}-profile`,
          request_ids: [`preview-${kind}-profile`],
          event_count: isRia ? 2 : 3,
          events: [
            {
              id: `preview-${kind}-requested`,
              request_id: `preview-${kind}-profile`,
              status: "pending",
              action: "REQUESTED",
              issued_at: hoursAgo(now, 20),
              scope: profileScope,
              scope_description: isRia
                ? "Risk tolerance assessment"
                : "Contact details",
            },
            {
              id: `preview-${kind}-granted`,
              request_id: `preview-${kind}-profile`,
              status: "approved",
              action: "CONSENT_GRANTED",
              issued_at: hoursAgo(now, 18),
              scope: profileScope,
              scope_description: isRia
                ? "Risk tolerance assessment"
                : "Contact details",
            },
            ...(!isRia
              ? [
                  {
                    id: "preview-developer-read",
                    request_id: "nested-history-read-request",
                    status: "read",
                    action: "READ",
                    issued_at: hoursAgo(now, 17),
                    scope: profileScope,
                    scope_description: "Encrypted export read",
                  },
                  {
                    id: "preview-developer-revoked",
                    request_id: "preview-developer-profile",
                    status: "revoked",
                    action: "REVOKED",
                    issued_at: hoursAgo(now, 4),
                    scope: profileScope,
                    scope_description: "Contact details",
                  },
                ]
              : []),
          ],
        },
        {
          id: `preview-${kind}-secondary`,
          trail_key: `${kind}-secondary`,
          scope: secondScope,
          scope_description: isRia
            ? "Portfolio positions and allocation"
            : "Employment details",
          status: isRia ? "revoked" : "denied",
          action: isRia ? "REVOKED" : "CONSENT_DENIED",
          issued_at: hoursAgo(now, 72),
          expires_at: hoursAgo(now, 24),
          latest_request_id: `preview-${kind}-secondary`,
          request_ids: [`preview-${kind}-secondary`],
          event_count: isRia ? 3 : 1,
          events: [
            {
              id: `preview-${kind}-secondary-event`,
              request_id: `preview-${kind}-secondary`,
              status: isRia ? "revoked" : "denied",
              action: isRia ? "REVOKED" : "CONSENT_DENIED",
              issued_at: hoursAgo(now, 24),
              scope: secondScope,
              scope_description: isRia
                ? "Portfolio positions and allocation"
                : "Employment details",
            },
          ],
        },
      ],
      metadata: {
        request_source: isRia ? "ria_iam" : "consent_ledger",
      },
    },
    {
      type: `grouped_${kind}_history`,
      category: isRia ? "portfolio" : "developer_api",
      source: isRia ? "ria_iam" : "consent_ledger",
    },
  );
}

function simpleHistory(
  now: number,
  options: {
    id: string;
    status: string;
    action: string;
    scope: string;
    description: string;
    label: string;
    category: string;
    source: string;
    hoursAgo: number;
    counterpartType?: "ria" | "investor" | "developer" | "self";
    metadata?: Record<string, unknown>;
  },
) {
  return fixtureEntry(
    {
      id: options.id,
      request_id: options.id,
      kind: "history",
      status: options.status,
      action: options.action,
      scope: options.scope,
      scope_description: options.description,
      counterpart_type: options.counterpartType || "developer",
      counterpart_id: `${options.id}-counterpart`,
      counterpart_label: options.label,
      counterpart_email: `${options.category.replace(/_/g, "-")}@fixtures.example`,
      issued_at: hoursAgo(now, options.hoursAgo),
      expires_at: hoursAgo(now, Math.max(1, options.hoursAgo - 1)),
      reason: `Recorded ${options.status} consent lifecycle.`,
      metadata: {
        request_source: options.source,
        ...(options.metadata || {}),
      },
    },
    {
      type: `${options.source}_${options.status}_history`,
      category: options.category,
      source: options.source,
    },
  );
}

function buildPreviousAnchors(now: number): ConsentCenterEntry[] {
  return [
    groupedHistory(now, "developer"),
    groupedHistory(now, "ria"),
    simpleHistory(now, {
      id: "preview-history-kyc-denied",
      status: "denied",
      action: "CONSENT_DENIED",
      scope: "attr.identity.bank.*",
      description: "Bank identity and verification fields",
      label: "One",
      category: "kyc_bank",
      source: "one_email_kyc_v1",
      hoursAgo: 30,
      metadata: {
        workflow_id: "preview-kyc-denied",
        gmail_thread_id: "preview-thread-denied",
      },
    }),
    simpleHistory(now, {
      id: "preview-history-cancelled",
      status: "cancelled",
      action: "CANCELLED",
      scope: "attr.travel.itinerary.*",
      description: "Travel itinerary summary",
      label: "Journey Organizer",
      category: "travel",
      source: "developer_api",
      hoursAgo: 54,
    }),
    simpleHistory(now, {
      id: "preview-history-timeout",
      status: "expired",
      action: "TIMEOUT",
      scope: "attr.health.metrics.*",
      description: "Health measurements and trends",
      label: "Health Metrics",
      category: "health_metrics",
      source: "consent_ledger",
      hoursAgo: 62,
    }),
    simpleHistory(now, {
      id: "one_location_grant:preview-history-revoked",
      status: "revoked",
      action: "REVOKED",
      scope: "cap.location.live.view",
      description: "Live location sharing",
      label: "Zoya Khan",
      category: "location",
      source: "one_location_share_grant",
      counterpartType: "investor",
      hoursAgo: 48,
      metadata: {
        grant_id: "preview-history-revoked",
        share_kind: "check_in",
        duration_label: "30 minutes",
      },
    }),
    simpleHistory(now, {
      id: "one_location_grant:preview-history-expired",
      status: "expired",
      action: "TIMEOUT",
      scope: "cap.location.live.view",
      description: "Live location sharing",
      label: "Dev Patel",
      category: "location",
      source: "one_location_share_grant",
      counterpartType: "investor",
      hoursAgo: 72,
      metadata: {
        grant_id: "preview-history-expired",
        share_kind: "share",
        duration_label: "24 hours",
      },
    }),
    simpleHistory(now, {
      id: "marketplace_request:preview-history-owner-denied",
      status: "denied",
      action: "CONSENT_DENIED",
      scope: "attr.entertainment.preferences.*",
      description: "Entertainment preference summary",
      label: "Studio Signal",
      category: "entertainment",
      source: "marketplace_access_request",
      counterpartType: "investor",
      hoursAgo: 80,
      metadata: {
        role: "owner",
        domain: "entertainment",
        scope_handle: "attr.entertainment.preferences.*",
      },
    }),
    simpleHistory(now, {
      id: "marketplace_request:preview-history-buyer-expired",
      status: "expired",
      action: "TIMEOUT",
      scope: "attr.shopping.preferences.*",
      description: "Shopping preference summary",
      label: "Archived Marketplace Purchase",
      category: "shopping",
      source: "marketplace_access_request",
      counterpartType: "investor",
      hoursAgo: 96,
      metadata: {
        role: "buyer",
        domain: "shopping",
        scope_handle: "attr.shopping.preferences.*",
      },
    }),
  ];
}

function buildPreviewState(now = Date.now()): LocalConsentPreviewState {
  const pending = newestFirst([
    ...buildPendingAnchors(now),
    ...buildDensityEntries("pending", now),
  ]);
  const active = newestFirst([
    ...buildActiveAnchors(now),
    ...buildDensityEntries("active", now),
  ]);
  const previous = newestFirst([
    ...buildPreviousAnchors(now),
    ...buildDensityEntries("previous", now),
  ]);

  if (
    pending.length !== FIXTURE_PAGE_TOTAL ||
    active.length !== FIXTURE_PAGE_TOTAL ||
    previous.length !== FIXTURE_PAGE_TOTAL
  ) {
    throw new Error("Consent preview fixture must keep 21 rows per surface");
  }
  return { pending, active, previous };
}

function getState() {
  previewState ??= buildPreviewState();
  return previewState;
}

export function resetLocalConsentPreviewState(now = Date.now()) {
  previewState = buildPreviewState(now);
}

export function getLocalConsentPreviewSummary(
  userId: string,
  actor: ConsentCenterActor = "investor",
): ConsentCenterPageSummary {
  const state = getState();
  return {
    user_id: userId,
    actor,
    mode: "consents",
    counts: {
      pending: state.pending.length,
      active: state.active.length,
      previous: state.previous.length,
    },
  };
}

function entrySearchText(entry: ConsentCenterEntry) {
  // The real list endpoint searches identifiers and nested lifecycle events in
  // addition to visible labels. JSON traversal keeps the deterministic fixture
  // aligned with that behavior without maintaining a second field allowlist.
  return JSON.stringify(entry).toLowerCase();
}

export function getLocalConsentPreviewList({
  userId,
  actor = "investor",
  surface,
  q = "",
  page = 1,
  limit = 20,
}: {
  userId: string;
  actor?: ConsentCenterActor;
  surface: PreviewSurface;
  q?: string;
  page?: number;
  limit?: number;
}): ConsentCenterPageListResponse {
  const normalizedQuery = q.trim().toLowerCase();
  const source = getState()[surface];
  const filtered = normalizedQuery
    ? source.filter((entry) => entrySearchText(entry).includes(normalizedQuery))
    : source;
  const safePage = Math.max(1, page);
  const safeLimit = Math.max(1, limit);
  const start = (safePage - 1) * safeLimit;
  return {
    user_id: userId,
    actor,
    mode: "consents",
    surface,
    query: q,
    page: safePage,
    limit: safeLimit,
    total: filtered.length,
    has_more: start + safeLimit < filtered.length,
    items: filtered.slice(start, start + safeLimit),
  };
}

export function getLocalConsentPreviewLookup(
  requestIds: string[],
): PendingConsentLookupResponse {
  const pending = getState().pending;
  const requested = new Set(requestIds);
  const matching = pending.filter(
    (entry) => requested.has(entry.request_id || "") || requested.has(entry.id),
  );
  const found = new Set(matching.map((entry) => entry.request_id || entry.id));
  return {
    items: matching.map((entry) => ({
      request_id: entry.request_id || entry.id,
      developer: entry.counterpart_label,
      agent_id: entry.counterpart_id,
      requester_label: entry.counterpart_label,
      requester_image_url: entry.counterpart_image_url,
      requester_website_url: entry.counterpart_website_url,
      scope: entry.scope || "",
      scope_description: entry.scope_description,
      poll_timeout_at: entry.approval_timeout_at || entry.expires_at,
      issued_at: entry.issued_at,
      request_url: entry.request_url,
      reason: entry.reason,
      metadata: entry.metadata,
      bundle_id:
        typeof entry.metadata?.bundle_id === "string"
          ? entry.metadata.bundle_id
          : null,
      bundle_label:
        typeof entry.metadata?.bundle_label === "string"
          ? entry.metadata.bundle_label
          : null,
      is_scope_upgrade: entry.is_scope_upgrade,
      existing_granted_scopes: entry.existing_granted_scopes,
      additional_access_summary: entry.additional_access_summary,
    })),
    missing_request_ids: requestIds.filter((requestId) => !found.has(requestId)),
  };
}

export function getLocalConsentPreviewHandshakeHistory({
  userId,
  counterpartId,
  actor = "investor",
  page = 1,
  limit = 50,
}: {
  userId: string;
  counterpartId: string;
  actor?: ConsentCenterActor;
  page?: number;
  limit?: number;
}): HandshakeHistoryResponse {
  const timeline = newestFirst([
    ...getState().pending,
    ...getState().active,
    ...getState().previous,
  ])
    .filter((entry) => entry.counterpart_id === counterpartId)
    .map((entry) => ({
      id: entry.id,
      action: entry.action,
      status: entry.status,
      scope: entry.scope,
      scope_description: entry.scope_description,
      issued_at: entry.issued_at,
      expires_at: entry.expires_at,
      request_id: entry.request_id,
      actor,
      counterpart_id: counterpartId,
      metadata: entry.metadata,
    }));
  const safePage = Math.max(1, page);
  const safeLimit = Math.max(1, limit);
  const start = (safePage - 1) * safeLimit;
  return {
    user_id: userId,
    counterpart_id: counterpartId,
    actor,
    page: safePage,
    limit: safeLimit,
    total: timeline.length,
    has_more: start + safeLimit < timeline.length,
    timeline: timeline.slice(start, start + safeLimit),
  };
}

export function applyLocalConsentPreviewMutation({
  action,
  entry,
  durationHours,
}: {
  action: PreviewMutationAction;
  entry: ConsentCenterEntry;
  durationHours?: number;
}) {
  const state = getState();
  const requestId = entry.request_id || entry.id;
  const now = Date.now();

  if (action === "approve") {
    state.pending = state.pending.filter(
      (candidate) => (candidate.request_id || candidate.id) !== requestId,
    );
    state.active = newestFirst([
      fixtureEntry(
        {
          ...entry,
          id: entry.id.replace(
            "one_location_request:",
            "one_location_grant:",
          ),
          kind: "active_grant",
          status: "active",
          active: true,
          granted: true,
          action: "CONSENT_GRANTED",
          issued_at: new Date(now).toISOString(),
          expires_at: hoursFrom(now, durationHours || 24),
        },
        {
          type: String(
            entry.metadata?.fixture_type || "approved_preview_request",
          ),
          category: String(entry.metadata?.fixture_category || "other"),
          source: String(entry.metadata?.fixture_source || "preview_mutation"),
        },
      ),
      ...state.active,
    ]);
  } else if (action === "deny") {
    state.pending = state.pending.filter(
      (candidate) => (candidate.request_id || candidate.id) !== requestId,
    );
    state.previous = newestFirst([
      {
        ...entry,
        kind: "history",
        status: "denied",
        active: false,
        granted: false,
        action: "CONSENT_DENIED",
        expires_at: new Date(now).toISOString(),
      },
      ...state.previous,
    ]);
  } else {
    state.active = state.active.filter((candidate) => candidate.id !== entry.id);
    state.previous = newestFirst([
      {
        ...entry,
        kind: "history",
        status: "revoked",
        active: false,
        granted: false,
        action: "REVOKED",
        expires_at: new Date(now).toISOString(),
      },
      ...state.previous,
    ]);
  }

  return {
    action,
    requestId,
    scope: entry.scope || undefined,
    source: "local_consent_preview",
  } as const;
}

export function revokeLocalConsentPreviewScope(scope: string) {
  const state = getState();
  const active = state.active.find((entry) => entry.scope === scope);
  if (active) {
    return applyLocalConsentPreviewMutation({
      action: "revoke",
      entry: active,
    });
  }

  const now = new Date().toISOString();
  state.previous = state.previous.map((entry) => ({
    ...entry,
    consent_trails: entry.consent_trails?.map((trail) =>
      trail.scope === scope &&
      ["active", "approved", "granted"].includes(trail.status || "")
        ? {
            ...trail,
            status: "revoked",
            action: "REVOKED",
            expires_at: now,
            events: [
              ...(trail.events || []),
              {
                id: `preview-scope-revoked-${scope}`,
                request_id: trail.latest_request_id,
                status: "revoked",
                action: "REVOKED",
                issued_at: now,
                expires_at: now,
                scope,
                scope_description: trail.scope_description,
              },
            ],
          }
        : trail,
    ),
  }));
  return {
    action: "revoke" as const,
    scope,
    source: "local_consent_preview",
  };
}
