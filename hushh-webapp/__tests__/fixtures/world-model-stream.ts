import type { PwmProgress } from "@/lib/services/world-model-research-service";

export const progress = (searches: number): PwmProgress => ({
  stage: "coverage",
  searches_used: searches,
  searches_total: 32,
  model_calls_used: searches * 2,
  model_calls_total: 128,
  topics_checked: ["career"],
  sources_found: searches,
  recent_sources: [{ title: "Public page", url: "https://example.test/p" }],
  identity_state: "owner_linked",
  candidates: 1,
  started_at: "2026-10-15T00:00:00Z",
  last_activity_at: "2026-10-15T00:01:00Z",
  slice: 1,
});
export const validatedFact = {
  id: "candidate-a:career:fact-1",
  topic: "career",
  statement: "Works at Acme Corp",
  confidence: "supported",
  sources: [{ title: "Acme team page", url: "https://acme.example/team" }],
  identity_state: "owner_linked",
};
export const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
/** A live response whose frames arrive in the given pieces. */
export const eventStream = (...pieces: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces)
          controller.enqueue(new TextEncoder().encode(piece));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
