"use client";

import {
  PersonalKnowledgeModelService,
  type PersonalKnowledgeModelMetadata,
} from "@/lib/services/personal-knowledge-model-service";
import {
  buildPkmMemorySnapshot,
  selectRelevantPkmMemoryCards,
  type PkmMemorySnapshot,
} from "@/lib/pkm/pkm-memory-cards";

type AgentPkmWorkingSet = {
  userId: string;
  metadata: PersonalKnowledgeModelMetadata | null;
  fullBlob: Record<string, unknown>;
  memorySnapshot: PkmMemorySnapshot;
  loadedAt: number;
  metadataUpdatedAt: string | null;
};

export type AgentPkmWorkingContextMode = "relevant" | "broad";

export type AgentPkmWorkingContext = {
  text: string;
  domains: string[];
  totalAttributes: number;
  updatedAt: string | null;
  detailCount: number;
  source: "decrypted_session_pkm";
  mode: AgentPkmWorkingContextMode;
};

const SESSION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CONTEXT_CHARS = 16000;
const MAX_DETAIL_LINES = 180;
const MAX_VALUE_CHARS = 260;
const MAX_ARRAY_ITEMS = 8;
const MAX_DEPTH = 5;

const workingSets = new Map<string, AgentPkmWorkingSet>();

