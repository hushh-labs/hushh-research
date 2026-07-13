import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useHostname } from "@/lib/hooks/use-hostname";

describe("useHostname", () => {
  it("reuses the resolved hostname on later route-local mounts", async () => {
    const first = renderHook(() => useHostname());

    await waitFor(() => {
      expect(first.result.current).toBe(window.location.hostname);
    });
    first.unmount();

    const next = renderHook(() => useHostname());
    expect(next.result.current).toBe(window.location.hostname);
  });
});
