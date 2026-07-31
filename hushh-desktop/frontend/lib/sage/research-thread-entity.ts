/**
 * Persistent Research Threads: an ongoing investigation (a real question,
 * the Q&A turns and papers traced while pursuing it, and a running
 * synthesis of what's established vs. still open) that survives across
 * sessions -- unlike Ask Sage's per-visit chat or a one-off citation trace.
 *
 * Stored in its own `research` PKM domain, under a `threads` scope
 * (distinct from `add-note-entity.ts`'s `notes` scope: the shape here is
 * materially richer -- nested turns/papers/synthesis, not a flat
 * observation string). Raw storage is snake_case to match the rest of the
 * PKM at-rest convention (e.g. `readable_highlights`); every read goes
 * through parseThreadEntity so the rest of the app works with a typed,
 * camelCase shape, same split as `DomainSummary`'s readable_* fields.
 */

export type ResearchThreadSource = { title: string; url: string };

/** A term used in a turn's answer, defined using ONLY what that same answer
 * already stated -- not a separate lookup, so it can't introduce new facts. */
export type ResearchThreadKeyTerm = { term: string; definition: string };

/** A real comparable numeric fact pulled out of a turn's answer, for a
 * quick inline visual -- never fabricated when the answer has nothing to compare. */
export type ResearchThreadComparison = { label: string; value: number; unit: string };

export type ResearchThreadTurn = {
  query: string;
  answer: string;
  mode: "standard" | "challenge";
  sources: ResearchThreadSource[];
  keyTerms: ResearchThreadKeyTerm[];
  comparisons: ResearchThreadComparison[];
  /** A model-curated academic-search query for this turn, or null when the
   * model judged there's nothing genuinely academic to trace -- e.g. a
   * question about this app's own internal tooling. Using this (instead of
   * the raw user question) for paper auto-trace avoids OpenAlex matching
   * unrelated papers on incidental shared words. */
  paperSearchQuery: string | null;
  createdAt: string;
};

export type ResearchThreadPaper = {
  id: string;
  title: string;
  year: number | null;
  topic: string | null;
  citedByCount: number;
  addedAt: string;
};

export type ResearchThreadSynthesis = {
  summary: string;
  established: string[];
  openQuestions: string[];
  generatedAt: string;
};

export type ResearchThreadEntity = {
  entityId: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  turns: ResearchThreadTurn[];
  tracedPapers: ResearchThreadPaper[];
  synthesis: ResearchThreadSynthesis | null;
};

function toThreadsScope(cloned: Record<string, unknown>): Record<string, unknown> {
  const scope =
    cloned.threads && typeof cloned.threads === "object" && !Array.isArray(cloned.threads)
      ? (cloned.threads as Record<string, unknown>)
      : ((cloned.threads = {}) as Record<string, unknown>);
  const entities =
    scope.entities && typeof scope.entities === "object" && !Array.isArray(scope.entities)
      ? (scope.entities as Record<string, unknown>)
      : ((scope.entities = {}) as Record<string, unknown>);
  return entities;
}

