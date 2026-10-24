/**
 * The person's private agent as the authority for "Bring your own AI".
 *
 * The agent checks the key live and then uses exactly that selection for every
 * turn; there is no fallback to managed models. Requests go owner-direct
 * through `ApiService.ownerPodRequest`, which seals a PUT body to the agent's
 * hub-signed key (`pod-app-access.ts`), so no plaintext key reaches the hub.
 */
import { readUpdateStatus } from "@/lib/feed/agent-update-status";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { ApiService } from "@/lib/services/api-service";
import { ownerCloudProvider } from "./owner-cloud";
import type {
  AiSelectionPlaintext,
  AiSelectionProvider,
} from "./ai-selection-seal";
import {
  recordSelectedAiProvider,
  type AiSelectionVault,
} from "./ai-selection-vault";

type AgentStatus = Awaited<
  ReturnType<typeof ApiService.getPersonalAgentStatus>
>;

export const UNVERIFIED_GEMINI_KEY_MESSAGE = "Gemini keys are unavailable for your private agent because their processing terms have not been verified. Use your verified Google Cloud connection.";

export type AgentAiUpdateOffer = {
  releaseId: string | null;
  deploymentTarget: string | null;
  installable: boolean;
  working: boolean;
};

export type AgentAiReadiness =
  | { kind: "unknown" }
  | { kind: "no_agent" }
  | { kind: "agent_pending" }
  | { kind: "processing_terms_unverified" }
  | { kind: "needs_update"; update: AgentAiUpdateOffer }
  | { kind: "ready" };

export type AgentAiSelection = {
  configured: boolean;
  provider: string | null;
  model: string | null;
  checkedAtMs: number | null;
  lastFailure: string | null;
};

export const AI_SELECTION_REFUSAL_CODES = [
  "KEY_REFUSED",
  "QUOTA_EXCEEDED",
  "MODEL_UNAVAILABLE",
  "PROVIDER_UNREACHABLE",
  "PROVIDER_UNSUPPORTED",
  "STALE_SELECTION",
  "BAD_ENVELOPE",
  "AI_DEFAULT_UNAVAILABLE",
] as const;
export type AiSelectionRefusalCode =
  | (typeof AI_SELECTION_REFUSAL_CODES)[number]
  | "AGENT_UNREACHABLE"
  | "AGENT_KEY_CHANGED"
  | "DEVICE_UNSUPPORTED";

export type AiSelectionOutcome =
  | {
      ok: true;
      provider: string;
      model: string | null;
      checkedAtMs: number | null;
    }
  | { ok: false; code: AiSelectionRefusalCode };

function captureAiOwner(expectedUserId?: string): () => boolean {
  const owner = snapshotValidatedAuthSessionOwner();
  return () => !!owner && (!expectedUserId || owner.userId === expectedUserId) && isValidatedAuthSessionOwnerCurrent(owner);
}

/** The hub's agent status, or null when it cannot be read. */
async function readAgentStatus(): Promise<AgentStatus | null> {
  try {
    return await ApiService.getPersonalAgentStatus();
  } catch {
    return null;
  }
}

/** C3: `aiSelection` on the agent status; null or missing means an older agent. */
export function advertisedAiProviders(status: unknown): string[] | null {
  const value = (status as { aiSelection?: unknown } | null)?.aiSelection;
  if (!value || typeof value !== "object") return null;
  const { version, providers } = value as {
    version?: unknown;
    providers?: unknown;
  };
  if (
    !Number.isInteger(version) ||
    Number(version) < 1 ||
    !Array.isArray(providers)
  )
    return null;
  return providers.filter(
    (provider): provider is string => typeof provider === "string",
  );
}

