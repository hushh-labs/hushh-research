import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { resolveHermesBridgeConfig } from "@/lib/hermes/bridge-config";

/**
 * Stream one Puppy One turn as AG-UI frames.
 *
 * Hermes speaks its own named SSE vocabulary (`assistant.delta`,
 * `tool.started`, ...). The One app speaks AG-UI, and hand-rolled SSE parsing
 * in the client is forbidden by contract. So the translation happens here, on
 * the server: Hermes frames in, AG-UI frames out, which lets the Puppy One
 * panel reuse the same HttpAgent, activity renderer and delta batching as the
 * cloud agent instead of growing a second streaming stack.
 *
 * The loopback bearer key stays on this side and never reaches the browser.
 */

const encoder = new TextEncoder();

function agui(frame: Record<string, unknown>): Uint8Array {
  // AG-UI frames are unnamed SSE events; the discriminator is the JSON `type`.
  return encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
}

/** Parse one SSE block into its event name and JSON data. */
function parseBlock(block: string): { event: string; data: Record<string, unknown> } | null {
  let event = "";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!event && dataLines.length === 0) return null;
  let data: Record<string, unknown> = {};
  if (dataLines.length) {
    try {
      data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    } catch {
      data = {};
    }
  }
  return { event, data };
}

export async function POST(request: NextRequest) {
  const config = resolveHermesBridgeConfig();
  if (!config) {
    // Not-configured is an ordinary state, so answer on the same SSE contract
    // the client already understands rather than an out-of-band error shape.
    return new Response(
      `data: ${JSON.stringify({
        type: "RUN_ERROR",
        message:
          "Set HERMES_API_SERVER_KEY to talk to Puppy One on this machine.",
      })}\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  // Accept AG-UI's RunAgentInput (a messages array) as well as the simpler
  // {message} shape, so the panel can drive this with a stock HttpAgent while
  // the route stays callable directly for tests and probes.
  const messages = Array.isArray(body.messages)
    ? (body.messages as Array<{ role?: string; content?: unknown }>)
    : [];
  const lastUser = [...messages]
    .reverse()
    .find((entry) => entry?.role === "user");
  const message = String(
    (lastUser?.content ?? body.message ?? "") as string,
  ).trim();
  const forwarded = (body.forwardedProps ?? {}) as Record<string, unknown>;
  const sessionId = String(body.sessionId ?? forwarded.sessionId ?? "").trim();
  const onDevice = Boolean(body.onDevice ?? forwarded.onDevice);
  const threadId = String(body.threadId || "") || crypto.randomUUID();

  const upstreamBody: Record<string, unknown> = { message };
  // Pin generation to the loopback local provider so the turn is answered on
  // this machine and nothing reaches a model vendor.
  if (onDevice) upstreamBody.provider = "lmstudio";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const messageId = `msg_${crypto.randomUUID()}`;
      let closed = false;
      const send = (frame: Record<string, unknown>) => {
        if (!closed) controller.enqueue(agui(frame));
      };
      const fail = (msg: string) => {
        send({ type: "RUN_ERROR", message: msg });
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      let activeSession = sessionId;
      try {
        if (!activeSession) {
          const created = await fetch(`${config.baseUrl}/api/sessions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(15_000),
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
            activeSession = String(
              payload.session_id ?? payload.id ?? payload.session?.id ?? "",
            );
          }
        }
        if (!activeSession) {
          fail("Puppy One could not open a session on this machine.");
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
          },
        );
        if (!upstream.ok || !upstream.body) {
          fail(
            upstream.status === 401
              ? "Puppy One rejected the local key."
              : "Puppy One could not start that turn.",
          );
          return;
        }

        send({ type: "RUN_STARTED", threadId, runId: activeSession });
        send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finished = false;

        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE blocks are separated by a blank line. Keep the trailing
          // partial block in the buffer until its terminator arrives.
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const parsed = parseBlock(block);
            if (!parsed) continue;
            const { event, data } = parsed;
            switch (event) {
              case "assistant.delta":
                send({
                  type: "TEXT_MESSAGE_CONTENT",
                  messageId,
                  delta: String(data.delta ?? ""),
                });
                break;
              case "tool.progress":
                send({
                  type: "REASONING_MESSAGE_CONTENT",
                  messageId,
                  delta: String(data.delta ?? ""),
                });
                break;
              case "tool.started":
                send({
                  type: "TOOL_CALL_START",
                  toolCallId: String(data.tool_name ?? "tool"),
                  toolCallName: String(data.tool_name ?? "tool"),
                  parentMessageId: messageId,
                });
                break;
              case "tool.completed":
              case "tool.failed":
                send({
                  type: "TOOL_CALL_END",
                  toolCallId: String(data.tool_name ?? "tool"),
                });
                send({
                  type: "TOOL_CALL_RESULT",
                  toolCallId: String(data.tool_name ?? "tool"),
                  messageId,
                  content: event === "tool.failed" ? "failed" : "done",
                });
                break;
              case "error":
                // Never forward upstream error text: it can carry paths and
                // request detail the browser has no business seeing.
                fail("Puppy One could not complete that response.");
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

        if (!closed) {
          send({ type: "TEXT_MESSAGE_END", messageId });
          send({ type: "RUN_FINISHED", threadId, runId: activeSession });
          closed = true;
          controller.close();
        }
      } catch {
        fail("Puppy One is not answering on this machine.");
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
