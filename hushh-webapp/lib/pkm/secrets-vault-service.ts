"use client";

/**
 * The reserved `secrets` PKM domain: the single boundary that stores, lists,
 * reveals and removes the owner's secrets. Mirrors the Wallet storage contract
 * (`PersonalKnowledgeModelService.storeWalletDomain`): client-side AES-256-GCM
 * under the vault key, an explicit manifest with one non-exposable branch, and
 * a plaintext summary that carries bookkeeping only (the server refuses
 * anything else, `secrets_domain_validation.py`).
 *
 * Domain data shape (inside the encrypted blob):
 *   { items: { [sec_id]: { label, kind, pattern_id, file_to, offer_noun,
 *                          value, created_at, filed_to? } } }
 *
 * The writer is the registered feature writer `secrets_vault`; sending a
 * message or tapping Save is the owner's own act, so every write is an
 * owner-confirmed plan through `PkmWriteCoordinator`. Values leave this module
 * only through `revealSecret`, to the secure reveal card.
 */

import type {
  DomainManifest,
  PathDescriptor,
  StructureDecision,
} from "@/lib/personal-knowledge-model/manifest";
import { sha256Hex, type PkmUserConfirmation } from "@/lib/personal-knowledge-model/mutation-plan";
import {
  CURRENT_PKM_CONTRACT_VERSION,
  CURRENT_READABLE_PROJECTION_VERSION,
  CURRENT_READABLE_SUMMARY_VERSION,
  currentDomainContractVersion,
} from "@/lib/personal-knowledge-model/upgrade-contracts";
import type { SecretFileTo, SecretKind } from "@/lib/pkm/secret-patterns";
import type { ResolvedSecret, SecretCapture } from "@/lib/pkm/secret-span-guard";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

export const SECRETS_DOMAIN = "secrets";
const ITEMS_BRANCH = "items";
const SECRET_ID = /^sec_[a-f0-9]{16}$/;

export type SecretsVaultContext = {
  userId: string;
  vaultKey: string | null | undefined;
  vaultOwnerToken: string | null | undefined;
};

/** One stored secret, without its value. Safe to render and to name to a model. */
export type SecretItemSummary = {
  id: string;
  label: string;
  kind: SecretKind;
  patternId: string;
  fileTo: SecretFileTo;
  offerNoun: string | null;
  createdAt: string;
  filedTo: Exclude<SecretFileTo, "none"> | null;
};

export type SaveSecretCapturesResult =
  | { ok: true; resolved: ReadonlyMap<string, ResolvedSecret> }
  | { ok: false; reason: "locked" | "failed"; message: string };

