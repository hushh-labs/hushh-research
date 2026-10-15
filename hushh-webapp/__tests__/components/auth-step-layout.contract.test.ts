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
    router: { push: vi.fn(), replace: vi.fn() },
    progress: { registerSteps: vi.fn(), completeStep: vi.fn(), reset: vi.fn() },
    native: { enabled: false, autoReviewerLogin: false },
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
} }));
vi.mock("@/lib/services/initial-contacts-onboarding-service", () => ({ InitialContactsOnboardingService: { begin: settlement.contacts } }));
vi.mock("@/lib/services/legal-acceptance-service", () => ({ LegalAcceptanceService: { recordSignInAcceptance: settlement.legal } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {
  getAppReviewModeConfig: async () => ({ enabled: false }), notifyFirstWelcome: settlement.notify,
} }));
vi.mock("@/lib/services/post-auth-route-service", () => ({ PostAuthRouteService: { resolveAfterLogin: settlement.route } }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({ PreVaultUserStateService: { syncOnboardingJourney: async () => undefined } }));
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
vi.mock("@/components/app-ui/native-test-beacon", () => ({ NativeTestBeacon: () => null }));
vi.mock("@/components/onboarding/EnterpriseSsoSection", () => ({ EnterpriseSsoSection: () => null }));
vi.mock("@/components/onboarding/AuthProviderButton", () => ({
  AuthProviderButton: (props: { label: string; onClick: () => void; disabled?: boolean }) =>
    createElement("button", { onClick: props.onClick, disabled: props.disabled }, props.label),
}));

describe("AuthStep committed provider settlement", () => {
  beforeEach(() => { vi.clearAllMocks(); settlement.currentUser = null; });
  afterEach(cleanup);

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
      expect(settlement.legal).toHaveBeenCalledExactlyOnceWith(user);
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
      "const showReviewer = nativeTestConfig.enabled && nativeReviewerVisible;",
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
