import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    getRiaPublicProfile: vi.fn(),
    verifyOnboardingName: vi.fn(),
    submitOnboarding: vi.fn(),
    activateDevRia: vi.fn(),
    setRiaMarketplaceDiscoverability: vi.fn(),
  },
  draftService: {
    load: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
  },
  refreshPersonaState: vi.fn(),
  trackEvent: vi.fn(),
  trackGrowthFunnelStepCompleted: vi.fn(),
  trackRiaActivationCompleted: vi.fn(),
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
  ShieldQuestion: () => <span />,
}));

vi.mock("@/components/app-ui/command-fields", () => ({
  PopupTextEditorField: ({
    value,
    placeholder,
    onSave,
  }: {
    value: string;
    placeholder?: string;
    onSave: (value: string) => void;
  }) => (
    <textarea
      value={value}
      placeholder={placeholder}
      onChange={(event) => onSave(event.target.value)}
    />
  ),
}));

vi.mock("@/components/app-ui/surfaces", () => ({
  SurfaceCard: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  SurfaceCardContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  SurfaceCardHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  SurfaceInset: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}));

vi.mock("@/components/profile/settings-ui", () => ({
  SettingsGroup: ({
    title,
    children,
  }: {
    title: string;
    children: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
  }: {
    title: string;
    description?: string;
  }) => (
    <div>
      <span>{title}</span>
      <span>{description}</span>
    </div>
  ),
}));

vi.mock("@/components/ui/progress", () => ({
  Progress: ({ value }: { value?: number }) => <div data-testid="progress" data-value={value} />,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ria/ria-page-shell", () => ({
  RiaPageShell: ({
    title,
    description,
    children,
  }: {
    title: string;
    description: string;
    children: React.ReactNode;
  }) => (
    <section>
      <h1>{title}</h1>
      <p>{description}</p>
      {children}
    </section>
  ),
  RiaCompatibilityState: ({
    title,
    description,
  }: {
    title: string;
    description: string;
  }) => (
    <div>
      <span>{title}</span>
      <span>{description}</span>
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
  ROUTES: {
    RIA_HOME: "/ria",
    RIA_CLIENTS: "/ria/clients",
  },
}));

vi.mock("@/lib/services/ria-onboarding-draft-local-service", () => ({
  RiaOnboardingDraftLocalService: mocks.draftService,
}));

vi.mock("@/lib/services/ria-service", () => ({
  RiaService: mocks.riaService,
  isIAMSchemaNotReadyError: () => false,
}));

vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: mocks.usePersonaState,
}));

vi.mock("@/lib/observability/client", () => ({
  trackEvent: mocks.trackEvent,
}));

vi.mock("@/lib/observability/growth", () => ({
  trackGrowthFunnelStepCompleted: mocks.trackGrowthFunnelStepCompleted,
  trackRiaActivationCompleted: mocks.trackRiaActivationCompleted,
}));

import RiaOnboardingPage from "@/app/ria/onboarding/page";

