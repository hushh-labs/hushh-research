"use client";

import { Bug, ChevronDown, ChevronUp, Copy, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { useVoiceSession } from "@/lib/voice/voice-session-store";
import type { VoiceUiState } from "@/lib/voice/voice-ui-state-machine";
import { cn } from "@/lib/utils";

type VoiceDebugDrawerProps = {
  enabled: boolean;
  currentState: VoiceUiState;
  sessionId: string;
  route: string;
  screen: string;
  authStatus: string;
  vaultStatus: string;
  voiceAvailabilityReason: string;
};

export function VoiceDebugDrawer({
  enabled,
  currentState,
  sessionId,
  route,
  screen,
  authStatus,
  vaultStatus,
  voiceAvailabilityReason,
}: VoiceDebugDrawerProps) {
  const [open, setOpen] = useState(false);
  const debugEvents = useVoiceSession((s) => s.debugEvents);
  const clearDebugEvents = useVoiceSession((s) => s.clearDebugEvents);
  const lastTurnId = useVoiceSession((s) => s.lastTurnId);

  const recentEvents = useMemo(() => {
    const slice = [...debugEvents].slice(-80).reverse();
    return slice;
  }, [debugEvents]);

  const turnSummary = useMemo(() => {
    const byTurn = new Map<string, (typeof debugEvents)[number][]>();
    for (const event of debugEvents) {
      const list = byTurn.get(event.turnId) || [];
      list.push(event);
      byTurn.set(event.turnId, list);
    }
    const completedTurnIds: string[] = [];
    for (const [turnId, events] of byTurn.entries()) {
      const hasCompletion = events.some((event) => {
        if (event.stage === "turn" && ["turn_completed", "turn_failed", "turn_aborted"].includes(event.event)) {
          return true;
        }
        if (event.stage === "turn" && event.event === "stage_timing") {
          const stage = typeof event.payload?.stage === "string" ? event.payload.stage : "";
          return stage === "playback_ended" || stage === "tts_fallback_playback_ended";
        }
        return false;
      });
      if (hasCompletion) completedTurnIds.push(turnId);
    }
    const activeTurnId =
      (completedTurnIds.length > 0 ? completedTurnIds[completedTurnIds.length - 1] : null) ||
      lastTurnId ||
      recentEvents[0]?.turnId ||
      null;
    if (!activeTurnId) {
      return {
        turnId: null,
        sttModel: null as string | null,
        plannerModel: null as string | null,
        ttsModel: null as string | null,
        ttsSource: null as string | null,
        fallbackUsed: false,
        fallbackReason: null as string | null,
        totalMs: null as number | null,
        realtimeReady: null as boolean | null,
      };
    }

    const events = debugEvents.filter((event) => event.turnId === activeTurnId);
    const toNumber = (value: unknown): number | null => {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    };

    let sttModel: string | null = null;
    let plannerModel: string | null = null;
    let ttsModel: string | null = null;
    let ttsSource: string | null = null;
    let fallbackUsed = false;
    let fallbackReason: string | null = null;
    let totalMs: number | null = null;
    let realtimeReady: boolean | null = null;

    for (const event of events) {
      const payload = event.payload || {};
      if (event.stage === "stt" && event.event === "request_ended") {
        const model = payload.model;
        if (typeof model === "string" && model.trim()) sttModel = model.trim();
      }
      if (event.stage === "planner" && event.event === "response_received") {
        const model = payload.planner_model;
        if (typeof model === "string" && model.trim()) plannerModel = model.trim();
      }
      if (event.stage === "tts" && event.event === "audio_received") {
        const model = payload.model;
        if (typeof model === "string" && model.trim()) ttsModel = model.trim();
        const source = payload.source;
        if (typeof source === "string" && source.trim()) ttsSource = source.trim();
        if (payload.fallback_attempted === true) {
          fallbackUsed = true;
          fallbackReason = "model_fallback";
        }
      }
      if (
        event.stage === "tts" &&
        (event.event === "fallback_activated" ||
          event.event === "tts_fallback_triggered" ||
          event.event === "legacy_local_tts_activated")
      ) {
        fallbackUsed = true;
        const reason = payload.reason;
        if (typeof reason === "string" && reason.trim()) {
          fallbackReason = reason.trim();
        }
      }
      if (event.stage === "turn" && event.event === "stage_timing") {
        const ms = toNumber(payload.since_turn_start_ms);
        if (ms != null) {
          totalMs = totalMs == null ? ms : Math.max(totalMs, ms);
        }
      }
      if (event.stage === "stt" && event.event === "stream_session_connected") {
        realtimeReady = true;
      }
      if (
        event.stage === "stt" &&
        (event.event === "stream_submit_blocked_not_ready" ||
          event.event === "stream_session_failed" ||
          event.event === "data_channel_closed")
      ) {
        realtimeReady = false;
      }
    }

    return {
      turnId: activeTurnId,
      sttModel,
      plannerModel,
      ttsModel,
      ttsSource,
      fallbackUsed,
      fallbackReason,
      totalMs,
      realtimeReady,
    };
  }, [debugEvents, lastTurnId, recentEvents]);

  const copyPayload = useMemo(
    () =>
      JSON.stringify(
        {
          state: currentState,
          session_id: sessionId,
          turn_id: lastTurnId ?? null,
          route,
          screen,
          auth_status: authStatus,
          vault_status: vaultStatus,
          voice_availability: voiceAvailabilityReason,
          summary: {
            stt_model: turnSummary.sttModel,
            planner_model: turnSummary.plannerModel,
            tts_model: turnSummary.ttsModel,
            tts_source: turnSummary.ttsSource,
            fallback_used: turnSummary.fallbackUsed,
            fallback_reason: turnSummary.fallbackReason,
            realtime_ready: turnSummary.realtimeReady,
            total_ms: turnSummary.totalMs,
          },
          recent_events: recentEvents,
        },
        null,
        2
      ),
    [
      authStatus,
      currentState,
      lastTurnId,
      recentEvents,
      route,
      screen,
      sessionId,
      turnSummary,
      vaultStatus,
      voiceAvailabilityReason,
    ]
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(copyPayload);
      toast.success("Voice debug copied");
    } catch {
      toast.error("Could not copy voice debug");
    }
  }, [copyPayload]);

  if (!enabled) return null;

  return (
    <div className="pointer-events-auto fixed bottom-5 right-4 z-[180] w-[min(92vw,420px)]">
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          className="inline-flex h-9 items-center gap-2 rounded-full border border-border/70 bg-background/95 px-3 text-xs font-semibold text-foreground shadow-md backdrop-blur hover:bg-muted"
          onClick={() => setOpen((v) => !v)}
        >
          <Bug className="h-3.5 w-3.5" />
          Voice Debug
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </button>
      </div>

      <div
        className={cn(
          "overflow-hidden rounded-2xl border border-border/70 bg-background/95 shadow-2xl backdrop-blur transition-all duration-200",
          open ? "max-h-[65vh] opacity-100" : "pointer-events-none max-h-0 opacity-0"
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/60 px-3 py-2">
          <div className="space-y-1 text-[11px] text-muted-foreground">
            <p>
              <span className="font-semibold text-foreground">State:</span> {currentState}
            </p>
            <p>
              <span className="font-semibold text-foreground">Session:</span> {sessionId}
            </p>
            <p>
              <span className="font-semibold text-foreground">Turn:</span> {lastTurnId ?? "n/a"}
            </p>
            <p>
              <span className="font-semibold text-foreground">Models:</span>{" "}
              STT={turnSummary.sttModel || "n/a"} | Planner={turnSummary.plannerModel || "n/a"} | TTS=
              {turnSummary.ttsModel || "n/a"}
            </p>
            <p>
              <span className="font-semibold text-foreground">TTS Source:</span>{" "}
              {turnSummary.ttsSource || "n/a"}
            </p>
            <p>
              <span className="font-semibold text-foreground">Fallback:</span>{" "}
              {turnSummary.fallbackUsed ? `yes${turnSummary.fallbackReason ? ` (${turnSummary.fallbackReason})` : ""}` : "no"}
            </p>
            <p>
              <span className="font-semibold text-foreground">Realtime Ready:</span>{" "}
              {turnSummary.realtimeReady == null ? "n/a" : turnSummary.realtimeReady ? "yes" : "no"}
            </p>
            <p>
              <span className="font-semibold text-foreground">Turn Total:</span>{" "}
              {turnSummary.totalMs != null ? `${Math.round(turnSummary.totalMs)} ms` : "n/a"}
            </p>
            <p>
              <span className="font-semibold text-foreground">Route:</span> {route} ({screen})
            </p>
            <p>
              <span className="font-semibold text-foreground">Auth:</span> {authStatus}
            </p>
            <p>
              <span className="font-semibold text-foreground">Vault:</span> {vaultStatus}
            </p>
            <p>
              <span className="font-semibold text-foreground">Voice:</span> {voiceAvailabilityReason}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => void handleCopy()}
              aria-label="Copy voice debug"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={clearDebugEvents}
              aria-label="Clear debug events"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="max-h-[45vh] overflow-auto px-3 py-2">
          {recentEvents.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No voice events captured yet.</p>
          ) : (
            <div className="space-y-1.5">
              {recentEvents.map((event) => (
                <div
                  key={event.id}
                  className="rounded-lg border border-border/50 bg-background/70 px-2.5 py-1.5 text-[10px]"
                >
                  <p className="font-semibold text-foreground">
                    {event.stage}:{event.event}
                  </p>
                  <p className="truncate text-muted-foreground">
                    {event.timestamp} | turn={event.turnId}
                  </p>
                  {event.payload ? (
                    <pre className="mt-1 overflow-auto whitespace-pre-wrap break-all text-muted-foreground">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
