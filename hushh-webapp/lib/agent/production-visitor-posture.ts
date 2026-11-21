// SPDX-FileCopyrightText: 2026 Hushh
// SPDX-License-Identifier: Apache-2.0

import { resolveAppEnvironment } from "@/lib/app-env";
import {
  HUSHH_TECH_LAUNCH_PATH,
  ROUTES,
  isFoundationPublicRoute,
  isOneSetupSurfaceRoute,
  isRiaOnboardingRoute,
} from "@/lib/navigation/routes";

/** Concise visitor-facing disclaimer shown on Production Google Apps surfaces. */
export const GOOGLE_APPS_CLEARANCE_NOTE =
  "Google Apps (Gmail, Calendar, Drive) are undergoing Google clearance; public sign-in may be limited.";

const GOOGLE_BRANDS = new Set(["gmail", "drive", "calendar"]);
const GOOGLE_SOURCE_IDS = new Set([
  "agent_email",
  "agent_calendar",
  "agent_documents",
]);
const GOOGLE_EXPERIENCE_TYPES = new Set([
  "one.email_draft.v1",
  "one.gmail_mailbox_directive.v1",
  "one.gmail_todo_directive.v1",
  "one.drive_share_directive.v1",
  "one.drive_share_review.v1",
  "one.drive_bulk_share_review.v1",
]);
const GOOGLE_PROSE_PATTERN =
  /\b(gmail|google\s+calendar|google\s+drive|google\s+workspace|google\s+apps)\b/i;

function normalizePathname(value: string | null | undefined): string {
  const raw = (value || "/").split(/[?#]/, 1)[0]?.trim() || "/";
  return raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
}

export function isProductionVisitorPostureEnabled(): boolean {
  return resolveAppEnvironment() === "production";
}

export function turnInvolvesGoogleApps(input: {
  streamEvents?: readonly { brand?: string | null }[];
  sources?: readonly { agentId?: string | null; id?: string | null }[];
  structuredExperiences?: readonly {
    type?: string | null;
    connector?: string | null;
    provider?: string | null;
  }[];
  responseText?: string | null;
  isError?: boolean;
}): boolean {
  if (
    input.streamEvents?.some(
      (event) => Boolean(event.brand && GOOGLE_BRANDS.has(event.brand)),
    )
  ) {
    return true;
  }
  if (
    input.sources?.some((source) => {
      const sourceKey = source.agentId ?? source.id;
      return Boolean(sourceKey && GOOGLE_SOURCE_IDS.has(sourceKey));
    })
  ) {
    return true;
  }
  if (
    input.structuredExperiences?.some((exp) => {
      const type = exp.type ?? "";
      if (!type) return false;
      if (GOOGLE_EXPERIENCE_TYPES.has(type) || type.startsWith("one.calendar_")) {
        return true;
      }
      if (type === "one.connector_read.v1") {
        return exp.connector === "gmail" || exp.connector === "drive";
      }
      if (type === "one.workspace_connector_setup.v1") {
        return Boolean(exp.provider && GOOGLE_BRANDS.has(exp.provider));
      }
      return false;
    })
  ) {
    return true;
  }
  if (!input.isError && input.responseText) {
    return GOOGLE_PROSE_PATTERN.test(input.responseText);
  }
  return false;
}

export function resolveProductionTurnGoogleNote(input: {
  isStreaming?: boolean;
  streamEvents?: readonly { brand?: string | null }[];
  sources?: readonly { agentId?: string | null; id?: string | null }[];
  experienceItems?: readonly {
    experience: {
      type: string;
      connector?: unknown;
      provider?: unknown;
    };
  }[];
  responseText?: string | null;
  isError?: boolean;
}): string | undefined {
  if (input.isStreaming || !isProductionVisitorPostureEnabled()) {
    return undefined;
  }
  const structuredExperiences = input.experienceItems?.map(({ experience }) => ({
    type: experience.type,
    connector:
      "connector" in experience && experience.connector != null
        ? String(experience.connector)
        : null,
    provider:
      "provider" in experience && experience.provider != null
        ? String(experience.provider)
        : null,
  }));
  return turnInvolvesGoogleApps({
    streamEvents: input.streamEvents,
    sources: input.sources,
    structuredExperiences,
    responseText: input.responseText,
    isError: input.isError,
  })
    ? GOOGLE_APPS_CLEARANCE_NOTE
    : undefined;
}

/**
 * Production-only suppression of the bottom voice bar across Research, Blog,
 * public editorial pages, early/pre-app entry & setup screens, and Terms/Legal.
 */
export function isProductionVoiceBarSuppressedRoute(input: {
  pathname: string | null | undefined;
  shellPathname: string | null | undefined;
  isAuthenticated: boolean;
  useOnboardingChrome: boolean;
}): boolean {
  if (!isProductionVisitorPostureEnabled()) return false;
  const path = normalizePathname(input.pathname);
  const shellPath = normalizePathname(input.shellPathname);

  // 1. Research, Blog, Developers & Foundation public editorial routes
  if (isFoundationPublicRoute(path) && path !== ROUTES.HOME) {
    return true;
  }

  // 2. Terms, Privacy & Regulatory legal routes
  if (
    path === ROUTES.TERMS ||
    path === ROUTES.PRIVACY ||
    path === ROUTES.PROFILE_REGULATORY
  ) {
    return true;
  }

  // 3. Very early entry, unauthenticated, account-deletion & onboarding/setup pages
  if (
    !input.isAuthenticated ||
    input.useOnboardingChrome ||
    path === ROUTES.GETTING_STARTED ||
    path === ROUTES.DELETE_ACCOUNT ||
    path === ROUTES.ONE_WELCOME ||
    path === HUSHH_TECH_LAUNCH_PATH ||
    isOneSetupSurfaceRoute(path) ||
    isOneSetupSurfaceRoute(shellPath) ||
    isRiaOnboardingRoute(path) ||
    isRiaOnboardingRoute(shellPath)
  ) {
    return true;
  }

  return false;
}

/** Suppresses only the voice launcher slot when Legal/Terms/Privacy is open inside Profile. */
export function isProductionProfileLegalSubsurface(
  pathname: string | null | undefined,
  searchParams: { get(name: string): string | null } | null | undefined,
): boolean {
  if (!isProductionVisitorPostureEnabled() || !searchParams) return false;
  const path = normalizePathname(pathname);
  const profilePanel = searchParams.get("profile_panel");
  const profileDetail = searchParams.get("profile_detail");
  if (
    profilePanel === "legal" ||
    profileDetail === "terms" ||
    profileDetail === "privacy"
  ) {
    return true;
  }
  if (path === ROUTES.PROFILE) {
    const panel = searchParams.get("panel");
    const detail = searchParams.get("detail");
    return panel === "legal" || detail === "terms" || detail === "privacy";
  }
  return false;
}
