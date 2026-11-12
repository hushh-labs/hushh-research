import type { MiddlewareFunction } from "@ag-ui/client";
import { filter } from "rxjs";

/** Apply the public-output policy before the SDK validates or stores reasoning. */
export function publicAgentOutput(onReasoningActivity?: (summary?: string) => void): MiddlewareFunction {
  return (input, next) => next.run(input).pipe(filter(event => {
    const type = String(event.type);
    if (!type.startsWith("REASONING_") && !type.startsWith("THINKING_")) return true;
    let approvedSummary: string | undefined;
    if (type === "REASONING_MESSAGE_CONTENT") {
      const summary = event as { delta?: unknown; metadata?: { husshThoughtSummary?: unknown } };
      if (summary.metadata?.husshThoughtSummary === true && typeof summary.delta === "string" && summary.delta) {
        approvedSummary = summary.delta.slice(0, 2048);
      }
    }
    // Preserve the content-free observation needed to discover a detached turn.
    onReasoningActivity?.(approvedSummary);
    // Older servers project summary content without reasoning open/close events.
    // It is display-only: neither it nor private reasoning belongs in SDK state.
    return false;
  }));
}
