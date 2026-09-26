"use client";

/**
 * The owner's direct line to their private agent.
 *
 * Until now every turn travelled browser -> hub -> pod, and the hub verified the
 * owner on every hop. The owner-direct path pins the pod's address once (a signed,
 * versioned endpoint record from the hub), enrols THIS app installation as a
 * subject with a non-extractable P-256 key, obtains a hub-signed binding for it,
 * and opens a session at the pod by proving possession of that key. From then on
 * the turn goes browser -> pod, with the pod's own authority answering the
 * consent question and the hub out of the conversation path.
 *
 * Rules this module enforces, because the pod cannot enforce them for the app:
 *
 *   * a lower `endpointVersion` is refused (an old record cannot re-point us);
 *   * a changed `podKeyId` without a higher `endpointVersion` is refused;
 *   * the app key is generated non-extractable and only its handle is stored, so
 *     the private material cannot be exported (the handle can still sign);
 *   * a revocation the pod could not receive is queued as an owner-signed intent
 *     and couriered through the hub as "revocation pending delivery", never
 *     silently dropped and never reported as done.
 *
 * Storage is IndexedDB (a `CryptoKey` handle is only storable there), falling
 * back to process memory where IndexedDB is absent (SSR, tests without a fake)
 * so nothing here can throw during a render.
 */

import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";

import { OwnerPodError, canonicalJson, p1363ToDer, readJson, subtle, verifyHubSignature } from "./owner-pod-crypto";
export { OwnerPodError, canonicalJson, p1363ToDer } from "./owner-pod-crypto";

export const OWNER_POD_DB_NAME = "hushh-owner-pod";
const DB_VERSION = 1;
const KEY_STORE = "app_keys";
const PIN_STORE = "pins";

/** The pod-session bearer prefix; the pod refuses anything else by shape. */
export const POD_SESSION_PREFIX = "pst1.";
/** Renew this long before expiry so a turn never starts on a dying session. */
const SESSION_RENEW_MARGIN_MS = 60 * 60 * 1000;
const SESSION_USABLE_MARGIN_MS = 60 * 1000;

export type PinnedEndpoint = {
  hushhId: string;
  url: string;
  podKeyId: string;
  environment: string;
  endpointVersion: number;
  signature: string;
  pinnedAt: number;
  /** Pins from the former prefix-only verifier must be admitted again once. */
  verificationVersion: 1;
};

export type PodSessionRecord = {
  session: string;
  sid: string;
  role: "app";
  scopes: string[];
  epoch: number;
  expiresAt: number;
  version: number;
  subjectId: string;
  /** Verified grant ceiling; renewal cannot extend owner authorization. */
  grantExpiresAt?: number;
};

export type PendingRevocation = {
  intentId: string;
  subjectId: string;
  atVersion: number;
  queuedAt: number;
  /** The hub accepted the courier request; the pod applies it on its next beat. */
  couriered: boolean;
};

type AppKeyRecord = {
  userId: string;
  key: CryptoKeyPair;
  publicKeyB64: string;
  subjectId: string | null;
};

type PinRecord = {
  userId: string;
  endpoint: PinnedEndpoint | null;
  session: PodSessionRecord | null;
  pendingRevocations: PendingRevocation[];
};


/**
 * The two transports the module needs, injected so tests drive it without a
 * browser: `hub` reaches the hub with the owner's Firebase bearer already applied
 * (`ApiService.apiFetch` plus the token), `direct` reaches an absolute pod URL.
 */
export type OwnerPodTransport = {
  hub: (path: string, init: RequestInit) => Promise<Response>;
  direct: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
};

// -- storage ------------------------------------------------------------------------

const memoryKeys = new Map<string, AppKeyRecord>();
const memoryPins = new Map<string, PinRecord>();

function indexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

async function openDb(): Promise<IDBDatabase | null> {
  if (!indexedDbAvailable()) return null;
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open(OWNER_POD_DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE, { keyPath: "userId" });
      }
      if (!db.objectStoreNames.contains(PIN_STORE)) {
        db.createObjectStore(PIN_STORE, { keyPath: "userId" });
      }
    };
    request.onblocked = () => reject(new OwnerPodError("STORAGE_BLOCKED"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new OwnerPodError("STORAGE_UNAVAILABLE"));
  });
}

