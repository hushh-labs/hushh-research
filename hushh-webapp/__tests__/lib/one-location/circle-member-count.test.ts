import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  circleMemberCountLabel,
  circleOtherMemberCount,
  circleOthersLabel,
  othersCountLabel,
} from "@/lib/one-location/circle-member-count";

/**
 * A Circle's count, from the reader's point of view.
 *
 * The server counts every active membership and the reader is always one of
 * them, so the raw number reads as that many OTHER people until you work out
 * that one of them is you. Four screens rendered it raw and three subtracted
 * the reader, so the same Circle said "5 members" on the share picker and
 * "4 members" one tap away in its own detail.
 */
describe("a Circle's count never includes the reader", () => {
  it("counts others", () => {
    expect(circleOtherMemberCount(5)).toBe(4);
    expect(circleOtherMemberCount(2)).toBe(1);
    expect(circleOtherMemberCount(1)).toBe(0);
  });

  it("never goes negative on a transient zero", () => {
    // A Circle read mid-write can report 0, and "-1 members" is worse than
    // being briefly wrong in the safe direction.
    expect(circleOtherMemberCount(0)).toBe(0);
    expect(circleOtherMemberCount(null)).toBe(0);
    expect(circleOtherMemberCount(undefined)).toBe(0);
  });

  it("says members in a list and people in a detail, for the same set", () => {
    expect(circleMemberCountLabel(5)).toBe("4 members");
    expect(circleMemberCountLabel(2)).toBe("1 member");
    expect(circleOthersLabel(5)).toBe("4 people");
    expect(circleOthersLabel(2)).toBe("1 person");
  });

  it("says a Circle of one is empty rather than counting the reader", () => {
    // This is the row the reporter saw: their own SMS Circle, holding nobody,
    // announcing "1 member".
    expect(circleMemberCountLabel(1)).toBe("0 members");
    expect(circleOthersLabel(1)).toBe("No members yet");
    expect(othersCountLabel(0)).toBe("No members yet");
  });
});

describe("every screen that shows a Circle count uses the shared rule", () => {
  const files = [
    "components/one-location/redesign/location-redesign-hub.tsx",
    "components/one-location/redesign/check-in-flow.tsx",
    "components/one-location/redesign/contact-picker/circle-member-picker.tsx",
    "app/one/location/page.tsx",
    "components/one-location/redesign/circles/named-circle-flows.tsx",
  ];

  it("renders no raw memberCount anywhere", () => {
    // The rule is only worth having if nothing routes around it. Each of these
    // interpolated the server number directly, and each disagreed with the
    // Circle's own detail screen by exactly one.
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8")
        .split("\r\n")
        .join("\n");
      expect(source, file).not.toMatch(/\$\{circle\.memberCount\}/);
      expect(source, file).not.toMatch(/\{circle\.memberCount\}\s*members/);
    }
  });
});
