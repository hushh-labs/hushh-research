import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  resolveAfterLogin: vi.fn(),
  getIdToken: vi.fn(),
  user: { uid: "returning_user" } as { uid: string } | null,
  loading: false,
  phoneNumber: "+15555550100" as string | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: mocks.user,
    loading: mocks.loading,
    phoneNumber: mocks.phoneNumber,
  }),
}));

vi.mock("@/lib/services/post-auth-route-service", () => ({
  PostAuthRouteService: { resolveAfterLogin: mocks.resolveAfterLogin },
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: mocks.getIdToken },
}));

vi.mock("@/components/onboarding/IntroStep", () => ({
  IntroStep: () => <div>Welcome</div>,
}));
vi.mock("@/components/seo/json-ld", () => ({ JsonLd: () => null }));
vi.mock("@/lib/seo/structured-data", () => ({ buildFaqGraph: () => ({}) }));
vi.mock("@/lib/seo/faq-data", () => ({ HOME_FAQ: [] }));
vi.mock("@/components/app-ui/native-test-beacon", () => ({
  NativeTestBeacon: () => null,
}));
vi.mock("@/components/app-ui/native-route-marker", () => ({
  NativeRouteMarker: () => null,
}));
vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: ({ label }: { label: string }) => <div>{label}</div>,
}));
vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

import Home from "@/app/page";

describe("authenticated root entry", () => {
  beforeEach(() => {
    mocks.replace.mockReset();
    mocks.resolveAfterLogin.mockReset();
    mocks.getIdToken.mockReset();
    mocks.user = { uid: "returning_user" };
    mocks.loading = false;
    mocks.phoneNumber = "+15555550100";
    mocks.getIdToken.mockResolvedValue("redacted-id-token");
    mocks.resolveAfterLogin.mockResolvedValue("/one");
  });

  it("resolves the authoritative post-auth destination once before entering a protected route", async () => {
    const view = render(<Home />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/one"));
    expect(mocks.resolveAfterLogin).toHaveBeenCalledTimes(1);
    expect(mocks.resolveAfterLogin).toHaveBeenCalledWith({
      userId: "returning_user",
      redirectPath: undefined,
      idToken: "redacted-id-token",
      phoneNumber: "+15555550100",
      enableFirstRunSetupGate: true,
    });

    view.rerender(<Home />);
    await Promise.resolve();
    expect(mocks.resolveAfterLogin).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledTimes(1);
  });
});
