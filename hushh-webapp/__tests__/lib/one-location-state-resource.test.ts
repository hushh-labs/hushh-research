import { afterEach, describe, expect, it } from "vitest";

import type { OneLocationState } from "@/lib/one-location/types";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { CacheService } from "@/lib/services/cache-service";

describe("OneLocationStateResource", () => {
  afterEach(() => {
    CacheService.getInstance().clear();
  });

  it("keeps a user-scoped memory snapshot available for same-session route re-entry", () => {
    const userId = "location-resource-owner";
    const snapshot = { recipients: [] } as OneLocationState;

    OneLocationStateResource.write(userId, snapshot);

    expect(OneLocationStateResource.peek(userId)?.data).toBe(snapshot);
    expect(OneLocationStateResource.peek("another-owner")).toBeNull();
  });
});