function compactWhitespace(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clip(value: unknown, maxChars = MAX_VALUE_CHARS): string {
  const text = compactWhitespace(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function tokenize(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9$.\-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  return new Set(tokens);
}

function containsAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function shouldUseBroadContext(message: string): boolean {
  const text = message.toLowerCase();
  return containsAny(text, [
    /\b(?:show|summari[sz]e|explain|list|display|read)\b.*\b(?:all|everything|entire|full)\b.*\b(?:pkm|personal knowledge|memory|memories|what kai knows)\b/,
    /\b(?:what|which)\b.*\b(?:is|are|stuff|details|data|information)\b.*\b(?:in|inside)\b.*\b(?:my )?(?:pkm|personal knowledge|memory|memories)\b/,
    /\b(?:can you|could you)?\s*(?:see|access|read|summari[sz]e|explain)\b.*\b(?:my )?(?:pkm|personal knowledge|memory|memories)\b/,
    /\bwhat\b.*\b(?:kai|agent|you)\b.*\bknow\b.*\b(?:about me|from my pkm)\b/,
  ]);
}

function formatPrimitive(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return clip(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function primitiveArraySummary(values: unknown[]): string | null {
  const primitives = values
    .map(formatPrimitive)
    .filter((value): value is string => Boolean(value))
    .slice(0, MAX_ARRAY_ITEMS);
  if (primitives.length === 0) return null;
  const suffix = values.length > primitives.length ? `, +${values.length - primitives.length} more` : "";
  return clip(`${primitives.join(", ")}${suffix}`);
}

type FlattenedPkmLine = {
  domain: string;
  path: string;
  value: string;
  text: string;
  score: number;
};

function flattenDomain(
  domain: string,
  value: unknown,
  promptTokens: Set<string>,
  path = domain,
  depth = 0,
  lines: FlattenedPkmLine[] = []
): FlattenedPkmLine[] {
  if (lines.length >= MAX_DETAIL_LINES * 2 || depth > MAX_DEPTH) {
    return lines;
  }

  const primitive = formatPrimitive(value);
  if (primitive) {
    const text = `${path}: ${primitive}`;
    lines.push({
      domain,
      path,
      value: primitive,
      text,
      score: scoreLine(domain, path, primitive, promptTokens),
    });
    return lines;
  }

  if (Array.isArray(value)) {
    const summary = primitiveArraySummary(value);
    if (summary) {
      const text = `${path}: ${summary}`;
      lines.push({
        domain,
        path,
        value: summary,
        text,
        score: scoreLine(domain, path, summary, promptTokens),
      });
      return lines;
    }
    value.slice(0, MAX_ARRAY_ITEMS).forEach((item, index) => {
      flattenDomain(domain, item, promptTokens, `${path}[${index}]`, depth + 1, lines);
    });
    return lines;
  }

  if (!isRecord(value)) {
    return lines;
  }

  for (const [key, child] of Object.entries(value)) {
    if (lines.length >= MAX_DETAIL_LINES * 2) break;
    flattenDomain(domain, child, promptTokens, path ? `${path}.${key}` : key, depth + 1, lines);
  }
  return lines;
}

function scoreLine(
  domain: string,
  path: string,
  value: string,
  promptTokens: Set<string>
): number {
  if (promptTokens.size === 0) return 0;
  const haystack = tokenize(`${domain} ${path} ${value}`);
  let score = 0;
  for (const token of promptTokens) {
    if (haystack.has(token)) score += 4;
    if (path.toLowerCase().includes(token)) score += 3;
    if (domain.toLowerCase().includes(token)) score += 2;
  }
  return score;
}

function domainSummaryLines(metadata: PersonalKnowledgeModelMetadata | null): string[] {
  if (!metadata?.domains?.length) return [];
  return metadata.domains
    .filter((domain) => domain.attributeCount > 0 || domain.readableSummary)
    .map((domain) => {
      const summary =
        clip(domain.readableSummary, 220) ||
        clip(domain.summary?.readable_summary, 220) ||
        `${domain.attributeCount || 0} saved details`;
      const highlights = Array.isArray(domain.readableHighlights)
        ? domain.readableHighlights.map((item) => clip(item, 100)).filter(Boolean).slice(0, 3)
        : [];
      return [
        `- ${domain.displayName || titleize(domain.key)} (${domain.key})`,
        summary ? `summary: ${summary}` : null,
        highlights.length > 0 ? `highlights: ${highlights.join("; ")}` : null,
        domain.lastUpdated ? `updated: ${domain.lastUpdated}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    });
}

function memoryDomainSummaryLines(workingSet: AgentPkmWorkingSet): string[] {
  if (workingSet.memorySnapshot.domainInsights.length === 0) {
    return domainSummaryLines(workingSet.metadata);
  }
  return workingSet.memorySnapshot.domainInsights
    .filter((domain) => domain.cardCount > 0 || domain.summary)
    .map((domain) =>
      [
        `- ${domain.title} (${domain.domain})`,
        `summary: ${clip(domain.summary, 260)}`,
        domain.highlights.length > 0
          ? `highlights: ${domain.highlights.map((item) => clip(item, 100)).join("; ")}`
          : null,
        domain.updatedAt ? `updated: ${domain.updatedAt}` : null,
      ]
        .filter(Boolean)
        .join(" | ")
    );
}

function buildContextText(params: {
  workingSet: AgentPkmWorkingSet;
  message: string;
  maxChars: number;
}): AgentPkmWorkingContext {
  const { workingSet } = params;
  const maxChars = Math.max(2000, params.maxChars || DEFAULT_MAX_CONTEXT_CHARS);
  const mode: AgentPkmWorkingContextMode = shouldUseBroadContext(params.message)
    ? "broad"
    : "relevant";
  const promptTokens = tokenize(params.message);
  const domainKeys = Array.from(
    new Set([
      ...(workingSet.metadata?.domains.map((domain) => domain.key).filter(Boolean) || []),
      ...Object.keys(workingSet.fullBlob || {}),
    ])
  );

  const allLines = domainKeys.flatMap((domain) =>
    flattenDomain(domain, (workingSet.fullBlob || {})[domain], promptTokens)
  );
  const relevantMemoryCards =
    mode === "broad"
      ? workingSet.memorySnapshot.cards.slice(0, 42)
      : selectRelevantPkmMemoryCards(workingSet.memorySnapshot.cards, params.message, 24);
  const selectedLines =
    mode === "broad"
      ? allLines.slice(0, MAX_DETAIL_LINES)
      : allLines
          .filter((line) => line.score > 0)
          .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
          .slice(0, MAX_DETAIL_LINES);
  const detailLines = selectedLines.length > 0 ? selectedLines : allLines.slice(0, 40);

  const lines = [
    "Agent PKM context:",
    "Source: decrypted client-side from the user's unlocked vault for this session.",
    "Boundary: use this as user-authorized memory for this turn; do not claim PKM is inaccessible when relevant details are present.",
    "Do not mention internal paths unless the user asks for raw structure.",
    `Mode: ${mode}`,
    `Total saved details: ${workingSet.metadata?.totalAttributes || 0}`,
    `Domains available: ${domainKeys.length > 0 ? domainKeys.join(", ") : "none"}`,
    workingSet.metadataUpdatedAt ? `Updated at: ${workingSet.metadataUpdatedAt}` : null,
    "",
    "Domain summaries:",
    ...memoryDomainSummaryLines(workingSet).slice(0, 12),
    "",
    relevantMemoryCards.length > 0
      ? "Memory cards selected from decrypted PKM:"
      : "Memory cards selected from decrypted PKM: none available.",
    ...relevantMemoryCards.map((card) =>
      `- ${card.title} | domain: ${card.domainTitle} | source: ${card.sourceLabel} | confidence: ${Math.round(
        card.confidence * 100
      )}% | ${card.detail}`
    ),
    "",
    detailLines.length > 0 ? "Decrypted PKM details:" : "Decrypted PKM details: none available.",
    ...detailLines.map((line) => `- ${line.text}`),
  ].filter((line): line is string => line !== null);

  let text = lines.join("\n");
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars - 80).trimEnd()}\n\n[PKM context clipped to the current prompt budget.]`;
  }

  return {
    text,
    domains: domainKeys,
    totalAttributes:
      workingSet.metadata?.totalAttributes ||
      workingSet.memorySnapshot.totalCards ||
      detailLines.length,
    updatedAt: workingSet.metadataUpdatedAt,
    detailCount: Math.max(detailLines.length, relevantMemoryCards.length),
    source: "decrypted_session_pkm",
    mode,
  };
}

export class AgentPkmContextStore {
  static clear(userId?: string): void {
    if (userId) {
      workingSets.delete(userId);
      return;
    }
    workingSets.clear();
  }

  static invalidateUser(userId: string): void {
    workingSets.delete(userId);
  }

  static async load(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    message?: string;
    forceRefresh?: boolean;
    maxChars?: number;
  }): Promise<AgentPkmWorkingContext> {
    const metadata = await PersonalKnowledgeModelService.getMetadata(
      params.userId,
      params.forceRefresh === true,
      params.vaultOwnerToken
    );
    const cached = workingSets.get(params.userId);
    const metadataUpdatedAt = metadata.lastUpdated || null;
    const cacheFresh =
      cached &&
      Date.now() - cached.loadedAt < SESSION_TTL_MS &&
      cached.metadataUpdatedAt === metadataUpdatedAt;

    const workingSet =
      !params.forceRefresh && cacheFresh
        ? cached
        : await (async (): Promise<AgentPkmWorkingSet> => {
            const fullBlob = await PersonalKnowledgeModelService.loadFullBlob({
              userId: params.userId,
              vaultKey: params.vaultKey,
              vaultOwnerToken: params.vaultOwnerToken,
            });
            return {
              userId: params.userId,
              metadata,
              fullBlob,
              memorySnapshot: buildPkmMemorySnapshot({
                metadata,
                fullBlob,
              }),
              loadedAt: Date.now(),
              metadataUpdatedAt,
            };
          })();

    workingSets.set(params.userId, workingSet);

    return buildContextText({
      workingSet,
      message: params.message || "",
      maxChars: params.maxChars || DEFAULT_MAX_CONTEXT_CHARS,
    });
  }
}
