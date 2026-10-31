import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => true),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  share: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: mocks.isNativePlatform } }));
vi.mock("@capacitor/filesystem", () => ({
  Filesystem: { writeFile: mocks.writeFile, deleteFile: mocks.deleteFile },
  Directory: { Cache: "CACHE" },
  Encoding: { UTF8: "utf8" },
}));
vi.mock("@capacitor/share", () => ({ Share: { share: mocks.share } }));
vi.mock("sonner", () => ({ toast: { error: mocks.error, success: mocks.success } }));

import { exportPrivateDriveMarkdown } from "@/lib/utils/private-markdown-export";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isNativePlatform.mockReturnValue(true);
  mocks.writeFile.mockResolvedValue({ uri: "file:///private.md" });
  mocks.deleteFile.mockResolvedValue(undefined);
  mocks.share.mockResolvedValue(undefined);
});

describe("private owner Markdown export", () => {
  it("shares from app cache and deletes the private file after the share settles", async () => {
    const markdown = "# Secret original notes";
    expect(await exportPrivateDriveMarkdown(markdown, "drive-notes-2026-09-26.md")).toBe(true);
    const write = mocks.writeFile.mock.calls[0]![0];
    expect(write).toMatchObject({ data: markdown, directory: "CACHE", encoding: "utf8" });
    expect(write.path).toMatch(/^[a-f0-9-]+-drive-notes-2026-09-26\.md$/);
    expect(mocks.share).toHaveBeenCalledWith({
      title: "drive-notes-2026-09-26.md", files: ["file:///private.md"],
      dialogTitle: "Save your notes",
    });
    expect(mocks.deleteFile).toHaveBeenCalledWith({ path: write.path, directory: "CACHE" });
    expect(mocks.share.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteFile.mock.invocationCallOrder[0]!,
    );
  });

  it("deletes the private file when the share sheet is canceled", async () => {
    mocks.share.mockRejectedValue(new Error("canceled"));
    expect(await exportPrivateDriveMarkdown("private", "drive-notes-2026-09-26.md")).toBe(false);
    expect(mocks.deleteFile).toHaveBeenCalledOnce();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("reports cleanup failure without claiming a private download succeeded", async () => {
    mocks.deleteFile.mockRejectedValue(new Error("disk error"));
    expect(await exportPrivateDriveMarkdown("private", "drive-notes-2026-09-26.md")).toBe(false);
    expect(mocks.error).toHaveBeenCalledWith(
      "A temporary copy of the notes could not be removed from app cache.",
    );
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
