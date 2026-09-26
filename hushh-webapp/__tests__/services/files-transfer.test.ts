import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-service", () => ({ ApiService: { ownerPodRequest: request } }));
import { DownloadPaused, FilesService, type FileEntry } from "@/lib/files/service";

function hash(chunks: Uint8Array[]) {
  let chain = Buffer.alloc(32);
  for (const chunk of chunks) {
    chain = createHash("sha256").update(Buffer.concat([chain, createHash("sha256").update(chunk).digest()])).digest();
  }
  return chain.toString("hex");
}
function entry(chunks: Uint8Array[]): FileEntry {
  const size = chunks.reduce((total, bytes) => total + bytes.length, 0);
  return { id: "file", name: "example.txt", originalName: "example.txt", parent: "root", kind: "file",
    size, received: size, receivedHash: hash(chunks), state: "ready", revision: 2 };
}
function disk() {
  let saved = new Uint8Array();
  const handle = {
    getFile: async () => ({ size: saved.length, slice: (start: number, end: number) => ({ arrayBuffer: async () => saved.slice(start, end).buffer }) }) as File,
    createWritable: async ({ keepExistingData }: { keepExistingData: boolean }) => {
      let pending = keepExistingData ? saved.slice() : new Uint8Array();
      let offset = 0;
      return {
        write: async (bytes: Uint8Array) => { const next = new Uint8Array(offset + bytes.length); next.set(pending.subarray(0, offset)); next.set(bytes, offset); pending = next; offset += bytes.length; },
        seek: async (value: number) => { offset = value; },
        close: async () => { saved = pending; },
        abort: async () => undefined,
      };
    },
  };
  vi.stubGlobal("showSaveFilePicker", vi.fn(async () => handle));
  return { corrupt: () => { saved[0] ^= 1; }, bytes: () => saved };
}
afterEach(() => { request.mockReset(); vi.unstubAllGlobals(); });

describe("private Files downloads", () => {
  it("resumes only missing chunks and verifies the saved prefix and complete file", async () => {
    const chunks = [new Uint8Array(4 * 1024 * 1024).fill(7), new Uint8Array([1, 2, 3])];
    const target = disk();
    request.mockResolvedValueOnce(new Response(chunks[0])).mockRejectedValueOnce(new TypeError("offline"));
    let paused: DownloadPaused | undefined;
    try { await FilesService.download(entry(chunks), new AbortController().signal); }
    catch (error) { expect(error).toBeInstanceOf(DownloadPaused); paused = error as DownloadPaused; }
    expect(paused?.checkpoint.offset).toBe(chunks[0].length);
    request.mockResolvedValueOnce(new Response(chunks[1]));
    await FilesService.download(entry(chunks), new AbortController().signal, paused!.checkpoint);
    expect(request.mock.calls[2][0]).toContain("index=1");
    expect(target.bytes().length).toBe(chunks[0].length + 3);
    expect(target.bytes().slice(-3)).toEqual(chunks[1]);
  });

  it("refuses a changed local partial file before another network read", async () => {
    const chunks = [new Uint8Array(4 * 1024 * 1024).fill(7), new Uint8Array([1])];
    const target = disk();
    request.mockResolvedValueOnce(new Response(chunks[0])).mockRejectedValueOnce(new TypeError("offline"));
    const paused = await FilesService.download(entry(chunks), new AbortController().signal).catch(error => error as DownloadPaused);
    target.corrupt();
    await expect(FilesService.download(entry(chunks), new AbortController().signal, paused.checkpoint)).rejects.toThrow("partial download changed");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not commit content whose immutable digest fails", async () => {
    const target = disk();
    request.mockResolvedValueOnce(new Response(new Uint8Array([9])));
    await expect(FilesService.download(entry([new Uint8Array([1])]), new AbortController().signal)).rejects.toThrow("integrity check");
    expect(target.bytes().length).toBe(0);
  });
});
