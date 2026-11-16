/**
 * Client-encrypted PKM projection & consent-scope write-through bridge for Personal Wiki (#9370).
 *
 * Works identically across BOTH Shared and Private Pod runtimes because BYOK PKM
 * domain blobs (`pkm_blobs`, `pkm_manifests`, `pkm_scope_registry`) are encrypted
 * exclusively on the unlocked owner client and committed through `PkmWriteCoordinator`.
 *
 * Key invariants:
 * 1. Coherent semantic domain/path classification via `requestPkmMemoryPreparation`
 *    (`memoryProfile: "wiki_claim_projection_v1"`), routing to `/api/pkm/memory/proposals`
 *    on Shared and `/api/one/pod/memory/proposals` on Private Pods.
 * 2. Graceful existing-domain & specialist non-clobbering: inspects decrypted `financial`,
 *    `identity`, and target domain blobs before writing; conflicting values transition
 *    `wpr_*` receipts to `state: "conflicted"` (`exposure_eligibility: false`) instead of
 *    overwriting verified specialist or pre-existing PKM records.
 * 3. Anti-broadening fence: holds updates in `state: "private_candidate"` whenever active
 *    external grants cover the domain/scope (`activeRecipientCount > 0`) unless explicitly
 *    confirmed by the owner.
 * 4. Selective provenance-backed retraction on Forget: removes ONLY `_wiki_projections`-owned
 *    leaf paths whose `value_sha256` still matches, preserving all sibling PKM records and
 *    marking emptied top-level scopes `"stale"` / `"delete"`.
 */

import {
  resolveCardTargetDomain,
  type AgentPkmPreviewCard,
} from "@/lib/agent/agent-pkm-memory";
import { requestPkmMemoryPreparation } from "@/lib/agent/agent-pkm-memory-preparation";
import {
  WIKI_PROJECTIONS_BRANCH,
  buildPersonalKnowledgeModelStructureArtifacts,
  type PkmScopeMaterializationState,
} from "@/lib/personal-knowledge-model/manifest";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { reservedEntryFor } from "@/lib/pkm/reserved-branches";
import { isDegradedPreviewCard } from "@/lib/profile/pkm-agent-lab-preview";
import {
  PersonalKnowledgeModelService,
  type PkmMutationSharingImpact,
} from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import type { SharedFilesAccess } from "../shared/store";
import {
  NON_EXTERNALIZABLE_WIKI_DOMAINS,
  canonicalJson,
  sha256Hex,
  validateProjectionDomain,
  validateProjectionJsonPath,
  type SpecialistDisagreementMetadata,
} from "./contracts";
import { normalizeStatementFingerprint } from "./migration-and-maintenance";
import {
  detectExistingDomainConflict,
  detectSpecialistDisagreement,
} from "./projections";

export type WikiPkmProjectionProvenance = {
  receipt_id: string;
  claim_id: string;
  page_id: string;
  page_revision: number;
  source_revision: number;
  value_sha256: string;
  updated_at: string;
};

export type StaledWikiProjectionDescriptor = {
  receiptId: string;
  domain: string;
  jsonPath: string;
  pageId: string;
  pageRevision: number;
  claimId: string;
  sourceRevision: number;
};

export type ClassifiedWikiClaimMapping = {
  statement: string;
  fingerprint: string;
  targetDomain: string;
  jsonPath: string;
  proposedValue: unknown;
  writeMode: "can_save" | "confirm_first";
  requiresConfirmation: boolean;
  sharingImpact?: PkmMutationSharingImpact;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getValueAtJsonPath(
  root: Record<string, unknown>,
  jsonPath: string,
): unknown {
  let cursor: unknown = root;
  for (const seg of jsonPath.split(".")) {
    if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, seg)) {
      return undefined;
    }
    cursor = cursor[seg];
  }
  return cursor;
}

export function setValueAtJsonPath(
  root: Record<string, unknown>,
  jsonPath: string,
  value: unknown,
): void {
  const segments = jsonPath.split(".").filter(Boolean);
  if (segments.length === 0) return;
  let cursor: Record<string, unknown> = root;
  for (let idx = 0; idx < segments.length - 1; idx += 1) {
    const seg = segments[idx]!;
    const next = cursor[seg];
    if (!isPlainObject(next)) {
      const created: Record<string, unknown> = {};
      cursor[seg] = created;
      cursor = created;
    } else {
      cursor = next;
    }
  }
  cursor[segments[segments.length - 1]!] = value;
}