/** A reveal or change was asked for without an unlocked vault. Nothing was read. */
export class SecretsLockedError extends Error {
  constructor() {
    super("Unlock your vault to see this secret.");
    this.name = "SecretsLockedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function itemsOf(domainData: unknown): Record<string, Record<string, unknown>> {
  const items = isRecord(domainData) && isRecord(domainData.items) ? domainData.items : {};
  return Object.fromEntries(
    Object.entries(items).filter((entry): entry is [string, Record<string, unknown>] =>
      SECRET_ID.test(entry[0]) && isRecord(entry[1])),
  );
}

function toSummary(id: string, item: Record<string, unknown>): SecretItemSummary {
  const fileTo = String(item.file_to ?? "none");
  const filedTo = String(item.filed_to ?? "");
  return {
    id,
    label: String(item.label ?? "Secret"),
    kind: String(item.kind ?? "credential") as SecretKind,
    patternId: String(item.pattern_id ?? ""),
    fileTo: (fileTo === "wallet" || fileTo === "kyc_identity_documents" ? fileTo : "none") as SecretFileTo,
    offerNoun: typeof item.offer_noun === "string" ? item.offer_noun : null,
    createdAt: String(item.created_at ?? ""),
    filedTo: filedTo === "wallet" || filedTo === "kyc_identity_documents" ? filedTo : null,
  };
}

function requireUnlocked(context: SecretsVaultContext): { userId: string; vaultKey: string; vaultOwnerToken: string } {
  if (!context.userId || !context.vaultKey || !context.vaultOwnerToken) throw new SecretsLockedError();
  return { userId: context.userId, vaultKey: context.vaultKey, vaultOwnerToken: context.vaultOwnerToken };
}

/**
 * Artifacts for the reserved `secrets` domain: one branch, `items`, never
 * exposable and consent-required, and a summary holding only bookkeeping and
 * a count. No label and no value ever reaches the plaintext index.
 */
export async function buildSecretsArtifacts(params: {
  userId: string;
  domainData: Record<string, unknown>;
  previousManifest: DomainManifest | null;
}): Promise<{ summary: Record<string, unknown>; manifest: DomainManifest }> {
  const nowIso = new Date().toISOString();
  const domainContractVersion = currentDomainContractVersion(SECRETS_DOMAIN);
  const manifestVersion = Math.max(1, params.previousManifest?.manifest_version || 0) + 1;
  const previousHandle = params.previousManifest?.scope_registry?.find(
    (entry) => String(entry.summary_projection?.top_level_scope_path || "") === ITEMS_BRANCH,
  )?.scope_handle;
  const scopeHandle = previousHandle && /^(?:s|scope|pending)_[A-Za-z0-9_-]{6,128}$/.test(previousHandle)
    ? previousHandle
    : `s_${(await sha256Hex(`${params.userId}:${SECRETS_DOMAIN}:${ITEMS_BRANCH}`)).slice(0, 12)}`;
  const summary = {
    domain_intent: SECRETS_DOMAIN,
    manifest_version: manifestVersion,
    domain_contract_version: domainContractVersion,
    readable_summary_version: CURRENT_READABLE_SUMMARY_VERSION,
    pkm_contract_version: CURRENT_PKM_CONTRACT_VERSION,
    readable_projection_version: CURRENT_READABLE_PROJECTION_VERSION,
    consumer_visible: false,
    internal_only: false,
    storage_mode: "encrypted_domain",
    item_count: Object.keys(itemsOf(params.domainData)).length,
  };
  const paths: PathDescriptor[] = [{
    json_path: ITEMS_BRANCH,
    parent_path: null,
    path_type: "object",
    exposure_eligibility: false,
    consent_label: "Secrets",
    sensitivity_label: "restricted",
    segment_id: ITEMS_BRANCH,
    scope_handle: scopeHandle,
    source_agent: "secrets_vault",
  }];
  const structureDecision: StructureDecision = {
    action: params.previousManifest ? "extend_domain" : "create_domain",
    target_domain: SECRETS_DOMAIN,
    json_paths: [ITEMS_BRANCH],
    top_level_scope_paths: [ITEMS_BRANCH],
    externalizable_paths: [],
    summary_projection: summary,
    sensitivity_labels: { [ITEMS_BRANCH]: "restricted" },
    confidence: 1,
    source_agent: "secrets_vault",
    contract_version: 1,
  };
  const manifest: DomainManifest = {
    domain: SECRETS_DOMAIN,
    manifest_version: manifestVersion,
    domain_contract_version: domainContractVersion,
    readable_summary_version: CURRENT_READABLE_SUMMARY_VERSION,
    pkm_contract_version: CURRENT_PKM_CONTRACT_VERSION,
    readable_projection_version: CURRENT_READABLE_PROJECTION_VERSION,
    upgraded_at: nowIso,
    structure_decision: structureDecision,
    summary_projection: summary,
    top_level_scope_paths: [ITEMS_BRANCH],
    externalizable_paths: [],
    segment_ids: [ITEMS_BRANCH],
    path_count: 1,
    externalizable_path_count: 0,
    last_structured_at: nowIso,
    last_content_at: nowIso,
    paths,
    scope_registry: [{
      scope_handle: scopeHandle,
      scope_label: "Secrets",
      segment_ids: [ITEMS_BRANCH],
      sensitivity_tier: "restricted",
      scope_kind: "reserved_domain_branch",
      exposure_enabled: false,
      visibility_posture: "consent_required",
      default_projection_ready: false,
      default_projection_updated_at: null,
      summary_projection: {
        top_level_scope_path: ITEMS_BRANCH,
        consumer_visible: false,
        internal_only: false,
        visibility_reason: "A secret leaves the vault only through a per-item grant the owner starts.",
        storage_mode: "encrypted_domain",
      },
    }],
  };
  return { summary, manifest };
}

async function writeItems(params: {
  context: { userId: string; vaultKey: string; vaultOwnerToken: string };
  confirmation: PkmUserConfirmation;
  mutate: (items: Record<string, Record<string, unknown>>) => Record<string, Record<string, unknown>>;
}) {
  return PkmWriteCoordinator.saveMergedDomain({
    userId: params.context.userId,
    domain: SECRETS_DOMAIN,
    vaultKey: params.context.vaultKey,
    vaultOwnerToken: params.context.vaultOwnerToken,
    confirmation: params.confirmation,
    build: async (writeContext) => {
      const base = isRecord(writeContext.currentDomainData) ? writeContext.currentDomainData : {};
      const domainData = { ...base, [ITEMS_BRANCH]: params.mutate({ ...itemsOf(base) }) };
      const artifacts = await buildSecretsArtifacts({
        userId: params.context.userId,
        domainData,
        previousManifest: writeContext.currentManifest,
      });
      return { domainData, summary: artifacts.summary, manifest: artifacts.manifest, scopePath: ITEMS_BRANCH };
    },
  });
}

async function loadItems(context: SecretsVaultContext): Promise<Record<string, Record<string, unknown>>> {
  const unlocked = requireUnlocked(context);
  const data = await PersonalKnowledgeModelService.loadDomainData({
    userId: unlocked.userId,
    domain: SECRETS_DOMAIN,
    vaultKey: unlocked.vaultKey,
    vaultOwnerToken: unlocked.vaultOwnerToken,
  }).catch(() => null);
  return itemsOf(data);
}

export class SecretsVaultService {
  /**
   * Save the secrets the guard captured from one outgoing turn. An item that
   * already holds the same value is reused, so its placeholder names it.
   * Returns the final id and label per provisional capture id.
   */
  static async saveCaptures(params: SecretsVaultContext & {
    captures: readonly SecretCapture[];
    surface: PkmUserConfirmation["surface"];
  }): Promise<SaveSecretCapturesResult> {
    if (params.captures.length === 0) return { ok: true, resolved: new Map() };
    let context: ReturnType<typeof requireUnlocked>;
    try {
      context = requireUnlocked(params);
    } catch {
      return { ok: false, reason: "locked", message: "Unlock your vault so this secret can be kept in Secrets." };
    }
    const resolved = new Map<string, ResolvedSecret>();
    const createdAt = new Date().toISOString();
    const result = await writeItems({
      context,
      confirmation: { confirmedByUser: true, surface: params.surface, source: "secrets_vault" },
      mutate: (items) => {
        resolved.clear();
        const byValue = new Map(Object.entries(items).map(([id, item]) => [String(item.value ?? ""), id]));
        for (const capture of params.captures) {
          const existingId = byValue.get(capture.value);
          if (existingId) {
            resolved.set(capture.id, { id: existingId, label: String(items[existingId]?.label ?? capture.label) });
            continue;
          }
          items[capture.id] = {
            label: capture.label,
            kind: capture.kind,
            pattern_id: capture.patternId,
            file_to: capture.fileTo,
            offer_noun: capture.offerNoun,
            value: capture.value,
            created_at: createdAt,
          };
          byValue.set(capture.value, capture.id);
          resolved.set(capture.id, { id: capture.id, label: capture.label });
        }
        return items;
      },
    });
    if (!result.success) {
      return { ok: false, reason: result.saveState === "blocked_pending_unlock" ? "locked" : "failed",
        message: "This secret couldn't be saved, so nothing was sent. Try again." };
    }
    return { ok: true, resolved };
  }

