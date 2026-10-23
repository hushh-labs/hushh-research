import { currentGrantFixture, viewerProfile } from "./person-profile/fixtures";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps, ReactNode, TextareaHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  realDialogs: false,
  answerGates: vi.fn(),
  answerCreate: vi.fn(),
  search: "",
  vaultKey: null as string | null,
  vaultOwnerToken: null as string | null,
  getInformationRequest: vi.fn(),
  getRequestHistory: vi.fn(),
  getPublic: vi.fn(),
  getViewer: vi.fn(),
  getRelationship: vi.fn(),
  getVaultOwnerToken: vi.fn(),
  push: vi.fn(),
  pathname: "/people/actual-public-ref",
  native: true,
  platform: "ios",
  user: null as { uid: string; getIdToken: () => Promise<string> } | null,
  authLoading: false,
  isVaultUnlocked: true,
  packets: vi.fn(),
  connectorOverview: vi.fn(),
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
    getVaultOwnerToken: mocks.getVaultOwnerToken,
    isVaultUnlocked: mocks.isVaultUnlocked,
  }),
}));

vi.mock("@/lib/services/person-profile-service", () => ({
  PersonProfileService: {
    getPublic: mocks.getPublic,
    getViewer: mocks.getViewer,
    getRelationship: mocks.getRelationship,
    createInformationRequest: vi.fn(),
    connect: vi.fn(),
    cancelConnectionRequest: vi.fn(),
    removeConnection: vi.fn(),
    getInformationRequestExports: vi.fn(),
    cancelInformationRequest: vi.fn(),
    getInformationRequest: mocks.getInformationRequest,
    getRequestHistory: mocks.getRequestHistory,
  },
}));

// A connection's listed packets; buying is covered by the packet tests.
vi.mock("@/lib/services/drive-packet-service", () => ({
  DrivePacketService: { packets: mocks.packets },
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: { overview: mocks.connectorOverview, featureReadiness: mocks.connectorOverview },
}));

vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({
  OneKycClientZkService: {
    decryptScopedExport: vi.fn(),
    ensureConnector: vi.fn(),
    readStoredConnector: vi.fn(),
  },
}));

function mockCurrentGrant(requestId: string, bundleId: string, scopeRef = "scope-0") {
  const { request, exported } = currentGrantFixture(requestId, bundleId, scopeRef);
  mocks.getInformationRequest.mockResolvedValue(request);
  return exported;
}

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
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

vi.mock("@/components/ui/dialog", async (original) => {
  const actual = await original<typeof import("@/components/ui/dialog")>();
  return {
    ...actual,
    DialogPortal: (props: ComponentProps<typeof actual.DialogPortal>) => mocks.realDialogs ? <actual.DialogPortal {...props} /> : <>{props.children}</>,
    DialogOverlay: (props: ComponentProps<typeof actual.DialogOverlay>) => mocks.realDialogs ? <actual.DialogOverlay {...props} /> : <div data-testid="dialog-overlay" />,
    Dialog: (props: ComponentProps<typeof actual.Dialog>) => mocks.realDialogs ? <actual.Dialog {...props} /> : props.open === false ? null : <>{props.children}</>,
    DialogTrigger: (props: ComponentProps<typeof actual.DialogTrigger>) => mocks.realDialogs ? <actual.DialogTrigger {...props} /> : <>{props.children}</>,
    DialogContent: (props: ComponentProps<typeof actual.DialogContent>) => mocks.realDialogs ? <actual.DialogContent {...props} /> : <section>{props.children}</section>,
    DialogDescription: (props: ComponentProps<typeof actual.DialogDescription>) => mocks.realDialogs ? <actual.DialogDescription {...props} /> : <p>{props.children}</p>,
    DialogFooter: (props: ComponentProps<typeof actual.DialogFooter>) => mocks.realDialogs ? <actual.DialogFooter {...props} /> : <footer>{props.children}</footer>,
    DialogHeader: (props: ComponentProps<typeof actual.DialogHeader>) => mocks.realDialogs ? <actual.DialogHeader {...props} /> : <header>{props.children}</header>,
    DialogTitle: (props: ComponentProps<typeof actual.DialogTitle>) => mocks.realDialogs ? <actual.DialogTitle {...props} /> : <h2>{props.children}</h2>,
  };
});

vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: ({
    open,
    title,
    description,
  }: {
    open: boolean;
    title: string;
    description: string;
  }) =>
    open ? (
      <div data-testid="vault-unlock-dialog">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    ) : null,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
}));

vi.mock("@/lib/morphy-ux/ui/surface-primitives", () => ({
  AvatarBubble: () => <span data-testid="avatar" />,
  SectionCard: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
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

vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: async () => mocks.user?.getIdToken() ?? null },
}));
vi.mock("@/lib/services/answer-request-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/answer-request-service")>()),
  AnswerRequestService: { gates: mocks.answerGates, create: mocks.answerCreate },
}));

beforeEach(() => {
  CacheService.getInstance().clear();
  mocks.getRelationship.mockReset().mockImplementation(() => new Promise(() => {}));
  mocks.getVaultOwnerToken.mockReset().mockImplementation(() => mocks.vaultOwnerToken);
  mocks.realDialogs = false;
  mocks.answerGates.mockReset().mockResolvedValue({ requests: false, payments: false, payouts: false });
  mocks.answerCreate.mockReset();
  mocks.connectorOverview.mockReset().mockResolvedValue({ driveAgentPackagesEnabled: true });
});

import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { CacheService } from "@/lib/services/cache-service";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { PersonProfilePage } from "@/components/connections/person-profile-page";
import { CONNECTION_GRAPH_CHANGED_EVENT } from "@/lib/connections/connection-graph-events";

