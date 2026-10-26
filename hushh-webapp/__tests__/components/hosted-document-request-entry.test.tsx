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
  hostingSession: null as null | { userId: string; vaultKey: string; vaultOwnerToken: string; isCurrent: () => boolean },
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
import { DocumentRequestButton } from "@/components/consent/document-request-button";
const personRef = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const mount = () => render(<DocumentRequestButton personRef={personRef} personName="A" />);
describe("@feature_one_document_hosting real file-request entrypoint", () => {
  beforeEach(() => {
    vi.resetAllMocks(); vi.stubGlobal("crypto", webcrypto);
    state.uid = "b"; state.epoch = 1; state.token = "owner-b"; state.unlocked = true;
    state.getToken.mockImplementation(() => state.token);
    state.hostingSession = { userId: "b", vaultKey: "a".repeat(64), vaultOwnerToken: "owner-b", isCurrent: () => state.uid === "b" && state.epoch === 1 && state.token === "owner-b" };
    state.overview.mockResolvedValue({ features: { drive_document_sharing: false }, connectors: [] });
    state.oneIdentity.mockResolvedValue("existing-one-firebase-id-token");
    state.ensureConnector.mockResolvedValue({ connector_key_id: "recipient-key", connector_public_key: btoa(String.fromCharCode(...new Uint8Array(32))) });
    state.apiFetch.mockImplementation(async (path: string) => new Response(JSON.stringify(path.endsWith("/delivery-readiness")
      ? { enabled: true, activityDisclosureVersion: "one-document-activity-v1" }
      : { requestId, delivery: { requestId } }), { status: 200 }));
  });
  afterEach(() => { cleanup(); state.hostingSession = null; vi.unstubAllGlobals(); });
  const openOne = async () => {
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Request files", exact: true }));
    await waitFor(() => expect(screen.getByLabelText("Receive through")).toHaveValue("one"));
    fireEvent.change(screen.getByLabelText("Which files do you need?"), { target: { value: "Approved statements" } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-08-31" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /I accept that the owner can see access activity/ }));
  };
  it("sends One-only with matching Firebase and consent headers when legacy Drive is disabled, without a quote or Google prompt", async () => {
    await openOne();
    expect(screen.getByText(/The owner chooses the exact files, final price and access deadline/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText("Request sent.")).toBeVisible();
    const calls = state.apiFetch.mock.calls.filter(([path]) => path.endsWith("/delivery-requests"));
    expect(calls).toHaveLength(1);
    const options = calls[0][1];
    expect(options.headers).toMatchObject({ Authorization: "Bearer existing-one-firebase-id-token", "X-Hushh-Consent": "owner-b" });
    expect(JSON.parse(options.body)).toMatchObject({ receiveThrough: "one", ownerPersonRef: personRef, activityAccepted: true, recipientKeyId: "recipient-key" });
    expect(JSON.parse(options.body)).not.toHaveProperty("expectedQuoteVersion");
    expect(state.oneIdentity).toHaveBeenCalledWith({ expectedUserId: "b", retries: 0 });
    expect(state.quote).not.toHaveBeenCalled(); expect(state.googleIdentity).not.toHaveBeenCalled(); expect(state.linkGoogle).not.toHaveBeenCalled(); expect(state.recipientIdentity).not.toHaveBeenCalled(); expect(state.create).not.toHaveBeenCalled();
  });
  it("keeps intake disabled when both hosted readiness and legacy Drive are off", async () => {
    state.apiFetch.mockImplementation(async () => new Response(JSON.stringify({ enabled: false }), { status: 200 }));
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Request files", exact: true }));
    await waitFor(() => expect(state.apiFetch).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Which files do you need?"), { target: { value: "Approved statements" } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-08-31" } });
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
    expect(screen.queryByLabelText("Receive through")).not.toBeInTheDocument();
    expect(state.quote).not.toHaveBeenCalled(); expect(state.googleIdentity).not.toHaveBeenCalled(); expect(state.ensureConnector).not.toHaveBeenCalled();
  });
  it("refuses a late One identity response after an owner or vault session change", async () => {
    let resolve!: (token: string) => void;
    state.oneIdentity.mockReturnValueOnce(new Promise<string>(done => { resolve = done; }));
    await openOne(); fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(state.oneIdentity).toHaveBeenCalled());
    state.uid = "another-owner"; state.epoch++;
    await act(async () => resolve("late-previous-owner-token"));
    expect(state.apiFetch.mock.calls.filter(([path]) => path.endsWith("/delivery-requests"))).toHaveLength(0);
    expect(screen.queryByText("Request sent.")).not.toBeInTheDocument();
  });
});