export function deleteValueAtJsonPathAndPrune(
  root: Record<string, unknown>,
  jsonPath: string,
): boolean {
  const segments = jsonPath.split(".").filter(Boolean);
  if (segments.length === 0) return false;
  const stack: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let cursor: unknown = root;
  for (let idx = 0; idx < segments.length - 1; idx += 1) {
    const seg = segments[idx]!;
    if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, seg)) {
      return false;
    }
    stack.push({ parent: cursor, key: seg });
    cursor = cursor[seg];
  }
  const leafKey = segments[segments.length - 1]!;
  if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, leafKey)) {
    return false;
  }
  delete cursor[leafKey];
  for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
    const { parent, key } = stack[idx]!;
    const child = parent[key];
    if (isPlainObject(child) && Object.keys(child).length === 0) {
      delete parent[key];
    } else {
      break;
    }
  }
  return true;
}

function sanitizePathSlug(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned || /^[0-9]/.test(cleaned)) {
    return `item_${cleaned || "note"}`.slice(0, 48);
  }
  return cleaned.slice(0, 48);
}

function extractLeafFromCandidateCard(
  card: AgentPkmPreviewCard,
  fallbackStatement: string,
): { jsonPath: string; value: unknown } | null {
  const primary = String(card.primary_json_path || card.target_entity_scope || "").trim();
  const payload = isPlainObject(card.candidate_payload) ? card.candidate_payload : null;

  const firstScalarLeaf = (
    node: Record<string, unknown>,
    prefix = "",
    depth = 0,
  ): { path: string; val: unknown } | null => {
    if (depth > 6) return null;
    for (const [k, v] of Object.entries(node)) {
      const seg = sanitizePathSlug(k);
      if (!seg || seg.startsWith("_") || seg === "superseded") continue;
      const nextPath = prefix ? `${prefix}.${seg}` : seg;
      if (isPlainObject(v)) {
        const nested = firstScalarLeaf(v, nextPath, depth + 1);
        if (nested) return nested;
      } else if (v !== undefined && v !== null && String(v).trim() !== "") {
        return { path: nextPath, val: v };
      }
    }
    return null;
  };

  if (payload) {
    const discovered = firstScalarLeaf(payload);
    if (discovered) {
      try {
        return {
          jsonPath: validateProjectionJsonPath(discovered.path),
          value: discovered.val,
        };
      } catch {
        // Fall through to normalized primary path below
      }
    }
  }

  if (!primary) return null;
  const normalizedSegments = primary
    .split(".")
    .map((part) => sanitizePathSlug(part))
    .filter((part) => Boolean(part) && !part.startsWith("_"));
  if (normalizedSegments.length === 0) return null;
  const candidatePath =
    normalizedSegments.length === 1
      ? `${normalizedSegments[0]}.note_${sanitizePathSlug(fallbackStatement.slice(0, 24))}`
      : normalizedSegments.join(".");
  try {
    return {
      jsonPath: validateProjectionJsonPath(candidatePath),
      value: fallbackStatement,
    };
  } catch {
    return null;
  }
}

