"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ExternalConnectorService,
  INSTAGRAM_ACCOUNT_METRICS,
  INSTAGRAM_MEDIA_METRICS,
  validInstagramNumericId,
  type InstagramAccountMetric,
  type InstagramComment,
  type InstagramInsight,
  type InstagramMediaMetric,
  type InstagramMessage,
  type InstagramTaggedMedia,
} from "@/lib/services/external-connector-service";

const inputClass = "min-h-11 w-full rounded-lg border border-border bg-background px-3";
const subSectionClass = "space-y-3 rounded-lg border border-border p-3";

function Insights({ vaultOwnerToken }: { vaultOwnerToken: string }) {
  const [accountMetric, setAccountMetric] = useState<InstagramAccountMetric>("reach");
  const [mediaMetric, setMediaMetric] = useState<InstagramMediaMetric>("reach");
  const [mediaId, setMediaId] = useState("");
  const [accountInsight, setAccountInsight] = useState<InstagramInsight | null>(null);
  const [mediaInsight, setMediaInsight] = useState<InstagramInsight | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    setAccountInsight(null);
    setMediaInsight(null);
    setMessage("");
    return () => { request.current?.abort(); request.current = null; };
  }, [vaultOwnerToken]);

  const load = (kind: "account" | "media") => {
    if (busy) return;
    if (kind === "media" && !validInstagramNumericId(mediaId)) {
      setMessage("Enter a media ID of up to 32 digits.");
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setMessage("");
    const task = kind === "account"
      ? ExternalConnectorService.instagramAccountInsight({ vaultOwnerToken, metric: accountMetric, signal: controller.signal })
      : ExternalConnectorService.instagramMediaInsight({ vaultOwnerToken, mediaId, metric: mediaMetric, signal: controller.signal });
    void task.then((result) => {
      if (controller.signal.aborted) return;
      if (kind === "account") setAccountInsight(result);
      else setMediaInsight(result);
    }).catch(() => {
      if (!controller.signal.aborted) setMessage("Could not load that insight. Check access and try again.");
    }).finally(() => {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    });
  };

  return (
    <div className={subSectionClass}>
      <h4 className="font-medium">Insights</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="instagram-account-metric" className="block text-sm">Account metric</label>
          <select id="instagram-account-metric" className={inputClass} value={accountMetric} disabled={busy}
            onChange={(event) => { setAccountMetric(event.target.value as InstagramAccountMetric); setAccountInsight(null); }}>
            {INSTAGRAM_ACCOUNT_METRICS.map((metric) => <option key={metric} value={metric}>{metric.replaceAll("_", " ")}</option>)}
          </select>
          <Button size="compact" variant="outline" disabled={busy} onClick={() => load("account")}>View account insight</Button>
          {accountInsight && <p className="text-sm">{accountInsight.metric.replaceAll("_", " ")}: {accountInsight.available ? accountInsight.value?.toLocaleString() : "Unavailable"}</p>}
        </div>
        <div className="space-y-2">
          <label htmlFor="instagram-insight-media-id" className="block text-sm">Owned media ID</label>
          <input id="instagram-insight-media-id" className={inputClass} inputMode="numeric" maxLength={32} disabled={busy}
            value={mediaId} onChange={(event) => { setMediaId(event.target.value); setMediaInsight(null); }} />
          <label htmlFor="instagram-media-metric" className="block text-sm">Media metric</label>
          <select id="instagram-media-metric" className={inputClass} value={mediaMetric} disabled={busy}
            onChange={(event) => { setMediaMetric(event.target.value as InstagramMediaMetric); setMediaInsight(null); }}>
            {INSTAGRAM_MEDIA_METRICS.map((metric) => <option key={metric} value={metric}>{metric.replaceAll("_", " ")}</option>)}
          </select>
          <Button size="compact" variant="outline" disabled={busy || !validInstagramNumericId(mediaId)} onClick={() => load("media")}>View media insight</Button>
          {mediaInsight && <p className="text-sm">{mediaInsight.metric.replaceAll("_", " ")}: {mediaInsight.available ? mediaInsight.value?.toLocaleString() : "Unavailable"}</p>}
        </div>
      </div>
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{busy ? "Loading insight…" : message}</p>
    </div>
  );
}

type CommentAction = { kind: "reply" | "hide" | "unhide" | "delete"; commentId: string };

