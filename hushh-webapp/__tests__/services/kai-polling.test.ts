import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch,
  },
}));

import { analyzeWithPolling, pollKaiAnalysisStatus, startKaiAnalysis } from "@/lib/services/kai-polling";

describe("kai-polling", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("starts analysis runs via the current analyze/run/start endpoint when a debate session is provided", async () => {
    apiFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run: {
            run_id: "run_123",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    await expect(
      startKaiAnalysis({
        userId: "user_1",
        ticker: "nvda",
        riskProfile: "balanced",
        vaultOwnerToken: "vault_token",
        debateSessionId: "session_1",
      })
    ).resolves.toEqual({ analysisId: "run_123" });

    expect(apiFetch).toHaveBeenCalledWith(
      "/api/kai/analyze/run/start",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("guards legacy polling helpers when no supported debate session context is available", async () => {
    await expect(
      startKaiAnalysis({
        userId: "user_1",
        ticker: "NVDA",
        vaultOwnerToken: "vault_token",
      })
    ).rejects.toThrow("Kai polling requires a debateSessionId");

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("blocks deprecated status polling endpoints and points callers to current run APIs", async () => {
    await expect(
      pollKaiAnalysisStatus("run_123", "vault_token")
    ).rejects.toThrow("Kai polling status endpoint is no longer supported");

    await expect(
      analyzeWithPolling({
        userId: "user_1",
        ticker: "NVDA",
        vaultOwnerToken: "vault_token",
      })
    ).rejects.toThrow("Kai polling status endpoint is no longer supported");

    expect(apiFetch).not.toHaveBeenCalled();
  });
});
