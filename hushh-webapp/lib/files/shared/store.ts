import { ApiService } from "@/lib/services/api-service";
import * as cipher from "./crypto";

export type SharedFilesAccess = {
  owner: string;
  vaultKey: string;
  ownerToken: string;
  check: () => void;
};
export type Snapshot<T> = { value: T | null; generation: string };
const ZERO = "0".repeat(64);
const decoder = new TextDecoder("utf-8", { fatal: true });

export class SharedFilesStore {
  private encryption!: CryptoKey;
  private names!: CryptoKey;
  private libraryId: string | null = null;
  private leaseId: string | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private initialization: Promise<void> | null = null;
  constructor(private readonly access: SharedFilesAccess) {}
  check(): void {
    this.access.check();
  }
  private async remote(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.check();
    signal?.throwIfAborted();
    const response = await ApiService.apiFetch(`/api/one/files/${path}`, {
      method: body === undefined ? "GET" : path === "storage" ? "POST" : "PUT",
      signal,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${this.access.ownerToken}`,
        "Content-Type": "application/json",
        ...(this.libraryId ? { "X-Files-Library-Id": this.libraryId } : {}),
        ...(this.leaseId ? { "X-Files-Mutation-Lease": this.leaseId } : {}),
      },
      beforeDispatch: async () => this.check(),
      isEffectCurrent: () => {
        try {
          this.check();
          return true;
        } catch {
          return false;
        }
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    this.check();
    signal?.throwIfAborted();
    const result = await response.json();
    this.check();
    if (!response.ok)
      throw new Error(
        result?.detail?.code ?? `FILES_UNAVAILABLE:${response.status}`,
      );
    return result;
  }
  private async withLease<T>(effect: () => Promise<T>): Promise<T> {
    const lease = crypto.randomUUID();
    this.check();
    if (!this.libraryId) await this.storage();
    await this.remote("storage", { operation: "acquire", leaseId: lease });
    this.leaseId = lease;
    try {
      return await effect();
    } finally {
      // A failed release does not undo a provider-confirmed commit. SQL permits
      // expiry only when every write settled; uncertain writes remain fenced.
      try {
        await this.remote("storage", { operation: "release", leaseId: lease });
      } catch {
        /* The durable lease reconciles independently of this browser. */
      } finally {
        this.leaseId = null;
      }
    }
  }
  async serialize<T>(effect: () => Promise<T>): Promise<T> {
    // Bootstrap owns a raw lease, outside this queue. Otherwise a first read and
    // first mutation could each await the other's initialization/queue slot.
    await this.ready();
    let unlock!: () => void;
    const previous = this.mutationTail;
    this.mutationTail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await this.withLease(effect);
    } finally {
      unlock();
    }
  }
  async analysis(
    input: unknown,
    signal: AbortSignal,
    beforeDisclosure: () => Promise<void>,
  ): Promise<Record<string, unknown>> {
    this.check();
    const response = await ApiService.apiFetch("/api/one/files/analyze", {
      method: "POST",
      signal,
      timeoutMs: 130_000,
      headers: {
        Authorization: `Bearer ${this.access.ownerToken}`,
        "Content-Type": "application/json",
        "X-Files-Library-Id": this.libraryId ?? "",
      },
      beforeDispatch: async () => {
        this.check();
        await beforeDisclosure();
        this.check();
      },
      isEffectCurrent: () => {
        try {
          this.check();
          return true;
        } catch {
          return false;
        }
      },
      body: JSON.stringify(input),
    });
    this.check();
    signal.throwIfAborted();
    const result = await response.json();
    if (!response.ok)
      throw new Error(result?.detail?.code ?? "FILES_MODEL_UNAVAILABLE");
    return result;
  }
  private async initialize(): Promise<void> {
    if (!this.libraryId) await this.storage();
    const context = `hussh/shared-files/key/v1/${this.access.owner}/${this.libraryId}`;
    const wrapping = await cipher.wrappingKey(
      this.access.vaultKey,
      this.access.owner,
    );
    let envelope = await this.remote(`objects/${ZERO}/${ZERO}`);
    if (envelope.ciphertext === null) {
      const proposed = crypto.getRandomValues(new Uint8Array(32));
      try {
        const ciphertext = await cipher.seal(wrapping, proposed, context);
        const install = async () => {
          await this.remote(`objects/${ZERO}/${ZERO}`, {
            ciphertext,
            expectedGeneration: "",
          });
          envelope = { ciphertext };
        };
        try {
          await this.withLease(install);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "FILES_REVISION_CONFLICT"
          )
            throw error;
          envelope = await this.remote(`objects/${ZERO}/${ZERO}`);
        }
      } finally {
        proposed.fill(0);
      }
    }
    if (typeof envelope.ciphertext !== "string")
      throw new Error("FILES_KEY_UNAVAILABLE");
    const raw = await cipher.open(wrapping, envelope.ciphertext, context);
    try {
      if (raw.length !== 32) throw new Error("FILES_KEY_INVALID");
      this.encryption = await cipher.aes(raw);
      this.names = await cipher.namesKey(raw);
      this.check();
    } finally {
      raw.fill(0);
    }
  }
  private async ready(): Promise<void> {
    this.check();
    this.initialization ??= this.initialize().catch((error) => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
    this.check();
  }
  private async address(
    group: string,
    id: string,
  ): Promise<{ namespace: string; id: string; context: string }> {
    await this.ready();
    const namespace = await cipher.opaque(this.names, `namespace:${group}`);
    const object = await cipher.opaque(this.names, `object:${group}:${id}`);
    return {
      namespace,
      id: object,
      context: JSON.stringify([
        "hussh/shared-files/object/v1",
        this.access.owner,
        this.libraryId,
        namespace,
        object,
      ]),
    };
  }
  async readBytes(
    group: string,
    id: string,
    signal?: AbortSignal,
    key?: CryptoKey,
  ): Promise<Snapshot<Uint8Array>> {
    const address = await this.address(group, id);
    const result = await this.remote(
      `objects/${address.namespace}/${address.id}`,
      undefined,
      signal,
    );
    if (typeof result.generation !== "string")
      throw new Error("FILES_VERSION_INVALID");
    const value =
      result.ciphertext === null
        ? null
        : await cipher.open(
            key ?? this.encryption,
            String(result.ciphertext),
            address.context,
          );
    this.check();
    return { value, generation: result.generation };
  }
  async writeBytesHeld(
    group: string,
    id: string,
    value: Uint8Array,
    generation: string,
    signal?: AbortSignal,
    key?: CryptoKey,
  ): Promise<void> {
    if (!this.leaseId) throw new Error("FILES_LEASE_REQUIRED");
    const address = await this.address(group, id);
    const ciphertext = await cipher.seal(
      key ?? this.encryption,
      value,
      address.context,
    );
    await this.remote(
      `objects/${address.namespace}/${address.id}`,
      { ciphertext, expectedGeneration: generation },
      signal,
    );
  }
  async read<T>(
    group: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<Snapshot<T>> {
    const result = await this.readBytes(group, id, signal);
    return {
      generation: result.generation,
      value:
        result.value === null
          ? null
          : (JSON.parse(decoder.decode(result.value)) as T),
    };
  }
  async write(
    group: string,
    id: string,
    value: unknown,
    generation: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.serialize(() =>
      this.writeHeld(group, id, value, generation, signal),
    );
  }
  async writeHeld(
    group: string,
    id: string,
    value: unknown,
    generation: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.writeBytesHeld(
      group,
      id,
      new TextEncoder().encode(JSON.stringify(value)),
      generation,
      signal,
    );
  }
  async id(requestId: string): Promise<string> {
    await this.ready();
    return (await cipher.opaque(this.names, `create:${requestId}`)).slice(
      0,
      32,
    );
  }
  async index(parent: string, id: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.writeHeld(`folder:${parent}`, id, { id }, "", signal);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "FILES_REVISION_CONFLICT"
      )
        throw error;
    }
  }
  async page(
    group: string,
    cursor = "",
    signal?: AbortSignal,
  ): Promise<{ values: unknown[]; cursor: string }> {
    await this.ready();
    const namespace = await cipher.opaque(this.names, `namespace:${group}`);
    const result = await this.remote(
      `objects/${namespace}?${new URLSearchParams({ cursor })}`,
      undefined,
      signal,
    );
    if (
      !Array.isArray(result.keys) ||
      result.keys.length > 100 ||
      typeof result.cursor !== "string"
    )
      throw new Error("FILES_INDEX_INVALID");
    const values: unknown[] = [];
    for (const id of result.keys) {
      if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
        throw new Error("FILES_INDEX_INVALID");
      const item = await this.remote(
        `objects/${namespace}/${id}`,
        undefined,
        signal,
      );
      if (typeof item.ciphertext !== "string") continue;
      const context = JSON.stringify([
        "hussh/shared-files/object/v1",
        this.access.owner,
        this.libraryId,
        namespace,
        id,
      ]);
      values.push(
        JSON.parse(
          decoder.decode(
            await cipher.open(this.encryption, item.ciphertext, context),
          ),
        ),
      );
    }
    this.check();
    return { values, cursor: result.cursor };
  }
  async storage(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = await this.remote("storage", undefined, signal);
    if (
      typeof result.libraryId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(result.libraryId) ||
      (this.libraryId && result.libraryId !== this.libraryId)
    )
      throw new Error("FILES_LIBRARY_CHANGED");
    this.libraryId = result.libraryId;
    return result;
  }
}
