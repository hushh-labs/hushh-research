import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function sourceOf(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function rootTags(source: string, component: "Dialog" | "Sheet" | "Drawer") {
  const tags: string[] = [];
  const matcher = new RegExp(`<${component}(?=[\\s>])`, "g");
  let match = matcher.exec(source);

  while (match) {
    let depth = 0;
    let cursor = match.index;
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      else if (character === ">" && depth === 0) break;
      cursor += 1;
    }
    tags.push(source.slice(match.index, cursor + 1));
    matcher.lastIndex = cursor + 1;
    match = matcher.exec(source);
  }

  return tags;
}

const BLOCKING_SURFACES = [
  [
    "components/one-location/redesign/location-redesign-hub.tsx",
    "Dialog",
  ],
  [
    "components/one-location/redesign/circles/named-circle-flows.tsx",
    "Sheet",
  ],
  [
    "components/one-location/redesign/circles/circle-grow-actions.tsx",
    "Sheet",
  ],
  [
    "components/one-location/redesign/circles/circle-member-actions-menu.tsx",
    "Drawer",
  ],
  [
    "components/one-location/redesign/contact-picker/selected-review-sheet.tsx",
    "Drawer",
  ],
  ["components/one-location/contact-sync-results-sheet.tsx", "Sheet"],
  ["components/connections/contact-invitation-sheet.tsx", "Sheet"],
  ["components/connections/person-profile-page.tsx", "Dialog"],
  ["app/connect/page-client.tsx", "Dialog"],
] as const;

describe("Location and Connect blocking surfaces", () => {
  it.each(BLOCKING_SURFACES)(
    "keeps every %s %s modal so the blurred background is inert",
    (file, component) => {
      const tags = rootTags(sourceOf(file), component);
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag, `${file}: ${tag}`).toMatch(/\bmodal(?:\s|=|>)/);
        expect(tag, `${file}: ${tag}`).not.toContain("modal={false}");
      }
    },
  );

  it("keeps the live-map nearby drawer as the deliberate non-modal exception", () => {
    const source = sourceOf(
      "components/one-location/nearby-check-in/nearby-check-in-sheet.tsx",
    );
    const [sheet] = rootTags(source, "Sheet");

    expect(sheet).toContain("modal={false}");
    expect(source).toContain("showOverlay={false}");
  });

  it("uses the shared blurred scrim for every blocking primitive", () => {
    for (const primitive of [
      "components/ui/dialog.tsx",
      "components/ui/sheet.tsx",
      "components/ui/drawer.tsx",
      "components/ui/alert-dialog.tsx",
    ]) {
      expect(sourceOf(primitive)).toContain("backdrop-blur-[12px]");
    }
  });
});
