"use client";

import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { ownerCloudProvider } from "@/lib/one/owner-cloud";
import { ApiService } from "@/lib/services/api-service";
import { AzureByocError } from "@/lib/services/azure-byoc-contract";
import { assignWindowLocation } from "@/lib/utils/browser-navigation";

/**
 * Starting the Microsoft sign-in that every Azure change rides on.
 *
 * Hussh holds no standing write authority in a person's subscription (see
 * `docs/reference/architecture/byoc-azure.md`, trust matrix), so setup and
 * every approved update go through the person's own just-in-time sign-in.
 * These helpers ask the hub for that sign-in address and navigate to it; the
 * Microsoft redirect lands on `/one/setup/cloud/azure/return`.
 */

/** `rebuild`: re-create the hosting space Microsoft removed, adopting what survived. */
export type AzureSignInKind = "setup" | "upgrade" | "rebuild";

/** The return leg is a web route; the mobile shells have no way back to it yet. */
export class AzureSignInUnavailableError extends Error {
  constructor() {
    super("AZURE_SIGN_IN_WEB_ONLY");
    this.name = "AzureSignInUnavailableError";
  }
}

export function isAzureSignInAvailable(): boolean {
  return !Capacitor.isNativePlatform();
}

const SUBSCRIPTION_REF = /^\/subscriptions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/**
 * The subscription a setup job or reserved home names (`/subscriptions/<id>/...`).
 * A retry signs in to that subscription's own directory: a personal Microsoft
 * account cannot reach Azure through the shared `common` sign-in at all.
 */
export function azureSubscriptionFromRef(ref: string | null | undefined): string | null {
  const match = SUBSCRIPTION_REF.exec(String(ref ?? ""));
  return match?.[1]?.toLowerCase() ?? null;
}

/** Same-origin only: carries a "setup started" signal, never a code or token. */
export const AZURE_SIGN_IN_CHANNEL = "hussh-azure-sign-in";
const POPUP_NAME = "hussh-azure-sign-in";
const POPUP_WIDTH = 520;
const POPUP_HEIGHT = 720;

type AzureSignInMessage =
  | { type: "azure-setup-started"; kind?: "upgrade"; jobId?: string }
  | { type: "azure-setup-ack" };

/** What the opening tab learns when the popup hands back: which sign-in, and its job. */
export type AzureSignInStarted = { kind: AzureSignInKind; jobId: string | null };

/**
 * Opened synchronously inside the tap, before the hub is asked for the address,
 * so a popup blocker sees a user gesture. `null` means blocked: the sign-in
 * then continues in this tab, exactly as before.
 */
export function openSignInPopup(): Window | null {
  if (typeof window === "undefined") return null;
  const left = Math.max(0, window.screenX + (window.outerWidth - POPUP_WIDTH) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2);
  const features = `popup,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top}`;
  try {
    // jsdom and some embedded browsers return undefined rather than null.
    return window.open("about:blank", POPUP_NAME, features) ?? null;
  } catch {
    return null;
  }
}

/**
 * Where the sign-in went: `"popup"` keeps this tab in place, `"tab"` means this
 * tab is leaving for Microsoft (no popup, or it was closed before the hub answered).
 */
export async function startAzureSignIn(
  kind: AzureSignInKind,
  subscriptionId?: string,
  popup: Window | null = null,
): Promise<"popup" | "tab"> {
  if (!isAzureSignInAvailable()) throw new AzureSignInUnavailableError();
  const begun =
    kind === "upgrade"
      ? await ApiService.beginAzureByocUpgrade()
      : kind === "rebuild"
        ? await ApiService.beginAzureByocRebuild()
        : await ApiService.beginAzureByocAuthorize(subscriptionId ? { subscriptionId } : {});
  if (popup && !popup.closed) {
    popup.location.assign(begun.authorizationUrl);
    popup.focus();
    return "popup";
  }
  assignWindowLocation(begun.authorizationUrl);
  return "tab";
}

function signInChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(AZURE_SIGN_IN_CHANNEL);
}

