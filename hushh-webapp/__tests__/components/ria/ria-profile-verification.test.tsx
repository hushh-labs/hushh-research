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

const PHONE_DIGITS = "8015663510";

const CLAIM_EVENT = {
  outcome: "verified",
  checked_at: "2026-08-01T00:00:00Z",
  expires_at: null,
  reference_metadata: {
    provider: "ria_identity_claim",
    claim_type: "individual",
    phone: PHONE_DIGITS,
    verification_level: "provisional",
    satisfied: ["phone_otp"],
    missing: ["domain_email"],
    firm_record: {
      crd: 800001,
      name: "EXAMPLE ADVISORS LLC",
      registration_status: "Active",
      registration_type: "sec",
      aum: 2_500_000_000,
      phone: PHONE_DIGITS,
    },
    advisor_record: {
      crd: 1234567,
      registered_since: "2004-01-12",
    },
  },
};

const BASE_STATUS = {
  exists: true,
  advisory_status: "submitted",
  verification_status: "submitted",
  display_name: "Andrew Kirkland",
  individual_crd: "7413463",
  services_offered: ["Portfolio Management"],
  fee_structure: ["Hourly"],
};

function renderSection(status: unknown, onRefresh = vi.fn()) {
  return render(
    <RiaProfileSection
      status={status as never}
      loading={false}
      onRefresh={onRefresh}
    />,
  );
}

