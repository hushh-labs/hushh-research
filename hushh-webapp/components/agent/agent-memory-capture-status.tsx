"use client";

import Link from "next/link";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import { AgentMemorySaveCard } from "@/components/agent/agent-memory-save-card";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/navigation/routes";
import {
  describeAgentPkmCapture,
  isAgentPkmCaptureRunning,
  type AgentPkmCaptureStatus,
} from "@/lib/agent/agent-pkm-capture-runtime";

/**
 * One quiet, session-only receipt next to the answer; never a second message.
 * An explicit save that finished shows its receipt card; everything else is
 * one status line that always resolves (see the capture job's deadline).
 */
export function AgentMemoryCaptureStatus({
  status,
  onConfirmNeedsOwner,
  onUnlock,
  pendingCards,
}: {
  status: AgentPkmCaptureStatus;
  onConfirmNeedsOwner?: () => Promise<void>;
  onUnlock?: () => void;
  pendingCards?: readonly AgentPkmPreviewCard[];
}) {
  if (status.phase === "skipped" && !status.receipt) return null;
  const running = isAgentPkmCaptureRunning(status);
  if (status.receipt && !running && status.phase !== "canceled") {
    return (
      <AgentMemorySaveCard
        receipt={status.receipt}
        memoryHref={ROUTES.PKM_RECENT}
        renderLink={({ href, className, children }) => (
          <Link href={href} className={className}>{children}</Link>
        )}
        onConfirmNeedsOwner={onConfirmNeedsOwner}
        pendingCards={pendingCards}
      />
    );
  }
  return (
    <div
      className="flex min-h-11 flex-wrap items-center gap-x-2 text-xs text-muted-foreground"
      data-testid="memory-capture-status"
    >
      <span role="status">{describeAgentPkmCapture(status)}</span>
      {status.phase === "needs_unlock" && onUnlock ? (
        <Button size="compact" variant="ghost" onClick={onUnlock}>
          Unlock vault
        </Button>
      ) : null}
      {!running && status.phase !== "needs_unlock" ? (
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
