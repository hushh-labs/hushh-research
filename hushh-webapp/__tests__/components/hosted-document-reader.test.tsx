import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ open: vi.fn(), artifact: vi.fn(), verify: vi.fn(), package: vi.fn(), activity: vi.fn(), download: vi.fn(), loadPdf: vi.fn(), renderPdf: vi.fn(), current: true }));
vi.mock("next/navigation", () => ({ usePathname: () => "/one/documents/open" }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@/lib/navigation/back-layers", () => ({ useBackLayer: vi.fn() }));
vi.mock("@/lib/services/document-hosting-service", () => ({ DocumentHostingService: { package: state.package, activity: state.activity }, protectedDocumentUrl: () => null, requireDocumentSession: (session: { isCurrent(): boolean }, signal?: AbortSignal) => { signal?.throwIfAborted(); if (!session.isCurrent()) throw new DOMException("changed", "AbortError"); } }));
vi.mock("@/lib/consent/document-hosting-open", () => ({ openHostedDocuments: state.open, openHostedArtifact: state.artifact, verifyHostedPackage: state.verify, hostedDocumentContentHash: () => "hash" }));
vi.mock("@/lib/consent/document-hosting-crypto", () => ({ documentHash: async () => "hash" }));
vi.mock("@/lib/consent/document-hosting-pdf", () => ({ loadHostedPdf: state.loadPdf, renderHostedPdfPage: state.renderPdf }));
vi.mock("@/lib/utils/native-download", () => ({ downloadFileBlob: state.download }));
vi.mock("@/lib/share/share-file", () => ({ shareFile: vi.fn() }));
vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({ OneKycClientZkService: {} }));
vi.mock("@/lib/consent/document-hosting-preparation", () => ({ verifyHostedRecipientKey: vi.fn() }));
import { HostedDocumentReader } from "@/components/consent/hosted-document-reader";
const session = { userId: "b", vaultKey: "vault", vaultOwnerToken: "token", isCurrent: () => state.current };
const value = () => ({ package: { accessExpiresAt: new Date(Date.now() + 3000).toISOString(), packageDigest: "digest", interactionId: "interaction", artifacts: [{ artifactId: "original" }, { artifactId: "preview" }] }, manifest: { version: 1, files: [{ fileRef: "ref", name: "Private.pdf", sourceRevision: "v1", originalArtifactId: "original", watermarkedArtifactId: "preview" }] } });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); state.current = true; state.open.mockResolvedValue(value()); state.verify.mockResolvedValue(undefined); state.package.mockResolvedValue(value().package); state.activity.mockResolvedValue({}); state.artifact.mockResolvedValue(new Uint8Array([1, 2, 3])); state.download.mockResolvedValue(true); state.loadPdf.mockResolvedValue({ numPages: 1, loadingTask: { destroy: vi.fn() } }); state.renderPdf.mockResolvedValue(undefined); });
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
