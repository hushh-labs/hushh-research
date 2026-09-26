import { z } from "zod";
import type { PkmUserConfirmation } from "@/lib/personal-knowledge-model/mutation-plan";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import {
  boundedSecret,
  containsVaultOwnerCredential,
  identifier,
  invalidConfiguration,
  oauthClientInfo,
  parseCustomConnectorConfiguration,
  type CustomConnectorConfiguration,
  type CustomConnectorSnapshot,
} from "@/lib/connections/custom-connector-schema";

// Vault persistence for custom MCP connectors. The pure schema and request
// projection live in `custom-connector-schema.ts` and are re-exported here so
// existing importers keep one entry point.
export {
  bearerAuthorizationValue,
  isVaultOwnerCredential,
  parseCustomConnectorConfiguration,
  projectCustomConnectorTurnConfigurations,
  type CustomConnectorConfiguration,
  type CustomConnectorSnapshot,
  type CustomConnectorTurnConfiguration,
  type InvalidCustomConnector,
} from "@/lib/connections/custom-connector-schema";

type VaultAccess = { userId: string; vaultKey: string; vaultOwnerToken: string };

function reference(connectorId: string): string {
  if (!identifier.safeParse(connectorId).success) throw invalidConfiguration();
  return `pkm:runtime_secrets.connectors.${connectorId}`;
}

async function storedRecords(access: VaultAccess, force = false): Promise<Record<string, unknown>> {
  const domain = force
    ? (await PersonalKnowledgeModelService.loadDomainSnapshot({ ...access, domain: "runtime_secrets", force: true })).data
    : await PersonalKnowledgeModelService.loadDomainData({ ...access, domain: "runtime_secrets" });
  if (domain === null) return {};
  if (!domain || typeof domain !== "object" || Array.isArray(domain)) throw invalidConfiguration();
  if (domain.connectors === undefined) return {};
  if (!domain.connectors || typeof domain.connectors !== "object" || Array.isArray(domain.connectors)) throw invalidConfiguration();
  if (Object.keys(domain.connectors).length > 32) throw invalidConfiguration();
  return domain.connectors as Record<string, unknown>;
}

function parseStoredRecord(key: string, serialized: unknown): CustomConnectorConfiguration {
  if (typeof serialized !== "string" || serialized.length > 32000) throw invalidConfiguration();
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw invalidConfiguration(); }
  const record = parseCustomConnectorConfiguration(value);
  if (record.connectorId !== key) throw invalidConfiguration();
  return record;
}

async function expectedRecord(access: VaultAccess, connectorId: string, expectedRevision: string | null): Promise<string | null> {
  const records = await storedRecords(access);
  const stored = records[connectorId];
  const currentRevision = stored === undefined ? null : parseStoredRecord(connectorId, stored).revision;
  if (currentRevision !== expectedRevision) throw new Error("This connector changed. Reload before editing again.");
  return stored === undefined ? null : stored as string;
}

/** Caller owns unlocked-session validity; no decrypted configuration is cached here. */
export async function loadCustomConnectorConfigurations(access: VaultAccess, force = false): Promise<CustomConnectorConfiguration[]> {
  return Object.entries(await storedRecords(access, force)).map(([key, value]) => parseStoredRecord(key, value));
}

/** A bad sibling must not hide an owner's otherwise valid connectors. Invalid
 * records never enter ADK; only their opaque, validated key reaches repair UI.
 * A failed vault read or malformed root still fails closed.
 */
export async function loadCustomConnectorSnapshot(access: VaultAccess, force = false): Promise<CustomConnectorSnapshot> {
  const records = await storedRecords(access, force);
  const snapshot: CustomConnectorSnapshot = { configurations: [], invalid: [] };
  for (const [key, value] of Object.entries(records)) {
    if (!identifier.safeParse(key).success) throw invalidConfiguration();
    try {
      const record = parseStoredRecord(key, value);
      if (containsVaultOwnerCredential(record)) throw invalidConfiguration();
      snapshot.configurations.push(record);
    } catch {
      snapshot.invalid.push({ connectorId: key, removable: typeof value === "string" });
    }
  }
  return snapshot;
}

/** Remove one invalid record with an exact compare-and-delete. Never parse or
 * echo its private contents, and never rewrite healthy siblings.
 */
