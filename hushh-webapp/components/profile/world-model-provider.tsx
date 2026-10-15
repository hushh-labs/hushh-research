"use client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";
import {
  WorldModelResearchService,
  type PwmPreferences,
  type PwmResult,
} from "@/lib/services/world-model-research-service";

const Context = createContext<{
  result: PwmResult | null;
  preferences: PwmPreferences | null;
  failed: boolean;
  reload: () => void;
  refresh: () => void;
}>({
  result: null,
  preferences: null,
  failed: false,
  reload: () => {},
  refresh: () => {},
});
/** One app-level reader. Python owns preparation, confidence and durable state. */
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
  const [snapshot, setSnapshot] = useState<{
    owner: string;
    key: string;
    token: string;
    result: PwmResult | null;
    preferences: PwmPreferences | null;
    failed: boolean;
  } | null>(null);
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
    let prefs: PwmPreferences | null = null;
    const publish = (result: PwmResult | null, failed = false) => {
      if (guard.isCurrent())
        setSnapshot({
          owner,
          key: vaultKey,
          token: vaultOwnerToken,
          preferences: prefs,
          result,
          failed,
        });
    };
    void (async () => {
      prefs = await WorldModelResearchService.preferences(authority);
      publish(null);
      if (prefs.enabled)
        await WorldModelResearchService.observe({
          ...authority,
          onResult: publish,
          refresh: explicitRefresh,
        });
    })().catch(() => {
      if (!controller.signal.aborted) publish(null, true);
    });
    return () => controller.abort();
  }, [ready, user, vaultKey, vaultOwnerToken, inSetup, revision]);
  const valid =
    ready &&
    snapshot?.owner === user?.uid &&
    snapshot?.key === vaultKey &&
    snapshot?.token === vaultOwnerToken;
  const value = useMemo(
    () => ({
      result: valid ? snapshot!.result : null,
      preferences: valid ? snapshot!.preferences : null,
      failed: valid ? snapshot!.failed : false,
      reload: () => {
        refreshIntent.current = null;
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
    }),
    [snapshot, valid],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useWorldModelResearch = () => useContext(Context);
