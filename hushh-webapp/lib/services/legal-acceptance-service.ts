// hushh-webapp/lib/services/legal-acceptance-service.ts
//
// Records which version of the Terms of Use and Privacy Policy a person
// accepted, and tells the app when the stored record is behind the documents
// the app currently serves.
//
// The version identity is read from the legal document source, never typed
// here, so a text change that bumps the document's version or date is the only
// thing that triggers a re-acceptance prompt. `currentLegalDocumentVersions`
// is the single place that knows the source's shape.
import { Capacitor } from "@capacitor/core";
import type { User } from "firebase/auth";

import {
  LEGAL_DOCUMENTS,
  type LegalDocumentType,
} from "@/lib/legal/legal-documents";
import { apiJson } from "@/lib/services/api-client";

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

/** Why a prompt is shown: never accepted, or accepted an older version. */
export type LegalAcceptanceRequirement = "none" | "first_acceptance" | "updated";

const LEGAL_ACCEPTANCE_PATH = "/api/account/legal-acceptance";
const LEGAL_DOCUMENT_IDS: readonly LegalAcceptanceDocumentId[] = ["terms", "privacy"];

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

/**
 * Compare the stored record with the served documents. Any difference in a
 * document's version or effective date counts as a change: version strings are
 * opaque, so "older" is decided by inequality, never by ordering.
 */
export function resolveLegalAcceptanceRequirement(
  state: LegalAcceptanceState,
  current: readonly LegalDocumentVersion[] = currentLegalDocumentVersions(),
): LegalAcceptanceRequirement {
  if (state.acceptances.length === 0) return "first_acceptance";
  const accepted = new Map(
    state.acceptances.map((record) => [record.document_id, record]),
  );
  for (const document of current) {
    const record = accepted.get(document.document_id);
    if (!record) return "first_acceptance";
    if (
      record.document_version !== document.document_version ||
      record.effective_date !== document.effective_date
    ) {
      return "updated";
    }
  }
  return "none";
}

export function currentLegalAcceptanceSurface(): LegalAcceptanceSurface {
  return Capacitor.isNativePlatform() ? "native" : "web";
}

type AuthUser = Pick<User, "uid" | "getIdToken">;

async function bearer(user: AuthUser): Promise<string> {
  const token = await user.getIdToken();
  if (!token) throw new Error("A signed-in session is required.");
  return token;
}

// Sign-in records acceptance in the background. The prompt waits for that
// write, so a person who just agreed on the sign-in screen is not asked again.
const pendingSignInRecords = new Map<string, Promise<unknown>>();

export const LegalAcceptanceService = {
  async fetchState(user: AuthUser): Promise<LegalAcceptanceState> {
    const token = await bearer(user);
    const payload = await apiJson<Partial<LegalAcceptanceState> | undefined>(
      LEGAL_ACCEPTANCE_PATH,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    );
    return { acceptances: Array.isArray(payload?.acceptances) ? payload.acceptances : [] };
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
    return { acceptances: Array.isArray(payload?.acceptances) ? payload.acceptances : [] };
  },

  /**
   * The sign-in screen says "By continuing you agree to our Terms and Privacy
   * Policy". Record that agreement once the sign-in succeeds. Never throws: a
   * failed write only means the prompt asks again later.
   */
  recordSignInAcceptance(user: AuthUser): Promise<void> {
    const pending = this.recordAcceptance(user)
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
