import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  resolveAfterLogin: vi.fn(),
  getIdToken: vi.fn(),
  getIdTokenWithRetry: vi.fn(),
  user: { uid: "returning_user" } as { uid: string } | null,
  loading: false,
  sessionVerificationRequired: false,
  phoneNumber: "+15555550100" as string | null,
  search: "",
  retrySessionVerification: vi.fn(),
  signOut: vi.fn(),
  isVaultUnlocked: true,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: mocks.user,
    loading: mocks.loading,
    phoneNumber: mocks.phoneNumber,
    sessionVerificationRequired: mocks.sessionVerificationRequired,
    retrySessionVerification: mocks.retrySessionVerification,
    signOut: mocks.signOut,
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: mocks.isVaultUnlocked }),
}));

vi.mock("@/lib/services/post-auth-route-service", () => ({
  PostAuthRouteService: { resolveAfterLogin: mocks.resolveAfterLogin },
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getIdToken: mocks.getIdToken,
    getIdTokenWithRetry: mocks.getIdTokenWithRetry,
  },
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
vi.mock("@/components/vault/vault-lock-guard", () => ({
  VaultLockGuard: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@/components/auth/phone-mandate-guard", () => ({
  PhoneMandateGuard: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@/components/agent/agent-chat-workspace", () => ({
  AgentChatWorkspace: () => <div>Chat workspace</div>,
}));
vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: ({ label }: { label: string }) => <div>{label}</div>,
}));
vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  ),
}));

import Home from "@/app/page";

describe("authenticated root entry", () => {
  beforeEach(() => {
    mocks.replace.mockReset();
    mocks.resolveAfterLogin.mockReset();
    mocks.getIdToken.mockReset();
    mocks.getIdTokenWithRetry.mockReset();
    mocks.user = { uid: "returning_user" };
    mocks.loading = false;
    mocks.phoneNumber = "+15555550100";
    mocks.sessionVerificationRequired = false;
    mocks.search = "";
    mocks.retrySessionVerification.mockReset();
    mocks.signOut.mockReset();
    mocks.isVaultUnlocked = true;
    mocks.getIdToken.mockResolvedValue("redacted-id-token");
    mocks.getIdTokenWithRetry.mockResolvedValue("redacted-id-token");
    mocks.resolveAfterLogin.mockResolvedValue("/");
  });

  it("enters the authenticated Chat workspace at the canonical root", async () => {
    const view = render(<Home />);

    await waitFor(() => expect(screen.getByText("Chat workspace")).toBeTruthy());
    expect(mocks.resolveAfterLogin).toHaveBeenCalledTimes(1);
    expect(mocks.resolveAfterLogin).toHaveBeenCalledWith({
      userId: "returning_user",
      redirectPath: undefined,
      idToken: "redacted-id-token",
      phoneNumber: "+15555550100",
      enableFirstRunSetupGate: true,
    });

    expect(mocks.replace).not.toHaveBeenCalled();
    view.rerender(<Home />);
    await Promise.resolve();
    expect(mocks.resolveAfterLogin).toHaveBeenCalledTimes(1);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("settles entry when StrictMode replays the admission effect", async () => {
    render(<StrictMode><Home /></StrictMode>);
    expect(await screen.findByText("Chat workspace")).toBeTruthy();
    expect(screen.queryByText("Opening chat…")).toBeNull();
  });

  it("honors a changed explicit destination for the same owner", async () => {
    const view = render(<Home />);
    await screen.findByText("Chat workspace");
    mocks.search = "redirect=%2Fone%2Fcalendar";
    mocks.resolveAfterLogin.mockResolvedValue("/one/calendar");
    view.rerender(<Home />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/one/calendar"));
  });

  it("uses the bounded-retry token fetch, not a single-shot read, for a deep link (e.g. a referral redirect)", async () => {
    // A Firebase session can still be restoring a frame after a fresh
    // sign-in or a referral redirect lands here with `redirect` set. A
    // single null token read used to fail this resolution outright and
    // show "Unable to verify setup progress." Routing through
    // getIdTokenWithRetry (rather than the bare getIdToken) is what gives
    // that restoration a bounded retry before this screen gives up.
    mocks.search = "redirect=%2Fr%2Ffriend-code";
    mocks.resolveAfterLogin.mockResolvedValue("/r/friend-code");
    mocks.getIdTokenWithRetry.mockResolvedValue("redacted-id-token");

    render(<Home />);

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/r/friend-code"),
    );
    expect(mocks.getIdTokenWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.getIdToken).not.toHaveBeenCalled();
    expect(screen.queryByText(/unable to verify setup progress/i)).toBeNull();
  });

  it("uses the secure reconnect recovery when the bounded retry genuinely exhausts", async () => {
    mocks.getIdTokenWithRetry.mockResolvedValue(null);

    render(<Home />);

    expect(
      await screen.findByText(/reconnect to continue securely/i),
    ).toBeTruthy();
    expect(screen.queryByText(/unable to verify setup progress/i)).toBeNull();
    expect(mocks.resolveAfterLogin).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "Sign out" }).click();
    expect(mocks.signOut).toHaveBeenCalledWith({ skipFcmCleanup: true });
  });

  it("holds signed-in routing behind the app-wide session recovery gate", async () => {
    mocks.sessionVerificationRequired = true;

    render(<Home />);

    expect(
      await screen.findByText(/reconnect to continue securely/i),
    ).toBeTruthy();
    expect(mocks.resolveAfterLogin).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "Try again" }).click();
    expect(mocks.retrySessionVerification).toHaveBeenCalledTimes(1);
    screen.getByRole("button", { name: "Sign out" }).click();
    expect(mocks.signOut).toHaveBeenCalledWith({ skipFcmCleanup: true });
  });

  it("offers recovery when a native cold read cannot identify the account", async () => {
    mocks.user = null;
    mocks.sessionVerificationRequired = true;
    render(<Home />);
    expect(await screen.findByText(/reconnect to continue securely/i)).toBeTruthy();
    expect(screen.queryByText("Welcome")).toBeNull();
    screen.getByRole("button", { name: "Sign out" }).click();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.signOut).toHaveBeenCalledWith({ skipFcmCleanup: true });
    expect(mocks.resolveAfterLogin).not.toHaveBeenCalled();
  });
});
