"use client";

import { Capacitor } from "@capacitor/core";

import { HushhKeychain } from "@/lib/capacitor";
import type { SavedLocationCategory } from "@/lib/one-location/saved-locations";
import {
  parseLocationRunProjection,
  type LocationRunProjectionV1,
} from "@/lib/services/one-location-onboarding-run-client";

const DATABASE_NAME = "hushh-one-location-pre-vault";
const DATABASE_VERSION = 2;
const DRAFT_STORE = "drafts";
const WEB_KEY_STORE = "web-keys";
const OWNER_INDEX = "ownerHash";
const RECORD_VERSION = 2;
const DRAFT_SCHEMA_VERSION = "one.location.pre_vault.draft.v1" as const;
const METADATA_SCHEMA_VERSION =
  "one.location.pre_vault.draft_metadata.v1" as const;
const KEY_BYTES = 32;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1_000;
const NATIVE_KEY_PREFIX = "one.location.pre_vault.key.";
const DRAFT_ID_PATTERN = /^draft_[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + GCM_TAG_BYTES;
const MAX_AAD_BYTES = 8 * 1024;
const MAX_DATE_MS = 8_640_000_000_000_000;

export const ONE_LOCATION_PRE_VAULT_DRAFT_TTL_MS = DRAFT_TTL_MS;

export type OneLocationPreVaultDraft = {
  category: SavedLocationCategory;
  label: string;
  latitude: number;
  longitude: number;
  address: string | null;
  accuracyM: number | null;
  capturedAt: string;
  sourcePlatform: "web" | "ios" | "android" | "native";
};

/**
 * The only draft information safe to attach to a server interaction.
 * Coordinates, labels, addresses, account identifiers, and plaintext never
 * cross this boundary.
 */
export type OneLocationPreVaultDraftMetadataV1 = {
  schemaVersion: typeof METADATA_SCHEMA_VERSION;
  digest: string;
  status: "staged";
  expiresAt: string;
  runId: string;
  revision: number;
};

export type OneLocationPreVaultDraftEnvelope = {
  draft: OneLocationPreVaultDraft;
  /** Opaque PKM receipt retained only until server verification succeeds. */
  pkmCommitRef: string | null;
  metadata: OneLocationPreVaultDraftMetadataV1;
  binding: Pick<
    LocationRunProjectionV1,
    "workflowId" | "workflowVersion" | "graphRevision" | "runId" | "revision"
  >;
};

export type OneLocationPreVaultDraftRecoveryBinding =
  OneLocationPreVaultDraftEnvelope["binding"] & { digest: string };

type StoredDraftV2 = {
  id: string;
  ownerHash: string;
  version: typeof RECORD_VERSION;
  draftSchemaVersion: typeof DRAFT_SCHEMA_VERSION;
  workflowId: LocationRunProjectionV1["workflowId"];
  workflowVersion: number;
  graphRevision: string;
  runId: string;
  runRevision: number;
  status: "staged";
  digest: string;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  commitIv?: ArrayBuffer;
  commitCiphertext?: ArrayBuffer;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
};

type StoredWebKeyV2 = {
  id: string;
  version: typeof RECORD_VERSION;
  key: CryptoKey;
};

type NativeLocationDraftKey =
  `one.location.pre_vault.key.draft_${string}`;

type DeviceKeyPlugin = {
  sealLocationDraft(options: {
    key: NativeLocationDraftKey;
    plaintext: string;
    aad: string;
  }): Promise<{ iv: string; ciphertext: string }>;
  openLocationDraft(options: {
    key: NativeLocationDraftKey;
    iv: string;
    ciphertext: string;
    aad: string;
  }): Promise<{ plaintext: string }>;
  delete(options: { key: NativeLocationDraftKey }): Promise<void>;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const ownerLocks = new Map<string, Promise<void>>();
const COMMIT_REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,63}$/iu;

export class OneLocationPreVaultDraftUnavailableError extends Error {
  readonly code = "ONE_LOCATION_PRE_VAULT_DRAFT_UNAVAILABLE";

  constructor(message = "Secure on-device Location storage is unavailable.") {
    super(message);
    this.name = "OneLocationPreVaultDraftUnavailableError";
  }
}

function webCrypto(): Crypto {
  const value = globalThis.crypto;
  if (!value?.subtle || typeof value.getRandomValues !== "function") {
    throw new OneLocationPreVaultDraftUnavailableError();
  }
  return value;
}

function indexedDatabase(): IDBFactory {
  if (typeof indexedDB === "undefined") {
    throw new OneLocationPreVaultDraftUnavailableError();
  }
  return indexedDB;
}

function assertValidClock(nowMs: number): void {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    nowMs > MAX_DATE_MS - DRAFT_TTL_MS
  ) {
    throw new OneLocationPreVaultDraftUnavailableError(
      "The secure Location draft clock is invalid.",
    );
  }
}

