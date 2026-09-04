"use client";

import { HermesChatPanel } from "@/components/agent/hermes-chat-panel";
import { PuppyMachineSheet } from "@/components/agent/puppy-resource-monitor";
import { cn } from "@/lib/utils";

/**
 * Puppy One as a mode of the Agent Chat workspace.
 *
 * It brings its OWN transcript. Puppy One turns are never appended to One's
 * messages and never reach One's conversation history, because a transcript
 * that mixed them would no longer be able to say where any given answer was
 * generated -- and where the answer was generated is the entire claim this
 * tier makes. `docs/reference/ai/puppy-one-on-device.md` records that as an
 * invariant; it is held structurally here, by the two agents keeping separate
 * state, rather than by a rule someone has to remember.
 *
 * The machine's readings sit above the conversation, as a control rather than
 * a block: the owner asks for them, and the answer opens in a sheet. What the
 * control cannot swallow is a broken link to Hussh One, which stays on the
 * strip whether or not anything is open -- see `PuppyMachineSheet`.
 */
export function PuppyOneSurface({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 pb-3 pt-3 sm:px-6",
        className,
      )}
      data-agent-surface="puppy"
    >
      <PuppyMachineSheet className="shrink-0" />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/60 bg-background">
        <HermesChatPanel />
      </div>
    </div>
  );
}
