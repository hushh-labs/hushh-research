import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/auth/session/route";
import * as adminAuth from "@/lib/firebase/admin";

const mockSetCookie = vi.fn();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    set: mockSetCookie,
    get: vi.fn(),
    delete: vi.fn(),
  })),
}));

vi.mock("@/lib/firebase/admin", () => ({
  createSessionCookie: vi.fn(),
  verifySessionCookie: vi.fn(),
}));

describe("POST /api/auth/session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST returns 400 and sets no cookie when idToken is absent", async () => {
    const request = new NextRequest("http://localhost:3000/api/auth/session", {
      method: "POST",
      body: JSON.stringify({}),
      headers: {
        "Content-Type": "application/json",
      },
    });

    const response = await POST(request);
    const body = await response.json();

    // 1. Status is 400
    expect(response.status).toBe(400);

    // 2. Response reports that an ID token is required
    expect(body).toEqual({ error: "ID token is required" });

    // 3. createSessionCookie was not called
    expect(adminAuth.createSessionCookie).not.toHaveBeenCalled();

    // 4. The cookie store did not receive a hushh_session value
    expect(mockSetCookie).not.toHaveBeenCalled();
  });
});
