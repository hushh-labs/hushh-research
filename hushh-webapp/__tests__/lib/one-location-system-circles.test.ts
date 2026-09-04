import { describe, expect, it } from "vitest";

import { resolveOwnSmsSystemCircleId } from "@/lib/one-location/system-circles";
import type { OneLocationCircleSummary } from "@/lib/one-location/types";

function circle(
  overrides: Partial<OneLocationCircleSummary>,
): OneLocationCircleSummary {
  return {
    id: "circle_default",
    name: "Circle",
    kind: "other",
    role: "member",
    memberCount: 1,
    memberLimit: null,
    isSystem: false,
    systemKind: null,
    ...overrides,
  };
}

describe("resolveOwnSmsSystemCircleId", () => {
  it("returns the viewer's own SMS system Circle", () => {
    const circles = [
      circle({ id: "own_sms", isSystem: true, role: "owner" }),
    ];
    expect(resolveOwnSmsSystemCircleId(circles)).toBe("own_sms");
  });

  // The regression: joining someone else's SMS Circle after your own was
  // provisioned put theirs first (backend orders by recency), and an
  // unfiltered `find` picked it -- redirecting "Edit contacts" and "add a
  // contact" into a Circle the viewer cannot manage.
  it("skips a foreign SMS Circle even when it sorts first", () => {
    const circles = [
      circle({ id: "someone_elses_sms", isSystem: true, role: "member" }),
      circle({ id: "own_sms", isSystem: true, role: "owner" }),
    ];
    expect(resolveOwnSmsSystemCircleId(circles)).toBe("own_sms");
  });

  it("returns null when the viewer has no own system Circle yet", () => {
    const circles = [
      circle({ id: "someone_elses_sms", isSystem: true, role: "member" }),
      circle({ id: "an_ordinary_circle", role: "owner" }),
    ];
    expect(resolveOwnSmsSystemCircleId(circles)).toBeNull();
  });

  it("returns null for an empty Circle list", () => {
    expect(resolveOwnSmsSystemCircleId([])).toBeNull();
  });
});
