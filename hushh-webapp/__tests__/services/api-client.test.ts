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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function plainResponse(body: string, status = 500): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("apiJson — success path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns parsed JSON body on a 2xx response", async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ id: "user-1" }));
    const result = await apiJson<{ id: string }>("/api/users/1");
    expect(result).toEqual({ id: "user-1" });
  });
});

// ---------------------------------------------------------------------------
// extractApiErrorMessage — tested via apiJson error path
// ---------------------------------------------------------------------------

describe("apiJson — extractApiErrorMessage contract", () => {
  beforeEach(() => vi.clearAllMocks());

  // top-level fields

  it("uses top-level error field when present", async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ error: "Unauthorised" }, 401));
    await expect(apiJson("/api/protected")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      message: "Unauthorised",
    } satisfies Partial<ApiError>);
  });

  it("uses top-level message field when error is absent", async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ message: "Not found" }, 404));
    await expect(apiJson("/api/missing")).rejects.toMatchObject({
      status: 404,
      message: "Not found",
    });
  });

  it("uses top-level detail string when present", async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ detail: "Forbidden" }, 403));
    await expect(apiJson("/api/forbidden")).rejects.toMatchObject({
      status: 403,
      message: "Forbidden",
    });
  });

  // nested detail object

  it("uses nested detail.message for structured FastAPI route errors", async () => {
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

  it("uses nested detail.error when detail.message is absent", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({ detail: { error: "rate limit exceeded" } }, 429)
    );
    await expect(apiJson("/api/ratelimited")).rejects.toMatchObject({
      status: 429,
      message: "rate limit exceeded",
    });
  });

  it("uses nested detail.code as last-resort string from detail object", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({ detail: { code: "VAULT_LOCKED" } }, 423)
    );
    await expect(apiJson("/api/vault")).rejects.toMatchObject({
      status: 423,
      message: "VAULT_LOCKED",
    });
  });

  // fallback cases

  it("falls back to status code when detail object has no readable string field", async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ detail: { retryable: true } }, 500));
    await expect(apiJson("/api/broken")).rejects.toMatchObject({
      message: "Request failed: 500",
    });
  });

  it("falls back to status code when payload is null", async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse(null, 502));
    await expect(apiJson("/api/gateway")).rejects.toMatchObject({
      message: "Request failed: 502",
    });
  });

  it("falls back to status code when payload is a primitive string", async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse("Internal error", 500));
    await expect(apiJson("/api/str-error")).rejects.toMatchObject({
      message: "Request failed: 500",
    });
  });

  it("falls back to status code when payload is an array", async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse(["err1", "err2"], 400));
    await expect(apiJson("/api/arr-error")).rejects.toMatchObject({
      message: "Request failed: 400",
    });
  });

  it("falls back when error and message fields are whitespace-only strings", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({ error: "   ", message: "  " }, 400)
    );
    await expect(apiJson("/api/whitespace")).rejects.toMatchObject({
      message: "Request failed: 400",
    });
  });

  it("falls back when top-level detail string is whitespace-only", async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ detail: "   " }, 400));
    await expect(apiJson("/api/ws-detail")).rejects.toMatchObject({
      message: "Request failed: 400",
    });
  });

  it("falls back when error and message fields are non-string types", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({ error: 500, message: ["bad"] }, 500)
    );
    await expect(apiJson("/api/typed-mismatch")).rejects.toMatchObject({
      message: "Request failed: 500",
    });
  });

  it("falls back to status code when response is not JSON", async () => {
    mockApiFetch.mockResolvedValueOnce(plainResponse("Service Unavailable", 503));
    await expect(apiJson("/api/non-json")).rejects.toMatchObject({
      status: 503,
      message: "Request failed: 503",
    });
  });

  // payload attachment

  it("attaches raw payload to ApiError for caller inspection", async () => {
    const body = { detail: "conflict" };
    mockApiFetch.mockResolvedValueOnce(jsonResponse(body, 409));
    const err = (await apiJson("/api/conflict").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.payload).toEqual(body);
  });
});