function normalizeDraft(
  draft: OneLocationPreVaultDraft,
): OneLocationPreVaultDraft {
  if (
    !Number.isFinite(draft.latitude) ||
    draft.latitude < -90 ||
    draft.latitude > 90 ||
    !Number.isFinite(draft.longitude) ||
    draft.longitude < -180 ||
    draft.longitude > 180
  ) {
    throw new Error("Choose a valid location before continuing.");
  }
  const capturedAt = String(draft.capturedAt || "").trim();
  if (!capturedAt || !Number.isFinite(Date.parse(capturedAt))) {
    throw new Error("The location reading is invalid. Try again.");
  }
  const label = String(draft.label || "")
    .trim()
    .slice(0, 40);
  const address =
    String(draft.address || "")
      .trim()
      .slice(0, 300) || null;
  const accuracyM =
    draft.accuracyM === null || draft.accuracyM === undefined
      ? null
      : Number(draft.accuracyM);
  if (accuracyM !== null && (!Number.isFinite(accuracyM) || accuracyM < 0)) {
    throw new Error("The location accuracy is invalid. Try again.");
  }
  if (
    draft.sourcePlatform !== "web" &&
    draft.sourcePlatform !== "ios" &&
    draft.sourcePlatform !== "android" &&
    draft.sourcePlatform !== "native"
  ) {
    throw new Error("The location source is invalid. Try again.");
  }
  if (
    draft.category !== "home" &&
    draft.category !== "work" &&
    draft.category !== "other"
  ) {
    throw new Error("Choose a valid place type before continuing.");
  }
  return {
    category: draft.category,
    label,
    latitude: draft.latitude,
    longitude: draft.longitude,
    address,
    accuracyM,
    capturedAt: new Date(capturedAt).toISOString(),
    sourcePlatform: draft.sourcePlatform,
  };
}

function validateDecryptedDraft(value: unknown): OneLocationPreVaultDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OneLocationPreVaultDraftUnavailableError(
      "The secure Location draft could not be read.",
    );
  }
  return normalizeDraft(value as OneLocationPreVaultDraft);
}

