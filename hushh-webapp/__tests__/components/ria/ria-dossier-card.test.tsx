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
  riaService: {
    deleteProfile: vi.fn(),
    updateProfile: vi.fn(),
    refreshLicenseProfile: vi.fn(),
    claimEmailStart: vi.fn(),
    claimEmailConfirm: vi.fn(),
    getDossier: vi.fn(),
    retryDossier: vi.fn(),
  },
  openKaiCommandBar: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush, replace: mocks.routerReplace }),
}));

vi.mock("lucide-react", () => ({
  ArrowRight: () => <span />,
  CheckCircle2: () => <span />,
  ClipboardCheck: () => <span />,
  ExternalLink: () => <span />,
  Loader2: () => <span />,
  MessageCircle: () => <span />,
  Pencil: () => <span />,
  RotateCcw: () => <span />,
  ShieldCheck: () => <span />,
  Trash2: () => <span />,
}));

vi.mock("@/components/ria/profile/ria-location-map", () => ({
  RiaLocationMap: () => <div data-testid="ria-location-map" />,
}));

vi.mock("@/components/ria/onboarding/onboarding-step-services", () => ({
  OnboardingStepServices: () => <div data-testid="step-services" />,
}));

vi.mock("@/components/ria/ria-page-shell", () => ({
  RiaCompatibilityState: () => <div data-testid="ria-compat" />,
  isRiaVerified: (status?: string | null) =>
    ["active", "verified", "finra_verified"].includes(
      String(status || "").toLowerCase(),
    ),
}));

vi.mock("@/components/research/prose-markdown", () => ({
  ProseMarkdown: ({ children }: { children: string }) => (
    <div data-testid="prose-markdown">{children}</div>
  ),
}));

vi.mock("@/components/app-ui/settings-ui", () => ({
  SettingsDetailPanel: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div data-testid="edit-panel">{children}</div> : null),
  SettingsGroup: ({
    children,
    testId = "manage-group",
  }: {
    children: React.ReactNode;
    testId?: string;
  }) => <div data-testid={testId}>{children}</div>,
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

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="license-dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
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
    <button>{children}</button>
  ),
  AlertDialogAction: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: { children: React.ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: mocks.useAuth }));
vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: mocks.usePersonaState,
}));
vi.mock("@/lib/services/ria-service", () => ({ RiaService: mocks.riaService }));
vi.mock("@/lib/services/ria-onboarding-draft-local-service", () => ({
  RiaOnboardingDraftLocalService: { clear: () => Promise.resolve() },
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onPersonaStateChanged: vi.fn() },
}));
vi.mock("@/lib/services/device-resource-cache-service", () => ({
  DeviceResourceCacheService: {
    invalidateResourcePrefix: () => Promise.resolve(),
  },
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: mocks.toast }));
vi.mock("@/lib/navigation/routes", () => ({
  ROUTES: { RIA_ONBOARDING: "/ria/onboarding", ONE_HOME: "/one" },
}));
vi.mock("@/lib/navigation/kai-command-bar-events", () => ({
  openKaiCommandBar: mocks.openKaiCommandBar,
}));

import { RiaProfileSection } from "@/components/ria/profile/ria-profile-section";

const BASE_STATUS = {
  exists: true,
  advisory_status: "verified",
  verification_status: "verified",
  display_name: "Andrew Kirkland",
  individual_crd: "7413463",
  services_offered: ["Portfolio Management"],
  fee_structure: ["Hourly"],
};

const DOSSIER_MARKDOWN = "# Dossier\n\nBuilt from your SEC record.";

function renderSection() {
  return render(
    <RiaProfileSection
      status={BASE_STATUS as never}
      loading={false}
      onRefresh={vi.fn()}
    />,
  );
}

async function renderWithDossier(row: unknown) {
  mocks.riaService.getDossier.mockResolvedValue(row);
  renderSection();
  await waitFor(() =>
    expect(mocks.riaService.getDossier).toHaveBeenCalledWith("tok"),
  );
}

