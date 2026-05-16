import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: mockApiFetch,
  },
}));

import { ApiError, apiJson } from "@/lib/services/api-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("apiJson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses nested FastAPI detail messages for structured route errors", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          detail: {
            code: "ONE_EMAIL_KYC_TEMPORARILY_UNAVAILABLE",
            message: "One email KYC is temporarily unavailable. Please try again in a moment.",
          },
        },
        503
      )
    );

    await expect(apiJson("/api/one/kyc/workflows")).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      message: "One email KYC is temporarily unavailable. Please try again in a moment.",
    } satisfies Partial<ApiError>);
  });

  it("falls back to the status code when the error payload has no readable message", async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ detail: { retryable: true } }, 500));

    await expect(apiJson("/api/one/kyc/workflows")).rejects.toMatchObject({
      message: "Request failed: 500",
    });
  });
});
