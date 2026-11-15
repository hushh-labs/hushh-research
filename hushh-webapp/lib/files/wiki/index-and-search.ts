/** Rebuildable bidirectional backlink graph and BM25 lexical search index for Shared wiki/v1. */

import {
  type StoredWikiPageRevision,
  type WikiLinkRelation,
  WikiRefusedError,
  canonicalJson,
  sha256Hex,
  validatePageId,
} from "./contracts";

const TOKEN_RE = /[a-z0-9_]{2,64}/g;
const STOPWORDS = new Set([
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "were",
  "with",
]);

const FIELD_WEIGHTS = {
  title: 3.0,
  claims: 2.5,
  tldr: 2.0,
  body: 1.0,
} as const;
type IndexedField = keyof typeof FIELD_WEIGHTS;

export function tokenizeWikiText(text: string): string[] {
  if (!text) return [];
  const matches = text.toLowerCase().match(TOKEN_RE) ?? [];
  return matches.filter((token) => !STOPWORDS.has(token));
}

export interface StoredBacklinkEdge {
  target_page_id: string;
  relation: WikiLinkRelation;
  source_revision: number;
  anchor_claim_id?: string;
  note?: string;
}

export interface StoredBacklinkGraph {
  format: 1;
  outbound: Record<string, StoredBacklinkEdge[]>;
}

export class BacklinkGraph {
  private readonly outbound = new Map<string, StoredBacklinkEdge[]>();

  constructor(initial?: Record<string, StoredBacklinkEdge[]>) {
    if (!initial) return;
    for (const sourceId of Object.keys(initial).sort()) {
      const validatedSource = validatePageId(sourceId);
      const edges = (initial[sourceId] ?? [])
        .filter((e) => validatePageId(e.target_page_id) !== validatedSource)
        .map((edge) => ({
          target_page_id: edge.target_page_id,
          relation: edge.relation,
          source_revision: edge.source_revision,
          ...(edge.anchor_claim_id
            ? { anchor_claim_id: edge.anchor_claim_id }
            : {}),
          ...(edge.note ? { note: edge.note } : {}),
        }))
        .sort((a, b) =>
          `${a.target_page_id}|${a.relation}|${a.anchor_claim_id ?? ""}`.localeCompare(
            `${b.target_page_id}|${b.relation}|${b.anchor_claim_id ?? ""}`,
          ),
        );
      if (edges.length > 0) {
        this.outbound.set(validatedSource, edges);
      }
    }
  }

  static fromPages(pages: StoredWikiPageRevision[]): BacklinkGraph {
    const graph = new BacklinkGraph();
    for (const page of [...pages].sort((a, b) =>
      a.page_id.localeCompare(b.page_id),
    )) {
      graph.upsertPage(page);
    }
    return graph;
  }

  static fromStored(raw: unknown): BacklinkGraph {
    if (
      !raw ||
      typeof raw !== "object" ||
      (raw as { format?: unknown }).format !== 1 ||
      typeof (raw as { outbound?: unknown }).outbound !== "object" ||
      (raw as { outbound?: unknown }).outbound === null
    ) {
      throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 409);
    }
    return new BacklinkGraph(
      (raw as StoredBacklinkGraph).outbound,
    );
  }

  upsertPage(page: StoredWikiPageRevision): void {
    const edges: StoredBacklinkEdge[] = page.links
      .filter((edge) => edge.target_page_id !== page.page_id)
      .map((edge) => ({
        target_page_id: edge.target_page_id,
        relation: edge.relation,
        source_revision: page.revision,
        ...(edge.anchor_claim_id
          ? { anchor_claim_id: edge.anchor_claim_id }
          : {}),
        ...(edge.note ? { note: edge.note } : {}),
      }))
      .sort((a, b) =>
        `${a.target_page_id}|${a.relation}|${a.anchor_claim_id ?? ""}`.localeCompare(
          `${b.target_page_id}|${b.relation}|${b.anchor_claim_id ?? ""}`,
        ),
      );
    if (edges.length > 0) {
      this.outbound.set(page.page_id, edges);
    } else {
      this.outbound.delete(page.page_id);
    }
  }

  inboundFor(targetPageId: string): Array<{
    source_page_id: string;
    relation: WikiLinkRelation;
    source_revision: number;
    anchor_claim_id?: string;
    note?: string;
  }> {
    const validated = validatePageId(targetPageId);
    const inbound: Array<{
      source_page_id: string;
      relation: WikiLinkRelation;
      source_revision: number;
      anchor_claim_id?: string;
      note?: string;
    }> = [];
    for (const sourceId of [...this.outbound.keys()].sort()) {
      for (const edge of this.outbound.get(sourceId) ?? []) {
        if (edge.target_page_id !== validated) continue;
        inbound.push({
          source_page_id: sourceId,
          relation: edge.relation,
          source_revision: edge.source_revision,
          ...(edge.anchor_claim_id
            ? { anchor_claim_id: edge.anchor_claim_id }
            : {}),
          ...(edge.note ? { note: edge.note } : {}),
        });
      }
    }
    return inbound;
  }

  toStored(): StoredBacklinkGraph {
    const outbound: Record<string, StoredBacklinkEdge[]> = {};
    for (const key of [...this.outbound.keys()].sort()) {
      outbound[key] = this.outbound.get(key)!;
    }
    return { format: 1, outbound };
  }

  async digest(): Promise<string> {
    return sha256Hex(canonicalJson(this.toStored()));
  }
}

export interface StoredLexicalDoc {
  revision: number;
  fields: Record<IndexedField, Record<string, number>>;
}