function Comments({ vaultOwnerToken }: { vaultOwnerToken: string }) {
  const [mediaId, setMediaId] = useState("");
  const [loadedMediaId, setLoadedMediaId] = useState<string | null>(null);
  const [comments, setComments] = useState<InstagramComment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [action, setAction] = useState<CommentAction | null>(null);
  const [replyText, setReplyText] = useState("");
  const [uncertainActions, setUncertainActions] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  const locked = useRef(false);

  useEffect(() => {
    setComments([]);
    setLoadedMediaId(null);
    setNextCursor(null);
    setAction(null);
    setUncertainActions(new Set());
    setMessage("");
    return () => { request.current?.abort(); request.current = null; locked.current = false; };
  }, [vaultOwnerToken]);

  const load = (after?: string) => {
    if (locked.current) return;
    if (!validInstagramNumericId(mediaId)) {
      setMessage("Enter a media ID of up to 32 digits.");
      return;
    }
    locked.current = true;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setAction(null);
    setMessage("");
    void ExternalConnectorService.instagramComments({ vaultOwnerToken, mediaId, after, signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;
        setLoadedMediaId(mediaId);
        setComments((current) => after ? [...current, ...page.comments.filter((item) => !current.some((old) => old.id === item.id))] : page.comments);
        setNextCursor(page.nextCursor);
      }).catch(() => {
        if (!controller.signal.aborted) setMessage("Could not load comments for this owned post.");
      }).finally(() => {
        if (request.current === controller) request.current = null;
        locked.current = false;
        if (!controller.signal.aborted) setBusy(false);
      });
  };

  const perform = () => {
    if (!action || locked.current || loadedMediaId !== mediaId) return;
    if (action.kind === "reply" && (!replyText.trim() || replyText.length > 2200)) return;
    const selected = action;
    const text = replyText;
    locked.current = true;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setAction(null);
    setMessage("");
    const common = { vaultOwnerToken, commentId: selected.commentId, signal: controller.signal };
    const task = selected.kind === "reply"
      ? ExternalConnectorService.instagramReplyToComment({ ...common, message: text })
      : selected.kind === "delete"
        ? ExternalConnectorService.instagramDeleteComment(common)
        : ExternalConnectorService.instagramSetCommentHidden({ ...common, hidden: selected.kind === "hide" });
    void task.then(() => {
      if (controller.signal.aborted) return;
      if (selected.kind === "delete") setComments((current) => current.filter((item) => item.id !== selected.commentId));
      if (selected.kind === "hide" || selected.kind === "unhide") {
        setComments((current) => current.map((item) => item.id === selected.commentId
          ? { ...item, hidden: selected.kind === "hide" } : item));
      }
      if (selected.kind === "reply") setReplyText("");
      setMessage(selected.kind === "reply" ? "Reply sent." : selected.kind === "delete" ? "Comment deleted." : "Comment visibility updated.");
    }).catch(() => {
      if (controller.signal.aborted) return;
      setUncertainActions((current) => new Set(current).add(`${selected.kind}:${selected.commentId}`));
      setMessage("The result could not be confirmed. Check Instagram before attempting this action again.");
    }).finally(() => {
      if (request.current === controller) request.current = null;
      locked.current = false;
      if (!controller.signal.aborted) setBusy(false);
    });
  };

  const review = (next: CommentAction) => {
    if (busy || uncertainActions.has(`${next.kind}:${next.commentId}`)) return;
    setAction(next);
    setReplyText("");
    setMessage("");
  };

  return (
    <div className={subSectionClass}>
      <h4 className="font-medium">Comments on your post</h4>
      <label htmlFor="instagram-comments-media-id" className="block text-sm">Owned media ID</label>
      <div className="flex flex-wrap gap-2">
        <input id="instagram-comments-media-id" className={`${inputClass} flex-1`} inputMode="numeric" maxLength={32} disabled={busy}
          value={mediaId} onChange={(event) => { setMediaId(event.target.value); setLoadedMediaId(null); setComments([]); setNextCursor(null); setAction(null); }} />
        <Button size="compact" variant="outline" disabled={busy || !validInstagramNumericId(mediaId)} onClick={() => load()}>Load comments</Button>
      </div>
      {loadedMediaId === mediaId && comments.length === 0 && <p className="text-sm text-muted-foreground">No comments found.</p>}
      {loadedMediaId === mediaId && comments.map((comment) => (
        <div key={comment.id} className="space-y-2 rounded-lg border border-border p-3">
          <p className="break-words text-sm"><strong>{comment.username || "Instagram user"}</strong>: {comment.text}</p>
          <p className="text-xs text-muted-foreground">ID {comment.id}{comment.hidden ? " · Hidden" : ""}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="compact" variant="outline" disabled={busy || uncertainActions.has(`reply:${comment.id}`)} onClick={() => review({ kind: "reply", commentId: comment.id })}>Reply</Button>
            <Button size="compact" variant="outline" disabled={busy || uncertainActions.has(`${comment.hidden ? "unhide" : "hide"}:${comment.id}`)} onClick={() => review({ kind: comment.hidden ? "unhide" : "hide", commentId: comment.id })}>{comment.hidden ? "Unhide" : "Hide"}</Button>
            <Button size="compact" variant="outline" disabled={busy || uncertainActions.has(`delete:${comment.id}`)} onClick={() => review({ kind: "delete", commentId: comment.id })}>Delete</Button>
          </div>
        </div>
      ))}
      {loadedMediaId === mediaId && nextCursor && <Button size="compact" variant="outline" disabled={busy} onClick={() => load(nextCursor)}>Load more comments</Button>}
      {action && <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3" aria-label="Confirm Instagram comment action">
        <p className="text-sm font-medium">Confirm {action.kind} for comment {action.commentId}</p>
        {action.kind === "reply" && <>
          <label htmlFor="instagram-comment-reply" className="block text-sm">Reply text</label>
          <textarea id="instagram-comment-reply" className="min-h-24 w-full rounded-lg border border-border bg-background p-3" maxLength={2200}
            value={replyText} onChange={(event) => setReplyText(event.target.value)} />
        </>}
        <div className="flex gap-2">
          <Button size="compact" disabled={busy || (action.kind === "reply" && !replyText.trim())} onClick={perform}>Confirm {action.kind}</Button>
          <Button size="compact" variant="outline" onClick={() => setAction(null)}>Cancel</Button>
        </div>
      </div>}
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{busy ? "Working…" : message}</p>
    </div>
  );
}

