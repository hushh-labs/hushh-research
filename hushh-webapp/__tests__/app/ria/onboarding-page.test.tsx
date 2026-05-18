import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MockRiaApiError = vi.hoisted(() => {
  return class extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  };
});

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
  FullscreenFlowShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="flow-shell">{children}</div>
  ),
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
      <button
        data-testid="select-individual"
        onClick={() => onSelect("individual")}
      >
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
    certifications,
    city,
    pinZip,
  }: {
    advisorName: string;
    firmName: string;
    certifications: string[];
    city: string;
    pinZip: string;
  }) => (
    <div data-testid="step-license-details">
      <span data-testid="advisor-name">{advisorName}</span>
      <span data-testid="firm-name">{firmName}</span>
      {certifications.map((certification) => (
        <span key={certification} data-testid="certification">
          {certification}
        </span>
      ))}
      <span data-testid="city">{city}</span>
      <span data-testid="pin-zip">{pinZip}</span>
    </div>
  ),
}));

vi.mock("@/components/ria/onboarding/onboarding-step-services", () => ({
  OnboardingStepServices: ({
    city,
    areaLocality,
    fullStreetAddress,
    pinZip,
  }: {
    city: string;
    areaLocality: string;
    fullStreetAddress: string;
    pinZip: string;
  }) => (
    <div data-testid="step-services">
      <span data-testid="services-city">{city}</span>
      <span data-testid="services-area">{areaLocality}</span>
      <span data-testid="services-address">{fullStreetAddress}</span>
      <span data-testid="services-pin-zip">{pinZip}</span>
    </div>
  ),
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
      <button
        data-testid="edit-license"
        onClick={() => onEditSection("license")}
      >
        Edit Licence
      </button>
      <button
        data-testid="edit-services"
        onClick={() => onEditSection("services")}
      >
        Edit Services
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
  RiaApiError: MockRiaApiError,
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
    vi.clearAllMocks();

    mocks.useAuth.mockReturnValue({
      user: {
        uid: "user-ria-1",
        email: "ria-user@example.com",
        phoneNumber: "+16505550101",
        getIdToken: vi.fn().mockResolvedValue("token-ria-1"),
      },
      phoneNumber: "+16505550101",
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
      undefined,
    );
  });

  it("renders welcome step on fresh load", async () => {
    render(<RiaOnboardingPage />);
    await waitFor(() => {
      expect(screen.getByTestId("step-welcome")).toBeTruthy();
    });
    expect(screen.getByTestId("shell-eyebrow").textContent).toBe("Welcome");
  });

  it("advances to license step after clicking Continue from welcome", async () => {
    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("step-welcome")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("select-individual"));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("continue-btn"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("step-license")).toBeTruthy();
    });
  });

  it("shows sign-in message when no user", async () => {
    mocks.useAuth.mockReturnValue({ user: null });
    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByText(/sign in/i)).toBeTruthy();
    });
  });

  it("shows IAM unavailable banner on schema error", async () => {
    mocks.riaService.getOnboardingStatus.mockRejectedValue(
      new Error("schema not ready"),
    );
    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByText(/unavailable/i)).toBeTruthy();
    });
  });

  it("calls verifyOnboardingLicense and prepopulates on found", async () => {
    mocks.riaService.verifyOnboardingLicense.mockResolvedValue({
      status: "found",
      advisor_name: "Jane Doe",
      firm_name: "Acme Wealth",
      regulator: "SEC",
      regulator_status: "ACTIVE",
      certifications: [],
      crd_number: "123456",
      city: "Kennesaw",
      pin_zip: "30144",
      exams_passed: ["Series 66", "SIE"],
      scrape_job_id: null,
    });

    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("step-welcome")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("select-individual"));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("continue-btn"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("step-license")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId("license-input"), {
        target: { value: "123456" },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("verify-btn"));
    });

    await waitFor(() => {
      expect(mocks.riaService.verifyOnboardingLicense).toHaveBeenCalledWith(
        "token-ria-1",
        expect.objectContaining({ license_number: "123456" }),
        expect.any(Object),
      );
    });

    await waitFor(
      () => {
        expect(screen.getByTestId("step-license-details")).toBeTruthy();
      },
      { timeout: 3000 },
    );

    expect(screen.getByTestId("advisor-name").textContent).toBe("Jane Doe");
    expect(screen.getByTestId("firm-name").textContent).toBe("Acme Wealth");
    expect(
      screen.getAllByTestId("certification").map((item) => item.textContent),
    ).toEqual(["Series 66", "SIE"]);
    expect(screen.getByTestId("city").textContent).toBe("Kennesaw");
    expect(screen.getByTestId("pin-zip").textContent).toBe("30144");
  });

  it("clears stale regulator fields before applying a fresh verification result", async () => {
    mocks.draftService.load.mockResolvedValue({
      currentStepId: "license_number",
      onboardingType: "individual",
      licenseNumber: "7413463",
      licenseVerificationStatus: "error",
      advisorName: "Old Advisor",
      firmName: "Old Firm",
      city: "Pune",
      areaLocality: "Downtown, Mission District",
      pinZip: "30144",
      fullStreetAddress: "Army Institute of Technology, Pune",
      bio: "Old stale bio",
      servicesOffered: ["Portfolio Management"],
      feeStructure: ["Fee-only"],
    });
    mocks.riaService.verifyOnboardingLicense.mockResolvedValue({
      status: "found",
      advisor_name: "Andrew Garrett Kirkland",
      firm_name: "Eissman Wealth Management",
      regulator: "SEC",
      regulator_status: "Active (Investment Adviser Representative)",
      certifications: ["Series 66 - Uniform Combined State Law Examination"],
      crd_number: "7413463",
      city: "Kennesaw",
      state: "GA",
      area_locality: "GA",
      pin_zip: "30144",
      full_street_address: "114 Townpark Drive, Ste. 175",
      official_location: {
        city: "Kennesaw",
        state: "GA",
        pin_zip: "30144",
        address: "114 Townpark Drive, Ste. 175",
      },
      bio: "Investment professional at Eissman Wealth Management.",
      scrape_job_id: null,
    });

    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("step-license")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("verify-btn"));
    });

    await waitFor(
      () => {
        expect(screen.getByTestId("step-license-details")).toBeTruthy();
      },
      { timeout: 3000 },
    );

    expect(screen.getByTestId("advisor-name").textContent).toBe(
      "Andrew Garrett Kirkland",
    );
    expect(screen.getByTestId("city").textContent).toBe("Kennesaw");
    expect(screen.getByTestId("pin-zip").textContent).toBe("30144");

    await act(async () => {
      fireEvent.click(screen.getByTestId("continue-btn"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("step-services")).toBeTruthy();
    });

    expect(screen.getByTestId("services-city").textContent).toBe("Kennesaw");
    expect(screen.getByTestId("services-area").textContent).toBe("GA");
    expect(screen.getByTestId("services-address").textContent).toBe(
      "114 Townpark Drive, Ste. 175",
    );
    expect(screen.getByTestId("services-pin-zip").textContent).toBe("30144");
  });

  it("repairs stale verified draft location from the license API on load", async () => {
    mocks.draftService.load.mockResolvedValue({
      currentStepId: "license_details",
      onboardingType: "individual",
      licenseNumber: "7265726",
      regulator: "SEC",
      licenseVerificationStatus: "found",
      advisorName: "Ria A. Sen",
      firmName: "Not Currently Registered",
      regulatorStatus: "Not Currently Registered",
      certifications: ["SIE", "Series 79TO"],
      crdNumber: "7265726",
      city: "",
      areaLocality: "",
      pinZip: "",
      fullStreetAddress: "",
      servicesOffered: ["Portfolio Management"],
      feeStructure: ["Fee-only"],
    });
    mocks.riaService.verifyOnboardingLicense.mockResolvedValue({
      status: "found",
      advisor_name: "Ria Ashley Sen",
      firm_name: "Not Currently Registered",
      regulator: "SEC",
      regulator_status: "Not Currently Registered",
      certifications: ["SIE", "Series 79TO"],
      crd_number: "7265726",
      city: "New York",
      state: "NY",
      area_locality: "NY",
      pin_zip: "10020-5900",
      full_street_address: "30 ROCKEFELLER PLAZA",
      official_location: {
        city: "New York",
        state: "NY",
        pin_zip: "10020-5900",
        address: "30 ROCKEFELLER PLAZA",
      },
      scrape_job_id: null,
    });

    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("step-license-details")).toBeTruthy();
    });

    await waitFor(() => {
      expect(mocks.riaService.verifyOnboardingLicense).toHaveBeenCalledWith(
        "token-ria-1",
        expect.objectContaining({
          license_number: "7265726",
          regulator: "SEC",
        }),
        expect.any(Object),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("advisor-name").textContent).toBe(
        "Ria Ashley Sen",
      );
      expect(screen.getByTestId("city").textContent).toBe("New York");
      expect(screen.getByTestId("pin-zip").textContent).toBe("10020-5900");
    });
  });

  it("repairs conflicting verified draft location from the license API on load", async () => {
    mocks.draftService.load.mockResolvedValue({
      currentStepId: "services",
      onboardingType: "individual",
      licenseNumber: "7265726",
      regulator: "SEC",
      licenseVerificationStatus: "found",
      advisorName: "Ria A. Sen",
      firmName: "Not Currently Registered",
      regulatorStatus: "Not Currently Registered",
      certifications: ["SIE", "Series 79TO"],
      crdNumber: "7265726",
      city: "Pune",
      areaLocality: "Downtown, Mission District",
      pinZip: "30144",
      fullStreetAddress: "Army Institute of Technology, Pune",
      servicesOffered: ["Portfolio Management"],
      feeStructure: ["Fee-only"],
    });
    mocks.riaService.verifyOnboardingLicense.mockResolvedValue({
      status: "found",
      advisor_name: "Ria Ashley Sen",
      firm_name: "Not Currently Registered",
      regulator: "SEC",
      regulator_status: "Not Currently Registered",
      certifications: ["SIE", "Series 79TO"],
      crd_number: "7265726",
      city: "New York",
      state: "NY",
      area_locality: "NY",
      pin_zip: "10020-5900",
      full_street_address: "30 ROCKEFELLER PLAZA",
      official_location: {
        city: "New York",
        state: "NY",
        pin_zip: "10020-5900",
        address: "30 ROCKEFELLER PLAZA",
      },
      scrape_job_id: null,
    });

    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("step-services")).toBeTruthy();
    });

    await waitFor(() => {
      expect(mocks.riaService.verifyOnboardingLicense).toHaveBeenCalledWith(
        "token-ria-1",
        expect.objectContaining({
          license_number: "7265726",
          regulator: "SEC",
        }),
        expect.any(Object),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("services-city").textContent).toBe("New York");
      expect(screen.getByTestId("services-area").textContent).toBe("NY");
      expect(screen.getByTestId("services-address").textContent).toBe(
        "30 ROCKEFELLER PLAZA",
      );
      expect(screen.getByTestId("services-pin-zip").textContent).toBe(
        "10020-5900",
      );
    });
  });

  it("handles not_found and stays on license step", async () => {
    mocks.riaService.verifyOnboardingLicense.mockResolvedValue({
      status: "not_found",
    });

    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("step-welcome")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("select-individual"));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("continue-btn"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("step-license")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId("license-input"), {
        target: { value: "999999" },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("verify-btn"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("verification-status").textContent).toBe(
        "not_found",
      );
    });

    expect(screen.queryByTestId("step-license-details")).toBeNull();
  });

  it("handles rate limit (429) gracefully", async () => {
    mocks.riaService.verifyOnboardingLicense.mockRejectedValue(
      new MockRiaApiError("rate limited", 429),
    );

    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("step-welcome")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("select-individual"));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("continue-btn"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("step-license")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId("license-input"), {
        target: { value: "123456" },
      });
    });

    await waitFor(() => {
      expect(
        (screen.getByTestId("license-input") as HTMLInputElement).value,
      ).toBe("123456");
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("verify-btn"));
    });

    await waitFor(() => {
      expect(mocks.riaService.verifyOnboardingLicense).toHaveBeenCalledWith(
        "token-ria-1",
        expect.objectContaining({ license_number: "123456" }),
        expect.any(Object),
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/too many verification/i)).toBeTruthy();
    });
  });

  it("persists draft to local storage on changes", async () => {
    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("step-welcome")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("select-firm"));
    });

    await waitFor(() => {
      expect(mocks.draftService.save).toHaveBeenCalledWith(
        "user-ria-1",
        expect.objectContaining({ onboardingType: "firm" }),
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
      verifiedLicensePrefillKey: "auto:111222",
      servicesOffered: [],
      feeStructure: [],
    });

    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(mocks.draftService.load).toHaveBeenCalledWith("user-ria-1");
    });
  });

  it("does not force a second live verification after license verification", async () => {
    mocks.draftService.load.mockResolvedValue({
      currentStepId: "review",
      onboardingType: "individual",
      licenseNumber: "7265726",
      licenseVerificationStatus: "found",
      advisorName: "Ria Ashley Sen",
      firmName: "Not Currently Registered",
      regulator: "SEC",
      regulatorStatus: "ACTIVE",
      crdNumber: "7265726",
      individualCrd: "7265726",
      verifiedLicensePrefillKey: "sec:7265726",
      servicesOffered: ["Portfolio Management"],
      feeStructure: ["Fee-only"],
      contactEmail: "ria-e2e@example.invalid",
    });
    mocks.riaService.submitOnboarding.mockResolvedValue({
      requested_capabilities: ["advisory"],
      verification_status: "verified",
      advisory_status: "active",
      individual_legal_name: "Ria Ashley Sen",
      individual_crd: "7265726",
      advisory_firm_legal_name: "Not Currently Registered",
    });
    mocks.riaService.setRiaMarketplaceDiscoverability.mockResolvedValue({
      enabled: true,
    });

    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("step-review")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("continue-btn"));
    });

    await waitFor(() => {
      expect(mocks.riaService.submitOnboarding).toHaveBeenCalledWith(
        "token-ria-1",
        expect.objectContaining({
          license_number: "7265726",
          individual_crd: "7265726",
          force_live_verification: false,
        }),
      );
    });
  });

  it("redirects to RIA home if already verified when submit clicked", async () => {
    mocks.riaService.getOnboardingStatus.mockResolvedValue({
      exists: true,
      advisory_status: "active",
      verification_status: "verified",
    });

    render(<RiaOnboardingPage />);

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-shell")).toBeTruthy();
    });
  });
});
