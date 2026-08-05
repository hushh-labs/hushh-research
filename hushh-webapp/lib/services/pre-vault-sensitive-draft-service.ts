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
import {
  addSavedLocation,
  defaultLabelForCategory,
  DuplicateSavedLocationError,
  loadSavedLocations,
  type SavedLocationCategory,
} from "@/lib/one-location/saved-locations";

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

export type PreVaultSavedLocationDraft = {
  category: SavedLocationCategory;
  label: string;
  latitude: number;
  longitude: number;
  address: string | null;
};

const geminiDrafts = new Map<string, PreVaultGeminiRuntimeDraft>();
const financeIntents = new Map<string, PreVaultFinanceIntent>();
const savedLocationDrafts = new Map<string, PreVaultSavedLocationDraft>();
const finalizeInFlight = new Map<string, Promise<void>>();
const savedLocationGenerations = new Map<string, number>();
const userClearEpochs = new Map<string, number>();

function nextCounter(counter: Map<string, number>, userId: string): number {
  const next = (counter.get(userId) ?? 0) + 1;
  counter.set(userId, next);
  return next;
}

function currentCounter(counter: Map<string, number>, userId: string): number {
  return counter.get(userId) ?? 0;
}

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

function normalizeSavedLocationDraft(
  draft: PreVaultSavedLocationDraft,
): PreVaultSavedLocationDraft {
  if (
    !Number.isFinite(draft.latitude) ||
    draft.latitude < -90 ||
    draft.latitude > 90 ||
    !Number.isFinite(draft.longitude) ||
    draft.longitude < -180 ||
    draft.longitude > 180
  ) {
    throw new Error("Choose a valid location before continuing.");
  }
  return {
    category: draft.category,
    label: draft.label.trim().slice(0, 40),
    latitude: draft.latitude,
    longitude: draft.longitude,
    address: draft.address?.trim().slice(0, 300) || null,
  };
}