function TaggedMedia({ vaultOwnerToken }: { vaultOwnerToken: string }) {
  const [media, setMedia] = useState<InstagramTaggedMedia[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    setMedia([]); setNextCursor(null); setLoaded(false); setMessage("");
    return () => { request.current?.abort(); request.current = null; };
  }, [vaultOwnerToken]);

  const load = (after?: string) => {
    if (busy) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setMessage("");
    void ExternalConnectorService.instagramTaggedMedia({ vaultOwnerToken, after, signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;
        setLoaded(true);
        setMedia((current) => after ? [...current, ...page.media.filter((item) => !current.some((old) => old.id === item.id))] : page.media);
        setNextCursor(page.nextCursor);
      }).catch(() => {
        if (!controller.signal.aborted) setMessage("Could not load tagged media. Check access and try again.");
      }).finally(() => {
        if (request.current === controller) request.current = null;
        if (!controller.signal.aborted) setBusy(false);
      });
  };

  return (
    <div className={subSectionClass}>
      <h4 className="font-medium">Posts tagging your account</h4>
      <p className="text-sm text-muted-foreground">These are posts that tag your connected account.</p>
      <Button size="compact" variant="outline" disabled={busy} onClick={() => load()}>Load tagged posts</Button>
      {loaded && media.length === 0 && <p className="text-sm text-muted-foreground">No tagged posts found.</p>}
      {media.map((item) => <p key={item.id} className="text-sm">
        <span>{item.username ? `@${item.username} · ` : ""}</span>
        <a href={item.permalink} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Open tagged post</a>
      </p>)}
      {nextCursor && <Button size="compact" variant="outline" disabled={busy} onClick={() => load(nextCursor)}>Load more tagged posts</Button>}
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{busy ? "Loading tagged posts…" : message}</p>
    </div>
  );
}

