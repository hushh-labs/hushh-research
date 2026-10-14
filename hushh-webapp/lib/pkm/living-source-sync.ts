"use client";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { ConsentCenterService } from "@/lib/services/consent-center-service";
import { ConnectionsService } from "@/lib/services/connections-service";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import { DocumentPayoutService } from "@/lib/services/document-payout-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import {
  reconcileLivingSources,
  DOCUMENT_EARNINGS_FRESHNESS_MS,
  CONNECTION_FRESHNESS_MS,
  CONSENT_FRESHNESS_MS,
  CURATED_OAUTH_CONNECTOR_FRESHNESS_MS,
  type LivingSourceInput,
  type LivingSourceInventory,
} from "@/lib/pkm/living-source-records";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

export const LIVING_SOURCE_DOMAIN = "one_living_sources";
const CONNECTION_PAGE_LIMIT = 100;
const MAX_CONNECTION_RECORDS = 5_000;
const MAX_CONNECTOR_CATALOG_ROWS = 500;
const MAX_RETAINED_CURATED_OAUTH_CONNECTORS = 1_000;
const MAX_DOCUMENT_EARNINGS = 5_000;
const MAX_RETAINED_CONNECTION_RECORDS = 10_000;
const MAX_RETAINED_DOCUMENT_EARNINGS = 10_000;
const MAX_CONSENT_SCAN_ROWS = 5_000;
const MAX_CONSENT_PAGE_READS = 100;
const MAX_RETAINED_CONSENT_RECORDS = 10_000;
type CompletedScan = { epoch: number; verifiedAt: string; completedAt: string };
const lastDocumentEarningsScan = new Map<string, CompletedScan>();
const lastConnectionScan = new Map<string, CompletedScan>();
const lastConsentScan = new Map<string, CompletedScan>();
const lastCuratedConnectorScan = new Map<string, CompletedScan>();
const lastConsentOverflow = new Map<string, { epoch: number; at: string }>();

class ConsentSourceCapacityError extends Error {}

function canReuseVerifiedScan(params: {
  userId: string;
  epoch: number;
  previousAt?: string;
  observedAt: string;
  maxAge: number;
  forced?: boolean;
  cache: Map<string, CompletedScan>;
}): boolean {
  const cached = params.cache.get(params.userId);
  const age = params.previousAt
    ? Date.parse(params.observedAt) - Date.parse(params.previousAt)
    : Infinity;
  const cooldownAge = cached
    ? Date.parse(params.observedAt) - Date.parse(cached.completedAt)
    : Infinity;
  return !params.forced && cached?.epoch === params.epoch &&
    cached.verifiedAt === params.previousAt && age >= 0 &&
    (age < params.maxAge || (cooldownAge >= 0 && cooldownAge < params.maxAge));
}

/** The owner-vault earnings API uses a stable (createdAt, requestId) keyset.
 * Scan both mode partitions twice; any gap, duplicate, shift or overflow keeps
 * earlier records and forbids a deletion inference. */
