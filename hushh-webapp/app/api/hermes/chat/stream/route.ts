import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { resolveHermesBridgeConfig } from "@/lib/hermes/bridge-config";
import { boundedAgentEvents } from "@/lib/services/agent-event-boundary";
import { parseSSEBlocks } from "@/lib/streaming/sse-parser";

/**
 * Project a local Puppy turn into the common native chat stream.
 * The loopback credential and Hermes provider details stay server-side.
 */

const encoder = new TextEncoder();

function frame(event: string, payload: Record<string, unknown>): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`;
}

function session(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : "";
}

export async function POST(request: NextRequest) {
  const config = resolveHermesBridgeConfig();
  if (!config) {
    return new Response(
      frame("error", { code: "PUPPY_NOT_CONFIGURED" }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const sessionId = session(body?.sessionId);
  const onDevice = body?.onDevice === true;
  if (!message || (body?.sessionId && !sessionId)) {
    return new Response(frame("error", { code: "AGENT_ERROR" }), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  const upstreamBody: Record<string, unknown> = { message };
  // Pin generation to the loopback local provider so the turn is answered on
  // this machine and nothing reaches a model vendor.
  if (onDevice) upstreamBody.provider = "lmstudio";

  // Hermes's local session-stream contract interrupts on disconnect. Keep the
  // upstream lifetime attached to this reader, including Stop before admission.
  // Remote pod turns use their separate durable turn/cancellation authority.
  const lifetime = new AbortController();
  let closed = false;
  let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const detach = () => {
    if (!closed) { closed = true; downstream?.close(); }
    lifetime.abort();
  };
  request.signal.addEventListener("abort", detach, { once: true });
  if (request.signal.aborted) detach();
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      closed = true; // The consumer has already closed the downstream stream.
      detach();
      request.signal.removeEventListener("abort", detach);
    },
    async start(controller) {
      downstream = controller;
      if (closed) {
        controller.close();
        request.signal.removeEventListener("abort", detach);
        return;
      }
      const messageId = `msg_${crypto.randomUUID()}`;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const send = (event: string, payload: Record<string, unknown>) => {
        if (!closed) controller.enqueue(encoder.encode(frame(event, payload)));
      };
      const fail = (code: string) => {
        send("error", { code });
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      let activeSession = sessionId;
      try {
        lifetime.signal.throwIfAborted();
        if (!activeSession) {
          const created = await fetch(`${config.baseUrl}/api/sessions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
            signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]),
          });
          if (created.ok) {
            const payload = (await created.json().catch(() => ({}))) as {
              session_id?: unknown;
              id?: unknown;
              session?: { id?: unknown };
            };
            // Hermes returns {"object":"hermes.session","session":{"id":...}};
            // the flatter shapes are accepted so a future response format does
            // not silently break session continuity.
            activeSession = session(
              payload.session_id ?? payload.id ?? payload.session?.id,
            );
          }
        }
        if (!activeSession) {
          fail("PUPPY_SESSION_UNAVAILABLE");
          return;
        }

        const upstream = await fetch(
          `${config.baseUrl}/api/sessions/${encodeURIComponent(activeSession)}/chat/stream`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify(upstreamBody),
            signal: lifetime.signal,
          },
        );
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel().catch(() => undefined);
          fail(upstream.status === 401 ? "PUPPY_KEY_REFUSED" : "PUPPY_UNAVAILABLE");
          return;
        }

        send("start", { sessionId: activeSession });

        reader = upstream.body.pipeThrough(boundedAgentEvents()).getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let remainder = "";
        let finished = false;

        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          const parsed = parseSSEBlocks(decoder.decode(value, { stream: true }), remainder);
          remainder = parsed.remainder;
          for (const { event, data: rawData } of parsed.events) {
            switch (event) {
              case "assistant.delta": {
                const data = JSON.parse(rawData) as Record<string, unknown> | null;
                if (typeof data?.delta === "string" && data.delta) {
                  send("", { id: messageId, author: "one", partial: true,
                    content: { parts: [{ text: data.delta }] } });
                }
                break;
              }
              case "tool.started": {
                const data = JSON.parse(rawData) as Record<string, unknown> | null;
                if (typeof data?.tool_name === "string" && /^[A-Za-z0-9_. -]{1,80}$/.test(data.tool_name)) {
                  send("activity", { label: data.tool_name });
                }
                break;
              }
              case "error":
                // Never forward upstream error text: it can carry paths and
                // request detail the browser has no business seeing.
                fail("AGENT_ERROR");
                finished = true;
                break;
              case "done":
                finished = true;
                break;
              default:
                break;
            }
            if (finished) break;
          }
        }

        if (!closed && finished) {
          send("done", {});
          closed = true;
          controller.close();
        } else if (!closed) {
          fail("AGENT_ERROR");
        }
      } catch {
        if (!lifetime.signal.aborted) fail("PUPPY_UNAVAILABLE");
      } finally {
        request.signal.removeEventListener("abort", detach);
        if (reader) {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Proxies buffer SSE by default, which would batch every token into one
      // burst and defeat the point of streaming.
      "X-Accel-Buffering": "no",
    },
  });
}