export function agentAiReadiness(
  status: AgentStatus | null,
  provider: AiSelectionProvider,
): AgentAiReadiness {
  if (!status) return { kind: "unknown" };
  const mode = status.hostingMode;
  if (mode === "pending") return { kind: "agent_pending" };
  if (mode === "shared" || !mode) return { kind: "no_agent" };
  if (mode !== "byoc" && mode !== "hussh_pods") return { kind: "unknown" };
  if (status.aiSelection?.unavailableProviders?.[provider] === "processing_terms_unverified")
    return { kind: "processing_terms_unverified" };
  if (advertisedAiProviders(status)?.includes(provider))
    return { kind: "ready" };
  if (status.state && status.state !== "active")
    return { kind: "agent_pending" };
  const update = readUpdateStatus(status);
  const working =
    !update.failed &&
    update.presentationState !== "blocked" &&
    (update.inProgress ||
      ["scheduled", "updating"].includes(update.presentationState ?? ""));
  return {
    kind: "needs_update",
    update: {
      releaseId: update.releaseId,
      deploymentTarget: status.deploymentTarget ?? null,
      // Older hubs expose only offerability; an explicit refusal always wins.
      installable:
        (status.updateInstallable ?? status.updateOfferable) === true &&
        Boolean(update.releaseId),
      working,
    },
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseAgentAiSelection(body: unknown): AgentAiSelection | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const failure = value.lastFailure;
  const failureCode =
    failure && typeof failure === "object"
      ? textOrNull((failure as Record<string, unknown>).code)
      : textOrNull(failure);
  return {
    configured: value.configured === true,
    provider: textOrNull(value.provider),
    model: textOrNull(value.model),
    checkedAtMs: finiteOrNull(value.checkedAtMs),
    lastFailure: failureCode,
  };
}

export async function readAgentAiSelection(isCurrent = captureAiOwner()): Promise<AgentAiSelection | null> {
  if (!isCurrent()) throw new Error("OWNER_CHANGED");
  const response = await ApiService.ownerPodRequest("ai-selection", {
    method: "GET",
    cache: "no-store",
  }, false, undefined, undefined, isCurrent);
  if (!isCurrent()) throw new Error("OWNER_CHANGED");
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!isCurrent()) throw new Error("OWNER_CHANGED");
  return parseAgentAiSelection(body);
}

/** Readiness for one provider plus the agent's current selection, when it has one. */
export async function loadAgentAiState(provider: AiSelectionProvider): Promise<{
  readiness: AgentAiReadiness;
  selection: AgentAiSelection | null;
}> {
  const isCurrent = captureAiOwner();
  const status = await readAgentStatus();
  if (!isCurrent()) return { readiness: { kind: "unknown" }, selection: null };
  const readiness = agentAiReadiness(status, provider);
  if (advertisedAiProviders(status) === null)
    return { readiness, selection: null };
  const selection = await readAgentAiSelection(isCurrent).catch(() => null);
  return isCurrent() ? { readiness, selection } : { readiness: { kind: "unknown" }, selection: null };
}

function refusalFromResponse(
  status: number,
  body: unknown,
): AiSelectionRefusalCode {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const detail =
    record.detail && typeof record.detail === "object"
      ? (record.detail as Record<string, unknown>)
      : record;
  const code = String(detail.code ?? record.code ?? "");
  if ((AI_SELECTION_REFUSAL_CODES as readonly string[]).includes(code))
    return code as AiSelectionRefusalCode;
  // An agent that predates the route cannot take a sealed selection at all.
  if (status === 404 || status === 405) return "PROVIDER_UNSUPPORTED";
  return "AGENT_UNREACHABLE";
}

function refusalFromError(error: unknown): AiSelectionRefusalCode {
  const code =
    error instanceof Error
      ? "code" in error && typeof error.code === "string"
        ? error.code
        : error.message
      : "";
  if (code === "DEVICE_UNSUPPORTED") return "DEVICE_UNSUPPORTED";
  if (code === "AGENT_KEY_MISMATCH" || code === "AGENT_KEY_UNAVAILABLE")
    return "AGENT_KEY_CHANGED";
  return "AGENT_UNREACHABLE";
}

