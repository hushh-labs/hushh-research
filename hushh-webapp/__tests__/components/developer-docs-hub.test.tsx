import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeveloperDocsHub } from "@/components/developers/developer-docs-hub";

const ORIGINAL_ENV = { ...process.env };

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    signOut: vi.fn(),
    setNativeUser: vi.fn(),
    checkAuth: vi.fn(),
  }),
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    signInWithGoogle: vi.fn(),
    signInWithApple: vi.fn(),
  },
}));

vi.mock("@/lib/utils/clipboard", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/services/developer-portal-service", () => {
  class DeveloperPortalRequestError extends Error {
    status: number;
    code?: string;

    constructor(message: string, options: { status: number; code?: string }) {
      super(message);
      this.name = "DeveloperPortalRequestError";
      this.status = options.status;
      this.code = options.code;
    }
  }

  return {
    DeveloperPortalRequestError,
    getLiveDeveloperDocs: vi.fn().mockResolvedValue({
      apiRoot: { version: "v1" },
      scopes: [{ name: "pkm.read", description: "Read approved PKM data." }],
      tools: [
        {
          name: "search_user_scopes",
          description: "Find the least-privilege scope available to a person.",
        },
      ],
      notes: [],
    }),
    getDeveloperAccess: vi.fn(),
    enableDeveloperAccess: vi.fn(),
    rotateDeveloperAccessToken: vi.fn(),
    updateDeveloperAccessProfile: vi.fn(),
  };
});

describe("DeveloperDocsHub", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "test",
      NEXT_PUBLIC_BACKEND_URL:
        "https://consent-protocol-uat-a1b2c3-uc.a.run.app",
    };
    delete process.env.NEXT_PUBLIC_DEVELOPER_API_URL;
    delete process.env.NEXT_PUBLIC_DEVELOPER_APP_URL;
    delete process.env.NEXT_PUBLIC_DEVELOPER_MCP_URL;
  });

  it("renders Remote MCP as the primary UAT onboarding path without Cloud Run snippet leakage", async () => {
    render(<DeveloperDocsHub initialOrigin="https://uat.one.hushh.ai" />);

    await waitFor(() => {
      expect(screen.getByText("One connection. One lifecycle.")).toBeTruthy();
    });

    expect(
      screen.getByRole("heading", {
        name: "Hussh Consent MCP",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Connect in three steps")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy Remote MCP config" }),
    ).toBeTruthy();
    // Bare URL, no ?token= query: the live API rejects query-string tokens and
    // requires "Authorization: Bearer" instead.
    expect(
      screen.getAllByText(/https:\/\/api\.uat\.hushh\.ai\/mcp\//).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("http://localhost:8000/mcp/")).toBeNull();
    // The first read is intentionally only the Remote MCP setup. Reference
    // details remain available behind named sections, rather than expanding a
    // public landing into a wall of implementation detail.
    expect(screen.queryByText("search_user_scopes")).toBeNull();
    expect(screen.queryByText("discover_user_domains")).toBeNull();
    expect(screen.getByText("Advanced: REST API and npm bridge")).toBeTruthy();
    expect(document.querySelectorAll("[data-state='open']")).toHaveLength(0);
    expect(document.querySelector("[data-slot='badge']")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sections" })).toBeNull();
    expect(screen.queryByText("Production")).toBeNull();
    expect(
      screen.queryByText(/consent-protocol-uat-a1b2c3-uc\.a\.run\.app/),
    ).toBeNull();

    await screen.getByText("Connect through streamable HTTP.").click();
    for (const tool of [
      "search-user-scopes",
      "prepare-campaign-context",
      "request-consent",
      "check-consent-status",
      "get-encrypted-scoped-export",
    ]) {
      expect(screen.getByText(tool)).toBeTruthy();
    }
    expect(screen.queryByText("search_user_scopes")).toBeNull();
  });
});
