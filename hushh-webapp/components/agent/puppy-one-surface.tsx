"use client";

import { useEffect, useState } from "react";
import { HermesChatPanel } from "@/components/agent/hermes-chat-panel";
import { PrivatePuppyInferencePanel } from "@/components/agent/private-puppy-inference-panel";
import { PuppyMachineSheet } from "@/components/agent/puppy-resource-monitor";
import { usePuppyLink } from "@/lib/hermes/use-puppy-link";
import { isLocalHost } from "@/lib/hermes/local-host";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { AgentChatConversation } from "@/lib/services/agent-chat-client";

/**
 * Puppy One as a mode of the Agent Chat workspace.
 *
 * It brings its OWN transcript. Puppy One turns are never appended to One's
 * messages and never reach One's conversation history, because a transcript
 * that mixed them would no longer be able to say where any given answer was
 * generated, and where the answer was generated is the entire claim this
 * tier makes. `docs/reference/ai/puppy-one-on-device.md` records that as an
 * invariant; it is held structurally here, by the two agents keeping separate
 * state, rather than by a rule someone has to remember.
 *
 * The machine's readings sit above the conversation, as a control rather than
 * a block: the owner asks for them, and the answer opens in a sheet. What the
 * control cannot swallow is a broken link to Hussh One, which stays on the
 * strip whether or not anything is open, see `PuppyMachineSheet`.
 */
export function PuppyOneSurface({
  className,
  active = true,
  conversations,
  activeConversationId,
  onCreateConversation,
}: {
  className?: string;
  conversations?: AgentChatConversation[];
  activeConversationId?: string | null;
  onCreateConversation?: () => void;
  /**
   * Whether this surface is the one on screen. The workspace keeps it mounted
   * and hidden so a slow local answer survives a glance at One, so `active`
   * is what stops a hidden surface polling forever and what closes the machine
   * panel: that panel is a Radix portal on document.body, and `hidden` on this
   * root does nothing to it, so without this it would float over One's
   * transcript under a header that says "One".
   */
  active?: boolean;
}) {
  const link = usePuppyLink();
  // A deployed frontend's loopback is its Cloud Run container, never the
  // owner's Mac. Resolve after hydration so server and client render agree.
  const [localBridge, setLocalBridge] = useState<boolean | null>(null);
  useEffect(() => setLocalBridge(isLocalHost()), []);
  const panel = (activePanel: boolean, panelClassName?: string) =>
    localBridge === null ? null : localBridge ? (
      <HermesChatPanel active={activePanel} className={panelClassName} />
    ) : (
      <PrivatePuppyInferencePanel className={panelClassName} />
    );
  return (
    <div
      className={cn(
        // The bottom padding is One's composer clearance, not a fixed gap. On
        // root Chat the bottom navigation is `position: fixed` over this
        // column and `--agent-chat-composer-bottom` carries its height (and
        // the keyboard inset on native), so a bare `pb-3` put Puppy's composer
        // underneath the navigation. The fallback covers a mount outside the
        // workspace, where the variable is not defined.
        "flex min-h-0 flex-1 flex-col overflow-hidden px-4 pt-5 sm:px-6",
        "pb-[var(--agent-chat-composer-bottom,0.75rem)] focus-within:pb-[var(--agent-chat-composer-focused-bottom,0.75rem)]",
        className,
      )}
      data-agent-surface="puppy"
    >
      {/* The measure lives on an INNER wrapper, because One puts its gutters
          outside the 896px column and merging `max-w-4xl` onto the padded
          outer div would leave Puppy 48px narrower than One at the same
          viewport. The wrapper repeats the flex chain on purpose: an inert
          wrapper here would let the chat panel's flex-1 basis collapse. */}
      <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-3">
        {/* Said once, and only to someone with no machine yet. The workspace
            header cannot carry it (its subtitle is hidden below sm, and the
            unlinked empty state below names an install without ever saying
            what the thing is). `/one/puppy` already says this in its own page
            header, so the claim still appears exactly once per screen. */}
        {link?.state === "unlinked" ? (
          <p className="shrink-0 text-xs text-muted-foreground">
            A personal supercomputer you own. Pin a model to this machine and
            answers never leave it.
          </p>
        ) : null}
        {localBridge ? <PuppyMachineSheet className="shrink-0" active={active} /> : null}
        {/* No card frame: One's transcript sits directly on the workspace
            surface, and a bordered box here read as a widget inside the page
            rather than the conversation itself. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {conversations === undefined ? panel(active) : (
            <>
              {conversations.length === 0 ? (
                <div className="flex flex-1 items-center justify-center p-4">
                  <Button onClick={onCreateConversation}>Start a Puppy chat</Button>
                </div>
              ) : null}
              {conversations.map((conversation) => localBridge === null ? null : localBridge ? (
                <HermesChatPanel
                  key={conversation.id}
                  active={active && activeConversationId === conversation.id}
                  className={cn(activeConversationId !== conversation.id && "hidden")}
                />
              ) : (
                <PrivatePuppyInferencePanel
                  key={conversation.id}
                  className={cn(activeConversationId !== conversation.id && "hidden")}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
