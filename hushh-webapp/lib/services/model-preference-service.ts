import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { readAgentAiSelection } from "@/lib/one/ai-selection-agent";
import { ApiService } from "@/lib/services/api-service";
import { usesOwnerPod } from "@/lib/services/pod-app-access";

/**
 * Which model runs this person's agent.
 *
 * The catalog is served, never compiled in: the backend resolves the choice at
 * call time (person > lane > proven default) and returns what may be chosen,
 * what this person chose, and what is actually running. A new generation
 * therefore reaches this picker without a client release.
 */

export type ModelChoice = {
  model_id: string;
  label: string;
  is_default: boolean;
  is_active: boolean;
};

export type ModelPreference = {
  user_id: string;
  selected_model: string | null;
  effective_model: string;
  source: "user" | "deployment" | "fallback" | "administrator_policy" | "owner_pod";
  choices: ModelChoice[];
  effective_provider?: string;
  verification?: "unverified" | "previously_verified";
};

const ENDPOINT = "/api/one/models/preference";

async function readOrThrow(response: Response, ownerId: string): Promise<ModelPreference> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Model preference request failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  const value = (await response.json()) as ModelPreference;
  if (value.user_id !== ownerId) throw new Error("MODEL_PREFERENCE_OWNER_CHANGED");
  return value;
}

async function modelAccess(isCurrent: () => boolean) {
  const owner = snapshotValidatedAuthSessionOwner();
  const current = () => !!owner && isCurrent() && isValidatedAuthSessionOwnerCurrent(owner);
  if (!owner || !current()) throw new Error("MODEL_PREFERENCE_OWNER_CHANGED");
  const privateAgent = await usesOwnerPod(() => ApiService.getPersonalAgentStatus());
  if (!current()) throw new Error("MODEL_PREFERENCE_OWNER_CHANGED");
  return { ownerId: owner.userId, privateAgent, current };
}

export const ModelPreferenceService = {
  async get(idToken: string, isCurrent = () => true): Promise<ModelPreference | null> {
    const access = await modelAccess(isCurrent);
    if (access.privateAgent) {
      const selection = await readAgentAiSelection(access.current);
      if (!access.current()) throw new Error("MODEL_PREFERENCE_OWNER_CHANGED");
      // A pod owns its connection. Its current selection is not an admitted
      // multi-model catalog; missing/old-image metadata never borrows Shared's.
      if (!selection) return null;
      const effective = selection.effectiveConnection;
      if (effective) {
        if (effective.state !== "configured" || !effective.model || !effective.provider || effective.verification === "failed") return null;
        return { user_id: access.ownerId, selected_model: selection.model,
          effective_model: effective.model, effective_provider: effective.provider,
          verification: effective.verification, source: "owner_pod", choices: [] };
      }
      if (!selection.configured || !selection.model || selection.lastFailure) return null;
      return { user_id: access.ownerId, selected_model: selection.model,
        effective_model: selection.model, source: "owner_pod", choices: [] };
    }
    const value = await readOrThrow(
      await fetch(ENDPOINT, {
        method: "GET",
        headers: { Authorization: `Bearer ${idToken}` },
        cache: "no-store",
      }), access.ownerId,
    );
    if (!access.current()) throw new Error("MODEL_PREFERENCE_OWNER_CHANGED");
    return value;
  },

  /** Pass null to clear the choice and follow the deployment default again. */
  async set(idToken: string, modelId: string | null, isCurrent = () => true): Promise<ModelPreference> {
    const access = await modelAccess(isCurrent);
    if (access.privateAgent) throw new Error("OWNER_POD_MODEL_SELECTION_SETTINGS");
    const value = await readOrThrow(
      await fetch(ENDPOINT, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model_id: modelId }),
      }), access.ownerId,
    );
    if (!access.current()) throw new Error("MODEL_PREFERENCE_OWNER_CHANGED");
    return value;
  },
};
