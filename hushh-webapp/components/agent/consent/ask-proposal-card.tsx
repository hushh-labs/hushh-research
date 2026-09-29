"use client";

/**
 * "One picks, you confirm" (contract C4).
 *
 * One has already chosen the best matching information from the question, so
 * the ask is one sentence, "Ask Kushal for Food preferences · 7 days", with
 * the reason on its own line, and Send and Change. The full catalog appears only
 * behind Change, searched on the server (`searchCatalog`), with human labels.
 *
 * This component never submits by itself: `onSend` is the caller's existing
 * send path, so there is exactly one way a request is created.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronRight, ConsentAgentIcon, Minus, Search } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { REQUEST_DURATION_OPTIONS } from "@/lib/agent/action-directive-summary";
import { proposalDurationLabel, type ScopeProposal } from "@/lib/agent/scope-proposal";
import type { PersonScopeCatalogPage, RequestablePersonScope } from "@/lib/services/person-profile-service";
import { firstName, joinLabels } from "./request-progress";
import {
  initialProposalSelection,
  mergeProposalCatalog,
  proposalCheckState,
  proposalLookups,
  proposalChosenCount,
  proposalChosenLabels,
  proposalRowLabel,
  proposalSendScopes,
  proposalTree,
  proposalUniverse,
  toggleProposalRow,
  type ProposalCheckState,
  type ProposalNode,
} from "@/lib/agent/proposal-selection";

export type AskProposalDraft = {
  scopes: RequestablePersonScope[];
  purpose: string;
  durationHours: number;
};

export type AskProposalCardProps = {
  personName: string;
  proposal: ScopeProposal;
  /** The current authority check has finished and a request may be sent. */
  ready: boolean;
  sending: boolean;
  error: string | null;
  onSend: (draft: AskProposalDraft) => void;
  searchCatalog: (query: string, page: number, signal: AbortSignal) => Promise<PersonScopeCatalogPage>;
  /**
   * Called once when the card appears, with its Send row, so the chat can
   * lift it above the composer. The card never scrolls anything itself.
   */
  revealActions?: (element: HTMLElement) => void;
  /**
   * The person's requestable catalog, already loaded for this card. It says
   * how proposed items nest, so a group row can open to its children.
   */
  catalog?: readonly RequestablePersonScope[];
};

const SEARCH_DEBOUNCE_MS = 200;
const MIN_REASON = 8;

const EMPTY_CATALOG: readonly RequestablePersonScope[] = [];

