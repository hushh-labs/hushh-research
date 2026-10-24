// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "https://backend.test",
}));

import { DELETE } from "@/app/api/account/delete/route";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deleteRequest() {
  return new NextRequest("https://app.test/api/account/delete", {
    method: "DELETE",
    headers: {
      authorization: "Bearer synthetic-owner",
      "content-type": "application/json",
    },
    body: JSON.stringify({ target: "both" }),
  });
}

async function proxiedError(backend: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(backend));
  const response = await DELETE(deleteRequest());
  const payload: unknown = await response.json();
  return { response, error: new ApiError("x", response.status, payload) };
}

describe("@feature_account_deletion @trace_loop account delete proxy", () => {
  it("preserves request correlation through the upstream call and response", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ success: true, account_deleted: true }));
    vi.stubGlobal("fetch", fetch);
    const request = deleteRequest();
    request.headers.set("x-request-id", "account-delete-trace-001");
    const response = await DELETE(request);
    expect(response.headers.get("x-request-id")).toBe("account-delete-trace-001");
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-request-id")).toBe("account-delete-trace-001");
  });
  it.each([
    "ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING",
    "FILES_ERASURE_IN_PROGRESS",
  ])("forwards the backend's typed error %s so the client can read its code", async (code) => {
    const { response, error } = await proxiedError(
      Response.json(
        {
          detail: {
            code,
            message: "Remove your private agent first.",
          },
        },
        { status: 409 },
      ),
    );

    expect(response.status).toBe(409);
    expect(apiErrorCode(error)).toBe(code);
  });

  it("keeps the rolled-back failure code on a backend 500", async () => {
    const { response, error } = await proxiedError(
      Response.json(
        { detail: "Account deletion failed", code: "ACCOUNT_DELETION_FAILED" },
        { status: 500 },
      ),
    );

    expect(response.status).toBe(500);
    expect(apiErrorCode(error)).toBe("ACCOUNT_DELETION_FAILED");
  });

  it("wraps a non-JSON backend error without inventing a code", async () => {
    const { response, error } = await proxiedError(
      new Response("upstream timeout", { status: 504 }),
    );

    expect(response.status).toBe(504);
    expect(error.payload).toEqual({ error: "upstream timeout" });
    expect(apiErrorCode(error)).toBeNull();
  });
});
