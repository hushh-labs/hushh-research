import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  invalidate: vi.fn(),
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
const send = () => fireEvent.click(screen.getByRole("button", { name: "Send" }));
describe("asking a connection about their Drive", () => {
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
  });
  afterEach(cleanup);

  it("offers one question field and no period or Google account step", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Ask about files" }));
    expect(screen.getByRole("dialog", { name: "Ask about their Drive" })).toBeVisible();
    expect(
      screen.getByText(
        "They see your question and decide. Nothing in their Drive is read unless they allow it. If they share files, you get Viewer access through the Google account linked to your One sign-in.",
      ),
    ).toBeVisible();
    const field = screen.getByLabelText("Your question");
    expect(field).toHaveAttribute("placeholder", "e.g. Find my bank statement from March");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByLabelText("Start date")).toBeNull();
    expect(screen.queryByLabelText("End date")).toBeNull();
    expect(screen.queryByRole("button", { name: "Request documents" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("sends exactly one question with a retry key, then shows the outgoing card", async () => {
    const reconcile = vi.fn();
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, reconcile);
    try {
      mount();
      await open("  potential bank statement  ");
      expect(state.createQuery).not.toHaveBeenCalled();
      const submit = screen.getByRole("button", { name: "Send" });
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
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't confirm it was sent. Send again. It won't be sent twice.");
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
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "Send" }).closest("form")!);
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

  it("does not offer asking when the feature is off", async () => {
    state.overview.mockResolvedValueOnce({ features: { drive_document_sharing: false } });
    mount();
    await waitFor(() => expect(state.overview).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Ask about files" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request files" })).toBeNull();
  });
});

describe("requesting exact files from a connection", () => {
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
  });
  afterEach(cleanup);

  async function openFiles(purpose = "Files modified in the last two days") {
    fireEvent.click(await screen.findByRole("button", { name: "Request files" }));
    fireEvent.change(screen.getByLabelText("What do you need?"), { target: { value: purpose } });
  }

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
      await openFiles("  Files modified in the last two days  ");
      expect(screen.getByRole("dialog", { name: "Request files" })).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Send request" }));
      expect(await screen.findByText("Request sent. No files have been shared yet.")).toBeVisible();
      expect(state.googleIdentity).toHaveBeenCalledOnce();
      expect(state.linkGoogle).not.toHaveBeenCalled();
      expect(state.createQuery).not.toHaveBeenCalled();
      expect(state.create).toHaveBeenCalledWith(
        "owner-b",
        firebaseProof,
        {
          ownerPersonRef: personRef,
          clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          purpose: { purpose: "Files modified in the last two days", periodStart: null, periodEnd: null },
        },
        expect.any(Function),
      );
      expect(reconcile).toHaveBeenCalledOnce();
      expect(state.invalidate).toHaveBeenCalledWith("b");
      const link = screen.getByRole("link", { name: "View request" }).getAttribute("href");
      expect(link).toContain(encodeURIComponent(`document_share_request:${requestId}`));
      expect(link).toContain("requestView=sent");
    } finally {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, reconcile);
    }
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
    expect(await screen.findByText("Request sent. No files have been shared yet.")).toBeVisible();
    expect(state.linkGoogle).toHaveBeenCalledOnce();
    expect(state.create.mock.calls[1][2].clientRequestId).toBe(
      state.create.mock.calls[0][2].clientRequestId,
    );
  });

  it("refuses an incomplete period before any identity check", async () => {
    mount();
    await openFiles();
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-01" } });
    expect(screen.getByText("Choose both dates, with the end on or after the start.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
    expect(state.googleIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ["identity_link_web_required", "Open One on the web to add your Google account once."],
    ["connection_required", "You need an active connection with this person."],
    ["sharing_unavailable", "File requests aren't available for this connection yet."],
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
    expect(state.googleIdentity).not.toHaveBeenCalled();
  });

  it("sends a draft without a period as the purpose alone", async () => {
    render(<DocumentRequestButton personRef={personRef} personName="A" draft={{
      clientRequestId, purpose: "Tax return", periodStart: null, periodEnd: null,
    }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask as a question" }));
    await waitFor(() => expect(state.createQuery.mock.calls[0][1].query).toBe("Tax return"));
  });

  it("requests the draft's exact files with its own retry key, then shows the request", async () => {
    state.googleIdentity.mockResolvedValue("synthetic-firebase-proof");
    state.create.mockResolvedValue({ requestId, status: "pending", revision: 1 });
    render(<DocumentRequestButton personRef={personRef} personName="A" draft={{
      clientRequestId, purpose: "Six months of statements",
      periodStart: "2026-03-01", periodEnd: "2026-08-31",
    }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Request files" }));
    expect(await screen.findByTestId("legacy-document-review")).toHaveTextContent(requestId);
    expect(state.create).toHaveBeenCalledWith(
      "owner-b",
      "synthetic-firebase-proof",
      {
        ownerPersonRef: personRef,
        clientRequestId,
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
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(state.createQuery).not.toHaveBeenCalled();
  });
});