async function collectDocumentEarnings(vaultOwnerToken: string): Promise<LivingSourceInput[]> {
  const scan = async () => {
    const entries: LivingSourceInput[] = [];
    const ids = new Set<string>();
    for (const mode of ["live", "test"] as const) {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (;;) {
        const response = await DocumentPayoutService.earnings(vaultOwnerToken, cursor, mode);
        if (response.currency !== "USD" || response.mode !== mode ||
            !Array.isArray(response.transactions) || response.transactions.length > 20 ||
            !(response.nextCursor === null || typeof response.nextCursor === "string") ||
            (response.nextCursor !== null &&
              (response.transactions.length !== 20 ||
                response.nextCursor !== response.transactions.at(-1)?.requestId ||
                seenCursors.has(response.nextCursor))))
          throw new Error("Document earnings page could not be verified");
        for (const row of response.transactions) {
          if (
            !row || typeof row.requestId !== "string" || !row.requestId ||
            ids.has(row.requestId) ||
            (mode === "live" ? row.stripeMode !== "live" :
              row.stripeMode !== "test" && row.stripeMode !== "legacy") ||
            typeof row.status !== "string" || !row.status ||
            !Number.isSafeInteger(row.grossAmountCents) || row.grossAmountCents < 0 ||
            (row.refundAmountCents !== null &&
              (!Number.isSafeInteger(row.refundAmountCents) || row.refundAmountCents < 0)) ||
            (row.netAmountCents !== null &&
              (!Number.isSafeInteger(row.netAmountCents) || row.netAmountCents < 0)) ||
            typeof row.createdAt !== "string" ||
            !Number.isFinite(Date.parse(row.createdAt)) ||
            (row.transferredAt !== null &&
              (typeof row.transferredAt !== "string" ||
                !Number.isFinite(Date.parse(row.transferredAt)))) ||
            (row.settlementMethod !== undefined &&
              !["stripe_transfer", "hashcoins"].includes(row.settlementMethod))
          ) throw new Error("Document earning row could not be verified");
          ids.add(row.requestId);
          entries.push({
            kind: "document_earning",
            id: row.requestId,
            createdAt: row.createdAt,
            updatedAt: null,
            value: {
              requestId: row.requestId,
              stripeMode: row.stripeMode,
              status: row.status,
              grossCents: row.grossAmountCents,
              refundCents: row.refundAmountCents,
              netCents: row.netAmountCents,
              createdAt: row.createdAt,
              transferredAt: row.transferredAt,
              settlementMethod: row.settlementMethod ?? null,
            },
          });
        }
        if (entries.length > MAX_DOCUMENT_EARNINGS ||
            (entries.length === MAX_DOCUMENT_EARNINGS && response.nextCursor !== null))
          throw new Error("Document earnings inventory exceeds its safe bound");
        if (response.nextCursor === null) break;
        seenCursors.add(response.nextCursor);
        cursor = response.nextCursor;
      }
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  };
  const first = await scan();
  const second = await scan();
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error("Document earnings changed during pagination; retry required");
  return second;
}

/** The owner-token endpoint returns its complete, unpaginated catalog and
 * owner credential statuses. Strict source-read mode rejects malformed 2xx
 * responses while allowing a genuinely empty catalog. */
async function collectConnectorStatuses(vaultOwnerToken: string): Promise<LivingSourceInput[]> {
  const scan = async () => {
    const overview = await ExternalConnectorService.overview(vaultOwnerToken, {
      sourceRead: true,
    });
    const rows = overview.connectors;
    if (!Array.isArray(rows) || rows.length > MAX_CONNECTOR_CATALOG_ROWS)
      throw new Error("Connector catalog completeness unverified");
    const ids = new Set<string>();
    const entries: LivingSourceInput[] = [];
    for (const row of rows) {
      if (
        !row || typeof row.connectorId !== "string" || !row.connectorId ||
        ids.has(row.connectorId) ||
        !["oauth", "api_key"].includes(row.authStyle) ||
        !["not_connected", "connected", "verifying", "needs_reauth", "revoked", "error"].includes(row.status) ||
        (row.connectedAt != null &&
          (typeof row.connectedAt !== "string" ||
            !Number.isFinite(Date.parse(row.connectedAt))))
      ) throw new Error("Connector catalog row could not be verified");
      ids.add(row.connectorId);
      if (row.authStyle !== "oauth" || row.status === "not_connected" ||
          (row.curatedOAuth !== true && row.connectorId !== "google_drive")) continue;
      entries.push({
        kind: "curated_oauth_connector",
        id: row.connectorId,
        createdAt: row.connectedAt ?? null,
        updatedAt: null,
        value: {
          provider: row.connectorId,
          status: row.status,
          connectedAt: row.connectedAt ?? null,
          authStyle: row.authStyle,
        },
      });
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  };
  const first = await scan();
  const second = await scan();
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error("Connector statuses changed during read; retry required");
  return second;
}

/** Offset pagination has no revision fence. Only matching complete scans may
 * authorize deletion; a concurrent change during either scan fails closed. */
async function collectConnections(params: {
  userId: string;
  idToken: string;
}): Promise<LivingSourceInput[]> {
  const scan = async () => {
    const entries: LivingSourceInput[] = [];
    const connectionIds = new Set<string>();
    const counterpartIds = new Set<string>();
    let expectedCount: number | null = null;
    for (let page = 1; ; page += 1) {
      const response = await ConnectionsService.listConnectionsPage({
        idToken: params.idToken,
        page,
        limit: CONNECTION_PAGE_LIMIT,
        audience: "all",
        sourceRead: true,
      });
      if (
        response.page !== page || response.audience !== "all" ||
        !Number.isSafeInteger(response.totalCount) || response.totalCount < 0 ||
        response.totalCount > MAX_CONNECTION_RECORDS ||
        (expectedCount !== null && response.totalCount !== expectedCount) ||
        !Array.isArray(response.items) ||
        response.items.length > CONNECTION_PAGE_LIMIT ||
        typeof response.hasMore !== "boolean"
      ) throw new Error("Connection page could not be verified");
      expectedCount = response.totalCount;
      for (const item of response.items) {
        if (
          !item || typeof item.connectionId !== "string" || !item.connectionId ||
          typeof item.userId !== "string" || !item.userId ||
          item.userId === params.userId ||
          connectionIds.has(item.connectionId) ||
          counterpartIds.has(item.userId) ||
          typeof item.connectedFromContacts !== "boolean" ||
          (item.createdAt !== null &&
            (typeof item.createdAt !== "string" ||
              !Number.isFinite(Date.parse(item.createdAt))))
        ) throw new Error("Connection row could not be verified");
        connectionIds.add(item.connectionId);
        counterpartIds.add(item.userId);
        entries.push({
          kind: "connection",
          id: item.connectionId,
          createdAt: item.createdAt,
          updatedAt: null,
          value: {
            counterpartId: item.userId,
            establishedAt: item.createdAt,
            connectedFromContacts: item.connectedFromContacts,
          },
        });
      }
      if (entries.length > expectedCount ||
          response.hasMore !== (entries.length < expectedCount) ||
          (response.hasMore && response.items.length === 0))
        throw new Error("Connection pagination incomplete");
      if (!response.hasMore) break;
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  };
  const first = await scan();
  const second = await scan();
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw new Error("Connections changed during pagination; retry required");
  return second;
}

export async function syncLivingSources(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  idToken: string;
  forceDocumentEarnings?: boolean;
  forceConnections?: boolean;
  forceConsent?: boolean;
  forceCuratedConnectors?: boolean;
}): Promise<void> {
  const epoch = snapshotVaultSessionEpoch();
  const readStartedAt = new Date().toISOString();
  let storedSnapshotAt = readStartedAt;
  let incomplete = false;
  let earningsScanned = false;
  let connectionsScanned = false;
  let consentScanned = false;
  let curatedConnectorsScanned = false;
  let earningsVerifiedAt: string | undefined;
  let connectionVerifiedAt: string | undefined;
  let consentVerifiedAt: string | undefined;
  let curatedConnectorsVerifiedAt: string | undefined;
  let consentOverflowed = false;
  const fetchSources = async (previous?: LivingSourceInventory) => {
    // A coordinator conflict can run build again. Only the final attempt may
    // publish verification and cooldown state.
    earningsScanned = false;
    connectionsScanned = false;
    consentScanned = false;
    curatedConnectorsScanned = false;
    earningsVerifiedAt = undefined;
    connectionVerifiedAt = undefined;
    consentVerifiedAt = undefined;
    curatedConnectorsVerifiedAt = undefined;
    consentOverflowed = false;
    const inputs: LivingSourceInput[] = [];
    const successful: string[] = [];
    const unavailable: string[] = [];
    try {
      const identity = await AccountIdentityService.refreshIdentityForSession(
        params.userId,
        params.idToken,
        { force: true },
      );
      if (!identity || identity.user_id !== params.userId)
        throw new Error("Identity unavailable");
      inputs.push({
        kind: "profile",
        id: params.userId,
        createdAt: identity.created_at ?? null,
        updatedAt: identity.updated_at ?? identity.last_synced_at ?? null,
        value: {
          name: identity.display_name ?? null,
          photo: identity.photo_url ?? null,
          email: identity.email ?? null,
        },
      });
      successful.push("profile");
    } catch {
      unavailable.push("profile");
    }
    const overflow = lastConsentOverflow.get(params.userId);
    const overflowAge = overflow ? Date.parse(readStartedAt) - Date.parse(overflow.at) : Infinity;
    if (!params.forceConsent && previous?.unavailable?.includes("consent") &&
        overflow?.epoch === epoch &&
        overflowAge >= 0 && overflowAge < CONSENT_FRESHNESS_MS) {
      unavailable.push("consent");
    } else if (!canReuseVerifiedScan({
      userId: params.userId, epoch, observedAt: readStartedAt,
      previousAt: previous?.verifiedAt?.consent,
      maxAge: CONSENT_FRESHNESS_MS,
      forced: params.forceConsent,
      cache: lastConsentScan,
    })) try {
      const startFence = await ConsentCenterService.sourceFence(
        params.idToken,
        params.userId,
      );
      const collectConsent = async () => {
        const entries = new Map<string, LivingSourceInput>();
        let scannedRows = 0;
        let pageReads = 0;
        for (const surface of ["pending", "active", "previous"] as const) {
          for (const requestView of (surface === "pending"
            ? ["received", "sent"]
            : ["received"]) as ("received" | "sent")[]) {
            const seenPages = new Set<string>();
            for (let page = 1; ; page += 1) {
              const response = await ConsentCenterService.listEntries({
                idToken: params.idToken,
                userId: params.userId,
                surface,
                requestView,
                page,
                limit: 100,
                force: true,
                sourceRead: true,
              });
              pageReads++;
              if (pageReads > MAX_CONSENT_PAGE_READS ||
                  !Array.isArray(response.items) || response.items.length > 100)
                throw new ConsentSourceCapacityError("Consent source scan exceeds its safe bound");
              if (response.source_read_verified !== true)
                throw new Error("Source completeness unverified");
              if (response.user_id !== params.userId)
                throw new Error("Owner mismatch");
              const pageSignature = JSON.stringify(
                response.items.map((item) => item.id),
              );
              if (seenPages.has(pageSignature) && response.items.length)
                throw new Error("Repeated source page");
              seenPages.add(pageSignature);
              scannedRows += response.items.length;
              if (scannedRows > MAX_CONSENT_SCAN_ROWS)
                throw new ConsentSourceCapacityError("Consent source scan exceeds its safe bound");
              for (const entry of response.items) {
                // Presentation fields only: tokens, request payloads and provider metadata never enter memory.
                const expired =
                  entry.expires_at &&
                  Number(new Date(entry.expires_at)) < Date.now();
                entries.set(entry.id, {
                  kind: "consent",
                  id: entry.id,
                  createdAt: entry.issued_at
                    ? new Date(entry.issued_at).toISOString()
                    : null,
                  updatedAt: null,
                  value: {
                    scope: entry.scope ?? null,
                    status: expired && entry.active ? "expired" : entry.status,
                    active: expired ? false : entry.active === true,
                    counterpart: entry.counterpart_id ?? null,
                    expiresAt: entry.expires_at ?? null,
                    action: entry.action,
                  },
                });
              }
              if (!response.has_more) break;
              if (!response.items.length)
                throw new Error("Incomplete source pagination");
            }
          }
        }
        return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
      };
      const first = await collectConsent();
      const second = await collectConsent();
      const endFence = await ConsentCenterService.sourceFence(
        params.idToken,
        params.userId,
      );
      if (
        startFence !== endFence ||
        JSON.stringify(first) !== JSON.stringify(second)
      )
        throw new Error("Consent changed during pagination; retry required");
      inputs.push(...second);
      successful.push("consent");
      consentScanned = true;
      consentVerifiedAt = new Date().toISOString();
    } catch (error) {
      consentOverflowed = error instanceof ConsentSourceCapacityError;
      unavailable.push("consent");
    }
    if (!canReuseVerifiedScan({
      userId: params.userId, epoch, observedAt: readStartedAt,
      previousAt: previous?.verifiedAt?.connection,
      maxAge: CONNECTION_FRESHNESS_MS,
      forced: params.forceConnections,
      cache: lastConnectionScan,
    })) {
      try {
        inputs.push(...await collectConnections(params));
        successful.push("connection");
        connectionsScanned = true;
        connectionVerifiedAt = new Date().toISOString();
      } catch {
        unavailable.push("connection");
      }
    }
    if (!canReuseVerifiedScan({
      userId: params.userId, epoch, observedAt: readStartedAt,
      previousAt: previous?.verifiedAt?.curated_oauth_connector,
      maxAge: CURATED_OAUTH_CONNECTOR_FRESHNESS_MS,
      forced: params.forceCuratedConnectors,
      cache: lastCuratedConnectorScan,
    })) {
      try {
        inputs.push(...await collectConnectorStatuses(params.vaultOwnerToken));
        successful.push("curated_oauth_connector");
        curatedConnectorsScanned = true;
        curatedConnectorsVerifiedAt = new Date().toISOString();
      } catch {
        unavailable.push("curated_oauth_connector");
      }
    }
    if (!canReuseVerifiedScan({
      userId: params.userId, epoch, observedAt: readStartedAt,
      previousAt: previous?.verifiedAt?.document_earning,
      maxAge: DOCUMENT_EARNINGS_FRESHNESS_MS,
      forced: params.forceDocumentEarnings,
      cache: lastDocumentEarningsScan,
    })) {
      try {
        inputs.push(...await collectDocumentEarnings(params.vaultOwnerToken));
        successful.push("document_earning");
        earningsScanned = true;
        earningsVerifiedAt = new Date().toISOString();
      } catch {
        unavailable.push("document_earning");
      }
    }
    // Tombstones are retained for owner provenance. Refuse a source update
    // before its encrypted retained history grows beyond its declared bound.
    for (const [kind, limit] of [
      ["connection", MAX_RETAINED_CONNECTION_RECORDS],
      ["document_earning", MAX_RETAINED_DOCUMENT_EARNINGS],
      ["curated_oauth_connector", MAX_RETAINED_CURATED_OAUTH_CONNECTORS],
      ["consent", MAX_RETAINED_CONSENT_RECORDS],
    ] as const) {
      const retained = new Set(
        (previous?.records ?? []).filter((record) => record.kind === kind)
          .map((record) => record.id),
      );
      for (const input of inputs) if (input.kind === kind) retained.add(input.id);
      if (retained.size <= limit) continue;
      for (let index = inputs.length - 1; index >= 0; index--) {
        if (inputs[index]?.kind === kind) inputs.splice(index, 1);
      }
      const successfulIndex = successful.indexOf(kind);
      if (successfulIndex >= 0) successful.splice(successfulIndex, 1);
      if (!unavailable.includes(kind)) unavailable.push(kind);
      if (kind === "connection") connectionsScanned = false;
      if (kind === "document_earning") earningsScanned = false;
      if (kind === "consent") {
        consentScanned = false;
        consentOverflowed = true;
      }
      if (kind === "curated_oauth_connector") curatedConnectorsScanned = false;
    }
    return { inputs, successful, unavailable };
  };
  if (!isVaultSessionEpochCurrent(epoch)) return;
  const result = await PkmWriteCoordinator.saveMergedDomain({
    ...params,
    domain: LIVING_SOURCE_DOMAIN,
    confirmation: {
      authorizationMode: "owner_source_projection",
      surface: "web",
      source: "one_living_memory_source_projection",
    },
    beforeEffect: async () => {
      if (!isVaultSessionEpochCurrent(epoch))
        throw new Error("Vault session changed");
    },
    build: async (context) => {
      const current = context.currentDomainData ?? {};
      const privateData = (current._private ?? {}) as Record<string, unknown>;
      const previous = privateData.inventory as
        LivingSourceInventory | undefined;
      const { inputs, successful, unavailable } = await fetchSources(previous);
      incomplete = unavailable.length > 0;
      if (!isVaultSessionEpochCurrent(epoch))
        throw new Error("Vault session changed");
      // A long keyset read is fresh when it finishes. Timestamping the start
      // would immediately trigger another full scan if it exceeded five minutes.
      storedSnapshotAt = new Date().toISOString();
      const inventory = reconcileLivingSources(
        previous ?? null,
        inputs,
        successful,
        unavailable,
        storedSnapshotAt,
        {
          connection: connectionVerifiedAt,
          document_earning: earningsVerifiedAt,
          consent: consentVerifiedAt,
          curated_oauth_connector: curatedConnectorsVerifiedAt,
        },
      );
      incomplete = !inventory.complete;
      const unchanged = Boolean(previous) && JSON.stringify({
        records: previous?.records,
        complete: previous?.complete,
        unavailable: previous?.unavailable,
        verifiedAt: previous?.verifiedAt,
      }) === JSON.stringify({
        records: inventory.records,
        complete: inventory.complete,
        unavailable: inventory.unavailable,
        verifiedAt: inventory.verifiedAt,
      });
      return {
        unchanged,
        domainData: { ...current, _private: { ...privateData, inventory } },
        summary: {
          item_count: inventory.records.length,
          source_projection_complete: inventory.complete,
        },
      };
    },
  });
  if (!result.success)
    throw new Error("Encrypted source projection not stored");
  if (earningsScanned)
    lastDocumentEarningsScan.set(params.userId, {
      epoch, verifiedAt: earningsVerifiedAt!, completedAt: storedSnapshotAt,
    });
  if (connectionsScanned)
    lastConnectionScan.set(params.userId, {
      epoch, verifiedAt: connectionVerifiedAt!, completedAt: storedSnapshotAt,
    });
  if (consentScanned)
    lastConsentScan.set(params.userId, {
      epoch, verifiedAt: consentVerifiedAt!, completedAt: storedSnapshotAt,
    });
  if (consentScanned) lastConsentOverflow.delete(params.userId);
  if (consentOverflowed) lastConsentOverflow.set(params.userId, {
    epoch, at: storedSnapshotAt,
  });
  if (curatedConnectorsScanned)
    lastCuratedConnectorScan.set(params.userId, {
      epoch, verifiedAt: curatedConnectorsVerifiedAt!, completedAt: storedSnapshotAt,
    });
  if (incomplete)
    throw new Error("Source inventory incomplete; retry required");
}
