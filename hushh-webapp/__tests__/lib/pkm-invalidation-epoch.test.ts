import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bumpPkmInvalidationEpoch,
  currentPkmInvalidationEpoch,
} from "@/lib/cache/pkm-invalidation-epoch";
import { usePkmDomainChangeRevision } from "@/lib/pkm/use-pkm-domain-change-revision";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";

describe("pkm invalidation epoch", () => {
  afterEach(() => vi.restoreAllMocks());
  it("counts per user and ignores blank ids", () => {
    expect(currentPkmInvalidationEpoch("epoch_user_a")).toBe(0);
    bumpPkmInvalidationEpoch("epoch_user_a");
    bumpPkmInvalidationEpoch("epoch_user_a");
    bumpPkmInvalidationEpoch("   ");
    expect(currentPkmInvalidationEpoch("epoch_user_a")).toBe(2);
    expect(currentPkmInvalidationEpoch("epoch_user_b")).toBe(0);
    expect(currentPkmInvalidationEpoch(null)).toBe(0);
  });

  it("seeds the change revision above zero when a write happened before mount", () => {
    bumpPkmInvalidationEpoch("epoch_user_c");
    const { result } = renderHook(() => usePkmDomainChangeRevision("epoch_user_c"));
    expect(result.current).toBeGreaterThan(0);
  });

  it("advances only for the matching user and encrypted domain", () => {
    const invalidate = vi
      .spyOn(PkmDomainResourceService, "invalidateDomain")
      .mockImplementation(() => undefined);
    const { result } = renderHook(() =>
      usePkmDomainChangeRevision("epoch_user_d", "location"),
    );
    const before = result.current;
    act(() => {
      window.dispatchEvent(
        new CustomEvent("pkm-domain-changed", {
          detail: {
            userId: "someone_else",
            domain: "location",
            dataVersion: 1,
            updatedAt: null,
            operation: "stored",
          },
        }),
      );
    });
    expect(result.current).toBe(before);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("pkm-domain-changed", {
          detail: {
            userId: "epoch_user_d",
            domain: "financial",
            dataVersion: 2,
            updatedAt: null,
            operation: "stored",
          },
        }),
      );
    });
    expect(result.current).toBe(before);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("pkm-domain-changed", {
          detail: {
            userId: "epoch_user_d",
            domain: "location",
            dataVersion: 3,
            updatedAt: "2026-09-20T00:00:00.000Z",
            operation: "stored",
          },
        }),
      );
    });
    expect(result.current).toBe(before + 1);
    expect(invalidate).toHaveBeenCalledWith("epoch_user_d", "location", {
      includeDevice: false,
      includeBackingCaches: true,
    });
  });
});
