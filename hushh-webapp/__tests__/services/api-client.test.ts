import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: mockApiFetch,
  },
}));

import { ApiError, apiJson, MAX_RESPONSE_BYTES } from "@/lib/services/api-client";
import { ApiService } from "@/lib/services/api-service";

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

  it("prefers the top-level error field over the message field", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({ error: "error field wins", message: "message field loses" }, 400)
    );

    await expect(apiJson("/api/test")).rejects.toMatchObject({
      message: "error field wins",
      status: 400,
    } satisfies Partial<ApiError>);
  });

  it("uses the top-level message field when error field is absent", async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ message: "standalone message" }, 422));

    await expect(apiJson("/api/test")).rejects.toMatchObject({
      message: "standalone message",
      status: 422,
    } satisfies Partial<ApiError>);
  });

  it("skips a whitespace-only error field and falls back to the message field", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({ error: "   ", message: "real message" }, 400)
    );

    await expect(apiJson("/api/test")).rejects.toMatchObject({
      message: "real message",
    } satisfies Partial<ApiError>);
  });

  it("skips a whitespace-only detail string and falls back to the status code", async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ detail: "   " }, 400));

    await expect(apiJson("/api/test")).rejects.toMatchObject({
      message: "Request failed: 400",
    } satisfies Partial<ApiError>);
  });

  it("uses the nested detail.error field when detail.message is absent", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({ detail: { error: "nested error text" } }, 500)
    );

    await expect(apiJson("/api/test")).rejects.toMatchObject({
      message: "nested error text",
      status: 500,
    } satisfies Partial<ApiError>);
  });

  it("uses the nested detail.code when no readable detail message exists when message and error are absent", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({ detail: { code: "ERR_UNAVAILABLE" } }, 503)
    );

    await expect(apiJson("/api/test")).rejects.toMatchObject({
      message: "ERR_UNAVAILABLE",
      status: 503,
    } satisfies Partial<ApiError>);
  });

  it("preserves the raw payload on the thrown ApiError", async () => {
    const payload = { detail: { code: "ERR_PRESERVED", retryable: true } };
    mockApiFetch.mockResolvedValueOnce(jsonResponse(payload, 503));

    const error = await apiJson("/api/test").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).payload).toEqual(payload);
  });

  it("returns the parsed JSON body on a successful 200 response", async () => {
    const body = { ok: true, value: 42 };
    mockApiFetch.mockResolvedValueOnce(jsonResponse(body, 200));

    const result = await apiJson<typeof body>("/api/test");

    expect(result).toEqual(body);
  });

  it("falls back to the status code when content-type is not JSON", async () => {
    mockApiFetch.mockResolvedValueOnce(
      new Response("plain text error", {
        status: 502,
        headers: { "content-type": "text/plain" },
      })
    );

    await expect(apiJson("/api/test")).rejects.toMatchObject({
      message: "Request failed: 502",
      status: 502,
    } satisfies Partial<ApiError>);
  });
});

// ---------------------------------------------------------------------------
// apiJson — response size boundary enforcement (CWE-400)
// ---------------------------------------------------------------------------

describe("apiJson — MAX_RESPONSE_BYTES Content-Length guard", () => {
  beforeEach(() => {
    vi.clearAllMocks(); 
  });
  it("allows responses when Content-Length header is absent", async () => {
      const response = jsonResponse({ ok: true });
      vi.mocked(ApiService.apiFetch).mockResolvedValueOnce(response);
      await expect(apiJson("/api/test")).resolves.toEqual({ ok: true });
  }); 

  function responseWithContentLength(
    body: unknown,
    status: number,
    contentLength: number | null
  ): Response {
    const serialised = JSON.stringify(body);

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (contentLength !== null) {
      headers["content-length"] = String(contentLength);
    }

    return new Response(serialised, { status, headers });
  }

  it("throws ApiError when Content-Length exceeds MAX_RESPONSE_BYTES", async () => {
    const oversizeBytes = MAX_RESPONSE_BYTES + 1;

    mockApiFetch.mockResolvedValueOnce(
      responseWithContentLength({ data: "truncated" }, 200, oversizeBytes)
    );

    await expect(apiJson("/api/data")).rejects.toMatchObject({
      name: "ApiError",
      message: expect.stringContaining(String(oversizeBytes)),
    } satisfies Partial<ApiError>);
  });

  it("throws ApiError with the correct response status when size limit exceeded", async () => {
    mockApiFetch.mockResolvedValueOnce(
      responseWithContentLength({ data: "x" }, 200, MAX_RESPONSE_BYTES + 1024)
    );

    await expect(apiJson("/api/data")).rejects.toMatchObject({
      status: 200,
    } satisfies Partial<ApiError>);
  });

  it("allows response exactly at MAX_RESPONSE_BYTES boundary", async () => {
    mockApiFetch.mockResolvedValueOnce(
      responseWithContentLength({ ok: true }, 200, MAX_RESPONSE_BYTES)
    );

    await expect(apiJson("/api/data")).resolves.toEqual({ ok: true });
  });

  it("allows response well within MAX_RESPONSE_BYTES", async () => {
    mockApiFetch.mockResolvedValueOnce(
      responseWithContentLength({ result: "small" }, 200, 512)
    );

    await expect(apiJson("/api/data")).resolves.toEqual({ result: "small" });
  });

  it("skips size check when Content-Length header is absent", async () => {
    mockApiFetch.mockResolvedValueOnce(
      responseWithContentLength({ result: "no-length" }, 200, null)
    );

    await expect(apiJson("/api/data")).resolves.toEqual({ result: "no-length" });
  });

  it("skips size check when Content-Length is not a valid number", async () => {
    const res = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "not-a-number",
      },
    });

    mockApiFetch.mockResolvedValueOnce(res);

    await expect(apiJson("/api/data")).resolves.toEqual({ ok: true });
  });
});
