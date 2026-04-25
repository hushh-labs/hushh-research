"use client";

import { ROUTES } from "@/lib/navigation/routes";
import { trackEvent } from "@/lib/observability/client";
import type {
  AuthMethod,
  GrowthEntrySurface,
  GrowthJourney,
  GrowthPortfolioSource,
  GrowthRiaStep,
  GrowthWorkspaceSource,
  GrowthInvestorStep,
} from "@/lib/observability/events";
import { getLocalItem, setLocalItem } from "@/lib/utils/session-storage";

const GROWTH_CONTEXT_STORAGE_KEY = "hushh_growth_context_v1";
const CLIENT_VERSION_FALLBACK = "unknown";

interface GrowthJourneyContext {
  entrySurface?: GrowthEntrySurface;
  authMethod?: AuthMethod;
  updatedAt?: string;
}

interface GrowthAttributionContext {
  campaignTagged: boolean;
  referrerHost?: string;
  landingPath?: string;
  capturedAt: string;
}

interface GrowthContextState {
  version: 1;
  investor?: GrowthJourneyContext;
  ria?: GrowthJourneyContext;
  attribution?: GrowthAttributionContext;
}

interface GrowthContextPatch {
  entrySurface?: GrowthEntrySurface;
  authMethod?: AuthMethod;
}

interface TrackGrowthStepParams {
  journey: GrowthJourney;
  step: GrowthInvestorStep | GrowthRiaStep;
  entrySurface?: GrowthEntrySurface;
  authMethod?: AuthMethod;
  portfolioSource?: GrowthPortfolioSource;
  workspaceSource?: GrowthWorkspaceSource;
  dedupeKey?: string;
  dedupeWindowMs?: number;
}

