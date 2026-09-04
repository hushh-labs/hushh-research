import { afterEach, describe, expect, it } from "vitest";

import {
  clearLocationWorkspaceMemory,
  readLocationWorkspaceMemory,
  writeLocationWorkspaceMemory,
} from "@/lib/one-location/location-workspace-memory";

const userA = "location-memory-a";
const userB = "location-memory-b";

afterEach(() => {
  clearLocationWorkspaceMemory(userA);
  clearLocationWorkspaceMemory(userB);
});

describe("Location workspace memory", () => {
  it("keeps decrypted coordinates scoped to one account and defensively cloned", () => {
    const workspace = {
      myLocationPoint: {
        latitude: 37.77,
        longitude: -122.41,
        capturedAt: "2026-07-21T00:00:00.000Z",
        sourcePlatform: "ios" as const,
      },
      decryptedPoints: {
        grant_a: {
          latitude: 37.78,
          longitude: -122.42,
          capturedAt: "2026-07-21T00:00:00.000Z",
          sourcePlatform: "ios" as const,
        },
      },
    };
    writeLocationWorkspaceMemory(userA, workspace);

    workspace.decryptedPoints.grant_a.latitude = 0;
    const read = readLocationWorkspaceMemory(userA);
    expect(read.decryptedPoints.grant_a?.latitude).toBe(37.78);
    expect(readLocationWorkspaceMemory(userB).decryptedPoints).toEqual({});

    read.decryptedPoints.grant_a!.latitude = 0;
    expect(readLocationWorkspaceMemory(userA).decryptedPoints.grant_a?.latitude).toBe(37.78);
  });

  it("clears volatile coordinates when the owning vault session ends", () => {
    writeLocationWorkspaceMemory(userA, {
      myLocationPoint: null,
      decryptedPoints: {
        grant_a: {
          latitude: 1,
          longitude: 2,
          capturedAt: "2026-07-21T00:00:00.000Z",
          sourcePlatform: "web",
        },
      },
    });
    clearLocationWorkspaceMemory(userA);
    expect(readLocationWorkspaceMemory(userA)).toEqual({
      myLocationPoint: null,
      decryptedPoints: {},
    });
  });
});