async function matchesPersistedSavedLocation(params: {
  context: { userId: string; vaultKey: string; vaultOwnerToken: string };
  draft: PreVaultSavedLocationDraft;
}): Promise<boolean> {
  const expectedLabel =
    params.draft.label || defaultLabelForCategory(params.draft.category);
  const expectedAddress = params.draft.address?.trim() || null;
  const locations = await loadSavedLocations(params.context);
  return locations.some(
    (location) =>
      location.category === params.draft.category &&
      location.label === expectedLabel &&
      location.latitude === params.draft.latitude &&
      location.longitude === params.draft.longitude &&
      (location.address?.trim() || null) === expectedAddress,
  );
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
    // Invalidate captured snapshots before deleting them. A finalizer already
    // awaiting another encrypted write must not dispatch this user's remaining
    // sensitive drafts after sign-out/account switch.
    nextCounter(userClearEpochs, userId);
    this.clearGeminiRuntime(userId);
    this.clearFinanceIntent(userId);
    this.clearSavedLocation(userId);
  }

  static stageFinanceIntent(
    userId: string,
    intent: PreVaultFinanceIntent,
  ): void {
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

  static stageSavedLocation(
    userId: string,
    draft: PreVaultSavedLocationDraft,
  ): void {
    if (!userId) throw new Error("A signed-in user is required.");
    nextCounter(savedLocationGenerations, userId);
    savedLocationDrafts.set(userId, normalizeSavedLocationDraft(draft));
  }

  static hasSavedLocation(userId: string): boolean {
    return savedLocationDrafts.has(userId);
  }

  static clearSavedLocation(userId: string): void {
    nextCounter(savedLocationGenerations, userId);
    savedLocationDrafts.delete(userId);
  }

  /**
   * Commit every sensitive setup draft through its existing encrypted domain
   * before clearing the volatile origin. A failed write retains only the
   * unfinished in-memory draft for a safe retry.
   */
  static finalizeForVault(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): Promise<void> {
    const previous = finalizeInFlight.get(params.userId);
    const commit = (async () => {
      if (previous) {
        // A later vault session must not inherit the earlier caller's result.
        // Wait for that attempt (including cancellation/failure), then replay
        // the still-current drafts with this caller's authority.
        try {
          await previous;
        } catch {
          // The previous caller receives its own failure. A queued caller is a
          // deliberate retry and must still get a chance to persist the draft.
        }
      }
      await this.finalizeCurrentDrafts(params);
    })();

    finalizeInFlight.set(params.userId, commit);
    return commit.finally(() => {
      if (finalizeInFlight.get(params.userId) === commit) {
        finalizeInFlight.delete(params.userId);
      }
    });
  }

  private static async finalizeCurrentDrafts(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): Promise<void> {
    if (
      !geminiDrafts.has(params.userId) &&
      !savedLocationDrafts.has(params.userId)
    ) {
      return;
    }

    const finalizationEpoch = currentCounter(userClearEpochs, params.userId);
    const wasCancelled = () =>
      currentCounter(userClearEpochs, params.userId) !== finalizationEpoch;

    commitLoop: while (!wasCancelled()) {
      const geminiDraft = geminiDrafts.get(params.userId);
      if (geminiDraft) {
        const confirmation = {
          confirmedByUser: true as const,
          surface: "web" as const,
          source: "one_setup_ai_access_finalize",
        };
        const secretRefs: Array<[string, string]> = [
          [GEMINI_RUNTIME_CREDENTIAL_REF, geminiDraft.credential],
          [GEMINI_RUNTIME_TRANSPORT_REF, geminiDraft.transport],
          [RUNTIME_CREDENTIAL_MODE_REF, "byok"],
        ];
        if (geminiDraft.vertexProject) {
          secretRefs.push([
            GEMINI_VERTEX_PROJECT_REF,
            geminiDraft.vertexProject,
          ]);
        }
        if (geminiDraft.vertexLocation) {
          secretRefs.push([
            GEMINI_VERTEX_LOCATION_REF,
            geminiDraft.vertexLocation,
          ]);
        }

        for (const [credentialRef, secret] of secretRefs) {
          if (wasCancelled()) return;
          if (geminiDrafts.get(params.userId) !== geminiDraft) {
            continue commitLoop;
          }
          const result = await PersonalKnowledgeModelService.storeRuntimeSecret(
            {
              userId: params.userId,
              vaultKey: params.vaultKey,
              vaultOwnerToken: params.vaultOwnerToken,
              credentialRef,
              secret,
              confirmation,
            },
          );
          assertStored(result);
        }

        if (wasCancelled()) return;
        if (geminiDrafts.get(params.userId) === geminiDraft) {
          this.clearGeminiRuntime(params.userId);
        } else {
          continue;
        }
      }

      if (wasCancelled()) return;
      const savedLocationDraft = savedLocationDrafts.get(params.userId);
      if (savedLocationDraft) {
        const locationGeneration = currentCounter(
          savedLocationGenerations,
          params.userId,
        );
        if (
          wasCancelled() ||
          savedLocationDrafts.get(params.userId) !== savedLocationDraft
        ) {
          continue;
        }
        try {
          await addSavedLocation({
            context: params,
            input: savedLocationDraft,
          });
        } catch (error) {
          const exactRetry =
            error instanceof DuplicateSavedLocationError &&
            error.existingCategory === savedLocationDraft.category &&
            (await matchesPersistedSavedLocation({
              context: params,
              draft: savedLocationDraft,
            }));
          if (!exactRetry) throw error;
        }

        if (wasCancelled()) return;
        if (
          currentCounter(savedLocationGenerations, params.userId) !==
            locationGeneration ||
          savedLocationDrafts.get(params.userId) !== savedLocationDraft
        ) {
          continue;
        }
        this.clearSavedLocation(params.userId);
      }

      if (
        !geminiDrafts.has(params.userId) &&
        !savedLocationDrafts.has(params.userId)
      ) {
        return;
      }
    }
  }
}
