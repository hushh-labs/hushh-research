import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStep } from "@/components/onboarding/AuthStep";

const settlement = vi.hoisted(() => {
  const begin = vi.fn().mockReturnValue(7);
  const complete = vi.fn();
  return {
    currentUser: null as { uid: string } | null,
    signIn: vi.fn(), begin, complete,
    contacts: vi.fn().mockResolvedValue(undefined),
    legal: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockResolvedValue("/one/setup"),
    journey: vi.fn().mockResolvedValue(undefined),
    requiredCookie: vi.fn(), flowCookie: vi.fn(),
    router: { push: vi.fn(), replace: vi.fn() },
    progress: { registerSteps: vi.fn(), completeStep: vi.fn(), reset: vi.fn() },
    mint: vi.fn(), customSignIn: vi.fn(), reviewMode: false, reviewerTrigger: null as null | (() => void),
    native: { enabled: false, autoReviewerLogin: false, expectedUserId: "reviewer", reviewerSessionPassphrase: "mint-only", vaultPassphrase: null },
    auth: { user: null, loading: false, sessionVerificationRequired: false,
      retrySessionVerification: vi.fn(), signOut: vi.fn(),
      beginPostAuthSettlement: begin, completePostAuthSettlement: complete },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => settlement.router }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/firebase/auth-context", () => ({ useAuth: () => settlement.auth }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: {
  canRequestInitialGoogleContacts: () => true,
  signInWithGoogle: settlement.signIn,
  getCurrentUser: () => settlement.currentUser,
  signInWithCustomToken: settlement.customSignIn,
} }));
vi.mock("@/lib/services/initial-contacts-onboarding-service", () => ({ InitialContactsOnboardingService: { begin: settlement.contacts } }));
vi.mock("@/lib/services/legal-acceptance-service", () => ({ LegalAcceptanceService: { recordSignInAcceptance: settlement.legal } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {
  emailAuthRequest: async () => ({ enabled: false }),
  getAppReviewModeConfig: async () => ({ enabled: settlement.reviewMode }), notifyFirstWelcome: settlement.notify,
  createAppReviewModeSession: settlement.mint,
} }));
vi.mock("@/lib/services/post-auth-route-service", () => ({ PostAuthRouteService: { resolveAfterLogin: settlement.route } }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({ PreVaultUserStateService: { syncOnboardingJourney: settlement.journey } }));
vi.mock("@/lib/services/onboarding-route-cookie", () => ({
  setOnboardingRequiredCookie: settlement.requiredCookie,
  setOnboardingFlowActiveCookie: settlement.flowCookie,
  isOnboardingFlowActiveCookieEnabled: () => false,
}));
vi.mock("@/lib/auth/google-signup-token", () => ({ preloadGoogleSignupAuth: async () => undefined }));
vi.mock("@/lib/progress/step-progress-context", () => ({ useStepProgress: () => settlement.progress }));
vi.mock("@/lib/capacitor/platform", () => ({ isWeb: () => true, isAndroid: () => false }));
vi.mock("@/lib/testing/native-test", () => ({ getNativeTestConfig: () => settlement.native, useNativeTestConfig: () => settlement.native }));
vi.mock("@/lib/agent/local-onboarding-actions", () => ({ useLocalOnboardingActionHandler: () => undefined }));
vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({ usePublishVoiceSurfaceMetadata: () => undefined }));
vi.mock("@/lib/observability/client", () => ({ trackEvent: () => undefined }));
vi.mock("@/lib/observability/growth", () => ({ resolveGrowthEntrySurface: () => "login", resolveGrowthJourneyForPath: () => null, trackGrowthFunnelStepCompleted: () => undefined }));
vi.mock("@/lib/morphy-ux/ui", () => ({ Icon: () => null }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { error: vi.fn() } }));
vi.mock("@/lib/morphy-ux/ui/hushh-mark", () => ({ HushhMark: () => null }));
vi.mock("@/components/app-ui/hushh-loader", () => ({ HushhLoader: () => null }));
vi.mock("@/components/auth/session-verification-recovery", () => ({ SessionVerificationRecovery: () => null }));
vi.mock("@/components/onboarding/OnboardingHeroBackground", () => ({ OnboardingHeroBackground: () => null }));
vi.mock("@/components/app-ui/native-test-beacon", () => ({ NativeTestBeacon: (props: {
  attachToBridge: (bridge: { triggerReviewerLogin?: () => void }) => void,
}) => {
  const bridge: { triggerReviewerLogin?: () => void } = {};
  props.attachToBridge(bridge);
  settlement.reviewerTrigger = bridge.triggerReviewerLogin ?? null;
  return null;
} }));
vi.mock("@/components/onboarding/EnterpriseSsoSection", () => ({ EnterpriseSsoSection: () => null }));
vi.mock("@/components/onboarding/AuthProviderButton", () => ({
  AuthProviderButton: (props: { label: string; onClick: () => void; disabled?: boolean }) =>
    createElement("button", { onClick: props.onClick, disabled: props.disabled }, props.label),
}));

