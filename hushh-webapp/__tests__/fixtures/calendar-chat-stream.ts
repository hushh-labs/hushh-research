import result from "../../../consent-protocol/tests/fixtures/calendar/chat_proposal_result.json";

export function calendarChatStream(delivery: "tool" | "state", toolResult: unknown = result) {
  const events: unknown[] = [{ type: "RUN_STARTED", threadId: "same-conversation", runId: "run-calendar" }];
  if (delivery === "tool") events.push(
    { type: "TOOL_CALL_START", toolCallId: "call-calendar", toolCallName: "propose_calendar_event" },
    { type: "TOOL_CALL_ARGS", toolCallId: "call-calendar", delta: "{}" },
    { type: "TOOL_CALL_END", toolCallId: "call-calendar" },
    { type: "TOOL_CALL_RESULT", messageId: "result-calendar", toolCallId: "call-calendar", role: "tool", content: JSON.stringify(toolResult) },
  );
  else events.push({ type: "STATE_DELTA", delta: [{ op: "add", path: "/hussh:pending_directive:calendar", value: (toolResult as typeof result).directive }] });
  events.push({ type: "RUN_FINISHED", threadId: "same-conversation", runId: "run-calendar" });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
