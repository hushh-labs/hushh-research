/**
 * Where Settings sends a private connector's tool refresh and login.
 *
 * Both carry the connector's credential (the access token in the configuration, or
 * the authorization code and the tokens the provider issues). For a Shared owner
 * the hub runs them, as before. For an owner whose agent runs privately they go
 * only to that agent (consent-protocol/api/routes/one/pod_agent_chat_connectors.py),
 * through the same exact-route allowlist as chat. A refused or unreadable placement
 * never falls back to the hub.
 */
import { ApiService } from "./api-service";
import { ownerContentIsPrivate } from "./private-agent-specialist-chat";

export type ConnectorSettingsOperation =
  | "mcp/catalog"
  | "mcp/oauth/begin"
  | "mcp/oauth/complete"
  | "mcp/oauth/cancel";

export async function connectorSettingsRequest(
  connectorId: string,
  operation: ConnectorSettingsOperation,
  init: Parameters<typeof ApiService.apiFetch>[1],
): Promise<Response> {
  const privateAgent = await ownerContentIsPrivate();
  const id = encodeURIComponent(connectorId);
  return privateAgent
    ? ApiService.ownerPodRequest(`agent-chat/connectors/${id}/${operation}`, init as RequestInit)
    : ApiService.apiFetch(`/api/connectors/${id}/${operation}`, init);
}
