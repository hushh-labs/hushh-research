// hushh-webapp/lib/services/legal-acceptance-service.ts
//
// Records which version of the Terms of Use and Privacy Policy a person
// accepted. The sign-in screen says "By continuing you agree to our Terms and
// Privacy Policy", with both linking to their full pages, so a successful
// sign-in is the acceptance and is recorded silently. There is no in-app
// re-acceptance prompt.
//
// A sign-in writes only when the served version is not already the person's
// latest acceptance: the first sign-in, and the first sign-in after a version
// change. Read-only reviewer automation never writes it; the account's next
// ordinary sign-in records the served version instead.
//
// The version identity is read from the legal document source, never typed
// here. `currentLegalDocumentVersions` is the single place that knows the
// source's shape.
import { Capacitor } from "@capacitor/core";
import type { User } from "firebase/auth";

import {
  LEGAL_DOCUMENTS,
  type LegalDocumentType,
} from "@/lib/legal/legal-documents";
import { apiJson } from "@/lib/services/api-client";
import { shouldSkipReviewerBackgroundWritesForAutomation } from "@/lib/testing/native-test";

export type LegalAcceptanceDocumentId = LegalDocumentType;
export type LegalAcceptanceSurface = "web" | "native";

export type LegalDocumentVersion = {
  document_id: LegalAcceptanceDocumentId;
  document_version: string;
  effective_date: string;
};

export type LegalAcceptanceRecord = LegalDocumentVersion & {
  accepted_at: string;
  surface: LegalAcceptanceSurface;
};

export type LegalAcceptanceState = {
  acceptances: LegalAcceptanceRecord[];
};

const LEGAL_ACCEPTANCE_PATH = "/api/account/legal-acceptance";
const LEGAL_DOCUMENT_IDS: readonly LegalAcceptanceDocumentId[] = ["terms", "privacy"];
const pendingSignInRecords = new Map<string, Promise<void>>();

/** The version and effective date of each document the app serves right now. */
export function currentLegalDocumentVersions(): LegalDocumentVersion[] {
  return LEGAL_DOCUMENT_IDS.map((documentId) => {
    const document = LEGAL_DOCUMENTS[documentId];
    return {
      document_id: documentId,
      document_version: document.version,
      effective_date: document.lastUpdated,
    };
  });
}

export function currentLegalAcceptanceSurface(): LegalAcceptanceSurface {
  return Capacitor.isNativePlatform() ? "native" : "web";
}

/**
 * True when the person's latest acceptance of every served document is the
 * served version. Versions are compared for equality, not order: labels may be
 * numbers or dates, and a mismatch in either direction means the person is now
 * agreeing to a text they have not accepted before.
 */
export function hasAcceptedCurrentLegalVersions(
  acceptances: readonly LegalDocumentVersion[],
): boolean {
  return currentLegalDocumentVersions().every((current) =>
    acceptances.some(
      (accepted) =>
        accepted.document_id === current.document_id &&
        accepted.document_version === current.document_version &&
        accepted.effective_date === current.effective_date,
    ),
  );
}

type AuthUser = Pick<User, "uid" | "getIdToken">;

function acceptanceState(
  payload: Partial<LegalAcceptanceState> | undefined,
): LegalAcceptanceState {
  return { acceptances: Array.isArray(payload?.acceptances) ? payload.acceptances : [] };
}

async function bearer(user: AuthUser): Promise<string> {
  const token = await user.getIdToken();
  if (!token) throw new Error("A signed-in session is required.");
  return token;
}

export const LegalAcceptanceService = {
  /** The person's latest accepted version of each document. */
  async getAcceptanceState(user: AuthUser): Promise<LegalAcceptanceState> {
    const token = await bearer(user);
    const payload = await apiJson<Partial<LegalAcceptanceState> | undefined>(
      LEGAL_ACCEPTANCE_PATH,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    );
    return acceptanceState(payload);
  },

  async recordAcceptance(user: AuthUser): Promise<LegalAcceptanceState> {
    const token = await bearer(user);
    const payload = await apiJson<Partial<LegalAcceptanceState> | undefined>(
      LEGAL_ACCEPTANCE_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          documents: currentLegalDocumentVersions(),
          surface: currentLegalAcceptanceSurface(),
        }),
      },
    );
    return acceptanceState(payload);
  },

  /**
   * Record the sign-in screen's agreement once the sign-in succeeds, only when
   * the served versions are not already the person's latest acceptance.
   *
   * Never throws: a failed read or write never blocks sign-in. A failed read
   * falls through to the write, which the server keeps idempotent per version,
   * so a real person's acceptance is never lost to a flaky read.
   *
   * Read-only, preparation-only and action-bounded reviewer automation shares
   * a fixture account and must not write it (the harness refuses any such
   * request). Skipping defers the record rather than dropping it: the account's
   * next ordinary sign-in still finds the served version missing and records it.
   */
  recordSignInAcceptance(user: AuthUser, interactive = true): Promise<void> {
    // Automated reviewer authentication is not a person's agreement.
    if (!interactive || shouldSkipReviewerBackgroundWritesForAutomation())
      return Promise.resolve();
    const existing = pendingSignInRecords.get(user.uid);
    if (existing) return existing;
    const pending = (async () => {
      const state = await this.getAcceptanceState(user).catch(() => null);
      if (state && hasAcceptedCurrentLegalVersions(state.acceptances)) return;
      await this.recordAcceptance(user);
    })()
      .catch(() => undefined)
      .finally(() => {
        if (pendingSignInRecords.get(user.uid) === pending) {
          pendingSignInRecords.delete(user.uid);
        }
      });
    pendingSignInRecords.set(user.uid, pending);
    return pending.then(() => undefined);
  },

  async waitForSignInRecord(userId: string): Promise<void> {
    await pendingSignInRecords.get(userId);
  },
};
