import { describe, expect, it } from "vitest";
import { shouldStreamSelfPreview } from "@/lib/one-location/self-preview";

describe("shouldStreamSelfPreview", () => {
  it("streams when opted in, permission ok, and no active grants", () => {
    expect(
      shouldStreamSelfPreview({
        streaming: true,
        activeGrantCount: 0,
        permissionState: "granted",
      }),
    ).toBe(true);
  });

  it("does not stream before the user opts in", () => {
    expect(
      shouldStreamSelfPreview({
        streaming: false,
        activeGrantCount: 0,
        permissionState: "granted",
      }),
    ).toBe(false);
  });

  it("defers to the publish watch when a share is active", () => {
    expect(
      shouldStreamSelfPreview({
        streaming: true,
        activeGrantCount: 1,
        permissionState: "granted",
      }),
    ).toBe(false);
  });

  it("does not stream when permission is blocked", () => {
    for (const permissionState of ["denied", "restricted", "unavailable"]) {
      expect(
        shouldStreamSelfPreview({
          streaming: true,
          activeGrantCount: 0,
          permissionState,
        }),
      ).toBe(false);
    }
  });

  it("streams when permission state is prompt/unknown (let the watch surface errors)", () => {
    expect(
      shouldStreamSelfPreview({
        streaming: true,
        activeGrantCount: 0,
        permissionState: "prompt",
      }),
    ).toBe(true);
  });
});
