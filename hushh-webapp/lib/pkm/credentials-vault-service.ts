"use client";
import type { DomainManifest, PathDescriptor } from "@/lib/personal-knowledge-model/manifest";
import { sha256Hex } from "@/lib/personal-knowledge-model/mutation-plan";
import { CURRENT_PKM_CONTRACT_VERSION, CURRENT_READABLE_PROJECTION_VERSION, CURRENT_READABLE_SUMMARY_VERSION, currentDomainContractVersion } from "@/lib/personal-knowledge-model/upgrade-contracts";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { ApiService } from "@/lib/services/api-service";
import { agentRecipientFromBinding } from "@/lib/one/ai-selection-recipient";
import type { AiSelectionRecipient } from "@/lib/one/ai-selection-seal";
import { readPodBackgroundConfig } from "@/lib/services/pod-background-config";
import { CREDENTIALS_DOMAIN, CREDENTIAL_ID, CredentialError, credentialInput, type CredentialAad, type CredentialInput, type CredentialRecord, type CredentialSummary, type CredentialsDomain } from "./credentials-contracts";
import { decryptCredentialRecord, encryptCredentialRecord } from "./credential-crypto";
export type CredentialCustodyPort = {
  recipient: AiSelectionRecipient;
  recheck: () => Promise<void>;
  fence: (id: string, generation: number) => Promise<void>;
  generationFloor: (id: string) => Promise<number>;
  publish: (id: string, contentRevision: number, manifestRevision: number) => Promise<void>;
};
export type CredentialsVaultContext = {
  userId: string;
  vaultKey: string | null | undefined;
  vaultOwnerToken: string | null | undefined;
  beforeEffect?: () => Promise<void>;
  custody?: CredentialCustodyPort;
  custodyGrantDurationHours?: number;
};
function unlocked(context: CredentialsVaultContext): asserts context is CredentialsVaultContext & {
  vaultKey: string;
  vaultOwnerToken: string;
} {
  if (!context.userId || !context.vaultKey || !context.vaultOwnerToken)
    throw new CredentialError("CREDENTIAL_VAULT_LOCKED");
}
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function domain(value: unknown): CredentialsDomain {
  if (value == null || (object(value) && !Object.keys(value).length))
    return {
      schemaVersion: 1, summary: {}, secrets: {}, tombstones: {}
    };
  if (!object(value) || value.schemaVersion !== 1 || Object.keys(value).some(k => !["schemaVersion", "summary", "secrets", "tombstones"].includes(k)) || !object(value.summary) || !object(value.secrets) || !object(value.tombstones))
    throw new CredentialError("CREDENTIAL_SCHEMA_UNSUPPORTED");
  const result = value as unknown as CredentialsDomain;
  if (Object.keys(result.summary).length > 5000 || Object.keys(result.secrets).length !== Object.keys(result.summary).length)
    throw new CredentialError("CREDENTIAL_DOMAIN_INVALID");
  for (const [id, summary] of Object.entries(result.summary)) {
    const record = result.secrets[id];
    if (!CREDENTIAL_ID.test(id) || !record || summary.id !== id || record.schemaVersion !== 1 ||
      record.aad.credentialId !== id || summary.revision !== record.aad.revision || summary.generation !== record.aad.generation ||
      summary.policyGeneration !== record.aad.policyGeneration || summary.custodyGeneration !== record.aad.custodyGeneration ||
      summary.autonomyPolicy !== record.aad.autonomyPolicy || JSON.stringify(summary.boundOrigins) !== JSON.stringify(record.aad.boundOrigins) ||
      result.tombstones[id])
      throw new CredentialError("CREDENTIAL_DOMAIN_INVALID");
  }
  return structuredClone(result);
}
async function load(context: CredentialsVaultContext): Promise<CredentialsDomain> {
  unlocked(context);
  await context.beforeEffect?.();
  // Refresh/reconciliation and reveal must observe edits or deletion on another
  // device, rather than treating the encrypted presentation cache as authority.
  const loaded = await PersonalKnowledgeModelService.loadDomainSnapshot({
    userId: context.userId, domain: CREDENTIALS_DOMAIN, vaultKey: context.vaultKey, vaultOwnerToken: context.vaultOwnerToken, force: true
  });
  await context.beforeEffect?.();
  return domain(loaded.data);
}
function aadFor(userId: string, summary: CredentialSummary): CredentialAad {
  return {
    purpose: "website_credential_payload", ownerId: userId, credentialId: summary.id, revision: summary.revision, generation: summary.generation, policyGeneration: summary.policyGeneration, custodyGeneration: summary.custodyGeneration, autonomyPolicy: summary.autonomyPolicy, boundOrigins: summary.boundOrigins
  };
}
export async function buildCredentialsArtifacts(userId: string, data: CredentialsDomain, previousManifest: DomainManifest | null): Promise<{
  summary: Record<string, unknown>;
  manifest: DomainManifest;
}> {
  const version = Math.max(1, previousManifest?.manifest_version ?? 0) + 1;
  const summary = {
    domain_intent: CREDENTIALS_DOMAIN, schema_version: 1, manifest_version: version, domain_contract_version: currentDomainContractVersion(CREDENTIALS_DOMAIN), readable_summary_version: CURRENT_READABLE_SUMMARY_VERSION, pkm_contract_version: CURRENT_PKM_CONTRACT_VERSION, readable_projection_version: CURRENT_READABLE_PROJECTION_VERSION, consumer_visible: false, internal_only: false, storage_mode: "encrypted_domain", item_count: Object.keys(data.summary).length
  };
  const paths: PathDescriptor[] = [];
  const registry: NonNullable<DomainManifest["scope_registry"]> = [];
  for (const branch of ["summary", "secrets"]) {
    const handle = `s_${(await sha256Hex(`${userId}:credentials:${branch}`)).slice(0, 12)}`;
    paths.push({
      json_path: branch, parent_path: null, path_type: "object", exposure_eligibility: false, consent_label: branch === "summary" ? "Website login summary" : "Website login secrets", sensitivity_label: "restricted", segment_id: branch, scope_handle: handle, source_agent: "credentials_vault"
    });
    registry.push({
      scope_handle: handle, scope_label: branch === "summary" ? "Website login summary" : "Website login secrets", segment_ids: [branch], sensitivity_tier: "restricted", scope_kind: "reserved_domain_branch", exposure_enabled: false, visibility_posture: "consent_required", default_projection_ready: false, default_projection_updated_at: null, summary_projection: {
        top_level_scope_path: branch, consumer_visible: false, internal_only: false, storage_mode: "encrypted_domain"
      }
    });
  }
  const now = new Date().toISOString();
  const manifest: DomainManifest = {
    domain: CREDENTIALS_DOMAIN, manifest_version: version, domain_contract_version: currentDomainContractVersion(CREDENTIALS_DOMAIN), readable_summary_version: CURRENT_READABLE_SUMMARY_VERSION, pkm_contract_version: CURRENT_PKM_CONTRACT_VERSION, readable_projection_version: CURRENT_READABLE_PROJECTION_VERSION, upgraded_at: now, summary_projection: summary, top_level_scope_paths: ["summary", "secrets"], externalizable_paths: [], segment_ids: ["summary", "secrets"], path_count: 2, externalizable_path_count: 0, last_structured_at: now, last_content_at: now, paths, scope_registry: registry, structure_decision: {
      action: previousManifest ? "extend_domain" : "create_domain", target_domain: CREDENTIALS_DOMAIN, json_paths: ["summary", "secrets"], top_level_scope_paths: ["summary", "secrets"], externalizable_paths: [], summary_projection: summary, sensitivity_labels: {
        summary: "restricted", secrets: "restricted"
      }, confidence: 1, source_agent: "credentials_vault", contract_version: 1
    }
  };
  return {
    summary, manifest
  };
}
/** Resolve the recipient exclusively through the authenticated owner transport. */
export async function createOwnerCredentialCustodyPort(context: CredentialsVaultContext): Promise<CredentialCustodyPort> {
  unlocked(context);
  await context.beforeEffect?.();
  let sealContext: Awaited<ReturnType<typeof ApiService.ownerCredentialSealContext>>;
  try {
    sealContext = await ApiService.ownerCredentialSealContext(context.userId);
  }
  catch {
    throw new CredentialError("CREDENTIAL_CUSTODY_UNAVAILABLE");
  }
  const resolve = () => agentRecipientFromBinding(sealContext, {
    requiredScope: "pod.config", ownerCloudOnly: false
  });
  const recipient = await resolve();
  async function recheck() {
    await context.beforeEffect?.();
    const latest = await resolve();
    if (latest.hushhId !== recipient.hushhId || latest.podKeyId !== recipient.podKeyId || latest.publicKey !== recipient.publicKey)
      throw new CredentialError("CREDENTIAL_RECIPIENT_CHANGED");
    const config = await readPodBackgroundConfig();
    await context.beforeEffect?.();
    if (!config)
      throw new CredentialError("CREDENTIAL_CUSTODY_UNAVAILABLE");
    if (config.sessionOnlyLockdown)
      throw new CredentialError("CREDENTIAL_SESSION_ONLY");
  }
  async function request(path: string, method: string, body: unknown) {
    await context.beforeEffect?.();
    const response = await ApiService.ownerPodRequest(path, {
      method, headers: {
        "Content-Type": "application/json"
      }, ...(method === "GET" ? {} : {
        body: JSON.stringify(body)
      })
    }, false, undefined, recipient.hushhId);
    await context.beforeEffect?.();
    if (!response.ok)
      throw new CredentialError("CREDENTIAL_CUSTODY_UNAVAILABLE");
    return response;
  }
  return {
    recipient, recheck,
    generationFloor: async (id) => {
      const response = await request(`credentials/${id}`, "GET", undefined);
      const body = await response.json();
      if (!Number.isSafeInteger(body.generation) || body.generation < 0)
        throw new CredentialError("CREDENTIAL_CUSTODY_UNAVAILABLE");
      return body.generation;
    },
    fence: async (id, generation) => {
      await request(`credentials/${id}`, "DELETE", {
        generation
      });
    },
    publish: async (id, contentRevision, manifestRevision) => {
      await recheck();
      const { admitCredentialCustodyExport } = await import("@/lib/services/credential-custody-grant-service");
      const selection = await admitCredentialCustodyExport({
        context: {
          ...context, vaultKey: context.vaultKey!, vaultOwnerToken: context.vaultOwnerToken!
        }, credentialId: id, sourceContentRevision: contentRevision, sourceManifestRevision: manifestRevision, recipient
      });
      await recheck();
      await request("credentials", "POST", selection);
    }
  };
}
export class CredentialsVaultService {
  static async list(context: CredentialsVaultContext): Promise<CredentialSummary[]> {
    return Object.values((await load(context)).summary);
  }
  static async reveal(context: CredentialsVaultContext, id: string): Promise<CredentialInput> {
    if (!CREDENTIAL_ID.test(id))
      throw new CredentialError("CREDENTIAL_ID_INVALID");
    const data = await load(context);
    const summary = data.summary[id];
    const record = data.secrets[id];
    if (!summary || !record)
      throw new CredentialError("CREDENTIAL_UNAVAILABLE");
    unlocked(context);
    const secret = await decryptCredentialRecord(record, context.vaultKey, aadFor(context.userId, summary));
    await context.beforeEffect?.();
    return {
      label: summary.label, boundOrigins: summary.boundOrigins, usernameHint: summary.usernameHint, autonomyPolicy: summary.autonomyPolicy, ...secret
    };
  }
  static async save(context: CredentialsVaultContext, input: CredentialInput, options: {
    id?: string;
    expectedRevision?: number;
    writer?: "credentials_vault" | "credentials_vault_rotate";
  } = {}): Promise<CredentialSummary> {
    unlocked(context);
    const checked = credentialInput(input);
    const id = options.id ?? `cred_${crypto.randomUUID().replaceAll("-", "")}`;
    if (!CREDENTIAL_ID.test(id))
      throw new CredentialError("CREDENTIAL_ID_INVALID");
    const preflight = await load(context);
    const previous = preflight.summary[id];
    if (options.id && (!previous || options.expectedRevision !== previous.revision))
      throw new CredentialError("CREDENTIAL_REVISION_STALE");
    if (preflight.tombstones[id])
      throw new CredentialError("CREDENTIAL_DELETED");
    const floor = context.custody ? await context.custody.generationFloor(id) : 0;
    if (!Number.isSafeInteger(floor) || floor < 0) throw new CredentialError("CREDENTIAL_CUSTODY_UNAVAILABLE");
    if (previous && preflight.secrets[id]?.podWrap && floor <= previous.generation) {
      if (!context.custody)
        throw new CredentialError("CREDENTIAL_CUSTODY_UNAVAILABLE");
      await context.custody.fence(id, previous.generation);
    }
    if (checked.autonomyPolicy !== "vault_only") {
      if (!context.custody)
        throw new CredentialError("CREDENTIAL_CUSTODY_UNAVAILABLE");
      await context.custody.recheck();
    }
    let saved: CredentialSummary | undefined;
    let manifestRevision = 0;
    const result = await PkmWriteCoordinator.saveMergedDomain({
      userId: context.userId, domain: CREDENTIALS_DOMAIN, vaultKey: context.vaultKey, vaultOwnerToken: context.vaultOwnerToken, confirmation: {
        confirmedByUser: true, surface: "web", source: options.writer ?? "credentials_vault"
      }, beforeEffect: context.beforeEffect, build: async (current) => {
        const data = domain(current.currentDomainData);
        const old = data.summary[id];
        if (data.tombstones[id] || (previous ? old?.revision !== previous.revision : Boolean(old)))
          throw new CredentialError("CREDENTIAL_REVISION_STALE");
        if (Object.keys(data.summary).length >= 5000 && !old)
          throw new CredentialError("CREDENTIAL_LIMIT");
        saved = {
          id, label: checked.label, boundOrigins: checked.boundOrigins, usernameHint: checked.usernameHint, autonomyPolicy: checked.autonomyPolicy, revision: Math.max(old?.revision ?? 0, floor) + 1, generation: Math.max(old?.generation ?? 0, floor) + 1, policyGeneration: Math.max(old?.policyGeneration ?? 0, floor) + 1, custodyGeneration: Math.max(old?.custodyGeneration ?? 0, floor) + 1
        };
        const { username, password, totpSecret, notes } = checked;
        const secrets = {
          username, password, ...(totpSecret ? {
            totpSecret
          } : {}), ...(notes ? {
            notes
          } : {})
        };
        const record: CredentialRecord = await encryptCredentialRecord(secrets, context.vaultKey!, aadFor(context.userId, saved), checked.autonomyPolicy === "vault_only" ? undefined : context.custody!.recipient);
        data.summary[id] = saved;
        data.secrets[id] = record;
        const artifacts = await buildCredentialsArtifacts(context.userId, data, current.currentManifest);
        manifestRevision = artifacts.manifest.manifest_version;
        return {
          domainData: data as unknown as Record<string, unknown>, summary: artifacts.summary, manifest: artifacts.manifest, scopePath: "secrets"
        };
      }
    });
    if (!result.success || !saved)
      throw new CredentialError("CREDENTIAL_SAVE_FAILED");
    await context.beforeEffect?.();
    const { ConsentExportRefreshOrchestrator } = await import("@/lib/services/consent-export-refresh-orchestrator");
    await ConsentExportRefreshOrchestrator.ensureRunning({userId:context.userId,vaultKey:context.vaultKey,vaultOwnerToken:context.vaultOwnerToken,initiatedBy:"credentials_vault"});
    await context.beforeEffect?.();
    if (saved.autonomyPolicy !== "vault_only") {
      if (!result.dataVersion)
        throw new CredentialError("CREDENTIAL_SAVED_CUSTODY_PENDING");
      try {
        await context.custody!.publish(id, result.dataVersion, manifestRevision);
      }
      catch {
        throw new CredentialError("CREDENTIAL_SAVED_CUSTODY_PENDING");
      }
    }
    return saved;
  }
  static async remove(context: CredentialsVaultContext, id: string, expectedRevision: number): Promise<void> {
    unlocked(context);
    const previous = (await load(context)).summary[id];
    if (!previous || previous.revision !== expectedRevision)
      throw new CredentialError("CREDENTIAL_REVISION_STALE");
    const floor = context.custody ? await context.custody.generationFloor(id) : 0;
    if (!Number.isSafeInteger(floor) || floor < 0) throw new CredentialError("CREDENTIAL_CUSTODY_UNAVAILABLE");
    if (previous.autonomyPolicy !== "vault_only" && floor <= previous.generation) {
      if (!context.custody)
        throw new CredentialError("CREDENTIAL_CUSTODY_UNAVAILABLE");
      await context.custody.fence(id, previous.generation);
    }
    const result = await PkmWriteCoordinator.saveMergedDomain({
      userId: context.userId, domain: CREDENTIALS_DOMAIN, vaultKey: context.vaultKey, vaultOwnerToken: context.vaultOwnerToken, confirmation: {
        confirmedByUser: true, surface: "web", source: "credentials_vault_remove"
      }, beforeEffect: context.beforeEffect, build: async (current) => {
        const data = domain(current.currentDomainData);
        const old = data.summary[id];
        if (!old || old.revision !== expectedRevision)
          throw new CredentialError("CREDENTIAL_REVISION_STALE");
        data.tombstones[id] = {
          revision: Math.max(old.revision, floor) + 1, generation: Math.max(old.generation, floor) + 1, policyGeneration: Math.max(old.policyGeneration, floor) + 1, custodyGeneration: Math.max(old.custodyGeneration, floor) + 1
        };
        delete data.summary[id];
        delete data.secrets[id];
        const artifacts = await buildCredentialsArtifacts(context.userId, data, current.currentManifest);
        return {
          domainData: data as unknown as Record<string, unknown>, summary: artifacts.summary, manifest: artifacts.manifest, scopePath: "secrets"
        };
      }
    });
    if (!result.success)
      throw new CredentialError("CREDENTIAL_REMOVE_FAILED");
    await context.beforeEffect?.();
    const { ConsentExportRefreshOrchestrator } = await import("@/lib/services/consent-export-refresh-orchestrator");
    await ConsentExportRefreshOrchestrator.ensureRunning({userId:context.userId,vaultKey:context.vaultKey,vaultOwnerToken:context.vaultOwnerToken,initiatedBy:"credentials_vault_remove"});
    await context.beforeEffect?.();
  }
  static async rotate(context: CredentialsVaultContext, id: string, expectedRevision: number): Promise<CredentialSummary> {
    const input = await this.reveal(context, id);
    return this.save(context, input, {
      id, expectedRevision, writer: "credentials_vault_rotate"
    });
  }
}
/** The one-use envelope may never outlive the admitted Browser task. */
export function credentialUseExpiry(taskExpiresAt: number, nowMs = Date.now()): number {
  const now = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(taskExpiresAt) || taskExpiresAt <= now) throw new CredentialError("CREDENTIAL_USE_EXPIRED");
  return Math.min(now + 60, taskExpiresAt);
}

