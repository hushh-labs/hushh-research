import { z } from "zod";

// Pure schema and request projection for custom MCP connectors. This module
// must stay free of vault, PKM, Firebase or any other side-effecting import:
// request builders such as `external-connector-service` depend on it, and
// everything they are bundled into (the Drive request surfaces, their layout
// fixtures) would otherwise initialise the auth stack at module load.
// Vault persistence lives in `custom-connector-configuration.ts`.

// Configuration, not tool authority. Every invocation still needs server-side
// endpoint validation, current owner admission and the existing call review.
export const identifier = z.string().regex(/^custom_[a-f0-9]{32}$/);
const revision = z.string().uuid();
export const boundedSecret = z.string().min(1).max(8192)
  .refine(value => Boolean(value.trim()) && !/[\x00-\x1f\x7f]/.test(value));
const endpoint = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.search && !url.hash && Boolean(url.hostname);
  } catch { return false; }
});

export const oauthClientInfo = z.object({
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

export function containsVaultOwnerCredential(record: CustomConnectorConfiguration): boolean {
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

export function invalidConfiguration(): Error {
  // Never forward Zod/JSON errors that can include private configuration.
  return new Error("Connector settings could not be read. Review the saved configuration.");
}

export function parseCustomConnectorConfiguration(value: unknown): CustomConnectorConfiguration {
  const parsed = configurationSchema.safeParse(value);
  if (!parsed.success) throw invalidConfiguration();
  return parsed.data;
}
