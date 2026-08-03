import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

type ConnectedSystemsCatchAllRoute = {
  DELETE: (
    request: NextRequest,
    props: { params: Promise<{ path: string[] }> },
  ) => Promise<Response>;
};

let route: ConnectedSystemsCatchAllRoute;

beforeEach(async () => {
  vi.restoreAllMocks();
  route = await import("../../app/api/connected-systems/[...path]/route");
});

describe("/api/connected-systems/[...path] proxy", () => {
  it("forwards owner-confirmed local unlink without a request body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ status: "disconnected" }),
    );
    const request = new NextRequest(
      "http://localhost:3000/api/connected-systems/customer-crm/record-binding?objectType=Contact",
      {
        method: "DELETE",
        headers: { Authorization: "Bearer HCT:test" },
      },
    );

    const response = await route.DELETE(request, {
      params: Promise.resolve({
        path: ["customer-crm", "record-binding"],
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.test/api/connected-systems/customer-crm/record-binding?objectType=Contact",
      expect.objectContaining({
        method: "DELETE",
        body: undefined,
      }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer HCT:test");
  });
});
