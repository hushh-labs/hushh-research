import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuthStep } from "@/components/onboarding/AuthStep";
import { ROUTES } from "@/lib/navigation/routes";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

vi.mock("firebase/auth", () => ({
  getRedirectResult: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/lib/firebase/config", () => ({
  auth: {},
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    setNativeUser: vi.fn(),
  }),
}));

vi.mock("@/lib/progress/step-progress-context", () => ({
  useStepProgress: () => ({
    registerSteps: vi.fn(),
    completeStep: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getAppReviewModeConfig: vi.fn(() => Promise.resolve({ enabled: false })),
    createAppReviewModeSession: vi.fn(),
  },
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    signInWithApple: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithCustomToken: vi.fn(),
    signInWithEmailAndPassword: vi.fn(),
  },
}));

vi.mock("@/lib/services/post-auth-route-service", () => ({
  PostAuthRouteService: {
    resolveAfterLogin: vi.fn(),
  },
}));

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    syncCurrentUser: vi.fn(),
    hasVerifiedPhone: vi.fn(),
  },
}));

vi.mock("@/lib/capacitor/platform", () => ({
  isAndroid: () => false,
}));

vi.mock("@/lib/testing/native-test", () => ({
  getNativeTestConfig: () => ({
    enabled: false,
    autoReviewerLogin: false,
    expectedRoute: null,
    expectedUserId: null,
    vaultPassphrase: null,
  }),
  useNativeTestConfig: () => ({
    enabled: false,
    autoReviewerLogin: false,
    expectedRoute: null,
    expectedUserId: null,
    vaultPassphrase: null,
  }),
}));

vi.mock("@/lib/testing/local-reviewer-auth", () => ({
  resolveLocalReviewerCredentials: () => null,
}));

vi.mock("@/lib/observability/client", () => ({
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/observability/growth", () => ({
  resolveGrowthEntrySurface: () => null,
  resolveGrowthJourneyForPath: () => null,
  trackGrowthFunnelStepCompleted: vi.fn(),
}));

vi.mock("@/lib/services/onboarding-route-cookie", () => ({
  isOnboardingFlowActiveCookieEnabled: () => false,
  setOnboardingFlowActiveCookie: vi.fn(),
  setOnboardingRequiredCookie: vi.fn(),
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: {
    error: vi.fn(),
  },
}));

vi.mock("@/components/app-ui/native-test-beacon", () => ({
  NativeTestBeacon: () => null,
}));

vi.mock("@/components/onboarding/AuthLegalDialog", () => ({
  AuthLegalDialog: () => null,
}));

describe("AuthStep", () => {
  it("covers onboarding heading semantics", () => {
    render(<AuthStep redirectPath={ROUTES.KAI_HOME} compact />);

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Sign in to One",
    });

    expect(heading).toBeTruthy();
    expect(heading.getAttribute("aria-level")).toBe("1");
  });
});
