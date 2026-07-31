"use client";

import { CACHE_KEYS, CACHE_TTL, CacheService } from "@/lib/services/cache-service";
import { ROUTES } from "@/lib/navigation/routes";
import type { Persona } from "@/lib/services/ria-service";

export type AgentWelcomeSuggestion = {
  id: string;
  label: string;
  prompt: string;
  source: "route" | "persona" | "one";
};

type ResolveAgentWelcomeSuggestionsInput = {
  userId?: string | null;
  pathname?: string | null;
  persona?: Persona | null;
  limit?: number;
  randomSeed?: number;
};

const BASE_SUGGESTIONS: AgentWelcomeSuggestion[] = [
  {
    id: "one-next-setup",
    label: "What should I set up next?",
    prompt: "Look at my One setup and tell me the highest-value next step.",
    source: "one",
  },
  {
    id: "memory-refresh",
    label: "Find stale memories",
    prompt: "Find memories or profile details that look stale and should be updated.",
    source: "one",
  },
  {
    id: "consent-request",
    label: "Draft an information request",
    prompt: "Help me draft a clear, consent-scoped information request for another One user.",
    source: "one",
  },
  {
    id: "workflow-summary",
    label: "Summarize my active workflows",
    prompt: "Summarize my active One workflows and what needs my attention.",
    source: "one",
  },
];

const ROUTE_SUGGESTIONS: Record<string, AgentWelcomeSuggestion[]> = {
  [ROUTES.ONE_HOME]: [
    {
      id: "one-dashboard-status",
      label: "Show my setup status",
      prompt: "Review my One dashboard and tell me what is set up, missing, or stale.",
      source: "route",
    },
  ],
  [ROUTES.KAI_HOME]: [
    {
      id: "market-change",
      label: "What changed in markets?",
      prompt: "Tell me what changed in the market since my last check and what matters.",
      source: "route",
    },
  ],
  [ROUTES.KAI_PORTFOLIO]: [
    {
      id: "portfolio-risk",
      label: "Review my portfolio risk",
      prompt: "Review my portfolio setup, risk, and the next action I should consider.",
      source: "route",
    },
  ],
  [ROUTES.KAI_ANALYSIS]: [
    {
      id: "analysis-next",
      label: "Pick my next analysis",
      prompt: "Suggest the next stock or scenario I should analyze based on my context.",
      source: "route",
    },
  ],
  [ROUTES.GMAIL]: [
    {
      id: "gmail-receipts",
      label: "Find receipt patterns",
      prompt: "Review my Gmail receipts and identify patterns worth saving to memory.",
      source: "route",
    },
  ],
  [ROUTES.MARKETPLACE]: [
    {
      id: "connect-request",
      label: "Request information",
      prompt: "Help me request the right information from a One user with clear consent scope.",
      source: "route",
    },
  ],
  [ROUTES.PROFILE]: [
    {
      id: "profile-data",
      label: "Audit my data",
      prompt: "Show what information I have connected and what I should clean up.",
      source: "route",
    },
  ],
};

const PERSONA_SUGGESTIONS: Record<Persona, AgentWelcomeSuggestion[]> = {
  investor: [
    {
      id: "investor-ria-request",
      label: "Prepare an RIA request",
      prompt: "Help me request advisor information with the right consent scope.",
      source: "persona",
    },
  ],
  ria: [
    {
      id: "ria-client-request",
      label: "Request client information",
      prompt: "Help me request the client information I need with a clear consent scope.",
      source: "persona",
    },
  ],
};

function normalizeRoute(pathname?: string | null): string {
  const base = String(pathname || ROUTES.ONE_HOME).split(/[?#]/, 1)[0] || ROUTES.ONE_HOME;
  const withSlash = base.startsWith("/") ? base : `/${base}`;
  return withSlash.endsWith("/") && withSlash !== "/" ? withSlash.slice(0, -1) : withSlash;
}

function routeSuggestionsFor(pathname?: string | null): AgentWelcomeSuggestion[] {
  const route = normalizeRoute(pathname);
  if (ROUTE_SUGGESTIONS[route]) return ROUTE_SUGGESTIONS[route];
  if (route.startsWith(`${ROUTES.KAI_HOME}/`)) return ROUTE_SUGGESTIONS[ROUTES.KAI_HOME] ?? [];
  return [];
}

function dedupeSuggestions(items: AgentWelcomeSuggestion[]): AgentWelcomeSuggestion[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function randomizeSuggestions(
  items: AgentWelcomeSuggestion[],
  randomSeed: number,
): AgentWelcomeSuggestion[] {
  const next = [...items];
  let seed = Math.max(1, Math.floor(randomSeed) || Date.now());
  for (let index = next.length - 1; index > 0; index -= 1) {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    const swapIndex = seed % (index + 1);
    [next[index], next[swapIndex]] = [next[swapIndex]!, next[index]!];
  }
  return next;
}

function buildSuggestionPool(input: ResolveAgentWelcomeSuggestionsInput): AgentWelcomeSuggestion[] {
  const persona = input.persona || "investor";
  return dedupeSuggestions([
    ...routeSuggestionsFor(input.pathname),
    ...(PERSONA_SUGGESTIONS[persona] ?? []),
    ...BASE_SUGGESTIONS,
  ]);
}

export function resolveAgentWelcomeSuggestions(
  input: ResolveAgentWelcomeSuggestionsInput = {},
): AgentWelcomeSuggestion[] {
  const userId = input.userId?.trim() || "anonymous";
  const persona = input.persona || "investor";
  const route = normalizeRoute(input.pathname);
  const limit = Math.max(1, Math.min(input.limit ?? 3, 5));
  const cache = CacheService.getInstance();
  const cacheKey = CACHE_KEYS.AGENT_WELCOME_SUGGESTIONS(userId, route, persona);
  const cachedPool = cache.get<AgentWelcomeSuggestion[]>(cacheKey);
  const pool = cachedPool?.length ? cachedPool : buildSuggestionPool(input);

  if (!cachedPool?.length) {
    cache.set(cacheKey, pool, CACHE_TTL.MEDIUM);
  }

  const [primary, ...secondary] = pool;
  return [
    ...(primary ? [primary] : []),
    ...randomizeSuggestions(secondary, input.randomSeed ?? Date.now()),
  ].slice(0, limit);
}
