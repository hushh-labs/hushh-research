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
import {
  WorldModelResearchService,
  type PwmPreferences,
  type PwmProgress,
  type PwmResult,
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
 * One app-level reader. Research is on by default: the server enrolls the
 * owner on ensure and answers consent_required only after an explicit opt-out.
 * Python owns preparation, confidence and durable state.
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
    const handle = worldModelResearchStore.attach({
      reload: (confirmed?: PwmPreferences) => {
        refreshIntent.current = null;
        const state = current.current;
        if (confirmed && state.ready)
          handle.setSnapshot((previous) =>
            previous &&
            previous.owner === state.owner &&
            previous.key === state.key &&
            previous.token === state.token
              ? { ...previous, preferences: confirmed }
              : previous,
          );
        setRevision((value) => value + 1);
      },
      refresh: () => {
        const state = current.current;
        refreshIntent.current =
          state.ready && state.owner && state.key && state.token
            ? { owner: state.owner, key: state.key, token: state.token }
            : null;
        setRevision((value) => value + 1);
      },
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
      progress: PwmProgress | null = null,
      live = false,
      lastActivityAt: number | null = null,
      retryAt: number | null = null,
      retryTimer: ReturnType<typeof setTimeout> | null = null,
      preferencesRequested = false;
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
          progress,
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
    // A long hidden spell is not a quiet one: running research is counted
    // fresh when the owner returns, until the next real frame arrives.
    const onVisible = () => {
      if (document.hidden) return;
      if (latest?.status !== "pending" && latest?.status !== "paused") return;
      lastActivityAt = Date.now();
      publish();
    };
    document.addEventListener("visibilitychange", onVisible);
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
        onProgress: (next) => {
          progress = next;
          live = true;
          lastActivityAt = Date.now();
          publish();
        },
        onInterrupted: () => {
          live = false;
          publish();
        },
        onResult: (result) => {
          latest = result;
          live = true;
          lastActivityAt = Date.now();
          if (result.status !== "pending" && result.status !== "paused")
            progress = null;
          clearRetry();
          retryAt =
            result.status === "unavailable" &&
            result.retry_after_s !== undefined
              ? lastActivityAt + result.retry_after_s * 1_000
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
      publish();
    })().catch(() => {
      if (controller.signal.aborted) return;
      latest = null;
      failed = true;
      progress = null;
      live = false;
      publish();
      readPreferences();
    });
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", onVisible);
      clearRetry();
    };
  }, [ready, user, vaultKey, vaultOwnerToken, inSetup, revision]);
  return <>{children}</>;
}

/** The research state, wherever the caller is mounted. */
export const useWorldModelResearch = (): WorldModelResearchState =>
  useSyncExternalStore(
    worldModelResearchStore.subscribe,
    worldModelResearchStore.getSnapshot,
    worldModelResearchStore.getServerSnapshot,
  );