function parseThreadEntity(raw: unknown): ResearchThreadEntity | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const entityId = String(r.entity_id || "").trim();
  if (!entityId) return null;

  const turns: ResearchThreadTurn[] = Array.isArray(r.turns)
    ? r.turns
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
        .map((t) => ({
          query: String(t.query || ""),
          answer: String(t.answer || ""),
          mode: t.mode === "challenge" ? "challenge" : "standard",
          sources: Array.isArray(t.sources)
            ? t.sources
                .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
                .map((s) => ({ title: String(s.title || ""), url: String(s.url || "") }))
                .filter((s) => s.url)
            : [],
          keyTerms: Array.isArray(t.key_terms)
            ? t.key_terms
                .filter((k): k is Record<string, unknown> => !!k && typeof k === "object")
                .map((k) => ({ term: String(k.term || ""), definition: String(k.definition || "") }))
                .filter((k) => k.term && k.definition)
            : [],
          comparisons: Array.isArray(t.comparisons)
            ? t.comparisons
                .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
                .map((c) => ({
                  label: String(c.label || ""),
                  value: typeof c.value === "number" ? c.value : Number(c.value) || 0,
                  unit: String(c.unit || ""),
                }))
                .filter((c) => c.label)
            : [],
          paperSearchQuery:
            typeof t.paper_search_query === "string" && t.paper_search_query.trim()
              ? t.paper_search_query.trim()
              : null,
          createdAt: String(t.created_at || ""),
        }))
    : [];

  const tracedPapers: ResearchThreadPaper[] = Array.isArray(r.traced_papers)
    ? r.traced_papers
        .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
        .map((p) => ({
          id: String(p.id || ""),
          title: String(p.title || "Untitled"),
          year: typeof p.year === "number" ? p.year : null,
          topic: typeof p.topic === "string" && p.topic.trim() ? p.topic.trim() : null,
          citedByCount: typeof p.cited_by_count === "number" ? p.cited_by_count : 0,
          addedAt: String(p.added_at || ""),
        }))
    : [];

  const rawSynthesis = r.synthesis && typeof r.synthesis === "object" ? (r.synthesis as Record<string, unknown>) : null;
  const synthesis: ResearchThreadSynthesis | null = rawSynthesis
    ? {
        summary: String(rawSynthesis.summary || ""),
        established: Array.isArray(rawSynthesis.established) ? rawSynthesis.established.map(String) : [],
        openQuestions: Array.isArray(rawSynthesis.open_questions) ? rawSynthesis.open_questions.map(String) : [],
        generatedAt: String(rawSynthesis.generated_at || ""),
      }
    : null;

  return {
    entityId,
    title: String(r.title || "Untitled research"),
    status: r.status === "archived" ? "archived" : "active",
    createdAt: String(r.created_at || ""),
    updatedAt: String(r.updated_at || ""),
    turns,
    tracedPapers,
    synthesis,
  };
}

