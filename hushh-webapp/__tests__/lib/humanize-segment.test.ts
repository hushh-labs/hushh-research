import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  humanizeMemoryPath,
  humanizeMemorySegment,
  looksLikeOpaqueId,
} from "@/lib/pkm/humanize-segment";

/**
 * The fixtures live outside this file, in a contract both languages read.
 *
 * The Python resolver in consent-protocol must produce the same words for the
 * same key, because a label written by the server and a label written by the
 * browser end up side by side on the same screen. Two implementations that must
 * agree need one list of truths; twelve independent humanizers is what happens
 * when they each carry their own.
 */
const FIXTURES = JSON.parse(
  readFileSync(
    path.resolve(__dirname, "../../../contracts/pkm/segment-humanization.v1.json"),
    "utf8",
  ),
) as {
  segments: Array<{ input: string; expected: string; why: string }>;
  opaque_ids: Array<{ input: string; why: string }>;
  not_opaque_ids: Array<{ input: string; why: string }>;
};

describe("humanizeMemorySegment", () => {
  it("has fixtures to check", () => {
    // A contract file that silently became empty would make every case below
    // vacuously pass.
    expect(FIXTURES.segments.length).toBeGreaterThan(5);
  });

  for (const { input, expected, why } of FIXTURES.segments) {
    it(`${input} -> ${expected}`, () => {
      expect(humanizeMemorySegment(input), why).toBe(expected);
    });
  }

  it("never shortens a multi-word key to its last word", () => {
    // The rationale behind merge d3336b95e, encoded so it cannot be re-proposed:
    // a last-word heuristic turns "Employment status" into "status", which is a
    // different field.
    expect(humanizeMemorySegment("employment_status")).toContain("Employment");
    expect(humanizeMemorySegment("addressDetails")).toContain("Address");
  });

  it("survives empty and junk input without throwing", () => {
    expect(humanizeMemorySegment("")).toBe("");
    expect(humanizeMemorySegment("   ")).toBe("");
    expect(humanizeMemorySegment(undefined as unknown as string)).toBe("");
  });
});

describe("humanizeMemoryPath", () => {
  it("humanizes every segment of a dotted path", () => {
    expect(humanizeMemoryPath("savedPlaces.locations.addressDetails")).toBe(
      "Saved Places Locations Address Details",
    );
  });

  it("cannot recover boundaries that were already lowercased", () => {
    // Not a defect in this function, and the reason the caller must humanize at
    // capture: once the path has been normalized for authorization, the words
    // are gone and no resolver can put them back.
    expect(humanizeMemoryPath("savedplaces.addressdetails")).toBe(
      "Savedplaces Addressdetails",
    );
  });
});

describe("looksLikeOpaqueId", () => {
  for (const { input, why } of FIXTURES.opaque_ids) {
    it(`suppresses ${input}`, () => {
      expect(looksLikeOpaqueId(input), why).toBe(true);
    });
  }

  for (const { input, why } of FIXTURES.not_opaque_ids) {
    it(`keeps ${input}`, () => {
      expect(looksLikeOpaqueId(input), why).toBe(false);
    });
  }
});
