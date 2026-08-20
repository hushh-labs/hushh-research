"use client";

import { KAI_MARKET_PATH, ROUTES } from "@/lib/navigation/routes";
import { trackEvent } from "@/lib/observability/client";
import type {
  AuthMethod,
  GrowthEntrySurface,
  GrowthJourney,
  GrowthLocationActivationPath,
  GrowthLocationInviteSource,
  GrowthLocationStep,
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
  inviteSource?: GrowthLocationInviteSource;
  updatedAt?: string;
}

interface GrowthAttributionContext {
  campaignTagged: boolean;
  referrerHost?: string;
  landingPath?: string;
  capturedAt: string;
  /**
   * First-touch campaign values. Held here rather than read from the URL at
   * emit time because the One auth gate (sign-in, phone verification, vault
   * unlock) navigates away from the tagged landing URL long before a user
   * reaches activation. Without persistence every social visit reports as
   * `(direct) / (not set)`.
   */
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
}

interface GrowthContextState {
  version: 1;
  investor?: GrowthJourneyContext;
  ria?: GrowthJourneyContext;
  location?: GrowthJourneyContext;
  attribution?: GrowthAttributionContext;
  /**
   * Funnel steps already emitted, so each fires at most once per user per
   * device. The dedupe in `client.ts` is an in-memory burst guard that resets
   * on reload — it cannot express "once, ever", which is what a funnel needs
   * for its step-to-step ratios to be readable as drop-off.
   */
  emittedSteps?: string[];
}

/** Campaign values are attacker-controlled URL input; keep them short and boring. */
const MAX_UTM_VALUE_LENGTH = 100;

function sanitizeCampaignValue(value: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().slice(0, MAX_UTM_VALUE_LENGTH);
  if (!trimmed) return undefined;
  return trimmed.replace(/[^\w.\-/ ]/g, "").toLowerCase() || undefined;
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
      location: parsed.location,
      attribution: parsed.attribution,
      emittedSteps: Array.isArray(parsed.emittedSteps)
        ? parsed.emittedSteps
        : undefined,
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
  if (pathname === KAI_MARKET_PATH || pathname.startsWith(`${KAI_MARKET_PATH}/`)) {
    return "investor";
  }
  if (
    pathname === ROUTES.ONE_LOCATION ||
    pathname.startsWith(`${ROUTES.ONE_LOCATION}/`) ||
    pathname === ROUTES.ONE_SETUP_LOCATION ||
    pathname.startsWith(`${ROUTES.ONE_SETUP_LOCATION}/`) ||
    pathname.startsWith("/circle/join")
  ) {
    return "location";
  }
  return null;
}

