"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveMirrorPreview } from "@/components/profile/live-mirror-preview";
import { SoulMemoryDocument } from "@/components/profile/soul-memory-document";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { Input } from "@/components/ui/input";
import { readLabelledSoulFacts, setLabelledSoulFact, ageFromDateOfBirth } from "@/lib/pkm/soul-labelled-facts";
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
    const birth = readLabelledSoulFacts(current.draft).get("date of birth")?.value;
    if (birth && ageFromDateOfBirth(birth) === null) {
      morphyToast.error("Date of birth must be a real past date.");
      return;
    }
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
        morphyToast.error(result.message || "memory.md could not be saved. Your draft is still here.");
        return;
      }
      clearAgentPkmContext(userId, { preserveMarkdown: true });
      const document = { markdown: result.markdown ?? "", persisted: true };
      setState({ session, document, draft: document.markdown, editing: false });
      morphyToast.success("memory.md saved");
    } catch {
      if (currentSession.current === session && isVaultSessionEpochCurrent(epoch)) morphyToast.error("memory.md could not be saved. Your draft is still here.");
    } finally {
      saveInFlight.current = false;
      if (currentSession.current === session) setSavingSession(null);
    }
  };

  if (!verified) return <p role="status" className="py-4 text-sm text-muted-foreground">Reconnect your account to open memory.md.</p>;
  // The same shared Live Mirror preview as Profile and One's sheet, above
  // the Soul view. It stays out of the way while memory.md is being edited.
  const livePreview = active && !editing ? <LiveMirrorPreview showOpenMemory={false} /> : null;
  if (failed && !editing) return <div className="min-w-0 space-y-[var(--app-form-section-gap)]">
    {livePreview}
    <div role="status" className="space-y-3 py-4">
      <p className="text-sm text-muted-foreground">memory.md couldn’t be opened.</p>
      <Button variant="muted" onClick={() => setRetry(value => value + 1)}>Try again</Button>
    </div>
  </div>;
  if (!current) return <div className="min-w-0 space-y-[var(--app-form-section-gap)]">
    {livePreview}
    <p role="status" className="py-4 text-sm text-muted-foreground">Opening memory.md…</p>
  </div>;
  const sync = peekMarkdownMemory(userId)?.syncStatus;
  return <div className="min-w-0 space-y-[var(--app-form-section-gap)]">
    {livePreview}
    <section aria-label="memory.md" className="min-w-0 space-y-[var(--app-form-section-gap)] pb-6">
    <div className="flex flex-col items-start gap-2 px-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <p className="ui-text-row-description min-w-0 flex-1">The memory One uses in every conversation.</p>
      {editing ? <div className="flex flex-wrap gap-2">
        <Button variant="muted" className="min-h-11" disabled={saving} onClick={cancelEdit}>Cancel</Button>
        <Button className="min-h-11" disabled={saving || current.draft === current.document.markdown || current.draft.length > MAX_MARKDOWN_MEMORY_CHARS} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</Button>
      </div> : <Button variant="muted" className="min-h-11 shrink-0" disabled={loading} onClick={() => setState({ ...current, editing: true })}>Edit memory.md</Button>}
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
      <fieldset className="space-y-[var(--app-form-field-gap)]" disabled={saving}>
        <legend className="text-sm font-medium">Identity details</legend>
        <p className="text-xs text-muted-foreground">Optional. Edit or clear a field to remove it. Your account name and photo already work for approved questions; no KYC is needed.</p>
        {[{ label: "Legal name", key: "legal name", type: "text" }, { label: "Date of birth", key: "date of birth", type: "date" }, { label: "Sex", key: "sex", type: "text" }].map(field => <label key={field.key} className="block space-y-2 text-sm">
          <span>{field.label}</span>
          <Input aria-label={field.label} type={field.type} autoComplete="off"
            value={readLabelledSoulFacts(current.draft).get(field.key)?.value ?? ""}
            onChange={event => setState({ ...current, draft: setLabelledSoulFact(current.draft, field.label, event.target.value) })} />
        </label>)}
        <p className="text-xs text-muted-foreground">Age is calculated from your birth date. Sharing age does not share that date. Sex is used only when you provide it.</p>
      </fieldset>
      <Textarea aria-label="memory.md Markdown" value={current.draft} disabled={saving}
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
    </section>
  </div>;
}
