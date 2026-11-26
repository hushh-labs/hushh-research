"use client";

import { useEffect, useState } from "react";
import { usePrivateMailSession } from "@/lib/mail/private-mail-session";
import { MailFollowupsService } from "@/lib/services/mail-followups-service";
import type { PrivateMailAccount } from "@/lib/services/private-google-connections";

export function PrivateMailOverview({ mailbox }: { mailbox: PrivateMailAccount }) {
  const session = usePrivateMailSession();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Awaited<ReturnType<typeof MailFollowupsService.recent>>>();
  const [error, setError] = useState(false);
  const [source, setSource] = useState("");
  const [message, setMessage] = useState<Awaited<ReturnType<typeof MailFollowupsService.open>>>();
  const { accountId: account, credentialId: connection, email } = mailbox;
  useEffect(() => {
    const abort = new AbortController();
    const box = {account, connection, address: email ?? ""};
    setError(false);
    setResult(undefined);
    setMessage(undefined);
    if (source) {
      void MailFollowupsService.open(box, source, abort.signal).then(value => {
        if (!abort.signal.aborted) setMessage(value);
      }).catch(() => { if (!abort.signal.aborted) setError(true); });
    } else {
      const list = search ? MailFollowupsService.search(box, search, abort.signal) : MailFollowupsService.recent(box, abort.signal);
      void list.then(value => { if (!abort.signal.aborted) setResult(value); })
        .catch(() => { if (!abort.signal.aborted) setError(true); });
    }
    return () => abort.abort();
  }, [account, connection, email, search, source, attempt]);
  const brief = session?.brief;
  return <section className="space-y-4" aria-label="Mailbox overview">
    <h2>Overview</h2>
    {brief && <><time dateTime={brief.generatedAt}>{new Date(brief.generatedAt).toLocaleString()}</time>
      {brief.attention.length === 0 && <p>Nothing needs attention</p>}
      {brief.attention.map(item => <article key={item.id}><h3>{item.title}</h3><p>{item.reason}</p>
        <button onClick={() => setSource(item.action.sourceId)}>View email</button></article>)}
      {brief.updates.map(item => <article key={item.id}><h3>{item.title}</h3><p>{item.line}</p></article>)}</>}
    {session?.briefUpdating && <p role="status">{brief ? "Updating…" : "Checking your mail…"}</p>}
    {session?.briefError && <p>Couldn’t update Overview. <button onClick={session.retryBrief}>Retry</button></p>}
    <form onSubmit={event => { event.preventDefault(); setSource(""); setSearch(query.trim()); }}>
      <input aria-label="Search mail" value={query} onChange={event => setQuery(event.target.value)} /><button>Search</button>
    </form>
    {source && <button onClick={() => setSource("")}>Back to mail</button>}
    {message && <article><h3>{message.subject}</h3><p>{message.sender}</p><p className="whitespace-pre-wrap">{message.body}</p></article>}
    {error ? <p>Couldn’t load mail. <button onClick={() => setAttempt(value => value + 1)}>Retry</button></p> :
      !message && !result ? <p role="status">Loading mail…</p> : null}
    {result && <><h3>{search ? "Search results" : "Recent mail"}</h3>
      {result.items.length === 0 && <p>No messages found.</p>}
      {result.items.map(item => <button className="block text-left" key={item.source} onClick={() => setSource(item.source)}>
        {item.subject} · {item.sender}</button>)}</>}
  </section>;
}
