import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRequestPriceSheetProps as PriceSheetProps } from "@/components/consent/document-request-price-sheet";
const state = vi.hoisted(() => ({
  uid: "a",
  providers: [] as { providerId: string; email: string | null }[],
  unlocked: true,
  token: "owner-a",
  epoch: 1,
  getToken: vi.fn(),
  status: vi.fn(),
  review: vi.fn(),
  delivery: vi.fn(),
  approve: vi.fn(),
  decide: vi.fn(),
  allow: vi.fn(),
  setRequestPrice: vi.fn(),
  prepareRevocation: vi.fn(),
  prepare: vi.fn(),
  prepareStream: vi.fn(),
  startRequestSearch: vi.fn(),
  requestSearchFiles: vi.fn(),
  prepareRequestBulk: vi.fn(),
  prepareRequestBatch: vi.fn(),
  setLiveBackground: vi.fn(),
  overview: vi.fn(),
  bulkShareFiles: vi.fn(),
  approveBulkShare: vi.fn(),
  retryBulkShare: vi.fn(),
  deliveryFiles: vi.fn(),
  revoke: vi.fn(),
  periodic: vi.fn(),
  requesterContext: vi.fn(),
  reviewRequest: vi.fn(),
}));
const searchStream = vi.hoisted(() => ({ status: vi.fn() }));
const priceSheet = vi.hoisted(() => ({ props: null as PriceSheetProps | null }));
vi.mock("@/lib/services/drive-request-requester-service", () => ({
  DriveRequestRequesterService: { reviewRequest: state.reviewRequest },
}));
// The price controls are their own component; this stands in at its prop contract.
vi.mock("@/components/consent/document-request-price-sheet", async (original) => ({
  ...(await original<typeof import("@/components/consent/document-request-price-sheet")>()),
  DocumentRequestPriceSheet: (props: PriceSheetProps) => {
    priceSheet.props = props;
    if (!props.open) return null;
    return (
      <div role="dialog" aria-label="Set a price">
        {props.error ? <p role="alert">{props.error}</p> : null}
        <button type="button" disabled={props.busy} onClick={() => props.onSubmit(2000)}>
          Submit $20
        </button>
      </div>
    );
  },
}));
vi.mock("@/components/consent/document-payout-account", () => ({
  DocumentPayoutAccountCard: () => <div data-testid="document-payout-account-card" />,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: state.uid, providerData: state.providers } }),
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
vi.mock("@/lib/perf/use-periodic-task", () => ({
  useCoarseClock: () => Date.now(),
  usePeriodicTask: state.periodic,
}));
vi.mock("@/lib/services/drive-sharing-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/drive-sharing-service")>()),
  DriveSharingService: state,
}));
vi.mock("@/lib/services/drive-search-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/drive-search-service")>()),
  DriveSearchService: { streamStatus: searchStream.status },
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: { setLiveBackground: state.setLiveBackground, overview: state.overview },
}));
import { DocumentShareReview } from "@/components/consent/document-share-review";
import {
  DriveSharingError,
  StreamUnavailable,
} from "@/lib/services/drive-sharing-service";
const requestId = "11111111-1111-4111-8111-111111111111";
const review = () => ({
  revision: 3,
  status: "review_ready",
  recipientEmail: "b@example.invalid",
  purpose: {
    purpose: "Statements",
    periodStart: "2026-01-01",
    periodEnd: "2026-06-30",
  },
  files: [
    { documentId: "document-one", name: "<script>Untrusted.pdf</script>" },
  ],
  coverage: {
    summary: "January only",
    status: "partial",
    gaps: ["February to June"],
    truncated: true,
  },
  canApprove: true,
  reviewDigest: "a".repeat(64),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const initial = () => ({
  requestId,
  direction: "incoming",
  revision: 3,
  status: "review_ready",
});
const delivery = () => ({
  status: "completed",
  files: [
    {
      name: "Approved.pdf",
      status: "succeeded",
      managed: true,
      grantId: "grant",
      revocationStatus: null,
      openUrl: "https://drive.google.com/file/d/approved/view",
    },
  ],
});
// GET /context for a request the requester wrote.
const requesterTerms = (overrides: Record<string, unknown> = {}) => ({
  requestId,
  purpose: { purpose: "Six months of statements", periodStart: "2026-01-01", periodEnd: "2026-06-30" },
  recipientEmail: "b@gmail.test",
  requestedAt: "2026-10-01T10:00:00Z",
  timeZone: null,
  ...overrides,
});
const pending = (revision = 0) => ({
  requestId,
  direction: "incoming",
  revision,
  status: "pending",
});
// What GET /review returns before preparation has published anything.
const partial = (overrides: Record<string, unknown> = {}) => ({
  ...review(),
  revision: 0,
  status: "pending",
  files: [],
  coverage: null,
  canApprove: false,
  reviewDigest: null,
  expiresAt: null,
  preparationError: null,
  ...overrides,
});
const searchJobId = "33333333-3333-4333-8333-333333333333";
const bulkShareId = "44444444-4444-4444-8444-444444444444";
const durableSearch = (overrides: Record<string, unknown> = {}) => ({
  jobId: searchJobId,
  status: "running",
  revision: 3,
  matched: 250,
  pagesScanned: 2,
  incompleteSearch: false,
  canStop: false,
  createdAt: "2026-09-28T00:00:00Z",
  updatedAt: "2026-09-28T00:01:00Z",
  expiresAt: "2026-09-29T00:00:00Z",
  errorCode: null,
  ...(overrides.status === "completed" && !("coverage" in overrides) ? { coverage: {
    corpora: ["user"], fileKind: "document", requestedPeriod: null,
    dateBasis: "title_date_then_created_or_modified", contentPeriodVerified: false,
    providerRowsScanned: 525, excludedByDateCount: 0, deduplicatedCount: 0,
    unavailableShortcutCount: 0, providerPagesExhausted: true, shareabilityVerified: true,
  } } : {}),
  ...overrides,
});
const durableBulk = (overrides: Record<string, unknown> = {}) => ({
  shareId: bulkShareId,
  searchJobId,
  status: "review_ready",
  revision: 1,
  reviewDigest: "b".repeat(64),
  fileCount: 499,
  recipientCount: 1,
  recipients: [{ name: "B", email: "b@example.invalid" }],
  excluded: [],
  counts: { total: 499, processed: 0, shared: 0, alreadyShared: 0, skipped: 0, failed: 0, needsReview: 0, unknown: 0, pending: 499 },
  notifications: { settled: 0, pending: 0, unavailable: 0 },
  canApprove: true,
  canStop: false,
  createdAt: "2026-09-28T00:00:00Z",
  updatedAt: "2026-09-28T00:01:00Z",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function poll() {
  await act(async () => state.periodic.mock.lastCall?.[2]());
}
const agentPackage = (overrides: Record<string, unknown> = {}) => ({
  status: "ready", revision: 2, digest: "b".repeat(64), selectedCount: 4,
  evaluatedCount: 8, candidateCount: 12, confidenceScore: 82,
  confidenceBasis: "model_assessment", importanceScore: 175,
  suggestedPriceCents: 1050, priceReason: "Four relevant records with partial coverage.",
  summary: "The package covers January and March.", coverageStatus: "partial",
  gaps: ["February is missing."], canAllow: true, ...overrides,
});
describe("exact-file document review", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    searchStream.status.mockResolvedValue("interrupted");
    priceSheet.props = null;
    state.uid = "a";
    state.token = "owner-a";
    state.unlocked = true;
    state.epoch = 1;
    state.getToken.mockImplementation(() => state.token);
    state.status.mockResolvedValue(initial());
    state.review.mockImplementation(async () => review());
    state.delivery.mockResolvedValue(delivery());
    state.approve.mockResolvedValue({ status: "approved" });
    state.decide.mockResolvedValue({});
    state.revoke.mockResolvedValue({});
    state.prepare.mockResolvedValue({ status: "review_ready" });
    // Default: this route can't stream here, so preparation falls back to POST.
    state.prepareStream.mockRejectedValue(new StreamUnavailable());
    state.startRequestSearch.mockResolvedValue(durableSearch());
    state.requestSearchFiles.mockResolvedValue({ jobId: searchJobId, revision: 4, matched: 500,
      files: [{ position: 1, id: "drive-1", name: "Standup 1", mimeType: "application/vnd.google-apps.document", modifiedTime: null, openUrl: null }], nextCursor: null });
    state.prepareRequestBulk.mockResolvedValue(durableBulk());
    state.prepareRequestBatch.mockResolvedValue(durableBulk());
    state.setLiveBackground.mockResolvedValue(true);
    state.overview.mockResolvedValue({ driveAgentPackagesEnabled: false });
    state.bulkShareFiles.mockResolvedValue({ shareId: bulkShareId,
      files: [{ position: 1, name: "Standup 1", mimeType: "application/vnd.google-apps.document", modifiedTime: null, openUrl: null }], nextCursor: null });
    state.approveBulkShare.mockResolvedValue(durableBulk({ status: "queued", canApprove: false }));
    state.deliveryFiles.mockResolvedValue({ files: [], nextCursor: null });
    // Most requests here have no requester terms to show (owner views, older free ones).
    state.requesterContext.mockRejectedValue(new DriveSharingError("request_unavailable", 404));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it("polls a preparing package, then approves its exact digest with an editable suggested price", async () => {
    state.status.mockResolvedValue(pending(3));
    state.review.mockResolvedValue(partial({ revision: 3, trustedAuto: true, durableAvailable: true,
      agentPackage: agentPackage({ status: "preparing", canAllow: false, digest: null }) }));
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(await screen.findByText("Preparing your file package")).toBeVisible();
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    expect(state.periodic.mock.lastCall?.[3]).toMatchObject({ enabled: true });
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.startRequestSearch).not.toHaveBeenCalled();
    state.review.mockResolvedValue(partial({ revision: 3, paymentRequired: true,
      ownerPriceRequired: true, priceCents: 2000, agentPackage: agentPackage() }));
    await poll();
    expect(await screen.findByText("Incomplete package")).toBeVisible();
    fireEvent.click(screen.getByText("View details"));
    expect(screen.getByText("82/100")).toBeVisible();
    expect(screen.getByText("175/500")).toBeVisible();
    expect(screen.getByText("February is missing.")).toBeVisible();
    expect(screen.getByText("4 files")).toBeVisible();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(state.requestSearchFiles).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit price" }));
    expect(priceSheet.props).toMatchObject({ moneyPolicy: "drive_cents", initialAmountCents: 1050 });
    state.review.mockResolvedValue(partial({ revision: 4, paymentRequired: true, priceCents: 2000,
      agentPackage: agentPackage({ status: "allowed", canAllow: false }) }));
    fireEvent.click(screen.getByRole("button", { name: "Submit $20" }));
    await waitFor(() => expect(state.allow).toHaveBeenCalledWith("owner-a", requestId,
      { revision: 3, amountCents: 2000, packageRevision: 2, packageDigest: "b".repeat(64) }, expect.any(Function)));
    expect(await screen.findByText("The requester pays before this approved package is shared.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(state.approve).not.toHaveBeenCalled();
    expect(state.prepareRequestBulk).not.toHaveBeenCalled();
  });

  it("allows a prepared exact packet at its estimate without requiring a price edit", async () => {
    state.status.mockResolvedValue(pending(3));
    state.review.mockResolvedValue(partial({ revision: 3, paymentRequired: true,
      priceCents: 2000, agentPackage: agentPackage() }));
    state.allow.mockResolvedValue({ requestId, status: "pending", revision: 4 });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(state.allow).toHaveBeenCalledWith("owner-a", requestId,
      { revision: 3, amountCents: 1050, packageRevision: 2, packageDigest: "b".repeat(64) }, expect.any(Function)));
    expect(screen.queryByRole("dialog", { name: "Set a price" })).toBeNull();
  });

  it("keeps exact selected file names under View details while Allow and Deny stay simple", async () => {
    state.status.mockResolvedValue(pending(3));
    state.review.mockResolvedValue(partial({ revision: 3, paymentRequired: true,
      agentPackage: agentPackage({ selectedFileCount: 4, selectedFiles: [
        { position: 1, name: "eStmt-09.pdf", weightageOutOf10: 9.5, confidenceScore: 94 },
        { position: 2, name: "eStmt-10.pdf", weightageOutOf10: 9, confidenceScore: 91 },
        { position: 3, name: "Statement A.pdf", weightageOutOf10: 8, confidenceScore: 87 },
        { position: 4, name: "Statement B.pdf", weightageOutOf10: 7, confidenceScore: 83 },
      ] }) }));
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Allow" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Deny/ })).toBeEnabled();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByText("View details"));
    expect(screen.getByRole("list", { name: "Included files" })).toHaveTextContent("eStmt-09.pdf");
    expect(screen.getByRole("list", { name: "Included files" })).toHaveTextContent("eStmt-10.pdf");
    expect(screen.getByRole("list", { name: "Included files" })).toHaveTextContent("Weightage 9.5/10 · Model assessment 94/100");
  });

  it("shows live V1 verified progress under details without turning Trusted matches into Allow", async () => {
    state.status.mockResolvedValue(pending(3));
    state.review.mockResolvedValue(partial({ revision: 3, v1LiveRequest: true, trustedAuto: true,
      requesterProfile: { type: "ria", displayName: "Chris", legalName: "Chris Advisor",
        firmName: "RIA Firm", crd: "12345" }, reason: "Review the Schwab statements",
      search: durableSearch({ status: "completed", matched: 5,
        evaluation: { status: "running", evaluatedCount: 3, pendingCount: 2, verifiedCount: 1 } }),
      agentPackage: agentPackage({ status: "preparing", digest: null, canAllow: false,
        selectedCount: 0, evaluatedCount: 3, candidateCount: 5,
        provisionalFiles: [{ position: 2, name: "eStmt-09.pdf", weightageOutOf10: 9, confidenceScore: 93 }],
        verifiedCount: 1, pendingCount: 2 }) }));
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(await screen.findByText("Finding files")).toBeVisible();
    expect(screen.queryByText("Preparing your file package")).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Deny/ })).toBeNull();
    expect(screen.getByText("Chris Advisor · Verified RIA")).toBeVisible();
    expect(screen.getByText("eStmt-09.pdf")).not.toBeVisible();
    fireEvent.click(screen.getByText("View details"));
    expect(screen.getByText("eStmt-09.pdf")).toBeVisible();
    expect(screen.getByText("RIA Firm")).toBeVisible();
    expect(screen.getByText("12345")).toBeVisible();
    expect(screen.getByText("Review the Schwab statements")).toBeVisible();
    expect(screen.getByText("Agent match 93/100 · Value 9/10")).toBeVisible();
    expect(screen.getByText("Scores are Agent One assessments, not measured accuracy.")).toBeVisible();
    expect(screen.getByText("3 of 5 candidates checked · 2 remaining")).toBeVisible();
    expect(state.startRequestSearch).not.toHaveBeenCalled();
    await waitFor(() => expect(searchStream.status).toHaveBeenCalledWith(
      "owner-a", searchJobId, expect.any(Function), expect.any(Function), expect.any(AbortSignal)));
    expect(state.requestSearchFiles).not.toHaveBeenCalled();
  });

  it("keeps a prepared Trusted V1 request in its existing payment flow", async () => {
    state.status.mockResolvedValue(pending(3));
    state.review.mockResolvedValue(partial({ revision: 3, v1LiveRequest: true, trustedAuto: true,
      paymentRequired: true, agentPackage: agentPackage({ coverageStatus: "complete", canAllow: true }) }));
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(await screen.findByText("Request prepared")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByText("Package ready for your decision")).toBeNull();
    expect(state.allow).not.toHaveBeenCalled();
  });

  it("does not call unknown coverage a ready package", async () => {
    state.status.mockResolvedValue(pending(3));
    state.review.mockResolvedValue(partial({ revision: 3, agentPackage: agentPackage({ coverageStatus: "unknown", canAllow: false }) }));
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(await screen.findByText("Unable to verify")).toBeVisible();
    expect(screen.getByText("Coverage could not be verified.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    expect(screen.queryByText("Package ready for your decision")).toBeNull();
  });

  it("reuses background Drive setup before polling package preparation", async () => {
    state.status.mockResolvedValue(pending(3));
    state.review.mockResolvedValue(partial({ revision: 3, preparationError: "background_preparation_required",
      agentPackage: agentPackage({ status: "preparing", canAllow: false, digest: null }) }));
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(await screen.findByText("Background Drive access needed")).toBeVisible();
    expect(state.periodic.mock.lastCall?.[3]).toMatchObject({ enabled: false });
    state.review.mockResolvedValue(partial({ revision: 3,
      agentPackage: agentPackage({ status: "preparing", canAllow: false, digest: null }) }));
    fireEvent.click(screen.getByRole("button", { name: "Enable background Drive access" }));
    await waitFor(() => expect(state.setLiveBackground).toHaveBeenCalledWith("owner-a", true));
    expect(await screen.findByText("Preparing your file package")).toBeVisible();
    expect(state.periodic.mock.lastCall?.[3]).toMatchObject({ enabled: true });
    expect(state.allow).not.toHaveBeenCalled();
  });

  it("closes the price decision when a ready package is replaced", async () => {
    state.status.mockResolvedValue(pending(3));
    state.review.mockResolvedValue(partial({ revision: 3, paymentRequired: true, agentPackage: agentPackage() }));
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    const editPrice = await screen.findByRole("button", { name: "Edit price" });
    await waitFor(() => expect(editPrice).toBeEnabled());
    await act(async () => fireEvent.click(editPrice));
    expect(await screen.findByRole("dialog", { name: "Set a price" })).toBeVisible();
    await act(async () => {});
    expect(screen.getByRole("dialog", { name: "Set a price" })).toBeVisible();
    state.review.mockResolvedValue(partial({ revision: 4, paymentRequired: true,
      agentPackage: agentPackage({ revision: 3, digest: "c".repeat(64), summary: "A different package." }) }));
    await poll();
    expect(await screen.findByText("A different package.")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Set a price" })).toBeNull();
    expect(state.allow).not.toHaveBeenCalled();
  });

  it.each(["stale", "unavailable", "no_match"])("blocks Allow for a %s package and keeps Deny available", async (status) => {
    state.status.mockResolvedValue(pending(3));
    state.review.mockResolvedValue(partial({ revision: 3, allowAvailable: true,
      agentPackage: agentPackage({ status, canAllow: false }) }));
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Allow" })).toBeDisabled();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(state.periodic.mock.lastCall?.[3]).toMatchObject({ enabled: false });
    fireEvent.click(screen.getByRole("button", { name: /^Deny/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm.*Deny|Deny.*confirm/i }));
    await waitFor(() => expect(state.decide).toHaveBeenCalledWith("owner-a", requestId, "decline", 3, expect.any(Function)));
    expect(state.allow).not.toHaveBeenCalled();
  });

  it("opens for review only, renders untrusted names as text and requires explicit sharing", async () => {
    const changed = vi.fn();
    render(<DocumentShareReview requestId={requestId} onChanged={changed} />);
    const share = await screen.findByRole("button", { name: "Share files" });
    expect(screen.getByText("b@example.invalid")).toBeVisible();
    expect(screen.getByText("February to June")).toBeVisible();
    expect(screen.getByText("<script>Untrusted.pdf</script>")).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
    expect(state.approve).not.toHaveBeenCalled();
    state.status.mockResolvedValue({ ...initial(), status: "approved" });
    state.delivery.mockResolvedValue({
      status: "approved",
      files: [{ ...delivery().files[0], status: "queued" }],
    });
    fireEvent.click(share);
    fireEvent.click(share);
    await screen.findByText("Waiting to share");
    expect(state.approve).toHaveBeenCalledTimes(1);
    expect(state.approve).toHaveBeenCalledWith(
      "owner-a",
      requestId,
      expect.objectContaining({ revision: 3, files: review().files }),
      expect.any(Function),
      ["document-one"],
    );
    expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveFocus();
  });
  it("reconciles accepted work even if the follow-up GET fails; never retries the POST", async () => {
    const changed = vi.fn();
    render(<DocumentShareReview requestId={requestId} onChanged={changed} />);
    const share = await screen.findByRole("button", { name: "Share files" });
    state.status.mockRejectedValue(new Error("offline"));
    fireEvent.click(share);
    await screen.findByRole("alert");
    expect(changed).toHaveBeenCalledOnce();
    expect(state.approve).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Share files" })).toBeNull();
    const refresh = screen.getByRole("button", { name: "Refresh status" });
    expect(refresh.querySelector("svg")).toHaveClass("size-4");
    fireEvent.click(refresh);
    await waitFor(() => expect(state.status).toHaveBeenCalledTimes(3));
    expect(state.approve).toHaveBeenCalledOnce();
  });
  it("does not chain a private read after the vault epoch changed", async () => {
    let finish!: (value: unknown) => void;
    state.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    state.epoch++;
    await act(async () => finish(initial()));
    expect(state.review).not.toHaveBeenCalled();
    expect(state.delivery).not.toHaveBeenCalled();
    expect(screen.queryByText("b@example.invalid")).toBeNull();
  });
  it("does not chain a read or reconcile after an approval settles for an old session", async () => {
    let finish!: (value: unknown) => void;
    state.approve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const changed = vi.fn();
    render(<DocumentShareReview requestId={requestId} onChanged={changed} />);
    fireEvent.click(await screen.findByRole("button", { name: "Share files" }));
    state.epoch++;
    await act(async () => finish({ status: "approved" }));
    expect(state.status).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
  });
  it("does not load private details while locked and removes them on locking", async () => {
    state.unlocked = false;
    const changed = vi.fn();
    const view = render(
      <DocumentShareReview requestId={requestId} onChanged={changed} />,
    );
    expect(state.status).not.toHaveBeenCalled();
    state.unlocked = true;
    view.rerender(
      <DocumentShareReview requestId={requestId} onChanged={changed} />,
    );
    await screen.findByText("b@example.invalid");
    state.unlocked = false;
    view.rerender(
      <DocumentShareReview requestId={requestId} onChanged={changed} />,
    );
    expect(screen.queryByText("b@example.invalid")).toBeNull();
  });
  it("opens B's originals as the Google account that received Viewer access", async () => {
    // A browser signed into several Google accounts otherwise opens the link
    // as its default account (on UAT, A's), which has no access. The account is
    // the one sealed in the request, never this session's providerData (native
    // builds synthesize it from the sign-in email).
    state.providers = [{ providerId: "google.com", email: "session@gmail.test" }];
    state.requesterContext.mockResolvedValue(requesterTerms({ recipientEmail: "b@gmail.test" }));
    state.status.mockResolvedValue({
      ...initial(),
      direction: "outgoing",
      status: "completed",
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(
      await screen.findByRole("link", { name: "Open in Google Drive" }),
    ).toHaveAttribute(
      "href",
      "https://drive.google.com/file/d/approved/view?authuser=b%40gmail.test",
    );
    expect(state.review).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Share files" })).toBeNull();
    expect(
      screen.getByText("Shared with b@gmail.test. Open while signed in to that Google account."),
    ).toBeVisible();
    expect(screen.queryByText(/session@gmail\.test/)).toBeNull();
    expect(screen.queryByText(/connect your own Drive/)).toBeNull();
    state.providers = [];
  });

  it("keeps the plain link when the request names no Google account, whatever this session has", async () => {
    state.providers = [{ providerId: "google.com", email: "session@gmail.test" }];
    state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "completed" });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(
      await screen.findByRole("link", { name: "Open in Google Drive" }),
    ).toHaveAttribute("href", "https://drive.google.com/file/d/approved/view");
    expect(
      screen.getByText("Open while signed in to your linked Google account."),
    ).toBeVisible();
    state.providers = [];
  });

  it("shows the requester their own terms and the owner's price beside the estimate, never a locked quote", async () => {
    state.requesterContext.mockResolvedValue(requesterTerms());
    state.status.mockResolvedValue({
      ...pending(),
      direction: "outgoing",
      paymentRequired: true,
      quotedAmountCents: 2500,
      quoteVersion: 1,
      price: { estimateCents: 1000, currentCents: 2500, finalCents: null, state: "owner_set" },
      payment: {
        state: "preparing", amountCents: 2500, currency: "usd", checkoutExpiresAt: null,
        requestExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), refund: null,
        nextAction: "wait_owner", withdrawn: false,
      },
    });
    state.delivery.mockResolvedValue({ status: "pending", files: [] });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    const terms = await screen.findByRole("group", { name: "Your request" });
    expect(within(terms).getByText("“Six months of statements”")).toBeVisible();
    expect(within(terms).getByText("2026-01-01 – 2026-06-30")).toBeVisible();
    expect(within(terms).getByText("Requested")).toBeVisible();
    expect(within(terms).getByText("b@gmail.test")).toBeVisible();
    expect(within(terms).getByText("Price").nextSibling).toHaveTextContent("$25");
    expect(within(terms).getByText("Estimate").nextSibling).toHaveTextContent("$10");
    expect(screen.getByTestId("requester-payment-section")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/lock/i);
    // A paid request withdraws in its payment section, not with the free Cancel row.
    expect(screen.queryByRole("button", { name: "Cancel request" })).toBeNull();
  });

  it("offers Request review only while the owner can still retry, then says it was asked", async () => {
    const recovery = (state: string, requestedAt: string | null) => ({
      undeliveredCount: 1,
      reasons: [{ reasonCode: "provider_unavailable", count: 1 }],
      ownerRetry: { state, retryableCount: state === "available" || state === "requested" ? 1 : 0, requestedAt },
      refund: { state: "none", amountCents: null, grossCents: null, expectedFiles: null, confirmedFiles: null },
    });
    const partialDelivery = (state: string, requestedAt: string | null = null) => ({
      status: "partial", files: [], bulkShareId, fileCount: 2, sharedCount: 1,
      counts: { total: 2, processed: 2, shared: 1, alreadyShared: 0, skipped: 1, failed: 0,
        needsReview: 0, unknown: 0, pending: 0 },
      issues: [{ reasonCode: "provider_unavailable", count: 1 }],
      recovery: recovery(state, requestedAt),
    });
    state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "partial" });
    state.delivery.mockResolvedValue(partialDelivery("available"));
    state.reviewRequest.mockResolvedValue({ requestId, reviewRequestedAt: "2026-10-11T08:00:00Z",
      ownerRetry: { state: "requested", retryableCount: 1 }, refund: { state: "none", amountCents: null } });
    const changed = vi.fn();
    render(<DocumentShareReview requestId={requestId} onChanged={changed} />);
    expect(await screen.findByText("1 file not shared")).toBeVisible();
    // The issue line never promises a retry that may already be closed.
    expect(screen.getByText(/Google Drive could not finish sharing these files\./)).toBeVisible();
    expect(screen.queryByText(/can retry/i)).toBeNull();
    state.delivery.mockResolvedValue(partialDelivery("requested", "2026-10-11T08:00:00Z"));
    fireEvent.click(screen.getByRole("button", { name: "Request review" }));
    await waitFor(() =>
      expect(state.reviewRequest).toHaveBeenCalledWith("owner-a", requestId, expect.any(Function)),
    );
    expect(await screen.findByText("Review requested")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Request review" })).toBeNull();
    expect(changed).toHaveBeenCalled();
  });

  it.each([
    ["succeeded", "1 file not shared · $5 refunded", null],
    ["pending", "1 file not shared", "Refund of $5 pending"],
  ])("shows the requester's %s refund instead of a review once nothing can be retried", async (refundState, title, line) => {
    state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "partial" });
    state.delivery.mockResolvedValue({
      status: "partial", files: [], bulkShareId, fileCount: 2, sharedCount: 1,
      recovery: {
        undeliveredCount: 1, reasons: [{ reasonCode: "provider_unavailable", count: 1 }],
        ownerRetry: { state: "unavailable", retryableCount: 0, requestedAt: null },
        refund: { state: refundState, amountCents: 500, grossCents: 1000, expectedFiles: 2, confirmedFiles: 1 },
      },
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(await screen.findByText(title)).toBeVisible();
    if (line) expect(screen.getByText(line)).toBeVisible();
    // Money that has not moved yet is never called refunded.
    if (refundState === "pending") expect(screen.queryByText(/refunded/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Request review" })).toBeNull();
  });

  it.each([
    [true, "They asked you to retry the files that weren't shared."],
    [false, "Nothing to retry; the requester was refunded $5 for 1 file."],
  ])("shows the owner a review ask beside the existing retry (retry available: %s)", async (canRetry, line) => {
    state.status.mockResolvedValue({ ...initial(), status: "partial" });
    state.delivery.mockResolvedValue({
      status: "partial", files: [], bulkShareId, fileCount: 2, sharedCount: 1,
      reviewRequest: {
        requestedAt: "2026-10-11T08:00:00Z", count: 1, unsharedCount: 1,
        refund: canRetry ? { state: "none", amountCents: null } : { state: "succeeded", amountCents: 500 },
      },
    });
    state.review.mockResolvedValue(partial({
      status: "partial", durableAvailable: true, trustedAuto: true,
      search: durableSearch({ status: "completed", matched: 2 }),
      bulkShare: durableBulk({ status: "partial", fileCount: 2, canApprove: false,
        canRetry, retryableCount: canRetry ? 1 : 0,
        counts: { total: 2, processed: 2, shared: 1, alreadyShared: 0, skipped: 1, failed: 0,
          needsReview: 0, unknown: 0, pending: 0 } }),
    }));
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    const note = await screen.findByRole("note", { name: "Review request" });
    expect(within(note).getByText("Review requested")).toBeVisible();
    expect(within(note).getByText(line)).toBeVisible();
    expect(screen.queryAllByRole("button", { name: "Retry 1 file" })).toHaveLength(canRetry ? 1 : 0);
    // The automatic owner view names the requested period too.
    expect(screen.getByText("2026-01-01 – 2026-06-30")).toBeVisible();
  });
  it("prepares removal only on click, requires a second decision and polls its recorded outcome", async () => {
    state.status.mockResolvedValue({ ...initial(), status: "completed" });
    state.prepareRevocation.mockResolvedValue({
      revision: 4,
      directiveId: "d",
      reviewDigest: "b".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      files: [
        {
          grantId: "grant",
          name: "Approved.pdf",
          recipientEmail: "b@example.invalid",
        },
      ],
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    const prepare = await screen.findByRole("button", {
      name: "Review removal",
    });
    expect(state.prepareRevocation).not.toHaveBeenCalled();
    fireEvent.click(prepare);
    const remove = await screen.findByRole("button", { name: "Stop access" });
    expect(state.revoke).not.toHaveBeenCalled();
    state.delivery.mockResolvedValue({
      ...delivery(),
      files: [{ ...delivery().files[0], revocationStatus: "queued" }],
    });
    fireEvent.click(remove);
    await screen.findByText("Removal: pending");
    expect(state.revoke).toHaveBeenCalledOnce();
    expect(state.periodic.mock.lastCall?.[3]).toEqual({ enabled: true });
  });
  it("keeps the request on screen through a transient preparation failure and recovers by polling", async () => {
    state.status.mockResolvedValue(pending());
    state.review.mockResolvedValue(partial());
    state.prepare.mockRejectedValueOnce(new Error("temporary"));
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    await screen.findByText("b@example.invalid");
    await waitFor(() => expect(state.prepare).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Finding files…");
    state.status.mockResolvedValue(initial());
    state.review.mockImplementation(async () => review());
    await poll();
    await screen.findByText("<script>Untrusted.pdf</script>");
    // A transport failure is re-read, never re-posted by the poll.
    expect(state.prepare).toHaveBeenCalledTimes(1);
  });

  it("requires explicit broad trust and sends its scope with approval", async () => {
    state.review.mockResolvedValue({ ...review(), canTrustFutureRequests: true });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    const trust = await screen.findByRole("checkbox", { name: /^Trust b@example\.invalid/ });
    expect(trust).not.toBeChecked();
    fireEvent.click(trust);
    fireEvent.click(screen.getByRole("button", { name: "Share files" }));
    await waitFor(() => expect(state.approve).toHaveBeenCalledWith(
      "owner-a", requestId, expect.anything(), expect.any(Function), ["document-one"], true, "any_requested_drive_file"));
  });

  it("shares only the files A keeps selected, and never an empty selection", async () => {
    const files = [
      { documentId: "document-one", name: "March statement.pdf" },
      { documentId: "document-two", name: "Meeting notes" },
    ];
    state.review.mockResolvedValue({ ...review(), files, canTrustFutureRequests: true });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    const notes = await screen.findByRole("checkbox", { name: "Meeting notes" });
    const all = screen.getByRole("checkbox", { name: "Select all" });
    expect(notes).toBeChecked();
    expect(all).toBeChecked();
    fireEvent.click(all);
    expect(notes).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Share 0 of 2 files" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "March statement.pdf" }));
    // Trust for future requests follows a review accepted in full.
    expect(screen.getByRole("checkbox", { name: /^Trust b@example\.invalid/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Share 1 of 2 files" }));
    await waitFor(() => expect(state.approve).toHaveBeenCalledWith(
      "owner-a", requestId, expect.anything(), expect.any(Function), ["document-one"]));
  });

  it("tells A plainly when no file looks like what was asked for", async () => {
    state.review.mockResolvedValue({
      ...review(),
      files: [],
      coverage: null,
      canApprove: false,
      preparationError: "no_relevant_files",
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(
      await screen.findByText("This search found no file candidates."),
    ).toBeVisible();
    expect(screen.getByText("Try a broader request or add files to Drive.")).toBeVisible();
    expect(screen.queryByText("Suggestions are not ready yet.")).toBeNull();
    expect(screen.queryByText("Refresh suggestions before sharing.")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Refresh suggestions" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Decline" })).toBeVisible();
  });

  it("does not claim a completed empty search proves no relevant files exist", async () => {
    state.status.mockResolvedValue({ ...initial(), status: "no_match" });
    state.delivery.mockResolvedValue({ status: "no_match", files: [], sharedCount: 0 });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("No file candidates in this search");
    expect(screen.queryByText("Sharing incomplete")).toBeNull();
    expect(state.review).not.toHaveBeenCalled();
  });

  it("shows the no-match outcome after a manual progressive search", async () => {
    state.status.mockResolvedValue({ ...pending(), status: "no_match" });
    state.review.mockResolvedValue(partial({
      status: "no_match", durableAvailable: true, progressiveAllowed: true,
      search: durableSearch({ status: "completed", matched: 0 }),
    }));
    state.delivery.mockResolvedValue({ status: "no_match", files: [], sharedCount: 0 });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("No file candidates in this search");
    expect(screen.getByRole("status")).not.toHaveTextContent("0 file candidates");
  });

  it("tells the requester who must allow, then what to pay, never a delay", async () => {
    state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "pending",
      awaitingOwnerAllow: true });
    state.delivery.mockResolvedValue({ status: "pending", files: [], sharedCount: 0 });
    const view = render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()}
      counterpartLabel="Ankit" />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Waiting for Ankit to allow"));
    expect(screen.getByRole("status")).not.toHaveTextContent(/longer than usual/i);
    view.unmount();

    const payable = { state: "payable", amountCents: 50, currency: "usd",
      checkoutExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), requestExpiresAt: null,
      refund: null, nextAction: "pay" };
    state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "pending",
      autoshare: true, payment: payable });
    const paying = render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} counterpartLabel="Document request" />);
    await waitFor(() => expect(screen.getAllByRole("status")[0]).toHaveTextContent("Pay $0.50 to get the files"));
    paying.unmount();

    // The checkout window passed on this device: never "Pay" or "Finding files".
    state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "pending",
      autoshare: true, payment: { ...payable,
        checkoutExpiresAt: new Date(Date.now() - 60_000).toISOString() } });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} counterpartLabel="Document request" />);
    await waitFor(() => expect(screen.getAllByRole("status")[0]).toHaveTextContent("Payment link expired"));
    expect(screen.getAllByRole("status")[0]).not.toHaveTextContent(/Pay \$|Finding files/);
  });

  it("tells the requester only that no files matched", async () => {
    state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "no_files_shared" });
    state.delivery.mockResolvedValue({ status: "no_files_shared", files: [], sharedCount: 0 });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("No matching files");
    expect(screen.queryByText("No file candidates in this search")).toBeNull();
  });

  it("tells A when matching files couldn't be read", async () => {
    state.review.mockResolvedValue({
      ...review(),
      files: [],
      coverage: null,
      canApprove: false,
      preparationError: "no_ready_files",
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(
      await screen.findByText(
        "Matching files couldn't be read, for example password-protected or scanned PDFs.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Suggestions are not ready yet.")).toBeNull();
  });

  it("still says suggestions are not ready for any other result", async () => {
    state.review.mockResolvedValue({
      ...review(),
      files: [],
      coverage: null,
      canApprove: false,
      preparationError: null,
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(
      await screen.findByText("Suggestions are not ready yet."),
    ).toBeVisible();
    // With nothing to share, the hint about sharing is noise.
    expect(screen.queryByText("Refresh suggestions before sharing.")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh suggestions" })).toBeEnabled();
  });


  describe("progressive preparation", () => {
    function streaming() {
      const result = deferred<string>();
      const seen: {
        onStage?: (stage: string) => void;
        signal?: AbortSignal;
      } = {};
      state.prepareStream.mockImplementation(
        (_token: string, _id: string, _guard: () => void, options: {
          onStage: (stage: string) => void;
          signal: AbortSignal;
        }) => {
          seen.onStage = options.onStage;
          seen.signal = options.signal;
          return result.promise;
        },
      );
      return { result, seen };
    }

    it("shows who asked and why before files are found, with one status line", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial());
      const { result, seen } = streaming();
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await screen.findByText("b@example.invalid");
      expect(screen.getByText("“Statements”")).toBeVisible();
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(screen.getByRole("status")).toHaveTextContent("Finding files…");
      expect(screen.getByRole("button", { name: "Share files" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
      expect(screen.queryByText("Suggestions are not ready yet.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Refresh suggestions" })).toBeNull();
      // Screen readers still hear stage changes: nothing above the status is busy.
      expect(
        screen.getByTestId("document-share-review").getAttribute("aria-busy"),
      ).toBeNull();
      await act(async () => seen.onStage?.("searching"));
      expect(screen.getByRole("status")).toHaveTextContent("Searching Drive…");
      await act(async () => seen.onStage?.("checking"));
      expect(screen.getByRole("status")).toHaveTextContent("Checking coverage…");
      state.status.mockResolvedValue(initial());
      state.review.mockImplementation(async () => review());
      await act(async () => result.resolve("review_ready"));
      expect(
        await screen.findByRole("button", { name: "Share files" }),
      ).toBeEnabled();
      expect(state.prepareStream).toHaveBeenCalledTimes(1);
      expect(state.prepare).not.toHaveBeenCalled();
      expect(state.status).toHaveBeenCalledTimes(2);
      expect(state.review).toHaveBeenCalledTimes(2);
    });

    it("says a long search can take a minute", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial());
      streaming();
      const view = render(
        <DocumentShareReview requestId={requestId} onChanged={vi.fn()} />,
      );
      await screen.findByText("b@example.invalid");
      expect(screen.queryByText("This can take a minute.")).toBeNull();
      const start = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(start + 16_000);
      view.rerender(
        <DocumentShareReview requestId={requestId} onChanged={vi.fn()} />,
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        "This can take a minute.",
      );
    });

    it("polls quietly while a worker holds the search", async () => {
      state.status.mockResolvedValue({ ...pending(), status: "preparing" });
      state.review.mockResolvedValue(partial({ status: "preparing" }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await screen.findByText("b@example.invalid");
      const line = screen.getByRole("status").textContent;
      const read = deferred<unknown>();
      state.status.mockReturnValueOnce(read.promise);
      const tick = act(async () => {
        await state.periodic.mock.lastCall?.[2]();
      });
      await waitFor(() => expect(state.status).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("status").textContent).toBe(line);
      expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
      expect(screen.queryByRole("alert")).toBeNull();
      read.resolve({ ...pending(), status: "preparing" });
      await tick;
      // Someone else is searching: this sheet never starts a second search.
      expect(state.prepareStream).not.toHaveBeenCalled();
      expect(state.prepare).not.toHaveBeenCalled();
    });

    it.each([
      ["a shareable review", review],
      ["request details only", () => partial({ status: "preparing" })],
    ])("clears %s when a poll fails", async (_label, shown) => {
      state.status.mockResolvedValue({ ...pending(), status: "preparing" });
      state.review.mockImplementation(async () => shown());
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await screen.findByText("b@example.invalid");
      state.status.mockRejectedValueOnce(new Error("offline"));
      await poll();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Refresh to try again.",
      );
      expect(screen.queryByText("b@example.invalid")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Share/ })).toBeNull();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Couldn't load request",
      );
    });

    it("keeps checking a long search without requiring the owner to wait in the sheet", async () => {
      state.status.mockResolvedValue({ ...pending(), status: "preparing" });
      state.review.mockResolvedValue(partial({ status: "preparing" }));
      const view = render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await screen.findByText("b@example.invalid");
      expect(state.periodic.mock.lastCall?.[3]).toEqual({ enabled: true });
      const started = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(started + 121_000);
      view.rerender(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      for (let tick = 0; tick < 25; tick += 1) await poll();
      expect(screen.getByRole("status")).toHaveTextContent("Still finding files");
      expect(screen.getByRole("status")).toHaveTextContent(
        "You can come back later.",
      );
      expect(state.status).toHaveBeenCalledTimes(26);
      expect(state.periodic.mock.lastCall?.[3]).toEqual({ enabled: true });
      expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
    });

    it("lets Decline interrupt a search; the late result changes nothing", async () => {
      state.status.mockResolvedValue(pending(1));
      state.review.mockResolvedValue(partial({ revision: 1 }));
      const { result, seen } = streaming();
      const changed = vi.fn();
      render(<DocumentShareReview requestId={requestId} onChanged={changed} />);
      fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
      state.status.mockResolvedValue({ ...pending(1), status: "declined" });
      state.delivery.mockResolvedValue({ status: "declined", files: [] });
      await waitFor(() =>
        expect(state.decide).toHaveBeenCalledWith(
          "owner-a",
          requestId,
          "decline",
          1,
          expect.any(Function),
        ),
      );
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("Request declined"),
      );
      expect(changed).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("status")).toHaveFocus();
      expect(seen.signal?.aborted).toBe(true);
      const reviews = state.review.mock.calls.length;
      await act(async () => result.resolve("review_ready"));
      expect(state.review).toHaveBeenCalledTimes(reviews);
      expect(screen.getByRole("status")).toHaveTextContent("Request declined");
    });

    it.each([
      ["review_changed", "This review changed. Refresh and review it again."],
      // Paid or shared meanwhile: the server's paid guard refuses the decline.
      ["request_paid", "Payment or sharing already started. Refresh to see it."],
    ])("never shows a lost Decline as declined (%s)", async (code, copy) => {
      state.status.mockResolvedValue(pending(1));
      state.review.mockResolvedValue(partial({ revision: 1 }));
      streaming();
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      state.decide.mockRejectedValueOnce(new DriveSharingError(code));
      fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(copy);
      expect(screen.queryByText("Request declined")).toBeNull();
      expect(screen.queryByText("b@example.invalid")).toBeNull();
    });

    it.each([
      [new DriveSharingError("reconnect_required"), "Reconnect Drive in Connections, then retry."],
      [new DriveSharingError("request_unavailable"), "This document request is no longer available."],
      [new DriveSharingError("request_expired"), "This document request expired."],
      [new DriveSharingError("owner_share_expired"), "This document search expired. Start a new request."],
      [new DriveSharingError("request_failed", 401), "Refresh to try again."],
    ])("treats a refused search as a real error", async (cause, copy) => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial());
      state.prepareStream.mockRejectedValue(cause);
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("alert")).toHaveTextContent(copy);
      expect(screen.queryByText("b@example.invalid")).toBeNull();
      expect(state.prepare).not.toHaveBeenCalled();
    });

    it("offers a new search when the last one couldn't finish", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(
        partial({ preparationError: "preparation_unavailable" }),
      );
      state.prepareStream.mockResolvedValue("not_claimed");
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("Search didn't finish"),
      );
      expect(screen.getByText("Couldn't prepare suggestions.")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Refresh suggestions" }),
      ).toBeEnabled();
      expect(state.periodic.mock.lastCall?.[3]).toEqual({ enabled: false });
      expect(state.prepare).not.toHaveBeenCalled();
    });

    it("falls back to exactly one POST when this route can't stream", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial());
      state.prepare.mockImplementation(async () => {
        state.status.mockResolvedValue(initial());
        state.review.mockImplementation(async () => review());
        return { status: "review_ready" };
      });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await screen.findByText("<script>Untrusted.pdf</script>");
      expect(state.prepareStream).toHaveBeenCalledTimes(1);
      expect(state.prepare).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["preparing", 0],
      ["pending", 1],
    ])(
      "after an interrupted stream with status %s, posts %i time(s)",
      async (after, posts) => {
        state.status
          .mockResolvedValueOnce(pending())
          .mockResolvedValue({ ...pending(), status: after });
        state.review.mockResolvedValue(partial());
        state.prepareStream.mockResolvedValue("interrupted");
        render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
        await screen.findByText("b@example.invalid");
        await waitFor(() =>
          expect(state.review.mock.calls.length).toBeGreaterThanOrEqual(2),
        );
        expect(state.prepare).toHaveBeenCalledTimes(posts);
      },
    );

    it("keeps the search layout while a Decline is being sent", async () => {
      state.status.mockResolvedValue(pending(1));
      state.review.mockResolvedValue(partial({ revision: 1 }));
      streaming();
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      state.decide.mockReturnValueOnce(new Promise(() => undefined));
      fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("Declining…"),
      );
      expect(screen.queryByText("Suggestions are not ready yet.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Refresh suggestions" })).toBeNull();
      expect(screen.getByRole("button", { name: "Share files" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Decline" })).toBeDisabled();
    });

    it("lets Refresh status take over from a quiet poll", async () => {
      state.status.mockResolvedValue({ ...pending(), direction: "outgoing" });
      state.delivery.mockResolvedValue({ status: "pending", files: [] });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      const refresh = await screen.findByRole("button", { name: "Refresh status" });
      const read = deferred<unknown>();
      state.status.mockReturnValueOnce(read.promise);
      const tick = act(async () => {
        await state.periodic.mock.lastCall?.[2]();
      });
      await waitFor(() => expect(state.status).toHaveBeenCalledTimes(2));
      fireEvent.click(refresh);
      await waitFor(() => expect(state.status).toHaveBeenCalledTimes(3));
      read.resolve({ ...pending(), direction: "outgoing" });
      await tick;
    });

    it("tells the requester a queued request is waiting, not being prepared", async () => {
      // The server sends autoshare with the queue for every Trusted or allowed request.
      state.status.mockResolvedValue({ ...pending(), direction: "outgoing", autoshare: true,
        queuedAt: new Date(Date.now() - 5 * 60_000).toISOString(), queueDelayed: true });
      state.delivery.mockResolvedValue({ status: "pending", files: [] });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Taking longer than usual · 5 min"));
      expect(screen.getByText("Your request is saved and continues automatically.")).toBeVisible();
      expect(screen.getByRole("status").querySelector("svg")).toBeNull();
      expect(screen.getByRole("status")).not.toHaveTextContent(/paused|preparing|finding files/i);
    });

    it("tells the requester a fresh queued request is waiting to start", async () => {
      state.status.mockResolvedValue({ ...pending(), direction: "outgoing", autoshare: true,
        queuedAt: new Date().toISOString(), queueDelayed: false });
      state.delivery.mockResolvedValue({ status: "pending", files: [] });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Waiting to start"));
      expect(screen.getByRole("status")).not.toHaveTextContent(/finding files/i);
    });

    it("never says files are sending once sharing stalled", async () => {
      state.status.mockResolvedValue({ ...pending(), direction: "outgoing", autoshare: true,
        workDelayedSince: new Date(Date.now() - 12 * 60_000 - 5_000).toISOString() });
      state.delivery.mockResolvedValue({ status: "pending", files: [], sharedCount: 5, bulkStatus: "running" });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("status"))
        .toHaveTextContent("Taking longer than usual · 12 min · 5 sent so far"));
      expect(screen.getByRole("status")).not.toHaveTextContent(/Sending files|Finding files/);
    });

    it("keeps an outgoing request readable when recipient verification is unavailable", async () => {
      state.status.mockResolvedValue({ ...pending(), direction: "outgoing" });
      state.delivery.mockRejectedValue(
        new DriveSharingError("recipient_verification_unavailable", 409),
      );
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Request pending"));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("Couldn't load request")).toBeNull();
    });

    it("never calls an approved request's empty delivery final for the requester", async () => {
      state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "approved" });
      state.delivery.mockResolvedValue({ status: "approved", files: [] });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("Sharing pending"),
      );
      expect(screen.queryByText("Nothing was shared.")).toBeNull();
      expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
    });

    it("settles instead of spinning when the owner token is unavailable", async () => {
      state.getToken.mockReturnValue(null);
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Unlock your vault to review.",
      );
      expect(screen.getByRole("status")).toHaveTextContent("Couldn't load request");
      expect(state.status).not.toHaveBeenCalled();
    });

    it("aborts the stream when the sheet closes, and reports nothing after", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial());
      const { seen } = streaming();
      const view = render(
        <DocumentShareReview requestId={requestId} onChanged={vi.fn()} />,
      );
      await screen.findByText("b@example.invalid");
      await waitFor(() => expect(seen.signal).toBeDefined());
      view.unmount();
      expect(seen.signal?.aborted).toBe(true);
      expect(() => seen.onStage?.("checking")).not.toThrow();
    });
  });

  describe("owner decision on a request from outside the Trusted circle", () => {
    const decision = (overrides: Record<string, unknown> = {}) => partial({ durableAvailable: true,
      search: null, bulkShare: null, allowAvailable: true, paymentRequired: true,
      ownerAllowed: false, priceCents: null, ...overrides });

    it("shows a queued request as waiting, then taking longer than usual, never as working", async () => {
      const queuedAt = new Date(Date.now() - 30_000).toISOString();
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(decision({ trustedAuto: true, allowAvailable: false,
        ownerAllowed: true, priceCents: 100, queuedAt, queueDelayed: false }));
      const view = render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Waiting to start"));
      expect(screen.getByRole("status").querySelector("svg")).toBeNull();
      expect(screen.getByText("Request allowed. The Drive search starts soon.")).toBeVisible();
      view.unmount();

      state.review.mockResolvedValue(decision({ trustedAuto: true, allowAvailable: false,
        ownerAllowed: true, priceCents: 100, queueDelayed: true,
        queuedAt: new Date(Date.now() - 12 * 60_000 - 5_000).toISOString() }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Taking longer than usual · 12 min"));
      expect(screen.getByRole("status").querySelector("svg")).toBeNull();
      expect(screen.getByText("This request is saved and continues automatically.")).toBeVisible();
      expect(screen.getByRole("status")).not.toHaveTextContent(/paused|preparing/i);
      expect(state.startRequestSearch).not.toHaveBeenCalled();
    });

    it("offers only whole-dollar prices for a whole-dollar request even when packages are on", async () => {
      // 2026-10-17: a cents price on this request got a 422 from Allow.
      state.overview.mockResolvedValue({ driveAgentPackagesEnabled: true });
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(decision({ wholeDollarPrice: true }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
      await screen.findByRole("dialog", { name: "Set a price" });
      await waitFor(() => expect(priceSheet.props?.moneyPolicy).toBe("legacy_whole_dollars"));
    });

    it("prices a new request in cents from $0.50, whatever the package flag says", async () => {
      state.overview.mockResolvedValue({ driveAgentPackagesEnabled: false });
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(decision({ autoshare: true }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
      await screen.findByRole("dialog", { name: "Set a price" });
      expect(priceSheet.props?.moneyPolicy).toBe("drive_cents");
    });

    it("allows at the requester's estimate in one tap, with Edit price beside it", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(decision({ autoshare: true, estimateCents: 50,
        periodConflict: "request_mentions_longer_span",
        purpose: { purpose: "last 3 months meeting notes", periodStart: "2026-09-02", periodEnd: "2026-10-02" } }));
      state.allow.mockResolvedValue({ requestId, status: "pending", revision: 0 });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      const allow = await screen.findByRole("button", { name: "Allow" });
      // Allow is never held behind a search, and the owner never picks files.
      expect(allow).toBeEnabled();
      // Only files the owner's account can share are ever sent.
      expect(screen.getByText("Allow and Agent One sends every matching file you can share once they pay.")).toBeVisible();
      expect(screen.getByText("The note says 3 months. We used the picked dates: 2 Sep – 2 Oct.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Edit price" })).toBeEnabled();
      expect(screen.queryByRole("checkbox")).toBeNull();
      // The price sits with the terms, with what the owner gets after fees.
      const price = screen.getByText("Price").closest("dl");
      expect(price).toBe(screen.getByText("Share with").closest("dl"));
      expect(screen.getByText("You get this minus a 3% fee and Stripe's fee.")).toBeVisible();
      fireEvent.click(allow);
      await waitFor(() => expect(state.allow).toHaveBeenCalledExactlyOnceWith(
        "owner-a", requestId, { revision: 0, amountCents: 50 }, expect.any(Function)));
      expect(screen.queryByRole("dialog", { name: "Set a price" })).toBeNull();
    });

    it("keeps the price step for a request sealed before the autoshare flow", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(decision({ estimateCents: 100 }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
      await screen.findByRole("dialog", { name: "Set a price" });
      expect(state.allow).not.toHaveBeenCalled();
      expect(screen.queryByText("Price")).toBeNull();
    });

    it("gives the owner's price sheet the estimate the requester saw, parsed from the real /review reply", async () => {
      const actual = await vi.importActual<typeof import("@/lib/services/drive-sharing-service")>(
        "@/lib/services/drive-sharing-service");
      const { ApiService } = await import("@/lib/services/api-service");
      const fetchReview = vi.spyOn(ApiService, "apiFetch").mockImplementation(async () =>
        new Response(JSON.stringify({ ...decision({ estimateCents: 1000 }), requestId })));
      try {
        state.status.mockResolvedValue(pending());
        state.review.mockImplementation((token: string, id: string, guard: () => void) =>
          actual.DriveSharingService.review(token, id, guard));
        render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
        // Allow takes the estimate in one tap; Edit price opens the sheet.
        fireEvent.click(await screen.findByRole("button", { name: "Edit price" }));
        await screen.findByRole("dialog", { name: "Set a price" });
        expect(fetchReview).toHaveBeenCalledWith(
          `/api/connectors/google_drive/sharing/requests/${requestId}/review`, expect.anything());
        expect(priceSheet.props?.estimateCents).toBe(1000);
      } finally {
        fetchReview.mockRestore();
      }
    });

    it("blocks preparation for bank setup and resumes the price decision on a state event", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(decision({
        ownerPayoutAccountReady: false, ownerPriceRequired: true,
        preparationError: "owner_payout_required",
      }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("link", { name: "Link payouts" })).toHaveAttribute(
        "href", expect.stringContaining("/one/profile/payouts?from=%2Fone%2Fconsent%3Ftab%3Dpending"),
      );
      expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
      expect(state.prepare).not.toHaveBeenCalled();
      state.review.mockResolvedValue(decision({ ownerPayoutAccountReady: true, ownerPriceRequired: true }));
      await act(async () => window.dispatchEvent(new CustomEvent("consent-state-changed", { detail: { requestId } })));
      expect(await screen.findByRole("button", { name: "Allow" })).toBeVisible();
      expect(screen.queryByRole("link", { name: "Link payouts" })).toBeNull();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
    });

    it.each([
      ["a request it would otherwise search for", () => partial({ ownerDriveReady: false })],
      ["the owner's decision", () => decision({ ownerDriveReady: false, ownerPayoutAccountReady: false })],
    ])("asks for Google Drive before %s, never saying it is finding files", async (_, drive) => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(drive());
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("link", { name: "Connect Google Drive" })).toHaveAttribute(
        "href", "/one?profile_pane=1&profile_panel=connectors&profile_detail=connector%3Agoogle_drive",
      );
      expect(screen.queryByText(/Finding files/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
      expect(screen.queryByRole("link", { name: "Link payouts" })).toBeNull();
      expect(state.prepare).not.toHaveBeenCalled();
      expect(state.prepareStream).not.toHaveBeenCalled();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
    });

    it("shows Set price for a paused trusted request without starting a search", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(decision({
        trustedAuto: true, allowAvailable: false, ownerPayoutAccountReady: true,
        ownerPriceRequired: true, preparationError: "owner_price_required",
      }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("link", { name: "Set price" })).toHaveAttribute(
        "href", expect.stringContaining("/one/profile/request-pricing?from=%2Fone%2Fconsent%3Ftab%3Dpending"),
      );
      expect(screen.queryByText("Waiting to start")).toBeNull();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
      expect(state.prepareStream).not.toHaveBeenCalled();
    });

    it.each([null, 1200])("prices a trusted request with draft %s without granting new consent", async (draftPrice) => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(decision({
        trustedAuto: true, allowAvailable: false, priceOnlyAvailable: true,
        ownerPayoutAccountReady: true, ownerPriceRequired: draftPrice === null,
        priceCents: draftPrice, preparationError: draftPrice === null ? "owner_price_required" : null,
      }));
      state.setRequestPrice.mockImplementation(async () => {
        state.review.mockResolvedValue(decision({ trustedAuto: true, allowAvailable: false,
          priceOnlyAvailable: false, ownerPayoutAccountReady: true, ownerPriceRequired: false,
          priceCents: 2000 }));
        return { requestId, revision: 1, status: "pending" };
      });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Set price" }));
      expect(priceSheet.props?.priceOnly).toBe(true);
      expect(priceSheet.props?.initialAmountCents).toBe(draftPrice);
      expect(screen.queryByText("Waiting to start")).toBeNull();
      expect(screen.queryByRole("button", { name: /Deny/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Submit $20" }));
      await waitFor(() => expect(state.setRequestPrice).toHaveBeenCalledExactlyOnceWith(
        "owner-a", requestId, { revision: 0, amountCents: 2000 }, expect.any(Function),
      ));
      expect(state.allow).not.toHaveBeenCalled();
    });

    it("searches nothing before Allow, then runs the automatic flow at the owner's price", async () => {
      let allowed = false;
      state.status.mockResolvedValue(pending());
      state.review.mockImplementation(async () => allowed
        ? decision({ trustedAuto: true, allowAvailable: false, ownerAllowed: true, priceCents: 2000 })
        : decision());
      state.allow.mockRejectedValueOnce(new DriveSharingError("invalid_payment_amount", 422))
        .mockImplementationOnce(async () => {
          allowed = true;
          return { requestId, status: "pending", revision: 0 };
        });
      const changed = vi.fn();
      render(<DocumentShareReview requestId={requestId} onChanged={changed} />);
      const allow = await screen.findByRole("button", { name: "Allow" });
      expect(screen.getByRole("status")).toHaveTextContent("Needs your decision");
      expect(screen.getByText("“Statements”")).toBeVisible();
      expect(screen.getByText("2026-01-01 – 2026-06-30")).toBeVisible();
      expect(screen.getByRole("button", { name: "Deny (tap again to confirm)" })).toBeEnabled();
      expect(allow).toHaveClass("bg-[color:var(--app-success-deep)]", "text-white");
      expect(screen.getByRole("button", { name: "Deny (tap again to confirm)" })).toHaveClass("h-[50px]");
      expect(screen.queryByRole("button", { name: /Share files|Decline/ })).toBeNull();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
      expect(state.prepareStream).not.toHaveBeenCalled();
      expect(state.prepare).not.toHaveBeenCalled();
      expect(state.periodic.mock.lastCall?.[3]).toEqual({ enabled: false });
      expect(screen.queryByRole("dialog", { name: "Set a price" })).toBeNull();

      fireEvent.click(allow);
      await screen.findByRole("dialog", { name: "Set a price" });
      expect(priceSheet.props).toMatchObject({ requesterLabel: "b@example.invalid",
        purpose: "Statements", paymentRequired: true, busy: false, error: null });
      // A refused price keeps the decision open and says what to change.
      fireEvent.click(screen.getByRole("button", { name: "Submit $20" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Choose a price from $0.50 to $500.");
      expect(screen.getByRole("dialog", { name: "Set a price" })).toBeVisible();
      expect(changed).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Submit $20" }));
      // Allowed, nothing started yet: it waits, and it never spins or claims work.
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Waiting to start"));
      expect(screen.getByRole("status").querySelector("svg")).toBeNull();
      expect(screen.getByText("Request allowed. The Drive search starts soon.")).toBeVisible();
      expect(state.allow).toHaveBeenCalledTimes(2);
      expect(state.allow).toHaveBeenLastCalledWith("owner-a", requestId,
        { revision: 0, amountCents: 2000 }, expect.any(Function));
      expect(screen.queryByRole("dialog", { name: "Set a price" })).toBeNull();
      expect(screen.getByText("$20")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
      expect(changed).toHaveBeenCalledOnce();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
      expect(state.decide).not.toHaveBeenCalled();
    });

    it("declines only after a confirming second tap on Deny", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(decision());
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Deny (tap again to confirm)" }));
      expect(state.decide).not.toHaveBeenCalled();
      state.status.mockResolvedValue({ ...pending(), status: "declined" });
      state.delivery.mockResolvedValue({ status: "declined", files: [] });
      fireEvent.click(screen.getByRole("button", { name: "Confirm Deny" }));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Request declined"));
      expect(state.decide).toHaveBeenCalledExactlyOnceWith("owner-a", requestId, "decline", 0, expect.any(Function));
      expect(state.allow).not.toHaveBeenCalled();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
    });

    it("lets the owner withdraw an Allow only until a batch is frozen", async () => {
      // Nothing is charged or shared before the first frozen batch.
      const allowed = (overrides: Record<string, unknown> = {}) => decision({ trustedAuto: true,
        allowAvailable: false, ownerAllowed: true, priceCents: 2000, ...overrides });
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(allowed());
      const changed = vi.fn();
      const view = render(<DocumentShareReview requestId={requestId} onChanged={changed} />);
      fireEvent.click(await screen.findByRole("button", { name: "Decline (tap again to confirm)" }));
      expect(state.decide).not.toHaveBeenCalled();
      state.status.mockResolvedValue({ ...pending(), status: "declined" });
      state.delivery.mockResolvedValue({ status: "declined", files: [] });
      fireEvent.click(screen.getByRole("button", { name: "Confirm Decline" }));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Request declined"));
      expect(state.decide).toHaveBeenCalledExactlyOnceWith("owner-a", requestId, "decline", 0, expect.any(Function));
      expect(changed).toHaveBeenCalledOnce();
      view.unmount();

      // Negative control: once a batch is frozen, the owner stops access instead.
      const batch = durableBulk({ status: "queued", canApprove: false });
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(allowed({ search: durableSearch(), bulkShare: batch,
        batches: [batch], batchCount: 1 }));
      state.delivery.mockResolvedValue({ status: "pending", files: [] });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("$20")).toBeVisible();
      expect(screen.queryByRole("button", { name: /Decline/ })).toBeNull();
    });

    it("keeps the manual search when the server does not offer Allow", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(decision({ allowAvailable: false }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(state.startRequestSearch).toHaveBeenCalledOnce());
      expect(await screen.findByRole("button", { name: "Decline" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Deny/ })).toBeNull();
      expect(screen.getByRole("status")).not.toHaveTextContent("Needs your decision");
    });
  });

  it("shows owner ledger status without claiming Stripe transfer reached a bank", async () => {
    state.status.mockResolvedValue(initial());
    state.review.mockResolvedValue({ ...review(), ownerPayout: {
      requestId, currency: "usd", grossAmountCents: 1000,
      retainedAmountCents: 700, platformFeeCents: 21,
      processingFeeCents: 68, ownerEarningCents: 611,
      status: "transferred",
    } });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    const earnings = await screen.findByLabelText("Document earnings");
    expect(earnings).toHaveTextContent("Sent to Stripe");
    expect(earnings).toHaveTextContent("Your net earnings: $6.11");
    expect(earnings).not.toHaveTextContent(/bank|deposited/i);
  });

  it("loads payout status for a completed owner request without a bulk share", async () => {
    state.status.mockResolvedValue({ ...initial(), status: "completed" });
    state.delivery.mockResolvedValue({ status: "completed", files: [] });
    state.review.mockResolvedValue({ ...review(), ownerPayout: {
      requestId, currency: "usd", grossAmountCents: 1000,
      retainedAmountCents: null, platformFeeCents: null,
      processingFeeCents: null, ownerEarningCents: null,
      status: "awaiting_fee",
    } });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    const earnings = await screen.findByLabelText("Document earnings");
    expect(earnings).toHaveTextContent("Calculating processing fee");
    expect(earnings).not.toHaveTextContent("Net $");
    expect(state.review).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Share files" })).toBeNull();
    expect(screen.queryByTestId("document-payout-account-card")).toBeNull();
  });

  it("offers payout setup while a paid document request awaits delivery", async () => {
    state.status.mockResolvedValue(initial());
    state.review.mockResolvedValue({ ...review(), ownerPayout: {
      requestId, currency: "usd", grossAmountCents: 1000,
      retainedAmountCents: null, platformFeeCents: null,
      processingFeeCents: null, ownerEarningCents: null,
      status: "awaiting_delivery",
    } });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(await screen.findByTestId("document-payout-account-card")).toBeVisible();
  });

  it("keeps terminal delivery visible if an older owner review is unavailable", async () => {
    state.status.mockResolvedValue({ ...initial(), status: "completed" });
    state.delivery.mockResolvedValue({ status: "completed", files: [] });
    state.review.mockRejectedValue(new DriveSharingError("request_unavailable", 404));
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    await waitFor(() => expect(state.review).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sharing results"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("durable request search and bulk sharing", () => {
    it.each([false, true])("reviews exact content-period candidates before sharing or payment (paid: %s)", async paymentRequired => {
      let phase: "searching" | "review_ready" | "queued" = "searching";
      const search = durableSearch({ status: "completed", matched: 46 });
      search.coverage = { ...search.coverage!, dateBasis: "content_period_unverified",
        timeIntent: "document_coverage", ownerReviewRequired: true,
        requestedPeriod: { start: "2026-01-01", end: "2026-06-30", timezone: "Asia/Kolkata" } };
      const batch = durableBulk({ fileCount: 2, positions: [1, 3],
        counts: { ...durableBulk().counts, total: 2, pending: 2 } });
      state.status.mockResolvedValue(pending());
      state.review.mockImplementation(async () => partial({ durableAvailable: true,
        // A stale automatic bit must not hide a current required owner review.
        trustedAuto: paymentRequired, ownerAllowed: true, paymentRequired,
        preparationError: null, progressiveAllowed: true, search,
        bulkShare: phase === "searching" ? null : { ...batch,
          status: phase === "queued" ? "queued" : "review_ready", canApprove: phase === "review_ready" },
        batches: phase === "searching" ? [] : [batch], batchCount: phase === "searching" ? 0 : 1,
        claimedPositions: phase === "searching" ? [] : [1, 3],
      }));
      state.requestSearchFiles.mockResolvedValue({ jobId: searchJobId, revision: 3, matched: 46,
        files: [1, 2, 3].map(position => ({ ...searchFile(position), shareable: true })), nextCursor: null });
      state.prepareRequestBatch.mockImplementation(async () => { phase = "review_ready"; return batch; });
      state.approveBulkShare.mockImplementation(async () => { phase = "queued"; return { ...batch, status: "queued", canApprove: false }; });

      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent("46 file candidates to review");
      expect(screen.getByText("Dates inside files haven't been checked. Select the exact files before sharing.")).toBeVisible();
      expect(screen.queryByText(/Matching files are found and shared automatically/)).toBeNull();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
      const first = await screen.findByRole("checkbox", { name: "Standup 1" });
      expect(first).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Standup 2" })).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Review 0 files" })).toBeDisabled();
      fireEvent.click(first);
      fireEvent.click(screen.getByRole("checkbox", { name: "Standup 3" }));
      expect(state.prepareRequestBatch).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Review 2 files" }));
      await waitFor(() => expect(state.prepareRequestBatch).toHaveBeenCalledWith(
        "owner-a", requestId, expect.objectContaining({ matched: 46 }), [1, 3], expect.any(Function),
      ));
      const share = await screen.findByRole("button", { name: "Share 2 files" });
      await waitFor(() => expect(share).toBeEnabled());
      expect(state.approveBulkShare).not.toHaveBeenCalled();
      if (paymentRequired) {
        expect(screen.getByText("The requester pays after you approve these files.")).toBeVisible();
      } else {
        expect(screen.queryByText("The requester pays after you approve these files.")).toBeNull();
      }
      fireEvent.click(share);
      await waitFor(() => expect(state.approveBulkShare).toHaveBeenCalledWith(
        "owner-a", expect.objectContaining({ shareId: bulkShareId, fileCount: 2 }), expect.any(Function),
      ));
      if (paymentRequired) expect(await screen.findByText("Files are shared after payment.")).toBeVisible();
      else expect(await screen.findByText("Sharing continues after you leave.")).toBeVisible();
    });

    it("keeps the existing selection and Approve flow for non-Trusted V1 verified files", async () => {
      let prepared = false;
      const search = durableSearch({ status: "completed", matched: 46 });
      const batch = durableBulk({ fileCount: 1, positions: [3],
        counts: { ...durableBulk().counts, total: 1, pending: 1 } });
      state.status.mockResolvedValue(pending());
      state.review.mockImplementation(async () => partial({
        durableAvailable: true, v1ManualReview: true, verifiedCount: 2,
        requestedAccessDays: 30,
        progressiveAllowed: true, paymentRequired: true, priceCents: 50,
        search, bulkShare: prepared ? batch : null,
        batches: prepared ? [batch] : [], batchCount: prepared ? 1 : 0,
        claimedPositions: prepared ? [3] : [],
      }));
      state.requestSearchFiles.mockResolvedValue({ jobId: searchJobId, revision: 3, matched: 46,
        files: [1, 3].map(position => ({ ...searchFile(position), shareable: true })), nextCursor: null });
      state.prepareRequestBatch.mockImplementation(async () => { prepared = true; return batch; });

      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("2 files checked against the request. Select the exact files to share.")).toBeVisible();
      expect(screen.getByText("Only Agent One's verified matches can be selected.")).toBeVisible();
      expect(screen.getByRole("heading", { name: "Verified files" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
      expect(screen.queryByText("Dates inside files haven't been checked. Select the exact files before sharing.")).toBeNull();
      fireEvent.click(await screen.findByRole("checkbox", { name: "Standup 1" }));
      fireEvent.click(screen.getByRole("button", { name: "Review 1 file" }));
      await waitFor(() => expect(state.prepareRequestBatch).toHaveBeenCalledWith(
        "owner-a", requestId, expect.objectContaining({ matched: 46 }), [3], expect.any(Function),
      ));
      const approve = await screen.findByRole("button", { name: "Approve 1 file" });
      expect(approve).toBeEnabled();
      expect(screen.getByText("Viewer for 30 days")).toBeVisible();
      fireEvent.change(screen.getByLabelText("Access period"), { target: { value: "7" } });
      fireEvent.click(approve);
      await waitFor(() => expect(state.approveBulkShare).toHaveBeenCalledWith(
        "owner-a", expect.objectContaining({ fileCount: 1 }), expect.any(Function), 7,
      ));
    });

    it("offers one-time background Drive setup for an automatic Trusted-circle request without manual approval", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValueOnce(partial({ durableAvailable: true, trustedAuto: true,
        search: null, bulkShare: null, preparationError: "background_preparation_required" }))
        .mockResolvedValue(partial({ durableAvailable: true, trustedAuto: true,
          search: null, bulkShare: null, preparationError: "trusted_auto_queued" }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      const enable = await screen.findByRole("button", { name: "Enable background Drive access" });
      expect(screen.getByRole("status")).toHaveTextContent("Background Drive access needed");
      expect(screen.getByText("Turn on background access so Agent One can resume this request.")).toBeVisible();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /Review \d+ files/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Share \d+ files/ })).toBeNull();
      fireEvent.click(enable);
      await waitFor(() => expect(state.setLiveBackground).toHaveBeenCalledExactlyOnceWith("owner-a", true));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Waiting to start"));
      expect(screen.queryByRole("button", { name: "Enable background Drive access" })).toBeNull();
    });

    it("keeps a Trusted Circle request paused until the server confirms resumption", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial({ durableAvailable: true, trustedAuto: true,
        search: null, bulkShare: null, preparationError: "background_preparation_required" }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Enable background Drive access" }));
      await waitFor(() => expect(state.review).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("status")).toHaveTextContent("Background Drive access needed");
      expect(screen.getByRole("button", { name: "Enable background Drive access" })).toBeVisible();
      expect(screen.queryByText("Matching files are found and shared automatically.", { exact: false })).toBeNull();
    });

    it("explains an older undated automatic request without retrying its search", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial({ durableAvailable: true, trustedAuto: true,
        search: null, bulkShare: null, preparationError: "date_range_required" }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent("Exact dates needed");
      expect(screen.getByText("This request needs exact start and end dates. Ask the requester to send a new request with both dates.")).toBeVisible();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
    });

    it("shows all confirmed automatic sharing outcomes instead of only the latest batch", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial({ durableAvailable: true, trustedAuto: true,
        search: durableSearch({ status: "running", matched: 60 }),
        bulkShare: durableBulk({ status: "queued", fileCount: 10,
          counts: { total: 10, processed: 0, shared: 0, alreadyShared: 0,
            skipped: 0, failed: 0, needsReview: 0, unknown: 0, pending: 10 } }),
        aggregateCounts: { total: 50, processed: 40, shared: 40, alreadyShared: 0,
          skipped: 0, failed: 0, needsReview: 0, unknown: 0, pending: 10 },
      }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("40 of 50 files available")).toBeVisible();
      expect(screen.getByRole("status")).toHaveTextContent("Sharing files · 40 shared so far");
      expect(screen.queryByRole("button", { name: /Review \d+ files|Share \d+ files/ })).toBeNull();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
    });

    // 2026-10-18: the owner saw 35 candidates and 3 held files with no reason
    // for the rest. Drive's count of matches this account can't share is owner-only.
    it("tells the owner how many automatic matches only their owners can share", async () => {
      const automatic = (unshareableCount: number) => partial({ durableAvailable: true, trustedAuto: true,
        ownerAllowed: true, autoshare: true, bulkShare: null,
        search: durableSearch({ status: "running", matched: 35, unshareableCount }) });
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(automatic(32));
      const view = render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("32 of these can only be shared by their owners.")).toBeVisible();
      view.unmount();

      state.review.mockResolvedValue(automatic(0));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText(/35 file candidates so far/)).toBeVisible();
      expect(screen.queryByText(/can only be shared by/)).toBeNull();
    });

    // 2026-10-18: after Allow the order (and the owner's earning row) exists
    // before the requester pays, yet A read "Payout pending · Waiting for
    // delivery" and "candidates so far" after the search ended, and lost
    // Decline as soon as a batch was frozen, with no way to end the request.
    describe("an allowed autoshare request", () => {
      const heldBatch = durableBulk({ status: "review_ready", fileCount: 3, canApprove: false,
        counts: { ...durableBulk().counts, total: 3, pending: 3 } });
      const earning = { requestId, currency: "usd", grossAmountCents: 500, retainedAmountCents: null,
        platformFeeCents: null, processingFeeCents: null, ownerEarningCents: null, status: "awaiting_delivery" };
      // The server sends the owner payment setup fields only until the order is paid.
      const unpaid = { paymentsReady: true, ownerPayoutAccountReady: true, ownerPriceRequired: false };
      const allowed = (overrides: Record<string, unknown> = {}) => partial({ durableAvailable: true,
        trustedAuto: true, ownerAllowed: true, autoshare: true, paymentRequired: true, priceCents: 500,
        search: durableSearch({ status: "completed", matched: 35 }), bulkShare: heldBatch,
        batches: [heldBatch], batchCount: 1, claimedPositions: [1, 2, 3], ownerPayout: earning,
        ...overrides });

      it("says what waits on payment, and keeps Decline until the requester pays", async () => {
        state.status.mockResolvedValue(pending());
        state.review.mockResolvedValue(allowed(unpaid));
        // An unpaid, unapproved batch has no delivery to stop yet.
        state.delivery.mockResolvedValue({ status: "pending", files: [] });
        render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
        expect(await screen.findByText("35 file candidates")).toBeVisible();
        expect(screen.queryByText(/file candidates so far/)).toBeNull();
        // The held batch waits on the requester; the owner has nothing to review.
        expect(screen.getByRole("status")).toHaveTextContent("Waiting for payment");
        expect(screen.getByText(
          "After payment, Agent One sends every matching file you can share, in batches. You can close this.",
        )).toBeVisible();
        const earnings = screen.getByLabelText("Document earnings");
        expect(earnings).toHaveTextContent("Waiting for payment");
        expect(earnings).not.toHaveTextContent(/Payout pending|delivery/);
        fireEvent.click(screen.getByRole("button", { name: "Decline (tap again to confirm)" }));
        fireEvent.click(screen.getByRole("button", { name: "Confirm Decline" }));
        await waitFor(() => expect(state.decide)
          .toHaveBeenCalledExactlyOnceWith("owner-a", requestId, "decline", 0, expect.any(Function)));
      });

      it("offers Stop instead of Decline once the requester paid", async () => {
        const sharing = durableBulk({ status: "running", fileCount: 3, canApprove: false,
          counts: { ...durableBulk().counts, total: 3, processed: 1, shared: 1, pending: 2 } });
        state.status.mockResolvedValue(pending());
        state.review.mockResolvedValue(allowed({ search: durableSearch({ status: "running", matched: 35 }),
          bulkShare: sharing, batches: [sharing] }));
        state.delivery.mockResolvedValue({ status: "pending", files: [], bulkShareId, fileCount: 3, sharedCount: 1 });
        state.bulkShareFiles.mockResolvedValue({ shareId: bulkShareId, files: [], nextCursor: null });
        state.prepareRevocation.mockResolvedValue({ requestId, revision: 1, generation: 1,
          directiveId: "directive", expiresAt: new Date(Date.now() + 60_000).toISOString(),
          reviewDigest: "c".repeat(64), disclosure: "remove-current-recorded-direct-viewer-v1",
          otherAccessMayRemain: true, affectedCount: 1, pendingCount: 2, files: [] });
        render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
        expect(await screen.findByText(/35 file candidates so far/)).toBeVisible();
        expect(screen.getByLabelText("Document earnings")).toHaveTextContent("Payout pending · Waiting for delivery");
        expect(screen.queryByRole("button", { name: /Decline/ })).toBeNull();
        fireEvent.click(await screen.findByText("Review removal"));
        await waitFor(() => expect(state.prepareRevocation).toHaveBeenCalledOnce());
        expect(await screen.findByRole("button", { name: "Stop access" })).toBeEnabled();
      });

      it("leaves an older automatic request's copy and Decline rule alone (negative control)", async () => {
        state.status.mockResolvedValue(pending());
        state.review.mockResolvedValue(allowed({ ...unpaid, autoshare: undefined }));
        state.delivery.mockResolvedValue({ status: "pending", files: [] });
        render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
        expect(await screen.findByText(/35 file candidates so far/)).toBeVisible();
        expect(screen.getByRole("status")).toHaveTextContent("Ready for review");
        expect(screen.getByLabelText("Document earnings")).toHaveTextContent("Payout pending · Waiting for delivery");
        expect(screen.getByText(/Agent One searches Drive and shares selected files/)).toBeVisible();
        expect(screen.queryByRole("button", { name: /Decline/ })).toBeNull();
      });
    });

    it("tells an autoshare requester how many files arrived when some could not be sent", async () => {
      const refunded = { state: "partially_refunded", amountCents: 500, currency: "usd", checkoutExpiresAt: null,
        requestExpiresAt: null, refund: { status: "succeeded", amountCents: 200 }, nextAction: "none" };
      const partialDelivery = { status: "partial", files: [], bulkShareId, fileCount: 5, sharedCount: 3,
        bulkStatus: "partial" };
      state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "partial",
        paymentRequired: true, payment: { ...refunded, autoshare: true } });
      state.delivery.mockResolvedValue(partialDelivery);
      const view = render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getAllByRole("status")[0]).toHaveTextContent("Files sent · 3"));
      expect(screen.getByText("$2 refunded for files not sent.")).toBeVisible();
      view.unmount();

      // Missing aggregate receipts never imply a delivery failure.
      state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "partial",
        paymentRequired: true, payment: refunded });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getAllByRole("status")[0]).toHaveTextContent("Review sharing and search results"));
      expect(screen.getByText("$2 refunded")).toBeVisible();
    });

    // The server resumes automatic batches only for a complete search.
    it.each([
      ["failed", "Search failed"],
      ["limited", "Search incomplete"],
      ["stopped", "Search stopped"],
    ])("never promises sharing for an automatic search that %s, and offers the next step", async (status, label) => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial({ durableAvailable: true, trustedAuto: true, ownerAllowed: true,
        search: durableSearch({ status, matched: 12 }), bulkShare: null, batches: [], batchCount: 0,
        claimedPositions: [] }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(label));
      expect(screen.getByRole("status")).not.toHaveTextContent("Waiting to share");
      expect(screen.getByText(
        "Automatic sharing stopped because the Drive search didn't finish. Review and share the files yourself.",
      )).toBeVisible();
      expect(screen.queryByText(/You can close this window/)).toBeNull();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Search again" }));
      await waitFor(() => expect(state.startRequestSearch).toHaveBeenCalledOnce());
    });

    it("stops claiming work when no worker has moved a started request", async () => {
      // 2026-10-17: the drains were paused between search slices.
      const working = { durableAvailable: true, trustedAuto: true, ownerAllowed: true,
        search: durableSearch({ status: "queued", matched: 7 }), bulkShare: null };
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial(working));
      const view = render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Searching Drive · 7 file candidates"));
      view.unmount();

      state.review.mockResolvedValue(partial({ ...working,
        workDelayedSince: new Date(Date.now() - 10 * 60_000 - 5_000).toISOString() }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Taking longer than usual · 10 min"));
      expect(screen.getByRole("status").querySelector("svg")).toBeNull();
      expect(screen.getByText("This request is saved and continues automatically.")).toBeVisible();
      expect(screen.getByRole("status")).not.toHaveTextContent(/searching|paused/i);
      expect(state.startRequestSearch).not.toHaveBeenCalled();
    });

    it("tells the requester when started sharing has not moved, instead of sharing in progress", async () => {
      state.status.mockResolvedValue({ ...pending(), direction: "outgoing", autoshare: true,
        workDelayedSince: new Date(Date.now() - 4 * 60_000 - 5_000).toISOString() });
      state.delivery.mockResolvedValue({ status: "pending", files: [], bulkStatus: "running" });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Taking longer than usual · 4 min"));
      expect(screen.getByText("Your request is saved and continues automatically.")).toBeVisible();
      expect(screen.getByRole("status")).not.toHaveTextContent(/Sharing in progress|paused/i);
    });

    // An owner-allowed request was never Trusted Circle work, so it must not claim Trusted Circle.
    it.each([
      [false, "Trusted Circle changed. Review this request manually before sharing."],
      [true, "This request needs a manual review before sharing."],
    ])("returns to manual review when automatic eligibility changes (allowed: %s)", async (ownerAllowed, copy) => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial({ durableAvailable: true, trustedAuto: true, ownerAllowed,
        preparationError: "trusted_relationship_changed", progressiveAllowed: true,
        search: durableSearch({ status: "running", matched: 1,
          coverage: { ...durableSearch({ status: "completed" }).coverage!, providerPagesExhausted: false } }),
        bulkShare: null, batches: [], batchCount: 0, claimedPositions: [],
      }));
      state.requestSearchFiles.mockResolvedValue({ jobId: searchJobId, revision: 1, matched: 1,
        files: [{ ...searchFile(1), shareable: true }], nextCursor: null });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText(copy)).toBeVisible();
      if (ownerAllowed) expect(screen.queryByText(/Trusted Circle/)).toBeNull();
      expect(await screen.findByRole("button", { name: "Review 1 file" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Enable background Drive access" })).toBeNull();
    });

    it("shows manual batch review after an owner takes over a Trusted-circle search", async () => {
      state.status.mockResolvedValue(pending());
      // The owner review projection clears trustedAuto after authenticated manual takeover.
      state.review.mockResolvedValue(partial({ durableAvailable: true, trustedAuto: false,
        preparationError: null, progressiveAllowed: true,
        search: durableSearch({ status: "running", matched: 1,
          coverage: { ...durableSearch({ status: "completed" }).coverage!, providerPagesExhausted: false } }),
        bulkShare: null, batches: [], batchCount: 0, claimedPositions: [],
      }));
      state.requestSearchFiles.mockResolvedValue({ jobId: searchJobId, revision: 1, matched: 1,
        files: [{ ...searchFile(1), shareable: true }], nextCursor: null });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("button", { name: "Review 1 file" })).toBeEnabled();
      expect(screen.queryByText("Matching files are found and shared automatically.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Enable background Drive access" })).toBeNull();
    });

    it("requires explicit owner selection and approval to recover a skipped automatic file", async () => {
      let phase: "searching" | "review_ready" | "queued" = "searching";
      const search = durableSearch({ status: "running", matched: 3,
        coverage: { ...durableSearch({ status: "completed" }).coverage!, providerPagesExhausted: false } });
      const batch = durableBulk({ fileCount: 2, positions: [2, 3],
        counts: { ...durableBulk().counts, total: 2, pending: 2 } });
      state.status.mockResolvedValue(pending());
      state.review.mockImplementation(async () => partial({ durableAvailable: true,
        trustedAuto: false, preparationError: null, progressiveAllowed: true, search,
        bulkShare: phase === "searching" ? null : { ...batch,
          status: phase === "queued" ? "queued" : "review_ready", canApprove: phase === "review_ready" },
        batches: phase === "searching" ? [] : [batch], batchCount: phase === "searching" ? 0 : 1,
        claimedPositions: phase === "searching" ? [1, 2] : [1, 2, 3],
        recoverablePositions: phase === "searching" ? [2] : [],
      }));
      state.requestSearchFiles.mockResolvedValue({ jobId: searchJobId, revision: 1, matched: 3,
        files: [1, 2, 3].map(position => ({ ...searchFile(position), shareable: true })), nextCursor: null });
      state.prepareRequestBatch.mockImplementation(async () => { phase = "review_ready"; return batch; });
      state.approveBulkShare.mockImplementation(async () => { phase = "queued"; return { ...batch, status: "queued", canApprove: false }; });

      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      const previouslyClaimed = await screen.findByRole("checkbox", { name: "Standup 1" });
      const recovery = screen.getByRole("checkbox", { name: "Standup 2" });
      const fresh = screen.getByRole("checkbox", { name: "Standup 3" });
      expect(previouslyClaimed).toBeDisabled();
      expect(recovery).toBeEnabled();
      expect(recovery).not.toBeChecked();
      expect(fresh).toBeChecked();
      expect(screen.getByText("Automatic sharing stopped before this file was sent. Select it to review and share.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Review 1 file" })).toBeEnabled();
      expect(state.prepareRequestBatch).not.toHaveBeenCalled();
      fireEvent.click(recovery);
      fireEvent.click(screen.getByRole("button", { name: "Review 2 files" }));
      await waitFor(() => expect(state.prepareRequestBatch).toHaveBeenCalledWith(
        "owner-a", requestId, expect.objectContaining({ status: "running" }), [2, 3], expect.any(Function),
      ));
      expect(state.approveBulkShare).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: "Share 2 files" }));
      await waitFor(() => expect(state.approveBulkShare).toHaveBeenCalledTimes(1));
    });

    it("reviews the first 25 while Drive keeps searching, then offers the next unclaimed page", async () => {
      let phase: "searching" | "first_review" | "first_queued" | "second_review" = "searching";
      const secondId = "55555555-5555-4555-8555-555555555555";
      const firstPositions = Array.from({ length: 25 }, (_, index) => index + 1);
      const secondPositions = Array.from({ length: 25 }, (_, index) => index + 26);
      const search = durableSearch({ status: "running", matched: 50,
        coverage: { ...durableSearch({ status: "completed" }).coverage!, providerPagesExhausted: false } });
      const first = durableBulk({ fileCount: 25, positions: firstPositions,
        counts: { ...durableBulk().counts, total: 25, pending: 25 } });
      const second = durableBulk({ ...first, shareId: secondId, positions: secondPositions });
      state.status.mockResolvedValue(pending());
      state.review.mockImplementation(async () => partial({ durableAvailable: true, progressiveAllowed: true, search,
        bulkShare: phase === "searching" ? null : phase === "second_review" ? second :
          phase === "first_queued" ? { ...first, status: "queued", canApprove: false } : first,
        batches: phase === "searching" ? [] : phase === "second_review" ? [second, { ...first, status: "queued", canApprove: false }] :
          [phase === "first_queued" ? { ...first, status: "queued", canApprove: false } : first],
        batchCount: phase === "searching" ? 0 : phase === "second_review" ? 2 : 1,
        claimedPositions: phase === "searching" ? [] : phase === "second_review" ? [...firstPositions, ...secondPositions] : firstPositions,
      }));
      state.requestSearchFiles.mockImplementation(async (_token, _id, _job, _guard, cursor) => ({
        jobId: searchJobId, revision: 3, matched: 50,
        files: (cursor ? secondPositions : firstPositions).map(position => ({
          ...searchFile(position), shareable: true,
        })),
        nextCursor: cursor ? null : "page-2",
      }));
      state.prepareRequestBatch.mockImplementation(async () => {
        phase = phase === "searching" ? "first_review" : "second_review";
        return phase === "first_review" ? first : second;
      });
      state.approveBulkShare.mockImplementation(async () => {
        phase = "first_queued";
        return { ...first, status: "queued", canApprove: false };
      });
      state.bulkShareFiles.mockImplementation(async (_token, shareId) => ({ shareId,
        files: [{ position: shareId === secondId ? 26 : 1, name: "Original",
          mimeType: "application/vnd.google-apps.document", modifiedTime: null, openUrl: null }], nextCursor: null }));

      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("button", { name: "Review 25 files" })).toBeEnabled();
      expect(screen.getByRole("status")).toHaveTextContent("Searching Drive · 50 file candidates");
      fireEvent.click(screen.getByRole("button", { name: "Review 25 files" }));
      await waitFor(() => expect(state.prepareRequestBatch).toHaveBeenCalledWith(
        "owner-a", requestId, expect.objectContaining({ status: "running" }), firstPositions, expect.any(Function),
      ));
      const share = await screen.findByRole("button", { name: "Share 25 files" });
      expect(screen.getByRole("checkbox", { name: "Standup 1" })).toBeDisabled();
      fireEvent.click(share);
      await waitFor(() => expect(state.approveBulkShare).toHaveBeenCalledTimes(1));
      expect(screen.getAllByText("Already in a sharing batch")).toHaveLength(25);
      fireEvent.click(screen.getByRole("button", { name: "Next 25" }));
      expect(await screen.findByRole("checkbox", { name: "Standup 26" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Review 25 files" }));
      await waitFor(() => expect(state.prepareRequestBatch).toHaveBeenCalledWith(
        "owner-a", requestId, expect.objectContaining({ status: "running" }), secondPositions, expect.any(Function),
      ));
      expect(screen.getByRole("status")).toHaveTextContent("2 batches started");
    });
    const searchFile = (position: number) => ({
      position, id: `drive-${position}`, name: `Standup ${position}`,
      mimeType: "application/vnd.google-apps.document", modifiedTime: null, openUrl: null,
    });

    it("starts the full search for an existing two-file review and retains those names if start fails", async () => {
      state.status.mockResolvedValue(initial());
      state.review.mockResolvedValue({ ...review(), durableAvailable: true, search: null, bulkShare: null,
        files: [
          { documentId: "old-1", name: "Old standup 1" },
          { documentId: "old-2", name: "Old standup 2" },
        ] });
      state.startRequestSearch.mockRejectedValue(new Error("offline"));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("Old standup 1")).toBeVisible();
      expect(screen.getByText("Old standup 2")).toBeVisible();
      expect(screen.getByText("Earlier suggestions")).toBeVisible();
      expect(screen.getByRole("button", { name: "Share files" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Search again" })).toBeEnabled();
      expect(state.startRequestSearch).toHaveBeenCalledOnce();
      expect(state.prepareStream).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Search again" }));
      await waitFor(() => expect(state.startRequestSearch).toHaveBeenCalledTimes(2));
      expect(screen.getByText("Old standup 1")).toBeVisible();
      expect(screen.getByRole("button", { name: "Share files" })).toBeDisabled();
    });

    it.each([
      { shareabilityVerified: false },
      { shareabilityVerified: true, ownerReviewRequired: true },
    ])("replaces a legacy completed search before review: %j", async (legacyCoverage) => {
      const complete = durableSearch({ status: "completed", matched: 2 });
      const legacy = { ...complete, coverage: { ...complete.coverage!, ...legacyCoverage } };
      const refreshed = durableSearch({ jobId: "55555555-5555-4555-8555-555555555555",
        status: "queued", matched: 0, coverage: { ...complete.coverage!, shareabilityVerified: true } });
      const start = deferred<void>();
      let replaced = false;
      state.status.mockResolvedValue(pending());
      state.review.mockImplementation(async () => partial({ durableAvailable: true,
        search: replaced ? refreshed : legacy, bulkShare: null }));
      state.startRequestSearch.mockImplementation(async () => {
        await start.promise;
        replaced = true;
        return refreshed;
      });
      state.requestSearchFiles.mockResolvedValue({ jobId: refreshed.jobId, revision: 1,
        matched: 0, files: [], nextCursor: null });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Updating file access checks"));
      expect(screen.getByText("Earlier files cannot be selected while the new check runs.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Updating file access" })).toBeDisabled();
      expect(state.requestSearchFiles).not.toHaveBeenCalled();
      expect(state.prepareRequestBulk).not.toHaveBeenCalled();
      await act(async () => start.resolve());
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Searching Drive · 0 file candidates"));
      await poll();
      expect(state.startRequestSearch).toHaveBeenCalledOnce();
      expect(state.prepareRequestBulk).not.toHaveBeenCalled();
    });

    it("preserves a frozen batch when older selection metadata lacks time intent", async () => {
      const complete = durableSearch({ status: "completed", matched: 2 });
      const legacy = { ...complete, coverage: { ...complete.coverage!, ownerReviewRequired: true } };
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial({ durableAvailable: true, search: legacy,
        bulkShare: durableBulk({ status: "review_ready", fileCount: 2, canApprove: true }) }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole("button", { name: "Share 2 files" })).toBeEnabled());
      expect(state.startRequestSearch).not.toHaveBeenCalled();
      expect(state.prepareRequestBulk).not.toHaveBeenCalled();
      expect(state.approveBulkShare).not.toHaveBeenCalled();
    });

    it("does not approve a frozen selection from a legacy search", async () => {
      const complete = durableSearch({ status: "completed", matched: 2 });
      const legacy = { ...complete, coverage: { ...complete.coverage!, shareabilityVerified: false } };
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial({ durableAvailable: true, search: legacy,
        bulkShare: durableBulk({ status: "review_ready", fileCount: 2, canApprove: true }) }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This selection predates the sharing permission check. Ask for a new document request before sharing.",
      );
      expect(screen.getByRole("button", { name: "New request needed" })).toBeDisabled();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
      expect(state.approveBulkShare).not.toHaveBeenCalled();
    });

    it("resumes a request search after the sheet closes without starting another one", async () => {
      let running = false;
      state.status.mockResolvedValue(pending());
      state.review.mockImplementation(async () => partial({
        durableAvailable: true,
        search: running ? durableSearch({ matched: 250 }) : null,
        bulkShare: null,
      }));
      state.startRequestSearch.mockImplementation(async () => {
        running = true;
        return durableSearch({ matched: 250 });
      });
      const first = render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent("Searching Drive · 250 file candidates");
      expect(screen.getByRole("button", { name: "Search in progress" })).toBeDisabled();
      expect(screen.getByText(/250 file candidates so far\. Search continues after you leave\./)).toBeVisible();
      expect(state.startRequestSearch).toHaveBeenCalledOnce();
      expect(state.prepareStream).not.toHaveBeenCalled();
      first.unmount();
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent("Searching Drive · 250 file candidates");
      expect(state.startRequestSearch).toHaveBeenCalledOnce();
    });

    it("updates live candidate counts from a search status stream and keeps polling as fallback", async () => {
      let matched = 2;
      let notify: ((status: ReturnType<typeof durableSearch>) => void) | undefined;
      state.status.mockResolvedValue(pending());
      state.review.mockImplementation(async () => partial({
        durableAvailable: true, search: durableSearch({ matched }), bulkShare: null,
      }));
      searchStream.status.mockImplementation((_token, _jobId, _guard, onStatus) => {
        notify = onStatus;
        return Promise.resolve("interrupted");
      });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(searchStream.status).toHaveBeenCalledOnce());
      expect(screen.getByRole("status")).toHaveTextContent("Searching Drive · 2 file candidates");
      matched = 5;
      await act(async () => notify?.(durableSearch({ matched: 5, revision: 4 })));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Searching Drive · 5 file candidates"));
      expect(state.startRequestSearch).not.toHaveBeenCalled();
      // The existing periodic GET remains available after a broken stream.
      expect(state.periodic).toHaveBeenCalledWith(
        `document-share-review:${requestId}`, expect.any(Number), expect.any(Function),
        expect.objectContaining({ enabled: true }),
      );
    });

    it("lets the owner review finalized latest files without waiting for older Drive pages", async () => {
      const complete = durableSearch({ status: "completed", matched: 2 });
      complete.coverage = { ...complete.coverage!, providerPagesExhausted: false,
        requestedResultLimit: 2, resultOrder: "modifiedTime desc", selectionFinalized: true,
        candidateCount: 25, candidateCountScope: "retained_pool", candidatePoolPruned: true };
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial({ durableAvailable: true, progressiveAllowed: false,
        search: complete, bulkShare: null }));
      state.requestSearchFiles.mockResolvedValue({ jobId: searchJobId, revision: 3, matched: 2,
        files: [searchFile(1), searchFile(2)], nextCursor: null });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent("2 file candidates to review");
      expect(screen.getByText("Selected candidates available; more files may exist.")).toBeVisible();
      await screen.findByText("Standup 1");
      const reviewFiles = screen.getByRole("button", { name: "Review 2 files" });
      expect(reviewFiles).toBeEnabled();
      fireEvent.click(reviewFiles);
      await waitFor(() => expect(state.prepareRequestBulk).toHaveBeenCalledWith(
        "owner-a", requestId, complete, [], expect.any(Function),
      ));
    });

    it("reviews all 525 matches by page, preserves exclusions, then shares the frozen subset", async () => {
      let phase: "running" | "complete" | "bulk" | "queued" = "running";
      const complete = durableSearch({ status: "completed", matched: 525, pagesScanned: 6 });
      const selectedBulk = durableBulk({ fileCount: 523,
        counts: { ...durableBulk().counts, total: 523, pending: 523 } });
      state.status.mockImplementation(async () => phase === "queued"
        ? { ...initial(), status: "approved" } : pending());
      state.review.mockImplementation(async () => partial({
        durableAvailable: true,
        search: phase === "running" ? durableSearch({ matched: 250 }) : complete,
        bulkShare: phase === "bulk" ? selectedBulk : phase === "queued"
          ? durableBulk({ ...selectedBulk, status: "queued", canApprove: false }) : null,
      }));
      state.requestSearchFiles.mockImplementation(async (_token, _id, _job, _guard, cursor) => ({
        jobId: searchJobId, revision: 5, matched: 525,
        files: Array.from({ length: 25 }, (_, index) => searchFile((cursor ? 25 : 0) + index + 1)),
        nextCursor: cursor ? "page-3" : "page-2",
      }));
      state.prepareRequestBulk.mockImplementation(async () => { phase = "bulk"; return selectedBulk; });
      state.approveBulkShare.mockImplementation(async () => { phase = "queued"; return durableBulk({ ...selectedBulk, status: "queued", canApprove: false }); });
      state.delivery.mockResolvedValue({ status: "approved", files: [], bulkShareId,
        fileCount: 523, sharedCount: 0 });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent("Searching Drive · 250 file candidates");
      expect(screen.queryByText("525 matching files")).toBeNull();
      phase = "complete";
      await poll();
      expect(await screen.findByText("Standup 1")).toBeVisible();
      expect(state.startRequestSearch).not.toHaveBeenCalled();
      expect(screen.getByText("525 file candidates. Select the files to share.")).toBeVisible();
      fireEvent.click(screen.getByRole("checkbox", { name: "Standup 1" }));
      fireEvent.click(screen.getByRole("button", { name: "Next 25" }));
      expect(await screen.findByText("Standup 26")).toBeVisible();
      fireEvent.click(screen.getByRole("checkbox", { name: "Standup 26" }));
      expect(screen.getByRole("button", { name: "Review 523 files" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Review 523 files" }));
      await waitFor(() => expect(state.prepareRequestBulk).toHaveBeenCalledWith(
        "owner-a", requestId, expect.objectContaining({ matched: 525 }), [1, 26], expect.any(Function),
      ));
      const share = await screen.findByRole("button", { name: "Share 523 files" });
      await waitFor(() => expect(share).toBeEnabled());
      fireEvent.click(share);
      await waitFor(() => expect(state.approveBulkShare).toHaveBeenCalledWith(
        "owner-a", expect.objectContaining({ shareId: bulkShareId, fileCount: 523 }), expect.any(Function),
      ));
      expect(await screen.findByRole("status")).toHaveTextContent("Sharing in progress");
      expect(screen.getByText("0 of 523 files available")).toBeVisible();
    });

    it("pages through verified shared links for the requester", async () => {
      state.requesterContext.mockResolvedValue(requesterTerms({ recipientEmail: "b@gmail.test" }));
      state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "completed" });
      state.delivery.mockResolvedValue({ status: "completed", files: [], bulkShareId,
        fileCount: 525, sharedCount: 525 });
      state.deliveryFiles.mockImplementation(async (_token, _id, _guard, cursor) => ({
        files: Array.from({ length: 25 }, (_, index) => {
          const position = (cursor ? 25 : 0) + index + 1;
          return { name: `Standup ${position}`, status: "succeeded", grantId: `grant-${position}`,
            revocationStatus: null, managed: false, manageInGoogle: false,
            openUrl: `https://drive.google.com/file/d/file-${position}/view` };
        }),
        nextCursor: cursor ? null : "page-2",
      }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("525 of 525 files available")).toBeVisible();
      expect(await screen.findByText("Standup 1")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Next 25" }));
      expect(await screen.findByText("Standup 26")).toBeVisible();
      expect(screen.getAllByRole("link", { name: "Open in Google Drive" })[0]).toHaveAttribute(
        "href", "https://drive.google.com/file/d/file-26/view?authuser=b%40gmail.test",
      );
    });

    it("lets the owner stop a delivered bulk request without loading every file", async () => {
      state.status.mockResolvedValue({ ...initial(), status: "completed" });
      state.delivery.mockResolvedValue({ status: "completed", files: [], bulkShareId,
        fileCount: 72, sharedCount: 71 });
      state.prepareRevocation.mockResolvedValue({ revision: 4, directiveId: "d",
        reviewDigest: "b".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(),
        affectedCount: 71, pendingCount: 1, files: [] });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Review removal" }));
      expect(await screen.findByText("Stop this request and check 71 file permissions.")).toBeVisible();
      expect(screen.getByText("1 grant is still settling.")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Stop access" }));
      await waitFor(() => expect(state.revoke).toHaveBeenCalledOnce());
      expect(state.deliveryFiles).not.toHaveBeenCalled();
    });

    it.each([true, false])("lets the owner stop a paid frozen request before any grant is queued (trusted: %s)", async (trustedAuto) => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial({ durableAvailable: true, trustedAuto,
        progressiveAllowed: !trustedAuto,
        search: durableSearch({ status: "completed" }),
        bulkShare: durableBulk({ status: "review_ready", fileCount: 1 }),
      }));
      state.delivery.mockResolvedValue({ status: "pending", files: [], canStopAccess: true });
      state.prepareRevocation.mockResolvedValue({ revision: 4, directiveId: "d",
        reviewDigest: "b".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(),
        affectedCount: 0, pendingCount: 0, files: [] });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      await waitFor(() => expect(state.delivery).toHaveBeenCalled());
      fireEvent.click(await screen.findByRole("button", { name: "Stop access" }));
      expect(state.prepareRevocation).toHaveBeenCalledOnce();
      expect(await screen.findByText("Stop this request before files are shared.")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Stop access" }));
      await waitFor(() => expect(state.revoke).toHaveBeenCalledOnce());
    });

    it("accounts for the skipped file, keeps search coverage, and pages the owner's original links", async () => {
      state.providers = [{ providerId: "google.com", email: "a@gmail.test" }];
      state.status.mockResolvedValue({ ...initial(), status: "partial" });
      state.delivery.mockResolvedValue({ status: "partial", files: [], bulkShareId, fileCount: 72, sharedCount: 71 });
      state.review.mockResolvedValue(partial({ durableAvailable: true,
        aggregateCounts: { total: 72, processed: 72, shared: 62, alreadyShared: 9,
          skipped: 1, failed: 0, needsReview: 0, unknown: 0, pending: 0 },
        search: durableSearch({ status: "completed", matched: 108, unshareableCount: 36, coverage: {
          corpora: ["user", "member_shared_drives"], fileKind: "document",
          requestedPeriod: { start: "2026-06-28", end: "2026-09-28", timezone: "Asia/Kolkata" },
          dateBasis: "title_date_then_created_or_modified", contentPeriodVerified: false,
          providerRowsScanned: 540, excludedByDateCount: 450, excludedByTopicCount: 7, deduplicatedCount: 18,
          unavailableShortcutCount: 36, providerPagesExhausted: true,
          shareabilityVerified: true,
        } }),
        bulkShare: durableBulk({ status: "partial", fileCount: 72, canApprove: false,
          counts: { total: 72, processed: 72, shared: 62, alreadyShared: 9, skipped: 1,
            failed: 0, needsReview: 0, unknown: 0, pending: 0 },
          issues: [{ reasonCode: "source_not_shareable", count: 1 }],
        }),
      }));
      state.bulkShareFiles.mockImplementation(async (_token, _id, _guard, cursor) => ({
        shareId: bulkShareId, nextCursor: cursor ? null : "page-2",
        files: [{ position: cursor ? 26 : 1, name: cursor ? "Original 26" : "Unshared original",
          mimeType: "application/vnd.google-apps.document", modifiedTime: null,
          openUrl: cursor ? "https://drive.google.com/file/d/original-26/view" : "https://drive.google.com/file/d/original-1/view",
          outcomes: [{ status: cursor ? "succeeded" : "skipped", reasonCode: cursor ? null : "source_not_shareable" }],
        }],
      }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent("Sharing incomplete");
      expect(screen.getByText("71 of 72 files available")).toBeVisible();
      expect(screen.getByText("108 file candidates · 72 selected for sharing")).toBeVisible();
      expect(screen.getByText("36 unavailable file candidates were not included.")).toBeVisible();
      expect(screen.getByText("1 not shared")).toBeVisible();
      expect(screen.getByText(/ask its owner or shared drive manager to check sharing permissions/i)).toBeVisible();
      expect(screen.getByText("Review the newly shared originals below. Remove any unintended access in Google Drive.")).toBeVisible();
      expect(screen.queryByText(/0 failed/)).toBeNull();
      expect(screen.getByText("Search finished; file contents and dates not checked.")).toBeVisible();
      expect(screen.getByText("Your files and shared drives · 540 Drive results scanned")).toBeVisible();
      expect(screen.getByText(/7 files in matching folders were excluded because their names did not match this request/)).toBeVisible();
      expect(screen.getByText(/Dates inside file contents were not checked/)).toBeVisible();
      expect(await screen.findByText("Unshared original")).toBeVisible();
      expect(screen.getAllByRole("link", { name: "Open in Google Drive" })[0]).toHaveAttribute(
        "href", "https://drive.google.com/file/d/original-1/view?authuser=a%40gmail.test",
      );
      fireEvent.click(screen.getByRole("button", { name: "Next 25" }));
      expect(await screen.findByText("Original 26")).toBeVisible();
      expect(screen.getByText("Shared")).toBeVisible();
    });

    it.each([
      ["running", "Sharing in progress", { total: 3, processed: 1, shared: 1, alreadyShared: 0,
        skipped: 0, failed: 0, needsReview: 0, unknown: 1, pending: 1 }, "1 waiting to share", "1 checking the outcome"],
      ["stopped", "Sharing stopped", { total: 3, processed: 3, shared: 0, alreadyShared: 0,
        skipped: 3, failed: 0, needsReview: 0, unknown: 0, pending: 0 }, "3 not shared", null],
      ["failed", "Sharing failed", { total: 3, processed: 3, shared: 0, alreadyShared: 0,
        skipped: 0, failed: 3, needsReview: 0, unknown: 0, pending: 0 }, "3 failed", null],
      ["partial", "Sharing incomplete", { total: 3, processed: 3, shared: 1, alreadyShared: 1,
        skipped: 0, failed: 0, needsReview: 1, unknown: 0, pending: 0 }, "1 needs review", null],
    ])("explains every outcome category for a %s share", async (status, label, counts, outcome, secondOutcome) => {
      state.status.mockResolvedValue({ ...initial(), status: status === "running" ? "approved" : "partial" });
      state.delivery.mockResolvedValue({ status: "partial", files: [], bulkShareId, fileCount: 3,
        sharedCount: counts.shared + counts.alreadyShared, counts });
      state.review.mockResolvedValue(partial({ durableAvailable: true,
        search: durableSearch({ status: "completed", matched: 3 }),
        bulkShare: durableBulk({ status, fileCount: 3, canApprove: false, counts,
          issues: status === "failed" ? [{ reasonCode: "permission_rejected", count: 3 }] : [] }),
      }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent(label);
      expect(screen.getByText(outcome)).toBeVisible();
      if (secondOutcome) expect(screen.getByText(secondOutcome)).toBeVisible();
      if (status === "failed") expect(screen.getByText(/Google Drive denied sharing/)).toBeVisible();
    });

    it.each([
      ["incoming", 0, 0, "Files shared · Request incomplete"],
      ["outgoing", 0, 0, "Files shared · Request incomplete"],
      ["incoming", 1, 0, "Sharing incomplete"],
      ["outgoing", 0, 1, "Checking file access"],
    ] as const)("distinguishes incomplete discovery from aggregate delivery (%s, %s, %s)", async (direction, failed, unknown, label) => {
      const confirmed = 20 - failed - unknown;
      const counts = { total: 20, processed: 20 - unknown, shared: confirmed - 7,
        alreadyShared: 7, skipped: 0, failed, needsReview: 0, unknown, pending: 0 };
      state.status.mockResolvedValue({ ...initial(), direction, status: "partial" });
      state.delivery.mockResolvedValue({ status: "partial", files: [], bulkShareId,
        fileCount: 20, sharedCount: confirmed, bulkStatus: "partial", counts });
      // The latest batch is complete even when an earlier batch failed.
      state.review.mockResolvedValue(partial({ durableAvailable: true,
        search: durableSearch({ status: "completed", matched: 20 }),
        bulkShare: durableBulk({ status: "completed", fileCount: 1, canApprove: false }),
      }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent(label);
      expect(screen.queryByText("Could not share all selected files")).toBeNull();
    });

    it("does not substitute the latest completed batch when aggregate counts are missing", async () => {
      state.status.mockResolvedValue({ ...initial(), status: "partial" });
      state.delivery.mockResolvedValue({ status: "partial", files: [], bulkShareId,
        fileCount: 20, sharedCount: 20, bulkStatus: "partial" });
      state.review.mockResolvedValue(partial({ durableAvailable: true,
        search: durableSearch({ status: "completed", matched: 20 }),
        bulkShare: durableBulk({ status: "completed", fileCount: 1, canApprove: false }),
      }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent("Review sharing and search results");
    });

    it.each(["partial", "running"])("tells B whether the final file is unavailable or still pending (%s)", async bulkStatus => {
      state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: bulkStatus === "running" ? "approved" : "partial" });
      state.delivery.mockResolvedValue({ status: bulkStatus === "running" ? "approved" : "partial", files: [], bulkShareId,
        fileCount: 72, sharedCount: 71, bulkStatus,
        counts: { total: 72, processed: bulkStatus === "running" ? 71 : 72, shared: 62, alreadyShared: 9,
          skipped: bulkStatus === "running" ? 0 : 1, failed: 0, needsReview: 0, unknown: 0,
          pending: bulkStatus === "running" ? 1 : 0 },
        issues: bulkStatus === "running" ? [] : [{ reasonCode: "source_not_shareable", count: 1 }],
      });
      state.deliveryFiles.mockResolvedValue({ files: [{ name: "Confirmed original", status: "succeeded",
        grantId: null, revocationStatus: null, managed: false, manageInGoogle: false,
        openUrl: "https://drive.google.com/file/d/confirmed/view" }], nextCursor: null });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("71 of 72 files available")).toBeVisible();
      expect(screen.getByText(bulkStatus === "running" ? "1 waiting to share" : "1 not shared")).toBeVisible();
      if (bulkStatus === "partial") {
        expect(screen.getByRole("status")).toHaveTextContent("Sharing incomplete");
        expect(screen.getByText("Only confirmed available files appear here.")).toBeVisible();
        expect(screen.getByText(/The owner's Google account lacks sharing permission/)).toBeVisible();
      }
      expect(await screen.findByText("Confirmed original")).toBeVisible();
      expect(screen.queryByText("Unshared original")).toBeNull();
      expect(screen.queryByText(/0 failed/)).toBeNull();
      if (bulkStatus === "running") expect(screen.getByRole("status")).toHaveTextContent("Sending files · 71 sent so far");
    });

    it("explains when an old undated relative request was stopped before sharing", async () => {
      state.status.mockResolvedValue({ ...initial(), status: "partial" });
      state.delivery.mockResolvedValue({ status: "partial", files: [], bulkShareId,
        fileCount: 1, sharedCount: 0 });
      state.review.mockResolvedValue(partial({ durableAvailable: true,
        search: durableSearch({ status: "completed", matched: 1 }),
        bulkShare: durableBulk({ status: "partial", fileCount: 1, canApprove: false,
          counts: { total: 1, processed: 1, shared: 0, alreadyShared: 0,
            skipped: 1, failed: 0, needsReview: 0, unknown: 0, pending: 0 },
          issues: [{ reasonCode: "date_range_required", count: 1 }] }),
      }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText(/This request needs exact dates/)).toBeVisible();
      expect(screen.getByText(/Make a new request with a start and end date/)).toBeVisible();
    });

    it.each(["pending", "unknown"])("keeps a stopped owner share current until its %s receipt settles", async outcome => {
      let settled = false;
      const counts = () => ({ total: 2, processed: settled ? 2 : 1, shared: settled ? 1 : 0, alreadyShared: 0,
        skipped: 1, failed: 0, needsReview: 0, unknown: !settled && outcome === "unknown" ? 1 : 0,
        pending: !settled && outcome === "pending" ? 1 : 0 });
      state.status.mockResolvedValue({ ...initial(), status: "approved" });
      state.delivery.mockImplementation(async () => ({ status: "approved", files: [], bulkShareId, fileCount: 2, sharedCount: settled ? 1 : 0 }));
      state.review.mockImplementation(async () => partial({ durableAvailable: true,
        search: durableSearch({ status: "completed", matched: 2 }),
        bulkShare: durableBulk({ status: "stopped", revision: settled ? 3 : 2, fileCount: 2, canApprove: false, counts: counts() }),
      }));
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText(outcome === "unknown" ? "1 checking the outcome" : "1 waiting to share")).toBeVisible();
      expect(state.periodic.mock.lastCall?.[3]).toMatchObject({ enabled: true });
      settled = true;
      await poll();
      expect(await screen.findByText("1 of 2 files available")).toBeVisible();
      expect(screen.queryByText(/1 checking the outcome|1 waiting to share/)).toBeNull();
      expect(state.periodic.mock.lastCall?.[3]).toMatchObject({ enabled: false });
      expect(state.approveBulkShare).not.toHaveBeenCalled();
      expect(state.retryBulkShare).not.toHaveBeenCalled();
    });

    it("keeps B checking a stopped approved request until a late confirmed link arrives", async () => {
      let settled = false;
      state.status.mockImplementation(async () => ({ ...initial(), direction: "outgoing", status: settled ? "partial" : "approved" }));
      state.delivery.mockImplementation(async () => ({ status: settled ? "partial" : "approved", files: [], bulkShareId,
        bulkStatus: "stopped", fileCount: 2, sharedCount: settled ? 1 : 0,
        counts: { total: 2, processed: settled ? 2 : 1, shared: settled ? 1 : 0, alreadyShared: 0,
          skipped: 1, failed: 0, needsReview: 0, unknown: settled ? 0 : 1, pending: 0 },
      }));
      state.deliveryFiles.mockResolvedValue({ files: [{ name: "Late confirmed original", status: "succeeded",
        grantId: null, revocationStatus: null, managed: false, manageInGoogle: false,
        openUrl: "https://drive.google.com/file/d/late-confirmed/view" }], nextCursor: null });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("1 checking the outcome")).toBeVisible();
      expect(state.periodic.mock.lastCall?.[3]).toMatchObject({ enabled: true });
      expect(state.deliveryFiles).not.toHaveBeenCalled();
      settled = true;
      await poll();
      expect(await screen.findByText("Late confirmed original")).toBeVisible();
      expect(screen.getByText("1 of 2 files available")).toBeVisible();
      expect(state.periodic.mock.lastCall?.[3]).toMatchObject({ enabled: false });
    });

    it("offers an explicit safe retry for only the unshared file in the locked selection", async () => {
      let retrying = false;
      const selected = durableBulk({ status: "partial", fileCount: 72, canApprove: false, canRetry: true, retryableCount: 1,
        counts: { total: 72, processed: 72, shared: 62, alreadyShared: 9, skipped: 1,
          failed: 0, needsReview: 0, unknown: 0, pending: 0 }, issues: [{ reasonCode: "provider_unavailable", count: 1 }] });
      state.status.mockImplementation(async () => ({ ...initial(), status: retrying ? "approved" : "partial" }));
      state.delivery.mockResolvedValue({ status: "partial", files: [], bulkShareId, fileCount: 72, sharedCount: 71 });
      state.review.mockImplementation(async () => partial({ durableAvailable: true,
        search: durableSearch({ status: "completed", matched: 108, unshareableCount: 36 }),
        bulkShare: retrying ? { ...selected, status: "queued", canRetry: false, retryableCount: 0,
          counts: { ...selected.counts, processed: 71, skipped: 0, pending: 1 } } : selected,
      }));
      state.retryBulkShare.mockImplementation(async () => { retrying = true; return {}; });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Retry 1 file" }));
      await waitFor(() => expect(state.retryBulkShare).toHaveBeenCalledWith("owner-a",
        expect.objectContaining({ shareId: bulkShareId, fileCount: 72, retryableCount: 1 }), expect.any(Function)));
      expect(await screen.findByText("1 waiting to share")).toBeVisible();
      expect(state.prepareRequestBulk).not.toHaveBeenCalled();
      expect(state.approveBulkShare).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Retry 1 file" })).toBeNull();
    });

    it("withholds candidate names from the requester until a verified grant exists", async () => {
      state.status.mockResolvedValue({ ...pending(), direction: "outgoing" });
      state.delivery.mockResolvedValue({ status: "pending", files: [] });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByRole("status")).toHaveTextContent("Request pending");
      expect(screen.queryByText(/Standup 1/)).toBeNull();
      expect(state.deliveryFiles).not.toHaveBeenCalled();
      state.status.mockResolvedValue({ ...initial(), direction: "outgoing", status: "approved" });
      state.delivery.mockResolvedValue({ status: "approved", files: [], bulkShareId,
        fileCount: 525, sharedCount: 0 });
      await poll();
      expect(screen.getByText("Files appear as sharing finishes.")).toBeVisible();
      expect(state.deliveryFiles).not.toHaveBeenCalled();
      state.delivery.mockResolvedValue({ status: "approved", files: [], bulkShareId,
        fileCount: 525, sharedCount: 1 });
      state.deliveryFiles.mockResolvedValue({ files: [{ name: "Standup 1", status: "succeeded",
        grantId: "grant-1", revocationStatus: null, managed: false, manageInGoogle: false,
        openUrl: "https://drive.google.com/file/d/file-1/view" }], nextCursor: null });
      await poll();
      expect(await screen.findByText("Standup 1")).toBeVisible();
      expect(state.deliveryFiles).toHaveBeenCalledOnce();
    });

    it("shows unshareable matches, excludes them, and blocks a review with no shareable files", async () => {
      state.status.mockResolvedValue(pending());
      state.review.mockResolvedValue(partial({ durableAvailable: true,
        search: durableSearch({ status: "completed", matched: 2, unshareableCount: 2 }), bulkShare: null }));
      state.requestSearchFiles.mockResolvedValue({ jobId: searchJobId, revision: 4, matched: 2,
        files: [1, 2].map(position => ({ ...searchFile(position), shareable: false,
          unavailableReason: position === 1 ? "source_not_shareable" : "shareability_unverified" })), nextCursor: null });
      render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
      expect(await screen.findByText("Standup 1")).toBeVisible();
      expect(screen.getByText("2 files have no confirmed sharing permission and won't be included.")).toBeVisible();
      expect(screen.getByText("Your Google account cannot share this file")).toBeVisible();
      expect(screen.getByText("Sharing permission could not be verified")).toBeVisible();
      expect(screen.getByRole("checkbox", { name: "Standup 1" })).toBeDisabled();
      expect(screen.getByRole("checkbox", { name: "Standup 2" })).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Review 0 files" })).toBeDisabled();
      expect(state.prepareRequestBulk).not.toHaveBeenCalled();
    });
  });

  it("reads out every consequence of standing trust", async () => {
    state.review.mockResolvedValue({ ...review(), canTrustFutureRequests: true });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    const trust = await screen.findByRole("checkbox", {
      name: "Trust b@example.invalid for future requests",
    });
    expect(trust).toHaveAccessibleDescription(/including future files, without asking/);
    expect(trust).toHaveAccessibleDescription(/while you’re away/);
    expect(trust).toHaveAccessibleDescription(/stop future sharing anytime/);
    expect(document.body.textContent).not.toMatch(/\bOne\b/);
  });

  it("names access outside the private agent without saying One", async () => {
    state.status.mockResolvedValue({ ...initial(), status: "completed" });
    state.delivery.mockResolvedValue({
      ...delivery(),
      files: [{ ...delivery().files[0], status: "present_unattributed" }],
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    expect(
      await screen.findByText("Access exists outside your private agent"),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Disconnecting Drive doesn't remove Google access. Other access may remain after removal.",
      ),
    ).toBeVisible();
    expect(document.body.textContent).not.toMatch(/\bOne\b/);
  });

  it("disables Cancel while a removal is being sent", async () => {
    state.status.mockResolvedValue({ ...initial(), status: "completed" });
    state.prepareRevocation.mockResolvedValue({
      revision: 4,
      directiveId: "d",
      reviewDigest: "b".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      files: [
        { grantId: "grant", name: "Approved.pdf", recipientEmail: "b@example.invalid" },
      ],
    });
    render(<DocumentShareReview requestId={requestId} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review removal" }));
    const remove = await screen.findByRole("button", { name: "Stop access" });
    state.revoke.mockReturnValueOnce(new Promise(() => undefined));
    fireEvent.click(remove);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled(),
    );
  });
});
