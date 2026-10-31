import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ open: vi.fn(), artifact: vi.fn(), verify: vi.fn(), package: vi.fn(), activity: vi.fn(), download: vi.fn(), loadPdf: vi.fn(), renderPdf: vi.fn(), current: true, copyStatus: vi.fn(), copyContent: vi.fn(), copyActivity: vi.fn(), copyRevoke: vi.fn(), native: false, share: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/one/documents/open" }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => state.native } }));
vi.mock("@/lib/navigation/back-layers", () => ({ useBackLayer: vi.fn() }));
vi.mock("@/lib/capacitor/native-navigation", () => ({ useNativeNavigationOverlayRef: (ref: unknown) => ref }));
vi.mock("@/lib/services/document-hosting-service", () => ({ DocumentHostingService: { package: state.package, activity: state.activity }, protectedDocumentUrl: () => null, requireDocumentSession: (session: { isCurrent(): boolean }, signal?: AbortSignal) => { signal?.throwIfAborted(); if (!session.isCurrent()) throw new DOMException("changed", "AbortError"); } }));
vi.mock("@/lib/consent/document-hosting-open", () => ({ openHostedDocuments: state.open, openHostedArtifact: state.artifact, verifyHostedPackage: state.verify, hostedDocumentContentHash: () => "hash" }));
vi.mock("@/lib/consent/document-hosting-crypto", () => ({ documentHash: async () => "hash" }));
vi.mock("@/lib/consent/document-hosting-pdf", () => ({ loadHostedPdf: state.loadPdf, renderHostedPdfPage: state.renderPdf }));
vi.mock("@/lib/utils/native-download", () => ({ downloadFileBlob: state.download }));
vi.mock("@/lib/share/share-file", () => ({ shareFile: state.share }));
vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({ OneKycClientZkService: {} }));
vi.mock("@/lib/consent/document-hosting-preparation", () => ({ verifyHostedRecipientKey: vi.fn() }));
vi.mock("@/lib/services/one-copy-service", () => ({ OneCopyService: { status: state.copyStatus, content: state.copyContent, activity: state.copyActivity, revoke: state.copyRevoke }, backgroundDocumentUrl: () => null }));
vi.mock("@/components/consent/use-hosted-document-session", () => ({ useHostedDocumentSession: () => null }));
import { CacheService } from "@/lib/services/cache-service";
import { BackgroundDocumentActivity } from "@/components/consent/background-document-activity";
import { BackgroundDocumentFilesBody } from "@/components/consent/background-document-files";
import { HostedDocumentReader } from "@/components/consent/hosted-document-reader";
import { HostedPdfCanvas } from "@/components/consent/hosted-pdf-canvas";
const session = { userId: "b", vaultKey: "vault", vaultOwnerToken: "token", isCurrent: () => state.current };
const value = () => ({ package: { accessExpiresAt: new Date(Date.now() + 3000).toISOString(), packageDigest: "digest", interactionId: "interaction", artifacts: [{ artifactId: "original" }, { artifactId: "preview" }] }, manifest: { version: 1, files: [{ fileRef: "ref", name: "Private.pdf", sourceRevision: "v1", originalArtifactId: "original", watermarkedArtifactId: "preview" }] } });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
beforeEach(() => { CacheService.getInstance().clear(); vi.useFakeTimers(); vi.clearAllMocks(); state.current = true; state.native = false; state.open.mockResolvedValue(value()); state.verify.mockResolvedValue(undefined); state.package.mockResolvedValue(value().package); state.activity.mockResolvedValue({}); state.artifact.mockResolvedValue(new Uint8Array([1, 2, 3])); state.download.mockResolvedValue(true); state.loadPdf.mockResolvedValue({ numPages: 1, loadingTask: { destroy: vi.fn() } }); state.renderPdf.mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("protected reader entitlement and memory", () => {
  it("never downloads on preview, erases preview bytes and names at expiry, and cannot reopen expired information", async () => {
    const bytes = new Uint8Array([1, 2, 3]); state.artifact.mockResolvedValue(bytes);
    render(<HostedDocumentReader session={session} requestId="request" />); await flush();
    fireEvent.click(screen.getByRole("button", { name: "Preview", exact: true })); await flush();
    expect(screen.getByRole("region", { name: "Document preview" })).toBeInTheDocument(); expect(state.download).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(bytes).toEqual(new Uint8Array(3)); expect(screen.queryByText("Private.pdf")).not.toBeInTheDocument(); expect(screen.queryByRole("region", { name: "Document preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download original" })).not.toBeInTheDocument();
  });
  it("rejects a late decrypted response after the vault session changes, without a browser download", async () => {
    let release!: (bytes: Uint8Array) => void; state.artifact.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    render(<HostedDocumentReader session={session} requestId="request" />); await flush();
    fireEvent.click(screen.getByRole("button", { name: "Download original" })); await flush();
    state.current = false; const bytes = new Uint8Array([4, 5]); await act(async () => { release(bytes); });
    expect(bytes).toEqual(new Uint8Array(2)); expect(state.download).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1000); }); expect(screen.queryByText("Private.pdf")).not.toBeInTheDocument();
  });
  it("clears decrypted presentation when a focus recheck rejects or changes the package", async () => {
    render(<HostedDocumentReader session={session} requestId="request" />); await flush();
    state.package.mockResolvedValue({ ...value().package, packageDigest: "changed" });
    fireEvent.focus(window); await flush(); expect(screen.queryByText("Private.pdf")).not.toBeInTheDocument(); expect(screen.getByRole("alert")).toHaveTextContent("Access ended");
  });
});

