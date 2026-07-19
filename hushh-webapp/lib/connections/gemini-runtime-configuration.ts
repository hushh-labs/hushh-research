import {
  GEMINI_RUNTIME_CREDENTIAL_REF,
  GEMINI_RUNTIME_TRANSPORT_REF,
  GEMINI_VERTEX_LOCATION_REF,
  GEMINI_VERTEX_PROJECT_REF,
  PersonalKnowledgeModelService,
  RUNTIME_CREDENTIAL_MODE_REF,
  type GeminiRuntimeTransport,
  type RuntimeCredentialMode,
} from "@/lib/services/personal-knowledge-model-service";

export type GeminiRuntimeConnection = {
  mode: RuntimeCredentialMode;
  credential: string | null;
  transport: GeminiRuntimeTransport;
  vertexProject: string | null;
  vertexLocation: string | null;
};

type ResolveGeminiRuntimeConnectionInput = {
  userId?: string | null;
  vaultKey?: string | null;
  vaultOwnerToken?: string | null;
};

const GEMINI_RUNTIME_CONFIGURATION_CHANGED =
  "hushh:gemini-runtime-configuration-changed";

/**
 * Resolve a turn-local runtime choice from the encrypted vault.
 *
 * Managed Vertex is intentionally the safe default whenever the vault is not
 * available. A BYOK selection without its key is preserved as `byok` so the
 * backend can return a precise safe configuration error rather than quietly
 * consuming Hussh-managed credentials.
 */
export async function resolveGeminiRuntimeConnection({
  userId,
  vaultKey,
  vaultOwnerToken,
}: ResolveGeminiRuntimeConnectionInput): Promise<GeminiRuntimeConnection> {
  if (!userId || !vaultKey || !vaultOwnerToken) {
    return {
      mode: "hushh_managed_vertex",
      credential: null,
      transport: "developer_api",
      vertexProject: null,
      vertexLocation: null,
    };
  }

  let mode: string | null;
  try {
    mode = await PersonalKnowledgeModelService.loadRuntimeSecret({
      userId,
      vaultKey,
      vaultOwnerToken,
      credentialRef: RUNTIME_CREDENTIAL_MODE_REF,
    });
  } catch {
    // A mode that cannot be read is indistinguishable from no configuration.
    // Use the documented default instead of leaving a caller with an unhandled
    // vault-read failure.
    return {
      mode: "hushh_managed_vertex",
      credential: null,
      transport: "developer_api",
      vertexProject: null,
      vertexLocation: null,
    };
  }
  if (mode !== "byok") {
    return {
      mode: "hushh_managed_vertex",
      credential: null,
      transport: "developer_api",
      vertexProject: null,
      vertexLocation: null,
    };
  }
  let credential: string | null;
  let transport: string | null;
  let vertexProject: string | null;
  let vertexLocation: string | null;
  try {
    [credential, transport, vertexProject, vertexLocation] = await Promise.all([
      PersonalKnowledgeModelService.loadRuntimeSecret({
        userId,
        vaultKey,
        vaultOwnerToken,
        credentialRef: GEMINI_RUNTIME_CREDENTIAL_REF,
      }),
      PersonalKnowledgeModelService.loadRuntimeSecret({
        userId,
        vaultKey,
        vaultOwnerToken,
        credentialRef: GEMINI_RUNTIME_TRANSPORT_REF,
      }),
      PersonalKnowledgeModelService.loadRuntimeSecret({
        userId,
        vaultKey,
        vaultOwnerToken,
        credentialRef: GEMINI_VERTEX_PROJECT_REF,
      }),
      PersonalKnowledgeModelService.loadRuntimeSecret({
        userId,
        vaultKey,
        vaultOwnerToken,
        credentialRef: GEMINI_VERTEX_LOCATION_REF,
      }),
    ]);
  } catch {
    // Do not silently substitute Hussh-managed capacity after a user selected
    // BYOK. The caller will show the precise missing-key configuration state.
    return {
      mode: "byok",
      credential: null,
      transport: "developer_api",
      vertexProject: null,
      vertexLocation: null,
    };
  }
  return {
    mode: "byok",
    credential: credential?.trim() || null,
    // Existing encrypted BYOK values predate endpoint selection and are
    // deliberately interpreted as Google AI Studio keys.
    transport: transport === "vertex_api_key" ? "vertex_api_key" : "developer_api",
    vertexProject: vertexProject?.trim() || null,
    vertexLocation: vertexLocation?.trim() || null,
  };
}

/** Notify in-memory voice clients that an active BYOK session must end. */
export function notifyGeminiRuntimeConfigurationChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(GEMINI_RUNTIME_CONFIGURATION_CHANGED));
}

export function onGeminiRuntimeConfigurationChanged(
  listener: () => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(GEMINI_RUNTIME_CONFIGURATION_CHANGED, listener);
  return () =>
    window.removeEventListener(GEMINI_RUNTIME_CONFIGURATION_CHANGED, listener);
}
