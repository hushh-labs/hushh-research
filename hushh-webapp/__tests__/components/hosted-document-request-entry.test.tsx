import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
const state = vi.hoisted(() => ({
  uid: "b",
  unlocked: true,
  epoch: 1,
  token: "owner-b",
  getToken: vi.fn(),
  overview: vi.fn(),
  googleIdentity: vi.fn(),
  linkGoogle: vi.fn(),
  create: vi.fn(),
  createQuery: vi.fn(),
  lookupClient: vi.fn(),
  quote: vi.fn(),
  invalidate: vi.fn(),
  recipientIdentity: vi.fn(),
  oneIdentity: vi.fn(),
  ensureConnector: vi.fn(),
  apiFetch: vi.fn(),
  featureData: { driveAgentPackagesEnabled: false, features: { drive_period_packets: true, drive_document_sharing: true } },
  hostingSession: null as null | { userId: string; vaultKey: string; vaultOwnerToken: string; isCurrent: () => boolean },
}));
vi.mock("@/lib/cache/use-stale-resource", () => ({
  useStaleResource: () => ({ data: state.featureData, error: null, refresh: vi.fn() }),
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({ CacheSyncService: { onConsentMutated: state.invalidate } }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: state.uid } }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: state.unlocked,
    getVaultOwnerToken: state.getToken,
    getVaultKey: () => state.hostingSession?.vaultKey ?? null,
  }),
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => state.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
  subscribeVaultSessionEpoch: () => () => undefined,
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: { overview: state.overview },
}));
// Asking a question never needs the asker's Google identity.
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdTokenWithRetry: state.oneIdentity, linkGoogleIdentity: state.linkGoogle, documentRequestIdentityToken: state.googleIdentity },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: state.apiFetch },
}));
vi.mock("@/components/consent/use-hosted-document-session", () => ({ useHostedDocumentSession: () => state.hostingSession }));
vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({ OneKycClientZkService: { ensureConnector: state.ensureConnector } }));
vi.mock("@/lib/services/drive-sharing-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/drive-sharing-service")>()),
  DriveSharingService: { create: state.create, createQuery: state.createQuery, lookupClient: state.lookupClient },
}));
vi.mock("@/lib/services/drive-request-pricing-service", () => ({
  DriveRequestPricingService: { quote: state.quote },
}));
// The server-verified Google account a new request's files would go to.
vi.mock("@/lib/services/drive-request-requester-service", () => ({
  DriveRequestRequesterService: { recipientIdentity: state.recipientIdentity },
}));
vi.mock("@/components/consent/drive-query-request-card", () => ({
  DriveQueryRequestCard: ({ requestId, direction, initial }: { requestId: string; direction?: string; initial?: { query: string } }) => (
    <div data-testid="drive-query-card" data-direction={direction}>{requestId}:{initial?.query}</div>
  ),
}));
vi.mock("@/components/consent/document-share-review", () => ({
  DocumentShareReview: ({ requestId }: { requestId: string }) => <div data-testid="legacy-document-review">{requestId}</div>,
}));
import { usePersonConnectorFeatures } from "@/lib/connections/use-person-connector-features";
import { DocumentRequestButton } from "@/components/consent/document-request-button";
const personRef = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const firebaseProof = "synthetic-firebase-proof";
const mount = () => render(<DocumentRequestButton personRef={personRef} personName="A" />);
describe("@feature_one_document_hosting real file-request entrypoint", () => {
  beforeEach(() => {
    vi.resetAllMocks(); vi.stubGlobal("crypto", webcrypto);
    state.uid = "b"; state.epoch = 1; state.token = "owner-b"; state.unlocked = true;
    state.getToken.mockImplementation(() => state.token);
    state.hostingSession = { userId: "b", vaultKey: "a".repeat(64), vaultOwnerToken: "owner-b", isCurrent: () => state.uid === "b" && state.epoch === 1 && state.token === "owner-b" };
    state.overview.mockResolvedValue({ features: { drive_document_sharing: true }, connectors: [] });
    state.quote.mockResolvedValue({ amountCents: 1000, version: 1, paymentRequired: true, priceReady: true, paymentsReady: true, payoutReady: true });
    state.googleIdentity.mockResolvedValue(firebaseProof);
    state.recipientIdentity.mockResolvedValue({ email: "b@gmail.test", provider: "google.com" });
    state.oneIdentity.mockResolvedValue("existing-one-firebase-id-token");
    state.ensureConnector.mockResolvedValue({ connector_key_id: "recipient-key", connector_public_key: btoa(String.fromCharCode(...new Uint8Array(32))) });
    state.apiFetch.mockImplementation(async (path: string) => new Response(JSON.stringify(path.endsWith("/delivery-readiness")
      ? { enabled: true, activityDisclosureVersion: "one-document-activity-v1" }
      : { requestId, delivery: { requestId } }), { status: 200 }));
  });
  afterEach(() => { cleanup(); state.hostingSession = null; vi.unstubAllGlobals(); });
  const openDrive = async (purpose: string) => {
    fireEvent.click(await screen.findByRole("button", { name: "Request files", exact: true }));
    await screen.findByText("About $10. You pay only if files are found.");
    fireEvent.change(screen.getByLabelText("Which files do you need?"), { target: { value: purpose } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-08-31" } });
  };
  it("serializes a legacy-compatible request while period-packet browsing is enabled", async () => {
    state.hostingSession = null;
    const actual = await vi.importActual<typeof import("@/lib/services/drive-sharing-service")>("@/lib/services/drive-sharing-service");
    state.create.mockImplementation(actual.DriveSharingService.create.bind(actual.DriveSharingService));
    state.apiFetch.mockResolvedValue(new Response(JSON.stringify({ requestId, status: "pending", revision: 1 }), { status: 202 }));
    function ProfileRequest() {
      const { availability } = usePersonConnectorFeatures("b", "owner-b", true);
      return <DocumentRequestButton personRef={personRef} personName="A" availability={availability} />;
    }
    render(<ProfileRequest />);
    await openDrive("Bank statements");
    const advancedFieldsVisible = Boolean(screen.queryByLabelText("Access period") || screen.queryByLabelText("Requesting as"));
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByText("Request sent.");
    const [path, options] = state.apiFetch.mock.calls[0];
    expect(path).toBe("/api/connectors/google_drive/sharing/requests");
    expect(JSON.parse(options!.body as string)).toMatchObject({
      ownerPersonRef: personRef,
      purpose: { purpose: "Bank statements", periodStart: "2026-03-01", periodEnd: "2026-08-31" },
      expectedQuoteVersion: 1,
      oneCopyRequested: true, activityAccepted: true, activityDisclosureVersion: "one-document-activity-v1",
    });
    expect(JSON.parse(options!.body as string)).not.toHaveProperty("accessDays");
    expect(JSON.parse(options!.body as string)).not.toHaveProperty("requesterActorType");
    expect(JSON.parse(options!.body as string)).not.toHaveProperty("reason");
    expect(advancedFieldsVisible).toBe(false);
  });
  it("keeps the verified RIA justification required for legacy Drive requests", async () => {
    state.hostingSession = null;
    state.overview.mockResolvedValueOnce({
      features: { drive_document_sharing: true }, connectors: [], driveAgentPackagesEnabled: true,
    });
    mount();
    await openDrive("Bank statements");
    fireEvent.change(screen.getByLabelText("Requesting as"), { target: { value: "ria" } });
    expect(screen.getByLabelText("Reason")).toBeRequired();
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Financial review" } });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledWith(
      "owner-b", firebaseProof, expect.objectContaining({
        requesterActorType: "ria", reason: "Financial review",
      }), expect.any(Function),
    ));
  });
  it("keeps One copies in the existing request without a mode picker, recipient key, or extra payment", async () => {
    state.create.mockResolvedValue({ requestId });
    mount(); await openDrive("Approved statements");
    expect(screen.queryByLabelText("Receive through")).not.toBeInTheDocument();
    expect(screen.getByText(/Sending accepts owner-visible access activity/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByText("Request sent.");
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.create.mock.calls[0][2]).toMatchObject({ oneCopyRequested: true, activityAccepted: true, activityDisclosureVersion: "one-document-activity-v1" });
    expect(state.ensureConnector).not.toHaveBeenCalled();
    expect(state.oneIdentity).not.toHaveBeenCalled();
    expect(state.apiFetch).not.toHaveBeenCalled();
  });
  it("drops a late identity result after the vault session changes", async () => {
    let resolve!: (token: string) => void;
    mount(); await openDrive("Approved statements");
    state.googleIdentity.mockReturnValueOnce(new Promise<string>(done => { resolve = done; }));
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(state.googleIdentity).toHaveBeenCalled());
    state.uid = "another-owner"; state.epoch++;
    await act(async () => resolve("late-previous-owner-token"));
    expect(state.create).not.toHaveBeenCalled();
    expect(screen.queryByText("Request sent.")).not.toBeInTheDocument();
  });
});
