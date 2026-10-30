import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch } }));

import { ConnectionsService } from "@/lib/services/connections-service";

// Google Play user-generated content policy: a person who receives a
// connection request (with its free-text message) can report it and block the
// sender.
describe("ConnectionsService report and block", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(
      new Response(JSON.stringify({ result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("reports a request, declining and blocking, with a reason from the closed enum", async () => {
    await ConnectionsService.report({
      idToken: "token",
      requestId: "req/1",
      reason: "harassment",
    });
    const [path, init] = apiFetch.mock.calls[0];
    // No new endpoint: a report rides on the existing reject route.
    expect(path).toBe("/api/one/connections/requests/req%2F1/reject");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ block: true, report_reason: "harassment" });
  });

  it("sends block only when asked, and a plain decline stays bodyless", async () => {
    await ConnectionsService.reject({ idToken: "token", requestId: "req-1", block: true });
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ block: true });

    await ConnectionsService.reject({ idToken: "token", requestId: "req-1" });
    expect(apiFetch.mock.calls[1][1].body).toBeUndefined();
    expect(apiFetch.mock.calls[1][0]).toBe("/api/one/connections/requests/req-1/reject");
  });
});