export async function classifyWikiClaimsForPkm(
  access: SharedFilesAccess,
  statements: readonly string[],
  signal?: AbortSignal,
): Promise<ClassifiedWikiClaimMapping[]> {
  access.check();
  const boundedStatements = statements
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 24);
  if (boundedStatements.length === 0) return [];

  let currentDomains: string[] = [];
  const currentManifests: unknown[] = [];
  try {
    const metadata = await PersonalKnowledgeModelService.getMetadata(
      access.owner,
      false,
      access.ownerToken,
    );
    currentDomains = (metadata.domains || [])
      .map((d) => String(d.key || "").trim().toLowerCase())
      .filter(Boolean);
    const manifestFetchTargets = currentDomains.slice(0, 12);
    const loadedManifests = await Promise.all(
      manifestFetchTargets.map((domainKey) =>
        PersonalKnowledgeModelService.getDomainManifest(
          access.owner,
          domainKey,
          access.ownerToken,
        ).catch(() => null),
      ),
    );
    for (const m of loadedManifests) {
      if (m) currentManifests.push(m);
    }
  } catch {
    // Metadata unavailability degrades cleanly; preparation still runs or skips safely.
  }

  access.check();
  let cards: AgentPkmPreviewCard[] = [];
  try {
    const prepared = await requestPkmMemoryPreparation({
      userId: access.owner,
      message: boundedStatements.map((s) => `- ${s}`).join("\n"),
      currentDomains,
      currentManifests,
      vaultOwnerToken: access.ownerToken,
      memoryProfile: "wiki_claim_projection_v1",
      sourceLabel: "one_wiki_opt_in_auto_save",
      signal,
      isEffectCurrent: () => {
        try {
          access.check();
          return true;
        } catch {
          return false;
        }
      },
    });
    cards = Array.isArray(prepared.payload.preview_cards)
      ? prepared.payload.preview_cards
      : [];
  } catch {
    return [];
  }

  const out: ClassifiedWikiClaimMapping[] = [];
  for (const card of cards) {
    if (card.write_mode === "do_not_save" || isDegradedPreviewCard(card)) {
      continue;
    }
    const rawDomain = resolveCardTargetDomain(card).trim().toLowerCase();
    if (!rawDomain || rawDomain === "unresolved" || NON_EXTERNALIZABLE_WIKI_DOMAINS.has(rawDomain)) {
      continue;
    }
    let targetDomain: string;
    try {
      targetDomain = validateProjectionDomain(rawDomain);
    } catch {
      continue;
    }

    const matchedStatement =
      boundedStatements.find((stmt) => {
        const quote = String(card.source_quote || card.source_text || "").trim().toLowerCase();
        const lower = stmt.toLowerCase();
        return Boolean(quote) && (lower.includes(quote) || quote.includes(lower));
      }) ??
      String(card.source_text || "").trim();
    if (!matchedStatement) continue;

    const extracted = extractLeafFromCandidateCard(card, matchedStatement);
    if (!extracted) continue;

    let finalPath = extracted.jsonPath;
    const reserved = reservedEntryFor(targetDomain, finalPath);
    if (reserved) {
      if (!reserved.agentMemorySibling) continue;
      const leafSuffix = finalPath.split(".").slice(1).join(".") || sanitizePathSlug(finalPath);
      try {
        finalPath = validateProjectionJsonPath(`${reserved.agentMemorySibling}.${leafSuffix}`);
      } catch {
        continue;
      }
    }

    const fp = await normalizeStatementFingerprint(matchedStatement);
    const sharingImpact: PkmMutationSharingImpact | undefined = card.sharing_impact
      ? {
          activeRecipientCount: card.sharing_impact.active_recipient_count,
          recipientLabels: card.sharing_impact.recipient_labels,
          entersNextExportRevision: card.sharing_impact.enters_next_export_revision,
          summary: card.sharing_impact.summary,
          affectedGrantIds: card.sharing_impact.affected_grant_ids,
          affectedExportIds: card.sharing_impact.affected_export_ids,
        }
      : undefined;

    out.push({
      statement: matchedStatement,
      fingerprint: fp,
      targetDomain,
      jsonPath: finalPath,
      proposedValue: extracted.value,
      writeMode: card.write_mode === "can_save" ? "can_save" : "confirm_first",
      requiresConfirmation: Boolean(card.requires_confirmation) || card.write_mode !== "can_save",
      sharingImpact,
    });
  }
  return out;
}

export async function inspectPkmConflictsForProjection(
  access: SharedFilesAccess,
  input: {
    domain: string;
    jsonPath: string;
    statement: string;
    proposedValue?: unknown;
  },
): Promise<{
  conflict: SpecialistDisagreementMetadata | null;
  specialistSnapshot: Record<string, unknown>;
  existingDomainData: Record<string, unknown> | null;
}> {
  access.check();
  const domainsToInspect = Array.from(
    new Set(["financial", "identity", input.domain]),
  );
  const batch = await PkmDomainResourceService.getManyStaleFirst({
    userId: access.owner,
    domains: domainsToInspect,
    vaultKey: access.vaultKey,
    vaultOwnerToken: access.ownerToken,
  }).catch(() => ({ snapshots: {} as Record<string, { data?: Record<string, unknown> }> }));
  const snapshots = batch.snapshots;

  const specialistSnapshot: Record<string, unknown> = {};
  const finData = snapshots.financial?.data;
  if (isPlainObject(finData)) specialistSnapshot.financial = finData;
  const idData = snapshots.identity?.data;
  if (isPlainObject(idData)) specialistSnapshot.identity = idData;

  const targetSnapshot = snapshots[input.domain]?.data;
  const existingDomainData = isPlainObject(targetSnapshot) ? targetSnapshot : null;

  const conflict =
    detectSpecialistDisagreement({
      claimStatement: input.statement,
      targetDomain: input.domain,
      jsonPath: input.jsonPath,
      proposedValue: input.proposedValue,
      specialistSnapshot,
    }) ??
    detectExistingDomainConflict({
      claimStatement: input.statement,
      targetDomain: input.domain,
      jsonPath: input.jsonPath,
      proposedValue: input.proposedValue,
      existingDomainData,
    });

  return { conflict, specialistSnapshot, existingDomainData };
}

