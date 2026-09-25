import { beforeEach, expect, it, vi } from "vitest";
import { rememberRefreshedMcpCatalog, takeRefreshedMcpCatalog } from "@/lib/connections/custom-mcp-catalog-handoff";
import type { CustomConnectorConfiguration } from "@/lib/connections/custom-connector-configuration";

const connector: CustomConnectorConfiguration = {
  version: 1, connectorId: `custom_${"a".repeat(32)}`,
  revision: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", displayName: "Synthetic",
  endpoint: "https://example.com/mcp", enabled: true, authentication: { kind: "none" },
};
const tools = [{ id: `mcp_${"b".repeat(40)}`, name: "search_files", revision: "rev1" }];
const input = { ownerUserId: "owner-a", vaultEpoch: 4, connectorId: connector.connectorId,
  configurationRevision: connector.revision, tools };

beforeEach(() => {
  vi.restoreAllMocks();
  rememberRefreshedMcpCatalog(input);
});

it("shows a freshly authenticated catalog once for the same owner, vault and revision", () => {
  expect(takeRefreshedMcpCatalog({ ownerUserId: "owner-a", vaultEpoch: 4, configurations: [connector] }))
    .toEqual({ connectorId: connector.connectorId, tools });
  expect(takeRefreshedMcpCatalog({ ownerUserId: "owner-a", vaultEpoch: 4, configurations: [connector] })).toBeNull();
});

it("discards a catalog after owner, vault, connection or revision changes", () => {
  for (const changed of [
    { ownerUserId: "owner-b", vaultEpoch: 4, configurations: [connector] },
    { ownerUserId: "owner-a", vaultEpoch: 5, configurations: [connector] },
    { ownerUserId: "owner-a", vaultEpoch: 4, configurations: [{ ...connector, revision: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" }] },
    { ownerUserId: "owner-a", vaultEpoch: 4, configurations: [{ ...connector, enabled: false }] },
  ]) {
    rememberRefreshedMcpCatalog(input);
    expect(takeRefreshedMcpCatalog(changed)).toBeNull();
  }
});

it("expires instead of showing a stale tool list", () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000 + 1);
  expect(takeRefreshedMcpCatalog({ ownerUserId: "owner-a", vaultEpoch: 4, configurations: [connector] })).toBeNull();
});