function CheckMark({ state }: { state: ProposalCheckState }) {
  return (
    <span aria-hidden="true" className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] transition-colors duration-150 ${
      state === "unchecked" ? "border border-border bg-background" : "bg-accent-strong text-white"}`}>
      {state === "checked" ? <Check className="h-3 w-3" /> : state === "mixed" ? <Minus className="h-3 w-3" /> : null}
    </span>
  );
}

/**
 * One selectable row. The whole row is the target; Space toggles, and on a
 * group Enter or Right opens it and Left closes it. The chevron opens without
 * changing the choice.
 */
function ProposalRow({ label, meta, state, disabled, onToggle, expanded, onExpand, nested }: {
  label: string;
  meta?: string | null;
  state: ProposalCheckState;
  disabled: boolean;
  onToggle: () => void;
  expanded?: boolean;
  onExpand?: (open: boolean) => void;
  nested?: boolean;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.key === " ") {
      event.preventDefault();
      onToggle();
    } else if (event.key === "Enter" || event.key === "ArrowRight") {
      event.preventDefault();
      if (onExpand) onExpand(true);
      else if (event.key === "Enter") onToggle();
    } else if (event.key === "ArrowLeft" && onExpand) {
      event.preventDefault();
      onExpand(false);
    }
  };
  return (
    <div className="flex items-stretch">
      <div role="checkbox" aria-checked={state === "mixed" ? "mixed" : state === "checked"} aria-disabled={disabled || undefined}
        aria-expanded={onExpand ? Boolean(expanded) : undefined}
        tabIndex={disabled ? -1 : 0} onClick={() => { if (!disabled) onToggle(); }} onKeyDown={onKeyDown}
        data-testid="ask-proposal-row" data-state={state}
        className={`flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3 py-2 pr-2 text-left outline-none transition-colors duration-150 hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-disabled:cursor-default aria-disabled:opacity-60 ${
          nested ? "pl-11" : "pl-3.5"}`}>
        <CheckMark state={state} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-5 text-foreground [overflow-wrap:anywhere]">{label}</span>
          {meta ? <span className="block text-xs leading-4 text-muted-foreground">{meta}</span> : null}
        </span>
      </div>
      {onExpand ? (
        <button type="button" aria-label={expanded ? `Hide what ${label} includes` : `Show what ${label} includes`}
          aria-expanded={Boolean(expanded)} onClick={() => onExpand(!expanded)}
          className="inline-flex w-11 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <ChevronRight className={`h-4 w-4 transition-transform duration-150 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function ProposalRows({ nodes, extras, selected, disabled, onToggle }: {
  nodes: ProposalNode[];
  extras: RequestablePersonScope[];
  selected: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (scopeRef: string, select: boolean) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const inTree = new Set(proposalUniverse(nodes, []).map((scope) => scope.scopeRef));
  const added = extras.filter((extra) => !inTree.has(extra.scopeRef));
  const setExpanded = (ref: string, value: boolean) => setOpen((current) => {
    const next = new Set(current);
    if (value) next.add(ref);
    else next.delete(ref);
    return next;
  });
  return (
    <div role="group" aria-label="What to ask for" data-testid="ask-proposal-rows"
      className="divide-y divide-border/50 overflow-hidden rounded-[var(--app-card-radius-compact)] bg-background/80">
      {nodes.map((node) => {
        const state = proposalCheckState(node, selected);
        const expanded = open.has(node.scope.scopeRef);
        const label = proposalRowLabel(node.scope);
        return (
          <div key={node.scope.scopeRef}>
            <ProposalRow label={label} state={state} disabled={disabled}
              meta={node.children.length ? `${node.children.length} ${node.children.length === 1 ? "item" : "items"}` : null}
              onToggle={() => onToggle(node.scope.scopeRef, state !== "checked")}
              expanded={expanded}
              onExpand={node.children.length ? (value) => setExpanded(node.scope.scopeRef, value) : undefined} />
            {expanded ? (
              <div role="group" aria-label={`${label} includes`} className="divide-y divide-border/40 border-t border-border/40">
                {node.children.map((child) => {
                  const on = selected.has(child.scopeRef) || selected.has(node.scope.scopeRef);
                  return <ProposalRow key={child.scopeRef} nested label={proposalRowLabel(child)} disabled={disabled}
                    state={on ? "checked" : "unchecked"} onToggle={() => onToggle(child.scopeRef, !on)} />;
                })}
              </div>
            ) : null}
          </div>
        );
      })}
      {added.map((extra) => {
        const on = selected.has(extra.scopeRef);
        return <ProposalRow key={extra.scopeRef} label={proposalRowLabel(extra)} disabled={disabled}
          state={on ? "checked" : "unchecked"} onToggle={() => onToggle(extra.scopeRef, !on)} />;
      })}
    </div>
  );
}

/**
 * "Ask Kushal for Food preferences · 7 days". The reason is its own line
 * under this sentence: the server words it as a standalone phrase ("To pick
 * a restaurant for dinner"), so gluing "for" in front of it read as "for I'd
 * like to know your kind".
 */
export function askSentence(personName: string, labels: string[], durationHours: number): string {
  return [`Ask ${firstName(personName)} for ${joinLabels(labels)}`, proposalDurationLabel(durationHours)].join(" · ");
}

function CatalogPicker({ personName, selected, onToggle, searchCatalog }: {
  personName: string;
  selected: RequestablePersonScope[];
  onToggle: (scope: RequestablePersonScope) => void;
  searchCatalog: AskProposalCardProps["searchCatalog"];
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RequestablePersonScope[]>([]);
  const [page, setPage] = useState<{ page: number; nextPage: number | null } | null>(null);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");
  const controller = useRef<AbortController | null>(null);

  const run = (text: string, pageNumber: number) => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setState("loading");
    searchCatalog(text, pageNumber, next.signal).then((result) => {
      if (next.signal.aborted) return;
      setResults((current) => {
        if (pageNumber === 1) return result.scopes;
        const known = new Set(current.map((scope) => scope.scopeRef));
        return [...current, ...result.scopes.filter((scope) => !known.has(scope.scopeRef))];
      });
      setPage({ page: result.page, nextPage: result.hasMore ? result.nextPage : null });
      setState("idle");
    }).catch(() => {
      if (!next.signal.aborted) setState("error");
    });
  };

  useEffect(() => {
    const timer = window.setTimeout(() => run(query, 1), query ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
    // `run` is recreated each render; the query is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  useEffect(() => () => controller.current?.abort(), []);

  const selectedRefs = new Set(selected.map((scope) => scope.scopeRef));
  return (
    <div className="space-y-2" data-testid="ask-catalog-picker">
      <label className="relative block">
        <span className="sr-only">Search what {firstName(personName)} can share</span>
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="Search" className="pl-10" maxLength={120} />
      </label>
      <ul aria-label="Information you can ask for" aria-busy={state === "loading"}
        className="max-h-72 divide-y divide-border/50 overflow-y-auto rounded-[var(--app-card-radius-compact)] bg-background/80">
        {results.map((scope) => {
          const on = selectedRefs.has(scope.scopeRef);
          return (
            <li key={scope.scopeRef}>
              <button type="button" aria-pressed={on} onClick={() => onToggle(scope)}
                className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2 text-left transition-colors duration-150 hover:bg-accent/40">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-foreground">{scope.label}</span>
                  {scope.description ? <span className="block truncate text-xs text-muted-foreground">{scope.description}</span> : null}
                </span>
                <span aria-hidden="true" className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors duration-150 ${
                  on ? "bg-accent-strong text-white" : "border border-border"}`}>
                  {on ? <Check className="h-3 w-3" /> : null}
                </span>
              </button>
            </li>
          );
        })}
        {state === "idle" && !results.length ? (
          <li className="px-3.5 py-3 text-sm text-muted-foreground">Nothing matches. Try another word.</li>
        ) : null}
      </ul>
      {state === "error" ? <p role="alert" className="text-sm text-muted-foreground">We couldn’t search right now. Please try again.</p> : null}
      {state === "loading" ? <p className="text-xs text-muted-foreground">Searching…</p> : null}
      {page?.nextPage && state !== "loading" ? (
        <MorphyButton type="button" size="sm" variant="none" onClick={() => run(query, page.nextPage!)}>Show more</MorphyButton>
      ) : null}
    </div>
  );
}

export function AskProposalCard({ personName, proposal, ready, sending, error, onSend, searchCatalog, revealActions, catalog = EMPTY_CATALOG }: AskProposalCardProps) {
  const actionsRef = useRef<HTMLDivElement | null>(null);
  // Once per appearance: Send must never sit behind the composer. The first
  // reveal callback is kept, so a re-render never scrolls the chat again.
  const [reveal] = useState(() => revealActions);
  useEffect(() => {
    const element = actionsRef.current;
    if (element) reveal?.(element);
  }, [reveal]);
  // A proposed item the loaded catalog lacks (a broad one sorts past its first
  // page) is looked up by label, so the card still knows what it covers. Send
  // waits for that, so it never sends a broad item and its children apart.
  const lookups = useMemo(() => proposalLookups(proposal, catalog), [proposal, catalog]);
  const lookupKey = lookups.join("\u0000");
  const [found, setFound] = useState<{ key: string; scopes: RequestablePersonScope[] }>({ key: "", scopes: [] });
  // The caller passes a fresh function each render; the lookup is keyed by
  // its labels, not by that identity.
  const search = useRef(searchCatalog);
  useEffect(() => { search.current = searchCatalog; }, [searchCatalog]);
  useEffect(() => {
    if (!ready || !lookupKey) return;
    const controller = new AbortController();
    void Promise.allSettled(lookupKey.split("\u0000").map((label) => search.current(label, 1, controller.signal)))
      .then((results) => {
        if (controller.signal.aborted) return;
        // A failed lookup leaves that item a plain row; it never blocks Send.
        setFound({ key: lookupKey, scopes: results.flatMap((result) => result.status === "fulfilled" ? result.value.scopes : []) });
      });
    return () => controller.abort();
  }, [ready, lookupKey]);
  const placed = !lookupKey || found.key === lookupKey;
  const known = useMemo(() => mergeProposalCatalog(catalog, found.key === lookupKey ? found.scopes : []),
    [catalog, found, lookupKey]);
  // The catalog arrives after the card; the tree is rebuilt from it, and the
  // choice stays the person's: rows they changed keep their state.
  const nodes = useMemo(() => proposalTree(proposal, known), [proposal, known]);
  const [extras, setExtras] = useState<RequestablePersonScope[]>([]);
  const [touched, setTouched] = useState<Map<string, boolean>>(() => new Map());
  const selected = useMemo(() => {
    let next = initialProposalSelection(nodes);
    for (const [ref, value] of touched) next = toggleProposalRow(nodes, next, ref, value);
    return next;
  }, [nodes, touched]);
  const [durationHours, setDurationHours] = useState(proposal.durationHours);
  const [reason, setReason] = useState(proposal.reasonSuggestion);
  const [changing, setChanging] = useState(false);
  const universe = proposalUniverse(nodes, extras);
  const scopes = proposalSendScopes(universe, selected);
  const chosen = proposalChosenCount(nodes, extras, selected);
  const labels = proposalChosenLabels(nodes, extras, selected);
  const canSend = ready && placed && !sending && scopes.length > 0 && scopes.length <= 50 && reason.trim().length >= MIN_REASON;
  const why = proposal.proposed.find((item) => item.why)?.why;

  const setRow = (scopeRef: string, value: boolean) => setTouched((current) => {
    const next = new Map(current);
    next.delete(scopeRef);
    next.set(scopeRef, value);
    return next;
  });
  const toggle = (scope: RequestablePersonScope) => {
    if (!universe.some((entry) => entry.scopeRef === scope.scopeRef)) setExtras((current) => [...current, scope]);
    setRow(scope.scopeRef, !selected.has(scope.scopeRef));
  };

  return (
    <section aria-label={`Ask ${firstName(personName)}`} data-testid="ask-proposal-card"
      className="space-y-3 rounded-[24px] bg-[linear-gradient(145deg,var(--app-accent-surface),color-mix(in_srgb,var(--background)_94%,var(--app-accent-soft)))] p-4 shadow-[0_18px_55px_-38px_var(--app-accent-deep)] sm:p-5">
      <div className="flex items-start gap-3">
        {/* The /one Consent glyph, bare on a transparent well: never a filled tile. */}
        <span data-slot="card-header-icon" className="inline-flex h-9 w-9 shrink-0 items-center justify-center">
          <ConsentAgentIcon className="h-7 w-7" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold leading-6 tracking-[-0.015em] text-foreground [overflow-wrap:anywhere]" data-testid="ask-sentence">
            {labels.length ? askSentence(personName, labels, durationHours) : `Choose what to ask ${firstName(personName)} for`}
          </p>
          {reason.trim() ? (
            <p className="mt-1 text-sm leading-5 text-foreground/80 [overflow-wrap:anywhere]" data-testid="ask-reason">
              {reason.trim()}
            </p>
          ) : null}
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {why ?? `${firstName(personName)} decides what to share, and can stop any time.`}
          </p>
        </div>
      </div>

      <ProposalRows nodes={nodes} extras={extras} selected={selected} disabled={sending} onToggle={setRow} />
      <p className="text-xs font-medium text-muted-foreground" data-testid="ask-proposal-summary" aria-live="polite">
        {chosen} {chosen === 1 ? "item" : "items"} · {proposalDurationLabel(durationHours)}
      </p>

      {changing ? (
        <div className="space-y-3 rounded-[var(--app-card-radius-compact)] bg-background/72 p-3 backdrop-blur-xl">
          <CatalogPicker personName={personName} selected={universe.filter((scope) => selected.has(scope.scopeRef))}
            onToggle={toggle} searchCatalog={searchCatalog} />
          <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
              For how long
              <select value={durationHours} disabled={sending} data-testid="ask-proposal-duration"
                onChange={(event) => setDurationHours(Number(event.target.value))}
                className="block h-11 w-full cursor-pointer rounded-[var(--app-input-radius)] border border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] px-3.5 text-sm font-normal text-foreground">
                {REQUEST_DURATION_OPTIONS.map((option) => (
                  <option key={option.hours} value={option.hours}>{proposalDurationLabel(option.hours)}</option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
              What it is for
              <Input value={reason} disabled={sending} maxLength={500} data-testid="ask-proposal-reason"
                onChange={(event) => setReason(event.target.value)} placeholder="To plan dinner together" />
            </label>
          </div>
        </div>
      ) : null}

      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {!changing && reason.trim().length < MIN_REASON ? (
        <p className="text-xs text-muted-foreground">Add a reason so {firstName(personName)} can decide.</p>
      ) : null}
      <div ref={actionsRef} data-testid="ask-proposal-actions" className="flex flex-wrap items-center gap-2">
        <MorphyButton type="button" size="sm" disabled={!canSend}
          onClick={() => onSend({ scopes, purpose: reason.trim(), durationHours })}>
          {sending ? "Sending…" : !ready || !placed ? "Checking…" : "Send"}
        </MorphyButton>
        <MorphyButton type="button" size="sm" variant="none" disabled={sending}
          onClick={() => setChanging((current) => !current)}>
          {changing ? "Done" : "Change"}
        </MorphyButton>
      </div>
    </section>
  );
}
