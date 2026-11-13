"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { ConnectPersonRow } from "@/components/connect/connect-person-row";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Search as SearchIcon, X } from "@/components/icons";
import { advisorRequest } from "@/lib/advisor-review/service";
import type { AdvisorCandidate } from "@/lib/advisor-review/contract";
import { advisorServiceLabel } from "@/lib/advisor-review/matching";
import { buildPersonProfileRoute } from "@/lib/navigation/routes";
import type { FinanceShareContext } from "@/lib/services/finance-sharing-service";
import type { AdvisorSearchResult } from "@/lib/services/advisor-directory-service";
import { SegmentedTabs } from "@/lib/morphy-ux/ui";
import { AdvisorRecommendations, useAdvisorRecommendations } from "./advisor-recommendations";
import finance from "@/components/kai/shared/finance-workspace.module.css";
import styles from "./advisor-review.module.css";

type Result = { items: AdvisorCandidate[]; directory: AdvisorSearchResult | null; hasMore: boolean };
type Search =
  | { scope: "connections" }
  | { scope: "global"; query: string }
  | ({ scope: "nearby"; radiusMiles: number } & ({ postalCode: string } | { latitude: number; longitude: number }));
type Tab = "connections" | "nearby" | "all";

export function AdvisorDiscovery({ context, onChoose }: {
  context: FinanceShareContext;
  onChoose: (person: AdvisorCandidate) => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("connections");
  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [postalCode, setPostal] = useState("");
  const [radius, setRadius] = useState("5");
  const [result, setResult] = useState<(Result & { search: Search; page: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recommendations = useAdvisorRecommendations(context, settledQuery);
  const run = useRef(0);
  const pending = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const failed = useRef<{ criteria: Search; page: number } | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const cancel = useCallback(() => {
    run.current++;
    abort.current?.abort();
    pending.current = false;
  }, []);
  const reset = useCallback(() => {
    cancel();
    failed.current = null;
    setBusy(false);
    setResult(null);
    setError(null);
  }, [cancel]);
  useEffect(() => {
    const timer = setTimeout(() => setSettledQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const search = useCallback(async (criteria: Search, page = 1) => {
    if (pending.current || !context.isCurrent()) return;
    pending.current = true;
    const version = ++run.current;
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    setBusy(true);
    setError(null);
    failed.current = null;
    if (page === 1) setResult(null);
    try {
      const value = await advisorRequest<Result>(context, "/candidates", "POST", { ...criteria, page }, controller.signal);
      if (context.isCurrent() && run.current === version && !controller.signal.aborted) {
        setResult(previous => ({
          ...value,
          items: page === 1 ? value.items : [
            ...(previous?.items ?? []),
            ...value.items.filter(person => !previous?.items.some(existing => existing.personRef === person.personRef)),
          ],
          search: criteria, page,
        }));
      }
    } catch {
      if (context.isCurrent() && run.current === version && !controller.signal.aborted) {
        failed.current = { criteria, page };
        setError("Advisors could not be loaded. Please try again.");
      }
    } finally {
      if (run.current === version && !controller.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  }, [context]);
  useEffect(() => {
    reset();
    if (!recommendations.enabled) {
      if (tab === "connections") void search({ scope: "connections" });
      if (tab === "all") void search({ scope: "global", query: settledQuery });
    }
    return cancel;
  }, [tab, settledQuery, recommendations.enabled, search, reset, cancel]);
  useEffect(() => {
    if (tab !== "all" || recommendations.enabled || !result?.hasMore || busy || error || query.trim() !== settledQuery) return;
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting) && !pending.current)
        void search(result.search, result.page + 1);
    }, { root: node.closest("[data-task-region='body']"), rootMargin: "120px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [tab, recommendations.enabled, result, busy, error, query, settledQuery, search]);

  const browse = (next: Tab) => {
    if (!recommendations.clear()) return;
    reset();
    setQuery("");
    setSettledQuery("");
    setTab(next);
  };
  const locate = () => {
    if (!navigator.geolocation) { setError("Location is unavailable. Enter a postal code instead."); return; }
    reset();
    const version = ++run.current;
    setBusy(true);
    navigator.geolocation.getCurrentPosition(position => {
      if (context.isCurrent() && run.current === version)
        void search({ scope: "nearby", radiusMiles: Number(radius), latitude: position.coords.latitude, longitude: position.coords.longitude });
    }, () => {
      if (run.current === version && context.isCurrent()) {
        setBusy(false);
        setError("Location was not available. Enter a postal code instead.");
      }
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  };
  const recommending = tab === "all" && recommendations.enabled;
  const staleQuery = tab === "all" && query.trim() !== settledQuery;
  const loading = (recommending ? recommendations.busy : busy) || staleQuery;
  const failure = recommending ? recommendations.error : error;
  const rows = recommending ? recommendations.matches.map(match => ({ person: match.advisor, description: match.reason }))
    : (result?.items ?? []).map(person => ({ person, description: person.bio || "Verified advisor" }));

  if (!context.isCurrent()) return null;

  return (
    <div className={`${finance.detail} ${styles.stack}`}>
      <SegmentedTabs value={tab} options={[
        { value: "connections", label: "My connections" },
        { value: "nearby", label: "Nearby" },
        { value: "all", label: "All" },
      ]} onValueChange={value => browse(value as Tab)} />
      {tab === "all" ? <>
        <div className={finance.toolbar}>
          <div className="relative min-w-0 flex-1">
            <SearchIcon aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Advisor name" placeholder="Search advisors" maxLength={100} value={query}
              className={`pl-10 ${query ? "pr-11" : "pr-3.5"}`}
              onChange={event => { setQuery(event.target.value); }} />
            {query ? <ShellActionSurface variant="icon" aria-label="Clear search" className="absolute right-0 top-0" onClick={() => setQuery("")}><X className="size-4" /></ShellActionSurface> : null}
          </div>
          <ShellActionSurface variant="pill" aria-pressed={recommendations.enabled}
            data-voice-control-id="finance_recommend_advisor" className={styles.discoveryAction}
            onClick={() => recommendations.toggle()}>
            Recommend advisor
          </ShellActionSurface>
        </div>
        {recommending && recommendations.service ? <div className={styles.row}>
          <p className="ui-text-helper-text">{advisorServiceLabel(recommendations.service)}</p>
          <ShellActionSurface variant="pill" className={styles.discoveryAction} onClick={recommendations.changeChoice}>Change choice</ShellActionSurface>
        </div> : null}
      </> : null}
      {tab === "nearby" ? <>
        <form className={styles.row} onSubmit={event => {
          event.preventDefault();
          if (postalCode.trim().length >= 3) { reset(); void search({ scope: "nearby", postalCode: postalCode.trim(), radiusMiles: Number(radius) }); }
        }}>
          <Input aria-label="Postal code" placeholder="Postal code" maxLength={12} value={postalCode} onChange={event => setPostal(event.target.value)} />
          <select aria-label="Search radius" value={radius} onChange={event => setRadius(event.target.value)}>
            <option value="0.24855">400 m</option><option value="0.621371">1 km</option><option value="5">5 miles</option><option value="25">25 miles</option>
          </select>
          <ShellActionSurface type="submit" variant="pill" className={styles.discoveryAction} disabled={busy || postalCode.trim().length < 3}>Search nearby</ShellActionSurface>
        </form>
        <ShellActionSurface variant="pill" className={styles.discoveryAction} disabled={busy} onClick={locate}>Use my location</ShellActionSurface>
      </> : null}
      {loading ? <p role="status" className="ui-text-helper-text">Finding advisors…</p> : null}
      {failure && !recommendations.choosing ? <div role="alert">
        <p className="ui-text-helper-text">{failure}</p>
        <ShellActionSurface variant="pill" className={styles.discoveryAction} onClick={() => {
          if (recommending) recommendations.retry();
          else if (failed.current) void search(failed.current.criteria, failed.current.page);
        }}>Try again</ShellActionSurface>
      </div> : null}
      <div aria-busy={loading}>
        {rows.map(({ person, description }) => <ConnectPersonRow key={person.personRef} testId="advisor-person-row" leadingInteractive
          leading={<ConnectionPersonAvatar label={person.name} personRef={person.personRef} verified={person.verified} size="compact" />}
          title={person.name} description={<span className="ui-text-helper-text">{person.ready ? description : "Secure introduction unavailable"}</span>}
          onOpen={() => router.push(buildPersonProfileRoute(person.personRef, { from: pathname }))}
          openLabel={`Open ${person.name} profile`}
          trailing={<ShellActionSurface variant="pill" className={styles.discoveryAction} disabled={!person.ready || loading}
            aria-label={`Review introduction with ${person.name}`} onClick={() => {
              if (recommendations.clear()) onChoose(person);
            }}>Review</ShellActionSurface>} />)}
        {tab === "all" && !recommending && result?.hasMore ? <div ref={sentinel} data-testid="advisor-list-sentinel" className="h-px" /> : null}
      </div>
      {!loading && !failure && !rows.length && !recommendations.choosing && (recommending || result) ? <p role="status" className="ui-text-helper-text">
        {recommending ? "No advisors offering this service match your search yet. Try another service or clear your search."
          : tab === "connections" ? "No verified advisors in your connections yet. Try All or Nearby." : "No eligible advisors found."}
      </p> : null}
      {recommending && !recommendations.choosing ? <p className="ui-text-helper-text">Matches are based on stated services. Equal matches are tied.</p> : null}
      {tab !== "all" && result?.hasMore ? <ShellActionSurface variant="pill" className={styles.discoveryAction} disabled={busy} onClick={() => void search(result.search, result.page + 1)}>Load more advisors</ShellActionSurface> : null}
      {result?.directory ? <div className={styles.notice}>
        <p className="ui-text-helper-text">Office distances are approximate. {result.directory.meta.radiusAdjusted ? "The directory adjusted the requested radius." : ""} Directory-only profiles cannot receive an in-app request.</p>
        <a href={result.directory.attribution.sourceUrl} target="_blank" rel="noreferrer">{result.directory.attribution.source}</a><span> · </span>
        <a href={result.directory.attribution.termsUrl} target="_blank" rel="noreferrer">Directory terms</a>
        <p className="ui-text-caption">{result.directory.attribution.notice} {result.directory.attribution.errorReporting} Retrieved {result.directory.attribution.retrievedAt}.</p>
      </div> : null}
      <AdvisorRecommendations controller={recommendations} />
    </div>
  );
}