async function readRecord<T>(store: string, userId: string): Promise<T | null> {
  const db = await openDb();
  if (!db) {
    const fallback = store === KEY_STORE ? memoryKeys : memoryPins;
    return (fallback.get(userId) as T | undefined) ?? null;
  }
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const request = db.transaction(store, "readonly").objectStore(store).get(userId);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new OwnerPodError("STORAGE_READ_FAILED"));
    });
  } finally {
    db.close();
  }
}

async function writeRecord<T extends { userId: string }>(store: string, record: T): Promise<void> {
  const db = await openDb();
  if (!db) {
    const fallback = store === KEY_STORE ? memoryKeys : memoryPins;
    (fallback as unknown as Map<string, T>).set(record.userId, record);
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new OwnerPodError("STORAGE_WRITE_FAILED"));
      tx.onabort = () => reject(tx.error ?? new OwnerPodError("STORAGE_WRITE_ABORTED"));
    });
  } finally {
    db.close();
  }
}

async function readPin(userId: string): Promise<PinRecord> {
  const stored = await readRecord<PinRecord>(PIN_STORE, userId);
  if (stored?.endpoint && stored.endpoint.verificationVersion !== 1) {
    return { ...stored, endpoint: null, session: null };
  }
  if (stored?.session && !Number.isInteger(stored.session.grantExpiresAt)) {
    return { ...stored, session: null };
  }
  return stored ?? {
      userId,
      endpoint: null,
      session: null,
      pendingRevocations: [],
    };
}

/** Test and sign-out hook: forget everything held for one account. */
export async function forgetOwnerPodState(userId: string): Promise<void> {
  memoryKeys.delete(userId);
  memoryPins.delete(userId);
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([KEY_STORE, PIN_STORE], "readwrite");
      tx.objectStore(KEY_STORE).delete(userId);
      tx.objectStore(PIN_STORE).delete(userId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new OwnerPodError("STORAGE_WRITE_FAILED"));
    });
  } finally {
    db.close();
  }
}

// -- the app key ----------------------------------------------------------------------


async function ensureAppKey(userId: string): Promise<AppKeyRecord> {
  const existing = await readRecord<AppKeyRecord>(KEY_STORE, userId);
  if (existing) return existing;
  const key = await subtle().generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false, // non-extractable: the handle is stored, the material never leaves
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await subtle().exportKey("spki", key.publicKey));
  const record: AppKeyRecord = {
    userId,
    key,
    publicKeyB64: bytesToBase64(spki),
    subjectId: null,
  };
  await writeRecord(KEY_STORE, record);
  return record;
}

async function signWithAppKey(record: AppKeyRecord, payload: string): Promise<string> {
  const raw = new Uint8Array(
    await subtle().sign(
      { name: "ECDSA", hash: "SHA-256" },
      record.key.privateKey,
      new TextEncoder().encode(payload),
    ),
  );
  return bytesToBase64(p1363ToDer(raw));
}


function detailCode(body: Record<string, unknown>): string {
  const detail = body.detail;
  if (detail && typeof detail === "object" && "code" in detail) {
    return String((detail as { code?: unknown }).code ?? "");
  }
  return typeof detail === "string" ? detail : "";
}

// -- enrolment and discovery ---------------------------------------------------------

/** Enrol THIS installation as an app subject of the owner's pod. Idempotent. */
export async function ensureAppEnrollment(
  userId: string,
  transport: OwnerPodTransport,
  deviceName = "This browser",
): Promise<string> {
  const record = await ensureAppKey(userId);
  if (record.subjectId) return record.subjectId;
  const response = await transport.hub("/api/account/trusted-devices/self-enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      devicePublicKey: record.publicKeyB64,
      deviceName,
      platform: "web",
    }),
  });
  if (!response.ok) {
    throw new OwnerPodError(`SELF_ENROLL_FAILED:${response.status}`);
  }
  const body = await readJson(response);
  const subjectId = String(body.device_id ?? "");
  if (!subjectId) throw new OwnerPodError("SELF_ENROLL_FAILED:no_device_id");
  await writeRecord(KEY_STORE, { ...record, subjectId });
  return subjectId;
}

