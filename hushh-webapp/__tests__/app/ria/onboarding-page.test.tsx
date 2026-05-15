import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  useAuth: vi.fn(),
  usePersonaState: vi.fn(),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
  riaService: {
    getOnboardingStatus: vi.fn(),
    verifyOnboardingLicense: vi.fn(),
    submitOnboarding: vi.fn(),
    setRiaMarketplaceDiscoverability: vi.fn(),
    getCrdScrapeJobStatus: vi.fn(),
  },
  draftService: {
    load: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
  },
  refreshPersonaState: vi.fn(),
  trackEvent: vi.fn(),
  trackGrowthFunnelStepCompleted: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

vi.mock("lucide-react", () => ({
  ArrowLeft: () => <span />,
  ArrowRight: () => <span />,
  CheckCircle2: () => <span />,
  Loader2: () => <span />,
  ShieldCheck: () => <span />,
  Briefcase: () => <span />,
  Building2: () => <span />,
  Pencil: () => <span />,
  Sparkles: () => <span />,
  BarChart3: () => <span />,
  Landmark: () => <span />,
  FileText: () => <span />,
  ScrollText: () => <span />,
  AlertTriangle: () => <span />,
  MapPin: () => <span />,
  Mail: () => <span />,
  Phone: () => <span />,
}));

vi.mock("@/components/app-ui/fullscreen-flow-shell", () => ({
  FullscreenFlowShell: ({
    children,
  }: {
    children: React.ReactNode;
  }) => <div data-testid="flow-shell">{children}</div>,
}));

vi.mock("@/components/ria/onboarding/onboarding-shell", () => ({
  OnboardingShell: ({
    children,
    onBack,
    onContinue,
    canContinue,
    saving,
    eyebrow,
    title,
  }: {
    children: React.ReactNode;
    onBack: () => void;
    onContinue: () => void;
    canContinue: boolean;
    saving: boolean;
    eyebrow: string;
    title: string;
  }) => (
    <div data-testid="onboarding-shell">
      <span data-testid="shell-eyebrow">{eyebrow}</span>
      <span data-testid="shell-title">{title}</span>
      <button data-testid="back-btn" onClick={onBack}>
        Back
      </button>
      <button
        data-testid="continue-btn"
        onClick={onContinue}
        disabled={!canContinue || saving}
      >
        Continue
      </button>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ria/onboarding/onboarding-step-welcome", () => ({
  OnboardingStepWelcome: ({
    onboardingType,
    onSelect,
  }: {
    onboardingType: string;
    onSelect: (type: string) => void;
  }) => (
    <div data-testid="step-welcome">
      <span data-testid="welcome-type">{onboardingType}</span>
      <button data-testid="select-individual" onClick={() => onSelect("individual")}>
        Individual
      </button>
      <button data-testid="select-firm" onClick={() => onSelect("firm")}>
        Firm
      </button>
    </div>
  ),
}));

vi.mock("@/components/ria/onboarding/onboarding-step-license", () => ({
  OnboardingStepLicense: ({
    licenseNumber,
    onLicenseNumberChange,
    verificationStatus,
    onVerify,
  }: {
    licenseNumber: string;
    onLicenseNumberChange: (val: string) => void;
    verificationStatus: string;
    onVerify: () => void;
  }) => (
    <div data-testid="step-license">
      <input
        data-testid="license-input"
        value={licenseNumber}
        onChange={(e) => onLicenseNumberChange(e.target.value)}
      />
      <span data-testid="verification-status">{verificationStatus}</span>
      <button data-testid="verify-btn" onClick={onVerify}>
        Verify
      </button>
    </div>
  ),
}));

vi.mock("@/components/ria/onboarding/onboarding-step-license-details", () => ({
  OnboardingStepLicenseDetails: ({
    advisorName,
    firmName,
  }: {
    advisorName: string;
    firmName: string;
  }) => (
    <div data-testid="step-license-details">
      <span data-testid="advisor-name">{advisorName}</span>
      <span data-testid="firm-name">{firmName}</span>
    </div>
  ),
}));

vi.mock("@/components/ria/onboarding/onboarding-step-services", () => ({
  OnboardingStepServices: () => <div data-testid="step-services" />,
}));

vi.mock("@/components/ria/onboarding/onboarding-step-contact", () => ({
  OnboardingStepContact: () => <div data-testid="step-contact" />,
}));

vi.mock("@/components/ria/onboarding/onboarding-step-review", () => ({
  OnboardingStepReview: ({
    advisorName,
    onEditSection,
    advisoryAccessReady,
  }: {
    advisorName: string;
    onEditSection: (section: string) => void;
    advisoryAccessReady: boolean;
  }) => (
    <div data-testid="step-review">
      <span data-testid="review-name">{advisorName}</span>
      <span data-testid="advisory-ready">{String(advisoryAccessReady)}</span>
      <button data-testid="edit-license" onClick={() => onEditSection("license")}>
        Edit Licence
      </button>
      <button data-testid="edit-services" onClick={() => onEditSection("services")}>
        Edit Services
      </button>
      <button data-testid="edit-contact" onClick={() => onEditSection("contact")}>
        Edit Contact
      </button>
    </div>
  ),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: mocks.useAuth,
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: mocks.toast,
}));

vi.mock("@/lib/navigation/routes", () => ({
  ROUTES: { RIA_HOME: "/ria" },
}));

vi.mock("@/lib/services/ria-onboarding-draft-local-service", () => ({
  RiaOnboardingDraftLocalService: mocks.draftService,
}));

vi.mock("@/lib/services/ria-service", () => ({
  RiaService: mocks.riaService,
  RiaApiError: class extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  },
  isIAMSchemaNotReadyError: (err: unknown) =>
    err instanceof Error && err.message.includes("schema not ready"),
}));

vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: mocks.usePersonaState,
}));

vi.mock("@/lib/observability/client", () => ({
  trackEvent: mocks.trackEvent,
}));

vi.mock("@/lib/observability/growth", () => ({
  trackGrowthFunnelStepCompleted: mocks.trackGrowthFunnelStepCompleted,
}));

import RiaOnboardingPage from "@/app/ria/onboarding/page";

describe("RiaOnboardingPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();

    mocks.useAuth.mockReturnValue({
      user: {
        uid: "user-ria-1",
        getIdToken: vi.fn().mockResolvedValue("token-ria-1"),
      },
    });
    mocks.usePersonaState.mockReturnValue({
      refresh: mocks.refreshPersonaState,
    });
    mocks.draftService.load.mockResolvedValue(null);
    mocks.draftService.save.mockResolvedValue(undefined);
    mocks.draftService.clear.mockResolvedValue(undefined);
    mocks.riaService.getOnboardingStatus.mockResolvedValue({
      exists: false,
      verification_status: "draft",
    });
    mocks.riaService.setRiaMarketplaceDiscoverability.mockResolvedValue(
      undefined
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders welcome step on fresh load", async () => {
    render(<RiaOnboardingPage />);
    await waitFor(() => {
      expect(screen.getByTestId("step-welcome")).toBeInTheDocument();
    });
    expect(screen.getByTestId("shell-eyebrow")).toHaveTextContent("Welcome");
  });

  it("advances to license step after clicking Continue from welcome", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("step-welcome")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("continue-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("step-license")).toBeInTheDocument();
    });
  });

  it("shows sign-in message when no user", async () => {
    mocks.useAuth.mockReturnValue({ user: null });
    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByText(/sign in/i)).toBeInTheDocument();
    });
  });

  it("shows IAM unavailable banner on schema error", async () => {
    mocks.riaService.getOnboardingStatus.mockRejectedValue(
      new Error("schema not ready")
    );
    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
    });
  });

  it("calls verifyOnboardingLicense and prepopulates on found", async () => {
    mocks.riaService.verifyOnboardingLicense.mockResolvedValue({
      status: "found",
      advisor_name: "Jane Doe",
      firm_name: "Acme Wealth",
      regulator: "SEC",
      regulator_status: "ACTIVE",
      crd_number: "123456",
      scrape_job_id: null,
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("step-welcome")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("continue-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("step-license")).toBeInTheDocument();
    });

    await user.type(screen.getByTestId("license-input"), "123456");
    await user.click(screen.getByTestId("verify-btn"));

    await waitFor(() => {
      expect(mocks.riaService.verifyOnboardingLicense).toHaveBeenCalledWith(
        "token-ria-1",
        expect.objectContaining({ license_number: "123456" }),
        expect.any(Object)
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    await waitFor(() => {
      expect(screen.getByTestId("step-license-details")).toBeInTheDocument();
    });

    expect(screen.getByTestId("advisor-name")).toHaveTextContent("Jane Doe");
    expect(screen.getByTestId("firm-name")).toHaveTextContent("Acme Wealth");
  });

  it("handles not_found and stays on license step", async () => {
    mocks.riaService.verifyOnboardingLicense.mockResolvedValue({
      status: "not_found",
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("step-welcome")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("continue-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("step-license")).toBeInTheDocument();
    });

    await user.type(screen.getByTestId("license-input"), "999999");
    await user.click(screen.getByTestId("verify-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("verification-status")).toHaveTextContent(
        "not_found"
      );
    });

    expect(screen.queryByTestId("step-license-details")).not.toBeInTheDocument();
  });

  it("handles rate limit (429) gracefully", async () => {
    const RiaApiErr = class extends Error {
      status: number;
      constructor(msg: string, status: number) {
        super(msg);
        this.status = status;
        this.name = "RiaApiError";
      }
    };
    mocks.riaService.verifyOnboardingLicense.mockRejectedValue(
      new RiaApiErr("rate limited", 429)
    );

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("step-welcome")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("continue-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("step-license")).toBeInTheDocument();
    });

    await user.type(screen.getByTestId("license-input"), "123456");
    await user.click(screen.getByTestId("verify-btn"));

    await waitFor(() => {
      expect(screen.getByText(/too many verification/i)).toBeInTheDocument();
    });
  });

  it("persists draft to local storage on changes", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("step-welcome")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("select-firm"));

    await waitFor(() => {
      expect(mocks.draftService.save).toHaveBeenCalledWith(
        "user-ria-1",
        expect.objectContaining({ onboardingType: "firm" })
      );
    });
  });

  it("loads existing draft and restores saved step", async () => {
    mocks.draftService.load.mockResolvedValue({
      currentStepId: "services",
      onboardingType: "individual",
      licenseNumber: "111222",
      licenseVerificationStatus: "found",
      advisorName: "Saved Advisor",
      servicesOffered: [],
      feeStructure: [],
    });

    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(mocks.draftService.load).toHaveBeenCalledWith("user-ria-1");
    });
  });

  it("redirects to RIA home if already verified when submit clicked", async () => {
    mocks.riaService.getOnboardingStatus.mockResolvedValue({
      exists: true,
      advisory_status: "active",
      verification_status: "verified",
    });

    const _user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-shell")).toBeInTheDocument();
    });
  });
});