function Messages({ vaultOwnerToken }: { vaultOwnerToken: string }) {
  const [recipientId, setRecipientId] = useState("");
  const [loadedRecipientId, setLoadedRecipientId] = useState<string | null>(null);
  const [messages, setMessages] = useState<InstagramMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [confirmText, setConfirmText] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const request = useRef<AbortController | null>(null);
  const locked = useRef(false);

  useEffect(() => {
    setLoadedRecipientId(null); setMessages([]); setDraft(""); setConfirmText(null); setUncertain(false); setStatus("");
    return () => { request.current?.abort(); request.current = null; locked.current = false; };
  }, [vaultOwnerToken]);

  const load = () => {
    if (locked.current) return;
    if (!validInstagramNumericId(recipientId)) { setStatus("Enter a recipient ID of up to 32 digits."); return; }
    locked.current = true;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setStatus("");
    setConfirmText(null);
    void ExternalConnectorService.instagramRecentMessages({ vaultOwnerToken, recipientId, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setLoadedRecipientId(recipientId);
        setMessages(result.messages);
        setUncertain(false);
      }).catch(() => {
        if (!controller.signal.aborted) setStatus("Could not load this Instagram conversation.");
      }).finally(() => {
        if (request.current === controller) request.current = null;
        locked.current = false;
        if (!controller.signal.aborted) setBusy(false);
      });
  };

  const send = () => {
    if (locked.current || confirmText === null || loadedRecipientId !== recipientId || uncertain) return;
    const message = confirmText;
    locked.current = true;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setConfirmText(null);
    setUncertain(true);
    setStatus("");
    void ExternalConnectorService.instagramSendTextMessage({ vaultOwnerToken, recipientId, message, signal: controller.signal })
      .then(() => {
        if (controller.signal.aborted) return;
        setDraft("");
        setStatus("Message sent. Load the conversation to see the latest messages.");
      }).catch(() => {
        if (!controller.signal.aborted) setStatus("Sending could not be confirmed. Check Instagram, then reload the conversation before trying again.");
      }).finally(() => {
        if (request.current === controller) request.current = null;
        locked.current = false;
        if (!controller.signal.aborted) setBusy(false);
      });
  };

  const draftValid = Boolean(draft.trim()) && draft.length <= 1000 && new TextEncoder().encode(draft).byteLength <= 1000;

  return (
    <div className={subSectionClass}>
      <h4 className="font-medium">Instagram conversation</h4>
      <p className="text-sm text-muted-foreground">Enter a recipient's Instagram numeric ID to read that conversation. Replies require a message from them in the past 24 hours.</p>
      <label htmlFor="instagram-recipient-id" className="block text-sm">Recipient ID</label>
      <div className="flex flex-wrap gap-2">
        <input id="instagram-recipient-id" className={`${inputClass} flex-1`} inputMode="numeric" maxLength={32} disabled={busy} value={recipientId}
          onChange={(event) => { setRecipientId(event.target.value); setLoadedRecipientId(null); setMessages([]); setConfirmText(null); setUncertain(false); }} />
        <Button size="compact" variant="outline" disabled={busy || !validInstagramNumericId(recipientId)} onClick={load}>Load conversation</Button>
      </div>
      {loadedRecipientId === recipientId && messages.length === 0 && <p className="text-sm text-muted-foreground">No messages found.</p>}
      {loadedRecipientId === recipientId && messages.map((item) => <div key={item.id} className="rounded-lg border border-border p-2 text-sm">
        <strong>{item.senderId === recipientId ? "Them" : "You"}</strong>: <span className="break-words">{item.text}</span>
      </div>)}
      {loadedRecipientId === recipientId && <>
        <label htmlFor="instagram-message-draft" className="block text-sm">Text reply</label>
        <textarea id="instagram-message-draft" className="min-h-24 w-full rounded-lg border border-border bg-background p-3" maxLength={1000} disabled={busy}
          value={draft} onChange={(event) => { setDraft(event.target.value); setConfirmText(null); }} />
        <Button size="compact" variant="outline" disabled={busy || uncertain || !draftValid} onClick={() => setConfirmText(draft)}>Review reply</Button>
      </>}
      {confirmText !== null && <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3" aria-label="Confirm Instagram message">
        <p className="text-sm font-medium">Send to recipient {recipientId}?</p>
        <p className="break-words text-sm">{confirmText}</p>
        <div className="flex gap-2">
          <Button size="compact" disabled={busy} onClick={send}>Confirm send</Button>
          <Button size="compact" variant="outline" onClick={() => setConfirmText(null)}>Cancel</Button>
        </div>
      </div>}
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{busy ? "Working…" : status}</p>
    </div>
  );
}

/** On-demand Instagram Login capabilities for the connected Vault Owner. */
export function InstagramManage({ vaultOwnerToken }: { vaultOwnerToken: string }) {
  return (
    <section className="space-y-3 rounded-xl border border-border p-3" aria-label="Manage Instagram">
      <h3 className="font-semibold">Manage Instagram</h3>
      <p className="text-sm text-muted-foreground">Read account activity and review each reply or moderation action before it is sent.</p>
      <details className="space-y-2"><summary className="cursor-pointer text-sm font-medium">Insights</summary><Insights vaultOwnerToken={vaultOwnerToken} /></details>
      <details className="space-y-2"><summary className="cursor-pointer text-sm font-medium">Comments</summary><Comments vaultOwnerToken={vaultOwnerToken} /></details>
      <details className="space-y-2"><summary className="cursor-pointer text-sm font-medium">Tagged media</summary><TaggedMedia vaultOwnerToken={vaultOwnerToken} /></details>
      <details className="space-y-2"><summary className="cursor-pointer text-sm font-medium">Messages</summary><Messages vaultOwnerToken={vaultOwnerToken} /></details>
    </section>
  );
}
