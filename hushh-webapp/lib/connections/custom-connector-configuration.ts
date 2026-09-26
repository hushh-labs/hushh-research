import { z } from "zod";
import type { PkmUserConfirmation } from "@/lib/personal-knowledge-model/mutation-plan";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

// Configuration, not tool authority. Every invocation still needs server-side
// endpoint validation, current owner admission and the existing call review.
const identifier = z.string().regex(/^custom_[a-f0-9]{32}$/);
const revision = z.string().uuid();
const boundedSecret = z.string().min(1).max(8192)
  .refine(value => Boolean(value.trim()) && !/[\x00-\x1f\x7f]/.test(value));
const endpoint = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.search && !url.hash && Boolean(url.hostname);
  } catch { return false; }
});

const oauthClientInfo = z.object({
  client_id: boundedSecret,
  client_secret: boundedSecret.optional(),
  token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic"]).optional(),
  redirect_uris: z.array(z.string().url().max(2048)).min(1).max(8),
}).strip();
const oauthRegistration = z.object({
  issuer: endpoint,
  clientId: boundedSecret,
  clientSecret: boundedSecret.optional(),
  tokenEndpointAuthMethod: z.enum(["none", "client_secret_post", "client_secret_basic"]),
}).strict().refine(value => value.tokenEndpointAuthMethod === "none"
  ? value.clientSecret === undefined : value.clientSecret !== undefined);

const configurationSchema = z.object({
  version: z.literal(1),
  connectorId: identifier,
  revision,
  displayName: z.string().trim().min(1).max(100)
    .refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  endpoint,
  enabled: z.boolean(),
  blockedTools: z.array(z.object({
    id: z.string().regex(/^mcp_[a-f0-9]{40}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(200).refine(items => new Set(items.map(item => item.id)).size === items.length).optional(),
  oauthRegistration: oauthRegistration.optional(),
  authentication: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).strict(),
    z.object({
      kind: z.literal("api_key"),
      header: z.enum(["Authorization", "X-API-Key", "Api-Key"]),
      value: boundedSecret,
    }).strict(),
    z.object({
      kind: z.literal("oauth"),
      accessToken: boundedSecret,
      expiresAt: z.number().int().positive(),
      refreshToken: boundedSecret.optional(),
      clientInfo: oauthClientInfo.optional(),
    }).strict(),
  ]),
}).strict();

export type CustomConnectorConfiguration = z.infer<typeof configurationSchema>;
type Authentication = CustomConnectorConfiguration["authentication"];
export type CustomConnectorTurnConfiguration = Omit<CustomConnectorConfiguration, "authentication" | "oauthRegistration"> & {
  authentication: Exclude<Authentication, { kind: "oauth" }> | Omit<Extract<Authentication, { kind: "oauth" }>, "refreshToken" | "clientInfo">;
};
type VaultAccess = { userId: string; vaultKey: string; vaultOwnerToken: string };
export type InvalidCustomConnector = { connectorId: string; removable: boolean };
export type CustomConnectorSnapshot = {
  configurations: CustomConnectorConfiguration[];
  invalid: InvalidCustomConnector[];
};

/** A vault-owner token never leaves for another server, under any scheme. */
export function isVaultOwnerCredential(value: string): boolean {
  return /^(?:\S+\s+)?HCT:/i.test(value.trim());
}

/** A pasted token is sent as `Authorization: Bearer <token>`, matching Claude
 * Code's bearer header. A value that already names a scheme ("Bearer x",
 * "Token x", "Basic x") is kept exactly, so the person stays in control.
 */
export function bearerAuthorizationValue(credential: string): string {
  const value = credential.trim();
  return /^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*\s+\S/.test(value) ? value : `Bearer ${value}`;
}

function containsVaultOwnerCredential(record: CustomConnectorConfiguration): boolean {
  const auth = record.authentication;
  return (auth.kind === "api_key" && isVaultOwnerCredential(auth.value)) ||
    (auth.kind === "oauth" && isVaultOwnerCredential(auth.accessToken));
}

/** Memory-only request projection. Never serialize vault keys or refresh tokens
 * into ADK state/history. The caller must fence the request to its vault session.
 * OAuth expiresAt is Unix time in seconds, checked again by the hosted resolver.
 */
export function projectCustomConnectorTurnConfigurations(
  configurations: CustomConnectorConfiguration[],
): CustomConnectorTurnConfiguration[] {
  if (configurations.length > 32) throw invalidConfiguration();
  const seen = new Set<string>();
  return configurations.flatMap(configuration => {
    const record = parseCustomConnectorConfiguration(configuration);
    if (containsVaultOwnerCredential(record)) throw invalidConfiguration();
    if (seen.has(record.connectorId)) throw invalidConfiguration();
    seen.add(record.connectorId);
    // An explicit empty catalog already blocks legacy registry fallback.
    // Disabled connections therefore need not disclose credentials at all.
    if (!record.enabled) return [];
    const auth = record.authentication;
    const { oauthRegistration: _oauthRegistration, ...turnRecord } = record;
    return [{ ...turnRecord, authentication: auth.kind === "oauth"
      ? { kind: auth.kind, accessToken: auth.accessToken, expiresAt: auth.expiresAt }
      : auth }];
  });
}

function invalidConfiguration(): Error {
  // Never forward Zod/JSON errors that can include private configuration.
  return new Error("Connector settings could not be read. Review the saved configuration.");
}

export function parseCustomConnectorConfiguration(value: unknown): CustomConnectorConfiguration {
  const parsed = configurationSchema.safeParse(value);
  if (!parsed.success) throw invalidConfiguration();
  return parsed.data;
}

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
