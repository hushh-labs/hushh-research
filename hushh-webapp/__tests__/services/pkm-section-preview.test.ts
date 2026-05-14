import { describe, expect, it } from "vitest";

import { buildPkmSectionPreviewPresentation } from "@/lib/profile/pkm-section-preview";

describe("buildPkmSectionPreviewPresentation", () => {
  it("unwraps single-key section payloads and converts entity maps into readable entries", () => {
    const presentation = buildPkmSectionPreviewPresentation({
      domain: "location",
      domainTitle: "Location",
      permissionLabel: "Changes",
      permissionDescription: "Saved changes to places and preferences.",
      topLevelScopePath: "changes",
      value: {
        changes: {
          entities: {
            sf_residence_001: {
              entity_id: "sf_residence_001",
              kind: "correction",
              summary: "I live in New York City now.",
              observations: ["home", "nyc"],
              status: "active",
              created_at: "2026-04-16T05:54:08.696Z",
              updated_at: "2026-04-16T05:54:08.696Z",
            },
          },
        },
      },
    });

    expect(presentation.title).toBe("Changes");
    expect(presentation.stats).toEqual([{ label: "Entries", value: "1" }]);
    expect(presentation.groups[0]?.kind).toBe("entities");
    if (presentation.groups[0]?.kind !== "entities") {
      throw new Error("expected entities group");
    }
    expect(presentation.groups[0].items[0]?.title).toBe("I live in New York City now.");
    expect(presentation.groups[0].items[0]?.subtitle).toBe("correction · active");
    expect(
      presentation.groups[0].items[0]?.fields.some(
        (field) => field.label === "Entity Id" && field.value === "sf_residence_001"
      )
    ).toBe(true);
    expect(presentation.groups[0].items[0]?.sections?.[0]?.label).toBe("Observations");
  });

  it("renders receipts memory as semantic groups instead of raw keys", () => {
    const presentation = buildPkmSectionPreviewPresentation({
      domain: "shopping",
      domainTitle: "Shopping",
      permissionLabel: "Receipts memory",
      permissionDescription: "Receipt-backed shopping signals and preferences.",
      topLevelScopePath: "receipts_memory",
      value: {
        receipts_memory: {
          readable_summary: "You often return to Uber and Wonder.",
          inferred_preferences: ["rideshare", "late-night food"],
          observed_facts: ["Frequent Uber rides", "Repeat Wonder orders"],
          provenance: {
            source_kind: "gmail_receipts",
            updated_at: "2026-04-16T05:54:08.696Z",
          },
          schema_version: 4,
        },
      },
    });

    expect(presentation.title).toBe("Receipts memory");
    expect(presentation.summary).toBe("You often return to Uber and Wonder.");
    expect(presentation.groups.map((group) => group.title)).toEqual([
      "Inferred preferences",
      "Observed facts",
      "Source",
    ]);
  });
});
