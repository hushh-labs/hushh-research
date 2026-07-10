import {
  ChartNoAxesCombined,
  Database,
  FolderSearch,
  Mail,
  MailCheck,
  MapPin,
  ShieldCheck,
  Store,
  type LucideIcon,
} from "lucide-react";

import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { ROUTES } from "@/lib/navigation/routes";

/**
 * SHARED ONE CAPABILITY CATALOG — single source of truth.
 *
 * These are the capabilities One actually exposes on the `/one` dashboard.
 * Both the dashboard tiles (`components/dashboard/one-dashboard-page.tsx`
 * `buildModes()`) and the pre-auth "what lies ahead" carousel
 * (`components/onboarding/previews/WorkflowsPreviewCompact.tsx`) MUST read
 * from this catalog so a brand-new joiner previews exactly what they'll
 * unlock — no drift between the marketing preview and the real product.
 *
 * Per-tile runtime STATUS (Ready / Setup needed / N pending) is NOT encoded
 * here — that is resolved live by the dashboard from onboarding/consent state.
 * This catalog carries only the stable identity of each capability.
 */

export type OneCapabilityTone =
  | "finance"
  | "ria"
  | "gmail"
  | "email"
  | "location"
  | "pkm"
  | "consent"
  | "connected";

export type OneCapabilityGroup = "workflow" | "memory" | "access";

export interface OneCapability {
  id: string;
  /**
   * Backend agent lane this tile is bound to, or null when the tile is a
   * pure access/preview surface with no agent behind it (consent center,
   * marketplace preview) or the lane does not exist yet (gmail).
   *
   * This is a CONTRACT, not a comment: ids must exist in the backend
   * SPECIALIST_A2A_SCOPE_MAP and are enforced by
   * consent-protocol/scripts/verify_agent_hierarchy_contract.py.
   */
  agentId: string | null;
  title: string;
  /** Plain-language, rookie-safe description of what this capability does. */
  description: string;
  /**
   * Short (≤ ~24 char) label for the cramped onboarding preview rows, where the
   * full `description` would truncate mid-word. Falls back to `description`.
   */
  previewLabel?: string;
  href: string;
  icon: LucideIcon;
  tone: OneCapabilityTone;
  group: OneCapabilityGroup;
  /**
   * True when this capability collects NOTHING from the user — there is no data
   * to enter or connection to authorize, the tab is usable as soon as it opens.
   * Such capabilities are "set up" by taking a one-time look (an Explore tour)
   * rather than by a configuration step. The resolver treats them as
   * `not-started` ("Explore") until the person has explored them once, then
   * `completed` ("Explored"). This keeps the "N of M ready" count honest: an
   * un-explored tab is genuinely "left to set up", never a fabricated "Ready".
   */
  isExploreOnly?: boolean;
  /**
   * True when this capability's real workspace reads or writes vault-backed
   * personal data and therefore needs an UNLOCKED vault to be usable. The setup
   * STEP itself collects nothing and renders pre-vault; this flag only lets the
   * step set honest "you'll unlock your vault next" expectations and lets the
   * destination's own guard own the actual unlock prompt. Consent is
   * the only capability that does not read vault-backed data here.
   */
  requiresVault?: boolean;
}

/**
 * Canonical, ordered list of One's capabilities. Order mirrors the dashboard.
 */
