import { ApiService } from "@/lib/services/api-service";
import type { EncryptedPayload } from "@/lib/vault/encrypt";

export type PublicProfileFact = {
  category: string;
  claim: string;
  confidence: "low" | "medium" | "high" | null;
  support: string | null;
  source_urls: string[];
  observed_at: string | null;
  collected_at: string;
};

export type PublicProfileReview = {
  schema_version: "public_profile_review.v1";
  display_name: string;
  summary: string;
  collected_at: string;
  revision: number;
  facts: PublicProfileFact[];
  sources: string[];
  conflicts: string[];
  warnings: string[];
};

export type EncryptedProfileDraft = Omit<EncryptedPayload, "encoding"> & {
  profile_revision: number;
};

export type PublicProfileDiscoveryJob = {
  job_id: string;
  status: "queued" | "scanning" | "needs_details" | "ready" | "failed" | "claimed" | "cancelled";
  profile_revision: number | null;
  profile: PublicProfileReview | null;
  encrypted_draft: EncryptedProfileDraft | null;
  last_error_code: string | null;
  claimed_at: string | null;
  claim_decision: "accepted" | "rejected_all" | null;
  updated_at: string | null;
};

export type DiscoveryStartInput = {
  consent: true;
  consentVersion: "public_profile_discovery_v2";
  externalPhoneConsent: boolean;
  name?: string;
  email?: string;
  profileUrl?: string;
  employer?: string;
  city?: string;
};

const PROFILE_DISCOVERY_ERROR_COPY: Record<string, string> = {
  verified_phone_required: "Verify your phone number before starting public-profile discovery.",
  phone_unavailable: "The optional phone match is unavailable. Turn off phone matching and continue.",
  invalid_profile_url: "Enter a public HTTPS profile link, or leave that field empty.",
  invalid_email: "Check the email address you entered and try again.",
  profile_revision_changed: "This profile changed while you were reviewing it. Reload the review before continuing.",
  scan_retry_limit: "This one-time search reached its retry limit. You can continue using One.",
  consent_required: "Agree to the public-profile search terms before starting the search.",
};

async function requestJob(
  path: string,
  params: { token: string; method?: string; body?: unknown },
): Promise<PublicProfileDiscoveryJob | null> {
  const response = await ApiService.apiFetch(`/api/one/profile-discovery${path}`, {
    method: params.method || "GET",
    headers: { Authorization: `Bearer ${params.token}` },
    ...(params.body !== undefined ? { body: JSON.stringify(params.body) } : {}),
    timeoutMs: 15_000,
  });
  const payload = await response.json().catch(() => ({})) as {
    job?: PublicProfileDiscoveryJob | null;
    detail?: { code?: unknown };
  };
  if (!response.ok) {
    if (response.status === 404) throw new Error("profile_discovery_unavailable");
    const code = typeof payload.detail?.code === "string" ? payload.detail.code : "";
    if (PROFILE_DISCOVERY_ERROR_COPY[code]) throw new Error(PROFILE_DISCOVERY_ERROR_COPY[code]);
    throw new Error("Profile discovery is temporarily unavailable. Please retry.");
  }
  return payload.job ?? null;
}

export class PublicProfileDiscoveryService {
  static getStatus(token: string) {
    return requestJob("", { token });
  }

  static getReview(vaultOwnerToken: string) {
    return requestJob("/review", { token: vaultOwnerToken });
  }

  static start(token: string, input: DiscoveryStartInput) {
    return requestJob("/start", { token, method: "POST", body: input });
  }

  static submitAnchors(token: string, input: { name?: string; email?: string; profileUrl?: string; employer?: string; city?: string }) {
    return requestJob("/anchors", { token, method: "POST", body: input });
  }

  static saveEncryptedDraft(vaultOwnerToken: string, input: EncryptedPayload & { profileRevision: number }) {
    return requestJob("/draft", {
      token: vaultOwnerToken,
      method: "POST",
      body: {
        profileRevision: input.profileRevision,
        ciphertext: input.ciphertext,
        iv: input.iv,
        tag: input.tag,
        algorithm: input.algorithm,
      },
    });
  }

  static async prepareClaim(token: string, input: { profileRevision: number; operationKey: string; cards: Array<{ card_id: string; domain: string }> }): Promise<{ committed_card_ids: string[] }> {
    const response = await ApiService.apiFetch("/api/one/profile-discovery/claim/prepare", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error("The selected claim could not be prepared. Keep the selection unchanged and retry.");
    return response.json();
  }

  static completeClaim(
    vaultOwnerToken: string,
    input: { profileRevision: number; idempotencyKey: string; rejectAll: boolean; acceptedCount: number },
  ) {
    return requestJob("/claim", { token: vaultOwnerToken, method: "POST", body: input });
  }

  static cancel(token: string) {
    return requestJob("/cancel", { token, method: "POST", body: {} });
  }
}
