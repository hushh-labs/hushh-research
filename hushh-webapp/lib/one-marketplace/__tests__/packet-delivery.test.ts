import { describe, expect, it, vi } from "vitest";

import {
  buildPacketDeliveryPayload,
  isPacketDeliveryPayload,
  PacketPartNoDataError,
  packetIdFromRequest,
  type PacketDeliveryDeps,
} from "@/lib/one-marketplace/packet-delivery";

// A paid packet is the buyer's money: delivery must seal exactly the details the
// packet lists (no more), say which were missing, and refuse to send nothing.

function deps(overrides: Partial<PacketDeliveryDeps> = {}): PacketDeliveryDeps {
  return {
    getPacket: async () => ({
      title: "Bank statements",
      contents: [
        { domain: "financial", scopeHandle: "financial.accounts", label: "Accounts" },
        { domain: "financial", scopeHandle: "financial.cards", label: "Cards" },
      ],
    }),
    resolveScope: async (domain, handle) => `attr.${domain}.${handle.split(".")[1]}.*`,
    buildExport: async (scope) => ({ scope, value: "sealed-later" }),
    now: () => new Date("2026-10-02T00:00:00Z"),
    ...overrides,
  };
}

describe("packet delivery", () => {
  it("only treats packet requests as packets", () => {
    expect(packetIdFromRequest("pkm_packet", "packet:abc")).toBe("abc");
    expect(packetIdFromRequest("financial", "packet:abc")).toBeNull();
    expect(packetIdFromRequest("pkm_packet", "financial.accounts")).toBeNull();
  });

  it("exports exactly the listed details, one part each", async () => {
    const buildExport = vi.fn(async (scope: string) => ({ scope }));
    const payload = await buildPacketDeliveryPayload("p1", deps({ buildExport }));
    expect(buildExport.mock.calls.map((c) => c[0])).toEqual([
      "attr.financial.accounts.*",
      "attr.financial.cards.*",
    ]);
    expect(payload.parts.map((p) => p.label)).toEqual(["Accounts", "Cards"]);
    expect(payload.missing).toEqual([]);
    expect(isPacketDeliveryPayload(payload)).toBe(true);
  });

  it("lists details with no saved data as missing", async () => {
    const payload = await buildPacketDeliveryPayload(
      "p1",
      deps({
        buildExport: async (scope) => {
          if (scope.includes("cards")) throw new PacketPartNoDataError();
          return { scope };
        },
      }),
    );
    expect(payload.parts.map((p) => p.label)).toEqual(["Accounts"]);
    expect(payload.missing).toEqual([{ domain: "financial", label: "Cards" }]);
  });

  it("refuses to deliver an empty or deleted packet, and stops on real errors", async () => {
    await expect(buildPacketDeliveryPayload("gone", deps({ getPacket: async () => null }))).rejects.toThrow(
      /no longer exists/,
    );
    await expect(
      buildPacketDeliveryPayload("p1", deps({ buildExport: async () => { throw new PacketPartNoDataError(); } })),
    ).rejects.toThrow(/no saved data/);
    await expect(
      buildPacketDeliveryPayload("p1", deps({ buildExport: async () => { throw new Error("vault locked"); } })),
    ).rejects.toThrow("vault locked");
  });
});