describe("RiaProfileSection verification chip + email nudge", () => {
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

  it("renders the Not verified chip and the email nudge when unverified", async () => {
    renderSection({ ...BASE_STATUS, latest_claim_event: CLAIM_EVENT });

    await waitFor(() =>
      expect(screen.getByTestId("ria-profile-verification-chip")).toBeTruthy(),
    );
    expect(
      screen.getByTestId("ria-profile-verification-chip").textContent,
    ).toContain("Not verified");
    expect(screen.getByTestId("ria-email-verify-card")).toBeTruthy();
    expect(screen.getByText("Verify with your work email")).toBeTruthy();
  });

  it("mounts the location map inside the Location group", () => {
    renderSection({ ...BASE_STATUS });

    const locationGroup = screen.getByTestId("ria-profile-location-summary");
    expect(
      locationGroup.querySelector('[data-testid="ria-location-map"]'),
    ).toBeTruthy();
  });

  it("renders the Verified chip and no nudge when verified", async () => {
    renderSection({
      ...BASE_STATUS,
      verification_status: "verified",
      advisory_status: "verified",
      latest_claim_event: CLAIM_EVENT,
    });

    await waitFor(() =>
      expect(screen.getByTestId("ria-profile-verification-chip")).toBeTruthy(),
    );
    expect(
      screen.getByTestId("ria-profile-verification-chip").textContent,
    ).toContain("Verified");
    expect(
      screen.getByTestId("ria-profile-verification-chip").textContent,
    ).not.toContain("Not verified");
    expect(screen.queryByTestId("ria-email-verify-card")).toBeNull();
  });

  it("hides the nudge without a claim snapshot and for firm claims", () => {
    // Onboarded-but-never-claimed: no claim event → no email card.
    renderSection({ ...BASE_STATUS }).unmount();
    expect(screen.queryByTestId("ria-email-verify-card")).toBeNull();

    // Firm claims are gated out in v1 (no adviser name for email_name_match).
    renderSection({
      ...BASE_STATUS,
      latest_claim_event: {
        ...CLAIM_EVENT,
        reference_metadata: {
          ...CLAIM_EVENT.reference_metadata,
          claim_type: "firm",
        },
      },
    });
    expect(screen.queryByTestId("ria-email-verify-card")).toBeNull();
  });

  it("renders the SEC record from the claim event, ahead of the verification event", async () => {
    renderSection({
      ...BASE_STATUS,
      latest_claim_event: CLAIM_EVENT,
      latest_verification_event: {
        outcome: "verified",
        checked_at: "2026-08-05T00:00:00Z",
        reference_metadata: {
          provider: "sec_iapd",
          advisor_record: { crd: 999 },
        },
      },
    });

    await waitFor(() =>
      expect(screen.getByText("From your SEC record.")).toBeTruthy(),
    );
    expect(screen.getByText("1234567")).toBeTruthy();
    expect(screen.queryByText("999")).toBeNull();
    expect(screen.getByText("$2.5B")).toBeTruthy();
  });

  it("falls back to the verification event only when it carries records", async () => {
    renderSection({
      ...BASE_STATUS,
      latest_verification_event: {
        outcome: "verified",
        checked_at: "2026-08-05T00:00:00Z",
        reference_metadata: {
          provider: "sec_iapd",
          advisor_record: { crd: 424242, registered_since: "2010-05-01" },
        },
      },
    });

    await waitFor(() =>
      expect(screen.getByText("From your SEC record.")).toBeTruthy(),
    );
    expect(screen.getByText("424242")).toBeTruthy();
  });

  it("omits the SEC section when neither event carries records, but still shows verification", () => {
    // The chip used to ride inside the SEC card, so an adviser with a thin
    // record saw no verification state at all. Verification is its own row now.
    renderSection({
      ...BASE_STATUS,
      latest_verification_event: {
        outcome: "verified",
        checked_at: "2026-08-05T00:00:00Z",
        reference_metadata: { provider: "sec_iapd" },
      },
    });

    expect(screen.queryByText("From your SEC record.")).toBeNull();
    expect(screen.getByTestId("ria-profile-verification-row")).toBeTruthy();
    expect(
      screen.getByTestId("ria-profile-verification-chip").textContent,
    ).toContain("Not verified");
  });

  it("never renders the raw phone digits persisted in the claim metadata", async () => {
    const { container } = renderSection({
      ...BASE_STATUS,
      latest_claim_event: CLAIM_EVENT,
    });

    await waitFor(() =>
      expect(screen.getByText("From your SEC record.")).toBeTruthy(),
    );
    expect(container.textContent).not.toContain(PHONE_DIGITS);
  });

  it("sends the code, confirms it, and refreshes on verified", async () => {
    mocks.riaService.claimEmailStart.mockResolvedValue({
      status: "sent",
      email_masked: "r•••@examplefirm.com",
    });
    mocks.riaService.claimEmailConfirm.mockResolvedValue({
      verified: true,
      verification_status: "verified",
      verification_level: "verified",
    });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    renderSection({ ...BASE_STATUS, latest_claim_event: CLAIM_EVENT }, onRefresh);

    fireEvent.change(screen.getByTestId("ria-email-verify-input"), {
      target: { value: "reggie@examplefirm.com" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ria-email-verify-send"));
    });
    expect(mocks.riaService.claimEmailStart).toHaveBeenCalledWith("tok", {
      email: "reggie@examplefirm.com",
    });

    await waitFor(() =>
      expect(screen.getByTestId("ria-email-verify-code")).toBeTruthy(),
    );
    fireEvent.change(screen.getByTestId("ria-email-verify-code"), {
      target: { value: "123456" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ria-email-verify-confirm"));
    });

    expect(mocks.riaService.claimEmailConfirm).toHaveBeenCalledWith("tok", {
      email: "reggie@examplefirm.com",
      code: "123456",
    });
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledWith(true);
      expect(mocks.refresh).toHaveBeenCalledWith({ force: true });
    });
  });

  it("offers Retry when the mail queue fails, without losing the card", async () => {
    mocks.riaService.claimEmailStart.mockResolvedValue({
      status: "send_failed",
      email_masked: "r•••@examplefirm.com",
    });
    renderSection({ ...BASE_STATUS, latest_claim_event: CLAIM_EVENT });

    fireEvent.change(screen.getByTestId("ria-email-verify-input"), {
      target: { value: "reggie@examplefirm.com" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ria-email-verify-send"));
    });

    expect(screen.getByText("Couldn't send.")).toBeTruthy();
    expect(screen.getByTestId("ria-email-verify-send").textContent).toContain(
      "Retry",
    );
    // Still on the email phase — no code input yet.
    expect(screen.queryByTestId("ria-email-verify-code")).toBeNull();
  });
});

const BROCHURE_URL =
  "https://reports.adviserinfo.sec.gov/reports/ADV/800001/PDF/800001-Brochure.pdf";
const BROCHURE_CAPTION = "From your Form ADV brochure, filed 1/13/2026.";

describe("RiaProfileSection Form ADV brochure provenance", () => {
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

  it("captions the Services group with the filing date the SEC states", () => {
    renderSection({
      ...BASE_STATUS,
      profile_source: "form_adv_part2",
      profile_source_url: BROCHURE_URL,
      profile_source_filed_on: "1/13/2026",
    });

    const caption = screen.getByTestId("ria-profile-brochure-source");
    // The SEC's own date string, rendered as filed — not reformatted.
    expect(caption.textContent).toBe(BROCHURE_CAPTION);
  });

  it("links the caption to the brochure PDF when the url is present", () => {
    renderSection({
      ...BASE_STATUS,
      profile_source: "form_adv_part2",
      profile_source_url: BROCHURE_URL,
      profile_source_filed_on: "1/13/2026",
    });

    const link = screen
      .getByTestId("ria-profile-brochure-source")
      .querySelector("a");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe(BROCHURE_URL);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
    expect(link?.textContent).toBe(BROCHURE_CAPTION);
  });

  it("renders plain text when the brochure url is absent", () => {
    renderSection({
      ...BASE_STATUS,
      profile_source: "form_adv_part2",
      profile_source_filed_on: "1/13/2026",
    });

    const caption = screen.getByTestId("ria-profile-brochure-source");
    expect(caption.textContent).toBe(BROCHURE_CAPTION);
    expect(caption.querySelector("a")).toBeNull();
  });

  it("renders nothing when no brochure supplied a value", () => {
    // Absent source: the adviser wrote everything shown.
    renderSection({ ...BASE_STATUS }).unmount();
    expect(screen.queryByTestId("ria-profile-brochure-source")).toBeNull();

    // Empty source with a stray url: still nothing — no caption, no placeholder.
    renderSection({
      ...BASE_STATUS,
      profile_source: "",
      profile_source_url: BROCHURE_URL,
      profile_source_filed_on: "1/13/2026",
    });
    expect(screen.queryByTestId("ria-profile-brochure-source")).toBeNull();
    expect(screen.queryByText(BROCHURE_CAPTION)).toBeNull();
  });

  it("belongs to the Services group and to no other group", () => {
    renderSection({
      ...BASE_STATUS,
      profile_source: "form_adv_part2",
      profile_source_url: BROCHURE_URL,
      profile_source_filed_on: "1/13/2026",
    });

    expect(screen.getAllByTestId("ria-profile-brochure-source")).toHaveLength(1);
    expect(
      screen
        .getByTestId("ria-profile-services-summary")
        .querySelector('[data-testid="ria-profile-brochure-source"]'),
    ).toBeTruthy();
    for (const groupTestId of [
      "ria-profile-assistant",
      "ria-profile-licence-summary",
      "ria-profile-location-summary",
      "ria-profile-manage",
    ]) {
      expect(
        screen
          .getByTestId(groupTestId)
          .querySelector('[data-testid="ria-profile-brochure-source"]'),
      ).toBeNull();
    }
  });
});
