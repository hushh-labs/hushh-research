import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
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
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({ CacheSyncService: { onConsentMutated: state.invalidate } }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: state.uid } }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: state.unlocked,
    getVaultOwnerToken: state.getToken,
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
  AuthService: { linkGoogleIdentity: state.linkGoogle, documentRequestIdentityToken: state.googleIdentity },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: vi.fn() },
}));
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
import { CONSENT_ACTION_COMPLETE_EVENT } from "@/lib/consent/consent-events";
import { DriveSharingError } from "@/lib/services/drive-sharing-service";
const personRef = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const queryView = (query = "Six months of statements") => ({
  requestId,
  direction: "outgoing",
  status: "pending",
  revision: 1,
  query,
  counterpartName: "A",
  createdAt: "2026-09-24T10:00:00Z",
  expiresAt: "2026-10-01T10:00:00Z",
  decidedAt: null,
  answer: null,
  canDecide: false,
  lastError: null,
});
const mount = () =>
  render(<DocumentRequestButton personRef={personRef} personName="A" />);
async function open(value = "Six months of statements") {
  fireEvent.click(await screen.findByRole("button", { name: "Ask about files" }));
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value } });
}
const send = () => fireEvent.click(screen.getByRole("button", { name: "Send request" }));
describe("asking a connection about their Drive", () => {
  it("retains an accepted question while profile eligibility is rechecked", async () => {
    let accept!: (value: ReturnType<typeof queryView>) => void;
    state.createQuery.mockReturnValueOnce(new Promise((resolve) => { accept = resolve; }));
    const view = mount();
    await open("Which files cover the trip?");
    send();
    await waitFor(() => expect(state.createQuery).toHaveBeenCalledOnce());
    view.rerender(<DocumentRequestButton personRef={personRef} personName="A" canRequest={false} />);
    expect(screen.getByLabelText("Your question")).toHaveValue("Which files cover the trip?");
    await act(async () => accept(queryView("Which files cover the trip?")));
    await screen.findByTestId("drive-query-card");
    expect(state.createQuery).toHaveBeenCalledOnce();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    state.uid = "b";
    state.unlocked = true;
    state.epoch = 1;
    state.token = "owner-b";
    state.getToken.mockImplementation(() => state.token);
    state.overview.mockResolvedValue({
      features: { drive_document_sharing: true },
      connectors: [],
    });
    state.createQuery.mockImplementation(async (_token, draft) => queryView(draft.query));
    state.lookupClient.mockResolvedValue(null);
    state.quote.mockResolvedValue({ amountCents: 1000, version: 1, paymentRequired: true, priceReady: true, paymentsReady: true, payoutReady: true });
  });
  afterEach(cleanup);

  it.each(["Request files", "Ask about files"])("restores focus after %s closes with its opener removed", async (label) => {
    const returnFocusRef = createRef<HTMLButtonElement>();
    const content = (showTrigger: boolean) => <>
      <button ref={returnFocusRef}>Share profile</button>
      <DocumentRequestButton personRef={personRef} personName="A" showTrigger={showTrigger} canRequest={showTrigger} returnFocusRef={returnFocusRef} />
    </>;
    const view = render(content(true));
    fireEvent.click(await screen.findByRole("button", { name: label, exact: true }));
    expect(screen.getByRole("dialog")).toBeVisible();
    view.rerender(content(false));
    fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
    await waitFor(() => expect(returnFocusRef.current).toHaveFocus());
  });

  it("offers one question field and no period or Google account step", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Ask about files" }));
    expect(screen.getByRole("dialog", { name: "Ask about files" })).toBeVisible();
    expect(
      screen.getByText(
        "They see your question and decide. Nothing in their Drive is read unless they allow it. If they share files, you get Viewer access through the Google account linked to your One sign-in.",
      ),
    ).toBeVisible();
    const field = screen.getByLabelText("Your question");
    expect(field).toHaveAttribute("placeholder", "Which file has your latest project update?");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByLabelText("Start date")).toBeNull();
    expect(screen.queryByLabelText("End date")).toBeNull();
    expect(screen.queryByRole("button", { name: "Request documents" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
  });

  it("sends exactly one question with a retry key, then shows the outgoing card", async () => {
    const reconcile = vi.fn();
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, reconcile);
    try {
      mount();
      await open("  potential bank statement  ");
      expect(state.createQuery).not.toHaveBeenCalled();
      const submit = screen.getByRole("button", { name: "Send request" });
      fireEvent.click(submit);
      fireEvent.click(submit);
      const card = await screen.findByTestId("drive-query-card");
      expect(card).toHaveTextContent(`${requestId}:potential bank statement`);
      expect(card).toHaveAttribute("data-direction", "outgoing");
      expect(state.createQuery).toHaveBeenCalledOnce();
      expect(state.createQuery).toHaveBeenCalledWith(
        "owner-b",
        { ownerPersonRef: personRef, clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/), query: "potential bank statement" },
        expect.any(Function),
      );
      expect(state.googleIdentity).not.toHaveBeenCalled();
      expect(state.linkGoogle).not.toHaveBeenCalled();
      expect(state.create).not.toHaveBeenCalled();
      expect(reconcile).toHaveBeenCalledOnce();
      expect(state.invalidate).toHaveBeenCalledWith("b");
      const link = screen.getByRole("link", { name: "View question" }).getAttribute("href");
      expect(link).toContain("requestView=sent");
      expect(link).toContain(encodeURIComponent(`drive_query_request:${requestId}`));
      expect(link).not.toContain("statement");
    } finally {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, reconcile);
    }
  });

  it("preserves the retry key for an unchanged question and uses a new one when it changes", async () => {
    state.createQuery.mockRejectedValue(new Error("private-provider-error"));
    mount();
    await open();
    send();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't confirm sending. Try again.");
    const firstId = state.createQuery.mock.calls[0][1].clientRequestId;
    send();
    await waitFor(() => expect(state.createQuery).toHaveBeenCalledTimes(2));
    expect(state.createQuery.mock.calls[1][1].clientRequestId).toBe(firstId);
    expect(screen.queryByText("private-provider-error")).toBeNull();
    expect(screen.getByLabelText("Your question")).toHaveValue("Six months of statements");
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "A new question" } });
    send();
    await waitFor(() => expect(state.createQuery).toHaveBeenCalledTimes(3));
    expect(state.createQuery.mock.calls[2][1].clientRequestId).not.toBe(firstId);
  });

  it.each([
    ["connection_required", "You need an active connection with this person."],
    ["sharing_unavailable", "Drive questions aren't available for this connection yet."],
  ])("maps %s to plain copy", async (code, copy) => {
    state.createQuery.mockRejectedValueOnce(new DriveSharingError(code, 409));
    mount();
    await open();
    send();
    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
  });

  it("refuses a question over the UTF-8 byte limit before sending", async () => {
    mount();
    await open("€".repeat(700));
    expect(screen.getByText("Shorten your question.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "Send request" }).closest("form")!);
    expect(state.createQuery).not.toHaveBeenCalled();
  });

  it("prevents dismissal during POST and reconciles exactly once on acknowledgement", async () => {
    let finish!: (value: unknown) => void;
    state.createQuery.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const reconcile = vi.fn();
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, reconcile);
    try {
      mount();
      await open();
      send();
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(screen.getByRole("dialog")).toBeVisible();
      await act(async () => finish(queryView()));
      expect(reconcile).toHaveBeenCalledOnce();
      expect(state.invalidate).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, reconcile);
    }
  });

  it("clears the private draft and drops a late result after locking", async () => {
    let finish!: (value: unknown) => void;
    state.createQuery.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const rendered = mount();
    await open();
    send();
    state.unlocked = false;
    state.epoch++;
    rendered.rerender(<DocumentRequestButton personRef={personRef} personName="A" />);
    await act(async () => finish(queryView()));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(state.invalidate).not.toHaveBeenCalled();
    state.unlocked = true;
    rendered.rerender(<DocumentRequestButton personRef={personRef} personName="A" />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask about files" }));
    expect(screen.getByLabelText("Your question")).toHaveValue("");
    expect(screen.queryByTestId("drive-query-card")).toBeNull();
  });

  it("allows a second intentional question after a successful send", async () => {
    mount();
    await open();
    send();
    fireEvent.click(await screen.findByRole("button", { name: "Ask another question" }));
    expect(screen.getByLabelText("Your question")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "Statements again" } });
    send();
    await waitFor(() => expect(state.createQuery).toHaveBeenCalledTimes(2));
    expect(state.createQuery.mock.calls[1][1].clientRequestId).not.toBe(
      state.createQuery.mock.calls[0][1].clientRequestId,
    );
  });

  it("keeps action positions and explains unavailable intake without sending", async () => {
    state.overview.mockResolvedValueOnce({ features: { drive_document_sharing: false } });
    mount();
    await waitFor(() => expect(state.overview).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Ask about files" }));
    await screen.findByText("File requests are unavailable for this connection.");
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
    expect(state.createQuery).not.toHaveBeenCalled();
  });
});

