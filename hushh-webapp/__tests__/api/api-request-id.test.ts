import { withRequestIdResponse } from "@/app/api/_utils/request-id";
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id";

describe("withRequestIdResponse", () => {
  it("preserves request id on proxied upstream responses", async () => {
    const response = withRequestIdResponse(
      "req-proxy-123",
      new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: {
          "content-type": "application/json",
          [REQUEST_ID_HEADER]: "req-upstream-456",
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("req-proxy-123");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