function base64ToBytes(value: string, maximumBytes: number): Uint8Array {
  const normalized = String(value || "").trim();
  const maximumEncodedBytes = Math.ceil(maximumBytes / 3) * 4;
  if (
    !normalized ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    normalized.length > maximumEncodedBytes ||
    normalized.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      normalized,
    )
  ) {
    throw new OneLocationPreVaultDraftUnavailableError();
  }
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw new OneLocationPreVaultDraftUnavailableError();
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > maximumBytes ||
    bytesToBase64(bytes) !== normalized
  ) {
    bytes.fill(0);
    throw new OneLocationPreVaultDraftUnavailableError();
  }
  return bytes;
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < value.byteLength; index += 1) {
    binary += String.fromCharCode(value[index]!);
  }
  return btoa(binary);
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await webCrypto().subtle.digest(
    "SHA-256",
    exactArrayBuffer(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function ownerKey(userId: string): Promise<string> {
  const cleanUserId = String(userId || "").trim();
  if (!cleanUserId) throw new Error("A signed-in user is required.");
  return sha256(textEncoder.encode(cleanUserId));
}

function normalizedRun(value: unknown): LocationRunProjectionV1 {
  const projection = parseLocationRunProjection(value);
  if (!projection) {
    throw new OneLocationPreVaultDraftUnavailableError(
      "A verified Location task is required before saving this draft.",
    );
  }
  return projection;
}

function identityInput(
  ownerHash: string,
  run: LocationRunProjectionV1,
): string {
  return [
    DRAFT_SCHEMA_VERSION,
    ownerHash,
    run.workflowId,
    String(run.workflowVersion),
    run.graphRevision,
    run.runId,
  ].join(":");
}

async function recordIdentity(
  ownerHash: string,
  run: LocationRunProjectionV1,
): Promise<string> {
  return `draft_${await sha256(textEncoder.encode(identityInput(ownerHash, run)))}`;
}

function nativeKeyName(id: string): NativeLocationDraftKey {
  if (!DRAFT_ID_PATTERN.test(id)) {
    throw new OneLocationPreVaultDraftUnavailableError();
  }
  return `${NATIVE_KEY_PREFIX}${id}` as NativeLocationDraftKey;
}

function additionalData(
  record: Pick<
    StoredDraftV2,
    | "id"
    | "ownerHash"
    | "draftSchemaVersion"
    | "workflowId"
    | "workflowVersion"
    | "graphRevision"
    | "runId"
    | "runRevision"
    | "status"
    | "createdAtMs"
    | "updatedAtMs"
    | "expiresAtMs"
  >,
): ArrayBuffer {
  // AAD binds the ciphertext to the signed-in account scope, authoritative
  // run, workflow/schema revisions, graph build, server revision, and TTL.
  // None of those fields contains the private place payload.
  const encoded = textEncoder.encode(
    JSON.stringify({
      id: record.id,
      ownerHash: record.ownerHash,
      draftSchemaVersion: record.draftSchemaVersion,
      workflowId: record.workflowId,
      workflowVersion: record.workflowVersion,
      graphRevision: record.graphRevision,
      runId: record.runId,
      runRevision: record.runRevision,
      status: record.status,
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
      expiresAtMs: record.expiresAtMs,
    }),
  );
  if (encoded.byteLength < 1 || encoded.byteLength > MAX_AAD_BYTES) {
    encoded.fill(0);
    throw new OneLocationPreVaultDraftUnavailableError();
  }
  return exactArrayBuffer(encoded);
}

function commitAdditionalData(record: StoredDraftV2): ArrayBuffer {
  const encoded = textEncoder.encode(
    `${textDecoder.decode(additionalData(record))}:pkm-commit:${record.digest}`,
  );
  if (encoded.byteLength < 1 || encoded.byteLength > MAX_AAD_BYTES) {
    encoded.fill(0);
    throw new OneLocationPreVaultDraftUnavailableError();
  }
  return exactArrayBuffer(encoded);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDatabase().open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      let drafts: IDBObjectStore;
      if (!database.objectStoreNames.contains(DRAFT_STORE)) {
        drafts = database.createObjectStore(DRAFT_STORE, { keyPath: "id" });
      } else {
        drafts = request.transaction!.objectStore(DRAFT_STORE);
      }
      if (!drafts.indexNames.contains(OWNER_INDEX)) {
        drafts.createIndex(OWNER_INDEX, OWNER_INDEX, { unique: false });
      }
      if (!database.objectStoreNames.contains(WEB_KEY_STORE)) {
        database.createObjectStore(WEB_KEY_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () =>
      reject(new OneLocationPreVaultDraftUnavailableError());
    request.onblocked = () =>
      reject(new OneLocationPreVaultDraftUnavailableError());
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new OneLocationPreVaultDraftUnavailableError());
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(new OneLocationPreVaultDraftUnavailableError());
    transaction.onerror = () =>
      reject(new OneLocationPreVaultDraftUnavailableError());
  });
}

async function readStoredDraft(
  database: IDBDatabase,
  id: string,
): Promise<StoredDraftV2 | null> {
  const transaction = database.transaction(DRAFT_STORE, "readonly");
  const done = transactionDone(transaction);
  const value = await requestValue(
    transaction.objectStore(DRAFT_STORE).get(id),
  );
  await done;
  return value && typeof value === "object" ? (value as StoredDraftV2) : null;
}

async function readOwnerDrafts(
  database: IDBDatabase,
  ownerHash: string,
): Promise<StoredDraftV2[]> {
  const transaction = database.transaction(DRAFT_STORE, "readonly");
  const done = transactionDone(transaction);
  const values = await requestValue(
    transaction.objectStore(DRAFT_STORE).index(OWNER_INDEX).getAll(ownerHash),
  );
  await done;
  return Array.isArray(values) ? (values as StoredDraftV2[]) : [];
}

function validCryptoKey(value: unknown): value is CryptoKey {
  if (!value || typeof value !== "object") return false;
  try {
    const key = value as CryptoKey;
    const algorithm = key.algorithm as AesKeyAlgorithm | undefined;
    const usages = key.usages;
    return (
      key.type === "secret" &&
      key.extractable === false &&
      algorithm?.name === "AES-GCM" &&
      algorithm.length === KEY_BYTES * 8 &&
      Array.isArray(usages) &&
      usages.length === 2 &&
      usages.includes("encrypt") &&
      usages.includes("decrypt")
    );
  } catch {
    return false;
  }
}

async function readStoredWebKey(
  database: IDBDatabase,
  id: string,
): Promise<StoredWebKeyV2 | null> {
  const transaction = database.transaction(WEB_KEY_STORE, "readonly");
  const done = transactionDone(transaction);
  const value = await requestValue(
    transaction.objectStore(WEB_KEY_STORE).get(id),
  );
  await done;
  return value && typeof value === "object"
    ? (value as StoredWebKeyV2)
    : null;
}

async function webKey(database: IDBDatabase, id: string): Promise<CryptoKey> {
  const stored = await readStoredWebKey(database, id);
  if (stored) {
    if (
      stored.id === id &&
      stored.version === RECORD_VERSION &&
      validCryptoKey(stored.key)
    ) {
      return stored.key;
    }
    // Never replace an unknown key record. Existing ciphertext may have been
    // sealed with it; recovery must recapture instead of silently rekeying.
    throw new OneLocationPreVaultDraftUnavailableError();
  }

  const generated = await webCrypto().subtle.generateKey(
    { name: "AES-GCM", length: KEY_BYTES * 8 },
    false,
    ["encrypt", "decrypt"],
  );
  if (!validCryptoKey(generated)) {
    throw new OneLocationPreVaultDraftUnavailableError();
  }
  const writeTransaction = database.transaction(WEB_KEY_STORE, "readwrite");
  const writeDone = transactionDone(writeTransaction);
  const addRequest = writeTransaction.objectStore(WEB_KEY_STORE).add({
    id,
    version: RECORD_VERSION,
    key: generated,
  } satisfies StoredWebKeyV2);
  try {
    await Promise.all([requestValue(addRequest), writeDone]);
    return generated;
  } catch {
    // Another tab can win the add after our initial read. Reload that exact
    // winner; never overwrite it with a different key.
    await writeDone.catch(() => undefined);
    const winner = await readStoredWebKey(database, id);
    if (
      winner?.id === id &&
      winner.version === RECORD_VERSION &&
      validCryptoKey(winner.key)
    ) {
      return winner.key;
    }
    throw new OneLocationPreVaultDraftUnavailableError();
  }
}

type SealedBytes = { iv: ArrayBuffer; ciphertext: ArrayBuffer };

async function sealBytes(
  database: IDBDatabase,
  id: string,
  plaintext: Uint8Array,
  aad: ArrayBuffer,
): Promise<SealedBytes> {
  if (
    plaintext.byteLength < 1 ||
    plaintext.byteLength > MAX_PLAINTEXT_BYTES ||
    aad.byteLength < 1 ||
    aad.byteLength > MAX_AAD_BYTES
  ) {
    throw new OneLocationPreVaultDraftUnavailableError();
  }
  if (Capacitor.isNativePlatform()) {
    const plugin = HushhKeychain as unknown as DeviceKeyPlugin;
    if (typeof plugin.sealLocationDraft !== "function") {
      throw new OneLocationPreVaultDraftUnavailableError();
    }
    let result: { iv: string; ciphertext: string };
    try {
      result = await plugin.sealLocationDraft({
        key: nativeKeyName(id),
        plaintext: bytesToBase64(plaintext),
        aad: bytesToBase64(new Uint8Array(aad)),
      });
    } catch {
      throw new OneLocationPreVaultDraftUnavailableError();
    }
    const iv = base64ToBytes(result.iv, GCM_IV_BYTES);
    const ciphertext = base64ToBytes(
      result.ciphertext,
      MAX_CIPHERTEXT_BYTES,
    );
    if (
      iv.byteLength !== GCM_IV_BYTES ||
      ciphertext.byteLength !== plaintext.byteLength + GCM_TAG_BYTES
    ) {
      iv.fill(0);
      ciphertext.fill(0);
      throw new OneLocationPreVaultDraftUnavailableError();
    }
    const sealed = {
      iv: exactArrayBuffer(iv),
      ciphertext: exactArrayBuffer(ciphertext),
    };
    iv.fill(0);
    ciphertext.fill(0);
    return sealed;
  }
  const key = await webKey(database, id);
  const iv = webCrypto().getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const ciphertext = await webCrypto().subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
    key,
    exactArrayBuffer(plaintext),
  );
  if (ciphertext.byteLength !== plaintext.byteLength + GCM_TAG_BYTES) {
    iv.fill(0);
    throw new OneLocationPreVaultDraftUnavailableError();
  }
  const sealedIv = exactArrayBuffer(iv);
  iv.fill(0);
  return { iv: sealedIv, ciphertext };
}

