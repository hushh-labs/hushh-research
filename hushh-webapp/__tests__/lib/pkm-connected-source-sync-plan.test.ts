import { describe, expect, it } from "vitest";

import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import { buildConfirmedPkmMutationPlanV2 } from "@/lib/personal-knowledge-model/mutation-plan";

function manifest(domain: string, scope: string): DomainManifest {
  return {
    domain,
    manifest_version: 1,
    summary_projection: {},
    top_level_scope_paths: [scope],
    externalizable_paths: [scope],
    paths: [],
    scope_registry: [
      {
        scope_handle: "s_abcdefabcdef",
        scope_label: "Sources",
        segment_ids: [scope],
        summary_projection: { top_level_scope_path: scope },
      },
    ],
  };
}

const sync = {
  authorizationMode: "owner_connected_source_sync" as const,
  surface: "web" as const,
  source: "kai_financial_resource_connected_source_sync",
  connectedSourceProvider: "plaid" as const,
};

describe("connected-source sync receipts", () => {
  it("records a background refresh as a source sync, never as the owner's review", async () => {
    const current = manifest("financial", "sources");
    const plan = await buildConfirmedPkmMutationPlanV2({
      userId: "owner",
      domain: "financial",
      currentManifest: current,
      targetManifest: current,
      scopePath: "sources",
      operation: "update",
      confirmation: sync,
    });
    expect(plan.confirmation_receipt.authorization_mode).toBe("owner_connected_source_sync");
    expect(plan.confirmation_receipt.connected_source_provider).toBe("plaid");
    expect(plan.confirmation_receipt.sharing_impact_acknowledged).toBe(false);
    expect(plan.explanation).toContain("no per-write review is claimed");
    expect(plan.explanation).not.toContain("reviewed");
  });

  it("refuses any domain other than financial, and any delete", async () => {
    const location = manifest("location", "saved_places");
    await expect(
      buildConfirmedPkmMutationPlanV2({
        userId: "owner",
        domain: "location",
        currentManifest: location,
        targetManifest: location,
        scopePath: "saved_places",
        operation: "update",
        confirmation: sync,
      }),
    ).rejects.toThrow("connected-source sync");
    const financial = manifest("financial", "sources");
    await expect(
      buildConfirmedPkmMutationPlanV2({
        userId: "owner",
        domain: "financial",
        currentManifest: financial,
        targetManifest: financial,
        scopePath: "sources",
        operation: "delete",
        confirmation: sync,
      }),
    ).rejects.toThrow("connected-source sync");
  });
});