export function resolveGrowthEntrySurface(pathname: string): GrowthEntrySurface {
  if (!pathname) return "unknown";
  if (pathname === ROUTES.LOGIN) return "login";
  if (pathname === ROUTES.ONE_SETUP || pathname.startsWith(`${ROUTES.ONE_SETUP}/`)) {
    return "one_setup";
  }
  if (pathname === ROUTES.KAI_IMPORT || pathname.startsWith(`${ROUTES.KAI_IMPORT}/`)) {
    return "kai_import";
  }
  if (pathname === KAI_MARKET_PATH || pathname.startsWith(`${KAI_MARKET_PATH}/`)) {
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
  if (pathname.startsWith("/circle/join")) return "circle_join";
  if (pathname.startsWith(`${ROUTES.ONE_LOCATION}/request/`)) {
    return "public_location_link";
  }
  if (
    pathname === ROUTES.ONE_SETUP_LOCATION ||
    pathname.startsWith(`${ROUTES.ONE_SETUP_LOCATION}/`)
  ) {
    return "one_location_onboarding";
  }
  if (
    pathname === ROUTES.ONE_LOCATION ||
    pathname.startsWith(`${ROUTES.ONE_LOCATION}/`)
  ) {
    return "one_location";
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

  // First-touch wins: once a campaign is recorded it is never overwritten by a
  // later untagged visit, otherwise an internal navigation would relabel a
  // Reddit-sourced user as direct.
  // Any campaign field counts as first touch, not just utm_source. Keying on
  // source alone meant a link tagged with only medium/campaign was wiped by the
  // next navigation -- precisely the loss this persistence exists to prevent.
  const alreadyAttributedToCampaign = Boolean(
    context.attribution?.utmSource ||
      context.attribution?.utmMedium ||
      context.attribution?.utmCampaign ||
      context.attribution?.utmContent,
  );

  if (
    campaignTagged ||
    referrerHost ||
    !context.attribution ||
    context.attribution.landingPath !== pathname
  ) {
    const previous = context.attribution;
    context.attribution = {
      campaignTagged: campaignTagged || Boolean(previous?.campaignTagged),
      referrerHost: referrerHost || previous?.referrerHost,
      landingPath: previous?.landingPath || pathname,
      capturedAt: previous?.capturedAt || nowIso(),
      ...(alreadyAttributedToCampaign
        ? {
            utmSource: previous?.utmSource,
            utmMedium: previous?.utmMedium,
            utmCampaign: previous?.utmCampaign,
            utmContent: previous?.utmContent,
          }
        : {
            utmSource: sanitizeCampaignValue(searchParams.get("utm_source")),
            utmMedium: sanitizeCampaignValue(searchParams.get("utm_medium")),
            utmCampaign: sanitizeCampaignValue(searchParams.get("utm_campaign")),
            utmContent: sanitizeCampaignValue(searchParams.get("utm_content")),
          }),
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

/**
 * Records that a once-per-user milestone has fired and reports whether this
 * call is the first. Durable across reloads and across the auth gate, which an
 * in-memory dedupe window cannot be.
 */
function hasClaimedOncePerUser(marker: string): boolean {
  return (readGrowthContext().emittedSteps || []).includes(marker);
}

/**
 * Marks a once-per-user milestone as sent.
 *
 * Deliberately called *after* the event is handed to `trackEvent`, not before.
 * `trackEvent` drops the event when observability is disabled or a sampling
 * roll fails, and claiming first meant that single un-retryable roll burned the
 * step permanently for that device -- so the funnel did not degrade to a clean
 * sample, it silently lost individual steps and the step-to-step ratios stopped
 * meaning anything.
 */
function markClaimedOncePerUser(marker: string): void {
  const context = readGrowthContext();
  const emitted = context.emittedSteps || [];
  if (emitted.includes(marker)) return;
  context.emittedSteps = [...emitted, marker];
  writeGrowthContext(context);
}

export function rememberLocationInviteSource(
  inviteSource: GrowthLocationInviteSource
): void {
  const context = readGrowthContext();
  // First touch wins — a user who arrived on a circle code and later opens a
  // public link is still a circle-code acquisition.
  if (context.location?.inviteSource) return;
  context.location = {
    ...(context.location || {}),
    inviteSource,
    updatedAt: nowIso(),
  };
  writeGrowthContext(context);
}

/**
 * Emits one step of the One Location funnel, at most once per user per device.
 * Step-to-step ratios are the drop-off readout, so a step that fired twice for
 * one user would silently corrupt the funnel.
 */
export function trackLocationFunnelStepCompleted(
  step: GrowthLocationStep,
  options: { entrySurface?: GrowthEntrySurface; authMethod?: AuthMethod } = {}
): void {
  if (hasClaimedOncePerUser(`location:${step}`)) return;

  const current = resolveJourneyContext("location");
  const resolvedEntrySurface =
    options.entrySurface ||
    current.entrySurface ||
    resolveGrowthEntrySurface(
      typeof window !== "undefined" ? window.location.pathname : ""
    );
  const resolvedAuthMethod = options.authMethod || current.authMethod;

  rememberGrowthJourneyContext("location", {
    entrySurface: resolvedEntrySurface,
    authMethod: resolvedAuthMethod,
  });

  const dispatched = trackEvent("growth_funnel_step_completed", {
    journey: "location",
    step,
    ...(resolvedEntrySurface ? { entry_surface: resolvedEntrySurface } : {}),
    ...(resolvedAuthMethod ? { auth_method: resolvedAuthMethod } : {}),
    ...(current.inviteSource ? { invite_source: current.inviteSource } : {}),
    app_version: resolveClientVersion(),
  });
  // Claimed only if it actually went out. A step dropped by sampling or a
  // disabled kill-switch stays unclaimed so the next opportunity can send it.
  if (dispatched) markClaimedOncePerUser(`location:${step}`);
}

/**
 * The One Location north-star: location has actually moved between two people.
 * Fires at most once per user, on whichever side happens first.
 */
export function trackLocationActivationCompleted({
  activationPath,
  entrySurface,
  authMethod,
  recipientCountBucket,
  shareDurationBucket,
}: {
  activationPath: GrowthLocationActivationPath;
  entrySurface?: GrowthEntrySurface;
  authMethod?: AuthMethod;
  recipientCountBucket?: string;
  shareDurationBucket?: string;
}): void {
  if (hasClaimedOncePerUser("location:activated")) return;

  const current = resolveJourneyContext("location");
  const resolvedEntrySurface =
    entrySurface ||
    current.entrySurface ||
    resolveGrowthEntrySurface(
      typeof window !== "undefined" ? window.location.pathname : ""
    );
  const resolvedAuthMethod = authMethod || current.authMethod;

  const dispatched = trackEvent("one_location_activation_completed", {
    journey: "location",
    activation_path: activationPath,
    ...(resolvedEntrySurface ? { entry_surface: resolvedEntrySurface } : {}),
    ...(resolvedAuthMethod ? { auth_method: resolvedAuthMethod } : {}),
    ...(current.inviteSource ? { invite_source: current.inviteSource } : {}),
    ...(recipientCountBucket
      ? { recipient_count_bucket: recipientCountBucket }
      : {}),
    ...(shareDurationBucket
      ? { share_duration_bucket: shareDurationBucket }
      : {}),
    app_version: resolveClientVersion(),
  });
  if (dispatched) markClaimedOncePerUser("location:activated");
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
