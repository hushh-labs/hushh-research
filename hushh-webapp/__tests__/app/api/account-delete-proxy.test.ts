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

describe("account delete proxy", () => {
  it("forwards the backend's typed error object so the client can read its code", async () => {
    const { response, error } = await proxiedError(
      Response.json(
        {
          detail: {
            code: "ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING",
            message: "Remove your private agent first.",
          },
        },
        { status: 409 },
      ),
    );

    expect(response.status).toBe(409);
    expect(apiErrorCode(error)).toBe(
      "ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING",
    );
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
