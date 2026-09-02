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
  valueFingerprint: string;
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
// Defensive traversal guard. Memory nesting and array length are arbitrary by
// design, so this caps total nodes visited (against a pathologically large or
// malformed blob) rather than imposing a fixed semantic depth or a per-array
// item limit that would hide later entries from browsing and search.
const MAX_TREE_NODE_VISITS = 20_000;

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
const SECRET_KEY_PATTERN =
  /(?:^|[_-])(secret|secrets|password|passphrase|token|api[_-]?key|private[_-]?key|encryption[_-]?key|recovery[_-]?key|vault[_-]?key|credential|credentials|authorization|mnemonic)(?:$|[_-])/i;
const INTERNAL_PKM_DOMAINS = new Set([
  "kyc_connector",
  "kyc_workflow",
  "runtime_secrets",
  // Card data never enters agent memory context; chat reads metadata only
  // through the cards.list client action, and secrets only through the
  // on-device reveal widget.
  "payment_cards",
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

function valueFingerprint(value: unknown): string {
  return stableId(`${typeof value}:${String(value ?? "")}`);
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

/**
 * Returns whether a PKM key/domain is private runtime or protocol material
 * that must never enter a user-facing memory projection or an LLM context.
 *
 * Keep this as the single client-side classifier for readable PKM consumers.
 * In particular, `runtime_secrets` may be decrypted by the vault owner only
 * to resolve a turn-local provider credential; it is never agent memory.
 */
export function shouldSkipPkmMemoryKey(key: string): boolean {
  // A leading underscore marks a private/internal key by convention. Check it on
  // the raw key: normalizeKey() strips underscores, so this must run before it.
  if (String(key ?? "").trim().startsWith("_")) return true;
  const normalized = normalizeKey(key);
  if (!normalized) return true;
  if (INTERNAL_KEYS.has(normalized)) return true;
  if (INTERNAL_PKM_DOMAINS.has(normalized) || SECRET_KEY_PATTERN.test(normalized)) return true;
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
  const visiblePath: string[] = [];
  let skipEntityIdentifier = false;
  for (const segment of pathSegments) {
    if (typeof segment === "number") continue;
    const normalized = normalizeKey(segment);
    if (normalized === "entities") {
      skipEntityIdentifier = true;
      continue;
    }
    if (skipEntityIdentifier) {
      skipEntityIdentifier = false;
      continue;
    }
    if (shouldSkipPkmMemoryKey(normalized)) continue;
    const label = titleize(segment);
    if (label) visiblePath.push(label);
    if (visiblePath.length >= 4) break;
  }
  if (visiblePath.length === 0) return `Stored in ${domainTitle}.`;
  return `Stored in ${domainTitle} > ${visiblePath.join(" > ")}.`;
}

function flattenCards(params: {
  domain: string;
  domainTitle: string;
  value: unknown;
  sourceLabel: string;
  updatedAt: string | null;
  pathSegments?: PkmPathSegment[];
  cards?: PkmMemoryCard[];
  visits?: { count: number };
}): PkmMemoryCard[] {
  const pathSegments = params.pathSegments || [];
  const cards = params.cards || [];
  const visits = params.visits || { count: 0 };
  visits.count += 1;
  if (
    visits.count > MAX_TREE_NODE_VISITS ||
    cards.length >= DEFAULT_MAX_CARDS_PER_DOMAIN * 3
  ) {
    return cards;
  }

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
      valueFingerprint: valueFingerprint(params.value),
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
    params.value.forEach((item, index) => {
      flattenCards({
        ...params,
        value: item,
        pathSegments: [...pathSegments, index],
        cards,
        visits,
      });
    });
    return cards;
  }

  if (!isRecord(params.value)) return cards;
  for (const [key, child] of Object.entries(params.value)) {
    if (shouldSkipPkmMemoryKey(key)) continue;
    flattenCards({
      ...params,
      value: child,
      pathSegments: [...pathSegments, key],
      cards,
      visits,
    });
  }
  return cards;
}

/**
 * Public wrapper around the internal flattener: given one node of decrypted
 * domain data and the exact path segments that reach it, return the readable
 * leaf memory cards beneath it. Used by the nested Memory level navigator so a
 * drilled-in leaf carries the same id / fingerprint / labels as a search hit.
 */
export function buildPkmMemoryCardsFromNode(params: {
  domain: string;
  domainTitle: string;
  value: unknown;
  sourceLabel: string;
  updatedAt: string | null;
  pathSegments: PkmPathSegment[];
}): PkmMemoryCard[] {
  return flattenCards(params);
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

const GENERIC_LEAF_LABELS = new Set([
  "value",
  "values",
  "detail",
  "details",
  "profile",
  "data",
  "entry",
  "item",
  "note",
  "notes",
]);

/**
 * Human-readable labels for one memory row.
 *
 * `primary` is a short noun ("Morning flights", "Risk profile") derived from the
 * last meaningful path segment; `secondary` is the readable value sentence
 * ("You prefer morning flights"). When the derived name would just echo the
 * sentence, the raw value is used as the subtitle instead so the row never
 * repeats itself.
 */
export function pkmMemoryRowLabels(card: PkmMemoryCard): {
  primary: string;
  secondary: string;
} {
  const leaf = [...card.pathSegments]
    .reverse()
    .find((segment): segment is string => typeof segment === "string" && segment.trim().length > 0);
  const derived = leaf ? titleize(leaf) : "";
  const primary =
    derived && !GENERIC_LEAF_LABELS.has(derived.toLowerCase())
      ? derived
      : card.domainTitle;
  const value = compact(card.value);
  let sentence = compact(card.title);
  const prefix = `${primary}: `.toLowerCase();
  if (sentence.toLowerCase().startsWith(prefix)) {
    sentence = sentence.slice(prefix.length).trim();
  }
  const secondary =
    sentence && sentence.toLowerCase() !== primary.toLowerCase() ? sentence : value;
  return { primary, secondary };
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
  ).filter((domainKey) => !shouldSkipPkmMemoryKey(domainKey));

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
  expectedValueFingerprint?: string;
}): Record<string, unknown> {
  const nextDomainData = cloneRecord(params.domainData);
  let cursor: unknown = nextDomainData;
  for (const segment of params.pathSegments.slice(0, -1)) {
    const container = ensureContainer(cursor, segment);
    if (!container) {
      if (params.expectedValueFingerprint) {
        throw new Error("This saved detail changed before the correction was applied. Refresh and try again.");
      }
      return nextDomainData;
    }
    cursor = readChild(container, segment);
  }
  const last = params.pathSegments.at(-1);
  const container = ensureContainer(cursor, last ?? "");
  if (!container || last === undefined) {
    if (params.expectedValueFingerprint) {
      throw new Error("This saved detail changed before the correction was applied. Refresh and try again.");
    }
    return nextDomainData;
  }
  const currentValue = readChild(container, last);
  if (
    params.expectedValueFingerprint &&
    valueFingerprint(currentValue) !== params.expectedValueFingerprint
  ) {
    throw new Error("This saved detail changed before the correction was applied. Refresh and try again.");
  }
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
  expectedValueFingerprint?: string;
}): Record<string, unknown> {
  const nextDomainData = cloneRecord(params.domainData);
  let cursor: unknown = nextDomainData;
  for (const segment of params.pathSegments.slice(0, -1)) {
    const container = ensureContainer(cursor, segment);
    if (!container) {
      if (params.expectedValueFingerprint) {
        throw new Error("This saved detail changed before it could be removed. Refresh and try again.");
      }
      return nextDomainData;
    }
    cursor = readChild(container, segment);
  }
  const last = params.pathSegments.at(-1);
  const container = ensureContainer(cursor, last ?? "");
  if (!container || last === undefined) {
    if (params.expectedValueFingerprint) {
      throw new Error("This saved detail changed before it could be removed. Refresh and try again.");
    }
    return nextDomainData;
  }
  const currentValue = readChild(container, last);
  if (
    params.expectedValueFingerprint &&
    valueFingerprint(currentValue) !== params.expectedValueFingerprint
  ) {
    throw new Error("This saved detail changed before it could be removed. Refresh and try again.");
  }
  if (typeof last === "number") {
    if (Array.isArray(container)) container.splice(last, 1);
  } else if (isRecord(container)) {
    delete container[last];
  }
  return nextDomainData;
}
