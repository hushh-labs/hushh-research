"use client";

import type {
  DomainSummary,
  PersonalKnowledgeModelMetadata,
} from "@/lib/services/personal-knowledge-model-service";

export type PkmPathSegment = string | number;

export type PkmMemoryCard = {
  id: string;
  domain: string;
  domainTitle: string;
  title: string;
  detail: string;
  value: string;
  path: string;
  pathSegments: PkmPathSegment[];
  sourceLabel: string;
  updatedAt: string | null;
  confidence: number;
  kind: "profile" | "preference" | "financial" | "shopping" | "professional" | "memory";
  editable: boolean;
  searchText: string;
};

export type PkmDomainInsight = {
  domain: string;
  title: string;
  summary: string;
  highlights: string[];
  updatedAt: string | null;
  cardCount: number;
};

export type PkmMemorySnapshot = {
  cards: PkmMemoryCard[];
  domainInsights: PkmDomainInsight[];
  totalCards: number;
};

const DEFAULT_MAX_CARDS = 96;
const DEFAULT_MAX_CARDS_PER_DOMAIN = 24;
const MAX_VALUE_CHARS = 180;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 12;

const INTERNAL_KEYS = new Set([
  "algorithm",
  "artifact_id",
  "card_id",
  "ciphertext",
  "confidence",
  "contract_version",
  "created_at",
  "domain_contract_version",
  "domain_intent",
  "hash",
  "id",
  "iv",
  "last_content_at",
  "last_structured_at",
  "manifest_revision",
  "manifest_version",
  "path_count",
  "pkm_contract_version",
  "readable_projection_version",
  "readable_summary_version",
  "schema_version",
  "source_agent",
  "tag",
  "updated_at",
  "upgraded_at",
  "version",
]);

