/**
 * "Here's what I picked up": the card One offers after a first connection.
 *
 * The server (`POST /api/one/first-connect-insights`, same gate as a chat turn:
 * vault-owner token plus chat key) returns a few inferences for one newly
 * connected source and stores nothing about them. They live only in the card's
 * React state. Keep saves one through the existing owner-confirmed encrypted
 * PKM path (prepare, then `addToPKM` with `confirmedByUser: true`); Forget
 * drops it from the screen. Nothing reaches memory any other way.
 */

import { connectorMemorySharingImpact, prepareConnectorMemoryReview, saveConnectorMemoryReview } from "@/lib/agent/connector-memory-review";
import { ApiService } from "@/lib/services/api-service";
import { oneChatKeyHeaders } from "@/lib/vault/one-chat-key";

export const FIRST_CONNECT_INSIGHTS_ENDPOINT = "/api/one/first-connect-insights";
export const FIRST_CONNECT_INSIGHTS_SOURCE = "first_connect_insights";

export type FirstConnectInsightKind =
  | "recurring_meeting"
  | "newsletter_heavy"
  | "subscription_or_bill"
  | "frequent_contact"
  | "work_hours"
  | "working_pattern";

export type FirstConnectInsight = {
  id: string;
  kind: FirstConnectInsightKind;
  /** What the card shows, addressed to the person. */
  label: string;
  /** Exactly what Keep saves, in the person's own first-person words. */
  memoryText: string;
  evidence: string;
};

export type FirstConnectInsightsOffer = {
  source: "gmail" | "calendar" | "drive";
  sourceLabel: string;
  items: FirstConnectInsight[];
};

const KINDS = new Set<FirstConnectInsightKind>([
  "recurring_meeting",
  "newsletter_heavy",
  "subscription_or_bill",
  "frequent_contact",
  "work_hours",
  "working_pattern",
]);
const SOURCES = new Set(["gmail", "calendar", "drive"]);

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/** Parse the server's reply; anything but a well-formed offer is "nothing to show". */
export function parseFirstConnectInsightsOffer(payload: unknown): FirstConnectInsightsOffer | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.status !== "offered" || !SOURCES.has(String(record.source))) return null;
  const items = Array.isArray(record.items) ? record.items : [];
  const parsed: FirstConnectInsight[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const kind = String(item.kind) as FirstConnectInsightKind;
    const id = text(item.id, 40);
    const label = text(item.label, 200);
    const memoryText = text(item.memory_text, 240);
    if (!KINDS.has(kind) || !id || !label || !memoryText) continue;
    parsed.push({ id, kind, label, memoryText, evidence: text(item.evidence, 160) });
  }
  if (parsed.length === 0) return null;
  return {
    source: record.source as FirstConnectInsightsOffer["source"],
    sourceLabel: text(record.sourceLabel, 40) || "your account",
    items: parsed.slice(0, 5),
  };
}

/** Ask for the card. Best-effort: any failure means there is simply no card. */
export async function fetchFirstConnectInsights(input: {
  vaultOwnerToken: string;
  vaultKey: string;
  signal?: AbortSignal;
}): Promise<FirstConnectInsightsOffer | null> {
  try {
    const response = await ApiService.apiFetch(FIRST_CONNECT_INSIGHTS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.vaultOwnerToken}`,
        ...(await oneChatKeyHeaders(input.vaultKey)),
      },
      signal: input.signal,
    });
    if (!response.ok) return null;
    return parseFirstConnectInsightsOffer(await response.json());
  } catch {
    return null;
  }
}

export type KeepInsightResult =
  | { status: "saved" }
  /** Saving would change what active recipients receive; ask once more first. */
  | { status: "needs_sharing_ack"; recipientCount: number }
  | { status: "nothing_to_save" }
  | { status: "failed" };

/**
 * Save one kept inference through the owner-confirmed encrypted PKM writer.
 * Called only from the Keep button; this is the only path to memory.
 */
export async function keepFirstConnectInsight(input: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  memoryText: string;
  sharingImpactAcknowledged?: boolean;
  isCurrent: () => boolean;
  assertCurrent: () => Promise<void>;
}): Promise<KeepInsightResult> {
  const message = input.memoryText.trim();
  if (!message) return { status: "nothing_to_save" };
  try {
    const { cards, incomplete } = await prepareConnectorMemoryReview({
      ...input,
      message,
      source: FIRST_CONNECT_INSIGHTS_SOURCE,
    });
    if (cards.length === 0) return { status: incomplete ? "failed" : "nothing_to_save" };
    const recipientCount = connectorMemorySharingImpact(cards);
    if (recipientCount > 0 && !input.sharingImpactAcknowledged) {
      return { status: "needs_sharing_ack", recipientCount };
    }
    const result = await saveConnectorMemoryReview({
      ...input,
      cards,
      message,
      source: FIRST_CONNECT_INSIGHTS_SOURCE,
    });
    if (result && result.saved > 0 && result.failed === 0 && !incomplete) {
      return { status: "saved" };
    }
    return { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}
