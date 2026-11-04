// Synthetic profile transport and vault boundaries; tests render the production page.
import type { ComponentProps, ReactNode, TextareaHTMLAttributes } from "react";
import { useEffect } from "react";
import { vi } from "vitest";
import { currentGrantFixture } from "./fixtures";

const mocks = vi.hoisted(() => ({
  realDialogs: false,
  answerGates: vi.fn(),
  answerCreate: vi.fn(),
  receivingSetup: vi.fn(),
  search: "",
  vaultKey: null as string | null,
  vaultOwnerToken: null as string | null,
  getInformationRequest: vi.fn(),
  getRequestHistory: vi.fn(),
  getPublic: vi.fn(),
  peekPublic: vi.fn(),
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
  useAuth: () => ({ user: mocks.user, userId: mocks.user?.uid ?? null, loading: mocks.authLoading }),
}));

vi.mock("@/components/connections/person-network-summary", () => ({
  PersonNetworkSummary: ({ onReady }: { onReady?: () => void }) => {
    useEffect(() => { onReady?.(); }, [onReady]);
    return null;
  },
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
    peekPublic: mocks.peekPublic,
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

export function mockCurrentGrant(requestId: string, bundleId: string, scopeRef = "scope-0") {
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

export { mocks };
vi.mock("@/lib/one-marketplace/key-bootstrap", () => ({
  bootstrapCurrentUserMarketplaceRecipientKey: mocks.receivingSetup,
}));
