import type { CustomConnectorConfiguration } from "@/lib/connections/custom-connector-configuration";

type CatalogTool = { id: string; name: string; revision: string; fingerprint: string; permission: "ask_first" | "blocked" };
type CatalogHandoff = {
  ownerUserId: string;
  vaultEpoch: number;
  connectorId: string;
  configurationRevision: string;
  tools: CatalogTool[];
  expiresAt: number;
};

// A one-navigation display handoff, not tool authority or persistent cache.
// The authenticated catalog service must still rediscover current tools for calls.
let pending: CatalogHandoff | null = null;

export function rememberRefreshedMcpCatalog(input: Omit<CatalogHandoff, "expiresAt">): void {
  if (!input.ownerUserId || !Number.isSafeInteger(input.vaultEpoch) || input.tools.length > 500) return;
  pending = { ...input, tools: input.tools.map(tool => ({ ...tool })), expiresAt: Date.now() + 5 * 60_000 };
}

export function takeRefreshedMcpCatalog(input: {
  ownerUserId: string;
  vaultEpoch: number;
  configurations: CustomConnectorConfiguration[];
}): { connectorId: string; tools: CatalogTool[] } | null {
  const value = pending;
  pending = null;
  if (!value || value.expiresAt <= Date.now() || value.ownerUserId !== input.ownerUserId ||
      value.vaultEpoch !== input.vaultEpoch || !input.configurations.some(record =>
        record.enabled && record.connectorId === value.connectorId &&
        record.revision === value.configurationRevision)) return null;
  return { connectorId: value.connectorId, tools: value.tools };
}
