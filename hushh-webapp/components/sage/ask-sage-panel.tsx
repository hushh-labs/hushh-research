"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Search, Swords } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { ApiService } from "@/lib/services/api-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { addNoteEntity, buildSageNoteSummaryPatch } from "@/lib/sage/add-note-entity";
import { SageMarkdown } from "@/components/sage/sage-markdown";
import { SageLoadingIndicator } from "@/components/sage/sage-loading-indicator";
import { PersonalKnowledgeModelService, type DomainSummary } from "@/lib/services/personal-knowledge-model-service";
import { cn } from "@/lib/utils";

type ResearchSource = { title: string; url: string };

type ResearchResult = {
  id: string;
  query: string;
  answer: string;
  sources: ResearchSource[];
  saveState: "idle" | "saving" | "saved" | "error";
  challenged: boolean;
};

const MAX_HISTORY = 5;
const MAX_CONVERSATION_TURNS = 4;

/**
 * Sage as an actual researcher: a real question in, a real Gemini call with
 * live Google Search grounding out, personalized against the user's own PKM
 * summaries. This is the "active" half of Sage -- the rest of the page is
 * Sage reading your existing data; this is Sage going and doing new work.
 */
export function AskSagePanel({
  domains,
  suggestedPrompts = [],
  initialQuery,
  autoAsk = false,
}: {
  domains: DomainSummary[];
  suggestedPrompts?: string[];
  /** Pre-fills the query box (e.g. from a suggested-prompt deep link) --
   * never auto-submits on its own, the user still hits Ask themselves. */
  initialQuery?: string;
  /** Asks `initialQuery` automatically on mount -- for the home page's own
   * quick-ask box, where the user already typed a real question and
   * submitted it, vs. a suggested-prompt chip, which only pre-fills. */
  autoAsk?: boolean;
}) {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const [query, setQuery] = useState(initialQuery || "");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ResearchResult[]>([]);
  const [saveDomain, setSaveDomain] = useState<string>(domains[0]?.key || "");
  const [challengeMode, setChallengeMode] = useState(false);
  const autoAsked = useRef(false);

  const effectiveSaveDomain = saveDomain || domains[0]?.key || "";

  async function handleAsk(overrideQuery?: string) {
    const trimmed = (overrideQuery ?? query).trim();
    if (!trimmed || !vaultOwnerToken || asking) return;
    setAsking(true);
    setError(null);
    try {
      const conversationHistory = results
        .slice(0, MAX_CONVERSATION_TURNS)
        .slice()
        .reverse()
        .map((r) => ({ query: r.query, answer: r.answer }));
      const response = await ApiService.askSage({
        vaultOwnerToken,
        query: trimmed,
        mode: challengeMode ? "challenge" : "standard",
        domains: domains.map((d) => ({
          domain: d.key,
          displayName: d.displayName,
          summary: d.summary,
          attributeCount: d.attributeCount,
        })),
        conversationHistory,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error(detail?.detail || "Sage couldn't research that just now.");
      }
      const data = await response.json();
      setResults((prev) =>
        [
          {
            id: `${Date.now()}`,
            query: trimmed,
            answer: String(data.answer || ""),
            sources: Array.isArray(data.sources) ? data.sources : [],
            saveState: "idle" as const,
            challenged: challengeMode,
          },
          ...prev,
        ].slice(0, MAX_HISTORY),
      );
      setQuery("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sage couldn't research that just now.");
    } finally {
      setAsking(false);
    }
  }

  // Fires the pre-filled query automatically once the vault token is ready
  // (it isn't necessarily available on the very first render) -- guarded by
  // a ref so a later vaultOwnerToken change (e.g. a refresh) never re-asks.
  useEffect(() => {
    if (!autoAsk || !initialQuery?.trim() || !vaultOwnerToken || autoAsked.current) return;
    autoAsked.current = true;
    void handleAsk(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk, initialQuery, vaultOwnerToken]);

  async function handleSave(resultId: string) {
    const result = results.find((r) => r.id === resultId);
    if (!result || !user?.uid || !vaultKey || !vaultOwnerToken || !effectiveSaveDomain) return;

    setResults((prev) => prev.map((r) => (r.id === resultId ? { ...r, saveState: "saving" } : r)));
    try {
      const noteText = `Asked Sage: "${result.query}" — ${result.answer}`.slice(0, 1200);
      // Re-fetch live rather than trusting the `domains` prop (a one-time
      // page-load snapshot) -- readable_highlights is replaced wholesale on
      // write, not merged server-side, so saving a second result to the same
      // domain in one sitting against a stale snapshot silently overwrote the
      // first save's highlight line.
      const freshDomains = await PersonalKnowledgeModelService.getMetadata(user.uid, true, vaultOwnerToken)
        .then((m) => m.domains)
        .catch(() => domains);
      const targetDomain = freshDomains.find((d) => d.key === effectiveSaveDomain) || domains.find((d) => d.key === effectiveSaveDomain);
      const writeResult = await PkmWriteCoordinator.saveMergedDomain({
        userId: user.uid,
        domain: effectiveSaveDomain,
        vaultKey,
        vaultOwnerToken,
        build: (context) => ({
          domainData: addNoteEntity(context.currentDomainData, noteText, "sage_research"),
          summary: {
            source: "sage_research",
            message_excerpt: noteText.slice(0, 160),
            ...buildSageNoteSummaryPatch({
              displayName: targetDomain?.displayName || effectiveSaveDomain,
              existingHighlights: targetDomain?.readableHighlights || [],
              noteText,
            }),
          },
        }),
      });
      setResults((prev) =>
        prev.map((r) => (r.id === resultId ? { ...r, saveState: writeResult.success ? "saved" : "error" } : r)),
      );
    } catch {
      setResults((prev) => prev.map((r) => (r.id === resultId ? { ...r, saveState: "error" } : r)));
    }
  }

  return (
    <div className="rounded-2xl border border-violet-500/25 bg-card/85 p-4 shadow-[0_1px_2px_rgba(15,23,42,0.06)] sm:p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-violet-700 dark:text-violet-300">
        <Search className="h-4 w-4" aria-hidden />
        Ask Sage
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Ask a real question. Sage researches it live and personalizes the answer against what it
        knows about you. Ask a follow-up any time -- Sage remembers what you just asked.
      </p>

      {suggestedPrompts.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {suggestedPrompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => {
                setQuery(prompt);
                void handleAsk(prompt);
              }}
              disabled={asking}
              className="rounded-full border border-border/60 bg-card px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:border-violet-500/40 hover:text-foreground disabled:opacity-60"
            >
              {prompt}
            </button>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <Textarea
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleAsk();
            }
          }}
          placeholder={
            results.length > 0
              ? "Ask a follow-up, e.g. what about international equities?"
              : "e.g. What should I know about rebalancing a portfolio like mine?"
          }
          className="min-h-[2.75rem] flex-1 resize-none"
          rows={2}
        />
        <Button onClick={() => void handleAsk()} disabled={asking || !query.trim()} className="sm:w-auto">
          {asking ? "Researching…" : "Ask"}
        </Button>
      </div>

      <SageLoadingIndicator active={asking} expectedSeconds={challengeMode ? 25 : 12} />

      <button
        type="button"
        onClick={() => setChallengeMode((prev) => !prev)}
        className={cn(
          "mt-2.5 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
          challengeMode
            ? "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:border-orange-400/40 dark:text-orange-300"
            : "border-border/60 bg-card text-muted-foreground hover:border-violet-500/40 hover:text-foreground",
        )}
        aria-pressed={challengeMode}
      >
        <Swords className="h-3 w-3" aria-hidden />
        Challenge Mode
      </button>
      {challengeMode ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Sage will argue against its own answer and actively search for the strongest real
          counter-case.
        </p>
      ) : null}
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}

      {results.length > 0 ? (
        <div className="mt-4 space-y-3">
          {results.map((result) => (
            <div
              key={result.id}
              className="rounded-xl border border-border/60 bg-background/60 p-3.5 sm:p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-foreground">{result.query}</p>
                {result.challenged ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 text-[11px] font-medium text-orange-700 dark:border-orange-400/30 dark:text-orange-300">
                    <Swords className="h-2.5 w-2.5" aria-hidden />
                    Challenge Mode
                  </span>
                ) : null}
              </div>
              <div className="mt-2 border-t border-border/50 pt-2">
                <SageMarkdown text={result.answer} />
              </div>

              {result.sources.length > 0 ? (
                <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-border/50 pt-2.5">
                  {result.sources.map((source) => (
                    <a
                      key={source.url}
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-card px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-violet-500/40 hover:text-foreground"
                    >
                      {source.title}
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  ))}
                </div>
              ) : null}

              {domains.length > 0 ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-2.5">
                  <select
                    value={effectiveSaveDomain}
                    onChange={(event) => setSaveDomain(event.target.value)}
                    className="rounded-md border border-border/60 bg-card px-2 py-1 text-xs text-foreground"
                    disabled={result.saveState === "saving" || result.saveState === "saved"}
                  >
                    {domains.map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.displayName}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleSave(result.id)}
                    disabled={result.saveState === "saving" || result.saveState === "saved"}
                    className={cn(result.saveState === "saved" && "text-emerald-600 dark:text-emerald-400")}
                  >
                    {result.saveState === "saving"
                      ? "Saving…"
                      : result.saveState === "saved"
                        ? "Saved"
                        : result.saveState === "error"
                          ? "Retry save"
                          : "Save to notes"}
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
