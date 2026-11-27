"use client";

import { ApiService } from "@/lib/services/api-service";
import { ApiError } from "@/lib/services/api-client";
import { EmailVerificationRequired } from "./marketing-preference-service";

export interface AttemptEmailPreference {
  enabled: boolean;
  available: boolean;
  revision: number;
  disclosureVersion: "one-attempt-email-v1";
  frequency: "one_per_attempt";
}

async function request(owner: string, current: () => boolean, saved?: AttemptEmailPreference, enabled?: boolean): Promise<AttemptEmailPreference> {
  if (!current()) throw new Error("Account session changed");
  const token = await ApiService.getFirebaseIdTokenForOwner(owner);
  if (!token || !current()) throw new Error("Account session changed");
  const response = await ApiService.apiFetch("/api/one/plg/attempt-email/preferences", {
    method: saved ? "PUT" : "GET", cache: "no-store", isEffectCurrent: current,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(saved ? { body: JSON.stringify({ enabled, expectedRevision: saved.revision, disclosureVersion: saved.disclosureVersion }) } : {}),
  });
  if (!current()) throw new Error("Account session changed");
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    if (!current()) throw new Error("Account session changed");
    if (response.status === 409 && failure?.detail?.code === "verified_email_required") throw new EmailVerificationRequired();
    throw new ApiError("Activity email choice was not confirmed. Refresh before trying again.", response.status);
  }
  const body = await response.json();
  if (!current() || !body || typeof body.enabled !== "boolean" || !Number.isSafeInteger(body.revision) || body.revision < 0 ||
      body.disclosureVersion !== "one-attempt-email-v1" || body.frequency !== "one_per_attempt" ||
      (!saved && typeof body.available !== "boolean")) throw new Error("Activity email choice was not confirmed");
  return { ...body, available: saved?.available ?? body.available };
}

export const AttemptEmailService = {
  read: (owner: string, current: () => boolean) => request(owner, current),
  save: (owner: string, current: () => boolean, saved: AttemptEmailPreference, enabled: boolean) => request(owner, current, saved, enabled),
};