async function openBytes(
  database: IDBDatabase,
  id: string,
  iv: ArrayBuffer,
  ciphertext: ArrayBuffer,
  aad: ArrayBuffer,
): Promise<ArrayBuffer> {
  if (
    iv.byteLength !== GCM_IV_BYTES ||
    ciphertext.byteLength <= GCM_TAG_BYTES ||
    ciphertext.byteLength > MAX_CIPHERTEXT_BYTES ||
    aad.byteLength < 1 ||
    aad.byteLength > MAX_AAD_BYTES
  ) {
    throw new OneLocationPreVaultDraftUnavailableError();
  }
  if (Capacitor.isNativePlatform()) {
    const plugin = HushhKeychain as unknown as DeviceKeyPlugin;
    if (typeof plugin.openLocationDraft !== "function") {
      throw new OneLocationPreVaultDraftUnavailableError();
    }
    try {
      const result = await plugin.openLocationDraft({
        key: nativeKeyName(id),
        iv: bytesToBase64(new Uint8Array(iv)),
        ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
        aad: bytesToBase64(new Uint8Array(aad)),
      });
      const plaintext = base64ToBytes(result.plaintext, MAX_PLAINTEXT_BYTES);
      if (plaintext.byteLength + GCM_TAG_BYTES !== ciphertext.byteLength) {
        plaintext.fill(0);
        throw new OneLocationPreVaultDraftUnavailableError();
      }
      const opened = exactArrayBuffer(plaintext);
      plaintext.fill(0);
      return opened;
    } catch {
      throw new OneLocationPreVaultDraftUnavailableError();
    }
  }
  const key = await webKey(database, id);
  return webCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: aad,
      tagLength: 128,
    },
    key,
    ciphertext,
  );
}

function asArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  // IndexedDB implementations may deserialize an ArrayBuffer from another
  // JavaScript realm (for example, a WebView/worker boundary). Copy that
  // buffer into this realm before passing it to Web Crypto.
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return exactArrayBuffer(new Uint8Array(value as ArrayBuffer));
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer;
  }
  throw new OneLocationPreVaultDraftUnavailableError(
    "The secure Location draft could not be read.",
  );
}

