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
type VaultAccess = { userId: string; vaultKey: string; vaultOwnerToken: string };

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

/** Caller owns unlocked-session validity; no decrypted configuration is cached here. */
export async function loadCustomConnectorConfigurations(access: VaultAccess): Promise<CustomConnectorConfiguration[]> {
  const domain = await PersonalKnowledgeModelService.loadDomainData({
    ...access, domain: "runtime_secrets",
  });
  if (domain?.connectors === undefined) return [];
  const branch = domain.connectors;
  if (!branch || typeof branch !== "object" || Array.isArray(branch)) throw invalidConfiguration();
  const entries = Object.entries(branch);
  if (entries.length > 32) throw invalidConfiguration();
  return entries.map(([key, serialized]) => {
    if (typeof serialized !== "string" || serialized.length > 32000) throw invalidConfiguration();
    let value: unknown;
    try { value = JSON.parse(serialized); } catch { throw invalidConfiguration(); }
    const record = parseCustomConnectorConfiguration(value);
    if (record.connectorId !== key) throw invalidConfiguration();
    return record;
  });
}

/** One encrypted record per edit; conflict recovery preserves sibling records. */
export async function saveCustomConnectorConfiguration(
  access: VaultAccess,
  configuration: CustomConnectorConfiguration,
  confirmation: PkmUserConfirmation,
) {
  const record = parseCustomConnectorConfiguration(configuration);
  // Every save invalidates prior call-review bindings, even if the caller
  // mistakenly reuses a draft revision. The generated revision is encrypted.
  record.revision = crypto.randomUUID();
  await PersonalKnowledgeModelService.storeRuntimeSecret({
    ...access, confirmation, credentialRef: reference(record.connectorId),
    secret: JSON.stringify(record),
  });
  return record;
}

export async function removeCustomConnectorConfiguration(
  access: VaultAccess, connectorId: string, confirmation: PkmUserConfirmation,
) {
  return PersonalKnowledgeModelService.removeRuntimeSecret({
    ...access, confirmation, credentialRef: reference(connectorId),
  });
}
