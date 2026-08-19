import { describe, expect, it } from "vitest";
import {
  isReadOnlyLocationQuery,
  formatLocationQueryResponse,
  formatExpiryHint,
} from "@/lib/agent/tools/location-tools";
import { runLocationDirective } from "@/lib/agent/specialist-directive-runtime";

describe("Location Tools Intent Routing", () => {
  it("formats relative expiry hints", () => {
    expect(formatExpiryHint(null)).toBeNull();
    expect(formatExpiryHint("invalid-date")).toBeNull();
  });
  it("correctly identifies read-only query tools vs action tools", () => {
    // Read-only queries must return true
    expect(isReadOnlyLocationQuery("list_incoming_location_shares")).toBe(true);
    expect(isReadOnlyLocationQuery("list_active_location_shares")).toBe(true);
    expect(isReadOnlyLocationQuery("list_public_links")).toBe(true);
    expect(isReadOnlyLocationQuery("list_location_recipients")).toBe(true);
    expect(isReadOnlyLocationQuery("get_incoming_shares")).toBe(true);
    expect(isReadOnlyLocationQuery("get_active_shares")).toBe(true);

    // Action/write/navigation tools must return false
    expect(isReadOnlyLocationQuery("create_location_share")).toBe(false);
    expect(isReadOnlyLocationQuery("revoke_location_share")).toBe(false);
    expect(isReadOnlyLocationQuery("propose_location_view")).toBe(false);
    expect(isReadOnlyLocationQuery("propose_public_link")).toBe(false);
    expect(isReadOnlyLocationQuery("propose_sos_panic")).toBe(false);
    expect(isReadOnlyLocationQuery("propose_check_in")).toBe(false);
    expect(isReadOnlyLocationQuery("request_device_location_permission")).toBe(false);
  });

  it("formats incoming location shares query into direct natural language text and chips", () => {
    const payload = {
      incomingShares: [
        { ownerDisplayName: "Alex", expiresAt: "2026-08-17T23:30:00Z" },
        { ownerDisplayName: "Sarah" },
      ],
    };

    const formatted = formatLocationQueryResponse("list_incoming_location_shares", payload);
    expect(formatted.chatAnswer).toContain("Alex");
    expect(formatted.chatAnswer).toContain("Sarah");
    expect(formatted.chatAnswer).toContain("currently sharing live location with you");
    expect(formatted.suggestionChips).toHaveLength(2);
    expect(formatted.suggestionChips[0].label).toBe("🗺️ View on Map");
    expect(formatted.suggestionChips[0].kind).toBe("navigation");
    expect(formatted.suggestionChips[1].label).toBe("📍 Open Shared with Me");
    expect(formatted.suggestionChips[1].kind).toBe("navigation");
  });

  it("formats active location shares (who can see my location) into direct natural language text and chips", () => {
    const payload = {
      activeShares: [
        { recipientDisplayName: "John" },
      ],
    };

    const formatted = formatLocationQueryResponse("list_active_location_shares", payload);
    expect(formatted.chatAnswer).toBe("You are currently sharing your location with John.");
    expect(formatted.suggestionChips).toHaveLength(2);
    expect(formatted.suggestionChips[0].label).toBe("📍 Manage Location Shares");
    expect(formatted.suggestionChips[0].kind).toBe("navigation");
    expect(formatted.suggestionChips[1].label).toBe("🛑 Stop Sharing");
    expect(formatted.suggestionChips[1].kind).toBe("action");
  });

  it("returns natural language text when no shares are active", () => {
    const formatted = formatLocationQueryResponse("list_incoming_location_shares", { incomingShares: [] });
    expect(formatted.chatAnswer).toBe("No one is currently sharing their live location with you.");
    expect(formatted.suggestionChips[0].label).toBe("📍 Request Location");
    expect(formatted.suggestionChips[0].kind).toBe("action");
  });

  it("executes read-only query directives via runLocationDirective directly with zero confirmation modal required", async () => {
    const result = await runLocationDirective({
      kind: "action",
      payload: {
        id: "dir-123",
        type: "list_incoming_location_shares",
        incomingShares: [{ ownerDisplayName: "Alex" }],
      },
    });

    expect(result.status).toBe("completed");
    expect(result.detail).toBe("Alex is currently sharing live location with you.");
  });
});
