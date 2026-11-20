import { Blob as NativeBlob } from "node:buffer";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
const sharedRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { ownerPodRequest: request, apiFetch: sharedRequest },
}));
import { bindFilesConnection } from "@/lib/files/connection";
import {
  DownloadPaused,
  FilesService,
  type FileEntry,
} from "@/lib/files/service";

function hash(chunks: Uint8Array[]) {
  let chain = Buffer.alloc(32);
  for (const chunk of chunks) {
    chain = createHash("sha256")
      .update(
        Buffer.concat([chain, createHash("sha256").update(chunk).digest()]),
      )
      .digest();
  }
  return chain.toString("hex");
}
function entry(chunks: Uint8Array[]): FileEntry {
  const size = chunks.reduce((total, bytes) => total + bytes.length, 0);
  return {
    id: "file",
    name: "example.txt",
    originalName: "example.txt",
    parent: "root",
    kind: "file",
    size,
    received: size,
    receivedHash: hash(chunks),
    state: "ready",
    revision: 2,
  };
}
function disk() {
  let saved = new Uint8Array();
  const handle = {
    getFile: async () =>
      ({
        size: saved.length,
        slice: (start: number, end: number) => ({
          arrayBuffer: async () => saved.slice(start, end).buffer,
        }),
      }) as File,
    createWritable: async ({
      keepExistingData,
    }: {
      keepExistingData: boolean;
    }) => {
      let pending = keepExistingData ? saved.slice() : new Uint8Array();
      let offset = 0;
      return {
        write: async (bytes: Uint8Array) => {
          const next = new Uint8Array(offset + bytes.length);
          next.set(pending.subarray(0, offset));
          next.set(bytes, offset);
          pending = next;
          offset += bytes.length;
        },
        seek: async (value: number) => {
          offset = value;
        },
        close: async () => {
          saved = pending;
        },
        abort: async () => undefined,
      };
    },
  };
  vi.stubGlobal(
    "showSaveFilePicker",
    vi.fn(async () => handle),
  );
  return {
    corrupt: () => {
      saved[0] ^= 1;
    },
    bytes: () => saved,
  };
}
let release: (() => void) | undefined;
beforeEach(() => {
  release = bindFilesConnection(
    {
      owner: "fixture-owner",
      vaultKey: "0".repeat(64),
      ownerToken: "fixture-token",
      check: () => undefined,
    },
    false,
  );
});
afterEach(() => {
  release?.();
  request.mockReset();
  sharedRequest.mockReset();
  vi.unstubAllGlobals();
});

describe("private Files downloads", () => {
  it("resumes only missing chunks and verifies the saved prefix and complete file", async () => {
    const chunks = [
      new Uint8Array(4 * 1024 * 1024).fill(7),
      new Uint8Array([1, 2, 3]),
    ];
    const target = disk();
    request
      .mockResolvedValueOnce(new Response(chunks[0]))
      .mockRejectedValueOnce(new TypeError("offline"));
    let paused: DownloadPaused | undefined;
    try {
      await FilesService.download(entry(chunks), new AbortController().signal);
    } catch (error) {
      expect(error).toBeInstanceOf(DownloadPaused);
      paused = error as DownloadPaused;
    }
    expect(paused?.checkpoint.offset).toBe(chunks[0].length);
    request.mockResolvedValueOnce(new Response(chunks[1]));
    await FilesService.download(
      entry(chunks),
      new AbortController().signal,
      paused!.checkpoint,
    );
    expect(request.mock.calls[2][0]).toContain("index=1");
    expect(target.bytes().length).toBe(chunks[0].length + 3);
    expect(target.bytes().slice(-3)).toEqual(chunks[1]);
  });

  it("refuses a changed local partial file before another network read", async () => {
    const chunks = [
      new Uint8Array(4 * 1024 * 1024).fill(7),
      new Uint8Array([1]),
    ];
    const target = disk();
    request
      .mockResolvedValueOnce(new Response(chunks[0]))
      .mockRejectedValueOnce(new TypeError("offline"));
    const paused = await FilesService.download(
      entry(chunks),
      new AbortController().signal,
    ).catch((error) => error as DownloadPaused);
    target.corrupt();
    await expect(
      FilesService.download(
        entry(chunks),
        new AbortController().signal,
        paused.checkpoint,
      ),
    ).rejects.toThrow("partial download changed");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not commit content whose immutable digest fails", async () => {
    const target = disk();
    request.mockResolvedValueOnce(new Response(new Uint8Array([9])));
    await expect(
      FilesService.download(
        entry([new Uint8Array([1])]),
        new AbortController().signal,
      ),
    ).rejects.toThrow("integrity check");
    expect(target.bytes().length).toBe(0);
  });
});

