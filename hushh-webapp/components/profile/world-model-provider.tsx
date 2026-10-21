"use client";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";
import { shouldSkipReviewerBackgroundWritesForAutomation } from "@/lib/testing/native-test";
import {
  WorldModelResearchService,
  type PwmPreferences,
  type PwmProgress,
  type PwmResult,
  type PwmValidatedFact,
} from "@/lib/services/world-model-research-service";
import {
  WorldModelDecisionService,
  type PwmOwnerDecisions,
} from "@/lib/services/world-model-decision-service";
import {
  worldModelResearchStore,
  type WorldModelResearchState,
  type WorldModelResearchWriter,
} from "@/lib/world-model/research-store";

/**
 * One app-level reader. The server enrolls the legacy Google research choice
 * on ensure; Azure/Bing in UAT requires a separate explicit owner opt-in.
 * Python owns provider consent, preparation, confidence and durable state.
 *
 * It is the only writer of the research store and renders nothing of its own:
 * surfaces read the store, so the Profile pane, which is mounted beside this
 * provider rather than inside it, sees the same model.
 */
export function WorldModelProvider({ children }: { children: ReactNode }) {
  const { user, loading, sessionVerificationRequired } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked, tokenExpiresAt } =
    useVault();
  const inSetup = usePathname().startsWith("/one/setup");
  const [revision, setRevision] = useState(0);
  const refreshIntent = useRef<{
    owner: string;
    key: string;
    token: string;
    publicProfileUrls?: readonly string[];
  } | null>(null);
  const retryIntent = useRef<{
    owner: string;
    key: string;
    token: string;
  } | null>(null);
  const writer = useRef<WorldModelResearchWriter | null>(null);
  const ready = !!(
    !loading &&
    user &&
    !sessionVerificationRequired &&
    isVaultUnlocked &&
    vaultKey &&
    vaultOwnerToken &&
    (tokenExpiresAt === null || Date.now() < tokenExpiresAt)
  );
  const current = useRef({
    ready,
    owner: user?.uid,
    key: vaultKey,
    token: vaultOwnerToken,
  });
  current.current = {
    ready,
    owner: user?.uid,
    key: vaultKey,
    token: vaultOwnerToken,
  };
  // Layout effects, so a reader never paints a value for a previous owner,
  // key or token. Attach runs first: the authority effect needs the handle.
  useLayoutEffect(() => {
    const queueRefresh = (publicProfileUrls?: readonly string[]) => {
      const state = current.current;
      refreshIntent.current = state.ready && state.owner && state.key && state.token
        ? { owner: state.owner, key: state.key, token: state.token,
            ...(publicProfileUrls ? { publicProfileUrls: [...publicProfileUrls] } : {}) } : null;
      setRevision(value => value + 1);
    };
    const handle = worldModelResearchStore.attach({
      reload: (confirmed?: PwmPreferences) => {
        refreshIntent.current = null;
        const state = current.current;
        const activeOwner =
          state.ready && state.owner && state.key && state.token
            ? { owner: state.owner, key: state.key, token: state.token }
            : null;
        retryIntent.current = confirmed?.enabled === false ? null : activeOwner;
        if (activeOwner)
          handle.setSnapshot((previous) =>
            previous &&
            previous.owner === state.owner &&
            previous.key === state.key &&
            previous.token === state.token
              ? {
                  ...previous,
                  preferences: confirmed ?? previous.preferences,
                  result: null,
                  failed: false,
                  retrying: confirmed?.enabled !== false,
                  live: false,
                  retryAt: null,
                  progress: confirmed?.enabled === false ? null : previous.progress,
                  validatedFacts: confirmed?.enabled === false ? [] : previous.validatedFacts,
                }
              : previous,
          );
        setRevision((value) => value + 1);
      },
      refresh: () => queueRefresh(),
      researchPublicProfiles: urls => queueRefresh(urls),
    });
    writer.current = handle;
    return () => {
      handle.detach();
      if (writer.current === handle) writer.current = null;
    };
  }, []);
  const ownerId = user?.uid;
  useLayoutEffect(() => {
    writer.current?.setAuthority(
      ready && ownerId && vaultKey && vaultOwnerToken
        ? { owner: ownerId, key: vaultKey, token: vaultOwnerToken }
        : null,
    );
  }, [ready, ownerId, vaultKey, vaultOwnerToken]);
  useEffect(() => {
    if (!ready || !user || !vaultKey || !vaultOwnerToken || inSetup) return;
    const intent = refreshIntent.current;
    refreshIntent.current = null;
    const explicitRefresh =
      intent?.owner === user.uid &&
      intent.key === vaultKey &&
      intent.token === vaultOwnerToken;
    const retry = retryIntent.current;
    retryIntent.current = null;
    const explicitRetry =
      retry?.owner === user.uid &&
      retry.key === vaultKey &&
      retry.token === vaultOwnerToken;
    const retrySnapshot = explicitRetry ? worldModelResearchStore.getSnapshot() : null;
    const controller = new AbortController(),
      owner = user.uid;
    const guard = createAgentPkmCaptureGuard({
      userId: owner,
      signal: controller.signal,
      isEnabled: () =>
        current.current.ready &&
        current.current.owner === owner &&
        current.current.key === vaultKey &&
        current.current.token === vaultOwnerToken,
    });
    const authority = {
      vaultKey,
      vaultOwnerToken,
      signal: controller.signal,
      assertCurrent: guard.assertCurrent,
    };
    let prefs: PwmPreferences | null = null,
      latest: PwmResult | null = null,
      failed = false,
      retrying = explicitRetry,
      progress: PwmProgress | null = retrySnapshot?.progress ?? null,
      validatedFacts: readonly PwmValidatedFact[] = retrySnapshot?.validatedFacts ?? [],
      live = false,
      lastActivityAt: number | null = retrySnapshot?.lastActivityAt ?? null,
      retryAt: number | null = null,
      retryTimer: ReturnType<typeof setTimeout> | null = null,
      preferencesRequested = false;
    // A status read is not research activity. Ignore server timestamps here:
    // they can be re-derived when a different instance first sees a checkpoint.
    const progressContent = (value: PwmProgress) =>
      JSON.stringify({ ...value, started_at: undefined, last_activity_at: undefined });
    const store = writer.current;
    const publish = () => {
      if (guard.isCurrent())
        store?.setSnapshot((previous) => ({
          owner,
          key: vaultKey,
          token: vaultOwnerToken,
          // A restart for the same owner, key and token (reload after a toggle)
          // keeps the last known switches until this run reads them again.
          preferences:
            prefs ??
            (previous?.owner === owner &&
            previous.key === vaultKey &&
            previous.token === vaultOwnerToken
              ? previous.preferences
              : null),
          result: latest,
          failed,
          retrying,
          progress,
          validatedFacts,
          live,
          lastActivityAt,
          retryAt,
        }));
    };
    const clearRetry = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    };
    // The automatic retry lives here, not in a page: it happens whether or
    // not the owner keeps the pane open, and only for this owner, key and token.
    const scheduleRetry = (at: number) => {
      clearRetry();
      retryTimer = setTimeout(
        () => {
          retryTimer = null;
          if (!guard.isCurrent()) return;
          refreshIntent.current = null;
          setRevision((value) => value + 1);
        },
        Math.min(Math.max(0, at - Date.now()), 2_147_483_647),
      );
    };
    // Read after ensure, so a first-time owner sees the enrolled row; a failed
    // run still reads them, so the off switch stays reachable.
    const readPreferences = () => {
      if (preferencesRequested) return;
      preferencesRequested = true;
      void WorldModelResearchService.preferences(authority)
        .then((value) => {
          prefs = value;
          publish();
        })
        .catch(() => undefined);
    };
    void (async () => {
      // Past decisions only refine research; an unreadable memory never blocks it.
      let ownerDecisions: PwmOwnerDecisions | undefined;
      try {
        ownerDecisions = WorldModelDecisionService.ownerDecisions(
          await WorldModelDecisionService.load({ ...authority, userId: owner }),
        );
      } catch {
        if (controller.signal.aborted) return;
      }
      await WorldModelResearchService.observe({
        ...authority,
        // One tab per owner drives research; the others only read status.
        ownerId: owner,
        ownerDecisions,
        refresh: explicitRefresh,
        publicProfileUrls: explicitRefresh ? intent.publicProfileUrls : undefined,
        // Keep read warming, but do not enroll or resume research on fixture
        // unlock. Explicit UI actions retain the rehearsal's admission guard.
        readOnly: shouldSkipReviewerBackgroundWritesForAutomation() && !explicitRefresh && !explicitRetry,
        onProgress: (next) => {
          if (!progress || progressContent(next) !== progressContent(progress))
            lastActivityAt = Date.now();
          progress = next;
          live = true;
          publish();
        },
        onPartial: (next) => {
          if (JSON.stringify(next) !== JSON.stringify(validatedFacts))
            lastActivityAt = Date.now();
          validatedFacts = next;
          live = true;
          publish();
        },
        onInterrupted: () => {
          live = false;
          publish();
        },
        onResult: (result) => {
          const wasRunning = latest?.status === "pending" || latest?.status === "paused";
          const receivedAt = Date.now();
          latest = result;
          retrying = false;
          live = true;
          if (result.status === "pending" || result.status === "paused") {
            // Anchor a newly observed run once. Identical pending/restart reads
            // must not make a stalled worker look active forever.
            if (!wasRunning) lastActivityAt = receivedAt;
            // A bare restart_required response can mean the sealed work no
            // longer matches this identity binding. Only an explicitly
            // returned checkpoint can survive that boundary.
            if (result.restart_required && (!result.progress || !result.validated_facts)) {
              progress = null;
              validatedFacts = [];
            } else {
              if (result.progress) progress = result.progress;
              if (result.validated_facts) validatedFacts = result.validated_facts;
            }
          } else if (result.status === "unavailable") {
            lastActivityAt = receivedAt;
            // Terminal checkpoints are authoritative only when the server
            // returns both fields after its current owner/binding check.
            progress = result.progress ?? null;
            validatedFacts = result.validated_facts ?? [];
          } else {
            lastActivityAt = receivedAt;
            progress = null;
            validatedFacts = [];
          }
          clearRetry();
          retryAt =
            result.status === "unavailable" &&
            result.retry_after_s !== undefined
              ? receivedAt + result.retry_after_s * 1_000
              : null;
          if (retryAt !== null) scheduleRetry(retryAt);
          publish();
          readPreferences();
        },
      });
      live = false;
      // The watch ended without a final result: nothing is running any more,
      // so the page offers Try again rather than a resume that never comes.
      // (Typed explicitly: onResult assigns `latest` from inside a callback.)
      const ended = latest as PwmResult | null;
      if (ended?.status === "pending" || ended?.status === "paused")
        failed = true;
      if (failed) retrying = false;
      publish();
    })().catch(() => {
      if (controller.signal.aborted) return;
      latest = null;
      failed = true;
      retrying = false;
      live = false;
      publish();
      readPreferences();
    });
    return () => {
      controller.abort();
      clearRetry();
    };
  }, [ready, user, vaultKey, vaultOwnerToken, inSetup, revision]);
  return <>{children}</>;
}

/** The research state, wherever the caller is mounted. */
export function useWorldModelResearch(active = true): WorldModelResearchState {
  const { user, loading, sessionVerificationRequired } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked, tokenExpiresAt } = useVault();
  const expected = active && !loading && !sessionVerificationRequired && isVaultUnlocked && user && vaultKey && vaultOwnerToken &&
    (tokenExpiresAt === null || Date.now() < tokenExpiresAt) ? { owner: user.uid, key: vaultKey, token: vaultOwnerToken } : null;
  return useSyncExternalStore(
    worldModelResearchStore.subscribe,
    () => worldModelResearchStore.getSnapshotFor(expected),
    worldModelResearchStore.getServerSnapshot,
  );
}
