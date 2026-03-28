import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { CacheService } from "@/lib/services/cache-service";

function Harness({
  refreshKey,
  load,
}: {
  refreshKey: string;
  load: () => Promise<string | null>;
}) {
  const resource = useStaleResource<string | null>({
    cacheKey: "test-resource",
    enabled: true,
    refreshKey,
    load,
  });

  return <div data-testid="value">{resource.data ?? "empty"}</div>;
}

describe("useStaleResource", () => {
  beforeEach(() => {
    CacheService.getInstance().clear();
    vi.clearAllMocks();
  });

  it("re-runs the loader when refreshKey changes for the same cache key", async () => {
    const lockedLoad = vi.fn(async () => null);
    const unlockedLoad = vi.fn(async () => "hydrated-from-secure-cache");

    const view = render(<Harness refreshKey="locked" load={lockedLoad} />);

    await waitFor(() => {
      expect(lockedLoad).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId("value").textContent).toBe("empty");

    view.rerender(<Harness refreshKey="unlocked" load={unlockedLoad} />);

    await waitFor(() => {
      expect(unlockedLoad).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("value").textContent).toBe("hydrated-from-secure-cache");
    });
  });
});
