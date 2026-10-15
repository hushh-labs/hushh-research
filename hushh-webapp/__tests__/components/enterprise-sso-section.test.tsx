import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exchange: vi.fn(),
  signIn: vi.fn(),
  notifyFirstWelcome: vi.fn(),
  recordAcceptance: vi.fn(),
  begin: vi.fn(() => "settlement-1"),
  complete: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    exchangeEnterpriseSso: mocks.exchange,
    startEnterpriseSso: vi.fn(),
    notifyFirstWelcome: mocks.notifyFirstWelcome,
  },
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { signInWithCustomToken: mocks.signIn },
}));
vi.mock("@/lib/services/legal-acceptance-service", () => ({
  LegalAcceptanceService: { recordSignInAcceptance: mocks.recordAcceptance },
}));
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    beginPostAuthSettlement: mocks.begin,
    completePostAuthSettlement: mocks.complete,
  }),
}));
vi.mock("@/lib/capacitor/platform", () => ({ isWeb: () => true }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { error: mocks.toastError } }));
vi.mock("@/lib/observability/client", () => ({ trackEvent: vi.fn() }));

import { EnterpriseSsoSection } from "@/components/onboarding/EnterpriseSsoSection";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import {
  createWorldModelInvitationHandoff,
  readWorldModelInvitationHandoff,
  worldModelInvitationHandoffRoute,
} from "@/lib/world-model/invitation-handoff";

const PENDING_KEY = "hushh.enterprise_sso.pending";

function arriveFromWorkOS(search: string, pendingState = "expected.state") {
  window.sessionStorage.setItem(
    PENDING_KEY,
    JSON.stringify({ state: pendingState, resume: "/kai", startedAt: Date.now() }),
  );
  window.history.replaceState(null, "", `/login${search}`);
}

describe("EnterpriseSsoSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mocks.exchange.mockResolvedValue({ custom_token: "custom-token" });
    mocks.signIn.mockResolvedValue({
      user: { getIdToken: async () => "id-token" },
      idToken: "id-token",
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    window.history.replaceState(null, "", "/");
  });

  it("renders nothing while the flag is off", () => {
    const { container } = render(<EnterpriseSsoSection redirectPath="" />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText("Continue with SSO")).toBeNull();
  });

  it("offers the entry point once opted in", () => {
    vi.stubEnv("NEXT_PUBLIC_WORKOS_SSO_ENABLED", "true");
    render(<EnterpriseSsoSection redirectPath="" />);
    expect(screen.getByText("Continue with SSO")).toBeTruthy();
  });

  it("lets Back close the email form first, then releases to the route's own parent", () => {
    vi.stubEnv("NEXT_PUBLIC_WORKOS_SSO_ENABLED", "true");
    render(<EnterpriseSsoSection redirectPath="" />);
    expect(unwindBackLayer("/login", null)).toBe(false); // nothing open: Back is not ours
    fireEvent.click(screen.getByText("Continue with SSO"));
    expect(screen.getByLabelText("Work email")).toBeTruthy();
    let consumed = false;
    act(() => {
      consumed = unwindBackLayer("/login", null);
    });
    expect(consumed).toBe(true);
    expect(screen.queryByLabelText("Work email")).toBeNull();
    expect(screen.getByText("Continue with SSO")).toBeTruthy();
    expect(unwindBackLayer("/login", null)).toBe(false); // layer released; Back reaches the parent
  });

  it("refuses a callback whose state this browser did not store, and never exchanges the code", async () => {
    vi.stubEnv("NEXT_PUBLIC_WORKOS_SSO_ENABLED", "true");
    arriveFromWorkOS("?code=stolen&state=forged.state");
    render(<EnterpriseSsoSection redirectPath="" />);
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
    // The single-use code and state never stay in the address bar.
    expect(window.location.search).toBe("?redirect=%2Fkai");
  });

  it("completes the Firebase sign-in when the state matches (negative control)", async () => {
    vi.stubEnv("NEXT_PUBLIC_WORKOS_SSO_ENABLED", "true");
    arriveFromWorkOS("?code=good&state=expected.state");
    render(<EnterpriseSsoSection redirectPath="" />);
    await waitFor(() => expect(mocks.signIn).toHaveBeenCalledWith("custom-token"));
    expect(mocks.exchange).toHaveBeenCalledWith({ code: "good", state: "expected.state" });
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledWith("settlement-1"));
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("restores the invitation destination to Next search params before signing in", async () => {
    vi.stubEnv("NEXT_PUBLIC_WORKOS_SSO_ENABLED", "true");
    const token = "a".repeat(43);
    const id = createWorldModelInvitationHandoff(token)!;
    const resume = worldModelInvitationHandoffRoute(id);
    window.sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ state: "expected.state", resume, startedAt: Date.now() }),
    );
    const nextHistoryState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["login"] };
    window.history.replaceState(nextHistoryState, "", "/login?code=good&state=expected.state");
    let nextSearchParams = new URLSearchParams(window.location.search);
    let destinationAtSignIn: string | null = null;
    const nativeReplaceState = window.history.replaceState.bind(window.history);
    // Next's App Router bypasses useSearchParams synchronization for writes
    // carrying __NA/_N. Application writes instead inherit its internal state.
    const replaceState = vi.spyOn(window.history, "replaceState").mockImplementation((data, unused, url) => {
      if (data?.__NA || data?._N) return nativeReplaceState(data, unused, url);
      if (url) nextSearchParams = new URL(url, window.location.href).searchParams;
      return nativeReplaceState({ ...data, ...nextHistoryState }, unused, url);
    });
    mocks.signIn.mockImplementationOnce(async () => {
      destinationAtSignIn = nextSearchParams.get("redirect");
      return { user: { getIdToken: async () => "id-token" }, idToken: "id-token" };
    });
    try {
      render(<EnterpriseSsoSection redirectPath="" />);
      await waitFor(() => expect(mocks.complete).toHaveBeenCalledWith("settlement-1"));
      expect(destinationAtSignIn).toBe(resume);
      expect(window.location.search).not.toContain(token);
      expect(readWorldModelInvitationHandoff(id, null)).toBe(token);
      expect(nextSearchParams.has("code")).toBe(false);
      expect(nextSearchParams.has("state")).toBe(false);
      expect(window.history.state).toEqual(nextHistoryState);
    } finally {
      replaceState.mockRestore();
    }
  });
});
