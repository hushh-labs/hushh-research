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
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
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

  it("aligns requestable scope pills in a stable trailing column", async () => {
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
    const scopeRows = document.querySelectorAll('button[aria-pressed="false"]');
    expect(scopeRows).toHaveLength(2);
    for (const row of scopeRows) {
      expect(row).toHaveClass("grid");
      expect(row).toHaveClass("items-center");
      expect(row).toHaveClass("grid-cols-[minmax(0,1fr)_auto]");
      expect(row).not.toHaveClass("items-start");
      expect(row.querySelector(".justify-self-end")).not.toBeNull();
    }
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
});

describe("PersonProfilePage request catalog tools", () => {
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

  it("filters a long catalog by search text and domain chips, and clears back", async () => {
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    const search = await screen.findByTestId("person-profile-scope-search");
    expect(screen.getByTestId("person-profile-scope-count")).toHaveTextContent("9 of 9 fields");
    fireEvent.change(search, { target: { value: "employment" } });
    expect(screen.getByTestId("person-profile-scope-count")).toHaveTextContent("1 of 9 fields");
    expect(screen.getByRole("button", { name: /Employment status/ })).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("person-profile-domain-chip-food"));
    expect(screen.getByTestId("person-profile-scope-count")).toHaveTextContent("4 of 9 fields");
    fireEvent.change(search, { target: { value: "zzz-nothing" } });
    expect(screen.getByTestId("person-profile-scope-no-match")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByTestId("person-profile-scope-count")).toHaveTextContent("9 of 9 fields");
  });

  it("offers an access duration inside the review sheet and sends it in hours", async () => {
    const { PersonProfileService } = await import("@/lib/services/person-profile-service");
    const { OneKycClientZkService } = await import("@/lib/services/one-kyc-client-zk-service");
    (OneKycClientZkService.ensureConnector as ReturnType<typeof vi.fn>).mockResolvedValue({ connector_key_id: "ck_1" });
    (PersonProfileService.createInformationRequest as ReturnType<typeof vi.fn>).mockResolvedValue({ bundleId: "b1" });
    render(<PersonProfilePage personRef="actual-public-ref" initialProfile={null} />);
    fireEvent.click(await screen.findByRole("button", { name: /Employment status/ }));
    fireEvent.click(screen.getByRole("button", { name: /Review request \(1\)/ }));
    const duration = screen.getByTestId("person-profile-duration-select") as HTMLSelectElement;
    expect(duration.value).toBe("168");
    fireEvent.change(duration, { target: { value: "24" } });
    expect(screen.getByText(/the 24 hours access duration/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Explain why/), { target: { value: "Checking references for a role" } });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() =>
      expect(PersonProfileService.createInformationRequest).toHaveBeenCalledWith(
        expect.objectContaining({ durationSeconds: 24 * 3600, scopeRefs: ["scope-0"] }),
      ),
    );
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
    expect(await screen.findByTestId("person-profile-bundle-details")).toHaveTextContent("Employment status · 7 days");
  });
});
