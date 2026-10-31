import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { prepareProfilePortrait } from "@/lib/services/profile-portrait-service";

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

describe("private portrait media budget", () => {
  afterEach(() => { Reflect.deleteProperty(window, "CapacitorWebFetch"); vi.unstubAllGlobals(); });
  it("refuses oversized bytes and compressed oversized dimensions before browser image decoding", async () => {
    vi.stubGlobal("Blob", NodeBlob);
    const decode = vi.fn();
    vi.stubGlobal("Image", decode);
    const header = new Uint8Array(24);
    header.set([137, 80, 78, 71]);
    const view = new DataView(header.buffer);
    view.setUint32(16, 6000); view.setUint32(20, 6000);
    const fetchMedia = vi.fn();
    const patchedFetch = vi.fn();
    vi.stubGlobal("fetch", patchedFetch);
    Object.defineProperty(window, "CapacitorWebFetch", { configurable: true, value: fetchMedia });
    for (const bytes of [new Uint8Array(512 * 1024 + 1), header]) {
      fetchMedia.mockResolvedValueOnce(new Response(bytes, { headers: { "content-type": "image/png" } }));
      await expect(prepareProfilePortrait("https://lh3.googleusercontent.com/a/public-fixture=s768", new AbortController().signal)).rejects.toThrow();
    }
    expect(decode).not.toHaveBeenCalled();
    expect(patchedFetch).not.toHaveBeenCalled();
    expect(fetchMedia).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ credentials: "omit", cache: "no-store", redirect: "error" }));
    Reflect.deleteProperty(window, "CapacitorWebFetch");
    await expect(prepareProfilePortrait("https://lh3.googleusercontent.com/a/public-fixture=s768", new AbortController().signal)).rejects.toThrow();
    expect(patchedFetch).not.toHaveBeenCalled();
  });
});
