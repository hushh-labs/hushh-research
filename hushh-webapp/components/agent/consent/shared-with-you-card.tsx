"use client";

/**
 * The secure "Shared with you" card with its on-device opening (CONTRACT-2
 * decision 2, C6). Chat renders it from One's card payload; Profile renders
 * one per person from the share list. Both pass the same `items`.
 *
 * Trust boundary: values are decrypted here with the person's own connector
 * key, kept only in this component's state, dropped when the vault locks,
 * the person changes, access ends or the export's window runs out, and never
 * written to storage, logs or the server.
 *
 * Opening is idempotent per item (measured 2026-09-29, R3 and R8: the card
 * discarded its open on every state change, so an open that needed three slow
 * reads never finished and sat on "Opening on this device…" for 20 minutes).
 * An item has at most one open in flight; a re-render, a new array of the same
 * items or an unrelated consent event never cancels it. Only a real change
 * does: a different item or grant, a lock, a different person, or that
 * access ending.
 *
 * Access ending: the card registers what it shows with the app-wide live
 * access watch (about 5s for a minute after an answer, then 10s, while
 * visible) and takes every reading of those bundles, and of the share list,
 * whoever made it. An ended item's values leave memory at once.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import {
  informationRequestOutcome,
  isAccessEndedOutcome,
  openSharedItems,
  resolveSharedSensitivity,
  type SharedItemOpenResult,
} from "@/lib/consent/open-granted-person-information";
import { subscribeInformationRequest, subscribeSharedWithMe } from "@/lib/consent/information-request-reads";
import { wakeLiveAccessWatch, watchLiveAccess, watchSharedWithMeAccess } from "@/lib/consent/live-access-watch";
import type { SharedWithMeCardItem } from "@/lib/agent/agui-structured-experiences";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { AgentTranscriptRevealContext } from "@/components/agent/agent-transcript-reveal";
import {
  SharedWithYouCardView,
  type SharedWithYouCardStatus,
  type SharedWithYouItemView,
} from "./shared-with-you-card-view";

export type SharedWithYouPerson = {
  personRef: string;
  displayName: string;
  photoUrl?: string | null;
};

/** An open that has not settled by now shows a calm retry; a late result still lands. */
export const SHARED_OPEN_TIMEOUT_MS = 20_000;

type Ended = { reason: "revoked" | "expired"; at: string | null };

function isPast(iso: string | null, nowMs: number): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms <= nowMs;
}

/** The card's own reading of one item, before any value is opened. */
export function sharedItemBaseView(item: SharedWithMeCardItem, nowMs: number): SharedWithYouItemView {
  const ended = item.status === "revoked" || item.status === "expired" || isPast(item.accessEndsAt, nowMs);
  return {
    key: item.key,
    label: item.label,
    sharedAt: item.sharedAt,
    accessEndsAt: item.accessEndsAt,
    purpose: item.purpose,
    sensitive: resolveSharedSensitivity({ sensitivity: item.sensitivity, domain: item.domain, label: item.label }) === "sensitive",
    fieldOutline: item.fieldOutline,
    ...(item.fields?.length ? { fields: item.fields } : {}),
    state: ended ? "ended" : item.decryptable === false ? "unopenable" : "loading",
    endedReason: item.status === "revoked" ? "revoked" : "expired",
    endedAt: item.accessEndsAt,
  };
}

/** Access that ended is recorded per grant: a new approval under the same key opens again. */
function endKey(item: SharedWithMeCardItem): string {
  return `${item.key}|${item.bundleId ?? ""}|${item.requestId ?? ""}`;
}

function identityKey(item: SharedWithMeCardItem): string {
  return (item.requestId || item.grantRef || item.key).trim().toLowerCase();
}

function preferred(left: SharedWithMeCardItem, right: SharedWithMeCardItem): SharedWithMeCardItem {
  const openable = (item: SharedWithMeCardItem) => Number(Boolean(item.bundleId && item.requestId));
  const live = (item: SharedWithMeCardItem) => Number(item.status !== "revoked" && item.status !== "expired");
  if (openable(left) !== openable(right)) return openable(left) > openable(right) ? left : right;
  if (live(left) !== live(right)) return live(left) > live(right) ? left : right;
  return (right.sharedAt ?? "") > (left.sharedAt ?? "") ? right : left;
}

/**
 * One row per shared item, in the same order on every surface (S3, run 4:
 * "Work preferences" twice, and Profile and the person page listing the same
 * items in different orders). Items are the same when they name the same
 * request, else the same grant reference; the openable, live, newest copy is
 * kept. Order: label, then when it was shared, then the key.
 */