const background = (mimeType = "application/pdf", previewAvailable = true) => ({ requestId: "request", actorRole: "recipient", status: "ready", files: [{ fileRef: "file", name: "Original.file", mimeType, status: "ready", previewAvailable, sha256: "hash" }] });
describe("background One copies in the existing file flow", () => {
  beforeEach(() => { state.copyStatus.mockResolvedValue(background()); state.copyContent.mockResolvedValue(new Uint8Array([1, 2, 3])); });
  it("previews only after click, never downloads on preview, and clears bytes on Back", async () => {
    const bytes = new Uint8Array([1, 2, 3]); state.copyContent.mockResolvedValue(bytes);
    render(<BackgroundDocumentFilesBody session={session} requestId="request" />); await flush();
    expect(state.copyContent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Preview", exact: true })); await flush();
    expect(state.copyContent).toHaveBeenCalledWith(session, "request", "file", "preview", expect.any(AbortSignal), expect.any(Number));
    expect(screen.getByRole("region", { name: "Document preview" })).toBeVisible();
    expect(state.download).not.toHaveBeenCalled();
    expect(screen.getByText(/Shared in One · Access request/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    expect(bytes).toEqual(new Uint8Array(3));
    expect(screen.queryByRole("region", { name: "Document preview" })).not.toBeInTheDocument();
  });
  it("renders warm file metadata immediately and refuses a revoked live read before preview", async () => {
    const first = render(<BackgroundDocumentFilesBody session={session} requestId="request" />); await flush(); first.unmount();
    state.copyStatus.mockClear();
    render(<BackgroundDocumentFilesBody session={session} requestId="request" />);
    expect(screen.getByText("Original.file")).toBeVisible();
    expect(screen.queryByText("Checking One copy…")).not.toBeInTheDocument();
    await flush(); expect(state.copyStatus).not.toHaveBeenCalled();
    const bytes = new Uint8Array([1, 2, 3]); state.copyContent.mockResolvedValue(bytes);
    state.copyStatus.mockResolvedValue({ requestId: "request", actorRole: "recipient", status: "revoked", files: [] });
    fireEvent.click(screen.getByRole("button", { name: "Preview", exact: true })); await flush();
    expect(state.copyContent).toHaveBeenCalledOnce(); expect(state.copyStatus).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "Document preview" })).not.toBeInTheDocument();
    expect(state.download).not.toHaveBeenCalled(); expect(bytes).toEqual(new Uint8Array(3));
  });
  it.each(["owner", "recipient"])("uses authenticated %s role for direct-link management, ignoring a contrary Feed hint", async actorRole => {
    state.copyStatus.mockResolvedValue({ ...background(), actorRole });
    render(<BackgroundDocumentFilesBody session={session} requestId="request" owner={actorRole === "recipient"} />); await flush();
    expect(Boolean(screen.queryByRole("button", { name: "Stop One access" }))).toBe(actorRole === "owner");
    expect(Boolean(screen.queryByRole("button", { name: "Activity", exact: true }))).toBe(actorRole === "owner");
    if (actorRole === "owner") {
      const access = screen.getByRole("region", { name: "Document access" });
      expect(within(access).getByRole("button", { name: "Stop One access" })).toBeVisible();
      expect(within(access).getByRole("button", { name: "Activity", exact: true })).toBeVisible();
    }
  });
  it("requires the authored confirmation and cancels through Back without revoking", async () => {
    const { useBackLayer } = await import("@/lib/navigation/back-layers");
    state.copyStatus.mockResolvedValue({ ...background(), actorRole: "owner" });
    render(<BackgroundDocumentFilesBody session={session} requestId="request" owner />); await flush();
    fireEvent.click(screen.getByRole("button", { name: "Stop One access" })); await flush();
    expect(screen.getByRole("alertdialog", { name: "Stop One access?" })).toBeVisible();
    expect(state.copyRevoke).not.toHaveBeenCalled();
    const layer = vi.mocked(useBackLayer).mock.calls.findLast(call => call[1] === 4);
    expect(layer).toBeDefined(); act(() => { layer![2](); }); await flush();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(state.copyRevoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop One access" })); await flush();
    fireEvent.click(screen.getByRole("button", { name: "Stop access", exact: true })); await flush();
    expect(state.copyRevoke).toHaveBeenCalledWith(session, "request", expect.any(AbortSignal));
  });
  it("downloads an unsupported original with its MIME and never embeds active content", async () => {
    state.copyStatus.mockResolvedValue(background("text/html", true));
    const bytes = new Uint8Array([60, 104, 116, 109, 108, 62]); state.copyContent.mockResolvedValue(bytes);
    const { container } = render(<BackgroundDocumentFilesBody session={session} requestId="request" />); await flush();
    expect(screen.queryByRole("button", { name: "Preview", exact: true })).not.toBeInTheDocument();
    expect(container.querySelector("iframe,object,embed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download", exact: true })); await flush();
    expect(state.copyContent).toHaveBeenCalledWith(session, "request", "file", "download", expect.any(AbortSignal), expect.any(Number));
    expect(state.download).toHaveBeenCalledWith(expect.objectContaining({ type: "text/html" }), "Original.file", expect.any(Function));
    expect(bytes).toEqual(new Uint8Array(6));
  });
  it("labels a Google export and saves the advertised rendition without converting bytes", async () => {
    const copy = background("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", false);
    const bytes = new Uint8Array([80, 75, 3, 4]);
    state.copyStatus.mockResolvedValue({ ...copy, files: [{ ...copy.files[0], name: "Ledger.xlsx", rendition: "google_export", exportFormat: "XLSX" }] });
    state.copyContent.mockResolvedValue(bytes);
    render(<BackgroundDocumentFilesBody session={session} requestId="request" />); await flush();
    expect(screen.getByText("Google export · XLSX")).toBeVisible();
    expect(screen.getByText("Preview unavailable. Download the export.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Download", exact: true })); await flush();
    expect(state.download).toHaveBeenCalledWith(expect.objectContaining({ type: copy.files[0].mimeType }), "Ledger.xlsx", expect.any(Function));
    expect(bytes).toEqual(new Uint8Array(4));
  });
  it("refuses late bytes after signout and clears file presentation", async () => {
    let release!: (bytes: Uint8Array) => void; state.copyContent.mockImplementation(() => new Promise(done => { release = done; }));
    render(<BackgroundDocumentFilesBody session={session} requestId="request" />); await flush();
    fireEvent.click(screen.getByRole("button", { name: "Download", exact: true })); await flush();
    state.current = false; const bytes = new Uint8Array([4, 5]);
    await act(async () => release(bytes));
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(bytes).toEqual(new Uint8Array(2)); expect(state.download).not.toHaveBeenCalled();
    expect(screen.queryByText("Original.file")).not.toBeInTheDocument();
  });
  it("bounds the final entitlement read before revealing bytes or handing off a file", async () => {
    const bytes = new Uint8Array([1, 2, 3]); state.copyContent.mockResolvedValue(bytes);
    state.copyStatus.mockImplementation((_session, _requestId, _signal, deadline) => deadline ? new Promise(() => undefined) : Promise.resolve(background()));
    render(<BackgroundDocumentFilesBody session={session} requestId="request" />); await flush();
    fireEvent.click(screen.getByRole("button", { name: "Download", exact: true })); await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_001); }); await flush();
    expect(screen.getByText("File took too long. Try again.")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Document preview" })).not.toBeInTheDocument();
    expect(state.download).not.toHaveBeenCalled(); expect(state.share).not.toHaveBeenCalled();
    expect(bytes).toEqual(new Uint8Array(3));
  });
  it("uses native file handoff without claiming that a cancelled save completed", async () => {
    state.native = true; let rejectShare!: (error: Error) => void;
    state.share.mockImplementation(() => new Promise((_, reject) => { rejectShare = reject; }));
    state.copyStatus.mockResolvedValue(background("application/vnd.openxmlformats-officedocument.wordprocessingml.document", false));
    render(<BackgroundDocumentFilesBody session={session} requestId="request" />); await flush();
    fireEvent.click(screen.getByRole("button", { name: "Download", exact: true })); await flush();
    expect(state.share).toHaveBeenCalled(); expect(state.download).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_001); }); await flush();
    expect(screen.queryByText("File took too long. Try again.")).not.toBeInTheDocument();
    expect(state.share.mock.calls[0][0].isEffectCurrent()).toBe(true);
    await act(async () => rejectShare(new Error("synthetic cancellation"))); await flush();
    expect(screen.queryByText("Handed to system.")).not.toBeInTheDocument();
  });
});

