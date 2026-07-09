import { beforeEach, describe, expect, it, vi } from "vitest";

import { runLocationDirective } from "@/lib/agent/specialist-directive-runtime";
import { OneLocationService } from "@/lib/one-location/service";

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    requestLocationPermission: vi.fn(),
    captureCurrentPosition: vi.fn(),
    getState: vi.fn(),
    storeEnvelope: vi.fn(),
    viewEnvelope: vi.fn(),
    createPublicInvite: vi.fn(),
  },
}));

const mockRequestPermission = vi.mocked(OneLocationService.requestLocationPermission);

describe("runLocationDirective - request_device_location_permission", () => {
  beforeEach(() => mockRequestPermission.mockReset());

  it("triggers the real permission prompt and reports completed on grant", async () => {
    mockRequestPermission.mockResolvedValue({
      state: "granted",
      precise: true,
      background: "foreground-only",
      locationServicesEnabled: true,
    });

    const result = await runLocationDirective(
      {
        kind: "action",
        payload: { id: "act-1", type: "request_device_location_permission" },
      },
      "vault-token",
      "user-1",
    );

    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      delegate_agent_id: "agent_location",
      kind: "action",
      type: "request_device_location_permission",
      status: "completed",
    });
  });

  it("reports cancelled when permission is denied", async () => {
    mockRequestPermission.mockResolvedValue({
      state: "denied",
      precise: false,
      background: "unavailable",
      locationServicesEnabled: false,
    });

    const result = await runLocationDirective(
      {
        kind: "action",
        payload: { id: "act-2", type: "request_device_location_permission" },
      },
      "vault-token",
      "user-1",
    );

    expect(result.status).toBe("cancelled");
  });
});
