import { Capacitor } from "@capacitor/core";
import { HushhOAuthReturn, isNativeCustomConnectorReturnUri } from "@/lib/capacitor/oauth-return";
import { ExternalConnectorService, McpCatalogAuthenticationError } from "@/lib/services/external-connector-service";
import {
  bearerAuthorizationValue,
  isVaultOwnerCredential,
  saveCustomConnectorConfiguration,
  type CustomConnectorConfiguration,
} from "@/lib/connections/custom-connector-configuration";
import type { PkmUserConfirmation } from "@/lib/personal-knowledge-model/mutation-plan";
import type { CustomConnectorRecoveryReference, DriveChatRecoveryReason } from "@/lib/agent/drive-oauth-chat-recovery";

// The one add, verify and sign-in path for custom MCP connectors. Settings and
// the chat card both call it, so "connect from chat" and "connect from
// Connectors" behave identically. A saved definition is never a connection:
// servers without sign-in are verified with the real governed discovery before
// anything is written to the vault.

export type CustomConnectorAccess = { userId: string; vaultKey: string; vaultOwnerToken: string };
export type CatalogTool = Awaited<ReturnType<typeof ExternalConnectorService.refreshMcpCatalog>>[number];
export type ConnectorCredential = { header: "Authorization" | "X-API-Key" | "Api-Key"; value: string };
export type OAuthRegistration = NonNullable<CustomConnectorConfiguration["oauthRegistration"]>;
export type PrepareRecovery = (input: {
  attemptId: string; reason: DriveChatRecoveryReason; customConnector?: CustomConnectorRecoveryReference;
}) => Promise<"ready" | "busy" | "unavailable">;
export type AddedConnector = {
  configuration: CustomConnectorConfiguration;
  /** Verified tools; null while sign-in is still needed. */
  tools: CatalogTool[] | null;
  signInNeeded: boolean;
};

/** A message written for the person; safe to show as is. */
export class ConnectorSetupError extends Error {}

export function connectorSurface(): "ios" | "android" | "web" {
  const platform = Capacitor.getPlatform();
  return platform === "ios" ? "ios" : platform === "android" ? "android" : "web";
}

export function newCustomConnectorConfiguration(input: {
  displayName: string; endpoint: string; credential?: ConnectorCredential | null; oauthRegistration?: OAuthRegistration;
}): CustomConnectorConfiguration {
  const value = input.credential?.value.trim() ?? "";
  if (value && isVaultOwnerCredential(value))
    throw new ConnectorSetupError("Vault tokens cannot connect other servers. Use this connector’s sign-in.");
  return {
    version: 1, connectorId: `custom_${crypto.randomUUID().replaceAll("-", "")}`,
    revision: crypto.randomUUID(), displayName: input.displayName.trim(), endpoint: input.endpoint.trim(), enabled: true,
    ...(input.oauthRegistration ? { oauthRegistration: input.oauthRegistration } : {}),
    authentication: value && input.credential
      ? { kind: "api_key", header: input.credential.header,
        value: input.credential.header === "Authorization" ? bearerAuthorizationValue(value) : value }
      : { kind: "none" },
  };
}

/**
 * Verify, then save. A verified 401 without a supplied credential is a pending
 * sign-in, never a connected state; a rejected credential or any other failure
 * saves nothing. `blockWrites` blocks every verified tool that is not
 * explicitly read-only, using the owner's existing per-tool block rule.
 */
