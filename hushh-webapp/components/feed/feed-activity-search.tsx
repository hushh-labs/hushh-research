"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useRouter } from "next/navigation";
import { X, CalendarDays } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { feedDayLabel } from "@/lib/feed/feed-timestamp";
import { feedScopes } from "@/lib/feed/agent-scopes";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { subscribeFeedPresentationRevision } from "@/lib/cache/feed-invalidation-epoch";
import { FEED_SEARCH_OPEN_EVENT, FEED_SEARCH_RESET_EVENT } from "@/lib/feed/feed-search-events";
import { availableFeedScopes, feedScopeLabel, matchesCurrentFeedAction } from "@/lib/feed/agent-scopes";
import { getAppScrollRoot } from "@/lib/navigation/use-scroll-reset";
import { feedResultHref } from "@/lib/feed/result-navigation";
import { searchFeed, clearFeedSearchCache } from "@/lib/feed/search-cache";
import { useContactNameSearch } from "@/lib/feed/use-contact-name-search";
import { PRIVATE_NAMES_CHANGED } from "@/lib/connections/private-contact-names";
import { armFeedSearchReturn, retainFeedSearch, clearFeedSearch, type FeedSearchSnapshot, type ActivityCriteria } from "@/lib/feed/feed-search-memory";
import type { FeedItem, FeedService } from "@/lib/services/feed-service";
import type { FeedActionable } from "@/lib/feed/use-feed-actionables";
import { FeedRow } from "./feed-row";
import { FeedActionableRow } from "./feed-actionable-row";
import { FeedFinanceSearch } from "./feed-finance-search";
import { FeedDriveSearch } from "./feed-drive-search";
type SearchResult = Awaited<ReturnType<typeof FeedService.searchActivity>>;
function dateBoundary(value: string, next = false): string | null {
    if (!value)
        return null;
    const date = new Date(`${value}T00:00:00`);
    if (next)
        date.setDate(date.getDate() + 1);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
/** Server-ranked owner search; source decisions remain in their owning flow. */
export function FeedActivitySearch({ ownerId, getToken, isCurrent, onOpen, onModeChange, pinnedOperations, initial, actionables = [], persona = "investor" }: {
    ownerId: string;
    getToken: () => Promise<string>;
    isCurrent: () => boolean;
    onOpen: (item: FeedItem) => void;
    onModeChange: (active: boolean) => void;
    pinnedOperations?: ReadonlySet<string>;
    initial?: FeedSearchSnapshot | null;
    actionables?: FeedActionable[];
    persona?: "investor" | "ria";
}) {
    const router = useRouter();
    const resolveName = useContactNameSearch(ownerId);
    const vaultEpoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
    const initialVaultEpoch = useRef(vaultEpoch);
    const [open, setOpen] = useState(Boolean(initial?.open || initial?.submitted));
    const [query, setQuery] = useState(initial?.query || "");
    const [scope, setScope] = useState(initial?.agent || "");
    const [from, setFrom] = useState(initial?.from || "");
    const [through, setThrough] = useState(initial?.through || "");
    const [dates, setDates] = useState(Boolean(initial?.filtersOpen));
    const [submitted, setSubmitted] = useState<ActivityCriteria | null>(initial?.submitted || null);
    const [items, setItems] = useState<FeedItem[]>(initial?.items || []);
    const [cursor, setCursor] = useState<string | null>(initial?.cursor || null);
    const [topHit, setTopHit] = useState<SearchResult["top_hit"]>(initial?.topHit || null);
    const [suggestion, setSuggestion] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const [privateNamesUnavailable, setPrivateNamesUnavailable] = useState(false);
    const [financeCount, setFinanceCount] = useState<number | null>(initial?.financeItems?.length ?? 0);
    const [financeItems, setFinanceItems] = useState(initial?.financeItems);
    const [driveCount, setDriveCount] = useState<number | null>(null);
    const scrollFrame = useRef<number | null>(null);
    const financeScrollRestored = useRef(false);
    const restoreScroll = useCallback(() => {
        if (!initial?.scrollTop)
            return;
        if (scrollFrame.current !== null)
            cancelAnimationFrame(scrollFrame.current);
        scrollFrame.current = requestAnimationFrame(() => {
            if (!isCurrent())
                return;
            const root = getAppScrollRoot();
            if (root)
                root.scrollTop = initial.scrollTop!;
            else
                window.scrollTo(0, initial.scrollTop!);
        });
    }, [initial, isCurrent]);
    const financeEpoch = useRef(vaultEpoch);
    const onFinanceRecords = useCallback((records: NonNullable<FeedSearchSnapshot["financeItems"]>) => {
        financeEpoch.current = vaultEpoch;
        setFinanceItems(records);
        // The unlocked source may mount after the first scroll restoration.
        if (financeScrollRestored.current)
            return;
        financeScrollRestored.current = true;
        if (initialVaultEpoch.current === vaultEpoch && initial?.query === query && initial.agent === scope)
            restoreScroll();
    }, [vaultEpoch, initial, query, scope, restoreScroll]);
    const retainedFinanceItems = financeEpoch.current === vaultEpoch ? financeItems : undefined;
    useEffect(() => { if (vaultEpoch !== initialVaultEpoch.current)
        setFinanceItems(undefined); }, [vaultEpoch]);
    const generation = useRef(0), immediate = useRef(false), returned = useRef(Boolean(initial?.submitted && !initial?.pending)), scheduled = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clear = useCallback(() => {
        generation.current++;
        clearFeedSearch();
        setOpen(false);
        setQuery("");
        setScope("");
        setFrom("");
        setThrough("");
        setDates(false);
        setSubmitted(null);
        setItems([]);
        setCursor(null);
        setTopHit(null);
        setSuggestion(null);
        setBusy(false);
        setFailed(false);
        setPrivateNamesUnavailable(false);
        setFinanceItems(undefined);
        setFinanceCount(0);
        onModeChange(false);
    }, [onModeChange]);
    const activate = useCallback(() => { onModeChange(true); immediate.current = true; setOpen(true); }, [onModeChange]);
    useEffect(() => { window.addEventListener(FEED_SEARCH_OPEN_EVENT, activate); window.addEventListener(FEED_SEARCH_RESET_EVENT, clear); return () => { window.removeEventListener(FEED_SEARCH_OPEN_EVENT, activate); window.removeEventListener(FEED_SEARCH_RESET_EVENT, clear); }; }, [activate, clear]);
    useLayoutEffect(() => {
        restoreScroll();
        return () => { if (scrollFrame.current !== null)
            cancelAnimationFrame(scrollFrame.current); };
    }, [restoreScroll]);
    useEffect(() => () => { generation.current++; }, []);
    useEffect(() => subscribeFeedPresentationRevision(owner => {
        if (!owner || owner === ownerId)
            clear();
    }), [ownerId, clear]);
    useEffect(() => {
        if (isCurrent())
            retainFeedSearch(ownerId, { open, query, person: "", agent: scope, from, through, filtersOpen: dates, submitted, items, cursor, pending: busy, topHit, financeItems: retainedFinanceItems });
    }, [ownerId, open, query, scope, from, through, dates, submitted, items, cursor, busy, topHit, retainedFinanceItems, isCurrent]);
    useBackLayer("/one/feed", open ? 1 : 0, () => {
        if (dates)
            setDates(false);
        else
            clear();
        return true;
    });
    const run = useCallback(async (criteria: ActivityCriteria, append = false) => {
        if (!isCurrent())
            return;
        const request = ++generation.current;
        const current = () => request === generation.current && isCurrent();
        setBusy(true);
        setFailed(false);
        setSubmitted(criteria);
        if (!append) {
            setItems([]);
            setCursor(null);
            setTopHit(null);
            setSuggestion(null);
        }
        try {
            const token = await getToken();
            if (!current())
                return;
            const name = await resolveName(criteria.query, token, current);
            if (!current()) return;
            const page = await searchFeed(ownerId, { query: name.query, person_ref: name.personRef || null, scope: criteria.agent || null, persona, from_at: criteria.fromAt, before_at: criteria.beforeAt, cursor: append ? cursor : null, limit: 20 }, token, current);
            if (!current())
                return;
            setPrivateNamesUnavailable(name.privateNamesUnavailable === true);
            setSubmitted({ ...criteria, effectiveQuery: name.query, personRef: name.personRef,
              personUserId: name.personRef && page.matched_person_ref === name.personRef ? name.personUserId : undefined });
            setItems(previous => {
                const unique = new Map((append ? previous : []).map(item => [item.activity_group_id || item.id, item]));
                for (const item of page.items)
                    unique.set(item.activity_group_id || item.id, item);
                return [...unique.values()];
            });
            setCursor(page.next_cursor);
            if (!append) {
                setTopHit(page.top_hit);
                setSuggestion(page.suggestion || null);
            }
        }
        catch {
            if (current())
                setFailed(true);
        }
        finally {
            if (current())
                setBusy(false);
        }
    }, [isCurrent, getToken, ownerId, persona, cursor, resolveName]);
    // A criteria change retires the previous request synchronously. Only text
    // entry is debounced; a scope selection takes effect immediately, including "".
    const runRef = useRef(run);
    runRef.current = run;
    const nameEpoch = useRef(vaultEpoch);
    useLayoutEffect(() => {
        if (nameEpoch.current === vaultEpoch) return;
        nameEpoch.current = vaultEpoch;
        if (submitted?.personRef) clear();
    }, [vaultEpoch, submitted?.personRef, clear]);
    useEffect(() => {
        const changed = () => { clearFeedSearchCache(); if (open) void runRef.current({ query, person: "", agent: scope, fromAt: dateBoundary(from), beforeAt: dateBoundary(through, true), revision: Date.now() }); };
        window.addEventListener(PRIVATE_NAMES_CHANGED, changed);
        return () => window.removeEventListener(PRIVATE_NAMES_CHANGED, changed);
    }, [open, query, scope, from, through]);

    useEffect(() => {
        if (!open)
            return;
        generation.current++;
        onModeChange(true);
        if (returned.current) {
            returned.current = false;
            return;
        }
        const criteria = { query, person: "", agent: scope, fromAt: dateBoundary(from), beforeAt: dateBoundary(through, true), revision: Date.now() };
        if (criteria.fromAt && criteria.beforeAt && criteria.fromAt >= criteria.beforeAt) {
            setFailed(true);
            return;
        }
        const delay = immediate.current ? 0 : 200;
        immediate.current = false;
        const timer = setTimeout(() => void runRef.current(criteria), delay);
        scheduled.current = timer;
        return () => clearTimeout(timer);
    }, [open, query, scope, from, through, persona, onModeChange]);
    const selectScope = (value: string) => { if (value === scope)
        return; generation.current++; onModeChange(true); setItems([]); setTopHit(null); setFinanceItems(undefined); immediate.current = true; setScope(value); };
    useLocalOnboardingActionHandler("feed.search_activity", async (slots) => {
        const requested = typeof slots.scope === "string" ? slots.scope : "";
        if (requested && !Object.hasOwn(feedScopes, requested))
            return { status: "blocked", summary: "Choose an available agent." };
        activate();
        selectScope(requested);
        if (typeof slots.query === "string")
            setQuery(slots.query.slice(0, 120));
        return { status: "succeeded", summary: "Feed search opened." };
    });
    const openResult = (item: FeedItem) => { armFeedSearchReturn(); onOpen(item); };
    const changeQuery = (value: string) => { generation.current++; setItems([]); setTopHit(null); setFinanceItems(undefined); setQuery(value); };
    const submitCurrent = () => {
        if (scheduled.current)
            clearTimeout(scheduled.current);
        void run({ query, person: "", agent: scope, fromAt: dateBoundary(from), beforeAt: dateBoundary(through, true), revision: Date.now() });
    };
    const named = submitted?.query === query && submitted.personRef ? submitted : null;
    const pending = actionables.filter(item => (!scope || item.scopeId === scope) &&
        (!named || (Boolean(named.personUserId) && (item.person?.userId === named.personUserId || item.person?.personRef === named.personRef))) &&
        matchesCurrentFeedAction(item, named?.effectiveQuery ?? query)
        && (!from || (item.displayTimestamp != null && item.displayTimestamp >= Date.parse(dateBoundary(from)!)))
        && (!through || (item.displayTimestamp != null && item.displayTimestamp < Date.parse(dateBoundary(through, true)!))));
    const navigate = (href: string) => { const target = feedResultHref(href); armFeedSearchReturn(target); router.push(target); };
    const pendingKeys = new Set(pending.flatMap(item => item.operationKey ? [item.operationKey, ...(item.operationKeys ?? [])] : []));
    const visible = items.filter(item => !item.activity_group_id || (!pinnedOperations?.has(item.activity_group_id) && !pendingKeys.has(item.activity_group_id)));
    const excluded = (item: FeedItem) => Boolean(item.activity_group_id && (pinnedOperations?.has(item.activity_group_id) || pendingKeys.has(item.activity_group_id)));
    const visibleHit = topHit?.kind === "activity" && excluded(topHit.item) ? null : topHit;
    const activityHit = visibleHit?.kind === "activity" ? visibleHit.item : null;
    const dated = new Map<string, FeedItem[]>();
    for (const item of visible.filter(item => !activityHit || item.id !== activityHit.id)) {
        const label = feedDayLabel(item.created_at);
        dated.set(label, [...(dated.get(label) || []), item]);
    }
    const showFinance = !named && (!scope || scope === "finance" || scope === "advisor");
    const showFiles = Boolean(query.trim() && submitted?.query === query && (!scope || scope === "drive"));
    if (!open)
        return null;
    return <section aria-label="Search activity" className="space-y-3 pb-3">
    <form role="search" onSubmit={(event: FormEvent) => { event.preventDefault(); submitCurrent(); }} className="flex min-w-0 items-center gap-2">
      <Input autoFocus aria-label="Search Feed" placeholder="Search Feed" value={query} maxLength={120} onChange={event => changeQuery(event.target.value)} className="min-w-0 flex-1" data-voice-control-id="feed.search.query"/>
      <select aria-label="Agent scope" value={scope} onChange={event => selectScope(event.target.value)} className="h-11 min-w-0 max-w-[142px] rounded-[var(--app-input-radius)] border bg-background px-2 text-sm" data-voice-control-id="feed.search.scope">
        <option value="">All agents</option>{availableFeedScopes.map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}
      </select>
      <Button type="button" variant="ghost" size="icon" aria-label="Close search" onClick={clear}><X className="size-5"/></Button>
    </form>
    {privateNamesUnavailable ? <p role="status" className="text-xs text-muted-foreground">Private names unavailable</p> : null}
    <div className="flex items-center gap-2">
      {scope ? <Button variant="ghost" className="min-h-11 px-2 text-xs" onClick={() => selectScope("")} aria-label={`Remove ${feedScopeLabel(scope)} scope`}>{feedScopeLabel(scope)} ×</Button> : null}
      {query ? <Button variant="ghost" className="min-h-11 px-2 text-xs" onClick={() => changeQuery("")}>Clear search</Button> : null}
      <Button type="button" variant="ghost" size="icon" aria-label="Dates" aria-expanded={dates} onClick={() => setDates(value => !value)}><CalendarDays className="size-4"/></Button>
      {persona === "ria" && scope === "advisor" ? <Button variant="ghost" className="ml-auto min-h-11 text-sm" onClick={() => navigate("/ria/clients")}>Clients →</Button> : null}
    </div>
    {dates ? <div className="grid grid-cols-2 gap-3 text-sm"><label>From<Input type="date" value={from} onChange={event => setFrom(event.target.value)}/></label><label>Through<Input type="date" min={from || undefined} value={through} onChange={event => setThrough(event.target.value)}/></label></div> : null}
    {failed ? <Button variant="ghost" onClick={submitCurrent}>Retry search</Button> : null}
    {busy ? <p role="status" className="text-xs text-muted-foreground">Searching…</p> : null}
    {suggestion ? <Button variant="ghost" onClick={() => changeQuery(suggestion)}>Search “{suggestion}”</Button> : null}
    {visibleHit ? <section aria-label="Top Hit"><p className="px-2 text-xs text-muted-foreground">Top Hit</p><SettingsGroup separatorInset>
      {activityHit ? <FeedRow item={activityHit} unread={false} openable onOpen={openResult}/> : visibleHit.kind !== "activity" ? <Button variant="ghost" className="h-auto min-h-14 w-full justify-start px-4 text-left" onClick={() => navigate(visibleHit.href)}>{visibleHit.label}</Button> : null}
    </SettingsGroup></section> : null}
    <div aria-label="Activity results">
      {pending.map(item => <FeedActionableRow key={item.id} onNavigate={armFeedSearchReturn} item={{ ...item, href: item.href ? feedResultHref(item.href) : item.href, sourceLabel: feedScopeLabel(item.scopeId || "one") }}/>)}
      {[...dated].map(([date, rows]) => <SettingsGroup key={date} title={date} separatorInset>{rows.map(item => <FeedRow key={item.activity_group_id || item.id} item={item} unread={false} openable onOpen={openResult}/>)}</SettingsGroup>)}
      {!busy && !failed && !cursor && !visibleHit && !visible.length && !pending.length && (!showFinance || financeCount === 0) && (!showFiles || driveCount === 0) ? <div role="status" className="py-5 text-center text-sm text-muted-foreground"><p>{query ? `No activity for “${query}”` : scope ? `No ${feedScopeLabel(scope)} activity` : "No activity yet"}</p>{scope ? <Button variant="ghost" onClick={() => selectScope("")}>Show all</Button> : query ? <Button variant="ghost" onClick={() => changeQuery("")}>Clear search</Button> : null}</div> : null}
      {!busy && cursor ? <Button variant="ghost" onClick={() => submitted && void run(submitted, true)}>Load more</Button> : null}
      {showFinance ? <FeedFinanceSearch key={JSON.stringify([vaultEpoch, submitted?.query, scope, submitted?.fromAt, submitted?.beforeAt])} initialRecords={initialVaultEpoch.current === vaultEpoch && initial?.query === query && initial?.agent === scope && initial?.from === from && initial?.through === through ? initial.financeItems : undefined} onRecords={onFinanceRecords} query={submitted?.query || ""} person="" fromAt={submitted?.fromAt} beforeAt={submitted?.beforeAt} requestRevision={submitted?.revision} excludedOperations={new Set(items.flatMap(item => item.activity_group_id ? [item.activity_group_id] : []))} onResultCount={setFinanceCount} scope={scope}/> : null}
      {showFiles ? <FeedDriveSearch criteria={{ query: named?.effectiveQuery ?? submitted?.query ?? "", personRef: named?.personRef, fromAt: submitted?.fromAt, beforeAt: submitted?.beforeAt }} revision={submitted?.revision} onCount={setDriveCount} /> : null}
    </div>
  </section>;
}