function compact(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clip(value: unknown, maxChars = MAX_VALUE_CHARS): string {
  const text = compact(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function titleize(value: string): string {
  return value
    .replace(/\[\d+\]/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

function normalizeKey(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function stableId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function pathToString(pathSegments: readonly PkmPathSegment[]): string {
  return pathSegments
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : segment))
    .join(".")
    .replace(/\.\[/g, "[");
}

function parseDomainSummary(metadata: PersonalKnowledgeModelMetadata | null): Map<string, DomainSummary> {
  return new Map((metadata?.domains || []).map((domain) => [domain.key, domain]));
}

function shouldSkipKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (!normalized) return true;
  if (INTERNAL_KEYS.has(normalized)) return true;
  if (normalized.startsWith("_")) return true;
  if (normalized.endsWith("_id") && normalized !== "student_id") return true;
  if (normalized.includes("cipher") || normalized.includes("token")) return true;
  return false;
}

function primitiveValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return clip(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function classifyCard(domain: string, path: string, value: string): PkmMemoryCard["kind"] {
  const text = `${domain} ${path} ${value}`.toLowerCase();
  if (/\b(name|email|phone|roll|student|college|university|school|address|city)\b/.test(text)) {
    return "profile";
  }
  if (/\b(prefer|preference|favorite|favourite|like|dislike|brand|style)\b/.test(text)) {
    return "preference";
  }
  if (/\b(financial|portfolio|stock|ticker|risk|holding|analysis|brokerage|investment)\b/.test(text)) {
    return "financial";
  }
  if (/\b(shopping|receipt|merchant|seller|brand|purchase|subscription|return)\b/.test(text)) {
    return "shopping";
  }
  if (/\b(work|project|professional|job|meeting|company|iit|college|university)\b/.test(text)) {
    return "professional";
  }
  return "memory";
}

function cardTitle(params: {
  domain: string;
  pathSegments: readonly PkmPathSegment[];
  value: string;
}): string {
  const path = pathToString(params.pathSegments).toLowerCase();
  const lastKey = String(params.pathSegments.at(-1) ?? params.domain);
  const label = titleize(lastKey);
  const value = params.value;

  if (/\b(full_?name|display_?name|name)\b/.test(path)) return `Your name is ${value}`;
  if (/\b(roll|student_?id|roll_?no)\b/.test(path)) return `Roll number: ${value}`;
  if (/\b(iit|college|university|school|institution|institute)\b/.test(path)) {
    return `You study at ${value}`;
  }
  if (/\b(prefer|preference|favorite|favourite|likes?)\b/.test(path)) {
    return `You prefer ${value}`;
  }
  if (/\bdislikes?\b/.test(path)) return `You dislike ${value}`;
  if (/\b(ticker|stock|symbol)\b/.test(path)) return `Stock symbol: ${value}`;
  if (/\b(project|goal|routine|habit)\b/.test(path)) return `${label}: ${value}`;
  return `${label}: ${value}`;
}

function cardDetail(domainTitle: string, pathSegments: readonly PkmPathSegment[]): string {
  const visiblePath = pathSegments
    .filter((segment) => typeof segment !== "number")
    .map((segment) => titleize(String(segment)))
    .filter(Boolean)
    .slice(0, 4);
  if (visiblePath.length === 0) return `Stored in ${domainTitle}.`;
  return `Stored in ${domainTitle} > ${visiblePath.join(" > ")}.`;
}

function flattenCards(params: {
  domain: string;
  domainTitle: string;
  value: unknown;
  sourceLabel: string;
  updatedAt: string | null;
  depth?: number;
  pathSegments?: PkmPathSegment[];
  cards?: PkmMemoryCard[];
}): PkmMemoryCard[] {
  const depth = params.depth || 0;
  const pathSegments = params.pathSegments || [];
  const cards = params.cards || [];
  if (depth > MAX_DEPTH || cards.length >= DEFAULT_MAX_CARDS_PER_DOMAIN * 3) return cards;

  const primitive = primitiveValue(params.value);
  if (primitive) {
    const path = pathToString(pathSegments);
    if (!path || primitive.length === 0) return cards;
    const kind = classifyCard(params.domain, path, primitive);
    const title = cardTitle({
      domain: params.domain,
      pathSegments,
      value: primitive,
    });
    cards.push({
      id: `${params.domain}:${stableId(`${path}:${primitive}`)}`,
      domain: params.domain,
      domainTitle: params.domainTitle,
      title,
      detail: cardDetail(params.domainTitle, pathSegments),
      value: primitive,
      path,
      pathSegments: [...pathSegments],
      sourceLabel: params.sourceLabel,
      updatedAt: params.updatedAt,
      confidence: kind === "memory" ? 0.72 : 0.88,
      kind,
      editable: true,
      searchText: `${params.domain} ${params.domainTitle} ${path} ${title} ${primitive}`.toLowerCase(),
    });
    return cards;
  }

  if (Array.isArray(params.value)) {
    params.value.slice(0, MAX_ARRAY_ITEMS).forEach((item, index) => {
      flattenCards({
        ...params,
        value: item,
        depth: depth + 1,
        pathSegments: [...pathSegments, index],
        cards,
      });
    });
    return cards;
  }

  if (!isRecord(params.value)) return cards;
  for (const [key, child] of Object.entries(params.value)) {
    if (shouldSkipKey(key)) continue;
    flattenCards({
      ...params,
      value: child,
      depth: depth + 1,
      pathSegments: [...pathSegments, key],
      cards,
    });
  }
  return cards;
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9$.\-]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  );
}

export function selectRelevantPkmMemoryCards(
  cards: readonly PkmMemoryCard[],
  query: string,
  limit = 18
): PkmMemoryCard[] {
  const queryTokens = tokens(query);
  if (queryTokens.size === 0) return cards.slice(0, limit);

  return cards
    .map((card) => {
      let score = 0;
      for (const token of queryTokens) {
        if (card.searchText.includes(token)) score += 1;
        if (card.domain.includes(token)) score += 2;
        if (card.title.toLowerCase().includes(token)) score += 3;
      }
      return { card, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.card.confidence - left.card.confidence)
    .map((entry) => entry.card)
    .slice(0, limit);
}

function domainInsightSummary(params: {
  domain: DomainSummary | undefined;
  cards: readonly PkmMemoryCard[];
  domainKey: string;
  domainTitle: string;
}): string {
  const title = params.domainTitle;
  const text = params.cards.map((card) => `${card.title} ${card.path}`).join(" ").toLowerCase();
  const topics: string[] = [];
  const add = (topic: string, pattern: RegExp) => {
    if (pattern.test(text) && !topics.includes(topic)) topics.push(topic);
  };

  add("portfolio holdings", /\b(holding|holdings|portfolio|allocation)\b/);
  add("analysis history", /\b(analysis|decision|ticker|stock)\b/);
  add("saved risk profile", /\b(risk|risk_profile|risk bucket)\b/);
  add("receipts", /\b(receipt|purchase|order)\b/);
  add("brand preferences", /\b(brand|seller|merchant|preference|prefer)\b/);
  add("subscriptions", /\b(subscription|renewal)\b/);
  add("education", /\b(iit|college|university|school|student|roll)\b/);
  add("projects", /\b(project|work|professional)\b/);
  add("habits and routines", /\b(habit|routine|workout|sleep|meal)\b/);

  if (topics.length > 0) {
    return `Your ${title.toLowerCase()} memory includes ${topics.slice(0, 5).join(", ")}.`;
  }

  const readable = compact(params.domain?.readableSummary || params.domain?.summary?.readable_summary);
  if (readable) return readable;
  if (params.cards.length > 0) {
    return `Your ${title.toLowerCase()} memory has ${params.cards.length} readable detail${
      params.cards.length === 1 ? "" : "s"
    } ready for review.`;
  }
  return `Your ${title.toLowerCase()} memory is ready for review.`;
}

function domainInsight(params: {
  domain: DomainSummary | undefined;
  domainKey: string;
  cards: readonly PkmMemoryCard[];
}): PkmDomainInsight {
  const domainTitle = params.domain?.displayName || titleize(params.domainKey);
  const highlights = [
    ...params.cards
      .filter((card) => card.kind !== "memory")
      .map((card) => card.title)
      .slice(0, 4),
    ...(params.domain?.readableHighlights || []),
  ]
    .map((item) => clip(item, 120))
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, 5);

  return {
    domain: params.domainKey,
    title: domainTitle,
    summary: domainInsightSummary({
      domain: params.domain,
      cards: params.cards,
      domainKey: params.domainKey,
      domainTitle,
    }),
    highlights,
    updatedAt:
      params.domain?.readableUpdatedAt || params.domain?.lastUpdated || params.cards[0]?.updatedAt || null,
    cardCount: params.cards.length,
  };
}

export function buildPkmMemorySnapshot(params: {
  metadata: PersonalKnowledgeModelMetadata | null;
  fullBlob: Record<string, unknown>;
  maxCards?: number;
  maxCardsPerDomain?: number;
}): PkmMemorySnapshot {
  const maxCards = params.maxCards || DEFAULT_MAX_CARDS;
  const maxCardsPerDomain = params.maxCardsPerDomain || DEFAULT_MAX_CARDS_PER_DOMAIN;
  const domainsByKey = parseDomainSummary(params.metadata);
  const domainKeys = Array.from(
    new Set([
      ...(params.metadata?.domains.map((domain) => domain.key).filter(Boolean) || []),
      ...Object.keys(params.fullBlob || {}),
    ])
  );

  const cardsByDomain = new Map<string, PkmMemoryCard[]>();
  for (const domainKey of domainKeys) {
    const domain = domainsByKey.get(domainKey);
    const domainTitle = domain?.displayName || titleize(domainKey);
    const cards = flattenCards({
      domain: domainKey,
      domainTitle,
      value: params.fullBlob?.[domainKey],
      sourceLabel: domain?.readableSourceLabel || "Saved memory",
      updatedAt: domain?.readableUpdatedAt || domain?.lastUpdated || null,
    }).slice(0, maxCardsPerDomain);
    cardsByDomain.set(domainKey, cards);
  }

  const cards = Array.from(cardsByDomain.values()).flat().slice(0, maxCards);
  const domainInsights = domainKeys.map((domainKey) =>
    domainInsight({
      domain: domainsByKey.get(domainKey),
      domainKey,
      cards: cardsByDomain.get(domainKey) || [],
    })
  );

  return {
    cards,
    domainInsights,
    totalCards: cards.length,
  };
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value) as Record<string, unknown>;
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function ensureContainer(parent: unknown, segment: PkmPathSegment): Record<string, unknown> | unknown[] | null {
  if (typeof segment === "number") {
    return Array.isArray(parent) ? parent : null;
  }
  return isRecord(parent) ? parent : null;
}

function readChild(container: Record<string, unknown> | unknown[], segment: PkmPathSegment): unknown {
  if (typeof segment === "number") {
    return Array.isArray(container) ? container[segment] : undefined;
  }
  return isRecord(container) ? container[segment] : undefined;
}

function coerceEditedValue(previous: string, next: string): unknown {
  if (previous === "true" || previous === "false") {
    if (/^(true|false)$/i.test(next.trim())) return next.trim().toLowerCase() === "true";
  }
  if (/^-?\d+(\.\d+)?$/.test(previous) && /^-?\d+(\.\d+)?$/.test(next.trim())) {
    return Number(next.trim());
  }
  return next;
}

export function updatePkmDomainValue(params: {
  domainData: Record<string, unknown>;
  pathSegments: readonly PkmPathSegment[];
  previousValue: string;
  nextValue: string;
}): Record<string, unknown> {
  const nextDomainData = cloneRecord(params.domainData);
  let cursor: unknown = nextDomainData;
  for (const segment of params.pathSegments.slice(0, -1)) {
    const container = ensureContainer(cursor, segment);
    if (!container) return nextDomainData;
    cursor = readChild(container, segment);
  }
  const last = params.pathSegments.at(-1);
  const container = ensureContainer(cursor, last ?? "");
  if (!container || last === undefined) return nextDomainData;
  const value = coerceEditedValue(params.previousValue, params.nextValue);
  if (typeof last === "number") {
    if (Array.isArray(container)) container[last] = value;
  } else if (isRecord(container)) {
    container[last] = value;
  }
  return nextDomainData;
}

export function deletePkmDomainValue(params: {
  domainData: Record<string, unknown>;
  pathSegments: readonly PkmPathSegment[];
}): Record<string, unknown> {
  const nextDomainData = cloneRecord(params.domainData);
  let cursor: unknown = nextDomainData;
  for (const segment of params.pathSegments.slice(0, -1)) {
    const container = ensureContainer(cursor, segment);
    if (!container) return nextDomainData;
    cursor = readChild(container, segment);
  }
  const last = params.pathSegments.at(-1);
  const container = ensureContainer(cursor, last ?? "");
  if (!container || last === undefined) return nextDomainData;
  if (typeof last === "number") {
    if (Array.isArray(container)) container.splice(last, 1);
  } else if (isRecord(container)) {
    delete container[last];
  }
  return nextDomainData;
}
