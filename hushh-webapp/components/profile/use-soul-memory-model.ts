"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { clearAgentPkmContext } from "@/lib/agent/agent-pkm-memory";
import {
  loadMarkdownMemory,
  MARKDOWN_MEMORY_DOMAIN,
  peekMarkdownMemory,
  replaceMarkdownMemoryDocument,
  retryMarkdownMemorySync,
  subscribeMarkdownMemory,
} from "@/lib/pkm/markdown-memory";
import {
  readLabelledSoulFacts,
  ageFromDateOfBirth,
} from "@/lib/pkm/soul-labelled-facts";
import { usePkmDomainChangeRevision } from "@/lib/pkm/use-pkm-domain-change-revision";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

export type SoulMemoryModelOptions = {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  tokenExpiresAt: number | null;
  active: boolean;
  verified: boolean;
};
type Document = { markdown: string; persisted: boolean };

/** Shared, memory-only feature owner. Renderers receive document/draft and
 * bounded callbacks, never its credential options or a second persistence path. */
export function useSoulMemoryModel({
  userId,
  vaultKey,
  vaultOwnerToken,
  tokenExpiresAt,
  active,
  verified,
}: SoulMemoryModelOptions) {
  const session = useMemo(
    () =>
      Symbol(
        userId && vaultKey && verified
          ? "authorized-soul-session"
          : "unavailable-soul-session",
      ),
    [userId, vaultKey, verified],
  );
  const currentSession = useRef<symbol | null>(session);
  currentSession.current = session;
  useEffect(() => {
    currentSession.current = session;
    return () => {
      if (currentSession.current === session) currentSession.current = null;
    };
  }, [session]);
  const revision = usePkmDomainChangeRevision(userId, MARKDOWN_MEMORY_DOMAIN);
  const [localRevision, setLocalRevision] = useState(0);
  useEffect(
    () =>
      subscribeMarkdownMemory(userId, () =>
        setLocalRevision((value) => value + 1),
      ),
    [userId],
  );
  const [retry, setRetry] = useState(0);
  const lastReload = useRef(0);
  const [state, setState] = useState<{
    session: symbol;
    document: Document;
    draft: string;
    editing: boolean;
  } | null>(null);
  const current = state?.session === session ? state : null;
  const currentDocument = useRef(current);
  currentDocument.current = current;
  // A token refresh preserves the editor but retires callbacks that captured
  // its previous credentials. A retained Save must also name the latest draft.
  const writerBinding = useMemo(
    () => ({
      session,
      credentialAvailable: Boolean(vaultOwnerToken),
      expiresAt: tokenExpiresAt,
      epoch: snapshotVaultSessionEpoch(),
    }),
    [session, vaultOwnerToken, tokenExpiresAt],
  );
  const currentWriter = useRef(writerBinding);
  currentWriter.current = writerBinding;
  const editing = current?.editing ?? false;
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [savingSession, setSavingSession] = useState<symbol | null>(null);
  const saving = savingSession === session;
  const [conflict, setConflict] = useState(false);
  const saveInFlight = useRef(false);
  const ownsCurrentSession = useCallback(
    () =>
      verified &&
      currentSession.current === session &&
      (tokenExpiresAt === null || Date.now() < tokenExpiresAt),
    [verified, session, tokenExpiresAt],
  );
  const ownsCurrentWriter = () =>
    ownsCurrentSession() &&
    currentWriter.current === writerBinding &&
    isVaultSessionEpochCurrent(writerBinding.epoch);

  useEffect(() => {
    if (!active || editing || !verified) return;
    let canceled = false;
    const epoch = snapshotVaultSessionEpoch();
    const isCurrent = () =>
      !canceled &&
      currentSession.current === session &&
      isVaultSessionEpochCurrent(epoch) &&
      (tokenExpiresAt === null || Date.now() < tokenExpiresAt);
    setLoading(true);
    setFailed(false);
    setConflict(false);
    void (async () => {
      try {
        const forceRefresh = retry !== lastReload.current;
        lastReload.current = retry;
        const memory = await loadMarkdownMemory({
          userId,
          vaultKey,
          vaultOwnerToken,
          forceRefresh,
        });
        if (!isCurrent()) return;
        if (!memory) throw new Error("Soul document unavailable");
        const document = {
          markdown: memory.markdown,
          persisted: memory.persisted,
        };
        setState({
          session,
          document,
          draft: document.markdown,
          editing: false,
        });
      } catch {
        if (isCurrent()) setFailed(true);
      } finally {
        if (isCurrent()) setLoading(false);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [
    userId,
    vaultKey,
    vaultOwnerToken,
    tokenExpiresAt,
    verified,
    session,
    revision,
    localRevision,
    retry,
    active,
    editing,
  ]);

  const cancelEdit = useCallback(() => {
    if (!ownsCurrentSession() || !editing) return false;
    if (saveInFlight.current) return true;
    setState((value) =>
      value?.session === session
        ? { ...value, editing: false, draft: value.document.markdown }
        : value,
    );
    setConflict(false);
    return true;
  }, [editing, session, ownsCurrentSession]);
  useBackLayer(ROUTES.PKM, active && verified && editing ? 1 : 0, cancelEdit);

  const save = async () => {
    if (
      !ownsCurrentWriter() ||
      !current ||
      currentDocument.current !== current ||
      saveInFlight.current
    )
      return;
    const birth = readLabelledSoulFacts(current.draft).get(
      "date of birth",
    )?.value;
    if (birth && ageFromDateOfBirth(birth) === null) {
      morphyToast.error("Date of birth must be a real past date.");
      return;
    }
    const epoch = snapshotVaultSessionEpoch();
    const assertCurrent = async () => {
      if (
        !ownsCurrentWriter() ||
        currentDocument.current !== current ||
        !isVaultSessionEpochCurrent(epoch) ||
        (tokenExpiresAt !== null && Date.now() >= tokenExpiresAt)
      )
        throw new DOMException("Session changed", "AbortError");
    };
    saveInFlight.current = true;
    setSavingSession(session);
    setConflict(false);
    try {
      await assertCurrent();
      const result = await replaceMarkdownMemoryDocument({
        userId,
        vaultKey,
        vaultOwnerToken,
        markdown: current.draft,
        expectedMarkdown: current.document.markdown,
        expectedPersisted: current.document.persisted,
        beforeEffect: assertCurrent,
      });
      await assertCurrent();
      if (!result.success) {
        setConflict(Boolean(result.conflict));
        morphyToast.error(
          result.message ||
            "memory.md could not be saved. Your draft is still here.",
        );
        return;
      }
      clearAgentPkmContext(userId, { preserveMarkdown: true });
      const document = { markdown: result.markdown ?? "", persisted: true };
      setState({ session, document, draft: document.markdown, editing: false });
      morphyToast.success("memory.md saved");
    } catch {
      if (
        currentSession.current === session &&
        isVaultSessionEpochCurrent(epoch)
      )
        morphyToast.error(
          "memory.md could not be saved. Your draft is still here.",
        );
    } finally {
      saveInFlight.current = false;
      if (currentSession.current === session) setSavingSession(null);
    }
  };

  const retrySync = () =>
    !ownsCurrentWriter()
      ? Promise.resolve(undefined)
      : retryMarkdownMemorySync({
          userId,
          vaultKey,
          vaultOwnerToken,
          beforeEffect: async () => {
            if (!ownsCurrentWriter())
              throw new DOMException("Session changed", "AbortError");
          },
        }).catch(() => undefined);
  return {
    active,
    verified,
    current: current
      ? { document: current.document, draft: current.draft }
      : null,
    editing,
    loading,
    failed,
    saving,
    conflict,
    sync: peekMarkdownMemory(userId)?.syncStatus,
    cancelEdit,
    save,
    retrySync,
    retryLoad: () => {
      if (ownsCurrentSession()) setRetry((value) => value + 1);
    },
    beginEdit: () => {
      if (ownsCurrentSession() && !saveInFlight.current)
        setState((value) =>
          value?.session === session ? { ...value, editing: true } : value,
        );
    },
    changeDraft: (draft: string) => {
      if (ownsCurrentSession() && !saveInFlight.current)
        setState((value) =>
          value?.session === session ? { ...value, draft } : value,
        );
    },
    reloadLatest: () => {
      if (!ownsCurrentSession() || saveInFlight.current) return;
      cancelEdit();
      setRetry((value) => value + 1);
    },
  };
}

export type SoulMemoryModel = ReturnType<typeof useSoulMemoryModel>;
