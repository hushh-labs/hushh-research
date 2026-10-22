"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { HermesChatPanel } from "@/components/agent/hermes-chat-panel";
import { PrivatePuppyInferencePanel } from "@/components/agent/private-puppy-inference-panel";
import { CHAT_WELCOME_COPY_CLASSNAME } from "@/components/agent/chat-message-styles";
import { PuppyMachineSheet } from "@/components/agent/puppy-resource-monitor";
import { usePuppyLink } from "@/lib/hermes/use-puppy-link";
import { isLocalHost } from "@/lib/hermes/local-host";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { AgentChatConversation } from "@/lib/services/agent-chat-client";
import { AgentDockPortal } from "@/components/agent/agent-dock";
import { useAuth } from "@/lib/firebase";
import { AuthService } from "@/lib/services/auth-service";
import { ApiService } from "@/lib/services/api-service";
import type { PersonalAgentStatus } from "@/lib/services/personal-agent-status";
import { ROUTES } from "@/lib/navigation/routes";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";

type PuppySurfaceProps = {
  className?: string;
  conversations?: AgentChatConversation[];
  activeConversationId?: string | null;
  onCreateConversation?: () => void;
  /** Retain the transcript while hidden; close portals and pause readings. */
  active?: boolean;
  sharedDock?: boolean;
  composerDisabled?: boolean;
};

/** Placement is checked before either the local bridge or remote relay mounts. */
export function PuppyOneSurface(props: PuppySurfaceProps) {
  const { user } = useAuth();
  // A different owner must never inherit a retained transcript or placement read.
  const generation = snapshotValidatedAuthSessionOwner()?.generation;
  return <PuppyPlacement key={`${user?.uid ?? "signed-out"}:${generation}`} {...props} ownerId={user?.uid} />;
}

