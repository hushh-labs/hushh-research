import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

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

  it("reports error when Google reports an auth failure after load", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "browser-key");
    const { result } = renderHook(() => useGoogleMaps());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    // Google invokes this global on key rejection (e.g. RefererNotAllowedMapError).
    act(() => {
      expect(window.gm_authFailure).toBeDefined();
      window.gm_authFailure!();
    });
    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("starts in error when a prior auth failure already occurred", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "browser-key");
    // First mount loads the API and installs window.gm_authFailure.
    const first = renderHook(() => useGoogleMaps());
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    act(() => {
      expect(window.gm_authFailure).toBeDefined();
      window.gm_authFailure!();
    });
    await waitFor(() => expect(first.result.current.status).toBe("error"));
    // A hook mounting afterwards must immediately reflect the failed state.
    const second = renderHook(() => useGoogleMaps());
    await waitFor(() => expect(second.result.current.status).toBe("error"));
  });
});
