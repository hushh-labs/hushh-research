"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Laptop, Send, StopSquare } from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";

import { useAuth } from "@/lib/firebase";
import { useVault } from "@/lib/vault/vault-context";
import { usePuppyLink } from "@/lib/hermes/use-puppy-link";
import { ApiService } from "@/lib/services/api-service";
import { PodMemoryConsentRow } from "@/components/agent/pod-memory-consent-row";
import { PuppyChatMessage } from "@/components/agent/puppy-chat-message";
import { PuppyRemoteModelPicker, type PuppyMachineState } from "@/components/agent/puppy-remote-model-picker";
import { puppyMachineNoun } from "@/lib/agent/puppy-turn-copy";
import { usePuppyTurn, type PuppyChatModel, type PuppyChatTurn } from "@/lib/agent/use-puppy-turn";
import { podMemoryConsentPhrase, usePodMemoryConsentWord } from "@/lib/agent/use-pod-memory-consent-word";
import { pendingRevocations, type PendingRevocation } from "@/lib/services/owner-pod-endpoint";
import { cn } from "@/lib/utils";

const SUGGESTIONS = ["What do you remember about me?", "Help me plan my day", "Draft a short thank-you note"];

/** Revocations the pod has not received yet, read from the owner-pod store. */
function usePendingRevocations(uid: string | undefined, linkKey: string) {
  const [pending, setPending] = useState<PendingRevocation[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!uid) { setPending([]); return; }
    void pendingRevocations(uid)
      .then((items) => { if (!cancelled) setPending(items); })
      .catch(() => { if (!cancelled) setPending([]); });
    return () => { cancelled = true; };
  }, [uid, linkKey]);
  return pending;
}

/** The owner's active agent id, for the model list and the memory control. */
function useActiveAgentId(uid: string | undefined) {
  const [hushhId, setHushhId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!uid) { setHushhId(null); return; }
    void ApiService.getPersonalAgentStatus()
      .then((status) => { if (!cancelled) setHushhId(status.state === "active" && status.hushhId ? status.hushhId : null); })
      .catch(() => { if (!cancelled) setHushhId(null); });
    return () => { cancelled = true; };
  }, [uid]);
  return hushhId;
}

/** How close to the bottom still counts as "following along". */
const PINNED_SLACK_PX = 48;

function scrollToBottom(node: HTMLDivElement | null) {
  if (node) node.scrollTop = node.scrollHeight;
}

/**
 * Keep the newest words in view while the owner is reading along, and leave
 * them alone once they scroll up to reread. A new question always jumps down.
 */
function useFollowBottom(turns: PuppyChatTurn[], stage: string) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const lastTurn = turns[turns.length - 1];
  // Keyed on the newest question, not the count: a retry swaps one exchange
  // for another without changing the length and must still come into view.
  const newestQuestion = lastQuestionId(turns);
  useEffect(() => {
    pinned.current = true;
    scrollToBottom(scroller.current);
  }, [newestQuestion]);
  useEffect(() => {
    if (pinned.current) scrollToBottom(scroller.current);
  }, [lastTurn?.text, lastTurn?.thinking, stage]);
  const onScroll = () => {
    const node = scroller.current;
    if (node) pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= PINNED_SLACK_PX;
  };
  return { scroller, onScroll };
}

/** Only the newest question may be asked again, so a retry never reorders the chat. */
function lastQuestionId(turns: PuppyChatTurn[]): string | null {
  return turns.findLast((turn) => turn.role === "user")?.id ?? null;
}