describe("protected PDF page navigation and cleanup", () => {
  it("parses once across page changes and destroys the document when access ends", async () => {
    const destroy = vi.fn();
    const pdf = { numPages: 3, loadingTask: { destroy } };
    state.loadPdf.mockResolvedValue(pdf);
    const controller = new AbortController();
    const rendered = vi.fn();
    const view = render(<HostedPdfCanvas bytes={new Uint8Array([1])} signal={controller.signal} onRendered={rendered} />);
    await flush(); await flush();
    expect(state.loadPdf).toHaveBeenCalledOnce();
    expect(state.renderPdf).toHaveBeenLastCalledWith(pdf, 1, expect.any(HTMLCanvasElement), expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Next page" })); await flush(); await flush();
    expect(state.loadPdf).toHaveBeenCalledOnce();
    expect(state.renderPdf).toHaveBeenLastCalledWith(pdf, 2, expect.any(HTMLCanvasElement), expect.any(AbortSignal));
    expect(destroy).not.toHaveBeenCalled();
    screen.getByLabelText("Document preview, page 2").setAttribute("width", "100");
    state.renderPdf.mockRejectedValueOnce(new Error("synthetic page failure"));
    fireEvent.click(screen.getByRole("button", { name: "Next page" })); await flush(); await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Preview unavailable");
    expect(screen.getByLabelText("Document preview, page 3")).toHaveAttribute("width", "0");
    expect(rendered).toHaveBeenCalledTimes(2);
    act(() => controller.abort());
    expect(destroy).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Document preview, page 3")).toHaveAttribute("width", "0");
    view.unmount(); expect(destroy).toHaveBeenCalledOnce();
  });

  it("destroys a late load after unmount without rendering or reporting completion", async () => {
    let release!: (pdf: unknown) => void;
    const destroy = vi.fn(); const rendered = vi.fn();
    state.loadPdf.mockImplementation(() => new Promise(done => { release = done; }));
    const view = render(<HostedPdfCanvas bytes={new Uint8Array([1])} signal={new AbortController().signal} onRendered={rendered} />);
    view.unmount();
    await act(async () => release({ numPages: 2, loadingTask: { destroy } }));
    expect(destroy).toHaveBeenCalledOnce();
    expect(state.renderPdf).not.toHaveBeenCalled();
    expect(rendered).not.toHaveBeenCalled();
  });
});

describe("owner One-copy activity", () => {
  const event = (eventId: string, kind = "preview_requested") => ({ eventId, fileRef: null, kind, createdAt: "2026-10-27T00:00:00Z", country: null, actorRole: "recipient" });
  it("loads only when expanded, preserves server pagination, and refreshes new activity without claiming display or saving", async () => {
    state.copyActivity.mockResolvedValueOnce({ items: [event("first")], nextCursor: "older-cursor" })
      .mockResolvedValueOnce({ items: [event("second", "download_requested")], nextCursor: null })
      .mockResolvedValueOnce({ items: [event("newest", "stream_completed")], nextCursor: null });
    render(<BackgroundDocumentActivity session={session} requestId="request" />); await flush();
    expect(state.copyActivity).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Activity", exact: true })); await flush();
    expect(screen.getByText("Recipient · Preview requested")).toBeVisible();
    expect(screen.queryByText(/Approximate country/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More activity" })); await flush();
    expect(state.copyActivity).toHaveBeenLastCalledWith(expect.objectContaining({ userId: session.userId }), "request", expect.any(AbortSignal), "older-cursor");
    expect(screen.getByText("Recipient · Download requested")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" })); await flush();
    expect(screen.getByText("Recipient · Transfer completed")).toBeVisible();
    expect(screen.queryByText("Recipient · Preview requested")).not.toBeInTheDocument();
    expect(screen.queryByText(/saved|viewed|displayed/i)).not.toBeInTheDocument();
  });
  it("discards an activity page returned after the owner session ends", async () => {
    let release!: (page: unknown) => void; state.copyActivity.mockImplementation(() => new Promise(done => { release = done; }));
    render(<BackgroundDocumentActivity session={session} requestId="request" />);
    fireEvent.click(screen.getByRole("button", { name: "Activity", exact: true })); await flush();
    state.current = false; await act(async () => release({ items: [event("late")], nextCursor: null }));
    expect(screen.queryByText("Recipient · Preview requested")).not.toBeInTheDocument();
  });
});
