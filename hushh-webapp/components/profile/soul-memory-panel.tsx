"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SoulMemoryDocument } from "@/components/profile/soul-memory-document";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { Textarea } from "@/components/ui/textarea";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { clearAgentPkmContext } from "@/lib/agent/agent-pkm-memory";
import { loadMarkdownMemory, MARKDOWN_MEMORY_DOMAIN, MAX_MARKDOWN_MEMORY_CHARS, peekMarkdownMemory, replaceMarkdownMemoryDocument, retryMarkdownMemorySync, subscribeMarkdownMemory } from "@/lib/pkm/markdown-memory";
import { usePkmDomainChangeRevision } from "@/lib/pkm/use-pkm-domain-change-revision";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

type Document = { markdown: string; persisted: boolean };

/** An in-memory view/editor of the exact encrypted document supplied to chat. */
export function SoulMemoryPanel({ userId, vaultKey, vaultOwnerToken, tokenExpiresAt, active, verified }: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  tokenExpiresAt: number | null;
  active: boolean;
  verified: boolean;
}) {
  const session = useMemo(() => Symbol(userId && vaultKey && verified
    ? "authorized-soul-session" : "unavailable-soul-session"), [userId, vaultKey, verified]);
  const currentSession = useRef<symbol | null>(session);
  currentSession.current = session;
  useEffect(() => {
    currentSession.current = session;
    return () => { if (currentSession.current === session) currentSession.current = null; };
  }, [session]);
  const revision = usePkmDomainChangeRevision(userId, MARKDOWN_MEMORY_DOMAIN);
  const [localRevision, setLocalRevision] = useState(0);
  useEffect(() => subscribeMarkdownMemory(userId, () => setLocalRevision(value => value + 1)), [userId]);
  const [retry, setRetry] = useState(0);
  const lastReload = useRef(0);
  const [state, setState] = useState<{ session: symbol; document: Document; draft: string; editing: boolean } | null>(null);
  const current = state?.session === session ? state : null;
  const editing = current?.editing ?? false;
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [savingSession, setSavingSession] = useState<symbol | null>(null);
  const saving = savingSession === session;
  const [conflict, setConflict] = useState(false);
  const saveInFlight = useRef(false);

  useEffect(() => {
    if (!active || editing || !verified) return;
    let canceled = false;
    const epoch = snapshotVaultSessionEpoch();
    const isCurrent = () => !canceled && currentSession.current === session && isVaultSessionEpochCurrent(epoch) &&
      (tokenExpiresAt === null || Date.now() < tokenExpiresAt);
    setLoading(true); setFailed(false); setConflict(false);
    void (async () => {
      try {
        // An unavailable read must never look like an absent document.
        const forceRefresh = retry !== lastReload.current;
        lastReload.current = retry;
        const memory = await loadMarkdownMemory({ userId, vaultKey, vaultOwnerToken, forceRefresh });
        if (!isCurrent()) return;
        if (!memory) throw new Error("Soul document unavailable");
        const document = { markdown: memory.markdown, persisted: memory.persisted };
        setState({ session, document, draft: document.markdown, editing: false });
      } catch { if (isCurrent()) setFailed(true); }
      finally { if (isCurrent()) setLoading(false); }
    })();
    return () => { canceled = true; };
  }, [userId, vaultKey, vaultOwnerToken, tokenExpiresAt, verified, session, revision, localRevision, retry, active, editing]);

  const cancelEdit = useCallback(() => {
    if (!editing) return false;
    if (saveInFlight.current) return true;
    setState(value => value?.session === session ? { ...value, editing: false, draft: value.document.markdown } : value);
    setConflict(false);
    return true;
  }, [editing, session]);
  useBackLayer(ROUTES.PKM, active && verified && editing ? 1 : 0, cancelEdit);

  const save = async () => {
    if (!current || saveInFlight.current) return;
    const epoch = snapshotVaultSessionEpoch();
    const assertCurrent = async () => {
      if (!verified || currentSession.current !== session || !isVaultSessionEpochCurrent(epoch) ||
        (tokenExpiresAt !== null && Date.now() >= tokenExpiresAt)) throw new DOMException("Session changed", "AbortError");
    };
    saveInFlight.current = true; setSavingSession(session); setConflict(false);
    try {
      await assertCurrent();
      const result = await replaceMarkdownMemoryDocument({ userId, vaultKey, vaultOwnerToken,
        markdown: current.draft, expectedMarkdown: current.document.markdown,
        expectedPersisted: current.document.persisted, beforeEffect: assertCurrent });
      await assertCurrent();
      if (!result.success) {
        setConflict(Boolean(result.conflict));
        morphyToast.error(result.message || "Soul.md could not be saved. Your draft is still here.");
        return;
      }
      clearAgentPkmContext(userId, { preserveMarkdown: true });
      const document = { markdown: result.markdown ?? "", persisted: true };
      setState({ session, document, draft: document.markdown, editing: false });
      morphyToast.success("Soul.md saved");
    } catch {
      if (currentSession.current === session && isVaultSessionEpochCurrent(epoch)) morphyToast.error("Soul.md could not be saved. Your draft is still here.");
    } finally {
      saveInFlight.current = false;
      if (currentSession.current === session) setSavingSession(null);
    }
  };

  if (!verified) return <p role="status" className="py-4 text-sm text-muted-foreground">Reconnect your account to open Soul.md.</p>;
  if (failed && !editing) return <div role="status" className="space-y-3 py-4">
    <p className="text-sm text-muted-foreground">Soul.md couldn’t be opened.</p>
    <Button variant="muted" onClick={() => setRetry(value => value + 1)}>Try again</Button>
  </div>;
  if (!current) return <p role="status" className="py-4 text-sm text-muted-foreground">Opening Soul.md…</p>;
  const sync = peekMarkdownMemory(userId)?.syncStatus;
  return <section aria-label="Soul.md" className="min-w-0 space-y-[var(--app-form-section-gap)] pb-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">The memory One uses in every conversation.</p>
      {editing ? <div className="flex gap-2">
        <Button variant="muted" disabled={saving} onClick={cancelEdit}>Cancel</Button>
        <Button disabled={saving || current.draft === current.document.markdown || current.draft.length > MAX_MARKDOWN_MEMORY_CHARS} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</Button>
      </div> : <Button variant="muted" disabled={loading} onClick={() => setState({ ...current, editing: true })}>Edit Soul.md</Button>}
    </div>
    {sync === "saving" ? <p role="status" className="text-xs text-muted-foreground">Syncing your latest memories…</p> : null}
    {sync === "retryable" ? <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
      <p>Your latest memories are available here but haven’t synced yet.</p>
      <Button variant="muted" onClick={() => void retryMarkdownMemorySync({ userId, vaultKey, vaultOwnerToken,
        beforeEffect: async () => {
          if (!verified || currentSession.current !== session || (tokenExpiresAt !== null && Date.now() >= tokenExpiresAt))
            throw new DOMException("Session changed", "AbortError");
        },
      }).catch(() => undefined)}>Retry sync</Button>
    </div> : null}
    {editing ? <div className="space-y-[var(--app-form-field-gap)]">
      <Textarea aria-label="Soul.md Markdown" value={current.draft} disabled={saving}
        autoComplete="off" autoCorrect="off" spellCheck={false} rows={18}
        className="soul-memory-editor min-h-80"
        onChange={event => setState({ ...current, draft: event.target.value })} />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Use Markdown headings, lists, and links. Passwords are omitted when saving.</span>
        <span>{current.draft.length.toLocaleString()} / {MAX_MARKDOWN_MEMORY_CHARS.toLocaleString()}</span>
      </div>
      {conflict ? <Button variant="muted" disabled={saving} onClick={() => { cancelEdit(); setRetry(value => value + 1); }}>Reload latest version</Button> : null}
    </div> : null}
    <SoulMemoryDocument markdown={editing ? current.draft : current.document.markdown} preview={editing} />
  </section>;
}