export async function fetchProjectionSharingImpact(
  access: SharedFilesAccess,
  domain: string,
  jsonPath: string,
): Promise<PkmMutationSharingImpact> {
  access.check();
  const topScope = jsonPath.split(".")[0] || jsonPath;
  return PersonalKnowledgeModelService.getMutationSharingImpact({
    userId: access.owner,
    domain,
    scopePath: topScope,
    vaultOwnerToken: access.ownerToken,
  });
}

export type MaterializeProjectionOutcome =
  | {
      outcome: "materialized";
      sharingImpact: PkmMutationSharingImpact;
      dataVersion?: number;
    }
  | {
      outcome: "conflicted";
      conflict: SpecialistDisagreementMetadata;
    }
  | {
      outcome: "requires_confirmation";
      sharingImpact: PkmMutationSharingImpact;
    }
  | {
      outcome: "requires_upgrade";
      message?: string;
    };

export async function materializeWikiReceiptToPkm(
  access: SharedFilesAccess,
  item: {
    receiptId: string;
    domain: string;
    jsonPath: string;
    pageId: string;
    pageRevision: number;
    claimId: string;
    sourceRevision: number;
    statement: string;
    proposedValue?: unknown;
  },
  options: {
    ownerConfirmed: boolean;
    autoSaveEnabledAtIso?: string;
    sharingImpactOverride?: PkmMutationSharingImpact;
  },
): Promise<MaterializeProjectionOutcome> {
  access.check();
  const domain = validateProjectionDomain(item.domain);
  const jsonPath = validateProjectionJsonPath(item.jsonPath);
  const reserved = reservedEntryFor(domain, jsonPath);
  if (reserved) {
    return {
      outcome: "conflicted",
      conflict: {
        authority: domain,
        reason: "reserved_branch_protected",
        path: `${domain}.${jsonPath}`.slice(0, 128),
      },
    };
  }

  const leafValue =
    item.proposedValue !== undefined && item.proposedValue !== null
      ? item.proposedValue
      : item.statement;

  const [{ conflict }, sharingImpact] = await Promise.all([
    inspectPkmConflictsForProjection(access, {
      domain,
      jsonPath,
      statement: item.statement,
      proposedValue: leafValue,
    }),
    options.sharingImpactOverride
      ? Promise.resolve(options.sharingImpactOverride)
      : fetchProjectionSharingImpact(access, domain, jsonPath),
  ]);

  if (conflict) {
    return { outcome: "conflicted", conflict };
  }
  if (!options.ownerConfirmed && sharingImpact.activeRecipientCount > 0) {
    return { outcome: "requires_confirmation", sharingImpact };
  }

  const valueHash = await sha256Hex(canonicalJson(leafValue));
  const nowIso = new Date().toISOString();
  const topScope = jsonPath.split(".")[0]!;

  const confirmation = options.ownerConfirmed
    ? {
        confirmedByUser: true as const,
        surface: "web" as const,
        source: "one_wiki_candidate_confirm",
        sharingImpactAcknowledged: sharingImpact.activeRecipientCount > 0,
        sharingImpact,
      }
    : {
        authorizationMode: "owner_auto_save_policy" as const,
        surface: "chat" as const,
        source: "one_wiki_opt_in_auto_save",
        autoSavePolicyVersion: 1 as const,
        autoSavePolicyEnabledAt: options.autoSaveEnabledAtIso || nowIso,
      };

  const writeResult = await PkmWriteCoordinator.saveMergedDomain({
    userId: access.owner,
    domain,
    vaultKey: access.vaultKey,
    vaultOwnerToken: access.ownerToken,
    confirmation,
    idempotencyScope: `wiki_proj:${item.receiptId}:p${item.pageRevision}:s${item.sourceRevision}`,
    beforeEffect: async () => access.check(),
    mayPublish: () => {
      try {
        access.check();
        return true;
      } catch {
        return false;
      }
    },
    build: (context) => {
      const nextDomainData = cloneRecord(context.currentDomainData || {});
      const existingConflict = detectExistingDomainConflict({
        claimStatement: item.statement,
        targetDomain: domain,
        jsonPath,
        proposedValue: leafValue,
        existingDomainData: nextDomainData,
      });
      if (existingConflict) {
        throw new Error(`WIKI_PKM_CONFLICT:${existingConflict.reason}`);
      }

      const prevLedger = isPlainObject(nextDomainData[WIKI_PROJECTIONS_BRANCH])
        ? cloneRecord(
            nextDomainData[WIKI_PROJECTIONS_BRANCH] as Record<
              string,
              WikiPkmProjectionProvenance
            >,
          )
        : {};
      const priorEntry = prevLedger[jsonPath];
      const currentLeaf = getValueAtJsonPath(nextDomainData, jsonPath);
      if (
        priorEntry &&
        priorEntry.receipt_id === item.receiptId &&
        priorEntry.value_sha256 === valueHash &&
        canonicalJson(currentLeaf) === canonicalJson(leafValue)
      ) {
        return {
          unchanged: true,
          domainData: nextDomainData,
          summary: {},
        };
      }

      setValueAtJsonPath(nextDomainData, jsonPath, leafValue);
      prevLedger[jsonPath] = {
        receipt_id: item.receiptId,
        claim_id: item.claimId,
        page_id: item.pageId,
        page_revision: item.pageRevision,
        source_revision: item.sourceRevision,
        value_sha256: valueHash,
        updated_at: nowIso,
      };
      nextDomainData[WIKI_PROJECTIONS_BRANCH] = prevLedger;

      const wikiProjectionStates: Record<
        string,
        { state: PkmScopeMaterializationState; receipt_id?: string | null }
      > = {
        [jsonPath]: { state: "materialized", receipt_id: item.receiptId },
      };
      const artifacts = buildPersonalKnowledgeModelStructureArtifacts({
        domain,
        domainData: nextDomainData,
        previousManifest: context.currentManifest,
        wikiProjectionStates,
      });

      return {
        domainData: nextDomainData,
        summary: {
          updated_at: nowIso,
        },
        manifest: artifacts.manifest,
        wikiProjectionStates,
        operation: context.currentManifest ? "update" : "create",
        scopePath: topScope,
      };
    },
  });

  if (writeResult.saveState === "blocked_pending_upgrade") {
    return { outcome: "requires_upgrade", message: writeResult.message };
  }
  if (!writeResult.success) {
    if (writeResult.message?.startsWith("WIKI_PKM_CONFLICT:")) {
      return {
        outcome: "conflicted",
        conflict: {
          authority: domain,
          reason: "existing_pkm_value_conflict",
          path: `${domain}.${jsonPath}`.slice(0, 128),
        },
      };
    }
    throw new Error(writeResult.message || "Failed to materialize wiki update to PKM.");
  }

  return {
    outcome: "materialized",
    sharingImpact,
    dataVersion: writeResult.dataVersion,
  };
}