/**
 * Read the hub's signed endpoint record. A new endpoint is committed only after
 * the pod accepts this app's owner-bound session on that exact address.
 */
export async function refreshEndpointFromHub(
  userId: string,
  transport: OwnerPodTransport,
): Promise<PinnedEndpoint> {
  const response = await transport.hub("/api/one/personal-agent/endpoint", {
    method: "GET",
    cache: "no-store",
  });
  if (!response.ok) {
    const code = detailCode(await readJson(response));
    throw new OwnerPodError(code ? `ENDPOINT_UNAVAILABLE:${code}` : `ENDPOINT_UNAVAILABLE:${response.status}`);
  }
  const body = await readJson(response);
  const { signature: endpointSignature, ...signedEndpoint } = body;
  if (body.kind !== "pod_endpoint_v1") throw new OwnerPodError("ENDPOINT_MALFORMED");
  await verifyHubSignature(signedEndpoint, String(endpointSignature ?? ""), transport);
  const candidate: PinnedEndpoint = {
    hushhId: String(body.hushhId ?? ""),
    url: String(body.url ?? "").replace(/\/+$/, ""),
    podKeyId: String(body.podKeyId ?? ""),
    environment: String(body.environment ?? ""),
    endpointVersion: Number(body.endpointVersion ?? 0),
    signature: String(body.signature ?? ""),
    pinnedAt: (transport.now ?? Date.now)(),
    verificationVersion: 1,
  };
  let endpointUrl: URL | null = null;
  try {
    endpointUrl = new URL(candidate.url);
  } catch {
    // The malformed-record branch below supplies the stable refusal code.
  }
  if (
    endpointUrl?.protocol !== "https:" ||
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.pathname !== "/" ||
    endpointUrl.search ||
    endpointUrl.hash ||
    candidate.hushhId === "" ||
    !candidate.environment ||
    !candidate.podKeyId ||
    !candidate.hushhId ||
    !Number.isInteger(candidate.endpointVersion) ||
    candidate.endpointVersion < 1 ||
    !candidate.signature.startsWith("ed25519.")
  ) {
    throw new OwnerPodError("ENDPOINT_MALFORMED");
  }
  const pin = await readPin(userId);
  const current = pin.endpoint;
  if (current) {
    if (candidate.hushhId !== current.hushhId || candidate.environment !== current.environment) {
      throw new OwnerPodError("ENDPOINT_OWNER_OR_ENVIRONMENT_CHANGED");
    }
    if (candidate.endpointVersion < current.endpointVersion) {
      throw new OwnerPodError("ENDPOINT_VERSION_REGRESSION");
    }
    if (
      candidate.endpointVersion === current.endpointVersion &&
      (candidate.podKeyId !== current.podKeyId || candidate.url !== current.url)
    ) {
      throw new OwnerPodError("ENDPOINT_CHANGED_WITHOUT_VERSION_BUMP");
    }
    if (candidate.endpointVersion === current.endpointVersion) {
      return current;
    }
  }
  await admitEndpoint(userId, transport, candidate);
  return candidate;
}

export async function loadPinnedEndpoint(userId: string): Promise<PinnedEndpoint | null> {
  return (await readPin(userId)).endpoint;
}

// -- sessions ---------------------------------------------------------------------------

async function fetchBinding(
  subjectId: string,
  transport: OwnerPodTransport,
  endpoint: PinnedEndpoint,
  refreshGrant = false,
): Promise<{ binding: Record<string, unknown>; signature: string }> {
  const path = `/api/account/trusted-devices/${encodeURIComponent(subjectId)}/pod-binding`;
  let response = await transport.hub(path, { method: "GET", cache: "no-store" });
  let body = response.ok ? await readJson(response) : {};
  const existing = body.binding;
  const stale = existing && typeof existing === "object" && (
    (existing as Record<string, unknown>).pod_key_id !== endpoint.podKeyId ||
    (existing as Record<string, unknown>).url !== endpoint.url
  );
  if (response.status === 404 || stale || refreshGrant) {
    response = await transport.hub(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ puppyInference: false }),
    });
    body = response.ok ? await readJson(response) : {};
  }
  if (!response.ok) {
    const code = detailCode(await readJson(response));
    throw new OwnerPodError(code ? `BINDING_UNAVAILABLE:${code}` : `BINDING_UNAVAILABLE:${response.status}`);
  }
  const binding = body.binding;
  const signature = String(body.signature ?? "");
  if (!binding || typeof binding !== "object" || !signature) {
    throw new OwnerPodError("BINDING_MALFORMED");
  }
  await verifyHubSignature(binding as Record<string, unknown>, signature, transport);
  return { binding: binding as Record<string, unknown>, signature };
}

