import { afterEach, describe, expect, it, vi } from "vitest";
import { shareFile } from "@/lib/share/share-file";
import { Capacitor } from "@capacitor/core";
import { downloadBlobFile } from "@/lib/utils/native-download";
import { Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { nativeDrawers } from "@/lib/capacitor/native-drawers";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";

vi.mock("@/lib/capacitor/native-drawers", () => ({ nativeDrawers: vi.fn(() => ({ shareWorkspaceFile: vi.fn(async () => undefined) })) }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: vi.fn(() => false) } }));
vi.mock("@capacitor/filesystem", () => ({ Directory: { Cache: "CACHE" }, Filesystem: { writeFile: vi.fn(async () => ({ uri: "file://card.png" })), deleteFile: vi.fn(async () => undefined), rmdir: vi.fn(async () => undefined) } }));
vi.mock("@capacitor/share", () => ({ Share: { share: vi.fn(async () => ({})) } }));
vi.mock("@/lib/utils/native-download", () => ({ downloadBlobFile: vi.fn(async () => true), blobToBase64String: vi.fn(async () => "image") }));
const file = new File(["png"], "agent-one-profile.png", { type: "image/png" });
function web(share = vi.fn(async () => undefined), supports = true) {
  Object.defineProperties(navigator, {
    share: { configurable: true, value: share },
    canShare: { configurable: true, value: () => supports },
  });
  return share;
}
afterEach(() => { vi.clearAllMocks(); vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false); });

describe("card file delivery", () => {
  it("uses the same temporary owned handoff for readable text without retaining a Documents copy", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const { downloadTextFile } = await vi.importActual<typeof import("@/lib/utils/native-download")>("@/lib/utils/native-download");
    vi.mocked(Share.share).mockRejectedValueOnce(new Error("Share canceled"));
    await expect(downloadTextFile("Synthetic private information", "memory.json")).resolves.toBe(false);
    expect(Filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({ directory: "CACHE" }));
    expect(Filesystem.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ directory: "CACHE" }));
    expect(downloadBlobFile).not.toHaveBeenCalled();
  });
  it("keeps peer filenames inside one native cache leaf and fences a late share after owner loss", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const traversal = new File(["file"], "../../other\\file.pdf", { type: "application/pdf" });
    let current = true;
    vi.mocked(Filesystem.writeFile).mockImplementationOnce(async () => { current = false; return { uri: "file://fixture.pdf" }; });
    await expect(shareFile({ file: traversal, title: "File", isEffectCurrent: () => current })).rejects.toMatchObject({ name: "AbortError" });
    const path = vi.mocked(Filesystem.writeFile).mock.calls[0]![0].path;
    expect(path.split("/")).toHaveLength(3);
    expect(path.split("/").at(-1)).not.toMatch(/^[.]|[\\/]/);
    expect(Share.share).not.toHaveBeenCalled();
    expect(Filesystem.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ path }));
    expect(Filesystem.rmdir).toHaveBeenCalledWith({ path: path.split("/").slice(0, 2).join("/"), directory: "CACHE" });
  });
  it("removes an empty temporary directory even when the native write fails", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Filesystem.writeFile).mockRejectedValueOnce(new Error("write failed"));
    await expect(shareFile({ file, title: "Profile" })).rejects.toThrow("write failed");
    expect(Filesystem.rmdir).toHaveBeenCalledWith(expect.objectContaining({ directory: "CACHE" }));
    expect(Share.share).not.toHaveBeenCalled();
  });
  it("calls Web Share synchronously with the actual PNG file to retain click activation", async () => {
    const handler = web();
    const result = shareFile({ file, title: "Profile" });
    expect(handler).toHaveBeenCalledWith({ title: "Profile", files: [file] });
    await expect(result).resolves.toBe("web-share");
    expect(downloadBlobFile).not.toHaveBeenCalled();
  });
  it("downloads the same PNG where file sharing is unavailable, never a link substitute", async () => {
    const handler = web(vi.fn(), false);
    await expect(shareFile({ file, title: "Profile" })).resolves.toBe("download");
    expect(handler).not.toHaveBeenCalled();
    expect(downloadBlobFile).toHaveBeenCalledWith(file, file.name, "image/png");
  });
  it("respects dismissal without triggering a download", async () => {
    const cancelled = new DOMException("Dismissed", "AbortError");
    web(vi.fn().mockRejectedValue(cancelled));
    await expect(shareFile({ file, title: "Profile" })).rejects.toBe(cancelled);
    expect(downloadBlobFile).not.toHaveBeenCalled();
  });
  it("uses the confirmed Wallet owner for native sharing and cleans up on cancellation", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const handoff = vi.fn().mockRejectedValue(new Error("Share canceled"));
    vi.mocked(nativeDrawers).mockReturnValueOnce({ shareWorkspaceFile: handoff } as ReturnType<typeof nativeDrawers>);
    const choice: NativeWorkspaceChoice = { documentId: "document", ownerEpoch: "owner", ownerGeneration: 1, revision: 1,
      workspace: "wallet", privacyGeneration: 1, updateSequence: 1, sequence: 1, action: "row",
      rowId: "share", domain: "wallet-detail", detailVisitId: "visit", dismissed: false };
    await expect(shareFile({ file, title: "Profile", workspaceChoice: choice })).rejects.toThrow("Share canceled");
    expect(handoff).toHaveBeenCalledWith({ ...choice, fileUri: "file://card.png", title: "Profile" });
    expect(Share.share).not.toHaveBeenCalled();
    expect(Filesystem.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ directory: "CACHE" }));
  });
  it("cleans up the temporary native file after a dismissed share", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Share.share).mockRejectedValueOnce(new Error("Share canceled"));
    await expect(shareFile({ file, title: "Profile" })).rejects.toThrow("Share canceled");
    expect(Filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({ directory: "CACHE" }));
    expect(Filesystem.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ directory: "CACHE" }));
    expect(downloadBlobFile).not.toHaveBeenCalled();
  });
});
