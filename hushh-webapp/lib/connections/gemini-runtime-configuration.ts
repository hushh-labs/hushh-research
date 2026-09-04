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

type UnlockedGeminiRuntimeConnectionInput = {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
};

const GEMINI_RUNTIME_CONFIGURATION_CHANGED =
  "hushh:gemini-runtime-configuration-changed";
const RUNTIME_CONFIGURATION_TTL_MS = 5 * 60 * 1000;

type RuntimeCacheEntry = {
  value: GeminiRuntimeConnection;
  expiresAt: number;
};

const runtimeCache = new Map<string, RuntimeCacheEntry>();
const runtimeInFlight = new Map<string, Promise<GeminiRuntimeConnection>>();
let runtimeCacheGeneration = 0;

function managedRuntimeDefault(): GeminiRuntimeConnection {
  return {
    mode: "hushh_managed_vertex",
    credential: null,
    transport: "developer_api",
    vertexProject: null,
    vertexLocation: null,
  };
}

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
    return managedRuntimeDefault();
  }

  const cacheKey = userId;
  const cached = runtimeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) runtimeCache.delete(cacheKey);

  const existing = runtimeInFlight.get(cacheKey);
  if (existing) return existing;

  const generation = runtimeCacheGeneration;
  const promise = resolveUnlockedGeminiRuntimeConnection({
    userId,
    vaultKey,
    vaultOwnerToken,
  })
    .then((value) => {
      // A lock, identity change, or configuration mutation invalidates an
      // in-flight vault read. Never let its credential repopulate memory.
      if (generation !== runtimeCacheGeneration) return managedRuntimeDefault();
      runtimeCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + RUNTIME_CONFIGURATION_TTL_MS,
      });
      return value;
    })
    .finally(() => {
      if (runtimeInFlight.get(cacheKey) === promise) {
        runtimeInFlight.delete(cacheKey);
      }
    });
  runtimeInFlight.set(cacheKey, promise);
  return promise;
}

async function resolveUnlockedGeminiRuntimeConnection({
  userId,
  vaultKey,
  vaultOwnerToken,
}: UnlockedGeminiRuntimeConnectionInput): Promise<GeminiRuntimeConnection> {

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
    return managedRuntimeDefault();
  }
  if (mode !== "byok") {
    return managedRuntimeDefault();
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

/** Erase cached and in-flight runtime material synchronously. */
export function clearGeminiRuntimeConnectionCache(userId?: string | null): void {
  runtimeCacheGeneration += 1;
  if (userId) {
    runtimeCache.delete(userId);
    runtimeInFlight.delete(userId);
    return;
  }
  runtimeCache.clear();
  runtimeInFlight.clear();
}

/** Best-effort single-flight warmup after unlock; never persists credentials. */
export async function warmGeminiRuntimeConnection(
  input: UnlockedGeminiRuntimeConnectionInput,
): Promise<void> {
  await resolveGeminiRuntimeConnection(input);
}

/** Notify in-memory voice clients that an active BYOK session must end. */
export function notifyGeminiRuntimeConfigurationChanged(userId?: string | null): void {
  clearGeminiRuntimeConnectionCache(userId);
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
