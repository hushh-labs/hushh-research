import { describe, expect, it } from "vitest";

import { buildPkmSectionPreviewPresentation, pkmPreviewEntityTarget } from "@/lib/profile/pkm-section-preview";

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
    expect(presentation.groups[0].items[0]?.deletable).toBe(true);
    const entity = presentation.groups[0].items[0]!;
    expect(pkmPreviewEntityTarget(entity)).toEqual({ kind: "entity", relativePath: ["entities", "sf_residence_001"], entityId: "sf_residence_001" });
    expect(pkmPreviewEntityTarget(JSON.parse(JSON.stringify(entity)))).toBeNull();
    expect(presentation.groups[0].items[0]?.fields).toEqual([]);
    expect(JSON.stringify(presentation)).not.toContain("sf_residence_001");
    expect(JSON.stringify(presentation)).not.toMatch(/created at|updated at/i);
    expect(
      presentation.groups[0].items[0]?.fields.some((field) => field.label === "Entity Id")
    ).toBe(false);
    expect(presentation.groups[0].items[0]?.sections?.[0]?.label).toBe("Observations");
  });

  it("binds context edits to the original saved ID without putting it in display/export JSON", () => {
    const params = { domain: "financial", domainTitle: "Finance", permissionLabel: "Context", topLevelScopePath: "context",
      value: { context: { entries: [{ id: "ctx_original", category: "risk", text: "Synthetic investment preference" }] } } };
    const presentation = buildPkmSectionPreviewPresentation(params);
    const group = presentation.groups[0]!;
    if (group.kind !== "entities") throw new Error("expected context entities");
    const entity = group.items[0]!;
    expect(entity.key).toBe("context-1");
    expect(pkmPreviewEntityTarget(entity)).toEqual({ kind: "financial-context", entryId: "ctx_original" });
    expect(JSON.stringify(presentation)).not.toContain("ctx_original");
    expect(pkmPreviewEntityTarget({ ...entity })).toBeNull();
    const unknown = buildPkmSectionPreviewPresentation({ ...params, domain: "professional" });
    expect(unknown.groups[0]?.kind === "entities" && unknown.groups[0].items[0]?.editable).toBe(false);
    const unsupported = buildPkmSectionPreviewPresentation({ ...params, topLevelScopePath: " context ", value: {
      entities: { private_entry: { summary: "Noncanonical section" } },
      context: { entries: [{ id: "canonical_sibling", text: "Keep this sibling" }] },
    } });
    const unsupportedEntities = unsupported.groups.flatMap(group => group.kind === "entities" ? group.items : []);
    expect(unsupportedEntities.length).toBeGreaterThan(0);
    expect(unsupportedEntities.every(entity => !entity.deletable && pkmPreviewEntityTarget(entity) === null)).toBe(true);
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
          readable_summary: {
            text: "You often return to Uber and Wonder.",
            highlights: ["97 receipts reviewed"],
          },
          inferred_preferences: {
            preference_signals: {
              items: [
                {
                  label: "rideshare",
                  confidence: 0.91,
                  basis_codes: ["merchant_affinity"],
                },
              ],
            },
          },
          observed_facts: {
            recent_highlights: {
              items: [
                {
                  merchant_label: "Uber",
                  amount: 24.51,
                  currency: "USD",
                  purchased_at: "2026-04-15T10:00:00Z",
                },
              ],
            },
            merchant_affinity: {
              items: [
                {
                  merchant_label: "Wonder",
                  receipt_count_365d: 4,
                  affinity_score: 0.82,
                },
              ],
            },
          },
          provenance: {
            source_kind: "gmail_receipts",
            receipt_count_used: 97,
            latest_receipt_updated_at: "2026-04-16T05:54:08.696Z",
          },
          schema_version: 4,
        },
      },
    });

    expect(presentation.title).toBe("Receipts memory");
    expect(presentation.summary).toBe("You often return to Uber and Wonder.");
    expect(presentation.stats).toEqual([
      { label: "Receipts", value: "97" },
      { label: "Purchases", value: "1" },
      { label: "Preferences", value: "1" },
    ]);
    expect(presentation.groups.map((group) => group.title)).toEqual([
      "Receipt highlights",
      "Recent purchases",
      "Merchant patterns",
      "Preference signals",
    ]);
  });

  it("removes secret-shaped fields and containers from consumer previews", () => {
    const presentation = buildPkmSectionPreviewPresentation({
      domain: "profile",
      domainTitle: "Profile",
      permissionLabel: "Profile",
      topLevelScopePath: "",
      value: {
        display_name: "Reviewer",
        api_key: "must-not-render",
        secretMaterial: "must-not-render",
        data_version: 6,
        provenance: { writer_id: "must-not-render" },
        payload_hash: "must-not-render",
        runtime_secrets: {
          llm: { client_secret: "must-not-render" },
        },
        preferences: {
          theme: "dark",
          vault_passphrase: "must-not-render",
        },
        connections: [
          {
            name: "Calendar",
            access_token: "must-not-render",
            status: "active",
          },
        ],
      },
    });

    const serialized = JSON.stringify(presentation);
    expect(serialized).toContain("Reviewer");
    expect(serialized).toContain("Calendar");
    expect(serialized).toContain("dark");
    expect(serialized).not.toContain("must-not-render");
    expect(serialized).not.toMatch(
      /api key|runtime secrets|access token|passphrase|data version|provenance|payload hash/i
    );
  });
});