describe("requesting exact files from a connection", () => {
  it("keeps an accepted file receipt through a connection refresh", async () => {
    let accept!: (value: { requestId: string; status: string; revision: number }) => void;
    state.create.mockReturnValueOnce(new Promise((resolve) => { accept = resolve; }));
    const view = mount();
    await openFiles();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledOnce());
    view.rerender(<DocumentRequestButton personRef={personRef} personName="A" canRequest={false} />);
    await act(async () => accept({ requestId, status: "pending", revision: 1 }));
    await screen.findByText("Request sent.");
    expect(state.create).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Request more files" })).toBeDisabled();
  });
  const firebaseProof = "synthetic-firebase-proof";
  beforeEach(() => {
    vi.resetAllMocks();
    state.uid = "b";
    state.unlocked = true;
    state.epoch = 1;
    state.token = "owner-b";
    state.getToken.mockImplementation(() => state.token);
    state.overview.mockResolvedValue({ features: { drive_document_sharing: true }, connectors: [] });
    state.googleIdentity.mockResolvedValue(firebaseProof);
    state.linkGoogle.mockResolvedValue(firebaseProof);
    state.create.mockResolvedValue({ requestId, status: "pending", revision: 1 });
    state.lookupClient.mockResolvedValue(null);
    state.quote.mockResolvedValue({ amountCents: 1000, version: 1, paymentRequired: true, priceReady: true, paymentsReady: true, payoutReady: true });
    state.recipientIdentity.mockResolvedValue({ email: "b@gmail.test", provider: "google.com" });
  });
  afterEach(cleanup);

  async function openFiles(purpose = "Six months of statements", withDates = true) {
    fireEvent.click(await screen.findByRole("button", { name: "Request files" }));
    expect(await screen.findByText("About $10. You pay only if files are found.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Which files do you need?"), { target: { value: purpose } });
    if (withDates) {
      fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-03-01" } });
      fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-08-31" } });
    }
  }

  it("opens a focused dialog over the shared backdrop", async () => {
    mount();
    const opener = await screen.findByRole("button", { name: "Request files" });
    await openFiles();

    expect(screen.getByRole("dialog", { name: "Request files" })).toBeVisible();
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeVisible();
    expect(screen.getByText("To A")).toBeVisible();
    expect(screen.queryByText(/You get original Drive links/)).toBeNull();
    expect(screen.queryByText(/You don't connect your Drive/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("offers both actions next to each other", async () => {
    mount();
    expect(await screen.findByRole("button", { name: "Request files" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Ask about files" })).toBeVisible();
  });

  it("uses the Google account already linked to the sign-in, never a Drive grant or a question", async () => {
    const reconcile = vi.fn();
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, reconcile);
    try {
      mount();
      await openFiles("  Files modified in the last two days  ", false);
      expect(screen.getByRole("dialog", { name: "Request files" })).toBeVisible();
      expect(screen.getByRole("group", { name: "Dates covered" })).toHaveAccessibleDescription("Start and end dates are required.");
      expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
      // Opening previews the account once; sending proves it again.
      expect(await screen.findByText("Files will be shared with b@gmail.test")).toBeVisible();
      expect(state.googleIdentity).toHaveBeenCalledOnce();
      expect(state.recipientIdentity).toHaveBeenCalledWith("owner-b", firebaseProof, expect.any(Function));
      fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-29" } });
      fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-10-01" } });
      fireEvent.click(screen.getByRole("button", { name: "Send request" }));
      expect(await screen.findByText("Request sent.")).toBeVisible();
      expect(state.googleIdentity).toHaveBeenCalledTimes(2);
      expect(state.linkGoogle).not.toHaveBeenCalled();
      expect(state.createQuery).not.toHaveBeenCalled();
      expect(state.create).toHaveBeenCalledWith(
        "owner-b",
        firebaseProof,
        {
          ownerPersonRef: personRef, activityDisclosureVersion: "one-document-activity-v1",
          clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          expectedQuoteVersion: 1, oneCopyRequested: true, activityAccepted: true,
          purpose: { purpose: "Files modified in the last two days", periodStart: "2026-09-29", periodEnd: "2026-10-01" },
        },
        expect.any(Function),
      );
      expect(reconcile).toHaveBeenCalledOnce();
      expect(state.invalidate).toHaveBeenCalledWith("b");
      expect(screen.getByText("Request sent.")).toHaveAttribute("role", "status");
      expect(screen.getByRole("button", { name: "Request more files" })).toHaveClass("h-[50px]");
      const link = screen.getByRole("link", { name: "View request" }).getAttribute("href");
      expect(link).toContain(encodeURIComponent(`document_share_request:${requestId}`));
      expect(link).toContain("requestView=sent");
    } finally {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, reconcile);
    }
  });

  it("sends a plain file request with only the purpose and selected dates", async () => {
    mount();
    await openFiles("Bank statements");
    expect(screen.queryByLabelText("Requesting as")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Access period")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledWith(
      "owner-b", firebaseProof, expect.objectContaining({
        purpose: expect.objectContaining({ purpose: "Bank statements" }) }), expect.any(Function),
    ));
    expect(state.create.mock.calls[0][2]).not.toHaveProperty("accessDays");
    expect(state.create.mock.calls[0][2]).not.toHaveProperty("requesterActorType");
    expect(state.create.mock.calls[0][2]).not.toHaveProperty("reason");
  });

  it("keeps V1 request terms available when agent packages are enabled", async () => {
    state.overview.mockResolvedValue({
      features: { drive_document_sharing: true }, connectors: [], driveAgentPackagesEnabled: true,
    });
    mount();
    await openFiles("Bank statements");
    fireEvent.change(screen.getByLabelText("Access period"), { target: { value: "7" } });
    expect(screen.queryByLabelText(/Reason/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledWith(
      "owner-b", firebaseProof, expect.objectContaining({
        accessDays: 7, requesterActorType: "person",
      }), expect.any(Function),
    ));
  });

  it("asks to link Google only when the sign-in has none, then retries with the same key", async () => {
    state.create
      .mockRejectedValueOnce(new DriveSharingError("verify_google_identity_required", 409))
      .mockResolvedValueOnce({ requestId, status: "pending", revision: 1 });
    mount();
    await openFiles();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Add a Google account once to receive original files.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Google account" }));
    expect(await screen.findByText("Request sent.")).toBeVisible();
    expect(state.linkGoogle).toHaveBeenCalledOnce();
    expect(state.create.mock.calls[1][2].clientRequestId).toBe(
      state.create.mock.calls[0][2].clientRequestId,
    );
  });

  it("refreshes a stale quote before retrying with a new version and key", async () => {
    state.quote.mockResolvedValueOnce({ amountCents: 1000, version: 1, paymentRequired: true, priceReady: true, paymentsReady: true, payoutReady: true })
      .mockResolvedValueOnce({ amountCents: 2500, version: 2, paymentRequired: true, priceReady: true, paymentsReady: true, payoutReady: true });
    state.create.mockRejectedValueOnce(new DriveSharingError("price_changed", 409))
      .mockResolvedValueOnce({ requestId, status: "pending", revision: 1 });
    mount();
    await openFiles();
    expect(state.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Review the updated quote");
    expect(await screen.findByText("About $25. You pay only if files are found.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText("Request sent.")).toBeVisible();
    expect(state.create.mock.calls[0][2].expectedQuoteVersion).toBe(1);
    expect(state.create.mock.calls[1][2].expectedQuoteVersion).toBe(2);
    expect(state.create.mock.calls[1][2].clientRequestId).not.toBe(state.create.mock.calls[0][2].clientRequestId);
  });

  it("allows a request to wait for owner price and payout setup without inventing a price", async () => {
    state.quote.mockResolvedValueOnce({ amountCents: null, version: 0, paymentRequired: true,
      priceReady: false, payoutReady: false, paymentsReady: false });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Request files" }));
    expect(await screen.findByText("A sets the price. You see it before you pay.")).toBeVisible();
    expect(screen.getByText("We'll ask the owner to set up payouts.")).toBeVisible();
    expect(screen.queryByText(/\$10/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Which files do you need?"), { target: { value: "Bank statements" } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-08-31" } });
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText("Request sent.")).toBeVisible();
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.create.mock.calls[0][2]).toMatchObject({ expectedQuoteVersion: 0 });
  });

  it("starts the price line with a capital when the name is the fallback", async () => {
    state.quote.mockResolvedValueOnce({ amountCents: null, version: 0, paymentRequired: true,
      priceReady: false, payoutReady: true, paymentsReady: true });
    render(<DocumentRequestButton personRef={personRef} personName="this person" />);
    fireEvent.click(await screen.findByRole("button", { name: "Request files" }));
    expect(await screen.findByText("This person sets the price. You see it before you pay.")).toBeVisible();
  });

  it("retries a failed price check, and says when no payment is needed", async () => {
    state.quote.mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ amountCents: null, version: 3, paymentRequired: false, priceReady: true, paymentsReady: true, payoutReady: true });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Request files" }));
    expect(await screen.findByText("Couldn't check the price.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No payment needed.")).toBeVisible();
    expect(state.quote).toHaveBeenCalledTimes(2);
  });

  it("refuses an incomplete period before sending or linking anything", async () => {
    mount();
    await openFiles(undefined, false);
    expect(screen.getByRole("group", { name: "Dates covered" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-01" } });
    expect(screen.getByText("Choose a start and end date.")).toBeVisible();
    expect(screen.queryByText("The end date must be on or after the start date.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-08-31" } });
    expect(screen.getByText("The end date must be on or after the start date.")).toBeVisible();
    expect(screen.queryByText("Choose a start and end date.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
    expect(state.linkGoogle).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("asks for a Google account before sending when none is linked, then links it on send", async () => {
    state.recipientIdentity.mockRejectedValue(new DriveSharingError("verify_google_identity_required", 409));
    mount();
    await openFiles();
    expect(await screen.findByText("Add a Google account to receive the files.")).toBeVisible();
    expect(screen.queryByText(/Files will be shared with/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add Google account" }));
    expect(await screen.findByText("Request sent.")).toBeVisible();
    // The send linked the account first instead of failing on the server.
    expect(state.linkGoogle).toHaveBeenCalledOnce();
    expect(state.googleIdentity).toHaveBeenCalledOnce();
    expect(state.create).toHaveBeenCalledOnce();
  });

  it("keeps sending possible when the account check is unavailable", async () => {
    state.recipientIdentity.mockRejectedValue(new DriveSharingError("identity_verification_unavailable", 503));
    mount();
    await openFiles();
    await waitFor(() => expect(state.recipientIdentity).toHaveBeenCalled());
    expect(screen.queryByText(/Files will be shared with/)).toBeNull();
    expect(screen.queryByText("Add a Google account to receive the files.")).toBeNull();
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled();
  });

  it.each([
    ["identity_link_web_required", "Open One on the web to add your Google account once."],
    ["connection_required", "You need an active connection with this person."],
    ["sharing_unavailable", "File requests aren't available for this connection yet."],
    ["date_range_required", "Choose a start and end date."],
  ])("maps %s to plain copy", async (code, copy) => {
    state.create.mockRejectedValueOnce(new DriveSharingError(code, 409));
    mount();
    await openFiles();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
  });
});

describe("chat draft question card", () => {
  const clientRequestId = "33333333-3333-4333-8333-333333333333";
  beforeEach(() => {
    vi.resetAllMocks();
    state.uid = "b";
    state.unlocked = true;
    state.epoch = 1;
    state.token = "owner-b";
    state.getToken.mockImplementation(() => state.token);
    state.overview.mockResolvedValue({ features: { drive_document_sharing: true }, connectors: [] });
    state.createQuery.mockImplementation(async (_token, draft) => queryView(draft.query));
    state.lookupClient.mockResolvedValue(null);
    state.quote.mockResolvedValue({ amountCents: 1000, version: 1, paymentRequired: true, priceReady: true, paymentsReady: true, payoutReady: true });
    state.recipientIdentity.mockResolvedValue({ email: "b@gmail.test", provider: "google.com" });
  });
  afterEach(cleanup);

  it("sends the draft purpose and period as one question with the original retry key, only after a tap", async () => {
    render(<DocumentRequestButton personRef={personRef} personName="A" draft={{
      clientRequestId, purpose: "Six months of statements",
      periodStart: "2026-03-01", periodEnd: "2026-08-31",
    }} />);
    expect(await screen.findByText("Ask A: “Six months of statements (2026-03-01 to 2026-08-31)”")).toBeVisible();
    expect(state.createQuery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ask as a question" }));
    await waitFor(() => expect(state.createQuery).toHaveBeenCalledWith(
      "owner-b",
      { ownerPersonRef: personRef, clientRequestId, query: "Six months of statements (2026-03-01 to 2026-08-31)" },
      expect.any(Function),
    ));
    expect(await screen.findByTestId("drive-query-card")).toHaveAttribute("data-direction", "outgoing");
    expect(state.linkGoogle).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("blocks an undated draft even without relative date words", async () => {
    render(<DocumentRequestButton personRef={personRef} personName="A" draft={{
      clientRequestId, purpose: "Tax return", periodStart: null, periodEnd: null,
    }} />);
    expect(await screen.findByText("Choose exact start and end dates with your private agent before sending this request.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Request files" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ask as a question" })).toBeDisabled();
    expect(state.createQuery).not.toHaveBeenCalled();
  });

  it("blocks a relative-day draft until the requester gives exact dates", async () => {
    render(<DocumentRequestButton personRef={personRef} personName="A" draft={{
      clientRequestId, purpose: "last 3 days standup notes", periodStart: null, periodEnd: null,
    }} />);
    expect(await screen.findByText("Choose exact start and end dates with your private agent before sending this request.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Request files" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ask as a question" })).toBeDisabled();
    expect(state.create).not.toHaveBeenCalled();
    expect(state.createQuery).not.toHaveBeenCalled();
  });

  it("requests the draft's exact files with its own retry key, then shows the request", async () => {
    state.googleIdentity.mockResolvedValue("synthetic-firebase-proof");
    state.create.mockResolvedValue({ requestId, status: "pending", revision: 1 });
    render(<DocumentRequestButton personRef={personRef} personName="A" draft={{
      clientRequestId, purpose: "Six months of statements",
      periodStart: "2026-03-01", periodEnd: "2026-08-31",
    }} />);
    expect(await screen.findByText("About $10. You pay only if files are found.")).toBeVisible();
    expect(await screen.findByText("Files will be shared with b@gmail.test")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Request files" }));
    expect(await screen.findByTestId("legacy-document-review")).toHaveTextContent(requestId);
    expect(state.create).toHaveBeenCalledWith(
      "owner-b",
      "synthetic-firebase-proof",
      {
        ownerPersonRef: personRef, activityDisclosureVersion: "one-document-activity-v1",
        clientRequestId,
        expectedQuoteVersion: 1, oneCopyRequested: true, activityAccepted: true,
        purpose: { purpose: "Six months of statements", periodStart: "2026-03-01", periodEnd: "2026-08-31" },
      },
      expect.any(Function),
    );
    expect(state.createQuery).not.toHaveBeenCalled();
  });

  it("keeps showing a file request that this card already sent", async () => {
    state.lookupClient.mockResolvedValue(requestId);
    render(<DocumentRequestButton personRef={personRef} personName="A" draft={{
      clientRequestId, purpose: "Statements", periodStart: null, periodEnd: null,
    }} />);
    expect(await screen.findByTestId("legacy-document-review")).toHaveTextContent(requestId);
    expect(screen.queryByRole("button", { name: "Send request" })).toBeNull();
    expect(state.createQuery).not.toHaveBeenCalled();
  });
});