export async function retractStaleWikiProjectionsFromPkm(
  access: SharedFilesAccess,
  staledReceipts: readonly StaledWikiProjectionDescriptor[],
): Promise<{ allSucceeded: boolean; retractedPaths: string[] }> {
  access.check();
  if (staledReceipts.length === 0) {
    return { allSucceeded: true, retractedPaths: [] };
  }

  const byDomain = new Map<string, StaledWikiProjectionDescriptor[]>();
  for (const item of staledReceipts) {
    if (!item.domain || !item.jsonPath || !item.receiptId) continue;
    const list = byDomain.get(item.domain) ?? [];
    list.push(item);
    byDomain.set(item.domain, list);
  }

  let allSucceeded = true;
  const retractedPaths: string[] = [];

  for (const [domain, receipts] of byDomain.entries()) {
    try {
      const firstTopScope = receipts[0]!.jsonPath.split(".")[0]!;
      const sharingImpact = await fetchProjectionSharingImpact(
        access,
        domain,
        firstTopScope,
      ).catch(() => ({
        activeRecipientCount: 0,
        recipientLabels: [],
        entersNextExportRevision: false,
        summary: "",
        affectedGrantIds: [],
        affectedExportIds: [],
      }));

      const domainRetracted: string[] = [];
      const receiptSig = receipts
        .map((r) => `${r.receiptId}:${r.sourceRevision}`)
        .sort()
        .join(",");

      const writeRes = await PkmWriteCoordinator.saveMergedDomain({
        userId: access.owner,
        domain,
        vaultKey: access.vaultKey,
        vaultOwnerToken: access.ownerToken,
        confirmation: {
          confirmedByUser: true,
          surface: "web",
          source: "one_wiki_claim_forget",
          sharingImpactAcknowledged: true,
          sharingImpact,
        },
        idempotencyScope: `wiki_forget:${domain}:${receiptSig}`.slice(0, 120),
        beforeEffect: async () => access.check(),
        mayPublish: () => {
          try {
            access.check();
            return true;
          } catch {
            return false;
          }
        },
        build: async (context) => {
          if (!context.currentManifest) {
            return {
              unchanged: true,
              domainData: context.currentDomainData,
              summary: {},
            };
          }
          const nextDomainData = cloneRecord(context.currentDomainData || {});
          const rawLedger = nextDomainData[WIKI_PROJECTIONS_BRANCH];
          if (!isPlainObject(rawLedger)) {
            return {
              unchanged: true,
              domainData: nextDomainData,
              summary: {},
            };
          }
          const ledger = cloneRecord(
            rawLedger as Record<string, WikiPkmProjectionProvenance>,
          );
          let mutated = false;
          const staleStates: Record<
            string,
            { state: PkmScopeMaterializationState; receipt_id?: string | null }
          > = {};

          for (const rec of receipts) {
            const prov = ledger[rec.jsonPath];
            if (!prov || prov.receipt_id !== rec.receiptId) {
              continue;
            }
            const currentLeaf = getValueAtJsonPath(nextDomainData, rec.jsonPath);
            if (currentLeaf !== undefined) {
              const currentHash = await sha256Hex(canonicalJson(currentLeaf));
              if (currentHash === prov.value_sha256) {
                if (deleteValueAtJsonPathAndPrune(nextDomainData, rec.jsonPath)) {
                  domainRetracted.push(`${domain}.${rec.jsonPath}`);
                }
              }
            }
            delete ledger[rec.jsonPath];
            staleStates[rec.jsonPath] = {
              state: "stale",
              receipt_id: rec.receiptId,
            };
            mutated = true;
          }

          if (!mutated) {
            return {
              unchanged: true,
              domainData: nextDomainData,
              summary: {},
            };
          }

          if (Object.keys(ledger).length > 0) {
            nextDomainData[WIKI_PROJECTIONS_BRANCH] = ledger;
          } else {
            delete nextDomainData[WIKI_PROJECTIONS_BRANCH];
          }

          const artifacts = buildPersonalKnowledgeModelStructureArtifacts({
            domain,
            domainData: nextDomainData,
            previousManifest: context.currentManifest,
            wikiProjectionStates: staleStates,
          });
          const priorTopScopes = new Set(
            context.currentManifest.top_level_scope_paths || [],
          );
          const remainingLiveTopScopes = new Set(
            artifacts.manifest.paths
              .filter((p) => p.exposure_eligibility && p.path_type === "leaf")
              .map((p) => p.json_path.split(".")[0]!)
              .filter(Boolean),
          );
          const emptiedScope = Array.from(priorTopScopes).find(
            (scope) => !remainingLiveTopScopes.has(scope),
          );

          return {
            domainData: nextDomainData,
            summary: { updated_at: new Date().toISOString() },
            manifest: artifacts.manifest,
            wikiProjectionStates: staleStates,
            mergeDecision: { merge_mode: "replace" },
            operation: emptiedScope ? "delete" : "update",
            scopePath: emptiedScope ?? firstTopScope,
          };
        },
      });

      if (!writeRes.success) {
        allSucceeded = false;
      } else {
        retractedPaths.push(...domainRetracted);
      }
    } catch {
      allSucceeded = false;
    }
  }

  return { allSucceeded, retractedPaths };
}
