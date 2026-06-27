import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

/**
 * Characterization tests for the section-label and field-label fallback
 * titleization in lib/utils/json-to-human.ts.
 *
 * When a section key is absent from SECTION_LABELS, formatCompleteJson
 * falls back to getFieldLabel(sectionKey), which itself falls back to:
 *
 *   key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
 *
 * The same fallback applies to field keys absent from FIELD_LABELS.
 * Both lookups use || (not ??), so undefined (absent key) is falsy and
 * triggers the fallback. All replacements are standard String methods —
 * the output is fully deterministic for any ASCII key.
 *
 * No existing test uses a section key or field key absent from the lookup
 * tables. Every existing test uses known keys (account_metadata,
 * portfolio_summary, ytd_metrics, etc.).
 */

describe("formatCompleteJson — section-label fallback titleization", () => {
  it("auto-titleizes an unknown multi-word section key via underscore splitting", () => {
    // "custom_section" is absent from SECTION_LABELS.
    // getFieldLabel("custom_section"):
    //   FIELD_LABELS["custom_section"] → undefined (falsy)
    //   → "custom_section".replace(/_/g, " ") → "custom section"
    //   → .replace(/\b\w/g, ...) → "Custom Section"
    const output = formatCompleteJson({
      custom_section: { label: "ok" },
    });

    expect(output).toContain("--- Custom Section ---");
  });

  it("auto-titleizes an unknown single-word section key by capitalizing the first letter", () => {
    // "diagnostics" has no underscores; replace(/_/g, " ") is a no-op.
    // .replace(/\b\w/g, ...) capitalizes the first character → "Diagnostics".
    const output = formatCompleteJson({
      diagnostics: { status: "ok" },
    });

    expect(output).toContain("--- Diagnostics ---");
  });

  it("auto-titleizes a three-word section key correctly", () => {
    // "my_custom_section" → "my custom section" → "My Custom Section"
    const output = formatCompleteJson({
      my_custom_section: { status: "ok" },
    });

    expect(output).toContain("--- My Custom Section ---");
  });

  it("SECTION_LABELS entry takes priority over auto-titleization via ||", () => {
    // "account_metadata" is in SECTION_LABELS as "Account Information".
    // Auto-titleization would produce "Account Metadata" — this must NOT appear.
    const output = formatCompleteJson({
      account_metadata: { institution_name: "Bank" },
    });

    expect(output).toContain("--- Account Information ---");
    expect(output).not.toContain("Account Metadata");
  });
});

describe("formatCompleteJson — field-label fallback titleization", () => {
  it("auto-titleizes an unknown multi-word field key", () => {
    // "custom_field" is absent from FIELD_LABELS.
    // getFieldLabel("custom_field") → "Custom Field" (via replace chain).
    // formatValue("custom_field", "value") → cleanMarkdown("value") → "value".
    const output = formatCompleteJson({
      custom_section: { custom_field: "value" },
    });

    expect(output).toContain("Custom Field: value");
  });

  it("auto-titleizes an unknown single-word field key", () => {
    // "status" is absent from FIELD_LABELS → "Status".
    const output = formatCompleteJson({
      diagnostics: { status: "active" },
    });

    expect(output).toContain("Status: active");
  });

  it("auto-titleizes a three-word field key correctly", () => {
    // "my_custom_label" → "My Custom Label"
    const output = formatCompleteJson({
      diagnostics: { my_custom_label: "x" },
    });

    expect(output).toContain("My Custom Label: x");
  });

  it("FIELD_LABELS entry takes priority over auto-titleization via ||", () => {
    // "institution_name" is in FIELD_LABELS as "Institution".
    // Auto-titleization would produce "Institution Name" — this must NOT appear.
    const output = formatCompleteJson({
      account_metadata: { institution_name: "Bank" },
    });

    expect(output).toContain("Institution: Bank");
    expect(output).not.toContain("Institution Name");
  });
});