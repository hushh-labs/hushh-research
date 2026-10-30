/**
 * Location as a standing property of the account, not a per-open request.
 *
 * Every other app the owner uses — a ride app, a delivery app — asks for
 * location once and then simply knows where they are. One did not, and the
 * reason was not the permission: iOS and every browser already remember the
 * grant durably. The reason was that One held the *answer* in memory only.
 * `LocationBus` kept its snapshot in a module variable and the Nearby drawer
 * kept its fallback in a `useRef`, so a reload, a navigation, or an app
 * relaunch wiped both. A cold start therefore had nothing to show, and the
 * first transient GPS failure — `kCLErrorLocationUnknown`, which macOS and
 * desktop Chrome emit routinely because there is no GPS radio — had no fallback
 * to land on. The owner read that as "One keeps losing my location".
 *
 * This module is the durable half. It remembers two separate things, because
 * they carry very different weight:
 *
 *   1. **The grant** — that this account has, at some point, actually produced
 *      a fix. Not a coordinate; a fact about consent. Plain storage is right
 *      for it, exactly as `location-control-state.ts` stores pause and
 *      auto-approve. It is what lets a surface stop treating a cold start as
 *      "never asked" and stop leading with a permission primer at someone who
 *      granted months ago.
 *
 *   2. **The last known fix** — an actual coordinate, and therefore never
 *      written in the clear. It is sealed with `encryptLocationForRecipient`
 *      against the owner's *own* recipient key, which already lives in
 *      IndexedDB with a native Keychain mirror. On disk it is the same opaque
 *      envelope the backend is trusted with, so persisting it concedes nothing
 *      the architecture had not already decided was safe. Anyone reading
 *      localStorage — another script, a shared device, a forensic dump — sees
 *      ciphertext.
 *
 * Two independent clocks bound the coordinate, and they answer different
 * questions:
 *
 *   - **Retention** (`LAST_KNOWN_FIX_RETENTION_MS`): how long we are willing to
 *     keep it at all. Past this the record is deleted on sight, so a coordinate
 *     nobody will ever use does not sit on the device indefinitely.
 *   - **Usability** (the caller's `maxAgeMs`): how long it stays honest as an
 *     answer to "where are you now". The Nearby drawer allows ten minutes; a
 *     map centring hint can allow far more. The store does not decide this,
 *     because the store does not know what the answer is for.
 *
 * Retention is deliberately the longer of the two. A fix we may not present as
 * current is still worth keeping, because it is what stops the *next* cold
 * start from being empty.
 *
 * The grant window is long on purpose. Ninety days, renewed on every fix, means
 * an account in normal use never loses it — which is the whole point. It is a
 * memory of consent, never a substitute for it: the OS is still asked, the OS
 * still decides, and a denial still wins. This record only stops One from
 * *forgetting* an answer the owner already gave.
 */

import {
  decryptLocationEnvelope,
  ensureLocationRecipientKey,
  encryptLocationForRecipient,
} from "@/lib/one-location/encryption";
import type {
  OneLocationEncryptedEnvelope,
  PlainLocationPoint,
} from "@/lib/one-location/types";

const GRANT_KEY_PREFIX = "one_location_grant_v1:";
const LAST_FIX_KEY_PREFIX = "one_location_last_fix_v1:";

/**
 * How long a remembered grant stays valid without a single successful fix.
 *
 * Renewed every time one lands, so this is the *idle* window, not a countdown
 * on the account. Ninety days is chosen to be longer than any plausible gap
 * between two uses of a location feature; the owner asked not to be re-asked,
 * and an expiry they can reach in normal use would not honour that.
 */
export const LOCATION_GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

/**
 * How long a sealed coordinate is kept on the device at all.
 *
 * Twenty-four hours: long enough that yesterday's session still hands today's
 * cold start something to draw, short enough that a device left behind does not
 * carry a week of movement. Distinct from how long a fix may be *presented* as
 * current, which every caller decides for itself.
 */