/** One owner-unlocked vault-only use. The canonical record gets no pod wrap. */
export async function sealTransientCredentialUse(context: CredentialsVaultContext, id: string, request: {
  operationId: string;
  taskId: string;
  taskExpiresAt: number;
  incarnation: string;
  controlEpoch: number;
  origin: string;
  recipient: AiSelectionRecipient;
}) {
  unlocked(context);
  if (!CREDENTIAL_ID.test(id) || !/^[A-Za-z0-9_-]{8,128}$/.test(request.operationId) || !request.taskId || request.taskId.length > 128 || !request.incarnation || request.incarnation.length > 256 || !Number.isSafeInteger(request.controlEpoch) || request.controlEpoch < 1)
    throw new CredentialError("CREDENTIAL_USE_INVALID");
  credentialUseExpiry(request.taskExpiresAt);
  const first = await load(context);
  const summary = first.summary[id];
  if (!summary || summary.autonomyPolicy !== "vault_only" || !summary.boundOrigins.includes(request.origin))
    throw new CredentialError("CREDENTIAL_USE_REFUSED");
  const sealContext = await ApiService.ownerCredentialSealContext(context.userId);
  const recipient = await agentRecipientFromBinding(sealContext, {
    requiredScope: "browser.control", ownerCloudOnly: false
  });
  if (recipient.hushhId !== request.recipient.hushhId || recipient.podKeyId !== request.recipient.podKeyId || recipient.publicKey !== request.recipient.publicKey)
    throw new CredentialError("CREDENTIAL_RECIPIENT_CHANGED");
  const config = await readPodBackgroundConfig();
  await context.beforeEffect?.();
  if (!config || config.sessionOnlyLockdown)
    throw new CredentialError("CREDENTIAL_SESSION_ONLY");
  const loaded = await PersonalKnowledgeModelService.loadDomainSnapshot({
    userId: context.userId, domain: CREDENTIALS_DOMAIN, vaultKey: context.vaultKey, vaultOwnerToken: context.vaultOwnerToken, force: true
  });
  const current = domain(loaded.data);
  const latest = current.summary[id];
  if (!latest || JSON.stringify(latest) !== JSON.stringify(summary) || !loaded.snapshot?.contentRevision || !loaded.snapshot.manifestRevision)
    throw new CredentialError("CREDENTIAL_REVISION_STALE");
  const { admitCredentialCustodyExport } = await import("@/lib/services/credential-custody-grant-service");
  const selection = await admitCredentialCustodyExport({
    context: {
      ...context, vaultKey: context.vaultKey, vaultOwnerToken: context.vaultOwnerToken
    }, credentialId: id, sourceContentRevision: loaded.snapshot.contentRevision, sourceManifestRevision: loaded.snapshot.manifestRevision, recipient
  });
  await context.beforeEffect?.();
  const secrets = await decryptCredentialRecord(current.secrets[id]!, context.vaultKey, aadFor(context.userId, latest));
  const { sealCredentialUsePayload } = await import("./credential-crypto");
  const envelope = await sealCredentialUsePayload({
    username: secrets.username, password: secrets.password, ...(secrets.totpSecret ? {
      totpSecret: secrets.totpSecret
    } : {}), selection
  }, {
    purpose: "website_credential_use", ownerId: context.userId, credentialId: id, recordRevision: latest.revision, policyGeneration: latest.policyGeneration, custodyGeneration: latest.custodyGeneration, hushhId: recipient.hushhId, podKeyId: recipient.podKeyId, taskId: request.taskId, incarnation: request.incarnation, controlEpoch: request.controlEpoch, origin: request.origin, operationId: request.operationId, expiresAt: credentialUseExpiry(request.taskExpiresAt), nonce: crypto.randomUUID()
  }, recipient);
  await context.beforeEffect?.();
  return {
    envelope, selection
  };
}