export async function removeInvalidCustomConnectorConfiguration(
  access: VaultAccess, connectorId: string, confirmation: PkmUserConfirmation,
  isCurrent?: () => boolean,
) {
  if (!identifier.safeParse(connectorId).success || (isCurrent && !isCurrent())) throw invalidConfiguration();
  const records = await storedRecords(access, true);
  const value = records[connectorId];
  if (typeof value !== "string") throw invalidConfiguration();
  let healthy = false;
  try {
    healthy = !containsVaultOwnerCredential(parseStoredRecord(connectorId, value));
  } catch { /* A malformed record is eligible for exact-record recovery. */ }
  if (healthy) throw invalidConfiguration();
  if (isCurrent && !isCurrent()) throw invalidConfiguration();
  return PersonalKnowledgeModelService.removeRuntimeSecret({
    ...access, confirmation, credentialRef: reference(connectorId), expectedValue: value,
    ...(isCurrent ? { mayPublish: isCurrent } : {}),
  });
}

/** Accept only a fresh owner-bound result; credentials go directly to encryption.
 * No implicit lifetime is invented for servers omitting token expiry.
 */
export async function saveCustomConnectorOAuthResult(
  access: VaultAccess, connectorId: string, expectedRevision: string,
  value: unknown, confirmation: PkmUserConfirmation, isCurrent: () => boolean,
) {
  const result = z.object({
    tokens: z.object({
      access_token: boundedSecret,
      refresh_token: boundedSecret.optional(),
      token_type: z.string().refine(type => type.toLowerCase() === "bearer"),
    }).strip(),
    clientInfo: oauthClientInfo,
    expiresAt: z.number().int().positive(),
  }).strict().safeParse(value);
  if (!result.success || !isCurrent() || result.data.expiresAt <= Date.now() / 1000) throw invalidConfiguration();
  const records = (await loadCustomConnectorSnapshot(access, true)).configurations;
  if (!isCurrent()) throw invalidConfiguration();
  const record = records.find(item => item.connectorId === connectorId);
  if (!record || !record.enabled || record.revision !== expectedRevision) throw invalidConfiguration();
  return saveCustomConnectorConfiguration(access, { ...record, authentication: {
    kind: "oauth", accessToken: result.data.tokens.access_token,
    expiresAt: result.data.expiresAt, clientInfo: result.data.clientInfo,
    ...(result.data.tokens.refresh_token ? { refreshToken: result.data.tokens.refresh_token } : {}),
  } }, confirmation, expectedRevision, isCurrent);
}

/** One encrypted record per edit; conflict recovery preserves sibling records. */
export async function saveCustomConnectorConfiguration(
  access: VaultAccess,
  configuration: CustomConnectorConfiguration,
  confirmation: PkmUserConfirmation,
  expectedRevision: string | null,
  isCurrent?: () => boolean,
) {
  if (isCurrent && !isCurrent()) throw invalidConfiguration();
  const record = parseCustomConnectorConfiguration(configuration);
  if (containsVaultOwnerCredential(record)) throw invalidConfiguration();
  const expectedValue = await expectedRecord(access, record.connectorId, expectedRevision);
  if (isCurrent && !isCurrent()) throw invalidConfiguration();
  // Every save invalidates prior call-review bindings, even if the caller
  // mistakenly reuses a draft revision. The generated revision is encrypted.
  record.revision = crypto.randomUUID();
  const serialized = JSON.stringify(record);
  if (serialized.length > 32000) throw invalidConfiguration();
  await PersonalKnowledgeModelService.storeRuntimeSecret({
    ...access, confirmation, credentialRef: reference(record.connectorId),
    secret: serialized, expectedValue,
    ...(isCurrent ? { mayPublish: isCurrent } : {}),
  });
  return record;
}

export async function removeCustomConnectorConfiguration(
  access: VaultAccess, connectorId: string, confirmation: PkmUserConfirmation,
  expectedRevision: string,
  isCurrent?: () => boolean,
) {
  if (isCurrent && !isCurrent()) throw invalidConfiguration();
  const credentialRef = reference(connectorId);
  const expectedValue = await expectedRecord(access, connectorId, expectedRevision);
  if (isCurrent && !isCurrent()) throw invalidConfiguration();
  return PersonalKnowledgeModelService.removeRuntimeSecret({
    ...access, confirmation, credentialRef, expectedValue,
    ...(isCurrent ? { mayPublish: isCurrent } : {}),
  });
}