export const ONE_CAPABILITIES: readonly OneCapability[] = [
  {
    id: "finance",
    agentId: "agent_kai",
    // Public agent name is "Finance" (renamed back from a brief "Investor"
    // pass). Kai remains the internal finance runtime naming: id, routes,
    // contracts, and code identifiers unchanged.
    title: "Finance",
    description: "Market, portfolio, analysis, and RIA handoff.",
    previewLabel: "Market, portfolio & analysis",
    href: ROUTES.KAI_HOME,
    icon: ChartNoAxesCombined,
    tone: "finance",
    group: "workflow",
    requiresVault: true,
  },
  {
    id: "gmail",
    agentId: "agent_gmail",
    title: "Gmail",
    description: "Receipt sync and purchase-memory review.",
    previewLabel: "Receipt & purchase memory",
    href: ROUTES.GMAIL,
    icon: Mail,
    tone: "gmail",
    group: "memory",
    requiresVault: true,
  },
  {
    id: "email",
    agentId: "agent_email",
    title: "Email",
    description: "Approval drafts and client request workflows.",
    href: ROUTES.ONE_KYC,
    icon: MailCheck,
    tone: "email",
    group: "workflow",
    requiresVault: true,
  },
  {
    id: "location",
    agentId: "agent_location",
    title: "Location",
    description: "Live sharing, referrals, and local context.",
    previewLabel: "Live sharing & local context",
    href: ROUTES.ONE_LOCATION,
    icon: MapPin,
    tone: "location",
    group: "workflow",
    requiresVault: true,
  },
  {
    id: "pkm",
    agentId: "agent_personal_information",
    title: "Memory",
    description: "Saved knowledge and context you can review.",
    href: ROUTES.PKM,
    icon: FolderSearch,
    tone: "pkm",
    group: "memory",
    requiresVault: true,
  },
  {
    id: "consent",
    // Nav owns the consent center: approvals, revocations, and the
    // Connections tab (trusted connections are Nav's domain too).
    agentId: "agent_nav",
    title: "Consent",
    description: "Access requests, approvals, and revocations.",
    href: buildConsentCenterHref("pending"),
    icon: ShieldCheck,
    tone: "consent",
    group: "access",
    isExploreOnly: true,
  },
  {
    id: "marketplace",
    // Preview surface only today; no roster agent behind it.
    agentId: null,
    title: "Information Marketplace",
    description: "Preview priced slices of your data you could publish.",
    previewLabel: "Priced data slices",
    href: ROUTES.ONE_MARKETPLACE,
    icon: Store,
    tone: "pkm",
    group: "access",
    isExploreOnly: true,
  },
  {
    id: "connected-systems",
    agentId: "agent_connected_systems",
    title: "Connected Systems",
    description: "Approved CRM reads and writes.",
    href: ROUTES.CONNECTED_SYSTEMS,
    icon: Database,
    tone: "connected",
    group: "workflow",
    requiresVault: true,
  },
] as const;

/** Lookup a capability by id. */
export function getOneCapability(id: string): OneCapability | undefined {
  return ONE_CAPABILITIES.find((c) => c.id === id);
}

/**
 * Tailwind classes for a capability's icon chip, keyed by tone.
 *
 * Each tone gets its own fixed, mid-lightness brand color — the same hex in
 * both themes, so the tile stays recognizable at a glance regardless of
 * appearance mode. Only the glyph color flips for contrast: white in light
 * mode (the tile reads as a solid color chip against the light page), ink
 * (near-black) in dark mode (the same chip now reads as a lighter accent
 * against the dark page, so a dark glyph is what stays legible).
 * Shared so the dashboard tile, the topbar/menu chip, and the onboarding
 * preview render identically.
 */
// Class strings are written out in full (not built from a hex variable) so
// Tailwind's static content scanner can find and generate each utility.
export const ONE_CAPABILITY_ICON_CLASS_BY_TONE: Record<OneCapabilityTone, string> = {
  // One color guidelines — soft premium palette (see the "One — Color
  // Guidelines" spec). Each tone maps to its named token.
  // Finance: Lavender Mist.
  finance: "bg-[#B85CF6] text-white dark:text-[#1d1d1f]",
  // RIA: Sky Blue.
  ria: "bg-[#60A5FA] text-white dark:text-[#1d1d1f]",
  // Gmail renders its own full-color brand mark (see GmailBrandIcon) on a clean
  // Cloud White tile, so the logo's colors read cleanly.
  gmail: "bg-white text-[#1d1d1f]",
  // Email: Mint Teal.
  email: "bg-[#14B8A6] text-white dark:text-[#1d1d1f]",
  // Location: Sage Green.
  location: "bg-[#A7D7A1] text-white dark:text-[#1d1d1f]",
  // Memory (saved knowledge) + Information Marketplace preview: Lavender Mist.
  pkm: "bg-[#B85CF6] text-white dark:text-[#1d1d1f]",
  // Consent: Warm Gold (matches the shield motif).
  consent: "bg-[#C8923A] text-white dark:text-[#1d1d1f]",
  // Connected Systems: Slate Blue-Gray.
  connected: "bg-[#94A3B8] text-white dark:text-[#1d1d1f]",
};
