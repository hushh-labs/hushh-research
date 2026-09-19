import { describe, expect, it } from "vitest";

import {
  isForeignSmsSystemCircle,
  isSmsSystemCircle,
  resolveOwnSmsSystemCircleId,
} from "@/lib/one-location/system-circles";
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

describe("isSmsSystemCircle", () => {
  it("matches systemKind sms", () => {
    expect(
      isSmsSystemCircle(circle({ systemKind: "sms", role: "owner" })),
    ).toBe(true);
    expect(
      isSmsSystemCircle(circle({ systemKind: "sms", role: "member" })),
    ).toBe(true);
  });

  it("falls back to the legacy isSystem flag", () => {
    expect(
      isSmsSystemCircle(circle({ systemKind: null, isSystem: true })),
    ).toBe(true);
    expect(
      isSmsSystemCircle(circle({ systemKind: null, isSystem: false })),
    ).toBe(false);
  });

  it("never matches Trusted or ordinary Circles", () => {
    expect(
      isSmsSystemCircle(circle({ systemKind: "trusted", role: "owner" })),
    ).toBe(false);
    expect(isSmsSystemCircle(circle({}))).toBe(false);
  });
});

describe("isForeignSmsSystemCircle", () => {
  it("matches an SMS Circle the viewer does not own", () => {
    expect(
      isForeignSmsSystemCircle(
        circle({ systemKind: "sms", isSystem: true, role: "member" }),
      ),
    ).toBe(true);
  });

  it("matches a legacy-server foreign SMS Circle via isSystem", () => {
    expect(
      isForeignSmsSystemCircle(
        circle({ systemKind: null, isSystem: true, role: "member" }),
      ),
    ).toBe(true);
  });

  it("keeps the viewer's own SMS Circle usable", () => {
    expect(
      isForeignSmsSystemCircle(
        circle({ systemKind: "sms", isSystem: true, role: "owner" }),
      ),
    ).toBe(false);
  });

  it("ignores ordinary and Trusted Circles", () => {
    expect(isForeignSmsSystemCircle(circle({ role: "member" }))).toBe(false);
    expect(
      isForeignSmsSystemCircle(
        circle({ systemKind: "trusted", role: "owner" }),
      ),
    ).toBe(false);
  });
});