function PuppyPlacement({ ownerId, ...props }: PuppySurfaceProps & { ownerId?: string }) {
  const active = props.active ?? true;
  const [status, setStatus] = useState<PersonalAgentStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active || !ownerId) return;
    const owner = snapshotValidatedAuthSessionOwner();
    if (owner?.userId !== ownerId) return;
    const request = new AbortController();
    setChecking(true);
    setFailed(false);
    const current = () => !request.signal.aborted && AuthService.getCurrentUser()?.uid === ownerId &&
      isValidatedAuthSessionOwnerCurrent(owner);
    void ApiService.getPersonalAgentStatus({ signal: request.signal })
      .then((value) => { if (current()) setStatus(value); })
      .catch(() => { if (current()) setFailed(true); })
      .finally(() => { if (current()) setChecking(false); });
    return () => request.abort();
  }, [active, ownerId, attempt]);

  if (status?.hostingMode === "byoc" && status.hushhId) {
    // A transient status read must not destroy an in-flight reply. Send-time
    // admission remains authoritative; stale observations disable new input.
    return <>
      {failed && active && <div className="flex flex-wrap items-center justify-center gap-2 px-4 text-sm">
        <p role="status">Couldn’t check your agent.</p>
        <Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>Try again</Button>
      </div>}
      <PuppyChatSurface key={status.hushhId} {...props}
        composerDisabled={props.composerDisabled || checking || failed} />
    </>;
  }
  const message = !ownerId ? "Sign in to connect Puppy."
    : checking ? "Checking your agent…"
    : failed ? "Couldn’t check your agent."
    : status?.hostingMode === "shared" ? "Puppy needs your own cloud."
    : status?.hostingMode === "pending" ? "Finish setting up your private agent to connect Puppy."
    : "Set up your own cloud to connect Puppy.";
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-4 text-center", props.className)}
      inert={!active} data-agent-surface="puppy">
      <AgentDockPortal enabled={Boolean(props.sharedDock && active)} visible={false} suppressed>{null}</AgentDockPortal>
      <p className="text-sm text-muted-foreground" role="status">{message}</p>
      {ownerId && !checking && (failed
        ? <Button variant="outline" onClick={() => setAttempt(value => value + 1)}>Try again</Button>
        : <Button variant="outline" asChild><Link href={ROUTES.PROFILE_HOSTING}>Hosting</Link></Button>)}
    </div>
  );
}

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
function PuppyChatSurface({
  className,
  active = true,
  sharedDock = false,
  composerDisabled = false,
  conversations,
  activeConversationId,
  onCreateConversation,
}: PuppySurfaceProps) {
  const link = usePuppyLink();
  // A deployed frontend's loopback is its Cloud Run container, never the
  // owner's Mac. Resolve after hydration so server and client render agree.
  const [localBridge, setLocalBridge] = useState<boolean | null>(null);
  useEffect(() => setLocalBridge(isLocalHost()), []);
  // On a deployed origin the readings control shares the chat's header row,
  // so the chat opens on one quiet line instead of two stacked strips.
  const sheet = <PuppyMachineSheet ribbon active={active && !composerDisabled} />;
  const panel = (activePanel: boolean, panelClassName?: string) =>
    localBridge === null ? null : localBridge ? (
      <HermesChatPanel active={activePanel} sharedDock={sharedDock} composerDisabled={composerDisabled || !activePanel} accessory={sheet} className={panelClassName} />
    ) : (
      <PrivatePuppyInferencePanel className={panelClassName} accessory={sheet} composerDisabled={composerDisabled || !activePanel} />
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
        "flex min-h-0 flex-1 flex-col overflow-hidden pt-0",
        localBridge ? "px-4 sm:px-6" : "px-3 sm:px-5",
        "pb-[var(--agent-chat-composer-bottom,0.75rem)] focus-within:pb-[var(--agent-chat-composer-focused-bottom,0.75rem)]",
        className,
      )}
      inert={!active}
      data-agent-surface="puppy"
    >
      {/* The measure lives on an INNER wrapper, because One puts its gutters
          outside the 768px column and merging the measure onto the padded
          outer div would leave Puppy narrower than One at the same
          viewport. The wrapper repeats the flex chain on purpose: an inert
          wrapper here would let the chat panel's flex-1 basis collapse. */}
      <div className={cn("mx-auto flex min-h-0 w-full flex-1 flex-col gap-3",
        localBridge ? "max-w-3xl" : "max-w-[var(--app-bottom-shell-max-width)]")}>
        {/* Said once, and only to someone with no machine yet. The workspace
            header cannot carry it (its subtitle is hidden below sm, and the
            unlinked empty state below names an install without ever saying
            what the thing is). `/one/puppy` already says this in its own page
            header, so the claim still appears exactly once per screen. */}
        {link?.state === "unlinked" ? (
          <p className={cn("shrink-0", CHAT_WELCOME_COPY_CLASSNAME)}>
            A local model on your trusted machine. Requests and replies travel
            through your private pod.
          </p>
        ) : null}
        {/* No card frame: One's transcript sits directly on the workspace
            surface, and a bordered box here read as a widget inside the page
            rather than the conversation itself. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Remote Puppy retains its own admitted-pod composer. Suppress the
              shared cloud launcher; local Hermes may claim the retained dock. */}
          <AgentDockPortal
            enabled={sharedDock}
            active={active && (localBridge !== true || (conversations !== undefined && !conversations.some(conversation => conversation.id === activeConversationId)))}
            visible={false} suppressed
          >{null}</AgentDockPortal>
          {conversations === undefined ? panel(active) : (
            <>
              {conversations.length === 0 ? (
                <div className="flex flex-1 items-center justify-center p-4">
                  <Button disabled={composerDisabled || !active} onClick={onCreateConversation}>Start a Puppy chat</Button>
                </div>
              ) : null}
              {conversations.map((conversation) => localBridge === null ? null : localBridge ? (
                <HermesChatPanel
                  key={conversation.id}
                  active={active && activeConversationId === conversation.id}
                  sharedDock={sharedDock}
                  composerDisabled={composerDisabled || !active || activeConversationId !== conversation.id}
                  accessory={activeConversationId === conversation.id ? sheet : undefined}
                  className={cn(activeConversationId !== conversation.id && "hidden")}
                />
              ) : (
                <PrivatePuppyInferencePanel
                  key={conversation.id}
                  conversationId={conversation.id}
                  composerDisabled={composerDisabled || !active || activeConversationId !== conversation.id}
                  accessory={activeConversationId === conversation.id ? sheet : undefined}
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
