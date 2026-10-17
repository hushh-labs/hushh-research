import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// A plain stub, not a spy: the hook's own catch is what is under test.
let readStatus: () => Promise<unknown> = async () => null;
vi.mock("@/lib/services/api-service", () => ({ ApiService: { getPodMemoryStatus: () => readStatus() } }));

import { podMemoryConsentPhrase, usePodMemoryConsentWord } from "@/lib/agent/use-pod-memory-consent-word";

describe("provider memory word on the Puppy header", () => {
  it("says the pod's own grant", async () => {
    readStatus = async () => ({ provider: { consent: "granted" } });
    const { result } = renderHook(() => usePodMemoryConsentWord("h1", 0));
    await waitFor(() => expect(result.current).toBe("granted"));
    expect(podMemoryConsentPhrase(result.current)).toBe("Provider memory: on");
  });

  it("never stays on checking after a failed read", async () => {
    readStatus = () => Promise.reject(new Error("POD_DIRECT_UNAVAILABLE:x"));
    const { result } = renderHook(() => usePodMemoryConsentWord("h1", 0));
    await waitFor(() => expect(result.current).toBe("unknown"));
    expect(podMemoryConsentPhrase(result.current)).toBe("Provider memory: unknown");
  });

  it("treats an answer without a grant as unknown, not as off", async () => {
    readStatus = async () => null;
    const { result } = renderHook(() => usePodMemoryConsentWord("h1", 0));
    await waitFor(() => expect(result.current).toBe("unknown"));
    expect(podMemoryConsentPhrase(null)).toBe("Provider memory: checking");
  });
});
