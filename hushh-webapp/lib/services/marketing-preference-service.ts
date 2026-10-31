"use client";

import { ApiService } from "@/lib/services/api-service";
import { ApiError } from "@/lib/services/api-client";

export type EmailFrequency = "daily" | "weekly" | "updates";
export class EmailVerificationRequired extends Error {
  constructor() { super("Verify your account email before subscribing."); this.name = "EmailVerificationRequired"; }
}
export interface MarketingPreference {
  enabled: boolean;
  frequency: EmailFrequency;
  revision: number;
  generation: string | null;
  disclosureVersion: "one-email-updates-v1";
  consentAt: string | null;
  chosenAt: string | null;
}

async function request(userId: string, current: () => boolean, input?: {
  enabled: boolean; frequency: EmailFrequency; expectedRevision: number;
  disclosureVersion: MarketingPreference["disclosureVersion"]; surface: "setup" | "account";
}): Promise<MarketingPreference> {
  if (!current()) throw new Error("Account session changed");
  const token = await ApiService.getFirebaseIdTokenForOwner(userId);
  if (!token || !current()) throw new Error("Account session changed");
  const response = await ApiService.apiFetch("/api/one/plg/preferences", {
    method: input ? "PUT" : "GET", cache: "no-store", isEffectCurrent: current,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  if (!current()) throw new Error("Account session changed");
  if (!response.ok) {
    if (response.status === 409) {
      const failure = await response.json().catch(() => null);
      if (!current()) throw new Error("Account session changed");
      if (failure?.detail?.code === "verified_email_required") throw new EmailVerificationRequired();
    }
    throw new ApiError(response.status === 409 ? "Refresh your saved email preferences before trying again." :
      "Email preferences are temporarily unavailable.", response.status);
  }
  const body: MarketingPreference = await response.json();
  if (!current() || !body || typeof body.enabled !== "boolean" ||
      !["daily", "weekly", "updates"].includes(body.frequency) ||
      !Number.isSafeInteger(body.revision) || body.revision < 0 ||
      body.disclosureVersion !== "one-email-updates-v1") throw new Error("Email preference could not be confirmed");
  return body;
}

export const MarketingPreferenceService = {
  read: (userId: string, current: () => boolean) => request(userId, current),
  save: (userId: string, current: () => boolean, preference: MarketingPreference,
    enabled: boolean, frequency: EmailFrequency, surface: "setup" | "account") =>
    request(userId, current, { enabled, frequency, expectedRevision: preference.revision,
      disclosureVersion: preference.disclosureVersion, surface }),
};
