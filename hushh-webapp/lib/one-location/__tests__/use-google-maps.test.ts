import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const importLibrary = vi.fn().mockResolvedValue({});
vi.mock("@googlemaps/js-api-loader", () => ({
  Loader: class {
    importLibrary = importLibrary;
  },
}));

import {
  __resetGoogleMapsLoaderForTests,
  useGoogleMaps,
} from "@/lib/one-location/use-google-maps";

afterEach(() => {
  vi.unstubAllEnvs();
  __resetGoogleMapsLoaderForTests();
  importLibrary.mockClear();
});

describe("useGoogleMaps", () => {
  it("reports error when no browser key is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "");
    const { result } = renderHook(() => useGoogleMaps());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(importLibrary).not.toHaveBeenCalled();
  });

  it("reports ready when the loader resolves", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "browser-key");
    const { result } = renderHook(() => useGoogleMaps());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(importLibrary).toHaveBeenCalledWith("maps");
    expect(importLibrary).toHaveBeenCalledWith("marker");
  });
});
