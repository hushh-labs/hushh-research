import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  useAuth: vi.fn(),
  usePersonaState: vi.fn(),
  refresh: vi.fn(),
  switchPersona: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  riaService: { deleteProfile: vi.fn(), updateProfile: vi.fn() },
  openKaiCommandBar: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush, replace: mocks.routerReplace }),
}));

vi.mock("lucide-react", () => ({
  ArrowRight: () => <span />,
  Loader2: () => <span />,
  RotateCcw: () => <span />,
  Trash2: () => <span />,
}));

vi.mock("@/components/ria/ria-page-shell", () => ({
  RiaPageShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="ria-page-shell">{children}</div>
  ),
  RiaCompatibilityState: () => <div data-testid="ria-compat" />,
}));

vi.mock("@/components/ria/onboarding/onboarding-step-review", () => ({
  OnboardingStepReview: () => <div data-testid="step-review" />,
}));

vi.mock("@/components/ria/onboarding/onboarding-step-services", () => ({
  OnboardingStepServices: () => <div data-testid="step-services" />,
}));

vi.mock("@/components/app-ui/settings-ui", () => ({
  SettingsDetailPanel: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div data-testid="edit-panel">{children}</div> : null),
  SettingsGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="manage-group">{children}</div>
  ),
  SettingsRow: ({
    title,
    onClick,
    disabled,
    testId,
  }: {
    title: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    testId?: string;
  }) => (
    <button data-testid={testId} onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div data-testid="delete-dialog">{children}</div> : null),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button data-testid="delete-cancel">{children}</button>
  ),
  AlertDialogAction: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: (e: { preventDefault: () => void }) => void;
    disabled?: boolean;
  }) => (
    <button
      data-testid="delete-confirm"
      disabled={disabled}
      onClick={(e) => onClick?.(e)}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: mocks.useAuth }));
vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: mocks.usePersonaState,
}));
vi.mock("@/lib/services/ria-service", () => ({ RiaService: mocks.riaService }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: mocks.toast }));
vi.mock("@/lib/navigation/routes", () => ({
  ROUTES: { RIA_ONBOARDING: "/ria/onboarding", ONE_HOME: "/one" },
}));
vi.mock("@/lib/navigation/kai-command-bar-events", () => ({
  openKaiCommandBar: mocks.openKaiCommandBar,
}));

import RiaProfilePage from "@/app/ria/profile/page";

const VERIFIED_STATUS = {
  exists: true,
  advisory_status: "verified",
  verification_status: "verified",
  display_name: "Andrew Kirkland",
  individual_crd: "7413463",
  services_offered: ["Portfolio Management"],
  fee_structure: ["Hourly"],
};

describe("RiaProfilePage manage actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAuth.mockReturnValue({
      user: { uid: "u1", getIdToken: vi.fn().mockResolvedValue("tok") },
    });
    mocks.usePersonaState.mockReturnValue({
      riaOnboardingStatus: VERIFIED_STATUS,
      riaCapability: "switch",
      loading: false,
      refreshing: false,
      refresh: mocks.refresh,
      switchPersona: mocks.switchPersona,
    });
    mocks.refresh.mockResolvedValue(undefined);
    mocks.switchPersona.mockResolvedValue(null);
    mocks.riaService.deleteProfile.mockResolvedValue({
      deleted: true,
      remaining_personas: ["investor"],
    });
  });

  it("renders the Manage group with re-initiate and delete rows", async () => {
    render(<RiaProfilePage />);
    await waitFor(() => {
      expect(screen.getByTestId("ria-profile-reinitiate")).toBeTruthy();
      expect(screen.getByTestId("ria-profile-delete")).toBeTruthy();
    });
  });

  it("re-initiate routes to the onboarding wizard with ?reinitiate=1", async () => {
    render(<RiaProfilePage />);
    await waitFor(() =>
      expect(screen.getByTestId("ria-profile-reinitiate")).toBeTruthy(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("ria-profile-reinitiate"));
    });
    expect(mocks.routerPush).toHaveBeenCalledWith(
      "/ria/onboarding?reinitiate=1",
    );
  });

  it("delete confirms, calls deleteProfile, switches persona, and routes to One", async () => {
    render(<RiaProfilePage />);
    await waitFor(() =>
      expect(screen.getByTestId("ria-profile-delete")).toBeTruthy(),
    );
    // Confirm dialog is not shown until the destructive row is tapped.
    expect(screen.queryByTestId("delete-dialog")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("ria-profile-delete"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("delete-dialog")).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("delete-confirm"));
    });

    await waitFor(() => {
      expect(mocks.riaService.deleteProfile).toHaveBeenCalledWith("tok");
      expect(mocks.switchPersona).toHaveBeenCalledWith("investor");
      expect(mocks.routerReplace).toHaveBeenCalledWith("/one");
    });
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
});
