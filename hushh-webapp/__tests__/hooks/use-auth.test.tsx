import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, renderHook } from "@testing-library/react";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
  }),
  usePathname: vi.fn(),
}));

vi.mock("@/lib/firebase/auth-context", () => {
  const mockUseAuth = vi.fn();
  return {
    useAuth: mockUseAuth,
  };
});

import { usePathname } from "next/navigation";
import { useAuth as useContextAuth } from "@/lib/firebase/auth-context";
import { useAuth, useRequireAuth } from "@/hooks/use-auth";

function Harness() {
  useRequireAuth();
  return null;
}

describe("useRequireAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-exports the global auth context hook directly", () => {
    expect(useAuth).toBe(useContextAuth);
  });

  it("redirects unauthenticated users", () => {
    vi.mocked(usePathname).mockReturnValue("/dashboard");

    vi.mocked(useContextAuth).mockReturnValue({
      loading: false,
      isAuthenticated: false,
    } as any);

    render(<Harness />);

    expect(pushMock).toHaveBeenCalledWith("/login");
  });

  it("does not redirect authenticated users", () => {
    vi.mocked(usePathname).mockReturnValue("/dashboard");

    vi.mocked(useContextAuth).mockReturnValue({
      loading: false,
      isAuthenticated: true,
    } as any);

    render(<Harness />);

    expect(pushMock).not.toHaveBeenCalled();
  });

  it("does not redirect while loading", () => {
    vi.mocked(usePathname).mockReturnValue("/dashboard");

    vi.mocked(useContextAuth).mockReturnValue({
      loading: true,
      isAuthenticated: false,
    } as any);

    render(<Harness />);

    expect(pushMock).not.toHaveBeenCalled();
  });

  it("does not redirect when already on login page", () => {
    vi.mocked(usePathname).mockReturnValue("/login");

    vi.mocked(useContextAuth).mockReturnValue({
      loading: false,
      isAuthenticated: false,
    } as any);

    render(<Harness />);

    expect(pushMock).not.toHaveBeenCalled();
  });

  it("returns the exact auth object state", () => {
    const mockAuthObj = {
      loading: false,
      isAuthenticated: true,
      user: { uid: "user-test" },
    };
    vi.mocked(useContextAuth).mockReturnValue(mockAuthObj as any);
    vi.mocked(usePathname).mockReturnValue("/dashboard");

    const { result } = renderHook(() => useRequireAuth());
    expect(result.current).toBe(mockAuthObj);
  });
});