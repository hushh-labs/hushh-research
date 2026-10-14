import type { FileEntry, FilesSettings } from "../service";
import * as cipher from "./crypto";
import { SharedFilesStore, type SharedFilesAccess } from "./store";

export type StoredEntry = FileEntry & {
  chunks: number;
  contentKey: string;
  initialParent: string;
  history: Array<Partial<FileEntry>>;
};
export const identifier = (id: string): string => {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("FILES_INVALID_ID");
  return id;
};
const name = (value: string): string => {
  if (
    !value ||
    value.length > 255 ||
    value === "." ||
    value === ".." ||
    /[\\/\x00-\x1f]/.test(value)
  )
    throw new Error("FILES_INVALID_NAME");
  return value;
};
export function publicEntry(entry: StoredEntry): FileEntry {
  const {
    contentKey: _key,
    history: _history,
    chunks: _chunks,
    initialParent: _parent,
    ...publicValue
  } = entry;
  return publicValue;
}
export class SharedFilesLibrary {
  readonly store: SharedFilesStore;
  constructor(readonly access: SharedFilesAccess) {
    this.store = new SharedFilesStore(access);
  }
  async entry(id: string, signal?: AbortSignal) {
    const snapshot = await this.store.read<StoredEntry>(
      "entries",
      identifier(id),
      signal,
    );
    const entry = snapshot.value;
    if (!entry) throw new Error("FILES_NOT_FOUND");
    if (
      entry.id !== id ||
      !["file", "folder"].includes(entry.kind) ||
      !["uploading", "ready", "trashed"].includes(entry.state) ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 1 ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !Number.isSafeInteger(entry.received) ||
      entry.received < 0 ||
      entry.received > entry.size ||
      !/^[a-f0-9]{64}$/.test(entry.receivedHash) ||
      !/^[a-f0-9]{64}$/.test(entry.contentKey)
    )
      throw new Error("FILES_METADATA_INVALID");
    return { entry, generation: snapshot.generation };
  }
  async parent(
    parent: string,
    child = "",
    signal?: AbortSignal,
  ): Promise<void> {
    const seen = new Set([child]);
    for (let depth = 0; depth < 256; depth++) {
      if (parent === "root") return;
      if (seen.has(parent)) throw new Error("FILES_FOLDER_CYCLE");
      seen.add(parent);
      const { entry } = await this.entry(parent, signal);
      if (entry.kind !== "folder" || entry.state !== "ready")
        throw new Error("FILES_FOLDER_UNAVAILABLE");
      parent = entry.parent;
    }
    throw new Error("FILES_FOLDER_DEPTH_LIMIT");
  }
  async settings(signal?: AbortSignal): Promise<FilesSettings> {
    const result = await this.store.read<FilesSettings>(
      "configuration",
      "settings",
      signal,
    );
    const storage = await this.store.storage(signal);
    return {
      ...(result.value ?? {
        revision: 0,
        analysis: false,
        automatic: false,
        excluded: [],
      }),
      automatic: false,
      backgroundAvailable: false,
      backgroundProvider: null,
      foregroundOnly: true,
      retention: storage.retention as FilesSettings["retention"],
    };
  }
  async configure(
    settings: FilesSettings,
    signal?: AbortSignal,
  ): Promise<FilesSettings> {
    return this.store.serialize(() => this._configure(settings, signal));
  }
  private async _configure(
    settings: FilesSettings,
    signal?: AbortSignal,
  ): Promise<FilesSettings> {
    if (settings.automatic) throw new Error("FILES_PRIVATE_AGENT_REQUIRED");
    if (!Array.isArray(settings.excluded) || settings.excluded.length > 1000)
      throw new Error("FILES_EXCLUSIONS_TOO_LARGE");
    settings.excluded.forEach(identifier);
    const current = await this.store.read<FilesSettings>(
      "configuration",
      "settings",
      signal,
    );
    if ((current.value?.revision ?? 0) !== settings.revision)
      throw new Error("FILES_REVISION_CONFLICT");
    const value = {
      revision: settings.revision + 1,
      analysis: settings.analysis === true,
      automatic: false,
      excluded: [...new Set(settings.excluded)],
    };
    await this.store.writeHeld(
      "configuration",
      "settings",
      value,
      current.generation,
      signal,
    );
    return this.settings(signal);
  }
  async create(
    input: {
      name: string;
      parent: string;
      size: number;
      request_id: string;
      folder?: boolean;
    },
    signal?: AbortSignal,
    beforeCommit?: () => Promise<void>,
  ): Promise<FileEntry> {
    return this.store.serialize(() =>
      this._create(input, signal, beforeCommit),
    );
  }
  private async _create(
    input: {
      name: string;
      parent: string;
      size: number;
      request_id: string;
      folder?: boolean;
    },
    signal?: AbortSignal,
    beforeCommit?: () => Promise<void>,
  ): Promise<FileEntry> {
    name(input.name);
    if (
      !Number.isSafeInteger(input.size) ||
      input.size < 0 ||
      input.size > 5 * 1024 ** 4 ||
      (input.folder && input.size !== 0) ||
      !input.request_id ||
      input.request_id.length > 128
    )
      throw new Error("FILES_INVALID_UPLOAD");
    const id = await this.store.id(input.request_id);
    await this.parent(input.parent, id, signal);
    const current = await this.store.read<StoredEntry>("entries", id, signal);
    const kind = input.folder ? "folder" : "file";
    if (current.value) {
      const entry = current.value;
      if (
        entry.originalName !== input.name ||
        entry.initialParent !== input.parent ||
        entry.size !== input.size ||
        entry.kind !== kind
      )
        throw new Error("FILES_IDEMPOTENCY_CONFLICT");
      return publicEntry(entry);
    }
    const entry: StoredEntry = {
      id,
      name: input.name,
      originalName: input.name,
      parent: input.parent,
      initialParent: input.parent,
      kind,
      size: input.size,
      received: 0,
      receivedHash: "0".repeat(64),
      state: input.folder ? "ready" : "uploading",
      revision: 1,
      chunks: 0,
      contentKey: cipher.hex(crypto.getRandomValues(new Uint8Array(32))),
      history: [],
    };
    await this.store.index(input.parent, id, signal);
    await beforeCommit?.();
    await this.store.writeHeld("entries", id, entry, "", signal);
    return publicEntry(entry);
  }
  async list(
    parent: string,
    cursor: string,
    trash: boolean,
    signal?: AbortSignal,
  ) {
    await this.parent(parent, "", signal);
    const page = await this.store.page(`folder:${parent}`, cursor, signal);
    const entries: FileEntry[] = [];
    for (const hint of page.values) {
      const id = (hint as { id?: string }).id;
      if (!id) throw new Error("FILES_INDEX_INVALID");
      let entry: StoredEntry;
      try {
        entry = (await this.entry(id, signal)).entry;
      } catch (error) {
        if (error instanceof Error && error.message === "FILES_NOT_FOUND")
          continue;
        throw error;
      }
      if (entry.parent === parent && (entry.state === "trashed") === trash)
        entries.push(publicEntry(entry));
    }
    return { entries, cursor: page.cursor, chunkBytes: 4 * 1024 * 1024 };
  }
  async mutate(
    input: {
      file_id: string;
      revision: number;
      operation: string;
      name?: string;
      parent?: string;
      confirmed?: boolean;
    },
    signal?: AbortSignal,
    beforeCommit?: () => Promise<void>,
  ): Promise<FileEntry> {
    return this.store.serialize(() =>
      this._mutate(input, signal, beforeCommit),
    );
  }
  private async _mutate(
    input: {
      file_id: string;
      revision: number;
      operation: string;
      name?: string;
      parent?: string;
      confirmed?: boolean;
    },
    signal?: AbortSignal,
    beforeCommit?: () => Promise<void>,
  ): Promise<FileEntry> {
    const { entry, generation } = await this.entry(input.file_id, signal);
    if (entry.revision !== input.revision)
      throw new Error("FILES_REVISION_CONFLICT");
    let previous: Partial<FileEntry>;
    switch (input.operation) {
      case "rename":
        previous = { name: entry.name };
        entry.name = name(input.name ?? "");
        break;
      case "move":
        previous = { parent: entry.parent };
        await this.parent(input.parent ?? "", entry.id, signal);
        await this.store.index(input.parent!, entry.id, signal);
        entry.parent = input.parent!;
        break;
      case "trash":
        if (!input.confirmed) throw new Error("FILES_CONFIRMATION_REQUIRED");
        previous = { state: entry.state };
        entry.state = "trashed";
        break;
      case "restore":
        if (entry.state !== "trashed") throw new Error("FILES_NOT_TRASHED");
        await this.parent(entry.parent, entry.id, signal);
        previous = { state: entry.state };
        entry.state =
          entry.kind === "folder" || entry.received === entry.size
            ? "ready"
            : "uploading";
        break;
      case "undo": {
        const undo = entry.history.pop();
        if (!undo) throw new Error("FILES_NOTHING_TO_UNDO");
        await this.parent(undo.parent ?? entry.parent, entry.id, signal);
        if (undo.parent) await this.store.index(undo.parent, entry.id, signal);
        Object.assign(entry, undo);
        previous = {};
        break;
      }
      default:
        throw new Error("FILES_OPERATION_UNSUPPORTED");
    }
    if (input.operation !== "undo")
      entry.history = [...entry.history, previous].slice(-20);
    await beforeCommit?.();
    entry.revision++;
    await this.store.writeHeld("entries", entry.id, entry, generation, signal);
    return publicEntry(entry);
  }
  async chunk(
    id: string,
    index: number,
    content?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array | FileEntry> {
    return content
      ? this.store.serialize(() => this._chunk(id, index, content, signal))
      : this._chunk(id, index, undefined, signal);
  }
  private async _chunk(
    id: string,
    index: number,
    content?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array | FileEntry> {
    const { entry, generation } = await this.entry(id, signal);
    const chunkBytes = 4 * 1024 * 1024;
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index * chunkBytes >= entry.size ||
      entry.kind !== "file"
    )
      throw new Error("FILES_INVALID_CHUNK");
    await this.parent(entry.parent, entry.id, signal);
    const key = await cipher.aes(cipher.unhex(entry.contentKey));
    const group = `chunks:${id}`;
    const existing = await this.store.readBytes(
      group,
      String(index),
      signal,
      key,
    );
    if (!content) {
      if (entry.state !== "ready" || !existing.value)
        throw new Error("FILES_SOURCE_UNAVAILABLE");
      return existing.value;
    }
    if (
      entry.state !== "uploading" ||
      index > entry.chunks ||
      content.length !== Math.min(chunkBytes, entry.size - index * chunkBytes)
    )
      throw new Error("FILES_UPLOAD_NOT_WRITABLE");
    if (existing.value) {
      if (
        cipher.hex(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new Uint8Array(existing.value).buffer,
            ),
          ),
        ) !==
        cipher.hex(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new Uint8Array(content).buffer,
            ),
          ),
        )
      )
        throw new Error("FILES_CHUNK_RETRY_CONFLICT");
    } else
      await this.store.writeBytesHeld(
        group,
        String(index),
        content,
        "",
        signal,
        key,
      );
    if (index < entry.chunks) return publicEntry(entry);
    entry.receivedHash = await cipher.chain(entry.receivedHash, content);
    entry.received += content.length;
    entry.chunks++;
    entry.revision++;
    await this.store.writeHeld("entries", id, entry, generation, signal);
    return publicEntry(entry);
  }
  async complete(id: string, signal?: AbortSignal): Promise<FileEntry> {
    return this.store.serialize(() => this._complete(id, signal));
  }
  private async _complete(
    id: string,
    signal?: AbortSignal,
  ): Promise<FileEntry> {
    const { entry, generation } = await this.entry(id, signal);
    if (entry.state === "ready") return publicEntry(entry);
    if (entry.state !== "uploading" || entry.received !== entry.size)
      throw new Error("FILES_UPLOAD_INCOMPLETE");
    entry.state = "ready";
    entry.revision++;
    await this.store.writeHeld("entries", id, entry, generation, signal);
    return publicEntry(entry);
  }
}
