"use client";

import { ROUTES } from "@/lib/navigation/routes";

const STORAGE_KEY = "one_onboarding_connector_intent_v1";
const MAX_AGE_MS = 15 * 60 * 1000;

export type OnboardingConnectorIntent = {
  version: 1;
  capability: "gmail";
  returnTo: typeof ROUTES.ONE_SETUP;
  correlationId: string;
  startedAt: number;
};

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function writeIntent(
  target: Storage | null | undefined,
  intent: OnboardingConnectorIntent,
): boolean {
  if (!target) return false;
  try {
    target.setItem(STORAGE_KEY, JSON.stringify(intent));
    return true;
  } catch {
    return false;
  }
}

export function createOnboardingConnectorIntent(
  capability: "gmail",
): OnboardingConnectorIntent {
  return {
    version: 1,
    capability,
    returnTo: ROUTES.ONE_SETUP,
    correlationId:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `connector_${Date.now().toString(36)}`,
    startedAt: Date.now(),
  };
}

/**
 * Keep only an opaque correlation in browser session storage. Call this after
 * the matching durable journey transition has been accepted.
 */
export function persistOnboardingConnectorIntent(
  intent: OnboardingConnectorIntent,
): void {
  void writeIntent(storage(), intent);
}

/**
 * The Gmail OAuth popup has its own top-level session. Copy only the opaque
 * journey correlation into that popup so its callback can settle the durable
 * setup goal. Vault material, Firebase credentials, OAuth artifacts, and
 * Gmail contents are deliberately never copied across windows.
 */
export function persistOnboardingConnectorIntentInStorage(
  target: Storage | null | undefined,
  intent: OnboardingConnectorIntent,
): boolean {
  return writeIntent(target, intent);
}

export function beginOnboardingConnectorIntent(
  capability: "gmail",
): OnboardingConnectorIntent {
  const intent = createOnboardingConnectorIntent(capability);
  persistOnboardingConnectorIntent(intent);
  return intent;
}

export function readOnboardingConnectorIntent(): OnboardingConnectorIntent | null {
  const store = storage();
  const raw = store?.getItem(STORAGE_KEY);
  if (!store || !raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<OnboardingConnectorIntent>;
    const valid =
      value.version === 1 &&
      value.capability === "gmail" &&
      value.returnTo === ROUTES.ONE_SETUP &&
      typeof value.correlationId === "string" &&
      typeof value.startedAt === "number" &&
      Date.now() - value.startedAt <= MAX_AGE_MS;
    if (valid) return value as OnboardingConnectorIntent;
  } catch {
    // Invalid browser state is discarded below.
  }
  store.removeItem(STORAGE_KEY);
  return null;
}

export function clearOnboardingConnectorIntent(): void {
  storage()?.removeItem(STORAGE_KEY);
}
