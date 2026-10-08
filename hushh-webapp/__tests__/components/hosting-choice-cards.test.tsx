/**
 * The cloud step's hosting choice is a radio group whose arrows only move the
 * selection. A tap or an arrow key must never commit a placement on its own:
 * the server write belongs to the one explicit button under the cards.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiService } from "@/lib/services/api-service";
import { ByocCloudSetupPage } from "@/components/connections/byoc-cloud-setup-page";

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: { uid: "uid-first-run" }, loading: false }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: () => undefined,
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    getCachedBootstrapState: () => null,
    bootstrapState: () => Promise.resolve(null),
    hasOneCloudProject: () => false,
  },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getByocSetupStatus: vi.fn(),
    getPersonalAgentStatus: vi.fn(),
    suggestByocProject: vi.fn().mockResolvedValue(null),
    saveByocProject: vi.fn(),
    selectHostedCloud: vi.fn(),
    selectSharedHosting: vi.fn(),
    beginByocAuthorize: vi.fn(),
  },
}));

vi.mock("@/components/connections/byoc-cloud-card", () => ({
  ByocCloudCard: () => <div data-testid="byoc-cloud-card">naming form</div>,
}));

vi.mock("@/components/onboarding/setup/setup-completion-footer", () => ({
  SetupCompletionFooter: () => null,
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  AppPageHeaderRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AppPageContentRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/app-ui/page-sections", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

async function renderSharedDefault() {
  vi.mocked(ApiService.getPersonalAgentStatus).mockResolvedValue({ hostingMode: "shared" } as never);
  vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue({ status: "none" } as never);
  render(<ByocCloudSetupPage />);
  return screen.findByRole("radiogroup", { name: "Where your agent runs" });
}

describe("Hosting choice cards on the cloud step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("starts on the confirmed Shared default, one tab stop, Hussh Pods paused", async () => {
    await renderSharedDefault();
    const shared = screen.getByRole("radio", { name: "Hussh Shared" });
    const own = screen.getByRole("radio", { name: "Bring your own cloud" });
    const pods = screen.getByRole("radio", { name: "Hussh Pods" });

    expect(shared).toHaveAttribute("aria-checked", "true");
    expect(shared).toHaveAttribute("tabindex", "0");
    expect(own).toHaveAttribute("tabindex", "-1");
    expect(pods).toBeDisabled();
    expect(pods).toHaveAttribute("aria-checked", "false");
    expect(pods).toHaveAccessibleDescription(
      "A dedicated agent we run for you. Paused for maintenance",
    );
    expect(screen.getByTestId("cloud-tier-shared-continue")).toHaveTextContent(
      "Continue with Hussh Shared",
    );
  });

  it("moves the selection with the arrows, skips the paused option, and commits nothing", async () => {
    await renderSharedDefault();
    const shared = screen.getByRole("radio", { name: "Hussh Shared" });

    fireEvent.keyDown(shared, { key: "ArrowDown" });
    const own = screen.getByRole("radio", { name: "Bring your own cloud" });
    expect(own).toHaveAttribute("aria-checked", "true");
    expect(own).toHaveFocus();
    // Own cloud opens the provider step beneath the cards; the cards stay.
    expect(screen.getByTestId("byoc-cloud-card")).toBeInTheDocument();
    expect(screen.queryByTestId("cloud-tier-shared-continue")).toBeNull();

    // Hussh Pods is paused, so the next stop wraps back to Shared.
    fireEvent.keyDown(own, { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: "Hussh Shared" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("byoc-cloud-card")).toBeNull();

    expect(ApiService.selectSharedHosting).not.toHaveBeenCalled();
    expect(ApiService.selectHostedCloud).not.toHaveBeenCalled();
  });

  it("commits Shared only from the button under the cards", async () => {
    vi.mocked(ApiService.selectSharedHosting).mockResolvedValue({ hostingMode: "shared" } as never);
    await renderSharedDefault();

    await act(async () => {
      fireEvent.click(screen.getByTestId("cloud-tier-shared-continue"));
    });

    expect(ApiService.selectSharedHosting).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("cloud-tier-shared-continue")).toHaveTextContent("Hussh Shared selected");
    expect(screen.getByTestId("cloud-tier-shared-continue")).toBeDisabled();
  });

  it("names Azure only on a build where it can be chosen", async () => {
    await renderSharedDefault();
    expect(screen.getByRole("radio", { name: "Bring your own cloud" })).toHaveAccessibleDescription(
      "Your agent runs in your own Google Cloud Platform account. You own it and pay for it.",
    );
  });

  it("offers Hussh Pods through the same single button once it reopens", async () => {
    vi.stubEnv("NEXT_PUBLIC_HOSTED_POD_TIER_MAINTENANCE", "0");
    vi.mocked(ApiService.selectHostedCloud).mockReturnValue(new Promise(() => {}) as never);
    await renderSharedDefault();

    fireEvent.click(screen.getByRole("radio", { name: "Hussh Pods" }));
    expect(ApiService.selectHostedCloud).not.toHaveBeenCalled();
    const commit = screen.getByTestId("cloud-tier-hosted-continue");
    expect(commit).toHaveTextContent("Set up Hussh Pods");

    await act(async () => {
      fireEvent.click(commit);
    });
    expect(ApiService.selectHostedCloud).toHaveBeenCalledTimes(1);
    expect(commit).toHaveTextContent("Setting that up…");
  });
});
