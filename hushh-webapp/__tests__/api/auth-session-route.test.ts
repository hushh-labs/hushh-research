import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createSessionCookie: vi.fn(),
  cookies: vi.fn(),
  cookieSet: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  createSessionCookie: mocks.createSessionCookie,
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

import { POST } from "../../app/api/auth/session/route";

describe("POST /api/auth/session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookies.mockResolvedValue({
      set: mocks.cookieSet,
    });
  });

  it("returns 400 and sets no cookie when idToken is absent", async () => {
    const request = new NextRequest("http://localhost:3000/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "ID token is required",
    });
    expect(mocks.createSessionCookie).not.toHaveBeenCalled();
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});