function sessionFromResponse(body: Record<string, unknown>, subjectId: string): PodSessionRecord {
  const session = String(body.session ?? "");
  if (
    !session.startsWith(POD_SESSION_PREFIX) || body.role !== "app" ||
    typeof body.sid !== "string" || !body.sid.startsWith("pss_") ||
    !Number.isInteger(body.epoch) || Number(body.epoch) < 1 ||
    !Number.isInteger(body.version) || Number(body.version) < 1 ||
    !Number.isInteger(body.expiresAt) || !Array.isArray(body.scopes) ||
    body.scopes.some((scope) => typeof scope !== "string") ||
    new Set(body.scopes).size !== body.scopes.length
  ) {
    throw new OwnerPodError("SESSION_MALFORMED");
  }
  return {
    session,
    sid: String(body.sid ?? ""),
    role: "app",
    scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : [],
    epoch: Number(body.epoch ?? 0),
    expiresAt: Number(body.expiresAt ?? 0),
    version: Number(body.version ?? 0),
    subjectId,
  };
}

/**
 * Open a pod session: binding from the hub, challenge and proof at the pod.
 * The role is whatever the signed binding says; the app never asks for one.
 */
async function admitEndpoint(
  userId: string,
  transport: OwnerPodTransport,
  endpoint: PinnedEndpoint,
  refreshGrant = false,
): Promise<PodSessionRecord> {
  const record = await ensureAppKey(userId);
  const subjectId = record.subjectId ?? (await ensureAppEnrollment(userId, transport));
  const { binding, signature } = await fetchBinding(subjectId, transport, endpoint, refreshGrant);
  if (String(binding.pod_key_id ?? "") !== endpoint.podKeyId) {
    throw new OwnerPodError("BINDING_POD_KEY_MISMATCH");
  }
  const now = (transport.now ?? Date.now)();
  if (
    binding.kind !== "pod_binding_v1" ||
    binding.hushh_id !== endpoint.hushhId ||
    binding.user_id !== userId ||
    binding.environment !== endpoint.environment ||
    binding.url !== endpoint.url ||
    binding.subject_id !== subjectId ||
    binding.subject_kind !== "app" ||
    binding.role !== "app" ||
    binding.platform !== "web" ||
    binding.subject_public_key !== record.publicKeyB64 ||
    binding.deployment_target !== "user_gcp" ||
    !Array.isArray(binding.scopes) ||
    !binding.scopes.includes("pkm.read") ||
    !Number.isInteger(binding.version) ||
    Number(binding.version) < 1 ||
    !Number.isInteger(binding.issued_at_ms) ||
    !Number.isInteger(binding.expires_at_ms) ||
    Number(binding.issued_at_ms) > now ||
    Number(binding.expires_at_ms) <= now
  ) {
    throw new OwnerPodError("BINDING_OWNER_OR_ENDPOINT_MISMATCH");
  }
  const challengeResponse = await transport.direct(`${endpoint.url}/api/one/pod/session/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subjectId }),
  });
  if (!challengeResponse.ok) {
    const code = detailCode(await readJson(challengeResponse));
    throw new OwnerPodError(code ? `POD_CHALLENGE_REFUSED:${code}` : `POD_CHALLENGE_REFUSED:${challengeResponse.status}`);
  }
  const challenge = await readJson(challengeResponse);
  const signingPayload = String(challenge.signingPayload ?? "");
  const expectedPayload = canonicalJson({
    challenge_id: challenge.challengeId,
    epoch: challenge.epoch,
    hushh_id: endpoint.hushhId,
    nonce: challenge.nonce,
    pod_key_id: endpoint.podKeyId,
    purpose: "pod-session-admission",
    subject_id: subjectId,
  });
  if (
    !String(challenge.challengeId ?? "").startsWith("psc_") ||
    !String(challenge.nonce ?? "") ||
    challenge.podKeyId !== endpoint.podKeyId ||
    !Number.isInteger(challenge.epoch) ||
    !Number.isInteger(challenge.expiresAt) ||
    Number(challenge.expiresAt) <= now ||
    signingPayload !== expectedPayload
  ) {
    throw new OwnerPodError("POD_CHALLENGE_MALFORMED");
  }
  const proof = await signWithAppKey(record, signingPayload);
  const admitResponse = await transport.direct(`${endpoint.url}/api/one/pod/session/admit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      binding,
      signature,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      proof,
      epoch: challenge.epoch,
    }),
  });
  if (!admitResponse.ok) {
    const code = detailCode(await readJson(admitResponse));
    throw new OwnerPodError(code ? `POD_ADMISSION_REFUSED:${code}` : `POD_ADMISSION_REFUSED:${admitResponse.status}`);
  }
  const session = sessionFromResponse(await readJson(admitResponse), subjectId);
  if (
    session.version !== binding.version ||
    session.epoch !== challenge.epoch ||
    session.expiresAt <= now ||
    session.expiresAt > Number(binding.expires_at_ms) ||
    session.scopes.some((scope) => !(binding.scopes as string[]).includes(scope)) ||
    !session.scopes.includes("pkm.read")
  ) {
    throw new OwnerPodError("SESSION_BINDING_MISMATCH");
  }
  session.grantExpiresAt = Number(binding.expires_at_ms);
  const pin = await readPin(userId);
  await writeRecord(PIN_STORE, { ...pin, endpoint, session });
  return session;
}