export const LAST_KNOWN_FIX_RETENTION_MS = 24 * 60 * 60 * 1_000;

/**
 * What the account has already told the platform about location.
 *
 * `grantedAt` is the first observed success and never moves — it is the answer
 * to "since when". `lastConfirmedAt` moves with every fix and is what the TTL
 * is measured against.
 */
export type LocationGrantMemory = {
  grantedAt: string;
  lastConfirmedAt: string;
};

type StoredGrant = Partial<LocationGrantMemory>;

type StoredFix = {
  envelope: OneLocationEncryptedEnvelope;
  /** Mirrored outside the ciphertext so age can be judged without decrypting. */
  capturedAt: string;
  storedAt: string;
};

/**
 * Storage that is allowed to be missing.
 *
 * Server rendering has none, Safari private browsing throws on access, and an
 * embedded webview can disable it outright. None of those are location
 * failures, so every path here degrades to the old in-memory behaviour rather
 * than surfacing an error the owner cannot act on.
 */
function storage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function grantKey(userId: string): string {
  return `${GRANT_KEY_PREFIX}${userId}`;
}

function lastFixKey(userId: string): string {
  return `${LAST_FIX_KEY_PREFIX}${userId}`;
}

function readJson<T>(store: Storage, key: string): T | null {
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    // A record we cannot parse is a record we cannot trust. Drop it rather
    // than let it fail the same way on every subsequent read.
    try {
      store.removeItem(key);
    } catch {
      /* Nothing further to do; the next write overwrites it. */
    }
    return null;
  }
}

function isIsoWithin(value: unknown, windowMs: number): boolean {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const age = Date.now() - parsed;
  // A timestamp from the future means a clock change, not a fresh fix. Treat it
  // as unusable rather than as infinitely valid.
  return age >= 0 && age <= windowMs;
}

/**
 * Record that this account has produced a real fix.
 *
 * Call only after a coordinate actually arrives. A permission API answering
 * "granted" is not the same fact — it is a claim about a setting, and on Safari
 * it cannot be read at all. A coordinate is proof.
 */
export function rememberLocationGrant(userId: string | null | undefined): void {
  if (!userId) return;
  const store = storage();
  if (!store) return;
  const now = new Date().toISOString();
  const existing = readJson<StoredGrant>(store, grantKey(userId));
  const grantedAt =
    typeof existing?.grantedAt === "string" &&
    Number.isFinite(Date.parse(existing.grantedAt))
      ? existing.grantedAt
      : now;
  try {
    store.setItem(
      grantKey(userId),
      JSON.stringify({ grantedAt, lastConfirmedAt: now }),
    );
  } catch {
    // A blocked write costs continuity across reloads, nothing more. The
    // in-session behaviour is unchanged, so there is nothing to report.
  }
}

/** The remembered grant, or null when there is none or it has gone stale. */
export function readLocationGrant(
  userId: string | null | undefined,
): LocationGrantMemory | null {
  if (!userId) return null;
  const store = storage();
  if (!store) return null;
  const stored = readJson<StoredGrant>(store, grantKey(userId));
  if (!stored) return null;
  if (!isIsoWithin(stored.lastConfirmedAt, LOCATION_GRANT_TTL_MS)) {
    try {
      store.removeItem(grantKey(userId));
    } catch {
      /* Best effort; an expired record is already treated as absent. */
    }
    return null;
  }
  return {
    grantedAt:
      typeof stored.grantedAt === "string" ? stored.grantedAt : stored.lastConfirmedAt!,
    lastConfirmedAt: stored.lastConfirmedAt!,
  };
}

/**
 * Has this account already granted location on this device?
 *
 * Answers the UI question "do we lead with an explanation, or with a map?" —
 * never the runtime question "may we read the GPS?", which only the platform
 * can answer and which is asked separately every time.
 */
export function hasRememberedLocationGrant(
  userId: string | null | undefined,
): boolean {
  return readLocationGrant(userId) !== null;
}