interface TrackGrowthActivationParams {
  entrySurface?: GrowthEntrySurface;
  authMethod?: AuthMethod;
  portfolioSource?: GrowthPortfolioSource;
  workspaceSource?: GrowthWorkspaceSource;
  dedupeKey?: string;
  dedupeWindowMs?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readGrowthContext(): GrowthContextState {
  const raw = getLocalItem(GROWTH_CONTEXT_STORAGE_KEY);
  if (!raw) {
    return { version: 1 };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<GrowthContextState>;
    if (parsed.version !== 1) {
      return { version: 1 };
    }
    return {
      version: 1,
      investor: parsed.investor,
      ria: parsed.ria,
      attribution: parsed.attribution,
    };
  } catch {
    return { version: 1 };
  }
}

function writeGrowthContext(context: GrowthContextState): void {
  setLocalItem(GROWTH_CONTEXT_STORAGE_KEY, JSON.stringify(context));
}

function updateJourneyContext(
  journey: GrowthJourney,
  patch: GrowthContextPatch
): GrowthJourneyContext {
  const context = readGrowthContext();
  const current = context[journey] || {};
  const next: GrowthJourneyContext = {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  };
  context[journey] = next;
  writeGrowthContext(context);
  return next;
}

function resolveJourneyContext(journey: GrowthJourney): GrowthJourneyContext {
  return readGrowthContext()[journey] || {};
}

function normalizeReferrerHost(referrer: string): string | undefined {
  if (!referrer) return undefined;
  try {
    return new URL(referrer).hostname.trim().toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

function hasAttributionTag(searchParams: URLSearchParams): boolean {
  return [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_id",
    "gclid",
    "fbclid",
    "msclkid",
  ].some((key) => searchParams.has(key));
}

function resolveClientVersion(): string {
  const version = String(process.env.NEXT_PUBLIC_CLIENT_VERSION || "").trim();
  return version || CLIENT_VERSION_FALLBACK;
}

export function resolveGrowthJourneyForPath(pathname: string): GrowthJourney | null {
  if (!pathname) return null;
  if (pathname === ROUTES.RIA_HOME || pathname.startsWith(`${ROUTES.RIA_HOME}/`)) {
    return "ria";
  }
  if (pathname === ROUTES.KAI_HOME || pathname.startsWith(`${ROUTES.KAI_HOME}/`)) {
    return "investor";
  }
  return null;
}

export function resolveGrowthEntrySurface(pathname: string): GrowthEntrySurface {
  if (!pathname) return "unknown";
  if (pathname === ROUTES.LOGIN) return "login";
  if (pathname === ROUTES.KAI_ONBOARDING || pathname.startsWith(`${ROUTES.KAI_ONBOARDING}/`)) {
    return "kai_onboarding";
  }
  if (pathname === ROUTES.KAI_IMPORT || pathname.startsWith(`${ROUTES.KAI_IMPORT}/`)) {
    return "kai_import";
  }
  if (pathname === ROUTES.KAI_HOME || pathname.startsWith(`${ROUTES.KAI_HOME}/`)) {
    return "kai_home";
  }
  if (pathname === ROUTES.MARKETPLACE || pathname.startsWith(`${ROUTES.MARKETPLACE}/`)) {
    return "marketplace";
  }
  if (pathname === ROUTES.RIA_ONBOARDING || pathname.startsWith(`${ROUTES.RIA_ONBOARDING}/`)) {
    return "ria_onboarding";
  }
  if (pathname === ROUTES.RIA_HOME || pathname.startsWith(`${ROUTES.RIA_HOME}/`)) {
    return "ria_home";
  }
  return "unknown";
}

export function resolveGrowthWorkspaceSource(pathname: string): GrowthWorkspaceSource {
  if (!pathname) return "unknown";
  if (pathname === ROUTES.RIA_HOME || pathname.startsWith(`${ROUTES.RIA_HOME}/`)) {
    return "ria_home";
  }
  if (pathname === ROUTES.RIA_CLIENTS || pathname.startsWith(`${ROUTES.RIA_CLIENTS}/`)) {
    return "ria_client_workspace";
  }
  return "unknown";
}

export function captureGrowthAttribution(pathname: string): void {
  if (typeof window === "undefined") return;

  const context = readGrowthContext();
  const searchParams = new URLSearchParams(window.location.search);
  const campaignTagged = hasAttributionTag(searchParams);
  const referrerHost = normalizeReferrerHost(document.referrer);
  const nextEntrySurface = resolveGrowthEntrySurface(pathname);
  const journey = resolveGrowthJourneyForPath(pathname);

  if (
    campaignTagged ||
    referrerHost ||
    !context.attribution ||
    context.attribution.landingPath !== pathname
  ) {
    context.attribution = {
      campaignTagged,
      referrerHost,
      landingPath: pathname,
      capturedAt: nowIso(),
    };
  }

  if (journey) {
    context[journey] = {
      ...(context[journey] || {}),
      entrySurface: context[journey]?.entrySurface || nextEntrySurface,
      updatedAt: nowIso(),
    };
  }

  writeGrowthContext(context);
}

export function rememberGrowthJourneyContext(
  journey: GrowthJourney,
  patch: GrowthContextPatch
): void {
  updateJourneyContext(journey, patch);
}

export function trackGrowthFunnelStepCompleted({
  journey,
  step,
  entrySurface,
  authMethod,
  portfolioSource,
  workspaceSource,
  dedupeKey,
  dedupeWindowMs,
}: TrackGrowthStepParams): void {
  const current = resolveJourneyContext(journey);
  const resolvedEntrySurface =
    entrySurface ||
    current.entrySurface ||
    resolveGrowthEntrySurface(
      typeof window !== "undefined" ? window.location.pathname : ""
    );
  const resolvedAuthMethod = authMethod || current.authMethod;

  rememberGrowthJourneyContext(journey, {
    entrySurface: resolvedEntrySurface,
    authMethod: resolvedAuthMethod,
  });

  trackEvent(
    "growth_funnel_step_completed",
    {
      journey,
      step,
      ...(resolvedEntrySurface ? { entry_surface: resolvedEntrySurface } : {}),
      ...(resolvedAuthMethod ? { auth_method: resolvedAuthMethod } : {}),
      ...(portfolioSource ? { portfolio_source: portfolioSource } : {}),
      ...(workspaceSource ? { workspace_source: workspaceSource } : {}),
      app_version: resolveClientVersion(),
    },
    {
      dedupeKey,
      dedupeWindowMs,
    }
  );
}

export function trackInvestorActivationCompleted({
  entrySurface,
  authMethod,
  portfolioSource,
  dedupeKey,
  dedupeWindowMs,
}: TrackGrowthActivationParams): void {
  const current = resolveJourneyContext("investor");
  const resolvedEntrySurface =
    entrySurface ||
    current.entrySurface ||
    resolveGrowthEntrySurface(
      typeof window !== "undefined" ? window.location.pathname : ""
    );
  const resolvedAuthMethod = authMethod || current.authMethod;

  trackEvent(
    "investor_activation_completed",
    {
      journey: "investor",
      ...(resolvedEntrySurface ? { entry_surface: resolvedEntrySurface } : {}),
      ...(resolvedAuthMethod ? { auth_method: resolvedAuthMethod } : {}),
      ...(portfolioSource ? { portfolio_source: portfolioSource } : {}),
      app_version: resolveClientVersion(),
    },
    {
      dedupeKey,
      dedupeWindowMs,
    }
  );
}

export function trackRiaActivationCompleted({
  entrySurface,
  authMethod,
  workspaceSource,
  dedupeKey,
  dedupeWindowMs,
}: TrackGrowthActivationParams): void {
  const current = resolveJourneyContext("ria");
  const resolvedEntrySurface =
    entrySurface ||
    current.entrySurface ||
    resolveGrowthEntrySurface(
      typeof window !== "undefined" ? window.location.pathname : ""
    );
  const resolvedAuthMethod = authMethod || current.authMethod;

  trackEvent(
    "ria_activation_completed",
    {
      journey: "ria",
      ...(resolvedEntrySurface ? { entry_surface: resolvedEntrySurface } : {}),
      ...(resolvedAuthMethod ? { auth_method: resolvedAuthMethod } : {}),
      ...(workspaceSource ? { workspace_source: workspaceSource } : {}),
      app_version: resolveClientVersion(),
    },
    {
      dedupeKey,
      dedupeWindowMs,
    }
  );
}
