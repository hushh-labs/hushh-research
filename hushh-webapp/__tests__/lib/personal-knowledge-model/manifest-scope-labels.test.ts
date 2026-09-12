import { describe, expect, it } from "vitest";

import { buildPersonalKnowledgeModelStructureArtifacts } from "@/lib/personal-knowledge-model/manifest";

/**
 * The manifest walk is the only place a stored key and its normalized form
 * exist at the same time, so it is the only place the owner-facing label can be
 * authored correctly.
 *
 * The shape below is the real one that produced the bug: the live saved-places
 * writer emits `addressDetails`, the walk lowercased it to `addressdetails`
 * before building the label, and a chat row ended up titled
 * "Saved Places Locations Items Addressdetails Buildingcolor".
 */
const SAVED_PLACES = {
  savedPlaces: {
    locations: [
      {
        addressDetails: { buildingColor: "red" },
        ssnLast4: "1234",
      },
    ],
  },
};

function manifestOf(domainData: Record<string, unknown>) {
  return buildPersonalKnowledgeModelStructureArtifacts({
    domain: "location",
    domainData,
  }).manifest;
}

describe("manifest scope labels", () => {
  it("authors the label from the key as written, not the normalized path", () => {
    const manifest = manifestOf(SAVED_PLACES);
    const byPath = new Map(manifest.paths.map((path) => [path.json_path, path]));

    const buildingColor = byPath.get(
      "savedplaces.locations._items.addressdetails.buildingcolor",
    );
    expect(buildingColor, "the walk must still emit the canonical path").toBeDefined();
    expect(buildingColor?.consent_label).toBe(
      "Saved Places Locations Items Address Details Building Color",
    );
  });

  it("leaves the canonical path lowercased, because it is an authorization string", () => {
    // The whole point of the fix is that the label changed and the path did
    // not. A scope path that started carrying capitals would silently fail to
    // match existing grants.
    const manifest = manifestOf(SAVED_PLACES);
    for (const path of manifest.paths) {
      expect(path.json_path).toBe(path.json_path.toLowerCase());
    }
  });

  it("keeps each path's own segment as the owner spelled it", () => {
    const manifest = manifestOf(SAVED_PLACES);
    const byPath = new Map(manifest.paths.map((path) => [path.json_path, path]));

    expect(byPath.get("savedplaces")?.display_segment).toBe("savedPlaces");
    expect(
      byPath.get("savedplaces.locations._items.addressdetails")?.display_segment,
    ).toBe("addressDetails");
    expect(
      byPath.get("savedplaces.locations._items.ssnlast4")?.display_segment,
    ).toBe("ssnLast4");
  });

  it("marks synthetic collection segments as having no owner spelling", () => {
    // `_items` was invented by the walk to stand for every entry of an array.
    // Claiming the owner wrote it would be a small lie that a renderer would
    // faithfully display.
    const manifest = manifestOf(SAVED_PLACES);
    const items = manifest.paths.find(
      (path) => path.json_path === "savedplaces.locations._items",
    );
    expect(items).toBeDefined();
    expect(items?.display_segment).toBeNull();
  });

  it("splits a letter-to-digit run inside an authored label", () => {
    const manifest = manifestOf(SAVED_PLACES);
    const ssn = manifest.paths.find(
      (path) => path.json_path === "savedplaces.locations._items.ssnlast4",
    );
    expect(ssn?.consent_label).toBe("Saved Places Locations Items Ssn Last 4");
  });

  it("never shortens a label to its last word", () => {
    // Encodes the rationale of the reverted splitScopeLabel heuristic: dropping
    // leading words changes which field is being named.
    const manifest = manifestOf({ employment: { employmentStatus: "full time" } });
    const status = manifest.paths.find(
      (path) => path.json_path === "employment.employmentstatus",
    );
    expect(status?.consent_label).toBe("Employment Employment Status");
  });
});
