/** Opaque request correlation only: never include questions, facts, scopes or keys. */
export function answerStageTiming(requestId: string, stage: "owner_projection" | "memory_read" | "memory_refresh" | "gemini_compose" | "encrypt_stage" | "feed_publish", started: number): void {
  if (!/^[a-f0-9-]{36}$/i.test(requestId)) return;
  const duration = Math.max(0, performance.now() - started);
  performance.measure(`answer.${stage}`, { start: started, end: started + duration, detail: { requestId } });
  console.info("answer.lifecycle", { requestId, stage, durationMs: Math.round(duration) });
}
