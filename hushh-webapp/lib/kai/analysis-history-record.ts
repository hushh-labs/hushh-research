import type { AnalysisHistoryEntry, AnalysisHistoryMap } from "@/lib/services/kai-history-service";
import { getAnalysisHistoryRunRouteId } from "./analysis-route-intent";

function compactTranscriptRound(
  round: Record<string, any>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(round || {}).map(([agent, rawState]) => {
      const state =
        rawState && typeof rawState === "object" && !Array.isArray(rawState)
          ? (rawState as Record<string, unknown>)
          : {};
      return [
        agent,
        {
          stage: typeof state.stage === "string" ? state.stage : "complete",
          text: typeof state.text === "string" ? state.text : "",
          thoughts: Array.isArray(state.thoughts)
            ? state.thoughts.map((value) => String(value))
            : [],
          ...(typeof state.statusMessage === "string"
            ? { statusMessage: state.statusMessage }
            : {}),
          ...(typeof state.error === "string" ? { error: state.error } : {}),
        },
      ];
    }),
  );
}

/**
 * Persist the decision card once and keep only the text needed to replay each
 * analyst turn. Rich metrics already live in `raw_card`; copying them into
 * every transcript agent doubled the encrypted financial blob and made each
 * later history append progressively slower.
 */
export function compactAnalysisHistoryEntryForStorage(
  entry: AnalysisHistoryEntry,
): AnalysisHistoryEntry {
  if (!entry.debate_transcript) return entry;
  return {
    ...entry,
    debate_transcript: {
      round1: compactTranscriptRound(entry.debate_transcript.round1),
      round2: compactTranscriptRound(entry.debate_transcript.round2),
    },
  };
}

/**
 * Stable, URL-safe identity for a stored analysis. Runs use their persisted
 * run id; older records retain a deterministic ticker-and-timestamp fallback.
 */
export function getAnalysisHistoryEntryRouteId(
  entry: AnalysisHistoryEntry,
): string {
  const runId = extractRunId(entry);
  if (runId) return getAnalysisHistoryRunRouteId(runId);
  return `saved:${entry.ticker.toUpperCase()}:${entry.timestamp}`;
}

export function findAnalysisHistoryEntryByRouteId(
  historyMap: AnalysisHistoryMap,
  routeId: string,
): AnalysisHistoryEntry | null {
  const wanted = String(routeId || "").trim();
  if (!wanted) return null;
  return (
    Object.values(historyMap)
      .flat()
      .find((entry) => getAnalysisHistoryEntryRouteId(entry) === wanted) ?? null
  );
}

export function extractStreamId(entry: AnalysisHistoryEntry): string | null {
  const rawCard = entry.raw_card;
  if (!rawCard || typeof rawCard !== "object") return null;
  const diagnostics = (rawCard as Record<string, unknown>).stream_diagnostics;
  if (!diagnostics || typeof diagnostics !== "object") return null;
  const streamId = (diagnostics as Record<string, unknown>).stream_id;
  if (typeof streamId !== "string") return null;
  const trimmed = streamId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractRunId(entry: AnalysisHistoryEntry): string | null {
  const rawCard = entry.raw_card;
  if (!rawCard || typeof rawCard !== "object") return null;
  const direct = (rawCard as Record<string, unknown>).debate_run_id;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  return extractStreamId(entry);
}

