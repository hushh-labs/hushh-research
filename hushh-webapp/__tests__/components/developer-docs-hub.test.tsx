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
      tools: [{ name: "discover_user_domains", description: "Discover available domains." }],
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
      NEXT_PUBLIC_BACKEND_URL: "https://consent-protocol-uat-a1b2c3-uc.a.run.app",
    };
    delete process.env.NEXT_PUBLIC_DEVELOPER_API_URL;
    delete process.env.NEXT_PUBLIC_DEVELOPER_APP_URL;
    delete process.env.NEXT_PUBLIC_DEVELOPER_MCP_URL;
  });

  it("renders Remote MCP as the primary UAT onboarding path without Cloud Run snippet leakage", async () => {
    render(<DeveloperDocsHub initialOrigin="https://uat.kai.hushh.ai" />);

    await waitFor(() => {
      expect(screen.getByText("API root ready")).toBeTruthy();
      expect(screen.getByText("Tool catalog ready")).toBeTruthy();
      expect(screen.getByText("Scope catalog ready")).toBeTruthy();
    });

    expect(screen.getByRole("heading", { name: "Connect to Hussh with Remote MCP" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Connect with Remote MCP" })).toBeTruthy();
    expect(screen.getAllByText(/https:\/\/api\.uat\.hushh\.ai\/mcp\/\?token=<developer-token>/).length).toBeGreaterThan(0);
    expect(screen.getByText("Advanced: REST API and npm bridge")).toBeTruthy();
    expect(screen.getAllByText("Remote MCP first").length).toBeGreaterThan(0);
    expect(screen.queryByText("Production")).toBeNull();
    expect(screen.queryByText(/consent-protocol-uat-a1b2c3-uc\.a\.run\.app/)).toBeNull();
  });
});
