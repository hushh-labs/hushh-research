import React from "react";
import { vi } from "vitest";
import type { GoogleCalendarStatus } from "@/lib/services/google-calendar-service";
import type { GmailConnectionStatus } from "@/lib/services/gmail-receipts-service";

const state = vi.hoisted(() => ({
  privatePlacement: vi.fn(),
  ownerPodRequest: vi.fn(),
  user: { uid: "owner-a", email: "login@example.invalid", getIdToken: vi.fn() },
  token: "synthetic-owner-token" as string | null,
  overview: vi.fn(),
  startOAuthConnect: vi.fn(),
  documents: vi.fn(),
  liveBackground: vi.fn(),
  setLiveBackground: vi.fn(),
  push: vi.fn(),
  calendarRefresh: vi.fn(),
  calendarDisconnect: vi.fn(),
  calendar: { connected: false, loaded: true, error: null as string | null, status: { status: "disconnected" } as Partial<GoogleCalendarStatus> },
  financial: { data: null as { data: Record<string, unknown> } | null, loading: false, error: null as string | null },
  gmailStatus: { connected: false, compose_permission_granted: false } as Partial<GmailConnectionStatus>,
  gmailError: false,
  connectGmail: vi.fn(),
  gmailStartConnect: vi.fn(),
  startNativeConnect: vi.fn(),
  completeNativeConnect: vi.fn(),
  calendarStartConnect: vi.fn(),
  calendarStatus: vi.fn(),
  calendarStartNativeConnect: vi.fn(),
  calendarCompleteNativeConnect: vi.fn(),
  connectCalendar: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock('@/lib/services/api-service', () => ({ ApiService: { ownerPodRequest: state.ownerPodRequest } }));
vi.mock('@/lib/services/private-agent-specialist-chat', () => ({ ownerContentIsPrivate: state.privatePlacement }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }), usePathname: () => "/" }));
vi.mock("@/components/profile/live-mirror-preview", () => ({ LiveMirrorPreview: () => <p>Memory preview</p> }));
vi.mock("@/components/profile/profile-connectors-section", () => ({
  ProfileConnectorsSection: function RetainedConnectorFixture({ connectorId, onConnectorChange }: {
    connectorId: string | null; onConnectorChange: (id: string | null) => void;
  }) {
    const [draft, setDraft] = React.useState("");
    return <div>
      <input aria-label="Connector setup draft" value={draft} onChange={event => setDraft(event.target.value)} />
      <button onClick={() => onConnectorChange("gmail")}>Review Gmail</button>
      <span>{connectorId ? "Connector detail" : "Connector list"}</span>
    </div>;
  },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: state.token, vaultKey: state.token ? "synthetic-key" : null,
  getVaultKey: () => state.token ? "synthetic-key" : null, getVaultOwnerToken: () => state.token }) }));
vi.mock("@/lib/calendar/use-calendar-connection-status", () => ({ useCalendarConnectionStatus: () => ({ ...state.calendar, refresh: state.calendarRefresh }) }));
vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: {
    disconnect: state.calendarDisconnect,
    startConnect: state.calendarStartConnect,
    status: state.calendarStatus,
    startNativeConnect: state.calendarStartNativeConnect,
    completeNativeConnect: state.calendarCompleteNativeConnect,
  },
}));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({ usePkmDomainResource: () => state.financial }));
vi.mock("@/lib/profile/gmail-connector-store", () => ({
  useGmailConnectorStatus: () => ({
    status: state.gmailStatus,
    loadingStatus: false,
    statusError: state.gmailError,
    disconnectGmail: vi.fn(),
    refreshStatus: vi.fn(),
  }),
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: {
    overview: state.overview,
    startOAuthConnect: state.startOAuthConnect,
    disconnect: state.disconnect,
    documents: state.documents,
    liveBackground: state.liveBackground,
    setLiveBackground: state.setLiveBackground,
  },
}));
vi.mock("@/components/consent/trusted-document-rules", () => ({
  TrustedDocumentRulesView: () => null,
  useTrustedDocumentRules: () => ({ rules: [], busy: false, message: "", mutationPending: () => false }),
}));
vi.mock("@/lib/services/gmail-receipts-service", () => ({
  GmailReceiptsService: {
    startConnect: state.gmailStartConnect,
    startNativeConnect: state.startNativeConnect,
    completeNativeConnect: state.completeNativeConnect,
    recordConsentFailure: vi.fn(),
  },
}));
vi.mock("@/lib/capacitor", () => ({
  HushhAuth: { connectGmail: state.connectGmail, connectCalendar: state.connectCalendar },
}));
vi.mock("@/components/icons", () => ({
  ArrowLeftIcon: () => null,
  CaretRightIcon: () => null,
  ChevronRightIcon: () => null,
  Loader2: () => null,
  Loader2Icon: () => null,
  SearchIcon: () => null,
  XIcon: () => null,
}));


export { state };
