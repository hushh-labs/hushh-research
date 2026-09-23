import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode, TextareaHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: "",
  vaultKey: null as string | null,
  vaultOwnerToken: null as string | null,
  getInformationRequest: vi.fn(),
  getPublic: vi.fn(),
  getViewer: vi.fn(),
  push: vi.fn(),
  pathname: "/people/actual-public-ref",
  native: true,
  platform: "ios",
  user: null as { uid: string; getIdToken: () => Promise<string> } | null,
  authLoading: false,
  isVaultUnlocked: true,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(String(mocks.search || "")),
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => mocks.platform,
    isNativePlatform: () => mocks.native,
  },
  registerPlugin: () => ({}),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.user, loading: mocks.authLoading }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: mocks.vaultKey ?? null,
    vaultOwnerToken: mocks.vaultOwnerToken ?? null,
    isVaultUnlocked: mocks.isVaultUnlocked,
  }),
}));

vi.mock("@/lib/services/person-profile-service", () => ({
  PersonProfileService: {
    getPublic: mocks.getPublic,
    getViewer: mocks.getViewer,
    createInformationRequest: vi.fn(),
    connect: vi.fn(),
    cancelConnectionRequest: vi.fn(),
    removeConnection: vi.fn(),
    getInformationRequestExports: vi.fn(),
    cancelInformationRequest: vi.fn(),
    getInformationRequest: mocks.getInformationRequest,
  },
}));

vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({
  OneKycClientZkService: {
    decryptScopedExport: vi.fn(),
    ensureConnector: vi.fn(),
  },
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock("@/components/app-ui/page-sections", () => ({
  PageHeader: ({
    title,
    description,
  }: {
    title: string;
    description?: string;
  }) => (
    <header>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </header>
  ),
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({
    asChild,
    children,
    ...props
  }: {
    asChild?: boolean;
    children: ReactNode;
  }) => (asChild ? <>{children}</> : <button {...props}>{children}</button>),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: ReactNode;
    open?: boolean;
  }) => (open === false ? null : <>{children}</>),
  DialogContent: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

vi.mock("@/lib/morphy-ux/ui/surface-primitives", () => ({
  AvatarBubble: () => <span data-testid="avatar" />,
  SectionCard: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  StatusPill: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <span className={className}>{children}</span>,
}));

vi.mock("@/lib/agent/local-onboarding-actions", () => ({
  useLocalOnboardingActionHandler: vi.fn(),
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { PersonProfilePage } from "@/components/connections/person-profile-page";

function viewerProfile(overrides = {}) {
  return {
    personRef: "actual-public-ref",
    displayName: "Actual Person",
    photoUrl: "https://cdn.example.test/person.jpg",
    verifiedRole: null,
    relationship: {
      status: "connected",
      connectionId: "connection-1",
      connectedAt: null,
      requestId: null,
    },
    requestableScopes: [
      {
        scopeRef: "scope-short",
        label: "Risk profile",
        description: null,
        domain: "Financial",
        sensitivity: "standard",
        wildcard: false,
      },
      {
        scopeRef: "scope-wrapped",
        label: "Profile preferences investment horizon selected at",
        description: null,
        domain: "Financial",
        sensitivity: "standard",
        wildcard: false,
      },
    ],
    grants: [],
    requestHistory: [],
    ...overrides,
  };
}

describe("PersonProfilePage native profile route", () => {
  beforeEach(() => {
    mocks.getPublic.mockResolvedValue({
      personRef: "actual-public-ref",
      displayName: "Actual Person",
      photoUrl: null,
      verifiedRole: null,
    });
    mocks.getViewer.mockResolvedValue(null);
    mocks.pathname = "/people/actual-public-ref";
    mocks.native = true;
    mocks.platform = "ios";
    mocks.user = null;
    mocks.authLoading = false;
    mocks.vaultKey = null;
    mocks.vaultOwnerToken = null;
    mocks.isVaultUnlocked = true;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("uses the real iOS pathname person ref when native serves the static export shell", async () => {
    render(
      <PersonProfilePage
        personRef="00000000-0000-4000-8000-000000000001"
        initialProfile={null}
      />,
    );

    await waitFor(() => {
      expect(mocks.getPublic).toHaveBeenCalledWith("actual-public-ref");
    });
    expect(mocks.getPublic).not.toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(await screen.findByRole("heading", { name: "Actual Person" })).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("keeps the server-provided person ref outside native iOS", async () => {
    mocks.native = false;
    mocks.platform = "web";

    render(
      <PersonProfilePage
        personRef="server-public-ref"
        initialProfile={null}
      />,
    );

    await waitFor(() => {
      expect(mocks.getPublic).toHaveBeenCalledWith("server-public-ref");
    });
  });

  it("uses the shared connection avatar with the verified advisor badge for RIA profiles", async () => {
    render(
      <PersonProfilePage
        personRef="actual-public-ref"
        initialProfile={{
          personRef: "actual-public-ref",
          displayName: "Divya Rajendran",
          photoUrl: "https://cdn.example.test/divya.jpg",
          verifiedRole: "Registered investment adviser",
        }}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Divya Rajendran" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Verified advisor")).toBeInTheDocument();
    expect(document.querySelector('[data-avatar-size="profile"]')).not.toBeNull();
    expect(
      document.querySelector('[data-photo-url="https://cdn.example.test/divya.jpg"]'),
    ).not.toBeNull();
  });

  it("does not show a verified advisor badge for non-RIA profiles", async () => {
    render(
      <PersonProfilePage
        personRef="actual-public-ref"
        initialProfile={{
          personRef: "actual-public-ref",
          displayName: "Plain Person",
          photoUrl: null,
          verifiedRole: null,
        }}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Plain Person" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Verified advisor")).not.toBeInTheDocument();
  });

  it("keeps the share profile icon and label separated inside the existing action", async () => {
    render(
      <PersonProfilePage
        personRef="actual-public-ref"
        initialProfile={{
          personRef: "actual-public-ref",
          displayName: "Actual Person",
          photoUrl: null,
          verifiedRole: null,
        }}
      />,
    );

    const shareButton = await screen.findByRole("button", {
      name: "Share profile",
    });
    expect(shareButton.querySelector(".inline-flex.items-center.gap-2")).not.toBeNull();
  });

  it("opens the catalogue nested, one row per area rather than every scope at once", async () => {
    // Replaces an assertion about a hand-rolled grid row. The page no longer
    // owns a row: it renders the same nested list the Memory route uses, so a
    // person meets one screen per level instead of the whole catalogue flat.
    mocks.user = {
      uid: "viewer",
      getIdToken: vi.fn().mockResolvedValue("viewer-token"),
    };
    mocks.getViewer.mockResolvedValue(viewerProfile());

    render(
      <PersonProfilePage
        personRef="actual-public-ref"
        initialProfile={{
          personRef: "actual-public-ref",
          displayName: "Actual Person",
          photoUrl: null,
          verifiedRole: null,
        }}
      />,
    );

    await screen.findByRole("heading", { name: "Available to request" });

    // Both scopes live under one area, so the top level is that one area and
    // neither leaf is on screen yet.
    const area = screen.getByRole("button", { name: "Open Financial" });
    expect(area).toBeTruthy();
    expect(screen.queryByText("Risk profile")).toBeNull();

    fireEvent.click(area);

    // One level in: the leaves, and a back control named for where it returns
    // to rather than the word "Back".
    expect(screen.getByText("Risk profile")).toBeTruthy();
    expect(screen.getByTestId("person-profile-scope-back")).toHaveTextContent("All");
  });

  it("renders Review request after Financial rows without sticky viewport positioning", async () => {
    mocks.user = {
      uid: "viewer",
      getIdToken: vi.fn().mockResolvedValue("viewer-token"),
    };
    mocks.getViewer.mockResolvedValue(viewerProfile());

    render(
      <PersonProfilePage
        personRef="actual-public-ref"
        initialProfile={{
          personRef: "actual-public-ref",
          displayName: "Actual Person",
          photoUrl: null,
          verifiedRole: null,
        }}
      />,
    );

    const reviewButton = await screen.findByRole("button", {
      name: "Review request",
    });
    const historyHeading = screen.getByRole("heading", { name: "Request history" });
    expect(reviewButton.parentElement).toHaveClass("flex");
    expect(reviewButton.parentElement).toHaveClass("justify-end");
    expect(reviewButton.parentElement).not.toHaveClass("sticky");
    expect(reviewButton.parentElement).not.toHaveClass("bottom-4");
    expect(
      reviewButton.compareDocumentPosition(historyHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("does not open an unusable review dialog while the vault token is still loading", async () => {
    mocks.user = {
      uid: "viewer",
      getIdToken: vi.fn().mockResolvedValue("viewer-token"),
    };
    mocks.getViewer.mockResolvedValue(viewerProfile());

    render(
      <PersonProfilePage
        personRef="actual-public-ref"
        initialProfile={{
          personRef: "actual-public-ref",
          displayName: "Actual Person",
          photoUrl: null,
          verifiedRole: null,
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open Financial" }));
    fireEvent.click(screen.getByRole("button", { name: /Risk profile/ }));
    const reviewButton = await screen.findByRole("button", {
      name: "Review request (1)",
    });
    fireEvent.click(reviewButton);

    expect(screen.queryByRole("button", { name: "Send request" })).not.toBeInTheDocument();
    const { toast } = await import("sonner");
    expect(toast.error).toHaveBeenCalledWith(
      "Your vault is still getting ready. Try again in a moment.",
    );
  });
});

describe("PersonProfilePage request catalog tools", () => {
  it("distinguishes an unavailable catalog from an empty one and allows retry", async () => {
    mocks.getViewer.mockRejectedValueOnce(new Error("temporary failure"));
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    // The retry card carries the shipped copy ("We couldn't load your connection
    // with <name> right now") and stays identity-scoped to this viewer.
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn’t load your connection");
    expect(screen.queryByRole("heading", { name: "Available to request" })).not.toBeInTheDocument();
    mocks.getViewer.mockResolvedValue(viewerProfile());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Available to request" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not reuse the previous viewer's catalog while another account loads", async () => {
    const { rerender } = render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    await screen.findByRole("heading", { name: "Available to request" });
    mocks.user = { uid: "different-viewer", getIdToken: async () => "different-token" };
    mocks.getViewer.mockImplementation(() => new Promise(() => {}));
    rerender(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    expect(screen.queryByRole("heading", { name: "Available to request" })).not.toBeInTheDocument();
  });

  function manyScopes(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      scopeRef: `scope-${index}`,
      label: index === 0 ? "Employment status" : `Field ${index}`,
      description: null,
      domain: index % 2 === 0 ? "professional" : "food",
      sensitivity: "standard",
      wildcard: false,
    }));
  }

  beforeEach(() => {
    mocks.getPublic.mockResolvedValue({
      personRef: "actual-public-ref",
      displayName: "Actual Person",
      photoUrl: null,
      verifiedRole: null,
    });
    mocks.getViewer.mockResolvedValue(viewerProfile({ requestableScopes: manyScopes(9) }));
    mocks.pathname = "/people/actual-public-ref";
    mocks.native = false;
    mocks.platform = "web";
    mocks.user = { uid: "viewer-1", getIdToken: async () => "id-token" };
    mocks.authLoading = false;
    mocks.isVaultUnlocked = true;
    mocks.search = "";
    mocks.vaultKey = "vault-key";
    mocks.vaultOwnerToken = "owner-token";
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads the initial request catalog through the bounded first page", async () => {
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);

    await screen.findByRole("heading", { name: "Available to request" });
    expect(mocks.getViewer).toHaveBeenCalledWith(
      "actual-public-ref",
      "id-token",
      { page: 1 },
    );
  });

  it("drills into an area, walks back out, and lets search cut across every level", async () => {
    // The domain chips are gone. They were a flat filter standing in for
    // navigation; the level view navigates for real. Search survives because it
    // answers a different question -- someone typing has already said they do
    // not know where the thing lives, so search deliberately flattens.
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);

    const professional = await screen.findByRole("button", { name: "Open Professional" });
    expect(screen.queryByText("Employment status")).toBeNull();

    fireEvent.click(professional);
    expect(screen.getByText("Employment status")).toBeTruthy();
    expect(screen.queryByText("Field 1")).toBeNull(); // lives under the other area

    fireEvent.click(screen.getByTestId("person-profile-scope-back"));
    expect(screen.queryByText("Employment status")).toBeNull();
    expect(screen.getByRole("button", { name: "Open Professional" })).toBeTruthy();

    // Search reaches a leaf without navigating to it.
    const search = screen.getByTestId("person-profile-scope-search");
    fireEvent.change(search, { target: { value: "employment" } });
    expect(screen.getByText("Employment status")).toBeTruthy();

    fireEvent.change(search, { target: { value: "zzz-nothing" } });
    expect(screen.getByTestId("person-profile-scope-no-match")).toBeTruthy();

    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Open Professional" })).toBeTruthy();
  });

  it("offers an access duration inside the review sheet and sends it in hours", async () => {
    const { PersonProfileService } = await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } = await import("@/lib/services/one-kyc-client-zk-service");
    (OneKycClientZkService.ensureConnector as ReturnType<typeof vi.fn>).mockResolvedValue({ connector_key_id: "ck_1" });
    (PersonProfileService.createInformationRequest as ReturnType<typeof vi.fn>).mockResolvedValue({ bundleId: "b1" });
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Professional" }));
    fireEvent.click(screen.getByRole("button", { name: /Employment status/ }));
    fireEvent.click(screen.getByRole("button", { name: /Review request \(1\)/ }));
    const sendRequest = screen.getByRole("button", { name: "Send request" });
    expect(sendRequest).toBeDisabled();
    const duration = screen.getByTestId("person-profile-duration-select") as HTMLSelectElement;
    expect(duration.value).toBe("168");
    fireEvent.change(duration, { target: { value: "24" } });
    // The sheet no longer recites the duration; it says what the other person
    // will see, in the owner's words, and the select carries the number.
    expect(screen.getByText("They will see exactly what you asked for, why, and for how long.")).toBeTruthy();
    expect(duration.value).toBe("24");
    fireEvent.change(screen.getByTestId("person-profile-purpose"), { target: { value: "Checking references for a role" } });
    expect(sendRequest).toBeEnabled();
    fireEvent.click(sendRequest);
    await waitFor(() =>
      expect(PersonProfileService.createInformationRequest).toHaveBeenCalledWith(
        expect.objectContaining({ durationSeconds: 24 * 3600, scopeRefs: ["scope-0"] }),
      ),
    );
  });

  it("marks already shared fields as unavailable for a duplicate request", async () => {
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        requestableScopes: manyScopes(2),
        grants: [{
          scopeRef: "scope-0",
          label: "Employment status",
          domain: "professional",
          requestId: "req-shared",
          issuedAt: null,
          expiresAt: null,
          status: "granted",
          encryptedExportAvailable: true,
        }],
      }),
    );

    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Professional" }));
    const sharedField = screen.getByRole("checkbox", { name: "Employment status" });
    expect(sharedField).toBeDisabled();
  });

  it("reveals a grant behind stable test ids and confirms a copy in one word", async () => {
    const { PersonProfileService } = await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } = await import("@/lib/services/one-kyc-client-zk-service");
    const { toast } = await import("sonner");
    (OneKycClientZkService.ensureConnector as ReturnType<typeof vi.fn>).mockResolvedValue({ connector_key_id: "ck_1" });
    (PersonProfileService.getInformationRequestExports as ReturnType<typeof vi.fn>).mockResolvedValue([
      { requestId: "req-grant", encryptedExport: { sealed: true } },
    ]);
    (OneKycClientZkService.decryptScopedExport as ReturnType<typeof vi.fn>).mockResolvedValue({ city: "Pune" });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardBefore = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      mocks.getViewer.mockResolvedValue(
        viewerProfile({
          requestableScopes: manyScopes(2),
          grants: [
            {
              scopeRef: "scope-0",
              label: "City",
              domain: null,
              requestId: "req-grant",
              issuedAt: null,
              expiresAt: null,
              status: "granted",
              encryptedExportAvailable: true,
            },
          ],
          requestHistory: [
            {
              bundleId: "bundle-grant",
              requestId: "req-grant",
              scopeRef: "scope-0",
              label: "City",
              sensitivity: "standard",
              purpose: "Delivery",
              durationSeconds: 24 * 3600,
              createdAt: null,
              expiresAt: null,
              status: "approved",
            },
          ],
        }),
      );

      render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);

      const value = await screen.findByTestId("person-profile-grant-value");
      expect(value).toHaveTextContent("Pune");
      expect(screen.getByText(/End-to-end encrypted information shared with your account/)).toBeInTheDocument();
      expect(screen.queryByText("Zero-knowledge verified")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      expect(writeText).toHaveBeenCalledWith(JSON.stringify({ city: "Pune" }, null, 2));
      expect(toast.success).toHaveBeenCalledWith("Record copied to clipboard.");
    } finally {
      // Put the stub back so it cannot leak into a later test in this file.
      if (clipboardBefore) {
        Object.defineProperty(navigator, "clipboard", clipboardBefore);
      } else {
        delete (navigator as { clipboard?: unknown }).clipboard;
      }
    }
  });

  it("unwraps the domain envelope before rendering an encrypted grant", async () => {
    const { PersonProfileService } = await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } = await import("@/lib/services/one-kyc-client-zk-service");
    (OneKycClientZkService.ensureConnector as ReturnType<typeof vi.fn>).mockResolvedValue({ connector_key_id: "ck_1" });
    (PersonProfileService.getInformationRequestExports as ReturnType<typeof vi.fn>).mockResolvedValue([
      { requestId: "req-domain", encryptedExport: { sealed: true } },
    ]);
    (OneKycClientZkService.decryptScopedExport as ReturnType<typeof vi.fn>).mockResolvedValue({
      professional: { summary: "Synthetic approved detail" },
      __export_metadata: { source_domain: "professional" },
    });
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        requestableScopes: manyScopes(2),
        grants: [{
          scopeRef: "scope-0",
          label: "Professional detail",
          domain: "Professional",
          requestId: "req-domain",
          issuedAt: null,
          expiresAt: null,
          status: "granted",
          encryptedExportAvailable: true,
        }],
        requestHistory: [{
          bundleId: "bundle-domain",
          requestId: "req-domain",
          scopeRef: "scope-0",
          label: "Professional detail",
          sensitivity: "standard",
          purpose: "Reviewing a professional detail",
          durationSeconds: 24 * 3600,
          createdAt: null,
          expiresAt: null,
          status: "approved",
        }],
      }),
    );

    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);

    expect(await screen.findByTestId("person-profile-grant-value")).toHaveTextContent(
      "Synthetic approved detail",
    );
  });

  it("keeps nested approved summaries visible in an encrypted grant", async () => {
    const { PersonProfileService } = await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } = await import("@/lib/services/one-kyc-client-zk-service");
    (OneKycClientZkService.ensureConnector as ReturnType<typeof vi.fn>).mockResolvedValue({ connector_key_id: "ck_1" });
    (PersonProfileService.getInformationRequestExports as ReturnType<typeof vi.fn>).mockResolvedValue([
      { requestId: "req-nested", encryptedExport: { sealed: true } },
    ]);
    (OneKycClientZkService.decryptScopedExport as ReturnType<typeof vi.fn>).mockResolvedValue({
      professional: { profile: { summary: "Synthetic nested detail" } },
      __export_metadata: { source_domain: "professional" },
    });
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        requestableScopes: manyScopes(2),
        grants: [{
          scopeRef: "scope-0",
          label: "Professional detail",
          domain: "Professional",
          requestId: "req-nested",
          issuedAt: null,
          expiresAt: null,
          status: "granted",
          encryptedExportAvailable: true,
        }],
        requestHistory: [{
          bundleId: "bundle-nested",
          requestId: "req-nested",
          scopeRef: "scope-0",
          label: "Professional detail",
          sensitivity: "standard",
          purpose: "Reviewing a professional detail",
          durationSeconds: 24 * 3600,
          createdAt: null,
          expiresAt: null,
          status: "approved",
        }],
      }),
    );

    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);

    expect(await screen.findByTestId("person-profile-grant-value")).toHaveTextContent(
      "Synthetic nested detail",
    );
  });

  it("keeps a backend detail out of the toast when a grant cannot be opened", async () => {
    const { PersonProfileService } = await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } = await import("@/lib/services/one-kyc-client-zk-service");
    const { toast } = await import("sonner");
    (OneKycClientZkService.ensureConnector as ReturnType<typeof vi.fn>).mockResolvedValue({ connector_key_id: "ck_1" });
    (PersonProfileService.getInformationRequestExports as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("psycopg2.errors.UndefinedColumn: column consent_exports.sealed does not exist"),
    );
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        requestableScopes: manyScopes(2),
        grants: [
          {
            scopeRef: "scope-0",
            label: "City",
            domain: null,
            requestId: "req-grant-fail",
            issuedAt: null,
            expiresAt: null,
            status: "granted",
            encryptedExportAvailable: true,
          },
        ],
        requestHistory: [
          {
            bundleId: "bundle-grant",
            requestId: "req-grant-fail",
            scopeRef: "scope-0",
            label: "City",
            sensitivity: "standard",
            purpose: "Delivery",
            durationSeconds: 24 * 3600,
            createdAt: null,
            expiresAt: null,
            status: "approved",
          },
        ],
      }),
    );

    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);

    fireEvent.click(await screen.findByTestId("person-profile-grant-reveal"));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const shown = String((toast.error as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]);
    expect(shown).toBe("This shared information could not be opened.");
    expect(shown).not.toMatch(/psycopg2|column|export/i);
    expect(screen.queryByTestId("person-profile-grant-value")).toBeNull();
  });

  it("stops automatic grant retries after a bounded failure and leaves a manual retry", async () => {
    const { PersonProfileService } = await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } = await import("@/lib/services/one-kyc-client-zk-service");
    const { toast } = await import("sonner");
    mocks.user = {
      uid: "viewer",
      getIdToken: vi.fn().mockResolvedValue("viewer-token"),
    };
    mocks.vaultKey = "vault-key";
    mocks.vaultOwnerToken = "owner-token";
    (OneKycClientZkService.ensureConnector as ReturnType<typeof vi.fn>).mockResolvedValue({ connector_key_id: "ck_1" });
    (PersonProfileService.getInformationRequestExports as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("psycopg2.errors.SerializationFailure: temporary export failure"),
    );
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        grants: [{
          scopeRef: "scope-0",
          label: "City",
          domain: "location",
          requestId: "req-grant-fail",
          issuedAt: null,
          expiresAt: null,
          status: "granted",
          encryptedExportAvailable: true,
        }],
        requestHistory: [{
          bundleId: "bundle-grant",
          requestId: "req-grant-fail",
          scopeRef: "scope-0",
          label: "City",
          sensitivity: "standard",
          purpose: "Delivery",
          durationSeconds: 24 * 3600,
          createdAt: null,
          expiresAt: null,
          status: "approved",
        }],
      }),
    );

    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This shared information could not be opened."));
    expect(await screen.findByTestId("person-profile-grant-reveal")).toBeInTheDocument();
    expect(PersonProfileService.getInformationRequestExports).toHaveBeenCalledTimes(1);
  });

  it("brings the requestable catalog into view when opened with ?request=1", async () => {
    mocks.search = "request=1";
    const scrolled = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrolled;
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    await screen.findByTestId("person-profile-available");
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
  });

  it("shows bundle details for a request in the history on demand", async () => {
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        requestableScopes: manyScopes(2),
        requestHistory: [
          {
            bundleId: "bundle-1",
            requestId: "req-1",
            scopeRef: "scope-0",
            label: "Employment status",
            sensitivity: "standard",
            purpose: "Checking references",
            durationSeconds: 7 * 24 * 3600,
            createdAt: null,
            expiresAt: null,
            status: "pending",
          },
        ],
      }),
    );
    mocks.getInformationRequest.mockResolvedValue({
      personRef: "actual-public-ref",
      bundleId: "bundle-1",
      purpose: "Checking references",
      durationSeconds: 7 * 24 * 3600,
      cancelled: false,
      items: [{ requestId: "req-1", scopeRef: "scope-0", label: "Employment status", sensitivity: "standard", status: "pending" }],
    });
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Details for Employment status" }));
    expect(await screen.findByTestId("person-profile-bundle-details")).toHaveTextContent("Employment status (pending) · 1 week");
  });

  it("groups a multi-field request into one history row with one action", async () => {
    mocks.getViewer.mockResolvedValue(viewerProfile({
      requestHistory: Array.from({ length: 12 }, (_, index) => ({
        bundleId: "bundle-professional",
        requestId: `request-${index}`,
        scopeRef: `scope-${index}`,
        label: `Professional detail ${index + 1}`,
        sensitivity: "standard",
        purpose: "Review professional information",
        durationSeconds: 7 * 24 * 3600,
        createdAt: null,
        expiresAt: null,
        status: "granted",
      })),
    }));
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);

    expect(await screen.findByText("Request for 12 information items")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Details for 12 information items" })).toHaveLength(1);
    expect(screen.queryByText("Professional detail 2")).toBeNull();
  });

  it("pages request bundles instead of growing the history indefinitely", async () => {
    mocks.getViewer.mockResolvedValue(viewerProfile({
      requestHistory: Array.from({ length: 9 }, (_, index) => ({
        bundleId: `bundle-${index}`,
        requestId: `request-${index}`,
        scopeRef: `scope-${index}`,
        label: `History item ${index + 1}`,
        sensitivity: "standard",
        purpose: "Checking history",
        durationSeconds: 3600,
        createdAt: null,
        expiresAt: null,
        status: "granted",
      })),
    }));
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);

    expect(await screen.findByText("History item 1")).toBeInTheDocument();
    expect(screen.queryByText("History item 9")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("History item 9")).toBeInTheDocument();
    expect(screen.queryByText("History item 1")).toBeNull();
  });

  it("does not display details returned for another person", async () => {
    const { toast } = await import("sonner");
    mocks.getViewer.mockResolvedValue(viewerProfile({
      requestHistory: [{
        bundleId: "bundle-1", requestId: "request-1", scopeRef: "scope-1",
        label: "Employment status", sensitivity: "standard", purpose: "Checking references",
        durationSeconds: 3600, createdAt: null, expiresAt: null, status: "pending",
      }],
    }));
    mocks.getInformationRequest.mockResolvedValue({
      personRef: "another-person", bundleId: "bundle-1", items: [],
    });
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Details for Employment status" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByTestId("person-profile-bundle-details")).toBeNull();
  });
});
