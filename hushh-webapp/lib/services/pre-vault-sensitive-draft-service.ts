"use client";

import {
  GEMINI_RUNTIME_CREDENTIAL_REF,
  GEMINI_RUNTIME_TRANSPORT_REF,
  GEMINI_VERTEX_LOCATION_REF,
  GEMINI_VERTEX_PROJECT_REF,
  PersonalKnowledgeModelService,
  RUNTIME_CREDENTIAL_MODE_REF,
  type GeminiRuntimeTransport,
} from "@/lib/services/personal-knowledge-model-service";

/**
 * Sensitive setup input has exactly one pre-vault home: process memory.
 *
 * This intentionally is not backed by IndexedDB, Preferences, localStorage,
 * a cookie, or a backend bootstrap record. A reload or sign-out discards the
 * draft; Finish setup encrypts it before any durable PKM write is attempted.
 */
export type PreVaultGeminiRuntimeDraft = {
  transport: GeminiRuntimeTransport;
  credential: string;
  vertexProject: string | null;
  vertexLocation: string | null;
};

/**
 * A finance action may be selected during setup, but its statement or broker
 * connection must not leave the device until Finish setup creates the private
 * vault. This is an intent only: it contains no parsed holdings, Plaid token,
 * or account record.
 */
export type PreVaultFinanceIntent =
  | { kind: "statement"; file: File }
  | { kind: "plaid"; environment: string | null }
  | { kind: "sample" };

const geminiDrafts = new Map<string, PreVaultGeminiRuntimeDraft>();
const financeIntents = new Map<string, PreVaultFinanceIntent>();
const finalizeInFlight = new Map<string, Promise<void>>();

function normalizeDraft(
  draft: PreVaultGeminiRuntimeDraft,
): PreVaultGeminiRuntimeDraft {
  return {
    transport: draft.transport,
    credential: draft.credential.trim(),
    vertexProject: draft.vertexProject?.trim() || null,
    vertexLocation: draft.vertexLocation?.trim() || null,
  };
}

function assertStored(result: { success: boolean; conflict?: boolean }): void {
  if (!result.success) {
    throw new Error(result.conflict ? "PKM_CONFLICT" : "PKM_WRITE_FAILED");
  }
}

export class PreVaultSensitiveDraftService {
  static stageGeminiRuntime(
    userId: string,
    draft: PreVaultGeminiRuntimeDraft,
  ): void {
    const normalized = normalizeDraft(draft);
    if (!userId || !normalized.credential) {
      throw new Error("A Gemini credential is required.");
    }
    geminiDrafts.set(userId, normalized);
  }

  static hasGeminiRuntime(userId: string): boolean {
    return geminiDrafts.has(userId);
  }

  static clearGeminiRuntime(userId: string): void {
    const draft = geminiDrafts.get(userId);
    if (draft) draft.credential = "";
    geminiDrafts.delete(userId);
  }

  static clearForUser(userId: string): void {
    this.clearGeminiRuntime(userId);
    this.clearFinanceIntent(userId);
  }

  static stageFinanceIntent(userId: string, intent: PreVaultFinanceIntent): void {
    if (!userId) throw new Error("A signed-in user is required.");
    if (intent.kind === "statement" && !(intent.file instanceof File)) {
      throw new Error("A statement file is required.");
    }
    financeIntents.set(userId, intent);
  }

  static hasFinanceIntent(userId: string): boolean {
    return financeIntents.has(userId);
  }

  /**
   * Consume only after vault finalization. Deleting before dispatch prevents a
   * second mount or warm-up from replaying an external connection or raw file.
   */
  static consumeFinanceIntent(userId: string): PreVaultFinanceIntent | null {
    const intent = financeIntents.get(userId) ?? null;
    financeIntents.delete(userId);
    return intent;
  }

  static clearFinanceIntent(userId: string): void {
    financeIntents.delete(userId);
  }

  /**
   * Encrypt the complete runtime choice before clearing the volatile origin.
   * All writes share the existing runtime-secret domain and are idempotent at
   * the PKM commit layer; a failure retains the in-memory draft for retry.
   */
  static async finalizeForVault(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): Promise<void> {
    const draft = geminiDrafts.get(params.userId);
    if (!draft) return;

    const existing = finalizeInFlight.get(params.userId);
    if (existing) return existing;

    const commit = (async () => {
      const confirmation = {
        confirmedByUser: true as const,
        surface: "web" as const,
        source: "one_setup_ai_access_finalize",
      };
      const secretRefs: Array<[string, string]> = [
        [GEMINI_RUNTIME_CREDENTIAL_REF, draft.credential],
        [GEMINI_RUNTIME_TRANSPORT_REF, draft.transport],
        [RUNTIME_CREDENTIAL_MODE_REF, "byok"],
      ];
      if (draft.vertexProject) {
        secretRefs.push([GEMINI_VERTEX_PROJECT_REF, draft.vertexProject]);
      }
      if (draft.vertexLocation) {
        secretRefs.push([GEMINI_VERTEX_LOCATION_REF, draft.vertexLocation]);
      }

      for (const [credentialRef, secret] of secretRefs) {
        const result = await PersonalKnowledgeModelService.storeRuntimeSecret({
          userId: params.userId,
          vaultKey: params.vaultKey,
          vaultOwnerToken: params.vaultOwnerToken,
          credentialRef,
          secret,
          confirmation,
        });
        assertStored(result);
      }

      this.clearGeminiRuntime(params.userId);
    })();

    finalizeInFlight.set(params.userId, commit);
    try {
      await commit;
    } finally {
      if (finalizeInFlight.get(params.userId) === commit) {
        finalizeInFlight.delete(params.userId);
      }
    }
  }
}