describe("RiaProfileSection dossier row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAuth.mockReturnValue({
      user: { uid: "u1", getIdToken: vi.fn().mockResolvedValue("tok") },
    });
    mocks.usePersonaState.mockReturnValue({
      riaCapability: "switch",
      loading: false,
      refreshing: false,
      refresh: mocks.refresh,
      switchPersona: mocks.switchPersona,
    });
    mocks.refresh.mockResolvedValue(undefined);
  });

  it("renders nothing when no dossier row exists (404 → null)", async () => {
    await renderWithDossier(null);
    expect(screen.queryByTestId("ria-dossier-card")).toBeNull();
  });

  it("renders nothing when the read fails — best-effort surface", async () => {
    mocks.riaService.getDossier.mockRejectedValue(new Error("boom"));
    renderSection();
    await waitFor(() =>
      expect(mocks.riaService.getDossier).toHaveBeenCalled(),
    );
    expect(screen.queryByTestId("ria-dossier-card")).toBeNull();
  });

  it.each(["queued", "scanning"])(
    "shows the preparing line for status %s, with no Open and no Retry",
    async (status) => {
      await renderWithDossier({ status });
      await waitFor(() =>
        expect(screen.getByText("Preparing your dossier…")).toBeTruthy(),
      );
      expect(screen.queryByTestId("ria-dossier-toggle")).toBeNull();
      expect(screen.queryByTestId("ria-dossier-retry")).toBeNull();
      expect(screen.queryByText("Couldn't send.")).toBeNull();
    },
  );

  it.each(["generated", "sent"])(
    "shows the dossier with an expandable markdown body for status %s",
    async (status) => {
      await renderWithDossier({ status, markdown: DOSSIER_MARKDOWN });
      await waitFor(() => expect(screen.getByText("Your dossier")).toBeTruthy());
      expect(screen.queryByTestId("ria-dossier-retry")).toBeNull();
      expect(screen.queryByTestId("prose-markdown")).toBeNull();

      fireEvent.click(screen.getByTestId("ria-dossier-toggle"));
      expect(screen.getByTestId("prose-markdown").textContent).toBe(
        DOSSIER_MARKDOWN,
      );

      fireEvent.click(screen.getByTestId("ria-dossier-toggle"));
      expect(screen.queryByTestId("prose-markdown")).toBeNull();
    },
  );

  it.each(["scan_failed", "send_failed", "send_blocked_test_unset"])(
    "shows the failure grammar with Retry for status %s",
    async (status) => {
      await renderWithDossier({ status });
      await waitFor(() =>
        expect(screen.getByText("Couldn't send.")).toBeTruthy(),
      );
      expect(screen.getByTestId("ria-dossier-retry")).toBeTruthy();
      expect(screen.queryByTestId("ria-dossier-toggle")).toBeNull();
    },
  );

  it("shows blocked_no_email as a visible failure without Retry", async () => {
    await renderWithDossier({ status: "blocked_no_email" });
    await waitFor(() => expect(screen.getByText("Couldn't send.")).toBeTruthy());
    expect(screen.queryByTestId("ria-dossier-retry")).toBeNull();
  });

  it("re-queues on Retry and flips the row back to preparing", async () => {
    mocks.riaService.retryDossier.mockResolvedValue({ status: "queued" });
    await renderWithDossier({ status: "scan_failed" });
    await waitFor(() =>
      expect(screen.getByTestId("ria-dossier-retry")).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("ria-dossier-retry"));
    });

    expect(mocks.riaService.retryDossier).toHaveBeenCalledWith("tok");
    await waitFor(() =>
      expect(screen.getByText("Preparing your dossier…")).toBeTruthy(),
    );
    expect(screen.queryByText("Couldn't send.")).toBeNull();
  });

  it("keeps the failed row and Retry when the retry call itself fails", async () => {
    mocks.riaService.retryDossier.mockRejectedValue(new Error("boom"));
    await renderWithDossier({ status: "send_failed" });
    await waitFor(() =>
      expect(screen.getByTestId("ria-dossier-retry")).toBeTruthy(),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("ria-dossier-retry"));
    });

    expect(screen.getByText("Couldn't send.")).toBeTruthy();
    expect(screen.getByTestId("ria-dossier-retry")).toBeTruthy();
  });
});