describe("PersonProfilePage native profile route", () => {
  beforeEach(() => {
    mocks.getPublic.mockResolvedValue({
      personRef: "actual-public-ref",
      displayName: "Actual Person",
      photoUrl: null,
      verifiedRole: null,
    });
    mocks.getViewer.mockResolvedValue(null);
    mocks.getRequestHistory.mockRejectedValue(
      new Error("History service unavailable in legacy fixture"),
    );
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

  it.each(["connected", "none", "pending_incoming", "pending_outgoing"])("shows contact details only for an accepted connection (%s)", async (status) => {
    mocks.user = { uid: "viewer", getIdToken: vi.fn().mockResolvedValue("viewer-token") };
    mocks.getViewer.mockResolvedValue(viewerProfile({
      relationship: { status, connectionId: null, connectedAt: null, requestId: null },
      contactEmail: "friend@example.test", contactPhoneNumber: "+919876543210",
    }));
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    await screen.findByLabelText("Relationship actions");
    await waitFor(() => expect(mocks.getViewer).toHaveBeenCalled());
    if (status === "connected") {
      const email = await screen.findByRole("link", { name: "friend@example.test" });
      const phone = screen.getByRole("link", { name: "+919876543210" });
      expect(phone).toHaveAttribute("href", "tel:+919876543210");
      expect(email.compareDocumentPosition(phone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } else {
      await screen.findByText(status === "none" ? "Not connected" : "Request pending");
      expect(screen.queryByText("friend@example.test")).toBeNull();
      expect(screen.queryByText("+919876543210")).toBeNull();
    }
  });

  it("finishes the authenticated profile read if the vault changes while loading", async () => {
    mocks.user = { uid: "viewer", getIdToken: vi.fn().mockResolvedValue("viewer-token") };
    let resolveViewer!: (value: unknown) => void;
    mocks.getViewer.mockImplementationOnce(() => new Promise(resolve => { resolveViewer = resolve; }));
    const rendered = render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    await waitFor(() => expect(mocks.getViewer).toHaveBeenCalledTimes(1));
    mocks.isVaultUnlocked = false;
    rendered.rerender(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    await act(async () => { resolveViewer(viewerProfile({ contactPhoneNumber: "+919876543210" })); });
    expect(await screen.findByRole("link", { name: "+919876543210" })).toHaveAttribute("href", "tel:+919876543210");
  });

  it("clears contact details on connection changes and ignores late profile reads", async () => {
    mocks.user = { uid: "viewer", getIdToken: vi.fn().mockResolvedValue("viewer-token") };
    const connected = viewerProfile({ contactEmail: "friend@example.test", contactPhoneNumber: "+919876543210" });
    let resolveOld!: (value: unknown) => void;
    mocks.getViewer.mockResolvedValueOnce(connected)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(viewerProfile({ relationship: { status: "none" } }));
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    await screen.findByRole("link", { name: "+919876543210" });
    const changed = (changedAt: number) => window.dispatchEvent(new CustomEvent(CONNECTION_GRAPH_CHANGED_EVENT, { detail: { userId: "viewer", changedAt } }));
    act(() => { changed(1); });
    expect(screen.queryByText("+919876543210")).toBeNull();
    await waitFor(() => expect(mocks.getViewer).toHaveBeenCalledTimes(2));
    act(() => { changed(2); });
    await screen.findByText("Not connected");
    await act(async () => { resolveOld(connected); });
    expect(screen.queryByText("+919876543210")).toBeNull();
    expect(screen.queryByText("friend@example.test")).toBeNull();
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
    expect(
      await screen.findByRole("heading", { name: "Actual Person" }),
    ).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("keeps the server-provided person ref outside native iOS", async () => {
    mocks.native = false;
    mocks.platform = "web";

    render(
      <PersonProfilePage personRef="server-public-ref" initialProfile={null} />,
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
    expect(
      document.querySelector('[data-avatar-size="profile"]'),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-photo-url="https://cdn.example.test/divya.jpg"]',
      ),
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
    expect(
      shareButton.querySelector(".inline-flex.items-center.gap-2"),
    ).not.toBeNull();
  });

  it("opens a direct message draft only for an accepted connection", async () => {
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

    expect(screen.queryByRole("button", { name: "Message" })).toBeNull();
    expect(mocks.push).not.toHaveBeenCalledWith(
      "/one/messages?person=actual-public-ref",
    );
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
    expect(screen.getByTestId("person-profile-scope-back")).toHaveTextContent(
      "All",
    );
  });

  it("renders Review request after History without sticky viewport positioning", async () => {
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
    const historyHeading = screen.getByRole("heading", {
      name: "Request history",
    });
    expect(reviewButton).toBeDisabled();
    const actions = document.querySelectorAll(
      '[aria-label="Relationship actions"] button',
    );
    expect(
      Array.from(
        actions,
        (button) =>
          button.getAttribute("aria-label") || button.textContent?.trim(),
      ),
    ).toEqual(["Request", "Share profile", "Ask about files", "Request a card", "Manage access"]);
    expect(reviewButton.parentElement).not.toHaveClass("sticky");
    expect(reviewButton.parentElement).not.toHaveClass("bottom-4");
    expect(
      historyHeading.compareDocumentPosition(reviewButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the four card actions reachable in reading order without changing their dialogs", async () => {
    mocks.realDialogs = true;
    mocks.user = { uid: "viewer", getIdToken: async () => "viewer-token" };
    mocks.vaultOwnerToken = "synthetic-owner-token";
    mocks.connectorOverview.mockResolvedValue({ features: { drive_document_sharing: true }, driveAgentPackagesEnabled: false });
    mocks.getViewer.mockResolvedValue(viewerProfile());
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    const actions = await screen.findByLabelText("Relationship actions");
    await within(actions).findByRole("button", { name: "Ask about files", exact: true });
    const labels = ["Request files", "Ask about files", "Ask a question", "Request a card"];
    const cards = labels.map((name) => within(actions).getByRole("button", { name, exact: true }));
    expect(cards.every((card) => card.parentElement === cards[0].parentElement)).toBe(true);
    expect(Array.from(actions.querySelectorAll("button"), (button) => button.getAttribute("aria-label") || button.textContent?.trim()))
      .toEqual(["Request", "Share profile", ...labels, "Manage access"]);
    fireEvent.click(cards[0]);
    expect(await screen.findByRole("dialog", { name: "Request files", exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(cards[1]);
    expect(await screen.findByRole("dialog", { name: "Ask about files" })).toBeVisible();
  });

  it("sends one eligible Professional root request instead of twelve child requests", async () => {
    const { PersonProfileService } =
      await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } =
      await import("@/lib/services/one-kyc-client-zk-service");
    mocks.user = {
      uid: "viewer",
      getIdToken: vi.fn().mockResolvedValue("viewer-token"),
    };
    mocks.vaultKey = "synthetic-vault-key";
    mocks.vaultOwnerToken = "synthetic-owner-token";
    (
      OneKycClientZkService.ensureConnector as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ connector_key_id: "synthetic-connector" });
    (
      PersonProfileService.createInformationRequest as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ bundleId: "synthetic-bundle" });
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        requestableScopes: [
          {
            scopeRef: "opaque-professional-root",
            label: "Professional Domain",
            description: null,
            domain: "professional",
            sensitivity: "standard",
            wildcard: true,
            pathSegments: [],
          },
          ...Array.from({ length: 12 }, (_, index) => ({
            scopeRef: `opaque-professional-child-${index}`,
            label: `Professional detail ${index + 1}`,
            description: null,
            domain: "professional",
            sensitivity: "standard",
            wildcard: false,
            pathSegments: ["details", `item_${index + 1}`],
          })),
        ],
      }),
    );
    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Open Professional" }),
    );
    fireEvent.click(
      screen.getByTestId("person-profile-scope-group-toggle-professional"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review request (1)" }));
    expect(
      screen.getByText(
        "This includes all available information in this area, not just one detail.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("person-profile-purpose"), {
      target: { value: "Review synthetic professional information" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() =>
      expect(
        PersonProfileService.createInformationRequest,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          personRef: "actual-public-ref",
          scopeRefs: ["opaque-professional-root"],
        }),
      ),
    );
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

    fireEvent.click(
      await screen.findByRole("button", { name: "Open Financial" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Risk profile/ }));
    const reviewButton = await screen.findByRole("button", {
      name: "Review request (1)",
    });
    fireEvent.click(reviewButton);

    expect(
      screen.queryByRole("button", { name: "Send request" }),
    ).not.toBeInTheDocument();
    const { toast } = await import("sonner");
    expect(toast.error).toHaveBeenCalledWith(
      "Your vault is still getting ready. Try again in a moment.",
    );
  });
});

describe("PersonProfilePage request catalog tools", () => {
  it("distinguishes an unavailable catalog from an empty one and allows retry", async () => {
    mocks.getViewer.mockRejectedValueOnce(new Error("temporary failure"));
    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );
    // The retry card carries the shipped copy ("We couldn't load your connection
    // with <name> right now") and stays identity-scoped to this viewer.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "couldn’t load your connection",
    );
    expect(
      screen.queryByRole("heading", { name: "Available to request" }),
    ).not.toBeInTheDocument();
    mocks.getViewer.mockResolvedValue(viewerProfile());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Available to request" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not reuse the previous viewer's catalog while another account loads", async () => {
    const { rerender } = render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );
    await screen.findByRole("heading", { name: "Available to request" });
    mocks.user = {
      uid: "different-viewer",
      getIdToken: async () => "different-token",
    };
    mocks.getViewer.mockImplementation(() => new Promise(() => {}));
    rerender(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );
    expect(
      screen.queryByRole("heading", { name: "Available to request" }),
    ).not.toBeInTheDocument();
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
    mocks.getViewer.mockResolvedValue(
      viewerProfile({ requestableScopes: manyScopes(9) }),
    );
    mocks.getRequestHistory.mockRejectedValue(
      new Error("History service unavailable in legacy fixture"),
    );
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
    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );

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
    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );

    const professional = await screen.findByRole("button", {
      name: "Open Professional",
    });
    expect(screen.queryByText("Employment status")).toBeNull();

    fireEvent.click(professional);
    expect(screen.getByText("Employment status")).toBeTruthy();
    expect(screen.queryByText("Field 1")).toBeNull(); // lives under the other area

    fireEvent.click(screen.getByTestId("person-profile-scope-back"));
    expect(screen.queryByText("Employment status")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open Professional" }),
    ).toBeTruthy();

    // Search reaches a leaf without navigating to it.
    const search = screen.getByTestId("person-profile-scope-search");
    fireEvent.change(search, { target: { value: "employment" } });
    expect(screen.getByText("Employment status")).toBeTruthy();

    fireEvent.change(search, { target: { value: "zzz-nothing" } });
    expect(screen.getByTestId("person-profile-scope-no-match")).toBeTruthy();

    fireEvent.change(search, { target: { value: "" } });
    expect(
      screen.getByRole("button", { name: "Open Professional" }),
    ).toBeTruthy();
  });

  it("retains a request draft through consent bookkeeping but invalidates it on a real change", async () => {
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Professional" }));
    fireEvent.click(screen.getByTestId("person-profile-scope-toggle-scope-0"));
    fireEvent.click(screen.getByRole("button", { name: "Review request (1)" }));
    fireEvent.change(screen.getByTestId("person-profile-purpose"), {
      target: { value: "Review synthetic employment details" },
    });
    const reads = mocks.getViewer.mock.calls.length;
    for (const source of ["cached_pending", "queued_pending", "hydrated_pending", "fallback_reconciled", "fcm_opened"]) {
      act(() => dispatchConsentStateChanged({ source }));
      expect(screen.getByTestId("person-profile-purpose")).toHaveValue("Review synthetic employment details");
      expect(screen.getByRole("button", { name: "Review request (1)" })).toBeEnabled();
      expect(screen.getByTestId("person-profile-scope-back")).toBeInTheDocument();
      expect(mocks.getViewer).toHaveBeenCalledTimes(reads);
    }

    let resolveRefresh!: (value: ReturnType<typeof viewerProfile>) => void;
    mocks.getViewer.mockReturnValueOnce(new Promise(resolve => { resolveRefresh = resolve; }));
    // Explicit mutations still win even if a caller reuses a bookkeeping source.
    act(() => dispatchConsentStateChanged({ source: "fallback_reconciled", action: "revoke" }));
    await waitFor(() => expect(mocks.getViewer).toHaveBeenCalledTimes(reads + 1));
    expect(screen.queryByTestId("person-profile-purpose")).not.toBeInTheDocument();
    expect(screen.queryByTestId("person-profile-scope-toggle-scope-0")).not.toBeInTheDocument();
    await act(async () => { resolveRefresh(viewerProfile({ requestableScopes: manyScopes(9).slice(1) })); });
    expect(await screen.findByRole("button", { name: "Review request" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Open Professional" }));
    expect(screen.queryByTestId("person-profile-scope-toggle-scope-0")).not.toBeInTheDocument();
  });

  it("offers an access duration inside the review sheet and sends it in hours", async () => {
    const { PersonProfileService } =
      await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } =
      await import("@/lib/services/one-kyc-client-zk-service");
    (
      OneKycClientZkService.ensureConnector as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ connector_key_id: "ck_1" });
    (
      PersonProfileService.createInformationRequest as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ bundleId: "b1" });
    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Professional" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Employment status/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /Review request \(1\)/ }),
    );
    const sendRequest = screen.getByRole("button", { name: "Send request" });
    expect(sendRequest).toBeDisabled();
    const duration = screen.getByTestId(
      "person-profile-duration-select",
    ) as HTMLSelectElement;
    expect(duration.value).toBe("168");
    fireEvent.change(duration, { target: { value: "24" } });
    // The sheet no longer recites the duration; it says what the other person
    // will see, in the owner's words, and the select carries the number.
    expect(
      screen.getByText(
        "They will see exactly what you asked for, why, and for how long.",
      ),
    ).toBeTruthy();
    expect(duration.value).toBe("24");
    fireEvent.change(screen.getByTestId("person-profile-purpose"), {
      target: { value: "Checking references for a role" },
    });
    expect(sendRequest).toBeEnabled();
    fireEvent.click(sendRequest);
    await waitFor(() =>
      expect(
        PersonProfileService.createInformationRequest,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          durationSeconds: 24 * 3600,
          scopeRefs: ["scope-0"],
        }),
      ),
    );
  });

  it("marks already shared fields as unavailable for a duplicate request", async () => {
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        requestableScopes: manyScopes(2),
        grants: [
          {
            scopeRef: "scope-0",
            label: "Employment status",
            domain: "professional",
            requestId: "req-shared",
            issuedAt: null,
            expiresAt: null,
            status: "granted",
            encryptedExportAvailable: true,
          },
        ],
      }),
    );

    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Open Professional" }),
    );
    const sharedField = screen.getByRole("checkbox", {
      name: "Employment status",
    });
    expect(sharedField).toBeDisabled();
  });

  it("opens a shared record in the secure card and copies one value, confirmed in one word", async () => {
    const { PersonProfileService } =
      await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } =
      await import("@/lib/services/one-kyc-client-zk-service");
    const { toast } = await import("sonner");
    (
      OneKycClientZkService.readStoredConnector as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ connector_key_id: "ck_1" });
    (
      PersonProfileService.getInformationRequestExports as ReturnType<
        typeof vi.fn
      >
    ).mockResolvedValue([mockCurrentGrant("req-grant", "bundle-grant")]);
    (
      OneKycClientZkService.decryptScopedExport as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ city: "Pune" });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardBefore = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
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

      render(
        <PersonProfilePage
          personRef="actual-public-ref"
          initialProfile={null}
        />,
      );

      const value = await screen.findByTestId("shared-with-you-values");
      expect(value).toHaveTextContent("Pune");
      expect(
        screen.getByText(
          /End-to-end encrypted information shared with your account/,
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText("Zero-knowledge verified")).toBeNull();
      // The same card as chat: no raw record, no JSON control, no grant wording.
      expect(screen.queryByRole("button", { name: /json/i })).toBeNull();
      expect(
        screen.getByTestId("shared-with-you-card").textContent,
      ).not.toMatch(/grant|domain|scope/i);

      fireEvent.click(screen.getByRole("button", { name: "Copy City" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("Pune"));
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith("Copied", expect.anything()),
      );
    } finally {
      // Put the stub back so it cannot leak into a later test in this file.
      if (clipboardBefore) {
        Object.defineProperty(navigator, "clipboard", clipboardBefore);
      } else {
        delete (navigator as { clipboard?: unknown }).clipboard;
      }
    }
  });

  it("does not decrypt a late export after the vault locks", async () => {
    const { PersonProfileService } =
      await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } =
      await import("@/lib/services/one-kyc-client-zk-service");
    mockCurrentGrant("req-late", "bundle-late");
    (
      OneKycClientZkService.readStoredConnector as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ connector_key_id: "ck_1" });
    let resolveExports!: (value: unknown[]) => void;
    (
      PersonProfileService.getInformationRequestExports as ReturnType<
        typeof vi.fn
      >
    ).mockReturnValue(
      new Promise((done) => {
        resolveExports = done;
      }),
    );
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        grants: [
          {
            bundleId: "bundle-late",
            scopeRef: "scope-0",
            label: "Synthetic detail",
            domain: "Professional",
            requestId: "req-late",
            issuedAt: null,
            expiresAt: null,
            status: "granted",
            encryptedExportAvailable: true,
            exportRevision: 1,
          },
        ],
        requestHistory: [],
      }),
    );
    const view = render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );
    await waitFor(() =>
      expect(
        PersonProfileService.getInformationRequestExports,
      ).toHaveBeenCalled(),
    );
    mocks.isVaultUnlocked = false;
    view.rerender(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );
    await act(async () => resolveExports([]));
    expect(OneKycClientZkService.decryptScopedExport).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("shared-with-you-values"),
    ).not.toBeInTheDocument();
  });

  it("unwraps the domain envelope before rendering an encrypted grant", async () => {
    const { PersonProfileService } =
      await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } =
      await import("@/lib/services/one-kyc-client-zk-service");
    (
      OneKycClientZkService.readStoredConnector as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ connector_key_id: "ck_1" });
    (
      PersonProfileService.getInformationRequestExports as ReturnType<
        typeof vi.fn
      >
    ).mockResolvedValue([mockCurrentGrant("req-domain", "bundle-domain")]);
    (
      OneKycClientZkService.decryptScopedExport as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      professional: { summary: "Synthetic approved detail" },
      __export_metadata: { source_domain: "professional" },
    });
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        requestableScopes: manyScopes(2),
        grants: [
          {
            scopeRef: "scope-0",
            label: "Professional detail",
            domain: "Professional",
            requestId: "req-domain",
            issuedAt: null,
            expiresAt: null,
            status: "granted",
            encryptedExportAvailable: true,
          },
        ],
        requestHistory: [
          {
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
          },
        ],
      }),
    );

    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );

    expect(
      await screen.findByTestId("shared-with-you-values"),
    ).toHaveTextContent("Synthetic approved detail");
  });

  it("opens an old active grant from its bound bundle even after recent history is truncated", async () => {
    const { PersonProfileService } =
      await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } =
      await import("@/lib/services/one-kyc-client-zk-service");
    (
      OneKycClientZkService.readStoredConnector as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ connector_key_id: "ck_1" });
    (
      PersonProfileService.getInformationRequestExports as ReturnType<
        typeof vi.fn
      >
    ).mockResolvedValue([mockCurrentGrant("req-old", "bundle-old")]);
    (
      OneKycClientZkService.decryptScopedExport as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      professional: { role: "Synthetic reviewer" },
    });
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        grants: [
          {
            bundleId: "bundle-old",
            scopeRef: "scope-0",
            label: "Professional role",
            domain: "Professional",
            requestId: "req-old",
            issuedAt: null,
            expiresAt: null,
            status: "granted",
            encryptedExportAvailable: true,
            exportRevision: 1,
          },
        ],
        requestHistory: [],
      }),
    );
    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );
    expect(
      await screen.findByTestId("shared-with-you-values"),
    ).toHaveTextContent("Synthetic reviewer");
    expect(
      PersonProfileService.getInformationRequestExports,
    ).toHaveBeenCalledWith({
      bundleId: "bundle-old",
      vaultOwnerToken: "owner-token",
    });
    mocks.getViewer.mockResolvedValue(
      viewerProfile({ grants: [], requestHistory: [] }),
    );
    act(() => window.dispatchEvent(new Event("consent-state-changed")));
    await waitFor(() =>
      expect(screen.queryByTestId("shared-with-you-values")).toBeNull(),
    );
  });

  it("keeps nested approved summaries visible in an encrypted grant", async () => {
    const { PersonProfileService } =
      await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } =
      await import("@/lib/services/one-kyc-client-zk-service");
    (
      OneKycClientZkService.readStoredConnector as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ connector_key_id: "ck_1" });
    (
      PersonProfileService.getInformationRequestExports as ReturnType<
        typeof vi.fn
      >
    ).mockResolvedValue([mockCurrentGrant("req-nested", "bundle-nested")]);
    (
      OneKycClientZkService.decryptScopedExport as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      professional: { profile: { summary: "Synthetic nested detail" } },
      __export_metadata: { source_domain: "professional" },
    });
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        requestableScopes: manyScopes(2),
        grants: [
          {
            scopeRef: "scope-0",
            label: "Professional detail",
            domain: "Professional",
            requestId: "req-nested",
            issuedAt: null,
            expiresAt: null,
            status: "granted",
            encryptedExportAvailable: true,
          },
        ],
        requestHistory: [
          {
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
          },
        ],
      }),
    );

    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );

    expect(
      await screen.findByTestId("shared-with-you-values"),
    ).toHaveTextContent("Synthetic nested detail");
  });

  it("keeps a backend detail out of the card when shared information cannot be opened", async () => {
    const { PersonProfileService } =
      await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } =
      await import("@/lib/services/one-kyc-client-zk-service");
    const { toast } = await import("sonner");
    (
      OneKycClientZkService.readStoredConnector as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ connector_key_id: "ck_1" });
    mockCurrentGrant("req-grant-fail", "bundle-grant");
    (
      PersonProfileService.getInformationRequestExports as ReturnType<
        typeof vi.fn
      >
    ).mockRejectedValue(
      new Error(
        "psycopg2.errors.UndefinedColumn: column consent_exports.sealed does not exist",
      ),
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

    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("shared-with-you-card")).toHaveAttribute(
        "data-status",
        "error",
      ),
    );
    const shown = screen.getByTestId("shared-with-you-card").textContent ?? "";
    expect(shown).toContain("couldn’t be opened");
    expect(shown).not.toMatch(/psycopg2|column|export/i);
    expect(
      JSON.stringify((toast.error as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toMatch(/psycopg2|column/i);
    expect(screen.queryByTestId("shared-with-you-values")).toBeNull();
  });

  it("stops automatic grant retries after a bounded failure and leaves a manual retry", async () => {
    const { PersonProfileService } =
      await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } =
      await import("@/lib/services/one-kyc-client-zk-service");
    const { toast } = await import("sonner");
    mocks.user = {
      uid: "viewer",
      getIdToken: vi.fn().mockResolvedValue("viewer-token"),
    };
    mocks.vaultKey = "vault-key";
    mocks.vaultOwnerToken = "owner-token";
    (
      OneKycClientZkService.readStoredConnector as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ connector_key_id: "ck_1" });
    mockCurrentGrant("req-grant-fail", "bundle-grant");
    (
      PersonProfileService.getInformationRequestExports as ReturnType<
        typeof vi.fn
      >
    ).mockRejectedValue(
      new Error(
        "psycopg2.errors.SerializationFailure: temporary export failure",
      ),
    );
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        grants: [
          {
            scopeRef: "scope-0",
            label: "City",
            domain: "location",
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

    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("shared-with-you-card")).toHaveAttribute(
        "data-status",
        "error",
      ),
    );
    // One calm retry the person chooses; the card never loops on its own.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(
      PersonProfileService.getInformationRequestExports,
    ).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        PersonProfileService.getInformationRequestExports,
      ).toHaveBeenCalledTimes(2),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("brings the requestable catalog into view when opened with ?request=1", async () => {
    mocks.search = "request=1";
    const scrolled = vi.fn();
    vi.spyOn(window.HTMLElement.prototype, "scrollIntoView").mockImplementation(scrolled);
    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );
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
      items: [
        {
          requestId: "req-1",
          scopeRef: "scope-0",
          label: "Employment status",
          sensitivity: "standard",
          status: "pending",
        },
      ],
    });
    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Details for Employment status",
      }),
    );
    expect(
      await screen.findByTestId("person-profile-bundle-details"),
    ).toHaveTextContent("Employment status (waiting) · 7 days");
  });

  // Localhost run 4 (S3): the history read "Tax Record Domain" beside a raw "granted" pill.
  it("names a history row and its state in human words, never a machine label or state", async () => {
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        requestHistory: [
          {
            bundleId: "bundle-tax",
            requestId: "req-tax",
            scopeRef: "scope-tax",
            label: "Tax Record Domain",
            sensitivity: "sensitive",
            purpose: "To ensure information sharing works",
            durationSeconds: 7 * 24 * 3600,
            createdAt: null,
            expiresAt: null,
            status: "granted",
          },
        ],
      }),
    );
    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );
    expect(await screen.findByText("Tax record")).toBeInTheDocument();
    expect(screen.getByText("Shared")).toBeInTheDocument();
    const history = screen
      .getByRole("heading", { name: "Request history" })
      .closest("section")!;
    expect(history.textContent).not.toMatch(/domain|granted/i);
  });

  it("groups a multi-field request into one history row with one action", async () => {
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
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
      }),
    );
    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );

    expect(
      await screen.findByText("Professional detail 1 and 11 more"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", {
        name: "Details for Professional detail 1 and 11 more",
      }),
    ).toHaveLength(1);
    expect(screen.queryByText("Professional detail 2")).toBeNull();
  });

  it("pages request bundles instead of growing the history indefinitely", async () => {
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
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
      }),
    );
    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );

    expect(await screen.findByText("History item 1")).toBeInTheDocument();
    expect(screen.queryByText("History item 9")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("History item 9")).toBeInTheDocument();
    expect(screen.queryByText("History item 1")).toBeNull();
  });

  it("uses server bundle pages so a large request is never truncated into smaller history rows", async () => {
    mocks.getViewer.mockResolvedValue(viewerProfile({ requestHistory: [] }));
    mocks.getRequestHistory.mockImplementation(
      async ({ cursor }: { cursor?: string }) =>
        cursor
          ? {
              bundles: [
                {
                  bundleId: "older",
                  purpose: "Older request",
                  durationSeconds: 3600,
                  createdAt: "2026-09-19T10:00:00+00:00",
                  cancelled: false,
                  itemCount: 2,
                },
              ],
              nextCursor: null,
            }
          : {
              bundles: [
                {
                  bundleId: "large",
                  purpose: "Professional review",
                  durationSeconds: 3600,
                  createdAt: "2026-09-20T10:00:00+00:00",
                  cancelled: false,
                  itemCount: 150,
                },
              ],
              nextCursor: "next-page",
            },
    );
    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );
    expect(await screen.findByText("150 items")).toBeInTheDocument();
    expect(screen.getByText("Check status")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("2 items")).toBeInTheDocument();
    expect(screen.queryByText("150 items")).toBeNull();
    expect(mocks.getRequestHistory).toHaveBeenLastCalledWith({
      personRef: "actual-public-ref",
      idToken: "id-token",
      cursor: "next-page",
      limit: 8,
    });
  });

  // Run 4 (S3/U3): a grouped request on a later page read "2 items". The
  // server now names the request's items, and the row says what was asked for.
  it("titles a server history row by the item labels the server sends", async () => {
    mocks.getViewer.mockResolvedValue(viewerProfile({ requestHistory: [] }));
    mocks.getRequestHistory.mockResolvedValue({
      bundles: [
        {
          bundleId: "named",
          purpose: "Preparing the joint return",
          durationSeconds: 3600,
          createdAt: "2026-09-20T10:00:00+00:00",
          cancelled: false,
          itemCount: 2,
          itemLabels: ["Tax record", "Portfolio"],
        },
        // Negative control: a row with no labels keeps its count.
        {
          bundleId: "unnamed",
          purpose: "Older request",
          durationSeconds: 3600,
          createdAt: "2026-09-19T10:00:00+00:00",
          cancelled: false,
          itemCount: 3,
        },
      ],
      nextCursor: null,
    });
    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );
    expect(
      await screen.findByText("Tax record and Portfolio"),
    ).toBeInTheDocument();
    expect(screen.queryByText("2 items")).toBeNull();
    expect(screen.getByText("3 items")).toBeInTheDocument();
  });

  it("does not display details returned for another person", async () => {
    const { toast } = await import("sonner");
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        requestHistory: [
          {
            bundleId: "bundle-1",
            requestId: "request-1",
            scopeRef: "scope-1",
            label: "Employment status",
            sensitivity: "standard",
            purpose: "Checking references",
            durationSeconds: 3600,
            createdAt: null,
            expiresAt: null,
            status: "pending",
          },
        ],
      }),
    );
    mocks.getInformationRequest.mockResolvedValue({
      personRef: "another-person",
      bundleId: "bundle-1",
      items: [],
    });
    render(
      <PersonProfilePage personRef="actual-public-ref" initialProfile={null} />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Details for Employment status",
      }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByTestId("person-profile-bundle-details")).toBeNull();
  });

  it("marks already-granted scopes as preselected, locked with Granted badge, and excludes them from review count", async () => {
    const scopes = manyScopes(3);
    mocks.getViewer.mockResolvedValue(
      viewerProfile({
        requestableScopes: scopes,
        grants: [
          {
            scopeRef: scopes[0].scopeRef,
            label: scopes[0].label,
            domain: scopes[0].domain,
            requestId: "req-already-granted",
            issuedAt: null,
            expiresAt: null,
            status: "granted",
          },
        ],
      }),
    );
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Professional" }));

    // Look for Granted badge for the already-granted scope
    expect(await screen.findByTestId(`person-profile-scope-badge-granted-${scopes[0].scopeRef}`)).toHaveTextContent("Granted");
    const grantedCheckbox = screen.getByTestId(`person-profile-scope-toggle-${scopes[0].scopeRef}`) as HTMLInputElement;
    expect(grantedCheckbox.checked).toBe(true);
    expect(grantedCheckbox.disabled).toBe(true);

    // Review request button should be disabled because 0 ungranted scopes are selected
    const reviewBtn = screen.getByRole("button", { name: /^Review request/ });
    expect(reviewBtn).toBeDisabled();

    // Selecting an ungranted scope (scope-2 is also in Professional) enables Review request with count 1
    const ungrantedCheckbox = screen.getByTestId(`person-profile-scope-toggle-${scopes[2].scopeRef}`);
    fireEvent.click(ungrantedCheckbox);
    expect(screen.getByRole("button", { name: "Review request (1)" })).toBeEnabled();
  });

  it("scrolls to shared section and prompts vault unlock when visiting with ?section=shared while vault is locked", async () => {
    mocks.search = "section=shared";
    mocks.isVaultUnlocked = false;
    mocks.vaultKey = null;
    mocks.vaultOwnerToken = null;
    const scrolled = vi.fn();
    vi.spyOn(window.HTMLElement.prototype, "scrollIntoView").mockImplementation(scrolled);

    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    await screen.findByRole("heading", { name: "Shared with you" });
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    expect(await screen.findByText("Unlock your private agent to reveal information shared with you.")).toBeInTheDocument();
    vi.mocked(window.HTMLElement.prototype.scrollIntoView).mockRestore();
  });
});

