import { describe, it, expect, beforeAll } from "vitest";

const LIVE = process.env.LIVE_BACKEND === "1";
const BASE_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

describe.skipIf(!LIVE)("proxy route smoke tests (live backend)", () => {
  beforeAll(() => {
    console.log(`Running live proxy tests against ${BASE_URL}`);
  });

  it("GET /api/kai/market/insights/ returns insights payload", { timeout: 10_000 }, async () => {
    const response = await fetch(`${BASE_URL}/api/kai/market/insights/`);
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("json");

    const body = await response.json();
    expect(Array.isArray(body) || body.spotlights !== undefined).toBe(true);
  });

  it("POST /api/vault/bootstrap-state returns JSON shape", { timeout: 10_000 }, async () => {
    const response = await fetch(`${BASE_URL}/api/vault/bootstrap-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "test" }),
    });
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("json");

    const body = await response.json();
    expect(body).toBeDefined();
    expect(typeof body).toBe("object");
  });

  it("GET /api/pkm/metadata/{userId} returns metadata payload", { timeout: 10_000 }, async () => {
    const response = await fetch(`${BASE_URL}/api/pkm/metadata/test`);
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("json");

    const body = await response.json();
    expect(body.domains !== undefined || typeof body === "object").toBe(true);
  });

  it("GET /api/consent/active/{userId} returns consents payload", { timeout: 10_000 }, async () => {
    const response = await fetch(`${BASE_URL}/api/consent/active/test`);
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("json");

    const body = await response.json();
    expect(Array.isArray(body) || body.consents !== undefined).toBe(true);
  });

  it("POST /api/ria/persona-state returns JSON shape", { timeout: 10_000 }, async () => {
    const response = await fetch(`${BASE_URL}/api/ria/persona-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("json");

    const body = await response.json();
    expect(body).toBeDefined();
    expect(typeof body).toBe("object");
  });

  it("GET /api/world-model/stock-context/AAPL returns stock context", { timeout: 10_000 }, async () => {
    const response = await fetch(
      `${BASE_URL}/api/world-model/stock-context/AAPL`
    );
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("json");

    const body = await response.json();
    expect(body).toBeDefined();
    expect(typeof body).toBe("object");
  });
});