function validRecord(value: unknown, nowMs?: number): value is StoredDraftV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as StoredDraftV2;
  let iv: ArrayBuffer;
  let ciphertext: ArrayBuffer;
  try {
    iv = asArrayBuffer(record.iv);
    ciphertext = asArrayBuffer(record.ciphertext);
  } catch {
    return false;
  }
  const hasCommitIv = record.commitIv !== undefined;
  const hasCommitCiphertext = record.commitCiphertext !== undefined;
  if (hasCommitIv !== hasCommitCiphertext) return false;
  if (hasCommitIv) {
    try {
      if (
        asArrayBuffer(record.commitIv).byteLength !== GCM_IV_BYTES ||
        asArrayBuffer(record.commitCiphertext).byteLength <= GCM_TAG_BYTES ||
        asArrayBuffer(record.commitCiphertext).byteLength >
          MAX_CIPHERTEXT_BYTES
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return (
    record.version === RECORD_VERSION &&
    record.draftSchemaVersion === DRAFT_SCHEMA_VERSION &&
    record.status === "staged" &&
    typeof record.id === "string" &&
    DRAFT_ID_PATTERN.test(record.id) &&
    typeof record.ownerHash === "string" &&
    SHA256_PATTERN.test(record.ownerHash) &&
    record.workflowId === "workflow.setup.location" &&
    Number.isSafeInteger(record.workflowVersion) &&
    record.workflowVersion > 0 &&
    typeof record.graphRevision === "string" &&
    /^[0-9a-f]{12,64}$/u.test(record.graphRevision) &&
    typeof record.runId === "string" &&
    /^run_[a-z0-9]{16,96}$/u.test(record.runId) &&
    Number.isSafeInteger(record.runRevision) &&
    record.runRevision > 0 &&
    typeof record.digest === "string" &&
    SHA256_PATTERN.test(record.digest) &&
    Number.isSafeInteger(record.createdAtMs) &&
    Number.isSafeInteger(record.updatedAtMs) &&
    Number.isSafeInteger(record.expiresAtMs) &&
    record.createdAtMs >= 0 &&
    record.expiresAtMs <= MAX_DATE_MS &&
    record.createdAtMs <= record.updatedAtMs &&
    record.updatedAtMs <= record.expiresAtMs &&
    record.expiresAtMs - record.createdAtMs === DRAFT_TTL_MS &&
    (nowMs === undefined ||
      (Number.isSafeInteger(nowMs) &&
        nowMs >= 0 &&
        nowMs <= MAX_DATE_MS &&
        record.createdAtMs <= nowMs &&
        record.expiresAtMs <= nowMs + DRAFT_TTL_MS)) &&
    iv.byteLength === GCM_IV_BYTES &&
    ciphertext.byteLength > GCM_TAG_BYTES &&
    ciphertext.byteLength <= MAX_CIPHERTEXT_BYTES
  );
}

async function deleteRecordsAndWebKeys(
  database: IDBDatabase,
  ids: readonly string[],
): Promise<void> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return;
  const transaction = database.transaction(
    [DRAFT_STORE, WEB_KEY_STORE],
    "readwrite",
  );
  const done = transactionDone(transaction);
  for (const id of uniqueIds) {
    transaction.objectStore(DRAFT_STORE).delete(id);
    transaction.objectStore(WEB_KEY_STORE).delete(id);
  }
  await done;
}

async function deleteNativeKeys(ids: readonly string[]): Promise<void> {
  const nativeIds = [...new Set(ids)].filter((id) => DRAFT_ID_PATTERN.test(id));
  if (!Capacitor.isNativePlatform() || nativeIds.length === 0) return;
  const plugin = HushhKeychain as unknown as DeviceKeyPlugin;
  const results = await Promise.allSettled(
    nativeIds.map((id) => plugin.delete({ key: nativeKeyName(id) })),
  );
  if (results.some((result) => result.status === "rejected")) {
    throw new OneLocationPreVaultDraftUnavailableError(
      "Secure Location key cleanup did not finish.",
    );
  }
}

async function deleteRecords(
  database: IDBDatabase,
  ids: readonly string[],
): Promise<void> {
  // Native key deletion comes first. If it fails the IndexedDB record retains
  // the deterministic key id so a later sign-out/finalize cleanup can retry.
  // If it succeeds and the database write then fails, the remaining ciphertext
  // is safely undecryptable and its id still permits another cleanup pass.
  await deleteNativeKeys(ids);
  await deleteRecordsAndWebKeys(database, ids);
}

async function inProcessExclusive<T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = ownerLocks.get(id) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  ownerLocks.set(id, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (ownerLocks.get(id) === tail) ownerLocks.delete(id);
  }
}

async function exclusive<T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  // Serialize the owner-scoped key/draft pair across same-origin tabs when the
  // platform supports Web Locks. The IndexedDB `add` winner logic below still
  // protects the CryptoKey identity on older browsers and WebViews.
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks && typeof locks.request === "function") {
    return locks.request(
      `one-location-pre-vault:${id}`,
      { mode: "exclusive" },
      operation,
    );
  }
  return inProcessExclusive(id, operation);
}

function metadata(record: StoredDraftV2): OneLocationPreVaultDraftMetadataV1 {
  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    digest: record.digest,
    status: "staged",
    expiresAt: new Date(record.expiresAtMs).toISOString(),
    runId: record.runId,
    revision: record.runRevision,
  };
}

function binding(
  record: StoredDraftV2,
): OneLocationPreVaultDraftEnvelope["binding"] {
  return {
    workflowId: record.workflowId,
    workflowVersion: record.workflowVersion,
    graphRevision: record.graphRevision,
    runId: record.runId,
    revision: record.runRevision,
  };
}