function PuppyGreeting({ machine, onPick }: { machine: string; onPick: (prompt: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-8 text-center" data-testid="puppy-greeting">
      <Laptop className="size-8 text-[color:var(--app-accent)]" aria-hidden />
      <div className="space-y-1">
        <p className="text-base font-semibold">Hi, I&apos;m Puppy One</p>
        <p className="max-w-sm text-sm leading-6 text-muted-foreground">
          I answer with the model on {machine}. Your agent keeps your tools and what you&apos;ve shared.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((prompt) => (
          <button key={prompt} type="button" onClick={() => onPick(prompt)}
            className="min-h-8 rounded-full bg-foreground/[0.04] px-3 text-xs text-foreground transition-colors hover:bg-foreground/[0.08]">
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

function PuppyComposer({ busy, stopping, onSend, onStop }: {
  busy: boolean;
  stopping: boolean;
  onSend: (message: string) => void;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    if (busy || !draft.trim()) return;
    onSend(draft);
    setDraft("");
  };
  return (
    <div className="shrink-0 px-0 pt-3">
      <div data-testid="puppy-chat-composer" className="bottom-chrome-surface flex min-h-[3.75rem] items-center gap-2 rounded-[var(--app-input-radius)] px-2.5 pl-3.5">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
          }}
          rows={1}
          placeholder="Message Puppy One"
          aria-label="Message Puppy One"
          className="h-auto max-h-28 min-h-0 min-w-0 flex-1 resize-none overscroll-contain overflow-y-auto border-0 bg-transparent px-0 py-3 text-[15px] leading-snug text-foreground caret-[color:var(--app-accent)] outline-none placeholder:text-muted-foreground/70 sm:max-h-36 sm:text-sm"
        />
        {busy ? (
          <ShellActionSurface type="button" onClick={onStop} disabled={stopping} aria-label="Stop" title="Stop"
            className="border-transparent bg-foreground/[0.08] text-foreground hover:bg-foreground/[0.12]">
            <StopSquare className="size-3.5" aria-hidden />
          </ShellActionSurface>
        ) : (
          <ShellActionSurface type="button" onClick={submit} disabled={!draft.trim()} aria-label="Send to Puppy One" title="Send"
            className="border-transparent bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]">
            <Send className="size-4" aria-hidden />
          </ShellActionSurface>
        )}
      </div>
    </div>
  );
}

/**
 * Puppy One's chat. The pod path is fixed (app -> owner pod -> Puppy relay ->
 * the model on the owner's machine); One keeps orchestration, consent and
 * tools. Machine, model and memory details live behind one header chip so
 * the conversation, not its settings, fills the screen.
 */
export function PrivatePuppyInferencePanel({
  className,
  conversationId = "puppy-private-relay",
  accessory,
}: {
  className?: string;
  conversationId?: string;
  /** A control that shares the header row, such as the machine readings sheet. */
  accessory?: ReactNode;
}) {
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const link = usePuppyLink();
  const [chatModel, setChatModel] = useState<PuppyChatModel>(null);
  const machine = puppyMachineNoun(link?.device?.name);
  const { turns, busy, stage, elapsedSeconds, send, stop } = usePuppyTurn({ conversationId, chatModel, machine });
  const hushhId = useActiveAgentId(user?.uid);
  const pending = usePendingRevocations(user?.uid, `${link?.state ?? ""}:${link?.device?.id ?? ""}`);
  const pendingForDevice = pending.filter((item) => !link?.device?.id || item.subjectId === link.device.id);
  const machineState: PuppyMachineState = link?.state === "live" || link?.state === "quiet" ? link.state : "unavailable";
  const { scroller, onScroll } = useFollowBottom(turns, stage);
  const retryableId = busy ? null : lastQuestionId(turns);
  // Re-read the memory grant each time the menu that changes it closes.
  const [menuCloses, setMenuCloses] = useState(0);
  const memoryWord = usePodMemoryConsentWord(hushhId, menuCloses);

  return (
    // One's chat tokens (bubble greys) apply here too, also on /one/puppy,
    // which sits outside the workspace that normally scopes them.
    <div data-one-chat-surface className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex min-h-10 items-center gap-2">
        <PuppyRemoteModelPicker
          hushhId={hushhId}
          deviceId={link?.device?.id ?? null}
          vaultOwnerToken={vaultOwnerToken ?? null}
          chatModel={chatModel?.model ?? null}
          busy={busy}
          hasTurns={turns.length > 0}
          machineState={machineState}
          machine={machine}
          lastKnownModel={link?.device?.heartbeat?.current_model ?? null}
          onChatModel={(model, catalogVersion) => setChatModel({ model, catalogVersion })}
          onGlobalModel={(previousDefault, catalog) => {
            if (!turns.length) return;
            // A global change applies to future chats. This chat keeps its
            // model even if the device removed it: the next turn refuses it
            // plainly instead of silently switching models.
            const model = chatModel?.model ?? previousDefault;
            if (model) setChatModel({ model, catalogVersion: catalog.catalogVersion });
          }}
          footer={<PodMemoryConsentRow hushhId={hushhId} className="border-b-0 px-2" />}
          memoryPhrase={hushhId ? podMemoryConsentPhrase(memoryWord) : undefined}
          onOpenChange={(open) => { if (!open) setMenuCloses((count) => count + 1); }}
        />
        {accessory ? <div className="ml-auto shrink-0">{accessory}</div> : null}
      </div>
      <div ref={scroller} onScroll={onScroll} data-testid="puppy-transcript" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1 py-4">
        {turns.length === 0 ? <PuppyGreeting machine={machine} onPick={(prompt) => void send(prompt)} /> : null}
        <div className="flex flex-col gap-4">
          {turns.map((turn, index) => (
            <PuppyChatMessage
              key={turn.id}
              turn={turn}
              live={busy && index === turns.length - 1 && turn.role === "assistant"}
              stage={stage}
              elapsedSeconds={elapsedSeconds}
              machine={machine}
              onRetry={turn.failure?.retryable && turn.id === retryableId ? () => void send(turn.text, turn.id) : undefined}
            />
          ))}
        </div>
        {pendingForDevice.length > 0 ? (
          <p className="mt-4 text-xs text-muted-foreground" data-testid="puppy-revocation-pending">
            Removing this computer&apos;s access. It takes effect the next time your agent checks in.
          </p>
        ) : null}
      </div>
      <PuppyComposer busy={busy} stopping={stage === "stopping"} onSend={(message) => void send(message)} onStop={stop} />
    </div>
  );
}
