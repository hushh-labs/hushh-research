"use client";

import { decryptData, encryptData, type EncryptedPayload } from "@/lib/vault/encrypt";

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

export type DurableMemoryAccessInput = {
  userId: string;
  vaultKey?: string | null;
  vaultUnlocked?: boolean;
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
const DB_NAME = "kai_voice_memory_v3";
const STORE_NAME = "durable_memory";

type DurableMemoryEnvelope = {
  user_id: string;
  payload: EncryptedPayload;
  updated_at_ms: number;
};

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
  if (/\b\d{8,}\b/.test(text)) {
    return true;
  }
  if (/\b[a-zA-Z0-9_-]{24,}\b/.test(text)) {
    return true;
  }
  return false;
}

function normalizeSummary(raw: string): string {
  return String(raw || "").replace(/\s+/g, " ").trim().slice(0, 280);
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function canUseDurableMemory(input: DurableMemoryAccessInput): boolean {
  return isBrowser() && input.vaultUnlocked === true && Boolean(String(input.vaultKey || "").trim());
}

function normalizeRows(value: unknown): DurableMemoryItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
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
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!isBrowser()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "user_id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readEnvelope(userId: string): Promise<DurableMemoryEnvelope | null> {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(userId);
      request.onsuccess = () => {
        const result =
          request.result && typeof request.result === "object"
            ? (request.result as DurableMemoryEnvelope)
            : null;
        resolve(result);
      };
      request.onerror = () => resolve(null);
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => db.close();
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function writeEnvelope(userId: string, payload: EncryptedPayload): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      store.put({
        user_id: userId,
        payload,
        updated_at_ms: safeNowMs(),
      } satisfies DurableMemoryEnvelope);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

async function readDurable(
  input: DurableMemoryAccessInput
): Promise<DurableMemoryItem[]> {
  if (!canUseDurableMemory(input)) return [];
  const envelope = await readEnvelope(input.userId);
  if (!envelope) return [];
  try {
    const plaintext = await decryptData(envelope.payload, String(input.vaultKey || ""));
    return normalizeRows(JSON.parse(plaintext));
  } catch {
    return [];
  }
}

async function persistDurable(
  input: DurableMemoryAccessInput,
  rows: DurableMemoryItem[]
): Promise<void> {
  if (!canUseDurableMemory(input)) return;
  const payload = await encryptData(JSON.stringify(rows.slice(0, MAX_DURABLE_ITEMS)), String(input.vaultKey || ""));
  await writeEnvelope(input.userId, payload);
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

  async retrieveDurable(
    input: DurableMemoryAccessInput & {
      query: string;
      limit?: number;
    }
  ): Promise<DurableMemoryItem[]> {
    const rows = await readDurable(input);
    const now = safeNowMs();
    const ranked = rows
      .map((row) => {
        const queryScore = scoreMemoryItem(row.summary, input.query);
        const recencyScore = Math.max(0, 1 - Math.min(1, (now - row.last_used_ms) / (1000 * 60 * 60 * 24 * 30)));
        return {
          row,
          score: queryScore * 3 + recencyScore,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(input.limit ?? 8, 20)))
      .map((entry) => ({
        ...entry.row,
        last_used_ms: now,
      }));

    if (ranked.length > 0) {
      const byId = new Map(rows.map((row) => [row.id, row]));
      ranked.forEach((row) => {
        byId.set(row.id, row);
      });
      await persistDurable(input, Array.from(byId.values()));
    }
    return ranked;
  }

  async writeDurable(
    input: DurableMemoryAccessInput & {
      candidates: DurableMemoryWriteCandidate[];
    }
  ): Promise<DurableMemoryItem[]> {
    if (!canUseDurableMemory(input)) return [];

    const normalized = input.candidates
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
    const existing = await readDurable(input);
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
    await persistDurable(input, rows);
    return rows;
  }
}

export const voiceMemoryStore = new VoiceMemoryStore();