describe("Shared Files ciphertext boundary", () => {
  it("resumes encrypted transfers, verifies exact bytes and refuses tampering or locked access", async () => {
    vi.stubGlobal("btoa", (value: string) =>
      Buffer.from(value, "binary").toString("base64"),
    );
    vi.stubGlobal("atob", (value: string) =>
      Buffer.from(value, "base64").toString("binary"),
    );
    const storage = new Map<
      string,
      { ciphertext: string; generation: string }
    >();
    const sent: string[] = [];
    let generation = 0;
    const analyzed: Record<string, unknown>[] = [];
    let interruptTail = false;
    let interruptUpload = true;
    sharedRequest.mockImplementation(
      async (path: string, init: RequestInit) => {
        const url = new URL(path, "https://fixture.invalid");
        const key = url.pathname;
        if (key.endsWith("/analyze") && init.method === "POST") {
          const body = JSON.parse(String(init.body));
          analyzed.push(body);
          return Response.json({ fileId: body.file.id, revision: body.file.revision,
            consentRevision: body.consent_revision, provider: "gemini", changes: [],
            result: { state: "unchanged", explanation: "Synthetic selected-file review" } });
        }
        if (key.endsWith("/storage") && init.method === "POST")
          return Response.json({ status: "accepted" });
        if (key.endsWith("/storage"))
          return Response.json({
            libraryId: "00000000-0000-4000-8000-000000000001",
            retention: {
              retentionLocked: false,
              softDeleteSeconds: 0,
              versioning: false,
              physicalDeletion: "not_requested_by_trash",
            },
          });
        if (init.method === "PUT") {
          const body = JSON.parse(String(init.body));
          sent.push(String(init.body));
          if (interruptUpload && body.ciphertext.length === 44) {
            interruptUpload = false;
            throw new TypeError("synthetic interrupted upload");
          }
          if ((storage.get(key)?.generation ?? "") !== body.expectedGeneration)
            return Response.json(
              { detail: { code: "FILES_REVISION_CONFLICT" } },
              { status: 409 },
            );
          const value = {
            ciphertext: body.ciphertext,
            generation: String(++generation),
          };
          storage.set(key, value);
          return Response.json({ generation: value.generation });
        }
        const segments = key.split("/");
        if (segments.length === 6)
          return Response.json({
            keys: [...storage.keys()]
              .filter((name) => name.startsWith(key + "/"))
              .map((name) => name.split("/").at(-1)),
            cursor: "",
          });
        if (interruptTail && storage.get(key)?.ciphertext.length === 44) {
          interruptTail = false;
          throw new TypeError("synthetic network interruption");
        }
        return Response.json(
          storage.get(key) ?? { ciphertext: null, generation: "" },
        );
      },
    );
    let locked = false;
    release?.();
    release = bindFilesConnection(
      {
        owner: "fixture-shared",
        vaultKey: "1".repeat(64),
        ownerToken: "fixture-token",
        check: () => {
          if (locked) throw new Error("locked");
        },
      },
      true,
    );
    const [, folder] = await Promise.all([
      FilesService.list("root"),
      FilesService.createFolder("Private folder", "root"),
    ]);
    const first = new Uint8Array(4 * 1024 * 1024).fill(7),
      tail = new Uint8Array([4, 1, 9]);
    const bytes = new Uint8Array(first.length + tail.length);
    bytes.set(first);
    bytes.set(tail, first.length);
    const file = Object.assign(new NativeBlob([bytes]), {
      name: "private-original.txt",
    }) as unknown as File;
    await expect(
      FilesService.upload(
        file,
        "root",
        () => undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow("synthetic interrupted upload");
    const partial = (await FilesService.list("root")).entries.find(
      (item) => item.kind === "file",
    )!;
    expect(partial.received).toBe(first.length);
    const uploaded = await FilesService.upload(
      file,
      "root",
      () => undefined,
      new AbortController().signal,
      partial,
    );
    expect(uploaded.id).toBe(partial.id);
    expect(uploaded.receivedHash).toBe(hash([first, tail]));
    expect(sent.join(" ")).not.toContain("private-original.txt");
    expect(sent.join(" ")).not.toContain('"contentKey"');
    const renamed = await FilesService.mutate(uploaded, "rename", {
      name: "Private renamed.txt",
    });
    const moved = await FilesService.mutate(renamed, "move", {
      parent: folder.id,
    });
    expect((await FilesService.list(folder.id)).entries[0].id).toBe(
      uploaded.id,
    );
    const undone = await FilesService.mutate(moved, "undo");
    const trashed = await FilesService.mutate(undone, "trash", {
      confirmed: true,
    });
    const restored = await FilesService.mutate(trashed, "restore");
    const target = disk();
    interruptTail = true;
    const paused = await FilesService.download(
      restored,
      new AbortController().signal,
    ).catch((error) => error as DownloadPaused);
    expect(paused).toBeInstanceOf(DownloadPaused);
    expect(paused.checkpoint.offset).toBe(first.length);
    await FilesService.download(
      restored,
      new AbortController().signal,
      paused.checkpoint,
    );
    expect(Buffer.from(target.bytes()).equals(Buffer.from(bytes))).toBe(true);
    release?.();
    release = bindFilesConnection(
      {
        owner: "fixture-shared",
        vaultKey: "1".repeat(64),
        ownerToken: "renewed-fixture-token",
        check: () => {
          if (locked) throw new Error("locked");
        },
      },
      true,
    );
    expect((await FilesService.entry(uploaded.id)).name).toBe(
      "Private renamed.txt",
    );

    await expect(
      FilesService.mutate(uploaded, "rename", { name: "stale" }),
    ).rejects.toThrow("FILES_REVISION_CONFLICT");
    await expect(
      FilesService.configure({
        revision: 0,
        analysis: true,
        automatic: true,
        excluded: [],
      }),
    ).rejects.toThrow("FILES_PRIVATE_AGENT_REQUIRED");
    await FilesService.createFolder("Unapproved sibling folder", "root");
    await FilesService.configure({ revision: 0, analysis: true, automatic: false, excluded: [] });
    const selected = await FilesService.upload(
      Object.assign(new NativeBlob(["selected synthetic text"]), { name: "selected.txt" }) as unknown as File,
      "root", () => undefined, new AbortController().signal,
    );
    expect((await FilesService.organize(selected.id)).state).toBe("completed");
    expect(analyzed).toHaveLength(1);
    expect(analyzed[0]).toMatchObject({ file: { id: selected.id }, folders: [] });
    expect(JSON.stringify(analyzed)).not.toContain("Unapproved sibling folder");
    const object = [...storage.values()].find(
      (value) => value.ciphertext.length > 80,
    )!;
    object.ciphertext = object.ciphertext.slice(0, -4) + "AAAA";
    await expect(FilesService.list("root")).rejects.toThrow();
    locked = true;
    await expect(FilesService.entry(uploaded.id)).rejects.toThrow("locked");
    expect(request).not.toHaveBeenCalled();
  });
});
