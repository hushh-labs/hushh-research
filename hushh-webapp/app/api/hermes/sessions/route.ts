import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { resolveHermesBridgeConfig } from "@/lib/hermes/bridge-config";
import { resolveRequestId, withRequestIdJson } from "@/app/api/_utils/request-id";

/**
 * Puppy One's own conversations.
 *
 * Puppy One and One are two agents with two memories, and until now the
 * workspace showed One's conversation list under both. That list is the
 * reader's map of what they have said to whom, so borrowing it made the
 * on-device agent look like it remembered turns it never saw, and hid the ones
 * it did.
 *
 * These live on the owner's machine, in the Hermes session store, and never in
 * One's cloud history. Server-side only, like every route in this folder: the
 * loopback bearer key is host remote-code-execution and stays here.
 */

/** What the sidebar needs. Everything else the gateway reports is not its business. */
export interface PuppyConversation {
  id: string;
  title: string;
  preview: string | null;
  model: string | null;
  messageCount: number;
  lastActive: number | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** Gateway timestamps are epoch SECONDS; the UI works in milliseconds. */
function millis(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 1000);
}

export async function GET(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const config = resolveHermesBridgeConfig();
  if (!config) {
    return withRequestIdJson(
      requestId,
      {
        configured: false,
        reason: "not_configured",
        conversations: [],
        message: "Set HERMES_API_SERVER_KEY to read Puppy One's conversations.",
      },
      { status: 200 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // A closed loopback port is the ordinary "agent not running" case.
    return withRequestIdJson(
      requestId,
      { configured: true, reachable: false, conversations: [] },
      { status: 200 },
    );
  }
  if (!upstream.ok) {
    return withRequestIdJson(
      requestId,
      { configured: true, reachable: false, conversations: [] },
      { status: 200 },
    );
  }

  const payload = (await upstream.json().catch(() => ({}))) as { data?: unknown };
  const rows = Array.isArray(payload.data) ? payload.data : [];

  const conversations: PuppyConversation[] = rows
    .map((raw) => {
      const row =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const id = text(row.id);
      if (!id) return null;
      return {
        id,
        // A session the owner has not named yet still needs a handle in the
        // list; the first thing they said is the most useful one.
        title: text(row.title) ?? text(row.preview) ?? "Untitled",
        preview: text(row.preview),
        model: text(row.model),
        messageCount: count(row.message_count),
        lastActive: millis(row.last_active) ?? millis(row.started_at),
      };
    })
    .filter((row): row is PuppyConversation => row !== null)
    // Hidden and archived sessions are not conversations the owner is having.
    .filter((_row, index) => {
      const source = rows[index] as Record<string, unknown> | undefined;
      return !source?.hidden && !source?.archived;
    })
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));

  return withRequestIdJson(
    requestId,
    // Envelope flags last: they describe this bridge, not the gateway.
    { conversations, configured: true, reachable: true },
    { status: 200 },
  );
}
