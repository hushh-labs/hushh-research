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

const configurationSchema = z.object({
  version: z.literal(1),
  connectorId: identifier,
  revision,
  displayName: z.string().trim().min(1).max(100)
    .refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  endpoint,
  enabled: z.boolean(),
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
    }).strict(),
  ]),
}).strict();

export type CustomConnectorConfiguration = z.infer<typeof configurationSchema>;
type Authentication = CustomConnectorConfiguration["authentication"];
export type CustomConnectorTurnConfiguration = Omit<CustomConnectorConfiguration, "authentication"> & {
  authentication: Exclude<Authentication, { kind: "oauth" }> | Omit<Extract<Authentication, { kind: "oauth" }>, "refreshToken">;
};
type VaultAccess = { userId: string; vaultKey: string; vaultOwnerToken: string };

/** Memory-only request projection. Never serialize vault keys or refresh tokens
 * into ADK state/history. The caller must fence the request to its vault session.
 * OAuth expiresAt is Unix time in seconds, checked again by the hosted resolver.
 */
export function projectCustomConnectorTurnConfigurations(
  configurations: CustomConnectorConfiguration[],
): CustomConnectorTurnConfiguration[] {
  if (configurations.length > 32) throw invalidConfiguration();
  const seen = new Set<string>();
  return configurations.map(configuration => {
    const record = parseCustomConnectorConfiguration(configuration);
    if (seen.has(record.connectorId)) throw invalidConfiguration();
    seen.add(record.connectorId);
    const auth = record.authentication;
    return { ...record, authentication: auth.kind === "oauth"
      ? { kind: auth.kind, accessToken: auth.accessToken, expiresAt: auth.expiresAt }
      : auth };
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

async function storedRecords(access: VaultAccess): Promise<Record<string, unknown>> {
  const domain = await PersonalKnowledgeModelService.loadDomainData({ ...access, domain: "runtime_secrets" });
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
export async function loadCustomConnectorConfigurations(access: VaultAccess): Promise<CustomConnectorConfiguration[]> {
  return Object.entries(await storedRecords(access)).map(([key, value]) => parseStoredRecord(key, value));
}

/** One encrypted record per edit; conflict recovery preserves sibling records. */
export async function saveCustomConnectorConfiguration(
  access: VaultAccess,
  configuration: CustomConnectorConfiguration,
  confirmation: PkmUserConfirmation,
  expectedRevision: string | null,
) {
  const record = parseCustomConnectorConfiguration(configuration);
  const expectedValue = await expectedRecord(access, record.connectorId, expectedRevision);
  // Every save invalidates prior call-review bindings, even if the caller
  // mistakenly reuses a draft revision. The generated revision is encrypted.
  record.revision = crypto.randomUUID();
  await PersonalKnowledgeModelService.storeRuntimeSecret({
    ...access, confirmation, credentialRef: reference(record.connectorId),
    secret: JSON.stringify(record), expectedValue,
  });
  return record;
}

export async function removeCustomConnectorConfiguration(
  access: VaultAccess, connectorId: string, confirmation: PkmUserConfirmation,
  expectedRevision: string,
) {
  const credentialRef = reference(connectorId);
  const expectedValue = await expectedRecord(access, connectorId, expectedRevision);
  return PersonalKnowledgeModelService.removeRuntimeSecret({
    ...access, confirmation, credentialRef, expectedValue,
  });
}
