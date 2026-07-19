
import {
  BookMarked,
  ContactRound,
  FileCheck2,
  KeyRound,
  Landmark,
  Mail,
  MapPin,
  Store,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { ROUTES } from "@/lib/navigation/routes";
import {
  ONE_SETUP_CAPABILITY_IDS,
  type OneSetupCapabilityId,
} from "@/lib/onboarding/setup-capability-ids";

export {
  ONE_SETUP_CAPABILITY_IDS,
  type OneSetupCapabilityId,
} from "@/lib/onboarding/setup-capability-ids";

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

export type OneCapabilityIcon =
  | { kind: "lucide"; icon: LucideIcon }
  | { kind: "image"; src: string; alt: string };

export function lucideCapabilityIcon(icon: LucideIcon): OneCapabilityIcon {
  return { kind: "lucide", icon };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function imageCapabilityIcon(src: string, alt: string): OneCapabilityIcon {
  return { kind: "image", src, alt };
}

export interface OneCapability {
  id: string;
  /** Stable generated action identity when this capability is in onboarding. */
  setupActionId?: `setup.open_${string}`;
  /** Stable control correlation id when this capability is in onboarding. */
  setupControlId?: `one_setup_tile_${string}`;
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
  /** Hide this capability from the primary One agent roster while its route remains available. */
  isVisibleOnRoster?: boolean;
  href: string;
  icon: OneCapabilityIcon;
  tone: OneCapabilityTone;
  group: OneCapabilityGroup;
  /** A paused surface remains route-addressable but is omitted from One setup and navigation. */
  availability?: "enabled" | "paused";
  /**
   * True when this capability collects NOTHING from the user — there is no information
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
   * personal information and therefore needs an UNLOCKED vault to be usable. The setup
   * STEP itself collects nothing and renders pre-vault; this flag only lets the
   * step set honest "you'll set up your vault when it is needed" expectations.
   * The destination owns a contextual vault prerequisite or its own typed
   * continuation; it must not mount token-dependent work before that settles.
   * Consent is
   * the only capability that does not read vault-backed information here.
   */
  requiresVault?: boolean;
}

/**
 * Canonical, ordered list of One's capabilities. Order mirrors the dashboard.
 */
export const ONE_CAPABILITIES: readonly OneCapability[] = [
  {
    id: "finance",
    setupActionId: "setup.open_finance",
    setupControlId: "one_setup_tile_finance",
    agentId: "agent_kai",
    // Public agent name is "Finance" (renamed back from a brief "Investor"
    // pass). Kai remains the internal finance runtime naming: id, routes,
    // contracts, and code identifiers unchanged.
    title: "Finance",
    description: "Market, portfolio, analysis, and RIA handoff.",
    previewLabel: "Market, portfolio & analysis",
    href: ROUTES.KAI_HOME,
    icon: lucideCapabilityIcon(Landmark),
    tone: "finance",
    group: "workflow",
    requiresVault: true,
  },
  {
    id: "ria",
    setupActionId: "setup.open_ria",
    setupControlId: "one_setup_tile_ria",
    // RIA setup is an account/persona workflow owned by the existing RIA
    // onboarding route. It is not a separate product-agent delegation lane.
    agentId: null,
    title: "RIA",
    description: "Advisor verification, profile, clients, and requests.",
    previewLabel: "Advisor profile & verification",
    href: ROUTES.RIA_ONBOARDING,
    icon: lucideCapabilityIcon(UsersRound),
    tone: "ria",
    group: "workflow",
    requiresVault: true,
  },
  {
    id: "gmail",
    setupActionId: "setup.open_gmail",
    setupControlId: "one_setup_tile_gmail",
    agentId: "agent_gmail",
    title: "Gmail",
    description: "Receipt sync and purchase-memory review.",
    previewLabel: "Receipt & purchase memory",
    href: ROUTES.GMAIL,
    icon: lucideCapabilityIcon(Mail),
    tone: "gmail",
    group: "memory",
    availability: "paused",
    requiresVault: true,
  },
  {
    id: "email",
    setupActionId: "setup.open_email",
    setupControlId: "one_setup_tile_email",
    agentId: "agent_email",
    title: "KYC",
    description: "Review information requests and approve each response.",
    href: ROUTES.ONE_KYC,
    icon: lucideCapabilityIcon(FileCheck2),
    tone: "email",
    group: "workflow",
    requiresVault: true,
  },
  {
    id: "location",
    setupActionId: "setup.open_location",
    setupControlId: "one_setup_tile_location",
    agentId: "agent_location",
    title: "Location",
    description: "Live location & Alerts",
    previewLabel: "Live location & Alerts",
    href: ROUTES.ONE_LOCATION,
    icon: lucideCapabilityIcon(MapPin),
    tone: "location",
    group: "workflow",
    requiresVault: true,
  },
  {
    id: "pkm",
    // Memory is a direct private-agent surface, not Marketplace delegation.
    agentId: null,
    title: "Memory",
    description: "Saved knowledge and context you can review.",
    href: ROUTES.PKM,
    icon: lucideCapabilityIcon(BookMarked),
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
    icon: lucideCapabilityIcon(KeyRound),
    tone: "consent",
    group: "access",
    isExploreOnly: true,
  },
  {
    id: "marketplace",
    // Preview surface only today; no roster agent behind it.
    agentId: null,
    title: "Information Marketplace",
    description:
      "Preview priced slices of your personal information you could publish.",
    previewLabel: "Priced information slices",
    href: ROUTES.ONE_MARKETPLACE,
    icon: lucideCapabilityIcon(Store),
    tone: "pkm",
    group: "access",
    isExploreOnly: true,
    isVisibleOnRoster: false,
  },
  {
    id: "connected-systems",
    setupActionId: "setup.open_connected_systems",
    setupControlId: "one_setup_tile_connected-systems",
    agentId: "agent_connected_systems",
    title: "CRM",
    description: "Approved CRM reads and writes.",
    href: ROUTES.CONNECTED_SYSTEMS,
    icon: lucideCapabilityIcon(ContactRound),
    tone: "connected",
    group: "workflow",
    requiresVault: true,
  },
] as const;

/**
 * The setup journey is intentionally narrower than the full One dashboard.
 * This order is product-authored and must not be re-ranked by status: people
 * should always see the same calm sequence while individual rows update.
 *
 * Memory and Consent remain available in One; they are not account-setup
 * requirements. Information Marketplace remains route-addressable but is not
 * shown in the primary agent roster while the surface is disabled.
 */
export type OneSetupCapability = OneCapability & {
  id: OneSetupCapabilityId;
  setupActionId: `setup.open_${string}`;
  setupControlId: `one_setup_tile_${string}`;
};

function requireOneCapability(id: OneSetupCapabilityId): OneSetupCapability {
  const capability = ONE_CAPABILITIES.find((candidate) => candidate.id === id);
  if (!capability?.setupActionId || !capability.setupControlId) {
    throw new Error(`Missing One setup capability: ${id}`);
  }
  return capability as OneSetupCapability;
}

export const ONE_SETUP_CAPABILITIES: readonly OneSetupCapability[] =
  ONE_SETUP_CAPABILITY_IDS.map(requireOneCapability).filter(
    (capability): capability is OneSetupCapability =>
      isOneCapabilityEnabled(capability),
  );

export function getOneSetupCapability(
  id: string,
): OneSetupCapability | undefined {
  return ONE_SETUP_CAPABILITIES.find((capability) => capability.id === id);
}

/** Lookup a capability by id. */
export function getOneCapability(id: string): OneCapability | undefined {
  return ONE_CAPABILITIES.find((c) => c.id === id);
}

/**
 * Tailwind classes for a capability's icon chip, keyed by tone.
 *
 * Each tone gets its own fixed, mid-lightness brand color — the same hex in
 * both themes, so the tile stays recognizable at a glance regardless of
 * appearance mode. The shared glyph contract is deliberately simple and
 * predictable: ink in light mode and white in dark mode, across the grid,
 * compact list, and top-menu surfaces.
 * Shared so the dashboard tile, the topbar/menu chip, and the onboarding
 * preview render identically.
 */
// Class strings are written out in full (not built from a hex variable) so
// Tailwind's static content scanner can find and generate each utility.
export const ONE_CAPABILITY_ICON_CLASS_BY_TONE: Record<
  OneCapabilityTone,
  string
> = {
  // One color guidelines — soft premium palette (see the "One — Color
  // Guidelines" spec). Each tone maps to its named token.
  // Finance: Lavender Mist.
  finance: "bg-[#B85CF6] text-[#1d1d1f] dark:text-white",
  // RIA: Sky Blue.
  ria: "bg-[#60A5FA] text-[#1d1d1f] dark:text-white",
  // Gmail renders its own full-color brand mark (see GmailBrandIcon) on a clean
  // Cloud White tile, so the logo's colors read cleanly.
  gmail: "bg-white text-[#1d1d1f]",
  // Email: Mint Teal.
  email: "bg-[#14B8A6] text-[#1d1d1f] dark:text-white",
  // Location: Sage Green.
  location: "bg-[#A7D7A1] text-[#1d1d1f] dark:text-white",
  // Memory (saved knowledge) + Information Marketplace preview: Lavender Mist.
  pkm: "bg-[#B85CF6] text-[#1d1d1f] dark:text-white",
  // Consent: Warm Gold (matches the shield motif).
  consent: "bg-[#C8923A] text-[#1d1d1f] dark:text-white",
  // Connected Systems: Slate Blue-Gray.
  connected: "bg-[#94A3B8] text-[#1d1d1f] dark:text-white",
};

export function isOneCapabilityEnabled(capability: OneCapability | string | undefined | null): boolean {
  const resolved =
    typeof capability === "string" ? getOneCapability(capability) : capability;
  return Boolean(
    resolved &&
      resolved.id !== "marketplace" &&
      resolved.availability !== "paused",
  );
}