export function normalizeSharedItems(items: readonly SharedWithMeCardItem[]): SharedWithMeCardItem[] {
  const byIdentity = new Map<string, SharedWithMeCardItem>();
  for (const item of items) {
    const key = identityKey(item);
    const existing = byIdentity.get(key);
    byIdentity.set(key, existing ? preferred(existing, item) : item);
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: "base" })
    || (left.sharedAt ?? "").localeCompare(right.sharedAt ?? "")
    || left.key.localeCompare(right.key));
}

export function SharedWithYouCard({ person, items: rawItems, variant = "chat", className }: {
  person: SharedWithYouPerson;
  items: SharedWithMeCardItem[];
  variant?: "chat" | "profile";
  className?: string;
}) {
  const { user } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const [results, setResults] = useState<Record<string, { identity: string; result: SharedItemOpenResult }>>({});
  const [timedOut, setTimedOut] = useState<ReadonlySet<string>>(() => new Set());
  const [ended, setEnded] = useState<Record<string, Ended>>({});
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const revealInTranscript = useContext(AgentTranscriptRevealContext);

  // Identity of the content, not of the array: a parent re-render with the
  // same items keeps every open that is in flight.
  const itemsSignature = JSON.stringify(rawItems.map((item) => [item.key, item.bundleId, item.requestId,
    item.grantRef, item.label, item.status, item.sharedAt, item.accessEndsAt, item.decryptable,
    item.sensitivity, item.domain, item.purpose, item.fieldOutline, item.fields]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => normalizeSharedItems(rawItems), [itemsSignature]);

  const baseItems = useMemo(() => items.map((item) => sharedItemBaseView(item, nowMs)), [items, nowMs]);
  const openable = useMemo(
    () => items.filter((item, index) => baseItems[index]!.state === "loading" && !ended[endKey(item)]),
    [items, baseItems, ended],
  );

  const viewerUid = user?.uid ?? null;
  const session = isVaultUnlocked && viewerUid && vaultKey && vaultOwnerToken
    ? `${viewerUid}|${vaultOwnerToken}|${person.personRef}` : null;
  /** What an opened value is bound to; a result for another identity is never shown. */
  const identityOf = useCallback((item: SharedWithMeCardItem) =>
    `${session}|${item.key}|${item.bundleId ?? ""}|${item.requestId ?? ""}|${item.grantRef ?? ""}`, [session]);

  // Live references for opens that outlast a render.
  const inFlight = useRef(new Map<string, Promise<unknown>>());
  const wanted = useRef(new Set<string>());
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const timers = useRef(new Set<number>());
  useEffect(() => {
    const pending = timers.current;
    const opens = inFlight.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
      pending.clear();
      opens.clear();
      wanted.current.clear();
    };
  }, []);

  useEffect(() => {
    wanted.current = new Set(openable.map(identityOf));
  }, [identityOf, openable]);

  // Open what is not open yet, once per item.
  useEffect(() => {
    if (!session || !viewerUid || !vaultKey || !vaultOwnerToken) return;
    const toOpen = openable.filter((item) => {
      const identity = identityOf(item);
      return results[item.key]?.identity !== identity && !inFlight.current.has(identity);
    });
    if (!toOpen.length) return;
    const identities = toOpen.map(identityOf);
    const openSession = session;
    const promise = openSharedItems({
      userId: viewerUid,
      vaultKey,
      vaultOwnerToken,
      subjectRef: person.personRef,
      items: toOpen.map((item) => ({
        key: item.key, bundleId: item.bundleId, requestId: item.requestId,
        grantRef: item.grantRef, label: item.label, domain: item.domain,
      })),
      // Only a lock, another viewer or person, or every item leaving stops it.
      isCurrent: () => sessionRef.current === openSession && identities.some((identity) => wanted.current.has(identity)),
    }).then((opened) => {
      if (!opened || sessionRef.current !== openSession) return;
      setResults((current) => {
        const next = { ...current };
        opened.forEach((result, index) => {
          const identity = identities[index]!;
          if (wanted.current.has(identity)) next[result.key] = { identity, result };
        });
        return next;
      });
    }).catch(() => {
      if (sessionRef.current !== openSession) return;
      setResults((current) => {
        const next = { ...current };
        toOpen.forEach((item, index) => {
          const identity = identities[index]!;
          if (wanted.current.has(identity)) next[item.key] = { identity, result: { key: item.key, state: "unavailable" } };
        });
        return next;
      });
    }).finally(() => {
      for (const identity of identities) if (inFlight.current.get(identity) === promise) inFlight.current.delete(identity);
    });
    for (const identity of identities) inFlight.current.set(identity, promise);
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      if (identities.some((identity) => inFlight.current.get(identity) === promise)) {
        setTimedOut((current) => new Set([...current, ...identities]));
      }
    }, SHARED_OPEN_TIMEOUT_MS);
    timers.current.add(timer);
  }, [attempt, identityOf, openable, person.personRef, results, session, vaultKey, vaultOwnerToken, viewerUid]);

  // A lock, a sign-out or a different person drops every opened value at once.
  useEffect(() => {
    if (session) return;
    inFlight.current.clear();
    setResults((current) => Object.keys(current).length ? {} : current);
    setTimedOut((current) => current.size ? new Set() : current);
  }, [session]);

  // What access to watch: each bundle an item names or opened through.
  const resolvedBundles = useMemo(() => {
    const byBundle = new Map<string, Array<{ key: string; end: string; requestId: string | null }>>();
    for (const item of items) {
      const result = results[item.key]?.result;
      const bundleId = (item.bundleId ?? (result && "bundleId" in result ? result.bundleId : null) ?? "").toLowerCase();
      const requestId = item.requestId ?? (result && "requestId" in result ? result.requestId ?? null : null);
      if (!bundleId) continue;
      byBundle.set(bundleId, [...(byBundle.get(bundleId) ?? []), { key: item.key, end: endKey(item), requestId }]);
    }
    return byBundle;
  }, [items, results]);
  const bundleKey = [...resolvedBundles.keys()].sort().join(",");
  const resolvedRef = useRef(resolvedBundles);
  resolvedRef.current = resolvedBundles;
  const needsShareList = items.some((item) => !item.bundleId && !ended[endKey(item)] && item.decryptable !== false);

  const endItems = useCallback((entries: Array<{ key: string; end: string; reason: Ended["reason"] }>) => {
    if (!entries.length) return;
    // Values leave memory now, not at the next open.
    setResults((current) => {
      if (!entries.some((entry) => current[entry.key])) return current;
      const next = { ...current };
      for (const entry of entries) delete next[entry.key];
      return next;
    });
    setEnded((current) => {
      if (entries.every((entry) => current[entry.end])) return current;
      const next = { ...current };
      const at = new Date().toISOString();
      for (const entry of entries) next[entry.end] ??= { reason: entry.reason, at };
      return next;
    });
  }, []);

  useEffect(() => {
    if (!session || !vaultOwnerToken || !bundleKey) return;
    const releases = bundleKey.split(",").flatMap((bundleId) => [
      watchLiveAccess({ bundleId, vaultOwnerToken }),
      subscribeInformationRequest(bundleId, (bundle) => {
        const watched = resolvedRef.current.get(bundleId) ?? [];
        const outcome = informationRequestOutcome(bundle);
        const bundleEnded = isAccessEndedOutcome(outcome);
        endItems(watched.flatMap(({ key, end, requestId }) => {
          const status = requestId ? bundle.items.find((entry) => entry.requestId === requestId)?.status : null;
          if (status === "revoked" || status === "expired") return [{ key, end, reason: status }];
          if (bundleEnded && status !== "granted") {
            return [{ key, end, reason: outcome === "expired" ? "expired" as const : "revoked" as const }];
          }
          return [];
        }));
      }),
    ]);
    return () => releases.forEach((release) => release());
  }, [bundleKey, endItems, session, vaultOwnerToken]);

  // An item that names no bundle: its share leaving the list ends it.
  useEffect(() => {
    if (!session || !vaultOwnerToken || !needsShareList) return;
    const release = watchSharedWithMeAccess(vaultOwnerToken);
    const unsubscribe = subscribeSharedWithMe((shares) => {
      const live = new Set(shares.filter((share) => share.personRef === person.personRef)
        .map((share) => share.requestId.toLowerCase()));
      const gone: Array<{ key: string; end: string; reason: Ended["reason"] }> = [];
      for (const [, watched] of resolvedRef.current) {
        for (const { key, end, requestId } of watched) {
          const item = items.find((entry) => entry.key === key);
          if (!item || item.bundleId || !requestId) continue;
          if (!live.has(requestId.toLowerCase())) gone.push({ key, end, reason: "revoked" });
        }
      }
      endItems(gone);
    });
    return () => {
      release();
      unsubscribe();
    };
  }, [endItems, items, needsShareList, person.personRef, session, vaultOwnerToken]);

  // A push or live event about access: check now. Never a reopen.
  useEffect(() => {
    const onChanged = () => wakeLiveAccessWatch();
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, onChanged);
  }, []);

  const current = useMemo(() => {
    const out = new Map<string, SharedItemOpenResult>();
    for (const item of openable) {
      const entry = results[item.key];
      if (entry && entry.identity === identityOf(item)) out.set(item.key, entry.result);
    }
    return out;
  }, [identityOf, openable, results]);

  // Values leave memory the moment the export's window, or access, runs out.
  useEffect(() => {
    const ends = [
      ...[...current.values()].flatMap((result) => result.state === "open" ? [result.expiresAtMs] : []),
      ...items.flatMap((item) => {
        const ms = item.accessEndsAt ? Date.parse(item.accessEndsAt) : Number.NaN;
        return Number.isFinite(ms) && ms > nowMs ? [ms] : [];
      }),
    ];
    if (!ends.length) return;
    const wait = Math.max(0, Math.min(...ends) - Date.now());
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.min(wait + 50, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [current, items, nowMs]);

  const settled = (item: SharedWithMeCardItem) => current.has(item.key) || timedOut.has(identityOf(item));
  const failed = (item: SharedWithMeCardItem) => {
    const result = current.get(item.key);
    return result ? result.state === "unavailable" : timedOut.has(identityOf(item));
  };
  const status: SharedWithYouCardStatus = !isVaultUnlocked
    ? "locked"
    : !openable.length ? "ready"
      : openable.every(failed) ? "error"
        : openable.some(settled) ? "ready" : "loading";

  const views = items.map((item, index): SharedWithYouItemView => {
    const base = baseItems[index]!;
    const stopped = ended[endKey(item)];
    if (stopped) return { ...base, state: "ended", endedReason: stopped.reason, endedAt: stopped.at, data: null };
    if (base.state === "ended" || base.state === "unopenable") return base;
    if (status === "locked") return { ...base, state: "locked" };
    const result = current.get(item.key);
    if (!result) return timedOut.has(identityOf(item)) ? { ...base, state: "unavailable" } : base;
    if (result.state === "ended") return { ...base, state: "ended", endedReason: "revoked", endedAt: null };
    if (result.state === "unavailable") return { ...base, state: "unavailable" };
    if (result.expiresAtMs <= nowMs) return { ...base, state: "ended", endedReason: "expired" };
    return {
      ...base,
      state: "ready",
      data: result.value.data,
      sensitive: base.sensitive || result.value.sensitivity === "sensitive",
    };
  });

  // In a live chat turn, bring the card above the composer once, when it
  // first appears. A restored conversation is left where the reader is.
  const [reveal] = useState(() => variant === "chat" ? revealInTranscript : null);
  useEffect(() => {
    const element = sectionRef.current;
    if (!reveal || !element?.closest('[data-message-status="streaming"]')) return;
    reveal(element);
  }, [reveal]);

  // A calm retry: only what failed or timed out opens again. A late result
  // from the first try is still accepted if it lands first.
  const onRetry = useCallback(() => {
    const retried = new Set(openable.filter(failed).map(identityOf));
    for (const identity of retried) inFlight.current.delete(identity);
    setTimedOut((currentSet) => new Set([...currentSet].filter((identity) => !retried.has(identity))));
    setResults((currentResults) => {
      const next = { ...currentResults };
      for (const item of openable) if (retried.has(identityOf(item))) delete next[item.key];
      return next;
    });
    setAttempt((value) => value + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityOf, openable, current, timedOut]);

  return (
    <div ref={sectionRef}>
      <SharedWithYouCardView
        person={{ displayName: person.displayName, photoUrl: person.photoUrl ?? null }}
        status={status}
        items={views}
        variant={variant}
        className={className}
        onRetry={onRetry}
        onUnlock={user ? () => setUnlockOpen(true) : undefined}
      />
      {user && status === "locked" ? (
        <VaultUnlockDialog
          user={user}
          open={unlockOpen}
          onOpenChange={setUnlockOpen}
          onSuccess={() => setUnlockOpen(false)}
          title="Unlock to view"
          description={`Unlock your vault to open what ${person.displayName} shared, on this device only.`}
        />
      ) : null}
    </div>
  );
}