/** PUT the selection; the agent's live provider check is the validation. */
export async function sendAiSelectionToAgent(
  selection: AiSelectionPlaintext,
  isCurrent = captureAiOwner(),
): Promise<AiSelectionOutcome> {
  if (!isCurrent()) return { ok: false, code: "AGENT_UNREACHABLE" };
  let response: Response;
  try {
    response = await ApiService.ownerPodRequest("ai-selection", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      // pod-app-access seals this body to the agent's hub-signed key before dispatch.
      body: JSON.stringify(selection),
    }, false, undefined, undefined, isCurrent);
  } catch (error) {
    return { ok: false, code: refusalFromError(error) };
  }
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!isCurrent()) return { ok: false, code: "AGENT_UNREACHABLE" };
  if (response.ok && body?.status === "active") {
    return {
      ok: true,
      provider: textOrNull(body.provider) ?? selection.provider,
      model: textOrNull(body.model),
      checkedAtMs: finiteOrNull(body.checkedAtMs),
    };
  }
  return { ok: false, code: refusalFromResponse(response.status, body) };
}

export async function clearAgentAiSelection(
  verifyDefault = false,
  expectedProvider?: string,
  isCurrent = captureAiOwner(),
): Promise<boolean> {
  if (!isCurrent()) return false;
  try {
    const response = await ApiService.ownerPodRequest("ai-selection", {
      method: verifyDefault ? "PATCH" : "DELETE",
    }, false, undefined, undefined, isCurrent);
    if (!isCurrent() || !response.ok) return false;
    if (!verifyDefault) return true;
    const body = await response.json().catch(() => null);
    return (
      isCurrent() && body?.status === "cleared" &&
      typeof body.defaultModel === "string" &&
      body.defaultModel.trim().length > 0 &&
      typeof body.checkedAtMs === "number" &&
      Number.isFinite(body.checkedAtMs) &&
      body.checkedAtMs > 0 &&
      body.defaultProvider === expectedProvider
    );
  } catch {
    return false;
  }
}

/** Verify the cloud default without discarding the provider's typed refusal. */
export async function verifyAgentCloudAi(): Promise<AiSelectionOutcome> {
  const owner = snapshotValidatedAuthSessionOwner();
  if (!owner) return { ok: false, code: "AGENT_UNREACHABLE" };
  const status = await readAgentStatus();
  if (!isValidatedAuthSessionOwnerCurrent(owner))
    return { ok: false, code: "AGENT_UNREACHABLE" };
  const provider = ownerCloudProvider(status?.deploymentTarget);
  const knownPlacement = (status?.hostingMode === "byoc" && provider !== null) ||
    (status?.hostingMode === "hussh_pods" && status.deploymentTarget === "gcp");
  if (!status || !knownPlacement || status.state !== "active")
    return { ok: false, code: "AGENT_UNREACHABLE" };
  // A missing heartbeat advert is unread evidence, not a refusal by the pod.
  // The explicit owner action uses its admitted configuration door; old images
  // still refuse with 404/405 and provider/owner/incarnation checks remain intact.
  const expectedProvider = provider === "azure" ? "azure_openai" : "gemini";
  try {
    const response = await ApiService.ownerPodRequest("ai-selection", { method: "PATCH" }, false, undefined, undefined, () => isValidatedAuthSessionOwnerCurrent(owner));
    const body = await response.json().catch(() => null);
    if (!isValidatedAuthSessionOwnerCurrent(owner)) return { ok: false, code: "AGENT_UNREACHABLE" };
    if (!response.ok) return { ok: false, code: refusalFromResponse(response.status, body) };
    const model = textOrNull(body?.defaultModel);
    const checkedAtMs = finiteOrNull(body?.checkedAtMs);
    if (body?.status !== "cleared" || body.defaultProvider !== expectedProvider ||
        !model || checkedAtMs === null || checkedAtMs <= 0)
      return { ok: false, code: "AGENT_UNREACHABLE" };
    return { ok: true, provider: expectedProvider, model, checkedAtMs };
  } catch (error) {
    return { ok: false, code: refusalFromError(error) };
  }
}

