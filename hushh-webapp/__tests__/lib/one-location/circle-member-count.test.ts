import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  circleMemberCountLabel,
  circleOthersLabel,
  circleTotalMemberCount,
  totalCountLabel,
} from "@/lib/one-location/circle-member-count";

/**
 * A Circle's count, owner included.
 *
 * The server counts every active membership, and the owner always holds one
 * of them -- so `memberCount` already includes them. List rows used to
 * subtract the owner back out while the Circle's own detail screen kept the
 * raw count, so the same Circle said "4 members" on the share picker and
 * "5 members" one tap away in its own detail.
 */
describe("a Circle's count always includes the owner", () => {
  it("counts everyone", () => {
    expect(circleTotalMemberCount(5)).toBe(5);
    expect(circleTotalMemberCount(2)).toBe(2);
    expect(circleTotalMemberCount(1)).toBe(1);
  });

  it("never goes negative on a transient zero", () => {
    // A Circle read mid-write can report 0, and "-1 members" is worse than
    // being briefly wrong in the safe direction.
    expect(circleTotalMemberCount(0)).toBe(0);
    expect(circleTotalMemberCount(null)).toBe(0);
    expect(circleTotalMemberCount(undefined)).toBe(0);
  });

  it("says members in a list and people in a detail, for the same set", () => {
    expect(circleMemberCountLabel(5)).toBe("5 members");
    expect(circleMemberCountLabel(1)).toBe("1 member");
    expect(circleOthersLabel(5)).toBe("5 people");
    expect(circleOthersLabel(2)).toBe("2 people");
  });

  it("says a Circle holding only the owner is 'Only you', not a count of zero", () => {
    expect(circleMemberCountLabel(1)).toBe("1 member");
    expect(circleOthersLabel(1)).toBe("Only you");
    expect(totalCountLabel(1)).toBe("Only you");
  });
});

describe("every screen that shows a Circle count uses the shared rule", () => {
  const files = [
    "components/one-location/redesign/location-redesign-hub.tsx",
    "components/one-location/redesign/check-in-flow.tsx",
    "components/one-location/redesign/contact-picker/circle-member-picker.tsx",
    "app/one/location/page.tsx",
    "components/one-location/redesign/circles/named-circle-flows.tsx",
    "components/connect/circles/connect-circles-tab.tsx",
  ];

  it("renders no raw memberCount anywhere", () => {
    // The rule is only worth having if nothing routes around it. Each of these
    // interpolated the server number directly, and each disagreed with the
    // Circle's own detail screen.
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8")
        .split("\r\n")
        .join("\n");
      expect(source, file).not.toMatch(/\$\{circle\.memberCount\}/);
      expect(source, file).not.toMatch(/\{circle\.memberCount\}\s*members/);
    }
  });
});