export async function verifyAndSaveCustomConnector(input: {
  access: CustomConnectorAccess;
  configuration: CustomConnectorConfiguration;
  confirmation: PkmUserConfirmation;
  signal: AbortSignal;
  isCurrent: () => boolean;
  blockWrites?: boolean;
}): Promise<AddedConnector> {
  let configuration = input.configuration;
  let tools: CatalogTool[] | null = null;
  let signInNeeded = Boolean(configuration.oauthRegistration);
  if (!configuration.oauthRegistration) {
    try {
      tools = await ExternalConnectorService.refreshMcpCatalog({
        vaultOwnerToken: input.access.vaultOwnerToken, configuration,
        signal: input.signal, isEffectCurrent: input.isCurrent,
      });
      if (!tools.length) throw new ConnectorSetupError("This server offers no tools One can use.");
    } catch (error) {
      if (!(error instanceof McpCatalogAuthenticationError) || configuration.authentication.kind !== "none") throw error;
      signInNeeded = true;
    }
  }
  if (tools && input.blockWrites) {
    const writes = tools.filter(tool => tool.access === "write");
    if (writes.length > 200) throw new ConnectorSetupError("This server has too many tools to block. Connect it and block tools in Connectors.");
    configuration = { ...configuration, blockedTools: writes.map(tool => ({ id: tool.id, fingerprint: tool.fingerprint })) };
    tools = tools.map(tool => tool.access === "write" ? { ...tool, permission: "blocked" as const } : tool);
  }
  const saved = await saveCustomConnectorConfiguration(input.access, configuration, input.confirmation, null, input.isCurrent);
  return { configuration: saved, tools, signInNeeded };
}

/**
 * Start OAuth sign-in (MCP discovery, dynamic registration, S256 PKCE) for a
 * saved connector. Resolves after handing off to the provider; the app-owned
 * HTTPS return saves tokens into the vault and resumes the same chat.
 */
export async function beginCustomConnectorSignIn(input: {
  access: CustomConnectorAccess;
  configuration: CustomConnectorConfiguration;
  prepareRecovery: PrepareRecovery;
  signal: AbortSignal;
  isCurrent: () => boolean;
}): Promise<void> {
  const { configuration } = input;
  if (!configuration.enabled) throw new Error("Connector changed.");
  if (configuration.authentication.kind === "api_key") throw new Error("This connector uses a saved credential.");
  let attemptId: string | undefined;
  try {
    const result = await ExternalConnectorService.privateMcpOAuth({
      vaultOwnerToken: input.access.vaultOwnerToken, connectorId: configuration.connectorId, operation: "begin",
      payload: { revision: configuration.revision, endpoint: configuration.endpoint,
        ...(configuration.oauthRegistration ? { registeredClient: configuration.oauthRegistration } : {}) },
      signal: input.signal, isEffectCurrent: input.isCurrent,
    }) as { attemptId?: unknown; authorizeUrl?: unknown; redirectUri?: unknown };
    if (!result || typeof result.attemptId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.attemptId) || typeof result.authorizeUrl !== "string") throw new Error("Invalid connection response.");
    attemptId = result.attemptId;
    const url = new URL(result.authorizeUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || result.authorizeUrl.length > 16000) throw new Error("Invalid authorization address.");
    if (Capacitor.isNativePlatform() && !isNativeCustomConnectorReturnUri(result.redirectUri)) throw new Error("This connection cannot return to the app.");
    const ready = await input.prepareRecovery({ attemptId, reason: "web_full_page", customConnector: {
      connectorId: configuration.connectorId, revision: configuration.revision,
    } });
    if (!input.isCurrent() || ready !== "ready") throw new ConnectorSetupError("Finish the current chat action first.");
    // Explicit tap only. The app-owned HTTPS callback resumes the same
    // conversation; no provider credential is handed to the native plugin.
    if (Capacitor.isNativePlatform()) {
      await HushhOAuthReturn.openAuthorization({ authorizeUrl: url.href,
        redirectUri: result.redirectUri as string, attemptId, expectedUserId: input.access.userId });
    } else window.location.assign(url.href);
  } catch (error) {
    if (attemptId && input.isCurrent()) await ExternalConnectorService.privateMcpOAuth({
      vaultOwnerToken: input.access.vaultOwnerToken, connectorId: configuration.connectorId, operation: "cancel",
      payload: { revision: configuration.revision, attemptId }, signal: input.signal, isEffectCurrent: input.isCurrent,
    }).catch(() => undefined);
    throw error;
  }
}