describe("AuthStep committed provider settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks(); settlement.currentUser = null;
    settlement.native.enabled = false; settlement.native.autoReviewerLogin = false;
    settlement.reviewMode = false;
    settlement.auth.user = null;
  });
  afterEach(cleanup);

  it("leaves mint-only reviewer authentication to bootstrap, including tap and bridge triggers", async () => {
    settlement.native.enabled = true;
    settlement.native.autoReviewerLogin = true;
    const view = render(createElement(AuthStep, { redirectPath: "/one" }));
    const button = await screen.findByRole("button", { name: "Continue as Reviewer" });
    expect(button).toBeDisabled();
    await act(async () => { fireEvent.click(button); settlement.reviewerTrigger?.(); });
    expect(settlement.mint).not.toHaveBeenCalled();
    expect(settlement.customSignIn).not.toHaveBeenCalled();

    const user = { uid: "reviewer", getIdToken: vi.fn().mockResolvedValue("firebase-token") };
    settlement.currentUser = user;
    Object.assign(settlement.auth, { user });
    await act(async () => { view.rerender(createElement(AuthStep, { redirectPath: "/one" })); });
    expect(settlement.route).toHaveBeenCalledTimes(1);
    expect(settlement.router.replace).toHaveBeenCalledExactlyOnceWith("/one/setup");
    expect(settlement.mint).not.toHaveBeenCalled();
  });

  it("retains the explicit reviewer bridge action when automatic authentication is disabled", async () => {
    settlement.native.enabled = true;
    settlement.reviewMode = true;
    settlement.mint.mockResolvedValueOnce({ token: "test-custom-token" });
    const user = { uid: "reviewer", getIdToken: vi.fn().mockResolvedValue("firebase-token") };
    settlement.currentUser = user;
    settlement.customSignIn.mockResolvedValueOnce({ user });
    await act(async () => { render(createElement(AuthStep, { redirectPath: "/one" })); });
    await act(async () => { settlement.reviewerTrigger?.(); });
    expect(settlement.mint).toHaveBeenCalledTimes(1);
    expect(settlement.customSignIn).toHaveBeenCalledExactlyOnceWith("test-custom-token");
  });

  it("refuses a captured manual trigger after automatic auth takes ownership before rerender", async () => {
    settlement.reviewMode = true;
    await act(async () => { render(createElement(AuthStep, { redirectPath: "/one" })); });
    const trigger = settlement.reviewerTrigger;
    settlement.native.enabled = true;
    settlement.native.autoReviewerLogin = true;
    await act(async () => { trigger?.(); });
    expect(settlement.mint).not.toHaveBeenCalled();
    expect(settlement.customSignIn).not.toHaveBeenCalled();
  });

  it.each(["unmounted-resolve", "unmounted-reject", "changed-resolve", "changed-reject"])(
    "does not navigate or write route cookies after a pending resolver loses authority (%s)", async (scenario) => {
      let finishRoute!: (value: string) => void;
      let failRoute!: (error: Error) => void;
      settlement.route.mockImplementationOnce(() => new Promise<string>((resolve, reject) => {
        finishRoute = resolve; failRoute = reject;
      }));
      const user = { uid: "current-owner", getIdToken: vi.fn().mockResolvedValue("firebase-token") };
      settlement.currentUser = user;
      settlement.signIn.mockResolvedValueOnce({ user, idToken: "firebase-token", isNewUser: false });
      const view = render(createElement(AuthStep, { redirectPath: "/one" }));
      await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" })); });
      expect(settlement.route).toHaveBeenCalledTimes(1);
      if (scenario.startsWith("unmounted")) view.unmount();
      else settlement.currentUser = { uid: "different-owner" };
      await act(async () => {
        if (scenario.endsWith("reject")) failRoute(new Error("route unavailable"));
        else finishRoute("/one/setup");
      });
      expect(settlement.journey).not.toHaveBeenCalled();
      expect(settlement.requiredCookie).not.toHaveBeenCalled();
      expect(settlement.flowCookie).not.toHaveBeenCalled();
      expect(settlement.router.push).not.toHaveBeenCalled();
      expect(settlement.router.replace).not.toHaveBeenCalled();
      expect(settlement.complete).toHaveBeenCalledExactlyOnceWith(7);
    },
  );

  it.each(["same", "changed", "signed-out"] as const)("settles an unmounted signup only for its current Firebase owner (%s)", async (owner) => {
    let finish!: (result: unknown) => void;
    let signal: AbortSignal | undefined;
    let startExchange!: () => void;
    settlement.signIn.mockImplementationOnce((options) => {
      signal = options.signal;
      startExchange = options.onCredentialExchange;
      return new Promise((resolve) => { finish = resolve; });
    });
    const { unmount } = render(createElement(AuthStep, { redirectPath: "/one" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));
    act(() => startExchange());
    const user = { uid: "committed-owner", getIdToken: vi.fn().mockResolvedValue("firebase-token") };
    const result = { user, idToken: "firebase-token", isNewUser: true,
      contactsGrant: { accessToken: "ephemeral-token", authority: "firebase-signup" } };
    unmount();
    expect(signal?.aborted).toBe(true);
    settlement.currentUser = owner === "same" ? user : owner === "changed" ? { uid: "other-owner" } : null;
    await act(async () => { finish(result); await Promise.resolve(); });
    if (owner === "same") {
      expect(settlement.begin).toHaveBeenCalledExactlyOnceWith(user);
      expect(settlement.legal).toHaveBeenCalledExactlyOnceWith(user, true);
      expect(settlement.contacts).toHaveBeenCalledExactlyOnceWith(result, "google", expect.any(String), true);
      expect(settlement.complete).toHaveBeenCalledExactlyOnceWith(7);
    } else {
      expect(settlement.begin).not.toHaveBeenCalled();
      expect(settlement.legal).not.toHaveBeenCalled();
      expect(settlement.contacts).not.toHaveBeenCalled();
    }
    expect(settlement.route).not.toHaveBeenCalled();
    expect(settlement.router.push).not.toHaveBeenCalled();
    expect(settlement.router.replace).not.toHaveBeenCalled();
  });
});