export function aiSelectionRefusalMessage(
  code: string,
  providerName: string,
): string | null {
  switch (code) {
    case "AI_DEFAULT_UNAVAILABLE":
      return "Your cloud AI is not set up. Connect your own key or finish setting up model access in your cloud.";
    case "KEY_REFUSED":
      return `${providerName} did not accept this key. Check it and try again.`;
    case "QUOTA_EXCEEDED":
      return `This ${providerName} key is out of quota. Check your ${providerName} account, then try again.`;
    case "MODEL_UNAVAILABLE":
      return `This ${providerName} key cannot use the selected model. Check your ${providerName} account, then try again.`;
    case "PROVIDER_UNREACHABLE":
      return `${providerName} could not be reached. Try again in a moment.`;
    case "PROVIDER_UNSUPPORTED":
      return `Your agent needs an update to use ${providerName}.`;
    case "STALE_SELECTION":
      return "This setting changed on another device. Try again.";
    case "BAD_ENVELOPE":
      return "Your agent could not read this request. Refresh the app and try again.";
    case "AGENT_KEY_CHANGED":
      return "Your private agent's connection changed. Try again.";
    case "DEVICE_UNSUPPORTED":
      return "This device cannot protect your key for your agent. Update your browser or device, then try again.";
    case "AGENT_UNREACHABLE":
      return "Your private agent could not be reached. Try again in a moment.";
    default:
      return null;
  }
}

/**
 * After the Gemini own key is saved, hand it to an agent that takes sealed
 * selections. Returns plain copy when the agent refused it, otherwise null
 * (including for an agent that cannot take one, which keeps today's path).
 */
export async function shareGeminiSelectionWithAgent(
  input: AiSelectionVault & {
    credential: string;
    transport: "developer_api" | "vertex_api_key";
    vertexProject: string | null;
    vertexLocation: string | null;
  },
): Promise<string | null> {
  const isCurrent = captureAiOwner(input.userId);
  if (!isCurrent()) return "Your account changed. Try again.";
  const status = await readAgentStatus();
  if (!isCurrent()) return "Your account changed. Try again.";
  if (status?.aiSelection?.unavailableProviders?.gemini === "processing_terms_unverified")
    return UNVERIFIED_GEMINI_KEY_MESSAGE;
  if (!advertisedAiProviders(status)?.includes("gemini")) return null;
  const outcome = await sendAiSelectionToAgent({
    provider: "gemini",
    model: null,
    apiKey: input.credential,
    transport: input.transport,
    vertexProject:
      input.transport === "vertex_api_key" ? input.vertexProject : null,
    vertexLocation:
      input.transport === "vertex_api_key" ? input.vertexLocation : null,
  }, isCurrent);
  if (!isCurrent()) return "Your account changed. Try again.";
  if (!outcome.ok) return aiSelectionRefusalMessage(outcome.code, "Gemini");
  await recordSelectedAiProvider(input, "gemini", null, isCurrent).catch(() => undefined);
  return null;
}

/**
 * Stop the agent using a sealed selection. `onlyProvider` limits it to that
 * provider (removing the Gemini key must never clear an active OpenAI choice).
 */
export async function clearAgentAiSelectionFor(
  onlyProvider: AiSelectionProvider | null,
  verifyDefault = false,
): Promise<"cleared" | "not_needed" | "failed"> {
  const isCurrent = captureAiOwner();
  if (!isCurrent()) return "failed";
  const status = await readAgentStatus();
  if (!isCurrent()) return "failed";
  if (advertisedAiProviders(status) === null)
    return verifyDefault ? "failed" : "not_needed";
  if (onlyProvider) {
    const current = await readAgentAiSelection(isCurrent).catch(() => undefined);
    if (!isCurrent() || current === undefined) return "failed";
    if (!current?.configured || current.provider !== onlyProvider)
      return "not_needed";
  }
  if (verifyDefault && status?.aiSelection?.defaultVerification !== true)
    return "failed";
  const expectedProvider =
    status?.deploymentTarget === "user_azure" ? "azure_openai" : "gemini";
  return (await clearAgentAiSelection(verifyDefault, expectedProvider, isCurrent))
    ? "cleared"
    : "failed";
}
