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
  source: "user" | "deployment" | "fallback";
  choices: ModelChoice[];
};

const ENDPOINT = "/api/one/models/preference";

async function readOrThrow(response: Response): Promise<ModelPreference> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Model preference request failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return (await response.json()) as ModelPreference;
}

export const ModelPreferenceService = {
  async get(idToken: string): Promise<ModelPreference> {
    return readOrThrow(
      await fetch(ENDPOINT, {
        method: "GET",
        headers: { Authorization: `Bearer ${idToken}` },
        cache: "no-store",
      }),
    );
  },

  /** Pass null to clear the choice and follow the deployment default again. */
  async set(idToken: string, modelId: string | null): Promise<ModelPreference> {
    return readOrThrow(
      await fetch(ENDPOINT, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model_id: modelId }),
      }),
    );
  },
};
