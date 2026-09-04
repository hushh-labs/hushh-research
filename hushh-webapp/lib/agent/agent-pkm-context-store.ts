"use client";

import {
  PersonalKnowledgeModelService,
  type PersonalKnowledgeModelMetadata,
} from "@/lib/services/personal-knowledge-model-service";
import { shouldSkipPkmMemoryKey } from "@/lib/pkm/pkm-memory-cards";
import { PKM_QUARANTINE_SEGMENT_ID } from "@/lib/personal-knowledge-model/upgrade-registry";

type PkmInventoryFact = {
  domain: string;
  path: string[];
  value: string;
};

export type LocalPkmDuplicateMatch =
  | { kind: "exact"; domain: string; path: string[] }
  | { kind: "possible"; domain: string; path: string[] }
  | null;

type PkmInventory = {
  facts: PkmInventoryFact[];
  domainFactCounts: Map<string, number>;
  skippedFactCount: number;
  safetyOmittedNodeCount: number;
};

type AgentPkmWorkingSet = {
  userId: string;
  metadata: PersonalKnowledgeModelMetadata | null;
  inventory: PkmInventory;
  loadedAt: number;
  metadataUpdatedAt: string | null;
};

export type AgentPkmWorkingContextMode = "relevant" | "broad";

export type AgentPkmContextCoverage = {
  totalFactCount: number;
  matchedFactCount: number;
  selectedFactCount: number;
  omittedFactCount: number;
  domainCount: number;
  listedDomainCount: number;
  omittedDomainCount: number;
  skippedFactCount: number;
  safetyOmittedNodeCount: number;
  budgetChars: number;
  usedChars: number;
  clipped: boolean;
  inventoryOnly: boolean;
  valueTruncatedCount: number;
};

export type AgentPkmWorkingContext = {
  text: string;
  domains: string[];
  totalAttributes: number;
  updatedAt: string | null;
  detailCount: number;
  source: "decrypted_session_pkm";
  mode: AgentPkmWorkingContextMode;
  coverage: AgentPkmContextCoverage;
};

const SESSION_TTL_MS = 5 * 60 * 1000;
// The Finance specialist receives the selected context verbatim, but its
// governed instruction budget is 12k. Keeping selection at that bound means
// One and every current specialist reason from the same turn information.
const DEFAULT_MAX_CONTEXT_CHARS = 12000;
const MIN_CONTEXT_CHARS = 2000;
const MAX_PROJECTED_VALUE_CHARS = 260;
const MAX_INVENTORY_FACTS = 10000;
const MAX_INVENTORY_PATH_DEPTH = 16;

const workingSets = new Map<string, AgentPkmWorkingSet>();
const workingSetLoads = new Map<string, Promise<AgentPkmWorkingSet | null>>();
const workingSetGenerations = new Map<string, number>();
let globalWorkingSetGeneration = 0;
let pkmChangeListenerInstalled = false;

function currentGeneration(userId: string): string {
  return `${globalWorkingSetGeneration}:${workingSetGenerations.get(userId) ?? 0}`;
}

// Why the last void happened, per owner. Only a domain write may be retried;
// a vault clear or an explicit invalidation must drop the in-flight load.
const lastVoidReasons = new Map<string, "domain_changed" | "invalidated">();

function invalidateWorkingSet(
  userId: string,
  reason: "domain_changed" | "invalidated" = "invalidated",
): void {
  workingSets.delete(userId);
  const nextUserGeneration = (workingSetGenerations.get(userId) ?? 0) + 1;
  workingSetGenerations.set(userId, nextUserGeneration);
  lastVoidReasons.set(userId, reason);
}

function ensurePkmChangeListener(): void {
  if (typeof window === "undefined" || pkmChangeListenerInstalled) return;
  window.addEventListener("pkm-domain-changed", (event: Event) => {
    const detail = (event as CustomEvent<{ userId?: unknown }>).detail;
    const userId = typeof detail?.userId === "string" ? detail.userId.trim() : "";
    if (userId) invalidateWorkingSet(userId, "domain_changed");
  });
  pkmChangeListenerInstalled = true;
}

function compactWhitespace(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

function isPrimitive(value: unknown): value is string | number | boolean | bigint {
  return ["string", "number", "boolean", "bigint"].includes(typeof value);
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9$.-]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
  );
}

function normalizedMemoryValue(value: string): string {
  return compactWhitespace(value).toLowerCase();
}

function containsAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function shouldUseBroadContext(message: string): boolean {
  const text = message.toLowerCase();
  return containsAny(text, [
    /\b(?:show|summari[sz]e|explain|list|display|read)\b.*\b(?:all|everything|entire|full)\b.*\b(?:pkm|personal knowledge|memory|memories|what kai knows)\b/,
    /\b(?:what|which)\b.*\b(?:is|are|stuff|details|data|information)\b.*\b(?:in|inside)\b.*\b(?:my )?(?:pkm|personal knowledge|memory|memories)\b/,
    /\b(?:can you|could you)?\s*(?:see|access|read|summari[sz]e|explain|list(?: down)?(?: a)? summary)\b.*\b(?:my )?(?:pkm|personal knowledge|memory|memories)\b/,
    /\bwhat\b.*\b(?:kai|agent|you)\b.*\bknow\b.*\b(?:about me|from my pkm)\b/,
  ]);
}

function scoreFact(fact: PkmInventoryFact, promptTokens: Set<string>): number {
  if (promptTokens.size === 0) return 0;
  const tokens = tokenize(`${fact.domain} ${fact.path.join(" ")} ${fact.value}`);
  const pathText = fact.path.join(" ").toLowerCase();
  let score = 0;
  for (const token of promptTokens) {
    if (tokens.has(token)) score += 4;
    if (pathText.includes(token)) score += 3;
    if (fact.domain.toLowerCase().includes(token)) score += 2;
  }
  return score;
}

function buildPkmInventory(fullBlob: Record<string, unknown>): PkmInventory {
  const facts: PkmInventoryFact[] = [];
  const domainFactCounts = new Map<string, number>();
  const seen = new WeakSet<object>();
  let skippedFactCount = 0;
  let safetyOmittedNodeCount = 0;

  const visit = (domain: string, value: unknown, path: string[]): void => {
    if (
      facts.length >= MAX_INVENTORY_FACTS ||
      path.length > MAX_INVENTORY_PATH_DEPTH
    ) {
      safetyOmittedNodeCount += 1;
      return;
    }
    if (
      domain === PKM_QUARANTINE_SEGMENT_ID ||
      shouldSkipPkmMemoryKey(domain) ||
      path.some((segment) => segment === PKM_QUARANTINE_SEGMENT_ID || shouldSkipPkmMemoryKey(segment))
    ) {
      skippedFactCount += 1;
      return;
    }
    if (isPrimitive(value)) {
      const normalized = compactWhitespace(value);
      if (!normalized) return;
      facts.push({
        domain,
        path,
        value: normalized,
      });
      domainFactCounts.set(domain, (domainFactCounts.get(domain) ?? 0) + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(domain, item, [...path, String(index)]));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (shouldSkipPkmMemoryKey(key)) {
        skippedFactCount += 1;
        continue;
      }
      visit(domain, child, [...path, key]);
    }
  };

  for (const [domain, value] of Object.entries(fullBlob)) {
    visit(domain, value, []);
  }
  return { facts, domainFactCounts, skippedFactCount, safetyOmittedNodeCount };
}

function formatFactPath(fact: PkmInventoryFact): string {
  const displayPath = fact.path
    .filter((segment) => !/^\d+$/.test(segment))
    .map(titleize)
    .join(" > ");
  return [titleize(fact.domain), displayPath].filter(Boolean).join(" > ");
}

function projectFact(fact: PkmInventoryFact): { line: string; truncated: boolean } {
  if (fact.value.length <= MAX_PROJECTED_VALUE_CHARS) {
    return { line: `- ${formatFactPath(fact)}: ${fact.value}`, truncated: false };
  }
  return {
    line: `- ${formatFactPath(fact)}: ${fact.value.slice(0, MAX_PROJECTED_VALUE_CHARS - 1).trimEnd()}...`,
    truncated: true,
  };
}

function appendWithinBudget(
  lines: string[],
  line: string,
  currentLength: number,
  maxChars: number
): number | null {
  const nextLength = currentLength === 0 ? line.length : currentLength + line.length + 1;
  if (nextLength > maxChars) return null;
  lines.push(line);
  return nextLength;
}

