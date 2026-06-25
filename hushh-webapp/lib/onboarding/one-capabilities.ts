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
  },
  {
    id: "email",
    title: "Email",
    description: "Approval drafts and client request workflows.",
    href: ROUTES.ONE_KYC,
    icon: MailCheck,
    tone: "email",
    group: "workflow",
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
  },
  {
    id: "pkm",
    title: "Personal Data",
    description: "Saved knowledge and information you can review.",
    href: ROUTES.PKM,
    icon: FolderSearch,
    tone: "pkm",
    group: "memory",
  },
  {
    id: "consent",
    title: "Consent Guardian",
    description: "Access requests, approvals, and revocations.",
    href: buildConsentCenterHref("pending"),
    icon: ShieldCheck,
    tone: "consent",
    group: "access",
  },
  {
    id: "connected-systems",
    title: "Connected Systems",
    description: "Approved CRM reads and writes.",
    href: ROUTES.CONNECTED_SYSTEMS,
    icon: Database,
    tone: "connected",
    group: "workflow",
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
  email: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  location: "bg-teal-500/12 text-teal-700 dark:text-teal-300",
  pkm: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  consent: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  connected: "bg-cyan-500/12 text-cyan-700 dark:text-cyan-300",
};
