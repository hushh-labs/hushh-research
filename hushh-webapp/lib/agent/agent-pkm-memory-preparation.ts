/** Owner placement and secret admission for Memory preparation; never persists information. */
import type {
  AgentPkmPreviewResponse,
  AgentPkmPreviewCard,
} from "@/lib/agent/agent-pkm-memory";
import type { PkmReconciliationCandidate } from "@/lib/agent/agent-pkm-context-store";
import { ApiService } from "@/lib/services/api-service";
import { ownerContentIsPrivate } from "@/lib/services/private-agent-specialist-chat";
import { placementRefusalMessage } from "@/lib/agent/owner-pod-turn-errors";
import { AuthService } from "@/lib/services/auth-service";
import { assertNoUnguardedSecrets } from "@/lib/pkm/secret-span-guard";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

export type AgentPkmPreparationInput = {
  userId: string;
  message: string;
  currentDomains: string[];
  /** Existing domain manifests: with them the structurer lands facts in scopes that already exist. */
  currentManifests?: unknown[];
  vaultOwnerToken: string;
  ingestionId?: string;
  chunkIndex?: number;
  memoryProfile?: "general" | "kyc_identity_v1";
  /** Existing details the merge agent may extend or correct (explicit saves). */
  reconciliationCandidates?: readonly PkmReconciliationCandidate[];
  signal?: AbortSignal;
  isEffectCurrent?: () => boolean;
};

