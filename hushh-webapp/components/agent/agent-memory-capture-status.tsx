"use client";

import Link from "next/link";
import { ROUTES } from "@/lib/navigation/routes";
import {
  describeAgentPkmCapture,
  type AgentPkmCaptureStatus,
} from "@/lib/agent/agent-pkm-capture-runtime";

/** One quiet, session-only receipt next to the answer; never a second message. */
export function AgentMemoryCaptureStatus({
  status,
}: {
  status: AgentPkmCaptureStatus;
}) {
  if (status.phase === "skipped") return null;
  const running = status.phase === "preparing" || status.phase === "saving";
  return (
    <div
      className="flex min-h-11 flex-wrap items-center gap-x-2 text-xs text-muted-foreground"
      data-testid="memory-capture-status"
    >
      <span role="status">{describeAgentPkmCapture(status)}</span>
      {!running ? (
        <Link
          href={ROUTES.PKM_RECENT}
          className="inline-flex min-h-11 cursor-pointer items-center text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          View Memory
        </Link>
      ) : null}
    </div>
  );
}
