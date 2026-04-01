"use client";

export type ShortTermTurn = {
  turn_id: string;
  transcript_final: string;
  response_text: string;
  response_kind: string;
  created_at_ms: number;
};

export type DurableMemoryCategory =
  | "preferences"
  | "favorite_views"
  | "navigation_habits"
  | "watchlist_interests"
  | "communication_style"
  | "stable_product_choices";

export type DurableMemoryItem = {
  id: string;
  category: DurableMemoryCategory;
  summary: string;
  created_at_ms: number;
  last_used_ms: number;
};

export type DurableMemoryWriteCandidate = {
  category: DurableMemoryCategory;
  summary: string;
};

const ALLOWED_CATEGORIES = new Set<DurableMemoryCategory>([
  "preferences",
  "favorite_views",
  "navigation_habits",
  "watchlist_interests",
  "communication_style",
  "stable_product_choices",
]);

const MAX_SHORT_TERM_TURNS = 20;
const MAX_DURABLE_ITEMS = 80;

function safeNowMs(): number {
  return Date.now();
}

function isSensitiveSummary(text: string): boolean {
  const lower = text.toLowerCase();
  if (!lower) return true;
  const forbiddenKeywords = [
    "token",
    "secret",
    "password",
    "private key",
    "account number",
    "routing number",
    "ssn",
    "social security",
    "passport",
    "driver license",
    "document",
    "statement",
  ];
  if (forbiddenKeywords.some((keyword) => lower.includes(keyword))) {
    return true;
  }
  // Reject likely account IDs / sensitive numeric identifiers.
  if (/\b\d{8,}\b/.test(text)) {
    return true;
  }
  // Reject long alpha-numeric tokens.
  if (/\b[a-zA-Z0-9_-]{24,}\b/.test(text)) {
    return true;
  }
  return false;
}

function normalizeSummary(raw: string): string {
  return String(raw || "").replace(/\s+/g, " ").trim().slice(0, 280);
}

function memoryStorageKey(userId: string): string {
  return `kai_voice_v2_memory::${userId}`;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readDurable(userId: string): DurableMemoryItem[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(memoryStorageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => {
        if (!value || typeof value !== "object") return null;
        const row = value as Record<string, unknown>;
        const category = String(row.category || "") as DurableMemoryCategory;
        const summary = normalizeSummary(String(row.summary || ""));
        if (!ALLOWED_CATEGORIES.has(category) || !summary) return null;
        return {
          id: String(row.id || "").trim() || `mem_${Math.random().toString(16).slice(2)}`,
          category,
          summary,
          created_at_ms:
            typeof row.created_at_ms === "number" && Number.isFinite(row.created_at_ms)
              ? row.created_at_ms
              : safeNowMs(),
          last_used_ms:
            typeof row.last_used_ms === "number" && Number.isFinite(row.last_used_ms)
              ? row.last_used_ms
              : safeNowMs(),
        } satisfies DurableMemoryItem;
      })
      .filter((item): item is DurableMemoryItem => Boolean(item))
      .slice(0, MAX_DURABLE_ITEMS);
  } catch {
    return [];
  }
}

function writeDurable(userId: string, rows: DurableMemoryItem[]): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(memoryStorageKey(userId), JSON.stringify(rows.slice(0, MAX_DURABLE_ITEMS)));
  } catch {
    // Ignore localStorage quota/runtime failures.
  }
}

function scoreMemoryItem(summary: string, query: string): number {
  if (!query) return 0;
  const summaryLower = summary.toLowerCase();
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  if (tokens.length === 0) return 0;
  let score = 0;
  tokens.forEach((token) => {
    if (summaryLower.includes(token)) score += 1;
  });
  return score;
}

class VoiceMemoryStore {
  private shortTermByUser = new Map<string, ShortTermTurn[]>();

  getShortTerm(userId: string, limit: number = MAX_SHORT_TERM_TURNS): ShortTermTurn[] {
    const rows = this.shortTermByUser.get(userId) || [];
    return rows.slice(Math.max(0, rows.length - Math.max(1, Math.min(limit, MAX_SHORT_TERM_TURNS))));
  }

  appendShortTerm(userId: string, turn: ShortTermTurn): void {
    const rows = this.shortTermByUser.get(userId) || [];
    rows.push(turn);
    if (rows.length > MAX_SHORT_TERM_TURNS) {
      rows.splice(0, rows.length - MAX_SHORT_TERM_TURNS);
    }
    this.shortTermByUser.set(userId, rows);
  }

  retrieveDurable(userId: string, query: string, limit: number = 8): DurableMemoryItem[] {
    const rows = readDurable(userId);
    const now = safeNowMs();
    const ranked = rows
      .map((row) => {
        const queryScore = scoreMemoryItem(row.summary, query);
        const recencyScore = Math.max(0, 1 - Math.min(1, (now - row.last_used_ms) / (1000 * 60 * 60 * 24 * 30)));
        return {
          row,
          score: queryScore * 3 + recencyScore,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(limit, 20)))
      .map((entry) => ({
        ...entry.row,
        last_used_ms: now,
      }));

    if (ranked.length > 0) {
      const byId = new Map(rows.map((row) => [row.id, row]));
      ranked.forEach((row) => {
        byId.set(row.id, row);
      });
      writeDurable(userId, Array.from(byId.values()));
    }
    return ranked;
  }

  writeDurable(userId: string, candidates: DurableMemoryWriteCandidate[]): DurableMemoryItem[] {
    const normalized = candidates
      .map((candidate) => {
        const category = candidate.category;
        const summary = normalizeSummary(candidate.summary);
        if (!ALLOWED_CATEGORIES.has(category)) return null;
        if (!summary || isSensitiveSummary(summary)) return null;
        return {
          category,
          summary,
        };
      })
      .filter((item): item is { category: DurableMemoryCategory; summary: string } => Boolean(item));

    if (normalized.length === 0) return [];

    const now = safeNowMs();
    const existing = readDurable(userId);
    const byKey = new Map<string, DurableMemoryItem>();

    existing.forEach((item) => {
      byKey.set(`${item.category}:${item.summary.toLowerCase()}`, item);
    });

    normalized.forEach((item) => {
      const key = `${item.category}:${item.summary.toLowerCase()}`;
      const prev = byKey.get(key);
      if (prev) {
        byKey.set(key, {
          ...prev,
          last_used_ms: now,
        });
        return;
      }
      byKey.set(key, {
        id: `mem_${Math.random().toString(16).slice(2, 10)}`,
        category: item.category,
        summary: item.summary,
        created_at_ms: now,
        last_used_ms: now,
      });
    });

    const rows = Array.from(byKey.values())
      .sort((a, b) => b.last_used_ms - a.last_used_ms)
      .slice(0, MAX_DURABLE_ITEMS);
    writeDurable(userId, rows);
    return rows;
  }
}

export const voiceMemoryStore = new VoiceMemoryStore();
