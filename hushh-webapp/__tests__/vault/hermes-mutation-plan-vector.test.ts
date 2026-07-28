import { describe, expect, it } from "vitest";

import vector from "@/__tests__/fixtures/hermes-mutation-plan-v2.json";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import { buildConfirmedPkmMutationPlanV2 } from "@/lib/personal-knowledge-model/mutation-plan";

function manifest(): DomainManifest {
  return {
    domain: vector.domain,
    manifest_version: 1,
    summary_projection: {},
    top_level_scope_paths: [vector.scope_path],
    externalizable_paths: [vector.scope_path],
    paths: [],
    scope_registry: [
      {
        scope_handle: vector.scope_handle,
        scope_label: "Profile",
        segment_ids: ["profile"],
        summary_projection: {
          top_level_scope_path: vector.scope_path,
        },
      },
    ],
  };
}

describe("Hermes mutation plan v2 golden vector", () => {
  it("matches the current TypeScript mutation-plan contract", async () => {
    const currentManifest = manifest();
    const plan = await buildConfirmedPkmMutationPlanV2({
      userId: vector.user_id,
      domain: vector.domain,
      currentManifest,
      targetManifest: currentManifest,
      scopePath: vector.scope_path,
      operation: "update",
      confidence: 1,
      explanation: vector.summary,
      sourceRevision: vector.source_revision,
      confirmation: {
        confirmedByUser: true,
        surface: "chat",
        source: "hussh_one_hermes",
        sharingImpactAcknowledged: true,
        sharingImpact: {
          activeRecipientCount: vector.sharing_impact.active_recipient_count,
          recipientLabels: vector.sharing_impact.recipient_labels,
          entersNextExportRevision:
            vector.sharing_impact.enters_next_export_revision,
          summary: vector.sharing_impact.summary,
          affectedGrantIds: vector.sharing_impact.affected_grant_ids,
          affectedExportIds: vector.sharing_impact.affected_export_ids,
        },
      },
    });

    expect(plan).toMatchObject(vector.expected);
    expect(plan.confirmation_receipt).toMatchObject({
      version: 2,
      plan_id: plan.plan_id,
      confirmed_by_user_id: vector.user_id,
      surface: "chat",
      displayed_domain: vector.domain,
      displayed_scope: vector.scope_path,
      sharing_impact_acknowledged: true,
    });
  });
});
