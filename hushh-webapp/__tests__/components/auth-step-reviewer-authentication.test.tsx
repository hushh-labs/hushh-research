import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: { enabled: true, autoReviewerLogin: true, reviewerAuthMode: "human_authenticated", expectedUserId: "reviewer", vaultPassphrase: "synthetic-accidental", reviewerSessionPassphrase: "synthetic-accidental" },
  live: null as Record<string, unknown> | null,
  bridge: {} as { triggerReviewerLogin?: () => void },
  reviewerClick: null as (() => void) | null,
  mint: vi.fn(async () => ({ token: "synthetic-token" })),
  custom: vi.fn(async () => ({ user: null })),
  google: vi.fn(() => new Promise(() => {})),
  toast: vi.fn(),
  noop: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.noop, replace: state.noop }) }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/testing/native-test", () => ({
  useNativeTestConfig: () => state.config,
  getNativeTestConfig: () => state.live ?? state.config,
}));
vi.mock("@/lib/testing/local-reviewer-auth", () => ({ resolveLocalReviewerCredentials: () => null }));
vi.mock("@/lib/firebase/auth-context", () => ({ useAuth: () => ({
  user: null, loading: false, beginPostAuthSettlement: state.noop, completePostAuthSettlement: state.noop,
}) }));
vi.mock("@/lib/progress/step-progress-context", () => ({ useStepProgress: () => ({ registerSteps: state.noop, completeStep: state.noop, reset: state.noop }) }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { signInWithCustomToken: state.custom, signInWithGoogle: state.google } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { createAppReviewModeSession: state.mint, getAppReviewModeConfig: async () => ({ enabled: true }) } }));
vi.mock("@/lib/services/legal-acceptance-service", () => ({ LegalAcceptanceService: { recordSignInAcceptance: state.noop } }));
vi.mock("@/lib/services/post-auth-route-service", () => ({ PostAuthRouteService: {} }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({ PreVaultUserStateService: {} }));
vi.mock("@/lib/services/onboarding-route-cookie", () => ({ isOnboardingFlowActiveCookieEnabled: () => false, setOnboardingFlowActiveCookie: state.noop, setOnboardingRequiredCookie: state.noop }));
vi.mock("@/lib/capacitor/platform", () => ({ isAndroid: () => false, isWeb: () => true }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { error: state.toast } }));
vi.mock("@/lib/morphy-ux/ui", () => ({ Icon: () => null }));
vi.mock("@/lib/morphy-ux/ui/hushh-mark", () => ({ HushhMark: () => null }));
vi.mock("@/lib/observability/client", () => ({ trackEvent: state.noop }));
vi.mock("@/lib/observability/growth", () => ({ resolveGrowthEntrySurface: () => null, resolveGrowthJourneyForPath: () => null, trackGrowthFunnelStepCompleted: state.noop }));
vi.mock("@/lib/agent/local-onboarding-actions", () => ({ useLocalOnboardingActionHandler: state.noop }));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({ usePublishVoiceSurfaceMetadata: state.noop }));
vi.mock("@/components/onboarding/OnboardingHeroBackground", () => ({ OnboardingHeroBackground: () => null }));
vi.mock("@/components/app-ui/hushh-loader", () => ({ HushhLoader: () => null }));
vi.mock("@/components/auth/session-verification-recovery", () => ({ SessionVerificationRecovery: () => null }));
vi.mock("@/components/app-ui/native-test-beacon", () => ({ NativeTestBeacon: ({ attachToBridge }: { attachToBridge: (bridge: typeof state.bridge) => void }) => { attachToBridge(state.bridge); return null; } }));
vi.mock("@/components/onboarding/AuthProviderButton", () => ({ AuthProviderButton: ({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) => {
  if (label === "Continue as Reviewer") state.reviewerClick = onClick;
  return <button disabled={disabled} onClick={onClick}>{label}</button>;
} }));
import { AuthStep } from "@/components/onboarding/AuthStep";

describe("AuthStep human reviewer admission", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); state.live = null; state.bridge = {}; state.reviewerClick = null;
    state.config.reviewerAuthMode = "human_authenticated";
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("never auto-mints or reports a reviewer error during ordinary human sign-in", async () => {
    render(<AuthStep redirectPath="/one" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(state.mint).not.toHaveBeenCalled(); expect(state.custom).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
    expect(screen.queryByText("Continue as Reviewer")).toBeNull();
  });

  it("rejects the bridge trigger without entering reviewer authentication", async () => {
    render(<AuthStep redirectPath="/one" />);
    await act(async () => state.bridge.triggerReviewerLogin?.());
    expect(state.mint).not.toHaveBeenCalled(); expect(state.custom).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("rechecks live mode before a retained manual reviewer callback", async () => {
    state.config.reviewerAuthMode = "custom_token";
    render(<AuthStep redirectPath="/one" />);
    expect(state.reviewerClick).toBeTypeOf("function");
    state.live = { ...state.config, reviewerAuthMode: "human_authenticated" };
    await act(async () => state.reviewerClick?.());
    expect(state.mint).not.toHaveBeenCalled(); expect(state.custom).not.toHaveBeenCalled();
  });

  it("preserves legacy manual minting and the ordinary human Google flow", async () => {
    state.config.reviewerAuthMode = "custom_token";
    render(<AuthStep redirectPath="/one" />);
    await act(async () => state.reviewerClick?.());
    expect(state.mint).toHaveBeenCalledTimes(1); expect(state.custom).toHaveBeenCalledTimes(1);
    cleanup(); state.config.reviewerAuthMode = "human_authenticated";
    render(<AuthStep redirectPath="/one" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Continue with Google" })));
    expect(state.google).toHaveBeenCalledTimes(1);
  });
});
