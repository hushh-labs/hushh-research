import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  bumpPkmInvalidationEpoch,
  currentPkmInvalidationEpoch,
} from "@/lib/cache/pkm-invalidation-epoch";
import { usePkmDomainChangeRevision } from "@/lib/pkm/use-pkm-domain-change-revision";

describe("pkm invalidation epoch", () => {
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

  it("advances the mounted revision on the pkm-domain-changed event for that user only", () => {
    const { result } = renderHook(() => usePkmDomainChangeRevision("epoch_user_d"));
    const before = result.current;
    act(() => {
      window.dispatchEvent(
        new CustomEvent("pkm-domain-changed", { detail: { userId: "someone_else" } }),
      );
    });
    expect(result.current).toBe(before);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("pkm-domain-changed", { detail: { userId: "epoch_user_d" } }),
      );
    });
    expect(result.current).toBe(before + 1);
  });
});