async function decryptRecord(
  database: IDBDatabase,
  record: StoredDraftV2,
): Promise<OneLocationPreVaultDraftEnvelope> {
  if (!validRecord(record)) {
    throw new OneLocationPreVaultDraftUnavailableError(
      "The secure Location draft could not be read.",
    );
  }
  const aad = additionalData(record);
  const iv = asArrayBuffer(record.iv);
  const ciphertext = asArrayBuffer(record.ciphertext);
  const digestBytes = new Uint8Array(
    aad.byteLength + iv.byteLength + ciphertext.byteLength,
  );
  digestBytes.set(new Uint8Array(aad), 0);
  digestBytes.set(new Uint8Array(iv), aad.byteLength);
  digestBytes.set(
    new Uint8Array(ciphertext),
    aad.byteLength + iv.byteLength,
  );
  try {
    if ((await sha256(digestBytes)) !== record.digest) {
      throw new OneLocationPreVaultDraftUnavailableError(
        "The secure Location draft could not be read.",
      );
    }
  } finally {
    digestBytes.fill(0);
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await openBytes(
      database,
      record.id,
      iv,
      ciphertext,
      aad,
    );
  } catch {
    throw new OneLocationPreVaultDraftUnavailableError(
      "The secure Location draft could not be read.",
    );
  }
  const bytes = new Uint8Array(plaintext);
  try {
    let pkmCommitRef: string | null = null;
    if (record.commitIv && record.commitCiphertext) {
      let commitPlaintext: ArrayBuffer;
      try {
        commitPlaintext = await openBytes(
          database,
          record.id,
          asArrayBuffer(record.commitIv),
          asArrayBuffer(record.commitCiphertext),
          commitAdditionalData(record),
        );
      } catch {
        throw new OneLocationPreVaultDraftUnavailableError(
          "The secure Location receipt could not be read.",
        );
      }
      const commitBytes = new Uint8Array(commitPlaintext);
      try {
        const decoded = JSON.parse(textDecoder.decode(commitBytes)) as {
          commitRef?: unknown;
        };
        if (
          typeof decoded.commitRef !== "string" ||
          !COMMIT_REF_PATTERN.test(decoded.commitRef)
        ) {
          throw new OneLocationPreVaultDraftUnavailableError(
            "The secure Location receipt could not be read.",
          );
        }
        pkmCommitRef = decoded.commitRef;
      } finally {
        commitBytes.fill(0);
      }
    }
    return {
      draft: validateDecryptedDraft(JSON.parse(textDecoder.decode(bytes))),
      pkmCommitRef,
      metadata: metadata(record),
      binding: binding(record),
    };
  } finally {
    bytes.fill(0);
  }
}

