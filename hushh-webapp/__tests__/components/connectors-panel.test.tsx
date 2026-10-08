import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  privatePlacement: vi.fn(),
  ownerPodRequest: vi.fn(),
  user: { uid: "owner-a", getIdToken: vi.fn() },
  token: "synthetic-owner-token" as string | null,
  overview: vi.fn(),
  startOAuthConnect: vi.fn(),
  documents: vi.fn(),
  liveBackground: vi.fn(),
  setLiveBackground: vi.fn(),
  push: vi.fn(),
  calendarRefresh: vi.fn(),
  calendarDisconnect: vi.fn(),
  calendar: { connected: false, loaded: true, error: null as string | null, status: { status: "disconnected" } },
  financial: { data: null as { data: Record<string, unknown> } | null, loading: false, error: null as string | null },
  gmailStatus: { connected: false, compose_permission_granted: false } as Record<string, boolean>,
  connectGmail: vi.fn(),
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: state.token, vaultKey: state.token ? "synthetic-key" : null }) }));
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
    statusError: false,
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
  TrustedDocumentRules: () => null,
}));
vi.mock("@/lib/services/gmail-receipts-service", () => ({
  GmailReceiptsService: {
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

import { Capacitor } from "@capacitor/core";
import { ConnectorsPanel } from "@/components/agent/connectors-panel";
import { useGoogleConnectorTransitionReview } from '@/components/connections/google-connector-transition-review';
import { snapshotVaultSessionEpoch, advanceVaultSessionEpoch } from '@/lib/vault/session-epoch';

describe('private Google transition owner review', () => {
  const terms = { services: ['gmail', 'drive'] as const, scope: 'all_google_project_grants' as const };
  function ReviewHarness({ ownerId, epoch, result }: { ownerId: string; epoch: number; result: (approved: boolean) => void }) {
    const { confirmTransition, transitionDialog } = useGoogleConnectorTransitionReview(ownerId, epoch);
    return <><button onClick={() => void confirmTransition(terms).then(result)}>Review Google</button>{transitionDialog}</>;
  }
  afterEach(cleanup);
  it('requires explicit confirmation and explains that private-agent grants are replaced', async () => {
    const result = vi.fn();
    render(<ReviewHarness ownerId="owner-a" epoch={snapshotVaultSessionEpoch()} result={result} />);
    fireEvent.click(screen.getByText('Review Google'));
    expect(screen.getByText(/Existing Google connections, including your private agent/)).toBeInTheDocument();
    expect(result).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Replace and sign in' }));
    await waitFor(() => expect(result).toHaveBeenCalledWith(true));
  });
  it('refuses confirmation after vault lock, cancellation or unmount', async () => {
    const result = vi.fn();
    const view = render(<ReviewHarness ownerId="owner-a" epoch={snapshotVaultSessionEpoch()} result={result} />);
    fireEvent.click(screen.getByText('Review Google'));
    advanceVaultSessionEpoch();
    fireEvent.click(screen.getByRole('button', { name: 'Replace and sign in' }));
    await waitFor(() => expect(result).toHaveBeenLastCalledWith(false));
    view.rerender(<ReviewHarness ownerId="owner-a" epoch={snapshotVaultSessionEpoch()} result={result} />);
    fireEvent.click(screen.getByText('Review Google'));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(result).toHaveBeenCalledTimes(2));
    expect(result).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByText('Review Google'));
    view.unmount();
    await waitFor(() => expect(result).toHaveBeenCalledTimes(3));
    expect(result).toHaveBeenLastCalledWith(false);
  });
});

const callbacks = {
  onBack: vi.fn(),
  onAvailableChange: vi.fn(),
  onExternalModalChange: vi.fn(),
  onPrepareRecovery: vi.fn(async () => "ready" as const),
  onClearRecovery: vi.fn(async () => undefined),
};
const catalogItem = {
  connectorId: "example_docs",
  displayName: "Example Docs",
  description: "Read selected files",
  authStyle: "oauth",
  status: "not_connected",
};
const overview = (connectors: typeof catalogItem[] = []) => ({
  connectors,
  features: { connections_panel_v2: true, google_drive_connection: true },
});
const panel = (open = true) => <ConnectorsPanel open={open} {...callbacks} />;

describe("supported connector catalog", () => {
  beforeEach(() => {
    state.privatePlacement.mockReset().mockResolvedValue(false);
    state.ownerPodRequest.mockReset().mockImplementation(async (path: string) => new Response(JSON.stringify({ connectorId: path.split('/')[1], status: 'connected', capabilities: { read: true, manage: false }, accessLevel: 'read' })));
    state.user.uid = "owner-a";
    state.token = "synthetic-owner-token";
    state.overview.mockReset().mockResolvedValue(overview());
    state.startOAuthConnect.mockReset();
    state.documents.mockReset().mockResolvedValue([]);
    state.liveBackground.mockReset().mockResolvedValue(true);
    state.setLiveBackground.mockReset().mockImplementation(async (_token: string, enabled: boolean) => enabled);
    state.push.mockReset();
    state.calendarRefresh.mockReset();
    state.calendarDisconnect.mockReset().mockResolvedValue({ connected: false, status: "disconnected" });
    state.calendarStartConnect.mockReset().mockResolvedValue({
      authorize_url: "https://accounts.google.com/o/oauth2/v2/auth?synthetic=calendar",
      redirect_uri: "http://localhost:3000/one/profile/google/oauth/return",
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    state.calendarStatus.mockReset().mockResolvedValue({ configured: true, connected: false, status: "disconnected" });
    state.calendarStartNativeConnect.mockReset();
    state.calendarCompleteNativeConnect.mockReset();
    state.connectCalendar.mockReset();
    state.user.getIdToken.mockResolvedValue("synthetic-firebase-token");
    state.calendar = { connected: false, loaded: true, error: null, status: { status: "disconnected" } };
    state.financial = { data: null, loading: false, error: null };
    state.gmailStatus = { connected: false, compose_permission_granted: false };
    Object.values(callbacks).forEach((callback) => callback.mockClear());
  });
  afterEach(cleanup);

  it('private placement mounts only pod connectors and does not claim management access from a connection receipt', async () => {
    state.privatePlacement.mockResolvedValue(true);
    const view = render(panel());
    expect(await screen.findByTestId('private-google-connectors')).toBeInTheDocument();
    expect(await screen.findAllByRole('button', { name: 'Allow changes' })).toHaveLength(2);
    expect(screen.getAllByText('Connected · reading only')).toHaveLength(2);
    expect(state.ownerPodRequest).toHaveBeenCalledTimes(4);
    expect(state.overview).not.toHaveBeenCalled();
    expect(state.calendarStartNativeConnect).not.toHaveBeenCalled();
    state.token = null;
    view.rerender(panel());
    expect(await screen.findByText('Sign in and unlock your vault to connect Google.')).toBeInTheDocument();
    expect(screen.queryByText('Connected · reading only')).not.toBeInTheDocument();
  });

  it("shows real connections without roadmap placeholders", async () => {
    state.overview.mockResolvedValue(overview([catalogItem]));
    render(panel());
    expect(await screen.findByText("Example Docs")).toBeInTheDocument();
    for (const label of ["Connectors", "Google Drive", "Gmail"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole("button", { name: "Connect Calendar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plaid" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search connectors" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connected" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Available" })).toBeInTheDocument();
    expect(screen.queryByText(/Google Workspace MCP|Finance connection|Read access after connection/)).not.toBeInTheDocument();
    expect(screen.queryByText("Read selected files")).not.toBeInTheDocument();
    for (const label of ["Coming soon", "Notion", "HubSpot", "Attio", "Shopify", "Circle"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("shows built-in Drive when the external registry is empty", async () => {
    render(panel());
    expect(await screen.findByText("Google Drive")).toBeInTheDocument();
  });

  it("opens connected Plaid details without redirecting to portfolio sources", async () => {
    state.financial.data = { data: { connections_v1: {
      "synthetic-item": { institution_name: "Synthetic Bank", status: "active", products: [] },
    } } };
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Plaid" }));
    expect(screen.getByText("Synthetic Bank")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(state.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Disconnect this bank?" });
    expect(within(dialog).getByText(/removes its connected financial records/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(state.push).not.toHaveBeenCalled();
  });

  it("does not offer a dead Drive connection action when OAuth is unconfigured", async () => {
    state.overview.mockResolvedValue(overview());
    render(panel());
    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Google Drive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage Google Drive" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Google Drive" }));
    expect(screen.getByText("Drive sign-in is not configured here. Try again later.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry Drive" })).toBeEnabled();
  });

  it("offers selected-file Drive connection without claiming live Drive access", async () => {
    state.overview.mockResolvedValue({
      connectors: [{ ...catalogItem, connectorId: "google_drive", available: true }],
      features: {
        connections_panel_v2: true,
        google_drive_live: false,
        google_drive_picker: true,
      },
    });
    render(panel());
    expect(await screen.findByRole("button", { name: "Connect Google Drive" })).toBeEnabled();
    expect(screen.getByText("Selected files only")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Google Drive" }));
    expect(screen.getByRole("button", { name: "Connect Drive" })).toBeEnabled();
    expect(screen.getByText("You can choose files after connecting. One cannot search your entire Drive with this access.")).toBeInTheDocument();
    expect(screen.queryByText("Drive sign-in is not configured here. Try again later.")).not.toBeInTheDocument();
  });

  it("cancels a pending web Drive OAuth start and closes the blank popup", async () => {
    state.overview.mockResolvedValue({
      connectors: [{ ...catalogItem, connectorId: "google_drive", available: true }],
      features: {
        connections_panel_v2: true,
        google_drive_connection: true,
        google_drive_picker: true,
      },
    });
    const popupClosed = vi.fn();
    const popup = {
      closed: false,
      close: popupClosed,
      document: { title: "", body: { textContent: "" } },
      location: { replace: vi.fn() },
      sessionStorage: window.sessionStorage,
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    let startSignal: AbortSignal | undefined;
    state.startOAuthConnect.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          startSignal = signal;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Google Drive" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect Drive" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }));

    expect(startSignal?.aborted).toBe(true);
    expect(popupClosed).toHaveBeenCalled();
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(await screen.findByText("Drive connection cancelled.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).not.toBeInTheDocument();
  });

  it("closes the blank popup when Drive OAuth start fails", async () => {
    state.overview.mockResolvedValue({
      connectors: [{ ...catalogItem, connectorId: "google_drive", available: true }],
      features: {
        connections_panel_v2: true,
        google_drive_connection: true,
        google_drive_picker: true,
      },
    });
    const popupClosed = vi.fn();
    const popup = {
      closed: false,
      close: popupClosed,
      document: { title: "", body: { textContent: "" } },
      location: { replace: vi.fn() },
      sessionStorage: window.sessionStorage,
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    state.startOAuthConnect.mockRejectedValue(new Error("synthetic start failure"));

    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Google Drive" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect Drive" }));

    expect(await screen.findByText("Drive sign-in could not start. Check the connection and try again.")).toBeInTheDocument();
    expect(popupClosed).toHaveBeenCalled();
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).not.toBeInTheDocument();
  });

  it("navigates to Google when the server clock is ahead of the Windows device", async () => {
    state.overview.mockResolvedValue({
      connectors: [{ ...catalogItem, connectorId: "google_drive", available: true }],
      features: { connections_panel_v2: true, google_drive_connection: true },
    });
    const popup = {
      closed: false,
      close: vi.fn(),
      document: { title: "", body: { textContent: "" } },
      location: { replace: vi.fn() },
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    state.startOAuthConnect.mockResolvedValue({
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic",
      attemptId: "synthetic-attempt-id",
      connectorId: "google_drive",
      // The server grants ten minutes, but its clock is 30 seconds ahead.
      expiresAt: new Date(Date.now() + 10 * 60_000 + 30_000).toISOString(),
    });

    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Google Drive" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect Drive" }));

    await waitFor(() => expect(popup.location.replace).toHaveBeenCalledOnce());
    expect(screen.queryByText("Drive could not finish this action. Check the connection and try again.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(popup.close).toHaveBeenCalled();
  });

  it("offers no connect path for a registry row the server does not mark as a curated provider", async () => {
    state.overview.mockResolvedValue(overview([
      { ...catalogItem, connectorId: "notion", displayName: "Notion" },
      { ...catalogItem, connectorId: "hubspot", displayName: "HubSpot" },
      catalogItem,
    ]));
    const { container } = render(panel());
    expect(await screen.findByText("Example Docs")).toBeInTheDocument();
    // No curatedOAuth flag from the server means no Connect or Disconnect action.
    expect(screen.queryByRole("button", { name: /Connect (Notion|HubSpot)/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Disconnect (Notion|HubSpot)/ })).not.toBeInTheDocument();
    for (const provider of ["gmail", "drive", "calendar", "plaid"]) {
      expect(container.querySelector(`img[src="/icons/connectors/${provider}.svg"]`)).not.toBeNull();
    }
  });

  describe("connector brand marks", () => {
    const row = (connectorId: string, displayName: string) => ({
      ...catalogItem,
      connectorId,
      displayName,
      available: true,
      curatedOAuth: true,
      catalogCard: true,
    });

    it("shows Attio's own mark, inverted on the dark theme, and keeps the other marks as they were", async () => {
      state.overview.mockResolvedValue({
        connectors: [row("attio", "Attio"), catalogItem],
        features: { connections_panel_v2: true, curated_mcp_connectors: true },
      });
      const { container } = render(panel());
      expect(await screen.findByText("Example Docs")).toBeInTheDocument();
      const attio = container.querySelector('img[src="/icons/connectors/attio.svg"]');
      expect(attio).not.toBeNull();
      expect(attio).toHaveClass("dark:invert");
      // Colour marks are never inverted; Plaid (also single-colour) still is.
      expect(container.querySelector('img[src="/icons/connectors/gmail.svg"]')).not.toHaveClass("dark:invert");
      expect(container.querySelector('img[src="/icons/connectors/plaid.svg"]')).toHaveClass("dark:invert");
    });

    it("keeps Attio's official logo file exactly as the provider published it", () => {
      const file = readFileSync(join(process.cwd(), "public/icons/connectors/attio.svg"), "utf8").replaceAll("\r\n", "\n");
      expect(createHash("sha256").update(file).digest("hex")).toBe(
        "c4737394bc1e071e8f06fe22466c65279f66b508d26d4a06e95a2deaed2c2927",
      );
      expect(readFileSync(join(process.cwd(), "public/icons/connectors/README.md"), "utf8")).toContain(
        "https://attio.com/brand/v1/attio-logomark.svg",
      );
    });

    it("shows HubSpot's sprocket in its own colour, never inverted", async () => {
      state.overview.mockResolvedValue({
        connectors: [row("hubspot", "HubSpot"), catalogItem],
        features: { connections_panel_v2: true, curated_mcp_connectors: true },
      });
      const { container } = render(panel());
      expect(await screen.findByText("Example Docs")).toBeInTheDocument();
      const hubspot = container.querySelector('img[src="/icons/connectors/hubspot.svg"]');
      expect(hubspot).not.toBeNull();
      expect(hubspot).not.toHaveClass("dark:invert");
    });

    it("keeps the HubSpot glyph exactly as recorded, and says where it came from", () => {
      const dir = join(process.cwd(), "public/icons/connectors");
      const svg = readFileSync(join(dir, "hubspot.svg"), "utf8").replaceAll("\r\n", "\n");
      expect(createHash("sha256").update(svg).digest("hex")).toBe(
        "037689701fe2e70c7b5240547662e580a292cd43e7c0e0e8ea28b81c036d5260",
      );
      // The README must not present it as an official HubSpot file.
      const readme = readFileSync(join(dir, "README.md"), "utf8");
      expect(readme).toContain("NOT an official HubSpot file");
      expect(readme).toContain("simple-icons@16.34.0");
    });

    it("shows Notion's mark, inverted on the dark theme", async () => {
      state.overview.mockResolvedValue({
        connectors: [row("notion", "Notion"), catalogItem],
        features: { connections_panel_v2: true, curated_mcp_connectors: true },
      });
      const { container } = render(panel());
      expect(await screen.findByText("Example Docs")).toBeInTheDocument();
      const notion = container.querySelector('img[src="/icons/connectors/notion.svg"]');
      expect(notion).not.toBeNull();
      // Single-colour black: it would vanish on the dark theme without the inversion.
      expect(notion).toHaveClass("dark:invert");
    });

    it("keeps the Notion mark exactly as recorded, and says where it came from", () => {
      const dir = join(process.cwd(), "public/icons/connectors");
      const svg = readFileSync(join(dir, "notion.svg"), "utf8").replaceAll("\r\n", "\n");
      expect(createHash("sha256").update(svg).digest("hex")).toBe(
        "b17d2a2b592a06252efef522d5205f0c7a958f748d40df1011ed081417e42f85",
      );
      // The README must not present it as an official Notion file.
      const readme = readFileSync(join(dir, "README.md"), "utf8");
      expect(readme).toContain("NOT an official Notion file");
      expect(readme).toContain("simple-icons@16.34.0");
    });

    it("does not invent a logo for a connector that has no mark here", async () => {
      state.overview.mockResolvedValue({
        connectors: [row("example_unlisted", "Example Unlisted"), catalogItem],
        features: { connections_panel_v2: true, curated_mcp_connectors: true },
      });
      const { container } = render(panel());
      expect(await screen.findByText("Example Docs")).toBeInTheDocument();
      expect(container.querySelector('img[src="/icons/connectors/example_unlisted.svg"]')).toBeNull();
    });
  });

  describe("curated CRM connector (HubSpot)", () => {
    const hubspot = {
      ...catalogItem,
      connectorId: "hubspot",
      displayName: "HubSpot",
      available: true,
      curatedOAuth: true,
      catalogCard: true,
    } as typeof catalogItem & { available: boolean; curatedOAuth: boolean; catalogCard: boolean };
    const notion = { ...hubspot, connectorId: "notion", displayName: "Notion" };
    const attio = { ...hubspot, connectorId: "attio", displayName: "Attio" };
    const withFlag = (connectors: object[], enabled = true) => ({
      connectors,
      features: { connections_panel_v2: true, curated_mcp_connectors: enabled },
    });
    const realLocation = window.location;
    let assign: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      assign = vi.fn();
      // The full-page tests below run the blocked-popup fallback; the in-session
      // popup describe at the end of this block opens a window instead.
      vi.spyOn(window, "open").mockReturnValue(null);
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { origin: "https://uat.one.hushh.ai", assign },
      });
      state.startOAuthConnect.mockReset().mockResolvedValue({
        authorizeUrl: "https://mcp.hubspot.com/oauth/authorize/user?state=signed",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        attemptId: "attempt-abcdefghijklmnopqrstuvwxyz0123456789",
        connectorId: "hubspot",
      });
      state.disconnect.mockReset().mockResolvedValue({ status: "revoked", connectorId: "hubspot" });
    });
    afterEach(() => {
      Object.defineProperty(window, "location", { configurable: true, value: realLocation });
      vi.mocked(window.open).mockRestore();
      // eslint-disable-next-line no-restricted-globals -- Clear the synthetic handoff marker.
      sessionStorage.clear();
    });

    it("keeps a server-declared unavailable card visible while the rollout flag is off", async () => {
      state.overview.mockResolvedValue(withFlag([{ ...hubspot, available: false, catalogState: "unavailable" }, catalogItem], false));
      render(panel());
      expect(await screen.findByText("Example Docs")).toBeInTheDocument();
      expect(screen.getByText("HubSpot")).toBeInTheDocument();
      expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "Connect HubSpot" })).not.toBeInTheDocument();
      expect(state.startOAuthConnect).not.toHaveBeenCalled();
    });

    it("renders server-declared catalog cards with their pending states and no OAuth action", async () => {
      state.overview.mockResolvedValue(withFlag([
        { ...hubspot, curatedOAuth: false, available: false, catalogState: "setup_pending" },
        { ...notion, curatedOAuth: false, available: false, catalogState: "discovery_pending" },
        { ...attio, available: false, catalogState: "unavailable" },
      ]));
      render(panel());
      for (const [provider, state] of [
        ["HubSpot", "Setup pending"],
        ["Notion", "Discovery pending"],
        ["Attio", "Unavailable"],
      ]) {
        expect(await screen.findByText(provider)).toBeInTheDocument();
        expect(screen.getAllByText(state).length).toBeGreaterThan(0);
        expect(screen.queryByRole("button", { name: `Connect ${provider}` })).not.toBeInTheDocument();
      }
      expect(state.startOAuthConnect).not.toHaveBeenCalled();
    });

    it("shows catalog loading and retries before enabling a server-approved card", async () => {
      let rejectOverview!: (reason?: unknown) => void;
      state.overview
        .mockImplementationOnce(() => new Promise<ReturnType<typeof withFlag>>((_, reject) => {
          rejectOverview = reject;
      }))
        .mockResolvedValueOnce(withFlag([hubspot]));
      render(panel());
      const loadingStatus = await screen.findByText("Loading connector catalog…");
      expect(loadingStatus).toHaveAttribute("role", "status");

      await act(async () => rejectOverview(new Error("synthetic unavailable")));
      const unavailableStatus = await screen.findByText("Connector catalog unavailable. Try again.");
      expect(unavailableStatus).toHaveAttribute("role", "status");

      fireEvent.click(screen.getByRole("button", { name: "Retry connector catalog" }));
      expect(await screen.findByRole("button", { name: "Connect HubSpot" })).toBeEnabled();
      expect(state.overview).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Connector catalog unavailable. Try again.")).not.toBeInTheDocument();
    });

    it("keeps a connected connector reachable for disconnect while rollout is off", async () => {
      state.overview.mockResolvedValue(withFlag([{ ...hubspot, status: "connected" }], false));
      render(panel());
      const connected = await screen.findByRole("region", { name: "Connected" });
      expect(await within(connected).findByText("HubSpot")).toBeInTheDocument();
      fireEvent.click(within(connected).getByRole("button", { name: "Disconnect HubSpot" }));
      const dialog = await screen.findByRole("alertdialog", { name: "Disconnect this connector?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
      await waitFor(() =>
        expect(state.disconnect).toHaveBeenCalledWith({
          vaultOwnerToken: "synthetic-owner-token",
          connectorId: "hubspot",
        }),
      );
    });

    it.each([
      ["revoked", "Disconnected."],
      ["failed", "Disconnected in One. HubSpot did not confirm revoking access; remove it in HubSpot if needed."],
      ["unavailable", "Disconnected in One. Remove access in HubSpot if needed."],
    ])("tells the person what happened to the provider's copy of the grant (%s)", async (outcome, message) => {
      state.disconnect.mockReset().mockResolvedValue({ status: "revoked", connectorId: "hubspot", revocationOutcome: outcome });
      state.overview.mockResolvedValue(withFlag([{ ...hubspot, status: "connected" }]));
      render(panel());
      fireEvent.click(await screen.findByRole("button", { name: "HubSpot" }));
      const details = screen.getByRole("region", { name: "HubSpot details" });
      fireEvent.click(within(details).getByRole("button", { name: "Disconnect" }));
      const dialog = await screen.findByRole("alertdialog", { name: "Disconnect this connector?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
      expect(await screen.findByText(message)).toBeInTheDocument();
    });

    it("does not offer a stale grant a reconnect path while rollout is off", async () => {
      state.overview.mockResolvedValue(withFlag([{ ...hubspot, status: "verifying" }], false));
      render(panel());
      fireEvent.click(await screen.findByRole("button", { name: "HubSpot" }));
      const details = screen.getByRole("region", { name: "HubSpot details" });
      expect(within(details).getByText("Unavailable")).toBeInTheDocument();
      expect(within(details).queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
      expect(within(details).getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
      expect(state.startOAuthConnect).not.toHaveBeenCalled();
    });

    it("keeps an unavailable server-declared card visible without a connect action", async () => {
      state.overview.mockResolvedValue(withFlag([{ ...hubspot, available: false, catalogState: "unavailable" }, catalogItem]));
      render(panel());
      expect(await screen.findByText("Example Docs")).toBeInTheDocument();
      expect(screen.getByText("HubSpot")).toBeInTheDocument();
      expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "Connect HubSpot" })).not.toBeInTheDocument();
      expect(state.startOAuthConnect).not.toHaveBeenCalled();
    });

    it("offers a second curated provider with no provider-specific frontend code", async () => {
      state.overview.mockResolvedValue(withFlag([hubspot, notion]));
      state.startOAuthConnect.mockReset().mockResolvedValue({
        authorizeUrl: "https://mcp.notion.com/authorize?state=signed",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        attemptId: "attempt-abcdefghijklmnopqrstuvwxyz0123456789",
        connectorId: "notion",
      });
      const providerPopup = {
        closed: false,
        close: vi.fn(),
        document: { title: "", body: { textContent: "" } },
        location: { replace: vi.fn() },
      };
      vi.mocked(window.open).mockReturnValue(providerPopup as unknown as Window);
      render(panel());
      expect(await screen.findByRole("button", { name: "Connect HubSpot" })).toBeInTheDocument();
      fireEvent.click(await screen.findByRole("button", { name: "Connect Notion" }));
      await waitFor(() =>
        expect(providerPopup.location.replace).toHaveBeenCalledExactlyOnceWith(
          "https://mcp.notion.com/authorize?state=signed",
        ),
      );
      expect(state.startOAuthConnect).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: "notion", flow: "web" }),
      );
      // The sign-in happens in the popup; this window never leaves the app.
      expect(assign).not.toHaveBeenCalled();
    });

    it("offers Disconnect for a connected connector and confirms first", async () => {
      state.overview.mockResolvedValue(withFlag([{ ...hubspot, status: "connected" }]));
      render(panel());
      fireEvent.click(await screen.findByRole("button", { name: "Disconnect HubSpot" }));
      expect(state.disconnect).not.toHaveBeenCalled();
      const dialog = await screen.findByRole("alertdialog", { name: "Disconnect this connector?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
      await waitFor(() =>
        expect(state.disconnect).toHaveBeenCalledWith({
          vaultOwnerToken: "synthetic-owner-token",
          connectorId: "hubspot",
        }),
      );
    });

    it("clears a pending disconnect after same-owner token renewal", async () => {
      let settle!: (value: unknown) => void;
      state.disconnect.mockImplementation(() => new Promise((done) => { settle = done; }));
      state.overview.mockResolvedValue(withFlag([{ ...hubspot, status: "connected" }]));
      const view = render(panel());
      fireEvent.click(await screen.findByRole("button", { name: "Disconnect HubSpot" }));
      const dialog = await screen.findByRole("alertdialog", { name: "Disconnect this connector?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
      expect(await screen.findByText("Disconnecting…")).toBeInTheDocument();
      state.token = "renewed-owner-token";
      view.rerender(panel());
      await waitFor(() => expect(screen.queryByText("Disconnecting…")).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Disconnect HubSpot" })).toBeEnabled();
      await act(async () => settle({ status: "revoked", connectorId: "hubspot" }));
      expect(screen.getByRole("button", { name: "Disconnect HubSpot" })).toBeEnabled();
    });

    it("treats a connection stuck before verification as needing sign-in", async () => {
      state.overview.mockResolvedValue(withFlag([{ ...hubspot, status: "verifying" }]));
      render(panel());
      const available = await screen.findByRole("region", { name: "Available" });
      const connected = screen.getByRole("region", { name: "Connected" });
      expect(
        await within(available).findByRole("button", { name: "Reconnect HubSpot" }),
      ).toBeInTheDocument();
      expect(within(connected).queryByText("HubSpot")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Disconnect HubSpot" })).not.toBeInTheDocument();
      expect(screen.queryByText(/choose files/)).not.toBeInTheDocument();
    });

    it("offers Reconnect when sign-in is needed", async () => {
      state.overview.mockResolvedValue(withFlag([{ ...hubspot, status: "needs_reauth" }]));
      render(panel());
      expect(await screen.findByRole("button", { name: "Reconnect HubSpot" })).toBeInTheDocument();
    });

    describe("signs in inside the session", () => {
      const ATTEMPT_KEY = "one_curated_popup_attempt_v1";
      const AUTHORIZE_URL = "https://mcp.hubspot.com/oauth/authorize/user?state=signed";
      const fakePopup = () =>
        ({
          closed: false,
          close: vi.fn(),
          document: { title: "", body: { textContent: "" } },
          location: { replace: vi.fn() },
        }) as unknown as Window & { close: ReturnType<typeof vi.fn>; location: { replace: ReturnType<typeof vi.fn> } };
      const settlementOf = (outcome = "succeeded") => {
        const attempt = JSON.parse(window.localStorage.getItem(ATTEMPT_KEY) ?? "null") as {
          connectorId: string; attemptId: string; expiresAt: number;
        };
        return { type: "curated_oauth_settlement", ...attempt, outcome };
      };
      const post = (data: unknown, source: unknown, origin = window.location.origin) =>
        act(async () => {
          window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
        });
      let popup: ReturnType<typeof fakePopup>;
      beforeEach(() => {
        if (typeof window.localStorage?.setItem !== "function") {
          const store = new Map<string, string>();
          Object.defineProperty(window, "localStorage", {
            configurable: true,
            value: {
              get length() { return store.size; },
              clear: () => store.clear(),
              getItem: (key: string) => store.get(key) ?? null,
              key: (index: number) => Array.from(store.keys())[index] ?? null,
              removeItem: (key: string) => { store.delete(key); },
              setItem: (key: string, value: string) => { store.set(key, value); },
            },
          });
        }
        popup = fakePopup();
        vi.mocked(window.open).mockReturnValue(popup);
      });
      afterEach(() => {
        window.localStorage.clear();
      });
      const connectHubspot = async () => {
        state.overview.mockResolvedValue(withFlag([hubspot]));
        const view = render(panel());
        fireEvent.click(await screen.findByRole("button", { name: "Connect HubSpot" }));
        return view;
      };

      it("opens the window in the click before any awaited work and never navigates this window", async () => {
        await connectHubspot();
        // Synchronous: no await happened between the click and these assertions.
        expect(window.open).toHaveBeenCalledOnce();
        expect(vi.mocked(window.open).mock.invocationCallOrder[0]).toBeLessThan(
          state.startOAuthConnect.mock.invocationCallOrder[0],
        );
        await waitFor(() => expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith(AUTHORIZE_URL));
        expect(state.startOAuthConnect).toHaveBeenCalledWith(expect.objectContaining({
          vaultOwnerToken: "synthetic-owner-token",
          connectorId: "hubspot",
          redirectUri: "https://uat.one.hushh.ai/one/profile/connectors/oauth/return",
          flow: "web",
        }));
        expect(assign).not.toHaveBeenCalled();
        // eslint-disable-next-line no-restricted-globals -- No full-page handoff is saved.
        expect(sessionStorage.getItem("one_drive_chat_recovery_handoff_v1")).toBeNull();
        const marker = window.localStorage.getItem(ATTEMPT_KEY) ?? "";
        expect(marker).toContain("hubspot");
        expect(marker).not.toMatch(/synthetic-owner-token|state=signed/);
        expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeInTheDocument();
      });

      it("re-reads the owner-authenticated status when the popup settles, and only for its own popup", async () => {
        await connectHubspot();
        await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
        const before = state.overview.mock.calls.length;
        await post(settlementOf(), popup, "https://attacker.invalid");
        await post(settlementOf(), window);
        await post({ ...settlementOf(), connectorId: "notion" }, popup);
        await post({ ...settlementOf(), type: "drive_oauth_settlement" }, popup);
        expect(state.overview).toHaveBeenCalledTimes(before);
        expect(popup.close).not.toHaveBeenCalled();
        await post(settlementOf("failed"), popup);
        await waitFor(() => expect(state.overview).toHaveBeenCalledTimes(before + 1));
        // The popup said "failed" and the re-read status is still not connected.
        expect(await screen.findByText("Sign-in did not finish. Try again.")).toBeInTheDocument();
        expect(popup.close).toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
        expect(screen.queryByRole("button", { name: "Cancel sign-in" })).not.toBeInTheDocument();
        expect(assign).not.toHaveBeenCalled();
      });

      it("stays in place and says why when the popup and tab are both blocked", async () => {
        // A full-page redirect would reload the app and re-lock the vault, which is
        // exactly what signing in inside the session exists to avoid.
        vi.mocked(window.open).mockReturnValue(null);
        await connectHubspot();
        expect(
          await screen.findByText("Allow pop-ups for One, then try again. Your chat and draft stay here."),
        ).toBeInTheDocument();
        expect(state.startOAuthConnect).not.toHaveBeenCalled();
        expect(assign).not.toHaveBeenCalled();
        // eslint-disable-next-line no-restricted-globals -- No full-page handoff is ever saved.
        expect(sessionStorage.getItem("one_drive_chat_recovery_handoff_v1")).toBeNull();
        expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
      });

      it("cancels cleanly: closes the popup, clears busy and ignores a late settlement", async () => {
        await connectHubspot();
        await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
        const attempt = settlementOf();
        const before = state.overview.mock.calls.length;
        fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
        expect(await screen.findByText("Sign-in cancelled.")).toBeInTheDocument();
        expect(popup.close).toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
        expect(screen.queryByRole("button", { name: "Cancel sign-in" })).not.toBeInTheDocument();
        await post(attempt, popup);
        expect(state.overview).toHaveBeenCalledTimes(before);
        expect(assign).not.toHaveBeenCalled();
      });

      it("closes the popup when the panel unmounts mid sign-in", async () => {
        const view = await connectHubspot();
        await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
        view.unmount();
        await waitFor(() => expect(popup.close).toHaveBeenCalled());
        expect(assign).not.toHaveBeenCalled();
      });

      it("ends the sign-in when the vault re-locks", async () => {
        const view = await connectHubspot();
        await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
        state.token = null;
        view.rerender(panel());
        await waitFor(() => expect(popup.close).toHaveBeenCalled());
        expect(assign).not.toHaveBeenCalled();
        state.token = "synthetic-owner-token";
        view.rerender(panel());
        expect(await screen.findByRole("button", { name: "Connect HubSpot" })).toBeEnabled();
        expect(screen.queryByRole("button", { name: "Cancel sign-in" })).not.toBeInTheDocument();
      });

      it("keeps the sign-in open through a routine owner-token renewal and reads status with the new token", async () => {
        // The vault renews its owner token shortly before expiry. Someone who is
        // on the provider's consent page at that moment must not lose the window.
        const view = await connectHubspot();
        await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
        state.token = "renewed-owner-token";
        view.rerender(panel());
        await waitFor(() => expect(state.overview).toHaveBeenLastCalledWith("renewed-owner-token"));
        expect(popup.close).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeInTheDocument();
        const before = state.overview.mock.calls.length;
        await post(settlementOf(), popup);
        await waitFor(() => expect(state.overview.mock.calls.length).toBeGreaterThan(before));
        expect(state.overview).toHaveBeenLastCalledWith("renewed-owner-token");
        expect(popup.close).toHaveBeenCalled();
        expect(assign).not.toHaveBeenCalled();
      });

      it("ends the sign-in when the owner changes", async () => {
        const view = await connectHubspot();
        await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
        state.user.uid = "owner-b";
        view.rerender(panel());
        await waitFor(() => expect(popup.close).toHaveBeenCalled());
        expect(assign).not.toHaveBeenCalled();
      });

      it("reports the connection when the re-read status says it is connected", async () => {
        state.overview
          .mockResolvedValueOnce(withFlag([hubspot]))
          .mockResolvedValue(withFlag([{ ...hubspot, status: "connected", accountLabel: "owner@example.invalid" }]));
        render(panel());
        fireEvent.click(await screen.findByRole("button", { name: "Connect HubSpot" }));
        await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
        await post(settlementOf(), popup);
        expect(await screen.findByText("HubSpot connected.")).toBeInTheDocument();
      });

      it("opens only one window when the button is tapped twice in the same frame", async () => {
        state.overview.mockResolvedValue(withFlag([hubspot]));
        render(panel());
        const connect = await screen.findByRole("button", { name: "Connect HubSpot" });
        act(() => {
          connect.click();
          connect.click();
        });
        expect(window.open).toHaveBeenCalledOnce();
        await waitFor(() => expect(state.startOAuthConnect).toHaveBeenCalledOnce());
      });

      it("closes the popup and re-enables Connect when the sign-in cannot start", async () => {
        state.startOAuthConnect.mockRejectedValue(new Error("synthetic start failure"));
        await connectHubspot();
        expect(await screen.findByText("Could not start HubSpot. Try again.")).toBeInTheDocument();
        expect(popup.close).toHaveBeenCalled();
        expect(popup.location.replace).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
        expect(assign).not.toHaveBeenCalled();
      });

      it("refuses a non-https authorize URL and closes the popup", async () => {
        state.startOAuthConnect.mockResolvedValue({
          authorizeUrl: "http://evil.invalid/authorize",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          attemptId: "attempt-abcdefghijklmnopqrstuvwxyz0123456789",
          connectorId: "hubspot",
        });
        await connectHubspot();
        expect(await screen.findByText("Could not start HubSpot. Try again.")).toBeInTheDocument();
        expect(popup.location.replace).not.toHaveBeenCalled();
        expect(popup.close).toHaveBeenCalled();
        expect(window.localStorage.getItem(ATTEMPT_KEY)).toBeNull();
        expect(assign).not.toHaveBeenCalled();
      });

      it("refuses a start for a different connector and closes the popup", async () => {
        state.startOAuthConnect.mockResolvedValue({
          authorizeUrl: AUTHORIZE_URL,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          attemptId: "attempt-abcdefghijklmnopqrstuvwxyz0123456789",
          connectorId: "notion",
        });
        await connectHubspot();
        expect(await screen.findByText("Could not start HubSpot. Try again.")).toBeInTheDocument();
        expect(popup.location.replace).not.toHaveBeenCalled();
        expect(popup.close).toHaveBeenCalled();
      });

      it("still refuses on the native app without opening a window", async () => {
        state.overview.mockResolvedValue(withFlag([hubspot]));
        render(panel());
        const connect = await screen.findByRole("button", { name: "Connect HubSpot" });
        vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
        try {
          fireEvent.click(connect);
          expect(await screen.findByText("Connect HubSpot on the web. It works here once connected.")).toBeInTheDocument();
          expect(window.open).not.toHaveBeenCalled();
          expect(state.startOAuthConnect).not.toHaveBeenCalled();
          expect(assign).not.toHaveBeenCalled();
        } finally {
          vi.mocked(Capacitor.isNativePlatform).mockRestore();
        }
      });
    });
  });

  it("does not describe a failed Drive status check as disconnected", async () => {
    state.overview.mockRejectedValue(new Error("synthetic unavailable"));
    render(<ConnectorsPanel open initialConnector="google_drive" {...callbacks} />);
    expect(await screen.findByText("Connection status unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(screen.queryByText("Drive connection is unavailable in this session. Try again later.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Drive" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry Drive" })).toBeEnabled();
  });

  it("lets Profile hold the open connector and draws no header of its own", async () => {
    const onActiveConnectorChange = vi.fn();
    const view = render(
      <ConnectorsPanel
        open
        surface="profile"
        activeConnector={null}
        onActiveConnectorChange={onActiveConnectorChange}
        {...callbacks}
      />,
    );
    // Profile's pane header owns the title and Back.
    expect(await screen.findByRole("heading", { name: "Available" })).toBeInTheDocument();
    // Nothing is connected, so there is no empty "Connected" group to read past.
    expect(screen.queryByRole("heading", { name: "Connected" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to connectors" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close connectors" })).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Search connectors" })).not.toBeInTheDocument();
    expect(screen.getByTestId("profile-connector-row-calendar")).toHaveTextContent(
      "Plan around your schedule.",
    );
    const calendarRow = screen.getByRole("button", { name: /^Calendar/ });
    fireEvent.click(calendarRow);
    fireEvent.click(calendarRow);
    // Asked once: a double tap never stacks two identical history entries.
    expect(onActiveConnectorChange).toHaveBeenCalledExactlyOnceWith("calendar");
    view.rerender(
      <ConnectorsPanel
        open
        surface="profile"
        activeConnector="calendar"
        onActiveConnectorChange={onActiveConnectorChange}
        {...callbacks}
      />,
    );
    expect(await screen.findByRole("region", { name: "Calendar details" })).toBeInTheDocument();
  });

  it("offers explicit Gmail draft permission only for a connected account without it", async () => {
    state.gmailStatus = { connected: true, compose_permission_granted: false };
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Gmail" }));
    expect(screen.getByRole("button", { name: "Enable Gmail drafts" })).toBeInTheDocument();
    state.gmailStatus = { connected: true, compose_permission_granted: true };
    cleanup();
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Gmail" }));
    expect(screen.queryByRole("button", { name: "Enable Gmail drafts" })).not.toBeInTheDocument();
  });

  // The backend refuses a native grant that drops a scope the connection holds,
  // so a modify grant made on the web must ride along when drafts are enabled.
  it("carries existing Gmail send and modify grants into native draft consent", async () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    state.gmailStatus = { connected: true, compose_permission_granted: false, send_permission_granted: true, modify_permission_granted: true };
    state.startNativeConnect.mockResolvedValue({ configured: true, server_client_id: "native-client", purpose: "compose" });
    state.connectGmail.mockResolvedValue({ serverAuthCode: "one-time-code" });
    state.completeNativeConnect.mockResolvedValue(undefined);
    try {
      render(panel());
      fireEvent.click(await screen.findByRole("button", { name: "Gmail" }));
      fireEvent.click(screen.getByRole("button", { name: "Enable Gmail drafts" }));
      await waitFor(() => expect(state.connectGmail).toHaveBeenCalledWith({
        serverClientId: "native-client", purpose: "compose", preserveSend: true, preserveModify: true,
      }));
    } finally {
      vi.mocked(Capacitor.isNativePlatform).mockRestore();
    }
  });

  it("asks before a Gmail disconnect without leaving the list", async () => {
    state.gmailStatus = { connected: true, compose_permission_granted: true };
    render(panel());
    const connected = within(await screen.findByRole("region", { name: "Connected" }));
    fireEvent.click(await connected.findByRole("button", { name: "Disconnect Gmail" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Disconnect Mail?" });
    expect(within(dialog).getByText("Drive stays connected.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    // The question floated over the list; the person never left it.
    expect(screen.getByRole("region", { name: "Connected" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to connectors" })).not.toBeInTheDocument();
  });

  it("never duplicates the built-in Drive connection", async () => {
    state.overview.mockResolvedValue(overview([{ ...catalogItem, connectorId: "google_drive", displayName: "Duplicate Drive" }]));
    render(panel());
    await waitFor(() => expect(state.overview).toHaveBeenCalled());
    expect(screen.getAllByText("Google Drive")).toHaveLength(1);
    expect(screen.queryByText("Duplicate Drive")).not.toBeInTheDocument();
  });

  it("uses Calendar and vault Plaid status without duplicate built-ins", async () => {
    state.calendar = { connected: true, loaded: true, error: null, status: { status: "connected" } };
    state.financial.data = { data: { connections_v1: { synthetic: { status: "active" } } } };
    state.overview.mockResolvedValue(overview([
      { ...catalogItem, connectorId: "calendar", displayName: "Duplicate Calendar" },
      { ...catalogItem, connectorId: "plaid", displayName: "Duplicate Plaid" },
    ]));
    render(panel());
    await waitFor(() => expect(state.overview).toHaveBeenCalled());
    const connected = within(screen.getByRole("region", { name: "Connected" }));
    expect(connected.getByText("Calendar")).toBeInTheDocument();
    expect(connected.getByText("Plaid")).toBeInTheDocument();
    expect(screen.queryByText("Duplicate Calendar")).not.toBeInTheDocument();
    expect(screen.queryByText("Duplicate Plaid")).not.toBeInTheDocument();
  });

  it("filters the real connector list and restores it when search is cleared", async () => {
    state.overview.mockResolvedValue(overview([catalogItem]));
    render(panel());
    expect(await screen.findByText("Example Docs")).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search connectors" });
    fireEvent.change(search, { target: { value: "example" } });
    expect(screen.getByText("Example Docs")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Google Drive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gmail" })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Google Drive" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gmail" })).toBeInTheDocument();
  });

  it("offers Calendar connection when disconnected and a reviewed disconnect when connected", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const view = render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Connect Calendar" }));
    // Connecting stays inside the drawer: no route change, no drawer exit.
    expect(callbacks.onBack).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect Calendar" })).toBeEnabled());
    vi.mocked(window.open).mockRestore();
    state.calendar = { connected: true, loaded: true, error: null, status: { status: "connected" } };
    view.rerender(panel());
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Calendar" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Disconnect Calendar?" });
    expect(within(dialog).getByText("Other connections stay active.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(state.calendarDisconnect).toHaveBeenCalledExactlyOnceWith("synthetic-firebase-token", "owner-a"));
    await waitFor(() => expect(state.calendarRefresh).toHaveBeenCalledOnce());
  });

  it("keeps Calendar copy concise before and after connection", async () => {
    const view = render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Calendar" }));
    const calendar = await screen.findByRole("region", {
      name: "Calendar details",
    });

    expect(
      within(calendar).getByRole("heading", { name: "Google Calendar" }),
    ).toBeInTheDocument();
    expect(
      within(calendar).getByText("Plan around your schedule."),
    ).toBeInTheDocument();
    expect(within(calendar).getByText("Not connected")).toBeInTheDocument();
    expect(
      within(calendar).getByRole("button", { name: "Connect Calendar" }),
    ).toBeInTheDocument();
    expect(
      within(calendar).getByText("Private by default. Disconnect anytime."),
    ).toBeInTheDocument();

    state.calendar = {
      connected: false,
      loaded: true,
      error: null,
      status: { status: "needs_reauth" },
    };
    view.rerender(panel());

    expect(
      await within(calendar).findByText(
        "Reconnect to keep planning around your schedule.",
      ),
    ).toBeInTheDocument();
    expect(within(calendar).getByText("Reconnect needed")).toBeInTheDocument();
    expect(
      within(calendar).getByRole("button", { name: "Reconnect Calendar" }),
    ).toBeInTheDocument();

    state.calendar = {
      connected: true,
      loaded: true,
      error: null,
      status: { status: "connected", access_level: "manage" },
    };
    view.rerender(panel());

    expect(
      await within(calendar).findByText(
        "Your private agent can help schedule meetings. You approve every change.",
      ),
    ).toBeInTheDocument();
    expect(within(calendar).getByText("Connected")).toBeInTheDocument();
    expect(
      within(calendar).getByRole("button", { name: "Disconnect Calendar" }),
    ).toBeInTheDocument();
    expect(
      within(calendar).getByText("Disconnect anytime."),
    ).toBeInTheDocument();

    state.calendar = {
      connected: true,
      loaded: true,
      error: null,
      status: { status: "connected", access_level: "read" },
    };
    view.rerender(panel());

    expect(
      await within(calendar).findByText(
        "Your private agent can check your availability.",
      ),
    ).toBeInTheDocument();
  });

  describe("disconnect state transitions", () => {
    const connectedCalendar = () => {
      state.calendar = { connected: true, loaded: true, error: null, status: { status: "connected" } };
    };
    const askAndConfirm = async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Disconnect Calendar" }));
      const dialog = await screen.findByRole("alertdialog", { name: "Disconnect Calendar?" });
      return within(dialog).getByRole("button", { name: "Disconnect" });
    };

    it("sends one disconnect for a double tap and shows the row pending in place", async () => {
      connectedCalendar();
      let settle!: (value: unknown) => void;
      state.calendarDisconnect.mockImplementation(() => new Promise((done) => { settle = done; }));
      render(panel());
      const confirm = await askAndConfirm();
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      await waitFor(() => expect(state.calendarDisconnect).toHaveBeenCalledOnce());
      const connected = within(screen.getByRole("region", { name: "Connected" }));
      expect(connected.getByText("Disconnecting…")).toBeInTheDocument();
      expect(connected.getByRole("button", { name: "Disconnect Calendar" })).toBeDisabled();
      await act(async () => settle({ connected: false, status: "disconnected" }));
      await waitFor(() => expect(connected.queryByText("Disconnecting…")).not.toBeInTheDocument());
      expect(state.calendarDisconnect).toHaveBeenCalledOnce();
    });

    it("says a failed disconnect failed and lets the same row retry", async () => {
      connectedCalendar();
      state.calendarDisconnect
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValueOnce({ connected: false, status: "disconnected" });
      render(panel());
      fireEvent.click(await askAndConfirm());
      const connected = within(screen.getByRole("region", { name: "Connected" }));
      expect(await connected.findByText("Couldn't disconnect. Try again.")).toBeInTheDocument();
      expect(connected.getByRole("button", { name: "Disconnect Calendar" })).toBeEnabled();
      fireEvent.click(await askAndConfirm());
      await waitFor(() => expect(state.calendarDisconnect).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(connected.queryByText("Couldn't disconnect. Try again.")).not.toBeInTheDocument());
      expect(state.calendarRefresh).toHaveBeenCalledOnce();
    });

    it("keeps a disconnected row where it was until the list is revisited", async () => {
      connectedCalendar();
      const view = render(panel());
      fireEvent.click(await askAndConfirm());
      await waitFor(() => expect(state.calendarRefresh).toHaveBeenCalledOnce());
      state.calendar = { connected: false, loaded: true, error: null, status: { status: "disconnected" } };
      view.rerender(panel());
      // Updated in place: same section, new action, no re-sort under the finger.
      const connected = within(screen.getByRole("region", { name: "Connected" }));
      expect(connected.getByRole("button", { name: "Connect Calendar" })).toBeInTheDocument();
      fireEvent.click(connected.getByRole("button", { name: "Calendar" }));
      fireEvent.click(await screen.findByRole("button", { name: "Back to connectors" }));
      const available = within(await screen.findByRole("region", { name: "Available" }));
      expect(available.getByRole("button", { name: "Connect Calendar" })).toBeInTheDocument();
    });

    it("asks on the native app with a sheet rather than a dialog", async () => {
      connectedCalendar();
      vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
      try {
        render(panel());
        fireEvent.click(await screen.findByRole("button", { name: "Disconnect Calendar" }));
        const sheet = await screen.findByTestId("connector-confirm-sheet");
        expect(within(sheet).getByText("Disconnect Calendar?")).toBeInTheDocument();
        expect(screen.queryByTestId("connector-confirm-dialog")).not.toBeInTheDocument();
        fireEvent.click(within(sheet).getByRole("button", { name: "Disconnect" }));
        await waitFor(() => expect(state.calendarDisconnect).toHaveBeenCalledOnce());
      } finally {
        vi.mocked(Capacitor.isNativePlatform).mockRestore();
      }
    });
  });

  it("does not claim an unchecked Calendar connection is manageable", async () => {
    state.calendar = { connected: false, loaded: true, error: "Status unavailable", status: { status: "disconnected" } };
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Calendar" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.calendarRefresh).toHaveBeenCalledOnce();
    expect(state.push).not.toHaveBeenCalled();
  });

  it("rejects a delayed catalog after same-owner token rotation", async () => {
    let finish!: (value: ReturnType<typeof overview>) => void;
    state.overview.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(panel());
    await waitFor(() => expect(state.overview).toHaveBeenCalledTimes(1));
    state.token = "rotated-synthetic-token";
    view.rerender(panel());
    await waitFor(() => expect(state.overview).toHaveBeenCalledTimes(2));
    await act(async () => finish(overview([catalogItem])));
    expect(screen.queryByText("Example Docs")).not.toBeInTheDocument();
    expect(state.overview).toHaveBeenLastCalledWith("rotated-synthetic-token");
  });

  it("rejects a prior panel session's response after close and reopen", async () => {
    let finish!: (value: ReturnType<typeof overview>) => void;
    state.overview.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(panel());
    await waitFor(() => expect(state.overview).toHaveBeenCalledTimes(1));
    view.rerender(panel(false));
    view.rerender(panel());
    await waitFor(() => expect(state.overview).toHaveBeenCalledTimes(2));
    await act(async () => finish(overview([catalogItem])));
    expect(screen.queryByText("Example Docs")).not.toBeInTheDocument();
  });

  it("discards an old owner's delayed catalog", async () => {
    let finish!: (value: ReturnType<typeof overview>) => void;
    state.overview.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(panel());
    await waitFor(() => expect(state.overview).toHaveBeenCalledTimes(1));
    state.user.uid = "owner-b";
    state.token = "other-synthetic-token";
    view.rerender(panel());
    await act(async () => finish(overview([catalogItem])));
    expect(screen.queryByText("Example Docs")).not.toBeInTheDocument();
  });

  it("hides protected catalog immediately on vault lock", async () => {
    state.overview.mockResolvedValue(overview([catalogItem]));
    const view = render(panel());
    await screen.findByText("Example Docs");
    state.token = null;
    view.rerender(panel());
    expect(screen.queryByText("Example Docs")).not.toBeInTheDocument();
    expect(screen.getByText("Unlock your vault to manage connectors.")).toBeInTheDocument();
  });

  describe("Calendar connects in place", () => {
    const ATTEMPT_KEY = "one_google_oauth_popup_attempt_v1";
    const SETTLEMENT_KEY = "one_google_oauth_popup_settlement_v1";
    type FakeWindow = Window & { close: ReturnType<typeof vi.fn>; location: { replace: ReturnType<typeof vi.fn> } };
    const fakeWindow = () => {
      const store = new Map<string, string>();
      return {
        closed: false,
        close: vi.fn(),
        focus: vi.fn(),
        document: { title: "" },
        location: { replace: vi.fn() },
        sessionStorage: {
          setItem: (key: string, value: string) => void store.set(key, value),
          getItem: (key: string) => store.get(key) ?? null,
          removeItem: (key: string) => void store.delete(key),
        },
      } as unknown as FakeWindow;
    };
    const attemptOf = (target: Window) =>
      JSON.parse(target.sessionStorage.getItem(ATTEMPT_KEY) || "null") as { attemptId: string; service: string } | null;
    const settlement = (attemptId: string, outcome = "succeeded") => ({
      schemaVersion: 1,
      type: "google_oauth_settlement",
      attemptId,
      service: "calendar",
      outcome,
    });
    const post = (data: unknown, source: unknown, origin = window.location.origin) =>
      act(async () => {
        window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
      });
    const openCalendar = async () => {
      render(<ConnectorsPanel open initialConnector={null} {...callbacks} />);
      fireEvent.click(await screen.findByRole("button", { name: "Connect Calendar" }));
    };
    afterEach(() => {
      vi.restoreAllMocks();
      window.localStorage.clear();
    });

    it("opens a sized popup synchronously and settles only the exact popup attempt", async () => {
      const popup = fakeWindow();
      const open = vi.spyOn(window, "open").mockReturnValue(popup);
      await openCalendar();
      // Opened inside the click, before any awaited work.
      expect(open).toHaveBeenCalledExactlyOnceWith(
        "about:blank",
        "hushh-google-oauth",
        expect.stringContaining("popup=yes"),
      );
      await waitFor(() =>
        expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith(
          "https://accounts.google.com/o/oauth2/v2/auth?synthetic=calendar",
        ),
      );
      expect(state.calendarStartConnect).toHaveBeenCalledExactlyOnceWith({
        idToken: "synthetic-firebase-token",
        userId: "owner-a",
        accessLevel: "read",
      });
      expect(await screen.findByText("Finish signing in with Google in the window that opened.")).toBeInTheDocument();
      const attempt = attemptOf(popup);
      expect(attempt?.service).toBe("calendar");
      // The attempt marker in the popup carries no OAuth state or credentials.
      expect(popup.sessionStorage.getItem(ATTEMPT_KEY)).not.toContain("synthetic=calendar");

      // Negative controls: none of these may settle the attempt.
      await post(settlement(attempt!.attemptId), popup, "https://attacker.invalid");
      await post(settlement(attempt!.attemptId), window);
      await post(settlement("another-valid-attempt"), popup);
      await post({ ...settlement(attempt!.attemptId), service: "gmail_send" }, popup);
      await post({ ...settlement(attempt!.attemptId), type: "drive_oauth_settlement" }, popup);
      expect(state.calendarStatus).not.toHaveBeenCalled();
      expect(popup.close).not.toHaveBeenCalled();

      state.calendarStatus.mockResolvedValue({ configured: true, connected: true, status: "connected", access_level: "read" });
      await post(settlement(attempt!.attemptId), popup);
      expect(await screen.findByText("Calendar connected.")).toBeInTheDocument();
      expect(state.calendarStatus).toHaveBeenCalledOnce();
      expect(state.calendarRefresh).toHaveBeenCalledOnce();
      expect(popup.close).toHaveBeenCalled();
      // The drawer never left: no route change, no back navigation.
      expect(state.push).not.toHaveBeenCalled();
      expect(callbacks.onBack).not.toHaveBeenCalled();
      expect(screen.getByRole("region", { name: "Calendar details" })).toBeInTheDocument();

      // A late duplicate after settlement is ignored.
      await post(settlement(attempt!.attemptId), popup);
      expect(state.calendarStatus).toHaveBeenCalledOnce();
    });

    it("reports server truth, not the settlement, when the callback claims success", async () => {
      const popup = fakeWindow();
      vi.spyOn(window, "open").mockReturnValue(popup);
      await openCalendar();
      await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
      await post(settlement(attemptOf(popup)!.attemptId), popup);
      expect(await screen.findByText("Calendar not connected.")).toBeInTheDocument();
      expect(screen.queryByText("Calendar connected.")).not.toBeInTheDocument();
    });

    it("falls back to a new tab and settles through the storage event when the opener is severed", async () => {
      const tab = fakeWindow();
      const open = vi.spyOn(window, "open").mockImplementation(
        (_url?: string | URL, _target?: string, features?: string) => (features ? null : tab),
      );
      await openCalendar();
      expect(open).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenLastCalledWith("about:blank", "_blank", undefined);
      await waitFor(() => expect(tab.location.replace).toHaveBeenCalled());
      const attempt = attemptOf(tab)!;
      state.calendarStatus.mockResolvedValue({ configured: true, connected: true, status: "connected", access_level: "read" });
      // Google's opener policy can null window.opener; the callback's
      // same-origin storage write is then the only signal.
      await act(async () => {
        window.dispatchEvent(new StorageEvent("storage", {
          key: SETTLEMENT_KEY,
          newValue: JSON.stringify({ ...settlement(attempt.attemptId), sentAt: Date.now() }),
          storageArea: window.localStorage,
        }));
      });
      expect(await screen.findByText("Calendar connected.")).toBeInTheDocument();
      expect(state.push).not.toHaveBeenCalled();
    });

    it("stays in place without navigating when both popup and tab are refused", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      const before = window.location.href;
      await openCalendar();
      expect(open).toHaveBeenCalledTimes(2);
      expect(await screen.findByText("Allow pop-ups for One, then try again. Your chat and draft stay here.")).toBeInTheDocument();
      expect(state.calendarStartConnect).not.toHaveBeenCalled();
      expect(state.push).not.toHaveBeenCalled();
      expect(window.location.href).toBe(before);
    });

    it("cancelling sign-in shows a quiet not-connected state and ignores the late callback", async () => {
      const popup = fakeWindow();
      vi.spyOn(window, "open").mockReturnValue(popup);
      await openCalendar();
      await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
      const attempt = attemptOf(popup)!;
      fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
      expect(await screen.findByText("Calendar not connected.")).toBeInTheDocument();
      expect(popup.close).toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Cancel sign-in" })).not.toBeInTheDocument();
      await post(settlement(attempt.attemptId), popup);
      expect(state.calendarStatus).not.toHaveBeenCalled();
      expect(screen.queryByText(/could not/i)).not.toBeInTheDocument();
    });

    it("keeps Mail in place with the same guidance when popup and tab are refused", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      const before = window.location.href;
      render(<ConnectorsPanel open initialConnector={null} {...callbacks} />);
      fireEvent.click(await screen.findByRole("button", { name: "Connect Gmail" }));
      expect(await screen.findByText("Allow pop-ups for One, then try again. Your chat and draft stay here.")).toBeInTheDocument();
      expect(open).toHaveBeenCalledTimes(2);
      expect(state.push).not.toHaveBeenCalled();
      expect(window.location.href).toBe(before);
    });

    it("uses the native Google sheet on device without opening a window", async () => {
      vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
      const open = vi.spyOn(window, "open");
      state.calendarStartNativeConnect.mockResolvedValue({ configured: true, server_client_id: "native-client", service: "calendar", access_level: "read", state: "signed-state" });
      state.connectCalendar.mockResolvedValue({ serverAuthCode: "synthetic-auth-code" });
      state.calendarCompleteNativeConnect.mockResolvedValue({ connected: true, status: "connected" });
      state.calendarStatus.mockResolvedValue({ configured: true, connected: true, status: "connected", access_level: "read" });
      await openCalendar();
      expect(await screen.findByText("Calendar connected.")).toBeInTheDocument();
      expect(open).not.toHaveBeenCalled();
      expect(state.connectCalendar).toHaveBeenCalledExactlyOnceWith({ serverClientId: "native-client", accessLevel: "read" });
      expect(state.calendarCompleteNativeConnect).toHaveBeenCalledExactlyOnceWith({
        idToken: "synthetic-firebase-token",
        userId: "owner-a",
        accessLevel: "read",
        serverAuthCode: "synthetic-auth-code",
        state: "signed-state",
      });
      expect(state.push).not.toHaveBeenCalled();
    });

    it("treats a dismissed native sheet as quietly not connected", async () => {
      vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
      state.calendarStartNativeConnect.mockResolvedValue({ configured: true, server_client_id: "native-client", service: "calendar", access_level: "read", state: "signed-state" });
      state.connectCalendar.mockRejectedValue(Object.assign(new Error("cancelled"), { code: "USER_CANCELLED" }));
      await openCalendar();
      expect(await screen.findByText("Calendar not connected.")).toBeInTheDocument();
      expect(state.calendarCompleteNativeConnect).not.toHaveBeenCalled();
    });
  });

  describe("live Drive background preparation", () => {
    const liveDrive = (profile: "live" | "selected" = "live") => ({
      connectors: [
        {
          connectorId: "google_drive",
          displayName: "Google Drive",
          description: "Drive",
          authStyle: "oauth",
          profile,
          status: "connected",
          available: true,
        },
      ],
      features: {
        connections_panel_v2: true,
        google_drive_connection: true,
        google_drive_live: true,
      },
    });
    const openDrive = async () => {
      const view = render(panel());
      // The row moves from Available to Connected once the overview arrives;
      // click the connected row, not the detached pre-overview one.
      await screen.findByRole("button", { name: "Disconnect Google Drive" });
      fireEvent.click(screen.getByRole("button", { name: "Google Drive" }));
      return view;
    };

    it("explains default-on automatic Trusted Circle sharing before starting full Drive access", async () => {
      state.overview.mockResolvedValue({
        ...liveDrive(),
        connectors: [{ ...liveDrive().connectors[0], status: "not_connected" }],
      });
      render(panel());
      fireEvent.click(await screen.findByRole("button", { name: "Review Google Drive access" }));
      expect(state.startOAuthConnect).not.toHaveBeenCalled();
      const drive = screen.getByRole("region", { name: "Google Drive" });
      const disclosure = within(drive).getByText(/Full Drive access turns on background reads by default unless you turned them off/);
      expect(disclosure).toBeVisible();
      expect(within(drive).getByText(/send excerpts to Gemini, and share matching originals for document requests from accepted Trusted Circle members without asking again/)).toBeVisible();
      expect(within(drive).getByText(/requester can open a file only after Google confirms access/)).toBeVisible();
      expect(within(drive).getByText(/Turn background access off anytime; your choice is saved/)).toBeVisible();
      const connect = within(drive).getByRole("button", { name: "Connect Drive" });
      expect(connect).toBeEnabled();
      expect(disclosure.compareDocumentPosition(connect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("shows default-on background Drive access and lets its owner turn it off and on", async () => {
      state.overview.mockResolvedValue(liveDrive());
      await openDrive();
      const toggle = await screen.findByRole("switch", { name: "Background Drive access" });
      expect(toggle).toHaveAttribute("aria-checked", "true");
      expect(screen.getByText(/On by default. One may read Drive files, send excerpts to Gemini/)).toBeInTheDocument();
      expect(screen.getByText("On. Relevant work can continue while you’re away.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry Drive" })).not.toBeInTheDocument();
      expect(screen.getByText("Sharing and approval")).toBeInTheDocument();
      expect(screen.getByText(/Sharing a file needs your approval, document trust, or an accepted connection in your Trusted Circle/)).toBeInTheDocument();
      expect(state.liveBackground).toHaveBeenCalledWith("synthetic-owner-token");
      fireEvent.click(toggle);
      await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
      expect(state.setLiveBackground).toHaveBeenLastCalledWith("synthetic-owner-token", false);
      expect(screen.getByText("Off. New automatic document requests wait until you turn this on.")).toBeInTheDocument();
      expect(await screen.findByText("Background Drive access is off. New automatic document requests will wait.")).toBeInTheDocument();
      fireEvent.click(toggle);
      await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
      expect(state.setLiveBackground).toHaveBeenLastCalledWith("synthetic-owner-token", true);
    });

    it("reads a saved off choice after reopening Connections", async () => {
      state.overview.mockResolvedValue(liveDrive());
      state.liveBackground.mockResolvedValue(false);
      const view = await openDrive();
      expect(await screen.findByRole("switch", { name: "Background Drive access" })).toHaveAttribute("aria-checked", "false");
      view.unmount();
      await openDrive();
      expect(await screen.findByRole("switch", { name: "Background Drive access" })).toHaveAttribute("aria-checked", "false");
      expect(state.setLiveBackground).not.toHaveBeenCalled();
    });

    it("keeps the confirmed setting on when turning it off fails", async () => {
      state.overview.mockResolvedValue(liveDrive());
      state.setLiveBackground.mockRejectedValue(new Error("synthetic failure"));
      await openDrive();
      const toggle = await screen.findByRole("switch", { name: "Background Drive access" });
      await waitFor(() => expect(toggle).toBeEnabled());
      fireEvent.click(toggle);
      expect(
        await screen.findByText(
          "Drive could not finish this action. Check the connection and try again.",
        ),
      ).toBeInTheDocument();
      expect(toggle).toHaveAttribute("aria-checked", "true");
    });

    it("shows an unknown state and offers retry when the current setting cannot be read", async () => {
      state.overview.mockResolvedValue(liveDrive());
      state.liveBackground.mockRejectedValue(new Error("synthetic failure"));
      await openDrive();
      await waitFor(() => expect(state.liveBackground).toHaveBeenCalled());
      expect(await screen.findByRole("button", { name: "Retry setting" })).toBeEnabled();
      expect(screen.queryByRole("switch", { name: "Background Drive access" })).not.toBeInTheDocument();
      state.liveBackground.mockResolvedValue(true);
      fireEvent.click(screen.getByRole("button", { name: "Retry setting" }));
      expect(await screen.findByRole("switch", { name: "Background Drive access" })).toHaveAttribute("aria-checked", "true");
      expect(state.setLiveBackground).not.toHaveBeenCalled();
    });

    it("does not show a stale connected status after a failed refresh", async () => {
      state.overview.mockResolvedValue(liveDrive());
      const view = render(<ConnectorsPanel open initialConnector="google_drive" {...callbacks} />);
      const drive = await screen.findByRole("region", { name: "Google Drive" });
      await within(drive).findByText("Connected");
      state.overview.mockRejectedValue(new Error("synthetic unavailable"));
      state.token = "renewed-owner-token";
      view.rerender(<ConnectorsPanel open initialConnector="google_drive" {...callbacks} />);
      expect(await within(drive).findByText("Connection status unavailable")).toBeInTheDocument();
      expect(within(drive).queryByText("Connected")).not.toBeInTheDocument();
    });

    it("offers no background toggle for selected-file access", async () => {
      state.overview.mockResolvedValue(liveDrive("selected"));
      await openDrive();
      await waitFor(() => expect(state.overview).toHaveBeenCalled());
      expect(await screen.findByRole("button", { name: "Enable full Drive access" })).toBeInTheDocument();
      expect(screen.queryByRole("switch", { name: "Background Drive access" })).not.toBeInTheDocument();
      expect(state.liveBackground).not.toHaveBeenCalled();
    });
  });
});
