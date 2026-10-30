import { describe, expect, it } from "vitest";

import {
  committedDisplayName,
  isOwnIdentityChange,
} from "@/lib/one-voice/profile-voice-refresh";
import type { ToolResultPublic } from "@/lib/one-voice/protocol";

const result = (status: string, extra: Record<string, unknown> = {}): ToolResultPublic =>
  ({ status, spoken_facts: [], ...extra }) as unknown as ToolResultPublic;

describe("isOwnIdentityChange", () => {
  it("refreshes on a synced name change", () => {
    expect(isOwnIdentityChange("update_display_name", result("updated", { display_name: "A" }))).toBe(true);
  });

  it("refreshes when the provider committed but the shadow is still syncing", () => {
    // Graph observation 2: the provider holds the new name; a forced refresh
    // is how the shadow catches up. Treating this as "not changed" would leave
    // the old name on screen after a committed write.
    expect(
      isOwnIdentityChange("update_display_name", result("committed_sync_pending", { display_name: "A" })),
    ).toBe(true);
  });

  it("does not refresh on a refused, invalid or unavailable result", () => {
    for (const status of ["invalid", "unavailable", "rejected", "confirmation_required", "tap_required"]) {
      expect(isOwnIdentityChange("update_display_name", result(status))).toBe(false);
    }
  });

  it("ignores other tools even with a lookalike status", () => {
    expect(isOwnIdentityChange("rename_circle", result("updated"))).toBe(false);
  });

  it("recognises the pending_action.resolved mirror frame by its provider-held name", () => {
    expect(isOwnIdentityChange(null, result("updated", { display_name: "A" }))).toBe(true);
    expect(isOwnIdentityChange(null, result("updated"))).toBe(false);
  });

  it("is safe on malformed input", () => {
    expect(isOwnIdentityChange("update_display_name", null)).toBe(false);
    expect(isOwnIdentityChange("update_display_name", undefined)).toBe(false);
    expect(isOwnIdentityChange("update_display_name", {} as ToolResultPublic)).toBe(false);
  });
});

describe("committedDisplayName", () => {
  it("returns the trimmed provider-held name or null", () => {
    expect(committedDisplayName(result("updated", { display_name: "  Ayesha S " }))).toBe("Ayesha S");
    expect(committedDisplayName(result("updated"))).toBeNull();
    expect(committedDisplayName(null)).toBeNull();
  });
});