describe("AuthStep layout contract", () => {
  it("uses the shared welcome artwork on sign-in", () => {
    const source = readFileSync(join(process.cwd(), "components/onboarding/AuthStep.tsx"), "utf8");
    expect(source).toContain("data-auth-illustration");
    expect(source).toContain("data-auth-content-block");
  });
  it("returns to the canonical onboarding parent instead of browser history", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/AuthStep.tsx"),
      "utf8",
    );

    expect(source).toContain("buildWelcomeRoute");
    expect(source).toContain("router.replace(");
    expect(source).not.toContain("router.back()");
  });

  it("canonicalizes the post-auth target before every navigation branch", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/AuthStep.tsx"),
      "utf8",
    );

    expect(source).toContain(
      "const explicitTargetPath = normalizeInternalRouteHref(",
    );
    expect(source).toContain("const targetPath = explicitTargetPath ?? ROUTES.HOME;");
    expect(source).toContain("redirectPath: explicitTargetPath ?? undefined,");
    expect(source).not.toContain("ROUTES.KAI_HOME;");
    expect(source).not.toContain("const fallbackPath = targetPath ||");
    expect(source).not.toContain(
      "lastResolvedNavigationPathRef.current || targetPath ||",
    );
  });

  it("keeps the reviewer fixture out of normal sign-in UI", () => {
    const source = readFileSync(
      join(process.cwd(), "components/onboarding/AuthStep.tsx"),
      "utf8",
    );

    expect(source).toContain(
      "const showReviewer = shouldAutoAuthenticateReviewer(nativeTestConfig) && nativeReviewerVisible;",
    );
    expect(source).not.toContain("isLocalReviewerSurface");
  });

  it("keeps the auth presentation responsive and recovery controls reachable", () => {
    const source = readFileSync(join(process.cwd(), "components/onboarding/AuthStep.tsx"), "utf8");
    const css = readFileSync(join(process.cwd(), "components/onboarding/AuthStepLight.module.css"), "utf8");

    expect(source).toContain('from "./AuthStepLight.module.css"');
    expect(source).not.toContain('from "./AuthStep.module.css"');
    expect(css).not.toContain("scale(");
    expect(css).toContain("overflow-y: auto");
    expect(css).toMatch(/min-width:\s*800px/);
    expect(css).toContain("grid-template-columns");
    expect(source).toContain('providerAttempt?.phase === "attention_required"');
    expect(source).toContain("disabled={providerBusy}");
    expect(source).toContain("data-auth-provider-actions");
    expect(source).toContain("data-auth-supporting-content");
  });

  it("keeps the legal footer and links in the auth flow", () => {
    const source = readFileSync(join(process.cwd(), "components/onboarding/AuthStep.tsx"), "utf8");
    expect(source).toContain("className={lightStyles.footer}");
    expect(source).toContain('data-voice-control-id="auth_terms"');
    expect(source).toContain('data-voice-control-id="auth_privacy"');
  });

  it("links Terms and Privacy to their full pages instead of opening a popup", () => {
    const source = readFileSync(join(process.cwd(), "components/onboarding/AuthStep.tsx"), "utf8");

    // Same-tab navigation through next/link: the pre-auth screen holds no
    // state worth keeping, Back returns to sign-in, and in the native static
    // export the route is bundled so the link never leaves the app.
    expect(source).toContain('import Link from "next/link";');
    expect(source).toMatch(/<Link\s+href=\{ROUTES\.TERMS\}\s+data-voice-control-id="auth_terms"/);
    expect(source).toMatch(/<Link\s+href=\{ROUTES\.PRIVACY\}\s+data-voice-control-id="auth_privacy"/);
    expect(source).not.toContain('target="_blank"');
    // Voice takes the same route as a tap.
    expect(source).toContain("router.push(ROUTES.TERMS)");
    expect(source).toContain("router.push(ROUTES.PRIVACY)");

    // No inline legal document: no dialog, no sheet, no overlay to close.
    expect(source).not.toContain("AuthLegalDialog");
    expect(source).not.toContain("openLegalDoc");
    expect(source).not.toContain("activeLegalDoc");
    expect(source).not.toContain("auth.close_legal");
    expect(source).not.toContain("legal_document");
  });
});