  /** Labels and kinds only: what the Secrets list and One may know. */
  static async listSecrets(context: SecretsVaultContext): Promise<SecretItemSummary[]> {
    const items = await loadItems(context);
    return Object.entries(items)
      .map(([id, item]) => toSummary(id, item))
      .sort((left, right) => (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0));
  }

  /**
   * Decrypt one value for the secure reveal card. Requires an unlocked vault;
   * the caller holds the value in component state only and never logs it.
   */
  static async revealSecret(context: SecretsVaultContext & { secretId: string }): Promise<string | null> {
    const items = await loadItems(context);
    const value = items[context.secretId]?.value;
    return typeof value === "string" && value ? value : null;
  }

  static async removeSecret(context: SecretsVaultContext & { secretId: string }): Promise<boolean> {
    const unlocked = requireUnlocked(context);
    const result = await writeItems({
      context: unlocked,
      confirmation: { confirmedByUser: true, surface: "web", source: "secrets_vault_remove" },
      mutate: (items) => {
        delete items[context.secretId];
        return items;
      },
    });
    return result.success;
  }

  /** Record that the owner filed this secret in Wallet or Identity documents. */
  static async markFiled(context: SecretsVaultContext & {
    secretId: string;
    filedTo: Exclude<SecretFileTo, "none">;
  }): Promise<boolean> {
    const unlocked = requireUnlocked(context);
    const result = await writeItems({
      context: unlocked,
      confirmation: { confirmedByUser: true, surface: "web", source: "secrets_vault" },
      mutate: (items) => {
        const item = items[context.secretId];
        if (item) items[context.secretId] = { ...item, filed_to: context.filedTo };
        return items;
      },
    });
    return result.success;
  }
}