export class OneLocationPreVaultDraftService {
  static async stage(
    userId: string,
    runValue: unknown,
    input: OneLocationPreVaultDraft,
    nowMs = Date.now(),
  ): Promise<OneLocationPreVaultDraftMetadataV1> {
    assertValidClock(nowMs);
    const run = normalizedRun(runValue);
    const ownerHash = await ownerKey(userId);
    const id = await recordIdentity(ownerHash, run);
    const draft = normalizeDraft(input);
    return exclusive(ownerHash, async () => {
      const database = await openDatabase();
      try {
        const existing = await readStoredDraft(database, id);
        if (
          existing &&
          validRecord(existing, nowMs) &&
          existing.ownerHash === ownerHash &&
          existing.runId === run.runId &&
          existing.runRevision === run.revision &&
          existing.expiresAtMs > nowMs
        ) {
          const existingEnvelope = await decryptRecord(database, existing);
          if (
            JSON.stringify(existingEnvelope.draft) === JSON.stringify(draft)
          ) {
            // Stable input keeps the original ciphertext digest/commit receipt,
            // so concurrent Save taps converge on one PKM mutation identity.
            return existingEnvelope.metadata;
          }
        }
        const createdAtMs =
          existing &&
          validRecord(existing, nowMs) &&
          Number.isFinite(existing.createdAtMs)
            ? existing.createdAtMs
            : nowMs;
        // Re-saving form copy may replace ciphertext, but it must never slide
        // the lifetime of sensitive pre-vault data beyond the first staging.
        const expiresAtMs = createdAtMs + DRAFT_TTL_MS;
        if (expiresAtMs <= nowMs) {
          throw new OneLocationPreVaultDraftUnavailableError(
            "The Location draft expired. Resume setup before continuing.",
          );
        }
        const recordBase = {
          id,
          ownerHash,
          version: RECORD_VERSION as typeof RECORD_VERSION,
          draftSchemaVersion: DRAFT_SCHEMA_VERSION,
          workflowId: run.workflowId,
          workflowVersion: run.workflowVersion,
          graphRevision: run.graphRevision,
          runId: run.runId,
          runRevision: run.revision,
          status: "staged" as const,
          createdAtMs,
          updatedAtMs: nowMs,
          expiresAtMs,
        };
        if (!existing) {
          // Persist a non-sensitive marker before native/WebCrypto key
          // creation. If the process dies after key creation but before the
          // ciphertext commit, account/expiry cleanup can still find and
          // remove that otherwise-orphaned key.
          const markerTransaction = database.transaction(
            DRAFT_STORE,
            "readwrite",
          );
          const markerDone = transactionDone(markerTransaction);
          markerTransaction.objectStore(DRAFT_STORE).put({
            ...recordBase,
            status: "staging",
            digest: "",
            iv: new ArrayBuffer(0),
            ciphertext: new ArrayBuffer(0),
          });
          await markerDone;
        }
        const aad = additionalData(recordBase);
        const plaintext = textEncoder.encode(JSON.stringify(draft));
        let sealed: SealedBytes;
        try {
          sealed = await sealBytes(database, id, plaintext, aad);
        } finally {
          plaintext.fill(0);
        }
        const digestBytes = new Uint8Array(
          aad.byteLength + sealed.iv.byteLength + sealed.ciphertext.byteLength,
        );
        digestBytes.set(new Uint8Array(aad), 0);
        digestBytes.set(new Uint8Array(sealed.iv), aad.byteLength);
        digestBytes.set(
          new Uint8Array(sealed.ciphertext),
          aad.byteLength + sealed.iv.byteLength,
        );
        let digest: string;
        try {
          digest = await sha256(digestBytes);
        } finally {
          digestBytes.fill(0);
        }
        const record: StoredDraftV2 = {
          ...recordBase,
          digest,
          iv: sealed.iv,
          ciphertext: sealed.ciphertext,
        };
        const transaction = database.transaction(DRAFT_STORE, "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(DRAFT_STORE).put(record);
        await done;
        return metadata(record);
      } catch (error) {
        if (error instanceof OneLocationPreVaultDraftUnavailableError) {
          throw error;
        }
        throw new OneLocationPreVaultDraftUnavailableError();
      } finally {
        database.close();
      }
    });
  }

  static async read(
    userId: string,
    runValue: unknown,
    nowMs = Date.now(),
  ): Promise<OneLocationPreVaultDraftEnvelope | null> {
    assertValidClock(nowMs);
    const run = normalizedRun(runValue);
    const ownerHash = await ownerKey(userId);
    const id = await recordIdentity(ownerHash, run);
    return exclusive(ownerHash, async () => {
      const database = await openDatabase();
      try {
        const record = await readStoredDraft(database, id);
        if (!record) return null;
        if (!validRecord(record, nowMs) || record.expiresAtMs <= nowMs) {
          await deleteRecords(database, [id]);
          return null;
        }
        if (
          record.ownerHash !== ownerHash ||
          record.workflowId !== run.workflowId ||
          record.workflowVersion !== run.workflowVersion ||
          record.graphRevision !== run.graphRevision ||
          record.runId !== run.runId ||
          run.revision < record.runRevision
        ) {
          throw new OneLocationPreVaultDraftUnavailableError(
            "The Location task changed. Resume it before continuing.",
          );
        }
        return await decryptRecord(database, record);
      } finally {
        database.close();
      }
    });
  }

  /** Read the latest on-device draft for post-vault finalization. */
  static async readCurrent(
    userId: string,
    nowMs = Date.now(),
  ): Promise<OneLocationPreVaultDraftEnvelope | null> {
    assertValidClock(nowMs);
    const ownerHash = await ownerKey(userId);
    return exclusive(ownerHash, async () => {
      const database = await openDatabase();
      try {
        const records = await readOwnerDrafts(database, ownerHash);
        const expiredIds = records
          .filter(
            (record) =>
              !validRecord(record, nowMs) || record.expiresAtMs <= nowMs,
          )
          .map((record) => record.id)
          .filter(Boolean);
        await deleteRecords(database, expiredIds);
        const current = records
          .filter(
            (record) =>
              validRecord(record, nowMs) &&
              record.expiresAtMs > nowMs &&
              record.ownerHash === ownerHash,
          )
          .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
        return current ? decryptRecord(database, current) : null;
      } finally {
        database.close();
      }
    });
  }

  /**
   * Recover only the opaque workflow binding when ciphertext or its key is
   * unavailable. This deliberately does not expose draft fields and exists so
   * the server can consume `draft_unavailable` instead of trapping the run in
   * awaiting-vault forever.
   */
  static async readRecoveryBinding(
    userId: string,
    nowMs = Date.now(),
  ): Promise<OneLocationPreVaultDraftRecoveryBinding | null> {
    assertValidClock(nowMs);
    const ownerHash = await ownerKey(userId);
    return exclusive(ownerHash, async () => {
      const database = await openDatabase();
      try {
        const records = await readOwnerDrafts(database, ownerHash);
        const expiredIds = records
          .filter(
            (record) =>
              !validRecord(record, nowMs) || record.expiresAtMs <= nowMs,
          )
          .map((record) => record.id)
          .filter(Boolean);
        await deleteRecords(database, expiredIds);
        const current = records
          .filter(
            (record) =>
              validRecord(record, nowMs) &&
              record.expiresAtMs > nowMs &&
              record.ownerHash === ownerHash,
          )
          .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
        return current
          ? { ...binding(current), digest: current.digest }
          : null;
      } finally {
        database.close();
      }
    });
  }

  /** Read only the opaque cleanup binding for one known run. */
  static async readRecoveryBindingForRun(
    userId: string,
    runId: string,
    nowMs = Date.now(),
  ): Promise<OneLocationPreVaultDraftRecoveryBinding | null> {
    assertValidClock(nowMs);
    const cleanRunId = String(runId || "").trim();
    if (!cleanRunId) {
      throw new OneLocationPreVaultDraftUnavailableError(
        "The Location cleanup binding is invalid.",
      );
    }
    const ownerHash = await ownerKey(userId);
    return exclusive(ownerHash, async () => {
      const database = await openDatabase();
      try {
        const records = await readOwnerDrafts(database, ownerHash);
        const candidates = records.filter(
          (record) =>
            record.ownerHash === ownerHash && record.runId === cleanRunId,
        );
        const expiredIds = candidates
          .filter(
            (record) =>
              !validRecord(record, nowMs) || record.expiresAtMs <= nowMs,
          )
          .map((record) => record.id)
          .filter(Boolean);
        await deleteRecords(database, expiredIds);
        const current = candidates
          .filter(
            (record) =>
              validRecord(record, nowMs) && record.expiresAtMs > nowMs,
          )
          .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
        return current
          ? { ...binding(current), digest: current.digest }
          : null;
      } finally {
        database.close();
      }
    });
  }

  /**
   * Seal the deterministic opaque PKM commit reference before dispatch. The
   * backend remains the authority for whether that commit exists; retaining
   * the locator first closes the response-loss window without persisting a
   * vault key, owner token, or plaintext place.
   */
  static async markPkmCommitted(
    userId: string,
    runId: string,
    commitRef: string,
    nowMs = Date.now(),
  ): Promise<OneLocationPreVaultDraftEnvelope> {
    assertValidClock(nowMs);
    const cleanRunId = String(runId || "").trim();
    const cleanCommitRef = String(commitRef || "").trim();
    if (!cleanRunId || !COMMIT_REF_PATTERN.test(cleanCommitRef)) {
      throw new OneLocationPreVaultDraftUnavailableError(
        "The Location save receipt is invalid.",
      );
    }
    const ownerHash = await ownerKey(userId);
    return exclusive(ownerHash, async () => {
      const database = await openDatabase();
      try {
        const records = await readOwnerDrafts(database, ownerHash);
        const record = records
          .filter(
            (candidate) =>
              validRecord(candidate, nowMs) &&
              candidate.ownerHash === ownerHash &&
              candidate.runId === cleanRunId &&
              candidate.expiresAtMs > nowMs,
          )
          .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
        if (!record) {
          throw new OneLocationPreVaultDraftUnavailableError(
            "The Location draft expired. Resume setup before continuing.",
          );
        }
        const commitPlaintext = textEncoder.encode(
          JSON.stringify({ commitRef: cleanCommitRef }),
        );
        let sealedCommit: SealedBytes;
        try {
          sealedCommit = await sealBytes(
            database,
            record.id,
            commitPlaintext,
            commitAdditionalData(record),
          );
        } finally {
          commitPlaintext.fill(0);
        }
        const updated: StoredDraftV2 = {
          ...record,
          commitIv: sealedCommit.iv,
          commitCiphertext: sealedCommit.ciphertext,
        };
        const transaction = database.transaction(DRAFT_STORE, "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(DRAFT_STORE).put(updated);
        await done;
        return decryptRecord(database, updated);
      } finally {
        database.close();
      }
    });
  }

  static async clear(userId: string): Promise<void> {
    const ownerHash = await ownerKey(userId);
    await exclusive(ownerHash, async () => {
      const database = await openDatabase();
      try {
        const records = await readOwnerDrafts(database, ownerHash);
        await deleteRecords(
          database,
          records.map((record) => record.id).filter(Boolean),
        );
      } finally {
        database.close();
      }
    });
  }

  /**
   * Delete only the draft that an already-settled workflow operation consumed.
   * A newer run (or a restaged revision/digest) for the same owner survives.
   */
  static async clearExact(
    userId: string,
    runId: string,
    revision: number,
    digest: string,
  ): Promise<boolean> {
    const cleanRunId = String(runId || "").trim();
    const cleanDigest = String(digest || "").trim().toLowerCase();
    if (
      !cleanRunId ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !/^[0-9a-f]{64}$/u.test(cleanDigest)
    ) {
      throw new OneLocationPreVaultDraftUnavailableError(
        "The Location cleanup binding is invalid.",
      );
    }
    const ownerHash = await ownerKey(userId);
    return exclusive(ownerHash, async () => {
      const database = await openDatabase();
      try {
        const records = await readOwnerDrafts(database, ownerHash);
        const ids = records
          .filter(
            (record) =>
              record.ownerHash === ownerHash &&
              record.runId === cleanRunId &&
              record.runRevision === revision &&
              record.digest === cleanDigest,
          )
          .map((record) => record.id)
          .filter(Boolean);
        await deleteRecords(database, ids);
        return ids.length > 0;
      } finally {
        database.close();
      }
    });
  }
}
