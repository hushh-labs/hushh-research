import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRiaClientWorkspaceState } from "@/components/ria/use-ria-client-workspace-state";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { RiaService, type RiaClientDetail } from "@/lib/services/ria-service";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      uid: "advisor-1",
      getIdToken: vi.fn(() => new Promise<string>(() => {})),
    },
  }),
}));

vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => ({
    riaCapability: "active",
    loading: false,
  }),
}));

vi.mock("@/lib/observability/client", () => ({
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/observability/growth", () => ({
  resolveGrowthWorkspaceSource: vi.fn(() => "test"),
  trackGrowthFunnelStepCompleted: vi.fn(),
  trackRiaActivationCompleted: vi.fn(),
}));

vi.mock("@/lib/services/ria-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/ria-service")>();

  return {
    ...actual,
    RiaService: {
      getClientDetail: vi.fn(),
      getWorkspace: vi.fn(),
    },
  };
});

describe("useRiaClientWorkspaceState", () => {
  beforeEach(() => {
    CacheService.getInstance().clear();
    vi.mocked(RiaService.getClientDetail).mockReset();
    vi.mocked(RiaService.getWorkspace).mockReset();
  });

  it("covers cached loading fallback", () => {
    const cachedDetail = {
      investor_user_id: "client-1",
      investor_display_name: "Cached Investor",
      investor_email: "cached@example.com",
      relationship_status: "active",
      granted_scopes: [],
      account_branches: [],
      request_history: [],
      available_scope_metadata: [],
      requestable_scope_templates: [],
      kai_specialized_bundle: null,
    } as unknown as RiaClientDetail;

    CacheService.getInstance().set(
      CACHE_KEYS.RIA_CLIENT_DETAIL("advisor-1", "client-1"),
      cachedDetail,
    );

    const { result } = renderHook(() =>
      useRiaClientWorkspaceState({ clientId: "client-1" }),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.detail).toBe(cachedDetail);
    expect(result.current.detail?.investor_display_name).toBe("Cached Investor");
  });
});
