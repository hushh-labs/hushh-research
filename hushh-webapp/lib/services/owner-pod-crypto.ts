/** Canonical encoding and cryptographic verification for direct pod admission. */
import { base64ToBytes } from "@/lib/vault/base64";
import type { OwnerPodTransport } from "./owner-pod-endpoint";

export class OwnerPodError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "OwnerPodError";
  }
}

// -- canonical bytes shared with the pod -----------------------------------------

/**
 * Byte-exact with Python's `json.dumps(sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False)` for the value shapes used here (strings, integers, lists).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Verify issuer bytes before using an endpoint or signing an admission proof. */
export async function verifyHubSignature(
  payload: Record<string, unknown>,
  signature: string,
  transport: OwnerPodTransport,
): Promise<void> {
  const parts = signature.split(".");
  if (parts.length !== 3 || parts[0] !== "ed25519" || !parts[1] || !parts[2]) {
    throw new OwnerPodError("HUB_SIGNATURE_INVALID");
  }
  const response = await transport.hub(
    "/api/one/personal-agent/verification-keys",
    {
      method: "GET",
      cache: "no-store",
    },
  );
  if (!response.ok)
    throw new OwnerPodError("HUB_VERIFICATION_KEYS_UNAVAILABLE");
  const body = await readJson(response);
  const keys = body.keys;
  if (
    body.kind !== "pod_verification_keys_v1" ||
    !keys ||
    typeof keys !== "object"
  ) {
    throw new OwnerPodError("HUB_VERIFICATION_KEYS_UNAVAILABLE");
  }
  const encoded = (keys as Record<string, unknown>)[parts[1]];
  if (typeof encoded !== "string")
    throw new OwnerPodError("HUB_SIGNING_KEY_UNKNOWN");
  try {
    const raw = base64ToBytes(encoded);
    const sig = base64ToBytes(
      parts[2]
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(parts[2].length / 4) * 4, "="),
    );
    if (raw.length !== 32 || sig.length !== 64)
      throw new Error("Invalid length");
    const key = await subtle().importKey("raw", raw, "Ed25519", false, [
      "verify",
    ]);
    if (
      !(await subtle().verify(
        "Ed25519",
        key,
        sig,
        new TextEncoder().encode(canonicalJson(payload)),
      ))
    ) {
      throw new Error("Invalid signature");
    }
  } catch {
    throw new OwnerPodError("HUB_SIGNATURE_INVALID");
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * WebCrypto emits ECDSA signatures as raw `r || s` (IEEE P1363). The pod and hub
 * verify with `cryptography`, which expects DER. Convert once, here, so nothing
 * downstream ever sees the other shape.
 */
export function p1363ToDer(signature: Uint8Array): Uint8Array {
  const half = signature.length / 2;
  const r = trimAndPad(signature.slice(0, half));
  const s = trimAndPad(signature.slice(half));
  const body = new Uint8Array(2 + r.length + 2 + s.length);
  body.set([0x02, r.length], 0);
  body.set(r, 2);
  body.set([0x02, s.length], 2 + r.length);
  body.set(s, 4 + r.length);
  const der = new Uint8Array(2 + body.length);
  der.set([0x30, body.length], 0);
  der.set(body, 2);
  return der;
}

function trimAndPad(integer: Uint8Array): Uint8Array {
  let start = 0;
  while (start < integer.length - 1 && integer[start] === 0) start += 1;
  const trimmed = integer.slice(start);
  if ((trimmed[0] ?? 0) & 0x80) {
    const padded = new Uint8Array(trimmed.length + 1);
    padded.set(trimmed, 1);
    return padded;
  }
  return trimmed;
}

export function subtle(): SubtleCrypto {
  const api = globalThis.crypto?.subtle;
  if (!api) throw new OwnerPodError("WEBCRYPTO_UNAVAILABLE");
  return api;
}

export async function readJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => null)) as unknown;
  return body && typeof body === "object"
    ? (body as Record<string, unknown>)
    : {};
}
