import { validateLosslessDomainUpgrade } from "@/lib/personal-knowledge-model/upgrade-registry";

export type ReviewerPkmJson = null | boolean | number | string | ReviewerPkmJson[] | { [key: string]: ReviewerPkmJson };
type Json = ReviewerPkmJson;
type Snapshot = { userId: string; domain: string; contentRevision: number; data: Record<string, Json> };
export type ReviewerPkmExpectation = { domain: "financial" | "professional"; path: string[]; value: Json };
export type ReviewerPkmProofResult = { ok: boolean; code: "ready" | "verified" | "refused" | "mismatch" | "unavailable" };
export type ReviewerPkmProof = {
  begin: (expectation: ReviewerPkmExpectation) => Promise<ReviewerPkmProofResult>;
  verify: (savedRevision: number) => Promise<ReviewerPkmProofResult>;
};
export type ReviewerProjectionDigest =
  | { ok: true; code: "digest"; digest: string }
  | { ok: false; code: "refused" | "unavailable" };
export type ReviewerPkmBridge = {
  begin: () => Promise<ReviewerPkmProofResult>;
  verify: ReviewerPkmProof["verify"];
  projectionDigest: (scope: string) => Promise<ReviewerProjectionDigest>;
};

/** SHA-256 over sorted-key JSON; the same canonical form the rehearsal hashes. */
export async function canonicalJsonDigest(value: unknown): Promise<string> {
  const canonical = (item: unknown): unknown => Array.isArray(item)
    ? item.map(canonical)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical((item as Record<string, unknown>)[key])]))
      : item;
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function equal(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key =>
    Object.hasOwn(b, key) && equal((a as Record<string, Json>)[key]!, (b as Record<string, Json>)[key]!));
}

function validJson(value: unknown, depth = 0): value is Json {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value) && (Object.keys(value).length !== value.length ||
    !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean))) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).every(key => {
    if (Array.isArray(value) && key === "length") return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === "string" && descriptor.enumerable === true && "value" in descriptor &&
      validJson(descriptor.value, depth + 1);
  });
}

/** One additive proof, scoped by the caller's existing owner/vault guard. No plaintext outputs. */
export function createReviewerPkmProof(params: {
  owner: string;
  isCurrent: () => boolean;
  load: (domain: string) => Promise<Snapshot | null>;
}): ReviewerPkmProof & { dispose: () => void } {
  let claimed = false, disposed = false, verified = false;
  let baseline: Snapshot | null = null;
  let expected: Record<string, Json> | null = null;
  const dispose = () => { disposed = true; baseline = null; expected = null; };
  const current = () => {
    if (disposed || !params.isCurrent()) { dispose(); return false; }
    return true;
  };
  return {
    dispose,
    async begin(input) {
      if (claimed || !current()) return { ok: false, code: "refused" };
      claimed = true;
      try {
        if (!validJson(input)) return { ok: false, code: "refused" };
        const { domain, path, value } = structuredClone(input);
        if (!["financial", "professional"].includes(domain) || !Array.isArray(path) || !path.length ||
          !validJson(value) || path.some(part => typeof part !== "string" ||
          !part || ["__proto__", "prototype", "constructor"].includes(part))) return { ok: false, code: "refused" };
        const before = await params.load(domain);
        if (!current() || !before || before.userId !== params.owner || before.domain !== domain ||
          !Number.isSafeInteger(before.contentRevision) || !validJson(before.data)) return { ok: false, code: "refused" };
        const candidate = structuredClone(before.data);
        let parent: Record<string, Json> = candidate;
        for (const part of path.slice(0, -1)) {
          if (!Object.hasOwn(parent, part)) parent[part] = {};
          const child = parent[part];
          if (!child || typeof child !== "object" || Array.isArray(child)) return { ok: false, code: "refused" };
          parent = child;
        }
        const leaf = path.at(-1)!;
        if (Object.hasOwn(parent, leaf)) return { ok: false, code: "refused" };
        parent[leaf] = value;
        baseline = structuredClone(before);
        expected = candidate;
        return { ok: true, code: "ready" };
      } catch { dispose(); return { ok: false, code: "unavailable" }; }
    },
    async verify(savedRevision) {
      if (verified || !current() || !baseline || !expected || !Number.isSafeInteger(savedRevision) ||
        savedRevision <= baseline.contentRevision) return { ok: false, code: "refused" };
      verified = true;
      try {
        const before = baseline, afterExpected = expected;
        const after = await params.load(before.domain);
        if (!current() || !after || after.userId !== params.owner || after.domain !== before.domain ||
          after.contentRevision !== savedRevision || !validJson(after.data)) return { ok: false, code: "refused" };
        const ok = validateLosslessDomainUpgrade(before.data, after.data).preserved && equal(afterExpected, after.data);
        return { ok, code: ok ? "verified" : "mismatch" };
      } catch { return { ok: false, code: "unavailable" }; }
      finally { dispose(); }
    },
  };
}