function buildContextText(params: {
  workingSet: AgentPkmWorkingSet;
  message: string;
  maxChars: number;
}): AgentPkmWorkingContext {
  const { inventory, metadataUpdatedAt } = params.workingSet;
  const maxChars = Math.max(MIN_CONTEXT_CHARS, params.maxChars || DEFAULT_MAX_CONTEXT_CHARS);
  const mode: AgentPkmWorkingContextMode = shouldUseBroadContext(params.message) ? "broad" : "relevant";
  const domains = Array.from(inventory.domainFactCounts.keys()).sort((left, right) => left.localeCompare(right));
  const promptTokens = tokenize(params.message);
  const scoredFacts = inventory.facts
    .map((fact) => ({ fact, score: scoreFact(fact, promptTokens) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.fact.path.length - right.fact.path.length);
  const matchedFactCount = scoredFacts.length;
  const lines = [
    "Private-agent PKM context:",
    "Source: decrypted locally from the user's unlocked vault for this session.",
    "Boundary: this turn receives only the selected authorized facts below. Never infer facts that are not present.",
    mode === "broad"
      ? "Mode: complete local inventory summary. Raw PKM values are intentionally not included."
      : "Mode: typed local retrieval for the current request.",
    `Inventory coverage: ${inventory.facts.length} facts across ${domains.length} domains examined locally.`,
    metadataUpdatedAt ? `Updated at: ${metadataUpdatedAt}` : null,
    "",
  ].filter((line): line is string => Boolean(line));

  let selectedFactCount = 0;
  let listedDomainCount = 0;
  let valueTruncatedCount = 0;
  const selectedDomains = new Set<string>();
  let currentLength = lines.join("\n").length;
  if (mode === "broad") {
    currentLength = appendWithinBudget(lines, "Available domains:", currentLength, maxChars) ?? currentLength;
    for (const domain of domains) {
      const count = inventory.domainFactCounts.get(domain) ?? 0;
      const nextLength = appendWithinBudget(
        lines,
        `- ${titleize(domain)}: ${count} saved fact${count === 1 ? "" : "s"}`,
        currentLength,
        maxChars
      );
      if (nextLength === null) {
        break;
      }
      currentLength = nextLength;
      listedDomainCount += 1;
    }
  } else if (scoredFacts.length > 0) {
    currentLength = appendWithinBudget(lines, "Selected facts for this request:", currentLength, maxChars) ?? currentLength;
    for (const { fact } of scoredFacts) {
      const projected = projectFact(fact);
      const nextLength = appendWithinBudget(lines, projected.line, currentLength, maxChars);
      if (nextLength === null) break;
      currentLength = nextLength;
      selectedFactCount += 1;
      selectedDomains.add(fact.domain);
      if (projected.truncated) valueTruncatedCount += 1;
    }
  } else {
    currentLength = appendWithinBudget(
      lines,
      "Selected facts for this request: none matched locally.",
      currentLength,
      maxChars
    ) ?? currentLength;
  }

  const omittedFactCount = mode === "broad"
    ? inventory.facts.length
    : Math.max(0, matchedFactCount - selectedFactCount);
  const visibleDomainCount = mode === "broad" ? listedDomainCount : selectedDomains.size;
  const omittedDomainCount = Math.max(0, domains.length - visibleDomainCount);
  const coverage: AgentPkmContextCoverage = {
    totalFactCount: inventory.facts.length,
    matchedFactCount,
    selectedFactCount,
    omittedFactCount,
    domainCount: domains.length,
    listedDomainCount,
    omittedDomainCount,
    skippedFactCount: inventory.skippedFactCount,
    safetyOmittedNodeCount: inventory.safetyOmittedNodeCount,
    budgetChars: maxChars,
    usedChars: 0,
    clipped: omittedFactCount > 0 || omittedDomainCount > 0 || valueTruncatedCount > 0,
    inventoryOnly: mode === "broad",
    valueTruncatedCount,
  };
  const coverageLine = `Coverage: selected ${coverage.selectedFactCount}/${coverage.matchedFactCount} matched facts; ${coverage.totalFactCount} facts examined locally; ${coverage.omittedFactCount} relevant or raw facts withheld.`;
  appendWithinBudget(lines, coverageLine, currentLength, maxChars);
  const text = lines.join("\n");
  coverage.usedChars = text.length;

  return {
    text,
    domains,
    totalAttributes: inventory.facts.length,
    updatedAt: metadataUpdatedAt,
    detailCount: mode === "broad" ? listedDomainCount : selectedFactCount,
    source: "decrypted_session_pkm",
    mode,
    coverage,
  };
}

export class AgentPkmContextStore {
  static clear(userId?: string): void {
    if (userId) {
      workingSetLoads.delete(userId);
      invalidateWorkingSet(userId);
      return;
    }
    workingSets.clear();
    workingSetLoads.clear();
    globalWorkingSetGeneration += 1;
  }

  static invalidateUser(userId: string): void {
    invalidateWorkingSet(userId);
  }

  static peek(params: { userId: string; message?: string; maxChars?: number }): AgentPkmWorkingContext | null {
    ensurePkmChangeListener();
    const cached = workingSets.get(params.userId);
    if (!cached) return null;
    return buildContextText({
      workingSet: cached,
      message: params.message || "",
      maxChars: params.maxChars || DEFAULT_MAX_CONTEXT_CHARS,
    });
  }

  /**
   * Compare only against the already-unlocked, memory-only bounded inventory.
   * This never triggers a decrypt, network request, or model call and returns
   * locations—not values—so a caller can require review without leaking a
   * full domain back into a proposal request.
   */
  static findLocalDuplicate(params: { userId: string; candidate: string }): LocalPkmDuplicateMatch {
    const candidate = normalizedMemoryValue(params.candidate);
    if (!candidate) return null;
    const inventory = workingSets.get(params.userId)?.inventory;
    if (!inventory) return null;
    const exact = inventory.facts.find((fact) => normalizedMemoryValue(fact.value) === candidate);
    if (exact) return { kind: "exact", domain: exact.domain, path: [...exact.path] };
    const candidateTokens = tokenize(candidate);
    const possible = inventory.facts.find((fact) => {
      const factTokens = tokenize(fact.value);
      const overlap = [...candidateTokens].filter((token) => factTokens.has(token)).length;
      return candidateTokens.size >= 3 && overlap >= Math.min(3, candidateTokens.size);
    });
    return possible ? { kind: "possible", domain: possible.domain, path: [...possible.path] } : null;
  }

  static async load(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    message?: string;
    forceRefresh?: boolean;
    maxChars?: number;
  }): Promise<AgentPkmWorkingContext | null> {
    ensurePkmChangeListener();
    const cached = workingSets.get(params.userId);
    const cacheFresh = Boolean(cached && Date.now() - cached.loadedAt < SESSION_TTL_MS);
    if (!params.forceRefresh && cached && cacheFresh) {
      return buildContextText({
        workingSet: cached,
        message: params.message || "",
        maxChars: params.maxChars || DEFAULT_MAX_CONTEXT_CHARS,
      });
    }

    const existingLoad = workingSetLoads.get(params.userId);
    if (existingLoad) {
      const sharedWorkingSet = await existingLoad;
      if (!sharedWorkingSet) return null;
      return buildContextText({
        workingSet: sharedWorkingSet,
        message: params.message || "",
        maxChars: params.maxChars || DEFAULT_MAX_CONTEXT_CHARS,
      });
    }

    const loadOnce = async (): Promise<AgentPkmWorkingSet | null> => {
      const generation = currentGeneration(params.userId);
      const metadata = await PersonalKnowledgeModelService.getMetadata(
        params.userId,
        params.forceRefresh === true,
        params.vaultOwnerToken
      );
      if (generation !== currentGeneration(params.userId)) return null;

      const metadataUpdatedAt = metadata.lastUpdated || null;
      if (!params.forceRefresh && cached && cached.metadataUpdatedAt === metadataUpdatedAt) {
        return { ...cached, metadata, loadedAt: Date.now() };
      }

      const fullBlob = await PersonalKnowledgeModelService.loadFullBlob({
        userId: params.userId,
        vaultKey: params.vaultKey,
        vaultOwnerToken: params.vaultOwnerToken,
      });
      if (generation !== currentGeneration(params.userId)) return null;
      return {
        userId: params.userId,
        metadata,
        inventory: buildPkmInventory(fullBlob),
        loadedAt: Date.now(),
        metadataUpdatedAt,
      };
    };
    // A domain written while the working set is loading (a card saved from the
    // chat widget, a portfolio import) bumps the generation and voids that
    // load. Rebuild once under the new generation instead of handing the turn
    // a null that the chat surfaces as "couldn't load your private memory".
    const startGlobalGeneration = globalWorkingSetGeneration;
    const load = (async (): Promise<AgentPkmWorkingSet | null> => {
      const first = await loadOnce();
      if (first) return first;
      const retryable =
        globalWorkingSetGeneration === startGlobalGeneration &&
        lastVoidReasons.get(params.userId) === "domain_changed";
      return retryable ? loadOnce() : null;
    })();
    workingSetLoads.set(params.userId, load);

    let workingSet: AgentPkmWorkingSet | null;
    try {
      workingSet = await load;
    } finally {
      if (workingSetLoads.get(params.userId) === load) workingSetLoads.delete(params.userId);
    }
    if (!workingSet) return null;
    workingSets.set(params.userId, workingSet);
    return buildContextText({
      workingSet,
      message: params.message || "",
      maxChars: params.maxChars || DEFAULT_MAX_CONTEXT_CHARS,
    });
  }
}
