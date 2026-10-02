"use client";

import { Capacitor } from "@capacitor/core";
import { useCallback, useRef, useState } from "react";

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

export async function startAzureSignIn(
  kind: AzureSignInKind,
  subscriptionId?: string,
): Promise<void> {
  if (!isAzureSignInAvailable()) throw new AzureSignInUnavailableError();
  const begun =
    kind === "upgrade"
      ? await ApiService.beginAzureByocUpgrade()
      : await ApiService.beginAzureByocAuthorize(subscriptionId ? { subscriptionId } : {});
  assignWindowLocation(begun.authorizationUrl);
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
    try {
      await startAzureSignIn(kind, subscriptionId);
    } catch (cause) {
      setError(azureSignInErrorMessage(cause, kind));
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { start, starting, error, clearError };
}