describe("RiaOnboardingPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.useAuth.mockReturnValue({
      user: {
        uid: "user-ria-1",
        displayName: "Ana Carter",
        email: "ana@example.com",
        getIdToken: vi.fn().mockResolvedValue("token-ria-1"),
      },
    });
    mocks.usePersonaState.mockReturnValue({
      devRiaBypassAllowed: false,
      refresh: mocks.refreshPersonaState,
    });
    mocks.draftService.load.mockResolvedValue(null);
    mocks.draftService.save.mockResolvedValue(undefined);
    mocks.draftService.clear.mockResolvedValue(undefined);
    mocks.riaService.getOnboardingStatus.mockResolvedValue({
      exists: false,
      verification_status: "draft",
      requested_capabilities: ["advisory"],
    });
    mocks.riaService.getRiaPublicProfile.mockResolvedValue(null);
    mocks.riaService.setRiaMarketplaceDiscoverability.mockResolvedValue(undefined);
  });

  it("only verifies on explicit CTA and autofills read-only verified fields", async () => {
    mocks.riaService.verifyOnboardingName.mockResolvedValue({
      status: "verified",
      matched_name: "Ana Roumenova Carter",
      crd_number: "4424794",
      current_firm: "LCG CAPITAL ADVISORS, LLC",
      sec_number: "801-12345",
      provider: "ria_intelligence_stage1",
      suggested_names: [],
    });

    render(<RiaOnboardingPage />);

    const input = await screen.findByLabelText("Advisor name");
    const continueButton = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    const verifyButton = screen.getByRole("button", { name: "Verify" }) as HTMLButtonElement;

    expect(continueButton.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Use manual CRD fallback" })).toBeNull();

    fireEvent.change(input, { target: { value: "Ana Roumenova Carter" } });
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(mocks.riaService.verifyOnboardingName).not.toHaveBeenCalled();

    fireEvent.click(verifyButton);

    await waitFor(() =>
      expect(mocks.riaService.verifyOnboardingName).toHaveBeenCalledWith(
        "token-ria-1",
        { query: "Ana Roumenova Carter" },
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    );
    expect(mocks.riaService.verifyOnboardingName).toHaveBeenCalledTimes(1);

    await screen.findByText("Verified name");
    expect(screen.getByText("4424794")).toBeTruthy();
    expect(screen.getByText("LCG CAPITAL ADVISORS, LLC")).toBeTruthy();
    expect(screen.getByText("801-12345")).toBeTruthy();
    expect(continueButton.disabled).toBe(false);

    fireEvent.change(input, { target: { value: "Ana Carter" } });

    await waitFor(() => {
      expect(screen.queryByText("Verified name")).toBeNull();
    });
    expect(continueButton.disabled).toBe(true);
  });

  it("supports Enter-to-verify and blocks continue after a failed lookup", async () => {
    mocks.riaService.verifyOnboardingName.mockResolvedValue({
      status: "not_verified",
      matched_name: "Ana Carter",
      crd_number: null,
      current_firm: null,
      sec_number: null,
      reason: "No confident FINRA or SEC match was found for the query.",
      provider: "ria_intelligence_stage1",
      suggested_names: ["Ana Roumenova Carter"],
    });

    render(<RiaOnboardingPage />);

    const input = await screen.findByLabelText("Advisor name");
    const continueButton = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "Ana Carter" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(mocks.riaService.verifyOnboardingName).toHaveBeenCalledTimes(1);
    });

    await screen.findByRole("button", { name: "Retry verification" });
    // No manual fallback — strict gate: must verify via API
    expect(screen.queryByRole("button", { name: "Use manual CRD fallback" })).toBeNull();
    expect(continueButton.disabled).toBe(true);
  });

  it("guides broad partial-name queries toward fuller suggestions without opening fallback", async () => {
    mocks.riaService.verifyOnboardingName
      .mockResolvedValueOnce({
        status: "not_verified",
        matched_name: null,
        crd_number: null,
        current_firm: null,
        sec_number: null,
        reason:
          "The query 'Andrew G' is too broad and lacks a full last name or firm context, making it impossible to confidently identify a single registered financial professional or firm in FINRA or SEC public records.",
        reason_code: "query_too_broad",
        provider: "ria_intelligence_stage1",
        suggested_names: ["Andrew Garrett Kirkland"],
      })
      .mockResolvedValueOnce({
        status: "verified",
        matched_name: "Andrew Garrett Kirkland",
        crd_number: "7413463",
        current_firm: "Eissman Wealth Management",
        sec_number: null,
        provider: "ria_intelligence_stage1",
        suggested_names: [],
      });

    render(<RiaOnboardingPage />);

    const input = await screen.findByLabelText("Advisor name");
    const continueButton = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "Andrew G" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await screen.findByText(/more specific advisor name/i);
    expect(screen.getByText(/Try the advisor's full legal name/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Andrew Garrett Kirkland" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use manual CRD fallback" })).toBeNull();
    expect(continueButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Andrew Garrett Kirkland" }));

    await waitFor(() => {
      expect(mocks.riaService.verifyOnboardingName).toHaveBeenNthCalledWith(
        2,
        "token-ria-1",
        { query: "Andrew Garrett Kirkland" },
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    await screen.findByText("Verified name");
    expect(screen.getByDisplayValue("Andrew Garrett Kirkland")).toBeTruthy();
    expect(continueButton.disabled).toBe(false);
  });

});
