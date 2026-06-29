import {
  ChartNoAxesCombined,
  Database,
  FolderSearch,
  Mail,
  MailCheck,
  MapPin,
  ShieldCheck,
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
  | "gmail"
  | "email"
  | "location"
  | "pkm"
  | "consent"
  | "connected";

export type OneCapabilityGroup = "workflow" | "memory" | "access";

export interface OneCapability {
  id: string;
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
   * destination's own guard own the actual unlock prompt. Consent Guardian is
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
    title: "Finance",
    description: "Kai market, portfolio, analysis, and RIA handoff.",
    previewLabel: "Market, portfolio & analysis",
    href: ROUTES.KAI_HOME,
    icon: ChartNoAxesCombined,
    tone: "finance",
    group: "workflow",
    requiresVault: true,
  },
  {
    id: "gmail",
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
    title: "Personal Data",
    description: "Saved knowledge and information you can review.",
    href: ROUTES.PKM,
    icon: FolderSearch,
    tone: "pkm",
    group: "memory",
    requiresVault: true,
  },
  {
    id: "consent",
    title: "Consent Guardian",
    description: "Access requests, approvals, and revocations.",
    href: buildConsentCenterHref("pending"),
    icon: ShieldCheck,
    tone: "consent",
    group: "access",
    isExploreOnly: true,
  },
  {
    id: "connected-systems",
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
 * Shared so the dashboard tile and the onboarding preview render identically.
 */
export const ONE_CAPABILITY_ICON_CLASS_BY_TONE: Record<OneCapabilityTone, string> = {
  finance: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  gmail: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  email: "bg-accent-surface text-accent-strong",
  location: "bg-teal-500/12 text-teal-700 dark:text-teal-300",
  pkm: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  consent: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  connected: "bg-slate-500/12 text-slate-700 dark:text-slate-300",
};