describe("Request scope during profile authority refresh", () => {
  const requestId = "33333333-3333-4333-8333-333333333333";
  const initialProfile = { personRef: "actual-public-ref", displayName: "Actual Person", photoUrl: null, verifiedRole: null };
  beforeEach(() => {
    mocks.realDialogs = true;
    mocks.native = false;
    mocks.platform = "web";
    mocks.user = { uid: "viewer", getIdToken: async () => "viewer-token" };
    mocks.authLoading = false;
    mocks.search = "";
    mocks.isVaultUnlocked = true;
    mocks.vaultKey = "test-vault-key";
    mocks.vaultOwnerToken = "test-owner-token";
    mocks.getViewer.mockReset().mockResolvedValue(viewerProfile());
    mocks.getRequestHistory.mockResolvedValue({ bundles: [], hasMore: false, nextCursor: null });
    mocks.answerGates.mockResolvedValue({ requests: true, payments: false, payouts: false });
    mocks.answerCreate.mockReset();
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.realDialogs = false; });

  async function openQuestion() {
    const rendered = render(<PersonProfilePage personRef="actual-public-ref" initialProfile={initialProfile} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask a question", exact: true }));
    fireEvent.change(await screen.findByLabelText("Your question"), { target: { value: "What are your food preferences?" } });
    return rendered;
  }
  function answerDoorbell() {
    dispatchConsentStateChanged({ userId: "viewer", source: "answer_request_changed", requestId: `answer_request:${requestId}`, messageId: `pkm_answer_requests:${requestId}:awaiting_owner:synthetic-timestamp` });
  }

  it("admits connected actions while the complete catalog is still loading", async () => {
    mocks.getRelationship.mockResolvedValue(viewerProfile().relationship);
    mocks.getViewer.mockReturnValue(new Promise(() => {}));
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={initialProfile} />);
    expect(await screen.findByText("Connected")).toBeVisible();
    expect(screen.getByRole("region", { name: "Loading profile details" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Ask a question", exact: true }));
    const field = await screen.findByLabelText("Your question");
    fireEvent.change(field, { target: { value: "What are your food preferences?" } });
    expect(screen.getByRole("button", { name: "Send request", exact: true })).toBeEnabled();
    expect(mocks.answerCreate).not.toHaveBeenCalled();
  });

  it("converges lightweight readiness on the complete relationship snapshot", async () => {
    mocks.getRelationship.mockResolvedValue(viewerProfile().relationship);
    let finish!: (value: ReturnType<typeof viewerProfile>) => void;
    mocks.getViewer.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={initialProfile} />);
    expect(await screen.findByText("Connected")).toBeVisible();
    await act(async () => { finish(viewerProfile({ relationship: { status: "none" }, contactEmail: "old@example.test" })); });
    expect(await screen.findByText("Not connected")).toBeVisible();
    expect(screen.queryByRole("link", { name: "old@example.test" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask a question", exact: true })).toBeNull();
  });

  it.each(["connected", "disconnected", "failed"])("retains accepted confirmation through a %s connection refresh", async (outcome) => {
    let accept!: (value: { requestId: string }) => void;
    let refresh!: (value: ReturnType<typeof viewerProfile>) => void;
    let rejectRefresh!: (error: Error) => void;
    mocks.answerCreate.mockReturnValue(new Promise((resolve) => { accept = resolve; }));
    await openQuestion();
    fireEvent.click(screen.getByRole("button", { name: "Send request", exact: true }));
    await waitFor(() => expect(mocks.answerCreate).toHaveBeenCalledWith("viewer-token", "actual-public-ref", { question: "What are your food preferences?" }, expect.objectContaining({ clientRequestId: expect.any(String), isEffectCurrent: expect.any(Function) })));
    mocks.getViewer.mockReturnValueOnce(new Promise((resolve, reject) => { refresh = resolve; rejectRefresh = reject; }));
    act(answerDoorbell);
    await waitFor(() => expect(mocks.getViewer).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Ask a question", exact: true })).toBeNull();
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    await act(async () => { accept({ requestId }); });
    expect(await screen.findByText(/Request sent\./)).toBeVisible();
    expect(screen.getByRole("link", { name: "View request" })).toHaveAttribute("href", expect.stringContaining(requestId));
    expect(screen.getByRole("button", { name: "Ask another question" })).toBeDisabled();
    await act(async () => {
      if (outcome === "failed") rejectRefresh(new Error("Connection refresh unavailable"));
      else refresh(viewerProfile(outcome === "disconnected" ? { relationship: { status: "none" } } : {}));
    });
    const another = screen.getByRole("button", { name: "Ask another question" });
    if (outcome === "connected") expect(another).toBeEnabled();
    else expect(another).toBeDisabled();
    expect(screen.getByText(/Request sent\./)).toBeVisible();
    expect(mocks.answerCreate).toHaveBeenCalledTimes(1);
  });

  it("blocks a new submission while connection authority is unknown or removed", async () => {
    await openQuestion();
    let refresh!: (value: ReturnType<typeof viewerProfile>) => void;
    mocks.getViewer.mockReturnValueOnce(new Promise((resolve) => { refresh = resolve; }));
    act(answerDoorbell);
    await waitFor(() => expect(mocks.getViewer).toHaveBeenCalledTimes(2));
    const send = screen.getByRole("button", { name: "Send request", exact: true });
    expect(screen.getByLabelText("Your question")).toHaveValue("What are your food preferences?");
    expect(send).toBeDisabled();
    fireEvent.submit(send.closest("form")!);
    expect(mocks.answerCreate).not.toHaveBeenCalled();
    await act(async () => { refresh(viewerProfile({ relationship: { status: "none" } })); });
    expect(send).toBeDisabled();
    fireEvent.submit(send.closest("form")!);
    expect(mocks.answerCreate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: "Ask a question", exact: true })).toBeNull();
    expect(screen.getByRole("button", { name: "Share profile" })).toHaveFocus();
  });

  it("returns focus to the stable profile action when dismissed during a refresh", async () => {
    await openQuestion();
    mocks.getViewer.mockReturnValueOnce(new Promise(() => {}));
    act(answerDoorbell);
    await waitFor(() => expect(mocks.getViewer).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Your question")).toHaveValue("What are your food preferences?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Share profile" })).toHaveFocus();
  });

  it.each(["account", "person"])(
    "discards the accepted request dialog when its %s changes",
    async (change) => {
      mocks.answerCreate.mockResolvedValue({ requestId });
      const rendered = await openQuestion();
      fireEvent.click(screen.getByRole("button", { name: "Send request", exact: true }));
      await screen.findByText(/Request sent\./);

      if (change === "account") {
        mocks.user = { uid: "another-viewer", getIdToken: async () => "another-token" };
      }
      const personRef = change === "person" ? "other-public-ref" : "actual-public-ref";
      const nextProfile = { ...initialProfile, personRef };
      mocks.getPublic.mockResolvedValue(nextProfile);
      mocks.getViewer.mockResolvedValue(viewerProfile({ personRef }));
      rendered.rerender(<PersonProfilePage personRef={personRef} initialProfile={nextProfile} />);

      await waitFor(() => expect(screen.queryByText(/Request sent\./)).toBeNull());
      expect(screen.queryByRole("link", { name: "View request" })).toBeNull();
      fireEvent.click(await screen.findByRole("button", { name: "Ask a question", exact: true }));
      expect(await screen.findByLabelText("Your question")).toHaveValue("");
      expect(mocks.answerCreate).toHaveBeenCalledTimes(1);
    },
  );
});

describe("PersonProfilePage packets a connection has listed", () => {
  // Synthetic: one listed packet, as a buyer's list receives it.
  const listed = { packetId: "00000001-3333-4333-8333-333333333333", version: 2, listingRevision: 1,
    title: "Example Bank statements", description: "Monthly statements for one synthetic account.", state: "ready",
    coverageSummary: "January to June 2026", gaps: [], documentCount: 3, verifiedAt: null, freshness: "current",
    assessmentScore: 95, importance: 100, suggestedPriceCents: 1234, priceCents: 1234, listingEnabled: true,
    canRequest: true, canList: false };

  beforeEach(() => {
    mocks.getPublic.mockResolvedValue({ personRef: "actual-public-ref", displayName: "Actual Person", photoUrl: null, verifiedRole: null });
    mocks.getViewer.mockResolvedValue(viewerProfile());
    mocks.getRequestHistory.mockRejectedValue(new Error("History service unavailable in legacy fixture"));
    mocks.pathname = "/people/actual-public-ref";
    mocks.native = false;
    mocks.platform = "web";
    mocks.user = { uid: "viewer-1", getIdToken: async () => "id-token" };
    mocks.authLoading = false;
    mocks.isVaultUnlocked = true;
    mocks.search = "";
    mocks.vaultKey = "vault-key";
    mocks.vaultOwnerToken = "owner-token";
    publishValidatedAuthSessionOwner("viewer-1");
    mocks.packets.mockReset().mockImplementation(async (_token: string, guard: () => void) => {
      guard();
      return { packets: [listed], nextCursor: null };
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    publishValidatedAuthSessionOwner(null);
  });

  it.each(["legacy", "period"])("shows listed packets through the %s availability flag", async (feature) => {
    mocks.connectorOverview.mockResolvedValue({ driveAgentPackagesEnabled: feature === "legacy", features: { drive_period_packets: feature === "period" } });
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    const list = await screen.findByRole("region", { name: "Available document packets" });
    const row = await within(list).findByRole("button", { name: /^Example Bank statements/ });
    expect(row).toHaveTextContent("3 documents · January to June 2026");
    expect(row).toHaveTextContent("$12.34");
    expect(mocks.packets).toHaveBeenCalledWith("owner-token", expect.any(Function), "actual-public-ref", undefined);
    expect(list.parentElement?.closest("section")).toBeNull();
    fireEvent.click(row);
    expect(await screen.findByText("You pay after Actual Person approves.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buy for $12.34" })).toBeInTheDocument();
  });

  it("does not offer new packet purchases when agent packages are disabled", async () => {
    mocks.connectorOverview.mockResolvedValue({ driveAgentPackagesEnabled: false });
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    await waitFor(() => expect(mocks.connectorOverview).toHaveBeenCalledWith("owner-token"));
    expect(screen.queryByRole("button", { name: "Available packets" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Available document packets" })).toBeNull();
    expect(mocks.packets).not.toHaveBeenCalled();
  });
});
