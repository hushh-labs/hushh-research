/**
 * The manual lane must hand a person something they can actually run.
 *
 * When one-click authorization is unavailable or refused, this page falls back to
 * "record the project, show the script, prove on re-save". That fallback used to print:
 *
 *     PROJECT_ID=... HUSHH_CALLER=... bash deploy/iam/authorize_byoc_project.sh
 *
 * `deploy/iam/authorize_byoc_project.sh` exists only in the hussh repository. So the
 * journey dead-ended on an instruction nobody outside the team could follow, at exactly
 * the step that decides whether their agent gets built in their own cloud.
 *
 * The script is served now, rendered against their project, with the disclosure of what
 * it grants beside it.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiService } from "@/lib/services/api-service";
import { ByocCloudSetupPage } from "@/components/connections/byoc-cloud-setup-page";

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: { uid: "uid-manual" }, loading: false }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  // `intent=migrate` is the real product path that means "they have already chosen
  // their own cloud", which is the lane under test.
  useSearchParams: () => new URLSearchParams("intent=migrate"),
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
    getByocAuthorizationInstructions: vi.fn(),
  },
}));

// The real card owns a form; this stands in for a person naming their project, which is
// the only way into the lane under test.
vi.mock("@/components/connections/byoc-cloud-card", () => ({
  ByocCloudCard: ({
    onProjectNamed,
  }: {
    onProjectNamed: (projectId: string) => void;
  }) => (
    <button type="button" onClick={() => onProjectNamed("alices-own-cloud")}>
      name it
    </button>
  ),
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

const SERVED_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
PROJECT_ID="alices-own-cloud"
gcloud services enable "storage.googleapis.com" --project="$PROJECT_ID"`;

describe("the manual authorization lane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue({
      status: "none",
      stage: "",
      stages: [],
      projectId: "",
      errorCode: null,
      errorMessage: null,
      stale: false,
      updatedAt: null,
    });
    // One-click is unavailable, which is what sends this person down the manual lane.
    vi.mocked(ApiService.beginByocAuthorize).mockRejectedValue(
      new Error("BYOC_AUTHORIZE_BEGIN_FAILED"),
    );
    vi.mocked(ApiService.saveByocProject).mockResolvedValue({
      projectId: "alices-own-cloud",
      region: "us-central1",
      bootstrapServiceAccount: "one-bootstrap@alices-own-cloud.iam.gserviceaccount.com",
      authorized: false,
      hushhCaller: "consent-protocol-runtime@hushh.iam.gserviceaccount.com",
      nextStep: "Run the authorization script in your project, then continue.",
    });
    vi.mocked(ApiService.getByocAuthorizationInstructions).mockResolvedValue({
      projectId: "alices-own-cloud",
      bootstrapServiceAccount: "one-bootstrap@alices-own-cloud.iam.gserviceaccount.com",
      hushhCaller: "consent-protocol-runtime@hushh.iam.gserviceaccount.com",
      disclosure: {
        grants_to_bootstrap_sa: [
          { role: "roles/run.admin", why: "create the pod service" },
        ],
        hushh_never_receives: ["a service-account key file"],
        revocation: "Remove the serviceAccountTokenCreator binding.",
      },
      script: SERVED_SCRIPT,
      scriptFilename: "authorize-hussh-alices-own-cloud.sh",
      revokeCommand: "gcloud iam service-accounts remove-iam-policy-binding ...",
      authorized: false,
    });
  });

  it("shows the served script, not a path only hussh has", async () => {
    render(<ByocCloudSetupPage />);
    fireEvent.click(await screen.findByText("name it"));

    const block = await screen.findByTestId("byoc-authorize-script");
    expect(block.textContent).toContain("gcloud services enable");
    expect(block.textContent).toContain("alices-own-cloud");
    // The defect this exists for. A person cannot run a file they do not have.
    expect(document.body.textContent).not.toContain(
      "deploy/iam/authorize_byoc_project.sh",
    );
  });

  it("shows what the grant actually buys, next to the command that makes it", async () => {
    render(<ByocCloudSetupPage />);
    fireEvent.click(await screen.findByText("name it"));

    await screen.findByTestId("byoc-authorize-script");
    // `authorization_request` had no caller at all before this route existed, so a
    // person was shown a shell command and no account of what it does.
    expect(document.body.textContent).toContain("roles/run.admin");
    expect(document.body.textContent).toContain("a service-account key file");
  });

  it("stays honest while the script is still being fetched", async () => {
    let release: (value: never) => void = () => {};
    vi.mocked(ApiService.getByocAuthorizationInstructions).mockReturnValue(
      new Promise((resolve) => {
        release = resolve as (value: never) => void;
      }),
    );

    render(<ByocCloudSetupPage />);
    fireEvent.click(await screen.findByText("name it"));

    // Never a half-rendered grant: pending reads as pending, because a command that
    // authorizes nothing is worse than a visible wait.
    await waitFor(() =>
      expect(document.body.textContent).toContain("Preparing the script"),
    );
    expect(screen.queryByTestId("byoc-authorize-script")).toBeNull();
    void release;
  });
});