export async function openPodSession(
  userId: string,
  transport: OwnerPodTransport,
  refreshGrant = false,
): Promise<PodSessionRecord> {
  const pin = await readPin(userId);
  if (!pin.endpoint) throw new OwnerPodError("ENDPOINT_NOT_PINNED");
  return admitEndpoint(userId, transport, pin.endpoint, refreshGrant);
}

export async function renewPodSession(
  userId: string,
  transport: OwnerPodTransport,
): Promise<PodSessionRecord> {
  const pin = await readPin(userId);
  if (!pin.endpoint || !pin.session?.grantExpiresAt) return openPodSession(userId, transport);
  const now = (transport.now ?? Date.now)();
  if (pin.session.grantExpiresAt <= now) return openPodSession(userId, transport);
  const response = await transport.direct(`${pin.endpoint.url}/api/one/pod/session/renew`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pin.session.session}` },
  });
  if (!response.ok) {
    const code = detailCode(await readJson(response));
    if (code === "revoked") {
      await writeRecord(PIN_STORE, { ...pin, session: null });
      throw new OwnerPodError("POD_SESSION_REVOKED");
    }
    return openPodSession(userId, transport);
  }
  const session = sessionFromResponse(await readJson(response), pin.session.subjectId);
  if (
    session.version !== pin.session.version || session.epoch < pin.session.epoch ||
    session.expiresAt <= now || session.expiresAt > pin.session.grantExpiresAt ||
    !session.scopes.includes("pkm.read") ||
    session.scopes.some((scope) => !pin.session!.scopes.includes(scope))
  ) throw new OwnerPodError("SESSION_BINDING_MISMATCH");
  session.grantExpiresAt = pin.session.grantExpiresAt;
  await writeRecord(PIN_STORE, { ...pin, session });
  return session;
}

/** A session good for at least one more turn, renewing or reopening as needed. */
export async function currentPodSession(
  userId: string,
  transport: OwnerPodTransport,
): Promise<PodSessionRecord> {
  const pin = await readPin(userId);
  const now = (transport.now ?? Date.now)();
  const session = pin.session;
  if (session && session.expiresAt - now > SESSION_RENEW_MARGIN_MS) return session;
  if (session && session.expiresAt - now > SESSION_USABLE_MARGIN_MS) {
    try {
      return await renewPodSession(userId, transport);
    } catch (error) {
      // A transport outage may keep using a still-valid admission. An explicit
      // authority/verification refusal must not be hidden by the cached bearer.
      if (!(error instanceof TypeError)) throw error;
      return session;
    }
  }
  return openPodSession(userId, transport);
}

/** Read the matching endpoint and bearer together after any async renewal. */
export async function currentPodConnection(userId: string, transport: OwnerPodTransport): Promise<{
  endpoint: PinnedEndpoint; session: PodSessionRecord;
}> {
  const session = await currentPodSession(userId, transport);
  const pin = await readPin(userId);
  if (!pin.endpoint || pin.session?.session !== session.session) {
    throw new OwnerPodError("POD_CONNECTION_CHANGED");
  }
  return { endpoint: pin.endpoint, session };
}

// -- revocation --------------------------------------------------------------------------

export const TOMBSTONE_INTENT_KIND = "pod_tombstone_intent_v1";

function newIntentId(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return `pti_${bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/**
 * Revoke a subject at the pod. Pod first; when the pod cannot be reached the
 * revocation is signed by the app key and couriered through the hub, and the
 * caller is told it is PENDING DELIVERY rather than done.
 */
export async function revokeAtPod(
  userId: string,
  subjectId: string,
  transport: OwnerPodTransport,
  options: { atVersion?: number; reason?: string; hushhId?: string } = {},
): Promise<
  { delivered: true; pending: null } | { delivered: false; pending: PendingRevocation }
> {
  const pin = await readPin(userId);
  if (pin.endpoint && pin.session) {
    try {
      const response = await transport.direct(`${pin.endpoint.url}/api/one/pod/session/revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pin.session.session}`,
        },
        body: JSON.stringify({
          subjectId,
          atVersion: options.atVersion,
          reason: options.reason ?? "owner_revoked",
        }),
      });
      if (response.ok) return { delivered: true, pending: null };
      const code = detailCode(await readJson(response));
      if (code && code !== "fenced" && code !== "uncertain") {
        throw new OwnerPodError(`POD_REVOKE_REFUSED:${code}`);
      }
    } catch (error) {
      if (error instanceof OwnerPodError) throw error;
      // Network failure: fall through to the courier.
    }
  }
  const record = await ensureAppKey(userId);
  const signer = record.subjectId ?? (await ensureAppEnrollment(userId, transport));
  const intent = {
    kind: TOMBSTONE_INTENT_KIND,
    intentId: newIntentId(),
    hushhId: pin.endpoint?.hushhId ?? options.hushhId ?? "",
    subjectId,
    atVersion: options.atVersion ?? 1,
    issuedAtMs: (transport.now ?? Date.now)(),
    signerSubjectId: signer,
  };
  const signature = await signWithAppKey(record, canonicalJson(intent));
  const pending: PendingRevocation = {
    intentId: intent.intentId,
    subjectId,
    atVersion: intent.atVersion,
    queuedAt: intent.issuedAtMs,
    couriered: false,
  };
  const couriered = await transport.hub(
    `/api/account/trusted-devices/${encodeURIComponent(subjectId)}/pod-tombstone`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent, signature }),
    },
  );
  pending.couriered = couriered.ok;
  await writeRecord(PIN_STORE, {
    ...pin,
    pendingRevocations: [...pin.pendingRevocations.filter((p) => p.subjectId !== subjectId), pending],
  });
  return { delivered: false, pending };
}

export async function pendingRevocations(userId: string): Promise<PendingRevocation[]> {
  return (await readPin(userId)).pendingRevocations;
}

export async function clearPendingRevocation(userId: string, intentId: string): Promise<void> {
  const pin = await readPin(userId);
  await writeRecord(PIN_STORE, {
    ...pin,
    pendingRevocations: pin.pendingRevocations.filter((p) => p.intentId !== intentId),
  });
}

// -- helpers for callers ----------------------------------------------------------------

/** Decode a pod session's claims (unverified; the pod verifies). For display only. */
export function decodePodSessionClaims(session: string): Record<string, unknown> | null {
  if (!session.startsWith(POD_SESSION_PREFIX)) return null;
  const encoded = session.slice(POD_SESSION_PREFIX.length).split(".")[0] ?? "";
  try {
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (encoded.length % 4)) % 4);
    const text = new TextDecoder().decode(base64ToBytes(padded));
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
