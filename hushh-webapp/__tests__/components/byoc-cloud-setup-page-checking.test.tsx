/**
 * "Checking your cloud..." must end.
 *
 * It is a truthful sentence for a few seconds and a dead end after that. On
 * 2026-09-02 a returning person's session refresh stalled, the status call never
 * left the browser, and this line stayed on screen with nothing to click. Past
 * the ceiling the page must show the naming form (always a truthful fallback)
 * with a note, and must stay quiet about the note once the status does arrive.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiService } from "@/lib/services/api-service";
import {
  ByocCloudSetupPage,
  CLOUD_CHECK_TIMEOUT_MS,
} from "@/components/connections/byoc-cloud-setup-page";

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: { uid: "uid-returning" }, loading: false }),
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
    bootstrapState: () => new Promise(() => {}),
    hasOneCloudProject: () => false,
  },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getByocSetupStatus: vi.fn(),
    suggestByocProject: vi.fn().mockResolvedValue(null),
    saveByocProject: vi.fn(),
    selectHostedCloud: vi.fn(),
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
  AppPageContentRegion: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/app-ui/page-sections", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

const mockStatus = vi.mocked(ApiService.getByocSetupStatus);

describe("ByocCloudSetupPage — the checking ceiling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockStatus.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops saying 'Checking' at the ceiling and shows the way forward", async () => {
    mockStatus.mockReturnValue(new Promise(() => {})); // the stalled session: never answers
    render(<ByocCloudSetupPage />);

    expect(screen.getByTestId("byoc-cloud-checking")).toBeTruthy();
    expect(screen.queryByTestId("byoc-cloud-check-timed-out")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOUD_CHECK_TIMEOUT_MS + 1);
    });

    expect(screen.queryByTestId("byoc-cloud-checking")).toBeNull();
    expect(screen.getByTestId("byoc-cloud-check-timed-out")).toBeTruthy();
    // The person can act: the tier choice (the same node the first-run driver
    // asserts on) is on screen, not a spinner.
    expect(screen.getByTestId("cloud-tier-choice")).toBeTruthy();
  });

  it("never shows the note when the status arrives in time", async () => {
    mockStatus.mockResolvedValue({ status: "none" } as never);
    render(<ByocCloudSetupPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByTestId("byoc-cloud-checking")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOUD_CHECK_TIMEOUT_MS + 1);
    });
    expect(screen.queryByTestId("byoc-cloud-check-timed-out")).toBeNull();
  });
});
