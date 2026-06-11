import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
  }),
  usePathname: vi.fn(),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: vi.fn(),
}));

import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/firebase/auth-context";
import { useRequireAuth } from "@/hooks/use-auth";

function Harness() {
  useRequireAuth();
  return null;
}

describe("useRequireAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated users", () => {
    vi.mocked(usePathname).mockReturnValue("/dashboard");

    vi.mocked(useAuth).mockReturnValue({
      loading: false,
      isAuthenticated: false,
    } as any);

    render(<Harness />);

    expect(pushMock).toHaveBeenCalledWith("/login");
  });

  it("does not redirect authenticated users", () => {
    vi.mocked(usePathname).mockReturnValue("/dashboard");

    vi.mocked(useAuth).mockReturnValue({
      loading: false,
      isAuthenticated: true,
    } as any);

    render(<Harness />);

    expect(pushMock).not.toHaveBeenCalled();
  });

  it("does not redirect while loading", () => {
    vi.mocked(usePathname).mockReturnValue("/dashboard");

    vi.mocked(useAuth).mockReturnValue({
      loading: true,
      isAuthenticated: false,
    } as any);

    render(<Harness />);

    expect(pushMock).not.toHaveBeenCalled();
  });

  it("does not redirect when already on login page", () => {
    vi.mocked(usePathname).mockReturnValue("/login");

    vi.mocked(useAuth).mockReturnValue({
      loading: false,
      isAuthenticated: false,
    } as any);

    render(<Harness />);

    expect(pushMock).not.toHaveBeenCalled();
  });
});