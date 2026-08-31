import { describe, expect, it } from "vitest";

import { shareCircleSections } from "@/components/one-location/redesign/location-redesign-hub";
import type { OneLocationCircleSummary } from "@/lib/one-location/types";

function circle(
  overrides: Partial<OneLocationCircleSummary>,
): OneLocationCircleSummary {
  return {
    id: overrides.id ?? "circle",
    name: overrides.name ?? "Circle",
    kind: "general",
    role: overrides.role ?? "owner",
    memberCount: overrides.memberCount ?? 2,
    memberLimit: overrides.memberLimit ?? 12,
    canModerateInvites: true,
    ...overrides,
  } as OneLocationCircleSummary;
}

describe("shareCircleSections", () => {
  it("separates created and joined Circles for ordinary Share", () => {
    const sections = shareCircleSections(
      [
        circle({ id: "mine", name: "Family", role: "owner" }),
        circle({ id: "joined", name: "Office", role: "member" }),
      ],
      "",
    );

    expect(sections).toEqual([
      {
        id: "created",
        title: "Created by you",
        circles: [expect.objectContaining({ id: "mine" })],
      },
      {
        id: "joined",
        title: "Joined Circles",
        circles: [expect.objectContaining({ id: "joined" })],
      },
    ]);
  });

  it("excludes system Circles from ordinary Share", () => {
    const sections = shareCircleSections(
      [
        circle({ id: "trusted", name: "Trusted", systemKind: "trusted" }),
        circle({
          id: "sms",
          name: "SMS Circle",
          isSystem: true,
          systemKind: "sms",
        }),
        circle({ id: "manual", name: "Team", role: "owner" }),
      ],
      "",
    );

    expect(
      sections.flatMap((section) => section.circles.map((row) => row.id)),
    ).toEqual(["manual"]);
  });

  it("filters Circle sections with the same Share search query", () => {
    const sections = shareCircleSections(
      [
        circle({ id: "family", name: "Family", role: "owner" }),
        circle({ id: "office", name: "Office", role: "member" }),
      ],
      "off",
    );

    expect(sections).toEqual([
      {
        id: "joined",
        title: "Joined Circles",
        circles: [expect.objectContaining({ id: "office" })],
      },
    ]);
  });
});
