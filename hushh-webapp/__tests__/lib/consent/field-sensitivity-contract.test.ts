import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import contract from "@/contracts/consent/field-sensitivity.v1.json";
import { fieldSensitivity, sensitiveTopicLabel } from "@/lib/consent/field-sensitivity";
import { knownFieldLabel } from "@/lib/consent/field-labels";

/**
 * Client and server read one truth table for field-level sensitivity
 * (`contracts/consent/field-sensitivity.v1.json`). The Python rule runs the
 * same cases in consent-protocol; a case that passes there and fails here is
 * an EIN the device would send while the server believes it never left.
 */
describe("field-level sensitivity contract (C7)", () => {
  it("labels a stated topic the way the shared topic table says", () => {
    expect(contract.topic_cases.length).toBeGreaterThan(4);
    for (const testCase of contract.topic_cases) {
      expect(sensitiveTopicLabel(testCase.text), testCase.why).toBe(testCase.label);
    }
  });

  it("has cases to check", () => {
    // An emptied contract would make every case below pass vacuously.
    expect(contract.cases.length).toBeGreaterThan(10);
    expect(contract.cases.some((entry) => !entry.sensitive)).toBe(true);
  });

  it.each(contract.cases)("$key ($value) is sensitive: $sensitive", (testCase) => {
    const domain = "domain" in testCase ? testCase.domain : null;
    expect(fieldSensitivity(testCase.key, testCase.value, domain)).toBe(testCase.sensitive ? "sensitive" : "standard");
  });

  it("names a withheld field the way the server does", () => {
    expect(knownFieldLabel("fein")).toBe("Federal EIN");
    expect(knownFieldLabel("entity fein")).toBe("Federal EIN");
    expect(knownFieldLabel("favorite_restaurant")).toBeNull();
  });

  it.each(["field-sensitivity.v1.json", "field-labels.v1.json"])(
    "keeps the webapp mirror of %s byte-for-byte identical to the canonical contract",
    (file) => {
      const canonical = path.resolve(process.cwd(), "../contracts/consent", file);
      const packaged = path.resolve(process.cwd(), "contracts/consent", file);
      expect(fs.readFileSync(packaged, "utf8")).toBe(fs.readFileSync(canonical, "utf8"));
    },
  );
});