export interface StoredLexicalIndex {
  format: 1;
  documents: Record<string, StoredLexicalDoc>;
}

export class LexicalSearchIndex {
  private readonly documents = new Map<string, StoredLexicalDoc>();

  constructor(initial?: Record<string, StoredLexicalDoc>) {
    if (!initial) return;
    for (const pageId of Object.keys(initial).sort()) {
      const validated = validatePageId(pageId);
      const doc = initial[pageId];
      if (!doc || typeof doc !== "object") {
        throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 409);
      }
      const fields = {
        body: {},
        claims: {},
        title: {},
        tldr: {},
      } as Record<IndexedField, Record<string, number>>;
      for (const field of Object.keys(FIELD_WEIGHTS) as IndexedField[]) {
        const rawCounts = doc.fields?.[field] ?? {};
        for (const term of Object.keys(rawCounts).sort()) {
          const count = Number(rawCounts[term]);
          if (count > 0) fields[field][term] = count;
        }
      }
      this.documents.set(validated, {
        revision: Number(doc.revision ?? 1),
        fields,
      });
    }
  }

  static fromPages(pages: StoredWikiPageRevision[]): LexicalSearchIndex {
    const index = new LexicalSearchIndex();
    for (const page of [...pages].sort((a, b) =>
      a.page_id.localeCompare(b.page_id),
    )) {
      index.upsertPage(page);
    }
    return index;
  }

  static fromStored(raw: unknown): LexicalSearchIndex {
    if (
      !raw ||
      typeof raw !== "object" ||
      (raw as { format?: unknown }).format !== 1 ||
      typeof (raw as { documents?: unknown }).documents !== "object" ||
      (raw as { documents?: unknown }).documents === null
    ) {
      throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 409);
    }
    return new LexicalSearchIndex(
      (raw as StoredLexicalIndex).documents,
    );
  }

  upsertPage(page: StoredWikiPageRevision): void {
    const activeClaims = page.claims
      .filter((c) => c.status === "active" || c.status === "uncertain")
      .map((c) => `${c.claim_id} ${c.statement}`)
      .join(" ");
    const sources: Record<IndexedField, string> = {
      title: `${page.page_id} ${page.title}`,
      claims: activeClaims,
      tldr: page.tldr,
      body: page.body,
    };
    const fields = {
      body: {},
      claims: {},
      title: {},
      tldr: {},
    } as Record<IndexedField, Record<string, number>>;
    for (const field of Object.keys(FIELD_WEIGHTS) as IndexedField[]) {
      const counts = new Map<string, number>();
      for (const token of tokenizeWikiText(sources[field])) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
      for (const term of [...counts.keys()].sort()) {
        fields[field][term] = counts.get(term)!;
      }
    }
    this.documents.set(page.page_id, {
      revision: page.revision,
      fields,
    });
  }

  queryCandidates(
    query: string,
    limit = 10,
  ): Array<{
    page_id: string;
    indexed_revision: number;
    score: number;
    matched_terms: string[];
  }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new WikiRefusedError("WIKI_SCHEMA_INVALID", 400);
    }
    const terms = [...new Set(tokenizeWikiText(query))];
    if (terms.length === 0 || this.documents.size === 0) return [];

    const docCount = this.documents.size;
    const weightedLengths = new Map<string, number>();
    const docFreqs = new Map<string, number>();

    for (const [pageId, doc] of this.documents.entries()) {
      let length = 0;
      const present = new Set<string>();
      for (const field of Object.keys(FIELD_WEIGHTS) as IndexedField[]) {
        const weight = FIELD_WEIGHTS[field];
        for (const [term, freq] of Object.entries(doc.fields[field])) {
          length += weight * freq;
          present.add(term);
        }
      }
      weightedLengths.set(pageId, Math.max(length, 1));
      for (const term of present) {
        docFreqs.set(term, (docFreqs.get(term) ?? 0) + 1);
      }
    }

    const avgLen =
      [...weightedLengths.values()].reduce((sum, v) => sum + v, 0) /
      Math.max(docCount, 1);
    const k1 = 1.5;
    const b = 0.75;

    const scored: Array<{
      page_id: string;
      indexed_revision: number;
      score: number;
      matched_terms: string[];
    }> = [];

    for (const pageId of [...this.documents.keys()].sort()) {
      const doc = this.documents.get(pageId)!;
      let score = 0;
      const matched: string[] = [];
      for (const term of terms) {
        let tf = 0;
        for (const field of Object.keys(FIELD_WEIGHTS) as IndexedField[]) {
          tf += FIELD_WEIGHTS[field] * (doc.fields[field][term] ?? 0);
        }
        if (tf <= 0) continue;
        matched.push(term);
        const df = docFreqs.get(term) ?? 0;
        const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
        const norm =
          k1 * (1 - b + b * ((weightedLengths.get(pageId) ?? 1) / Math.max(avgLen, 1)));
        score += idf * ((tf * (k1 + 1)) / (tf + norm));
      }
      if (score > 0) {
        scored.push({
          page_id: pageId,
          indexed_revision: doc.revision,
          score: Math.round(score * 1_000_000) / 1_000_000,
          matched_terms: matched,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.page_id.localeCompare(b.page_id));
    return scored.slice(0, limit);
  }

  toStored(): StoredLexicalIndex {
    const documents: Record<string, StoredLexicalDoc> = {};
    for (const key of [...this.documents.keys()].sort()) {
      documents[key] = this.documents.get(key)!;
    }
    return { format: 1, documents };
  }

  async digest(): Promise<string> {
    return sha256Hex(canonicalJson(this.toStored()));
  }
}