/** Re-announce this often until the opening tab answers (a busy tab answers late). */
const ANNOUNCE_EVERY_MS = 400;
/**
 * How long a popup waits for its opening tab. One second was too short on a loaded
 * machine: the tab answered late, the popup concluded nobody was listening and took
 * over the setup inside itself (founder-hit 2026-10-04, with the Mac at load 25).
 */
export const ANNOUNCE_WAIT_MS = 8000;

/**
 * The return page, finished, tells the tab that opened the sign-in, repeating until
 * that tab acknowledges. Resolves `true` on the acknowledgement, so the popup can
 * close; `false` when no tab answered within `timeoutMs`.
 *
 * An update names its job (`upgradeJobId`), so the opening tab follows that job's
 * record and never an earlier setup's or attempt's.
 */
export function announceAzureSetupStarted({
  timeoutMs = ANNOUNCE_WAIT_MS,
  upgradeJobId,
}: { timeoutMs?: number; upgradeJobId?: string } = {}): Promise<boolean> {
  const channel = signInChannel();
  if (!channel) return Promise.resolve(false);
  const message: AzureSignInMessage =
    upgradeJobId === undefined
      ? { type: "azure-setup-started" }
      : { type: "azure-setup-started", kind: "upgrade", jobId: upgradeJobId };
  return new Promise((resolve) => {
    const announce = () => channel.postMessage(message);
    const done = (acked: boolean) => {
      clearTimeout(timer);
      clearInterval(repeat);
      channel.close();
      resolve(acked);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const repeat = setInterval(announce, ANNOUNCE_EVERY_MS);
    channel.onmessage = (event: MessageEvent<AzureSignInMessage>) => {
      if (event.data?.type === "azure-setup-ack") done(true);
    };
    announce();
  });
}

/**
 * Whether this page is the Microsoft sign-in popup, still attached to the tab that
 * opened it. Microsoft's pages set `Cross-Origin-Opener-Policy` in report-only mode
 * (measured 2026-10-04), so the opener survives the round trip; if a browser ever
 * severs it, this reads `false` and the return page behaves like a normal tab.
 */
export function isSignInPopup(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return Boolean(window.opener) && window.opener !== window;
  } catch {
    return false;
  }
}

/** Bring the tab that opened the popup forward, best effort, then close the popup. */
export function returnToOpener(): void {
  try {
    (window.opener as Window | null)?.focus();
  } catch {
    // A severed or cross-origin opener cannot be focused; closing is still right.
  }
  window.close();
}

/**
 * The opening tab hears the popup finish, acknowledges, and refreshes its own view.
 *
 * `only` limits it to one kind of sign-in. A hand-back of another kind is neither
 * acted on nor acknowledged: the popup closes on an acknowledgement, so a tab that
 * answered for a sign-in it does not follow would leave that sign-in followed nowhere.
 */
export function useAzureSetupStartedSignal(
  onStarted: (started: AzureSignInStarted) => void,
  only?: AzureSignInKind,
): void {
  const latest = useRef(onStarted);
  useEffect(() => {
    latest.current = onStarted;
  }, [onStarted]);
  useEffect(() => {
    const channel = signInChannel();
    if (!channel) return;
    channel.onmessage = (event: MessageEvent<AzureSignInMessage>) => {
      if (event.data?.type !== "azure-setup-started") return;
      const started: AzureSignInStarted =
        event.data.kind === "upgrade"
          ? { kind: "upgrade", jobId: event.data.jobId ?? null }
          : { kind: "setup", jobId: null };
      if (only && started.kind !== only) return;
      // Acknowledge every repeat (the popup closes on the first it hears) but act once.
      channel.postMessage({ type: "azure-setup-ack" } satisfies AzureSignInMessage);
      latest.current(started);
    };
    return () => channel.close();
  }, [only]);
}

