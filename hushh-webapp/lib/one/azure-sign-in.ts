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

export type AzureSignInKind = "setup" | "upgrade";

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

type AzureSignInMessage = { type: "azure-setup-started" } | { type: "azure-setup-ack" };

/**
 * Opened synchronously inside the tap, before the hub is asked for the address,
 * so a popup blocker sees a user gesture. `null` means blocked: the sign-in
 * then continues in this tab, exactly as before.
 */
function openSignInPopup(): Window | null {
  if (typeof window === "undefined") return null;
  const left = Math.max(0, window.screenX + (window.outerWidth - POPUP_WIDTH) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2);
  const features = `popup,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top}`;
  try {
    return window.open("about:blank", POPUP_NAME, features);
  } catch {
    return null;
  }
}

export async function startAzureSignIn(
  kind: AzureSignInKind,
  subscriptionId?: string,
  popup: Window | null = null,
): Promise<void> {
  if (!isAzureSignInAvailable()) throw new AzureSignInUnavailableError();
  const begun =
    kind === "upgrade"
      ? await ApiService.beginAzureByocUpgrade()
      : await ApiService.beginAzureByocAuthorize(subscriptionId ? { subscriptionId } : {});
  if (popup && !popup.closed) {
    popup.location.assign(begun.authorizationUrl);
    popup.focus();
    return;
  }
  assignWindowLocation(begun.authorizationUrl);
}

function signInChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(AZURE_SIGN_IN_CHANNEL);
}

/**
 * The return page, finished, tells the tab that opened the sign-in. Resolves
 * `true` once that tab acknowledges, so the popup can close; `false` when no
 * tab is listening (the same-tab flow), so the return page carries on itself.
 */
export function announceAzureSetupStarted(timeoutMs = 1000): Promise<boolean> {
  const channel = signInChannel();
  if (!channel) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (acked: boolean) => {
      clearTimeout(timer);
      channel.close();
      resolve(acked);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    channel.onmessage = (event: MessageEvent<AzureSignInMessage>) => {
      if (event.data?.type === "azure-setup-ack") done(true);
    };
    channel.postMessage({ type: "azure-setup-started" } satisfies AzureSignInMessage);
  });
}

/** The opening tab hears the popup finish, acknowledges, and refreshes its own view. */
export function useAzureSetupStartedSignal(onStarted: () => void): void {
  const latest = useRef(onStarted);
  useEffect(() => {
    latest.current = onStarted;
  }, [onStarted]);
  useEffect(() => {
    const channel = signInChannel();
    if (!channel) return;
    channel.onmessage = (event: MessageEvent<AzureSignInMessage>) => {
      if (event.data?.type !== "azure-setup-started") return;
      channel.postMessage({ type: "azure-setup-ack" } satisfies AzureSignInMessage);
      latest.current();
    };
    return () => channel.close();
  }, []);
}

const BEGIN_FALLBACK: Record<AzureSignInKind, string> = {
  setup:
    "We could not start the Microsoft sign-in. Nothing in your subscription changed; try again in a moment.",
  upgrade:
    "We could not start the update sign-in. Your agent keeps its current version; try again in a moment.",
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

/** Shared UI state for a button that starts the Microsoft sign-in. */
export function useAzureSignIn() {
  const inFlight = useRef(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async (kind: AzureSignInKind, subscriptionId?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStarting(true);
    setError(null);
    // Setup signs in beside the app; the popup must open before the first await.
    const popup = kind === "setup" && isAzureSignInAvailable() ? openSignInPopup() : null;
    try {
      await startAzureSignIn(kind, subscriptionId, popup);
    } catch (cause) {
      popup?.close();
      setError(azureSignInErrorMessage(cause, kind));
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { start, starting, error, clearError };
}