/**
 * Seal a fix and keep it for the next cold start.
 *
 * Failures are swallowed by design. This is a convenience layer over a feature
 * that already worked; a device without Web Crypto, without a recipient key, or
 * with a full storage quota should lose the *improvement*, not the feature.
 */
export async function rememberLastKnownFix(params: {
  userId: string | null | undefined;
  point: PlainLocationPoint;
}): Promise<void> {
  const { userId, point } = params;
  if (!userId) return;
  const store = storage();
  if (!store) return;
  if (!Number.isFinite(point?.latitude) || !Number.isFinite(point?.longitude)) {
    return;
  }
  try {
    const key = await ensureLocationRecipientKey(userId);
    const envelope = await encryptLocationForRecipient({
      // Drive and Check-In payloads belong to a share, not to "where I last
      // was". Persisting them would keep a destination or a venue on the device
      // long after the share that justified it ended.
      point: {
        latitude: point.latitude,
        longitude: point.longitude,
        accuracyM: point.accuracyM ?? null,
        capturedAt: point.capturedAt,
        sourcePlatform: point.sourcePlatform,
      },
      recipientPublicKeyJwk: key.publicKeyJwk,
      recipientKeyId: key.keyId,
    });
    const record: StoredFix = {
      envelope,
      capturedAt: point.capturedAt,
      storedAt: new Date().toISOString(),
    };
    store.setItem(lastFixKey(userId), JSON.stringify(record));
  } catch {
    // No key, no crypto, or no quota. The session keeps its in-memory fix.
  }
}

/**
 * The last sealed fix, when it is both retained and young enough to use.
 *
 * `maxAgeMs` is the caller's honesty budget: how old a coordinate may be and
 * still be offered as "where you are". Anything older is left on disk until
 * retention expires, because a fix too stale to *present* is still the best
 * starting point the next attempt has.
 */
export async function readLastKnownFix(params: {
  userId: string | null | undefined;
  maxAgeMs: number;
}): Promise<PlainLocationPoint | null> {
  const { userId, maxAgeMs } = params;
  if (!userId) return null;
  const store = storage();
  if (!store) return null;
  const stored = readJson<StoredFix>(store, lastFixKey(userId));
  if (!stored?.envelope) return null;

  if (!isIsoWithin(stored.storedAt, LAST_KNOWN_FIX_RETENTION_MS)) {
    forgetLastKnownFix(userId);
    return null;
  }
  if (!isIsoWithin(stored.capturedAt, maxAgeMs)) return null;

  try {
    const point = await decryptLocationEnvelope({
      userId,
      envelope: stored.envelope,
    });
    if (!Number.isFinite(point?.latitude) || !Number.isFinite(point?.longitude)) {
      forgetLastKnownFix(userId);
      return null;
    }
    return point;
  } catch {
    // Deliberately kept, not deleted.
    //
    // A failed decrypt looks the same whether the recipient key rotated away
    // for good or simply has not been provisioned yet — key bootstrap is async
    // and a surface can read before it finishes. Deleting would turn that race
    // into permanent data loss for someone whose fix was perfectly good.
    // Retention clears it soon enough either way, and the cost of being wrong
    // in this direction is one cheap failed decrypt per cold start.
    return null;
  }
}

/** Drop the sealed coordinate, keeping the grant. */
export function forgetLastKnownFix(userId: string | null | undefined): void {
  if (!userId) return;
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(lastFixKey(userId));
  } catch {
    /* Best effort. */
  }
}

/**
 * Forget everything this module remembers for an account.
 *
 * Belongs on sign-out and on any "stop tracking me" control: a durable memory
 * of location must be as easy to revoke as it was to create.
 */
export function forgetLocationMemory(userId: string | null | undefined): void {
  if (!userId) return;
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(grantKey(userId));
  } catch {
    /* Best effort. */
  }
  forgetLastKnownFix(userId);
}