export async function requestPkmMemoryPreparation(
  params: AgentPkmPreparationInput,
): Promise<{ payload: AgentPkmPreviewResponse; privateOwner: boolean }> {
  // Last line before a memory proposal: the text was guarded on the device and
  // carries placeholders only. A raw secret here is refused, never sent; the
  // server's own net (secret_patterns.py) stays behind this one.
  assertNoUnguardedSecrets([
    params.message,
    ...(params.reconciliationCandidates ?? []).map(
      (candidate) => candidate.message,
    ),
  ]);
  const privateOwner = await resolveMemoryPreparationPlacement();
  if (AuthService.getCurrentUser()?.uid !== params.userId) {
    throw new Error("Your account changed. Nothing was saved.");
  }
  if (params.isEffectCurrent && !params.isEffectCurrent()) {
    throw new DOMException("The effect session changed.", "AbortError");
  }
  const init = {
    method: "POST",
    signal: params.signal,
    headers: {
      "Content-Type": "application/json",
      ...(params.ingestionId
        ? { "X-PKM-Ingestion-Id": params.ingestionId }
        : {}),
      ...(typeof params.chunkIndex === "number"
        ? { "X-PKM-Chunk-Index": String(params.chunkIndex) }
        : {}),
    },
    body: JSON.stringify({
      user_id: params.userId,
      message: params.message,
      current_domains: params.currentDomains,
      current_manifests: (params.currentManifests || [])
        .filter(Boolean)
        .slice(0, 256),
      memory_profile: params.memoryProfile || "general",
      ...(params.reconciliationCandidates?.length
        ? {
            simulated_state: {
              memories: params.reconciliationCandidates.slice(0, 10),
            },
          }
        : {}),
    }),
  };
  const response = privateOwner
    ? await ApiService.ownerPodRequest("memory/proposals", init)
    : await ApiService.apiFetch("/api/pkm/memory/proposals", {
        ...init,
        isEffectCurrent: params.isEffectCurrent,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${params.vaultOwnerToken}`,
        },
      });

  if (!response.ok) await refusePreparationResponse(response, params);

  if (
    AuthService.getCurrentUser()?.uid !== params.userId ||
    (params.isEffectCurrent && !params.isEffectCurrent())
  ) {
    throw new DOMException("The effect session changed.", "AbortError");
  }
  return {
    payload: (await response.json()) as AgentPkmPreviewResponse,
    privateOwner,
  };
}

async function resolveMemoryPreparationPlacement(): Promise<boolean> {
  // The hub's placement refusal is the final boundary, not permission to send
  // a private owner's note there. Unresolved placement never chooses a runtime.
  let privateOwner: boolean;
  try {
    privateOwner = await ownerContentIsPrivate();
  } catch (error) {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "AGENT_HOSTING_UNAVAILABLE";
    const message =
      placementRefusalMessage(code) ??
      "Your agent hosting could not be verified.";
    throw new Error(`${message} Nothing was saved.`);
  }
  return privateOwner;
}

/** Exact recipient metadata belongs to the hub; note contents stay in the pod. */
export async function enrichPrivateMemorySharingImpact(
  params: AgentPkmPreparationInput,
  cards: AgentPkmPreviewCard[],
): Promise<void> {
  const impacts = new Map<
    string,
    NonNullable<AgentPkmPreviewCard["sharing_impact"]>
  >();
  for (const card of cards) {
    if (card.write_mode === "do_not_save") continue;
    const domain =
      card.manifest_draft?.domain ||
      card.structure_decision?.target_domain ||
      card.target_domain;
    const scope =
      card.target_entity_scope ||
      card.primary_json_path ||
      card.manifest_draft?.top_level_scope_paths?.[0] ||
      "profile";
    if (
      typeof domain !== "string" ||
      !domain.trim() ||
      typeof scope !== "string" ||
      !scope.trim()
    ) {
      throw new Error(
        "This note has no reviewable section. Nothing was saved.",
      );
    }
    const scopePath = scope.trim().split(".")[0];
    if (!scopePath) {
      throw new Error(
        "This note has no reviewable section. Nothing was saved.",
      );
    }
    const key = JSON.stringify([
      domain.trim().toLowerCase(),
      scopePath.toLowerCase(),
    ]);
    let impact = impacts.get(key);
    if (!impact) {
      const current =
        await PersonalKnowledgeModelService.getMutationSharingImpact({
          userId: params.userId,
          domain: domain.trim(),
          scopePath,
          vaultOwnerToken: params.vaultOwnerToken,
        });
      impact = {
        active_recipient_count: current.activeRecipientCount,
        recipient_labels: current.recipientLabels,
        enters_next_export_revision: current.entersNextExportRevision,
        summary: current.summary,
        affected_grant_ids: current.affectedGrantIds,
        affected_export_ids: current.affectedExportIds,
      };
      impacts.set(key, impact);
    }
    if (
      AuthService.getCurrentUser()?.uid !== params.userId ||
      (params.isEffectCurrent && !params.isEffectCurrent())
    ) {
      throw new DOMException("The effect session changed.", "AbortError");
    }
    card.sharing_impact = { ...impact };
    if (card.write_mode === "can_save" && impact.active_recipient_count > 0) {
      card.write_mode = "confirm_first";
      card.requires_confirmation = true;
      card.validation_hints = [
        ...(card.validation_hints || []),
        "auto_save_blocked_by_active_recipients",
      ];
    }
  }
}

async function refusePreparationResponse(
  response: Response,
  params: Pick<AgentPkmPreparationInput, "ingestionId" | "chunkIndex">,
): Promise<never> {
  let errorCode = `http_${response.status}`;
  try {
    const payload = (await response.json()) as {
      detail?:
        | { type?: unknown; code?: unknown }
        | Array<{ type?: unknown; code?: unknown }>;
    };
    const detail = Array.isArray(payload?.detail)
      ? payload.detail[0]
      : payload?.detail;
    if (detail && typeof detail === "object") {
      const candidate = detail.code || detail.type;
      if (typeof candidate === "string" && /^[A-Za-z0-9_]{1,96}$/.test(candidate)) {
        errorCode = candidate.trim();
      }
    }
  } catch {
    // Error bodies can contain the rejected source text. Never surface or log them.
  }
  console.error("[PKM_INGEST] proposal_failed", {
    ingestion_id: params.ingestionId || "none",
    chunk_index: params.chunkIndex ?? 0,
    status: response.status,
    error_code: errorCode,
  });
  throw new Error(
    response.status === 404
      ? "Your private agent needs an update before preparing Memory. Nothing was saved."
      : `Memory preparation failed (${errorCode}). Please try again.`,
  );
}