const BEGIN_FALLBACK: Record<AzureSignInKind, string> = {
  setup:
    "We could not start the Microsoft sign-in. Nothing in your subscription changed; try again in a moment.",
  upgrade:
    "We could not start the update sign-in. Your agent keeps its current version; try again in a moment.",
  rebuild:
    "We could not start the Microsoft sign-in. Your memory and keys are untouched; try again in a moment.",
};

/** One plain sentence for any failure on the way to, or back from, Microsoft. */
export function azureSignInErrorMessage(
  error: unknown,
  stage: AzureSignInKind | "complete",
): string {
  if (error instanceof AzureSignInUnavailableError) {
    return "Microsoft sign-in is not available in the mobile app yet. Continue on the Hussh website.";
  }
  if (error instanceof AzureByocError && error.serverMessage) {
    return error.serverMessage;
  }
  if (error instanceof AzureByocError && error.code === "AZURE_RESPONSE_INVALID") {
    return "We could not open the Microsoft sign-in safely. Nothing in your subscription changed; try again in a moment.";
  }
  if (stage === "complete") {
    return "We could not finish connecting Azure. Start the Microsoft sign-in again to continue.";
  }
  return BEGIN_FALLBACK[stage];
}

/**
 * Which sign-in a retry should restart. A person has one agent; when that agent
 * already runs in Azure, a Microsoft sign-in can only have been for its update.
 */
export function azureRetryKind(
  status: { deploymentTarget?: string | null; state?: string | null } | null,
): AzureSignInKind {
  return ownerCloudProvider(status?.deploymentTarget) === "azure" && status?.state === "active"
    ? "upgrade"
    : "setup";
}

export const POPUP_WATCH_MS = 500;
export const POPUP_CLOSED_NOTICE =
  "The Microsoft window closed before setup started. Nothing in your subscription changed.";
export const UPDATE_POPUP_CLOSED_NOTICE =
  "The Microsoft window closed before the update started. Your agent keeps its current version.";

/**
 * Shared UI state for a button that starts the Microsoft sign-in.
 *
 * `inPlace` keeps the sign-in in this window: the return page passes it, because it
 * already IS the popup, and opening another from it stacked a second window.
 */
export function useAzureSignIn({ inPlace = false }: { inPlace?: boolean } = {}) {
  const inFlight = useRef(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const watch = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopWatching = useCallback(() => {
    if (watch.current) clearInterval(watch.current);
    watch.current = null;
  }, []);
  useEffect(() => stopWatching, [stopWatching]);

  // A popup closed before setup started (the person closed it, or Microsoft stopped
  // them on its own page) leaves this tab waiting forever unless it notices.
  const watchPopup = useCallback(
    (popup: Window, kind: AzureSignInKind) => {
      stopWatching();
      const channel = signInChannel();
      let handedOff = false;
      if (channel) {
        channel.onmessage = (event: MessageEvent<AzureSignInMessage>) => {
          if (event.data?.type === "azure-setup-started") handedOff = true;
        };
      }
      watch.current = setInterval(() => {
        if (!popup.closed && !handedOff) return;
        stopWatching();
        channel?.close();
        if (!handedOff) setNotice(kind === "upgrade" ? UPDATE_POPUP_CLOSED_NOTICE : POPUP_CLOSED_NOTICE);
      }, POPUP_WATCH_MS);
    },
    [stopWatching],
  );

  const start = useCallback(
    async (kind: AzureSignInKind, subscriptionId?: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setStarting(true);
      setError(null);
      setNotice(null);
      // Setup and updates sign in beside the app, so the person stays where they
      // are; the popup must open before the first await.
      const popup = !inPlace && isAzureSignInAvailable() ? openSignInPopup() : null;
      try {
        const where = await startAzureSignIn(kind, subscriptionId, popup);
        if (popup && where === "popup") watchPopup(popup, kind);
      } catch (cause) {
        popup?.close();
        setError(azureSignInErrorMessage(cause, kind));
      } finally {
        inFlight.current = false;
        setStarting(false);
      }
    },
    [inPlace, watchPopup],
  );

  const clearError = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  return { start, starting, error, notice, clearError };
}