/** Every active + archived thread in this domain, most-recently-updated first. */
export function listResearchThreads(domainData: Record<string, unknown>): ResearchThreadEntity[] {
  const entities = (domainData?.threads as Record<string, unknown> | undefined)?.entities;
  if (!entities || typeof entities !== "object") return [];
  return Object.values(entities)
    .map(parseThreadEntity)
    .filter((t): t is ResearchThreadEntity => t !== null)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function getResearchThread(domainData: Record<string, unknown>, threadId: string): ResearchThreadEntity | null {
  const entities = (domainData?.threads as Record<string, unknown> | undefined)?.entities as
    | Record<string, unknown>
    | undefined;
  return parseThreadEntity(entities?.[threadId]);
}

/** Creates a brand-new thread with no turns/papers yet -- the caller asks the first question separately. */
export function createResearchThread(
  currentDomainData: Record<string, unknown>,
  title: string,
): { domainData: Record<string, unknown>; thread: ResearchThreadEntity } {
  const cloned = structuredClone(currentDomainData) as Record<string, unknown>;
  const entities = toThreadsScope(cloned);
  const entityId = `thread_${Date.now()}`;
  const nowIso = new Date().toISOString();
  const raw = {
    entity_id: entityId,
    kind: "research_thread",
    title: title.trim() || "Untitled research",
    status: "active",
    created_at: nowIso,
    updated_at: nowIso,
    turns: [],
    traced_papers: [],
    synthesis: null,
  };
  entities[entityId] = raw;
  const thread = parseThreadEntity(raw);
  if (!thread) throw new Error("Failed to create research thread");
  return { domainData: cloned, thread };
}

export function appendThreadTurn(
  currentDomainData: Record<string, unknown>,
  threadId: string,
  turn: {
    query: string;
    answer: string;
    mode: "standard" | "challenge";
    sources?: ResearchThreadSource[];
    keyTerms?: ResearchThreadKeyTerm[];
    comparisons?: ResearchThreadComparison[];
    paperSearchQuery?: string | null;
  },
): Record<string, unknown> {
  const cloned = structuredClone(currentDomainData) as Record<string, unknown>;
  const entities = toThreadsScope(cloned);
  const raw = entities[threadId] as Record<string, unknown> | undefined;
  if (!raw) return cloned;
  const nowIso = new Date().toISOString();
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  raw.turns = [
    ...turns,
    {
      query: turn.query,
      answer: turn.answer,
      mode: turn.mode,
      sources: turn.sources || [],
      key_terms: turn.keyTerms || [],
      comparisons: turn.comparisons || [],
      paper_search_query: turn.paperSearchQuery || null,
      created_at: nowIso,
    },
  ];
  raw.updated_at = nowIso;
  return cloned;
}

/** No-op (safe, idempotent) if this exact paper id is already traced in this thread. */
export function addTracedPaperToThread(
  currentDomainData: Record<string, unknown>,
  threadId: string,
  paper: { id: string; title: string; year: number | null; topic: string | null; citedByCount: number },
): Record<string, unknown> {
  const cloned = structuredClone(currentDomainData) as Record<string, unknown>;
  const entities = toThreadsScope(cloned);
  const raw = entities[threadId] as Record<string, unknown> | undefined;
  if (!raw) return cloned;
  const tracedPapers = Array.isArray(raw.traced_papers) ? raw.traced_papers : [];
  const alreadyTraced = tracedPapers.some(
    (p) => p && typeof p === "object" && String((p as Record<string, unknown>).id) === paper.id,
  );
  if (alreadyTraced) return cloned;
  const nowIso = new Date().toISOString();
  raw.traced_papers = [
    ...tracedPapers,
    {
      id: paper.id,
      title: paper.title,
      year: paper.year,
      topic: paper.topic,
      cited_by_count: paper.citedByCount,
      added_at: nowIso,
    },
  ];
  raw.updated_at = nowIso;
  return cloned;
}

/**
 * Deliberately does NOT touch updated_at: a manual dismissal shouldn't
 * re-trigger the synthesis/auto-trace staleness effect using the same
 * turn's paperSearchQuery, which would likely just re-add the exact paper
 * the user chose to remove.
 */
export function removeTracedPaperFromThread(
  currentDomainData: Record<string, unknown>,
  threadId: string,
  paperId: string,
): Record<string, unknown> {
  const cloned = structuredClone(currentDomainData) as Record<string, unknown>;
  const entities = toThreadsScope(cloned);
  const raw = entities[threadId] as Record<string, unknown> | undefined;
  if (!raw) return cloned;
  const tracedPapers = Array.isArray(raw.traced_papers) ? raw.traced_papers : [];
  raw.traced_papers = tracedPapers.filter(
    (p) => !(p && typeof p === "object" && String((p as Record<string, unknown>).id) === paperId),
  );
  return cloned;
}

export function updateThreadSynthesis(
  currentDomainData: Record<string, unknown>,
  threadId: string,
  synthesis: { summary: string; established: string[]; openQuestions: string[] },
): Record<string, unknown> {
  const cloned = structuredClone(currentDomainData) as Record<string, unknown>;
  const entities = toThreadsScope(cloned);
  const raw = entities[threadId] as Record<string, unknown> | undefined;
  if (!raw) return cloned;
  raw.synthesis = {
    summary: synthesis.summary,
    established: synthesis.established,
    open_questions: synthesis.openQuestions,
    generated_at: new Date().toISOString(),
  };
  return cloned;
}

export function archiveResearchThread(
  currentDomainData: Record<string, unknown>,
  threadId: string,
): Record<string, unknown> {
  const cloned = structuredClone(currentDomainData) as Record<string, unknown>;
  const entities = toThreadsScope(cloned);
  const raw = entities[threadId] as Record<string, unknown> | undefined;
  if (!raw) return cloned;
  raw.status = "archived";
  raw.updated_at = new Date().toISOString();
  return cloned;
}

/**
 * The `research` domain's readable_summary/readable_highlights -- what
 * the domain-level card, Notes Archive, and PKM natural-language panel
 * would read if this domain ever surfaces there. Recomputed from the
 * CURRENT active-thread list on every mutation, same rule every other
 * Sage write follows: without this, a thread is really saved but
 * invisible everywhere outside its own dedicated panel.
 */
export function buildResearchThreadsSummaryPatch(threads: ResearchThreadEntity[]): Record<string, unknown> {
  const active = threads.filter((t) => t.status === "active");
  const count = active.length;
  const highlights = active
    .slice(0, 30)
    .map((t) => `${t.title}${t.synthesis?.summary ? `: ${t.synthesis.summary}` : " (no synthesis yet)"}`);
  return {
    readable_summary:
      count === 0
        ? "No active research threads yet."
        : `You have ${count} active research thread${count === 1 ? "" : "s"}.`,
    readable_highlights: highlights,
    readable_updated_at: new Date().toISOString(),
    readable_source_label: "Sage",
  };
}
