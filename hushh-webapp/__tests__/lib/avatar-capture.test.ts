import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: true,
  getPhoto: vi.fn(),
}));

vi.mock("@/lib/capacitor/platform", () => ({ isNative: () => mocks.native }));
vi.mock("@capacitor/camera", () => ({
  Camera: { getPhoto: mocks.getPhoto },
  CameraResultType: { DataUrl: "dataUrl" },
  CameraSource: { Prompt: "PROMPT" },
}));

import { isCameraCancellation, pickAvatar, pickAvatarDataUrl } from "@/lib/profile/avatar-capture";

describe("pickAvatar (native)", () => {
  beforeEach(() => {
    mocks.native = true;
    mocks.getPhoto.mockReset();
  });

  it("a dismissed native picker is cancelled, not a failure", async () => {
    // @capacitor/camera rejects a dismissed sheet with "User cancelled photos app".
    mocks.getPhoto.mockRejectedValue(new Error("User cancelled photos app"));
    await expect(pickAvatar()).resolves.toEqual({ kind: "cancelled" });
  });

  it("a plugin error is a failure the person can be told about", async () => {
    // Graph observation 4: this used to come back as null, identical to cancel.
    mocks.getPhoto.mockRejectedValue(new Error("Plugin not implemented on this platform"));
    await expect(pickAvatar()).resolves.toEqual({ kind: "failed", reason: "plugin" });
  });

  it("a photo with no data is a plugin failure, never a silent no-op", async () => {
    mocks.getPhoto.mockResolvedValue({ dataUrl: undefined });
    await expect(pickAvatar()).resolves.toEqual({ kind: "failed", reason: "plugin" });
  });

  it("the compat wrapper still folds both to null for callers that only branch on it", async () => {
    mocks.getPhoto.mockRejectedValue(new Error("User cancelled photos app"));
    await expect(pickAvatarDataUrl()).resolves.toBeNull();
    mocks.getPhoto.mockRejectedValue(new Error("boom"));
    await expect(pickAvatarDataUrl()).resolves.toBeNull();
  });
});

describe("isCameraCancellation", () => {
  it("recognises the platform's cancel message in any shape and nothing else", () => {
    expect(isCameraCancellation(new Error("User cancelled photos app"))).toBe(true);
    expect(isCameraCancellation("User Cancelled")).toBe(true);
    expect(isCameraCancellation({ message: "cancelled" })).toBe(true);
    expect(isCameraCancellation(new Error("permission denied"))).toBe(false);
    expect(isCameraCancellation(null)).toBe(false);
    expect(isCameraCancellation(undefined)).toBe(false);
  });
});
