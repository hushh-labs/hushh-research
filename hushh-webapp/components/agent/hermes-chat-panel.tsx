"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { HttpAgent } from "@ag-ui/client";
import { Laptop, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  PuppyModelPicker,
  type ModelSelection,
} from "@/components/agent/puppy-model-picker";
import { formatRelativeTime } from "@/lib/format/relative-time";
import { isLocalHost } from "@/lib/hermes/local-host";
import { usePuppyLink } from "@/lib/hermes/use-puppy-link";
import { ROUTES } from "@/lib/navigation/routes";
import {
  PUPPY_ONE_INSTALL_URL,
  fetchPuppyStatus,
  type PuppyLink,
  type PuppyStatus,
} from "@/lib/services/puppy-one-service";
import { cn } from "@/lib/utils";

/** Per-viewer browser preference for the on-device pill ("1" or "0"). */
const ON_DEVICE_STORAGE_KEY = "hussh.puppy.on_device";

/**
 * Chat with Puppy One, the agent running on the owner's own machine.
 *
 * Streams through AG-UI rather than awaiting a whole response: the server
 * route translates Hermes's own SSE vocabulary into AG-UI frames, so this
 * panel drives a stock HttpAgent and inherits the same token-delta and
 * tool-activity semantics the cloud agent uses, instead of growing a second
 * streaming stack that would drift from it.
 *
 * The loopback key never reaches this component. It talks only to our own
 * origin; a Next route handler on this machine holds the key.
 */

interface PuppyTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  activity?: string[];
}

export function HermesChatPanel({ className }: { className?: string }) {
  const [status, setStatus] = useState<PuppyStatus | null>(null);
  const [turns, setTurns] = useState<PuppyTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // The on-device pill is a per-viewer preference, so it survives a reload:
  // a toggle that silently reset to "on-device" on every mount told the user
  // one thing and sent the turn somewhere else. Storage can be unavailable
  // (private window, blocked site data), so every access is guarded and the
  // default stays on-device.
  const [onDevice, setOnDeviceState] = useState(true);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(ON_DEVICE_STORAGE_KEY);
      if (stored === "0") setOnDeviceState(false);
    } catch {
      /* storage unavailable: keep the on-device default */
    }
  }, []);
  const setOnDevice = useCallback((update: boolean | ((value: boolean) => boolean)) => {
    setOnDeviceState((value) => {
      const next = typeof update === "function" ? update(value) : update;
      try {
        window.localStorage.setItem(ON_DEVICE_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* storage unavailable: the choice still applies to this session */
      }
      return next;
    });
  }, []);
  const [error, setError] = useState("");
  const sessionRef = useRef<string>("");
  const endRef = useRef<HTMLDivElement | null>(null);

  // One's record of the machine comes from the shared store, so this panel
  // and the strip above it change in the same moment. Deliberately NOT tied
  // to the bridge read: the loopback gateway answers in under a second and
  // the backend list can take a minute when One is slow, and awaiting both
  // together held a connected agent hostage to a hung backend.
  const link = usePuppyLink();

  const loadStatus = useCallback(async () => {
    // Through the service layer, not a raw fetch: not-running is an ordinary
    // state and every surface should render the same one.
    setStatus(await fetchPuppyStatus());
  }, []);

  useEffect(() => {
    void loadStatus();
    const timer = setInterval(() => void loadStatus(), 30_000);
    return () => clearInterval(timer);
  }, [loadStatus]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, sending]);

  const applyModel = useCallback(
    (selection: ModelSelection) => {
      // Hermes applies a model assignment to new sessions only. Keeping the
      // current session would leave the header naming one model while another
      // answered, so the session is dropped and the switch is stated in the
      // transcript rather than happening invisibly.
      sessionRef.current = "";
      setOnDevice(selection.onDevice);
      setStatus((prior) =>
        prior ? { ...prior, model: selection.model } : prior,
      );
      setTurns((prior) => [
        ...prior,
        {
          id: `sys-${Date.now()}`,
          role: "assistant",
          text: selection.onDevice
            ? `Switched to ${selection.model} on this machine. Starting a new session.`
            : `Switched to ${selection.model}. This model runs off this machine. Starting a new session.`,
        },
      ]);
    },
    [setOnDevice],
  );

  const appendDelta = useCallback((assistantId: string, delta: string) => {
    setTurns((prior) =>
      prior.map((turn) =>
        turn.id === assistantId ? { ...turn, text: turn.text + delta } : turn,
      ),
    );
  }, []);

  async function send() {
    const message = draft.trim();
    if (!message || sending) return;
    setDraft("");
    setError("");
    setSending(true);

    const assistantId = `a-${Date.now()}`;
    setTurns((prior) => [
      ...prior,
      { id: `u-${Date.now()}`, role: "user", text: message },
      { id: assistantId, role: "assistant", text: "", activity: [] },
    ]);

    try {
      const agent = new HttpAgent({
        url: "/api/hermes/chat/stream",
        initialMessages: [
          { id: crypto.randomUUID(), role: "user", content: message },
        ],
      });
      await agent.runAgent(
        { forwardedProps: { sessionId: sessionRef.current, onDevice } },
        {
          onTextMessageContentEvent: ({ event }) => {
            appendDelta(assistantId, String(event.delta ?? ""));
          },
          onToolCallStartEvent: ({ event }) => {
            const label = String(event.toolCallName ?? "tool");
            setTurns((prior) =>
              prior.map((turn) =>
                turn.id === assistantId
                  ? { ...turn, activity: [...(turn.activity ?? []), label] }
                  : turn,
              ),
            );
          },
          onRunStartedEvent: ({ event }) => {
            // Hermes uses the session id as the run id, so keeping it gives the
            // next turn continuity in the same conversation.
            const runId = String(
              (event as unknown as { runId?: string }).runId ?? "",
            );
            if (runId) sessionRef.current = runId;
          },
          onRunErrorEvent: ({ event }) => {
            setError(
              String(event.message ?? "") || "Puppy One could not answer.",
            );
          },
        },
      );
    } catch {
      setError("Puppy One is not answering on this machine.");
    } finally {
      setSending(false);
    }
  }

  const connected = status?.connected === true;
  // The bridge, when it is connected, is the stronger claim and keeps the
  // pill. Otherwise the pill says what One knows about the owner's machine.
  const pill = connected
    ? { live: true, label: status?.model ?? "connected" }
    : describeLinkPill(link);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5 text-xs">
        <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5",
            pill.live
              ? "bg-[rgba(52,199,89,0.12)] text-[#34C759]"
              : "bg-muted text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              pill.live ? "bg-current" : "bg-muted-foreground/60",
            )}
          />
          {pill.label}
        </span>
        {connected ? (
          <PuppyModelPicker onApplied={applyModel} className="ml-auto" />
        ) : null}
        {connected ? (
          <button
            type="button"
            onClick={() => setOnDevice((value) => !value)}
            aria-pressed={onDevice}
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
              onDevice
                ? "bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)]"
                : "text-muted-foreground hover:text-foreground",
            )}
            title={
              onDevice
                ? "Answers are generated on this machine."
                : "Answers may use a cloud model."
            }
          >
            {onDevice ? "on-device" : "any model"}
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!connected && status ? (
          <PuppyLinkEmptyState link={link} status={status} />
        ) : null}
        {connected && turns.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            Ask Puppy One. Its answers are generated on this machine, and this
            conversation stays separate from One.
          </p>
        ) : null}
        <div className="flex flex-col gap-3">
          {turns.map((turn) => (
            <div
              key={turn.id}
              className={cn(
                "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm",
                turn.role === "user"
                  ? "self-end bg-[color:var(--app-accent-surface)] text-foreground"
                  : "self-start bg-muted/60",
              )}
            >
              {turn.activity && turn.activity.length > 0 ? (
                <p className="mb-1.5 text-[11px] text-muted-foreground">
                  {turn.activity.join(" · ")}
                </p>
              ) : null}
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {turn.text}
              </p>
              {turn.role === "assistant" && sending && !turn.text ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : null}
            </div>
          ))}
        </div>
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        <div ref={endRef} />
      </div>

      <div className="flex items-end gap-2 border-t border-border/60 px-4 py-3">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          disabled={!connected || sending}
          rows={1}
          placeholder={connected ? "Ask Puppy One…" : composerPlaceholder(link)}
          className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-xl border border-border/70 bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
        />
        <Button
          type="button"
          size="icon"
          onClick={() => void send()}
          disabled={!connected || sending || !draft.trim()}
          aria-label="Send to Puppy One"
        >
          <Send className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * What the disabled composer says when the bridge is not the one answering.
 *
 * It must agree with the pill and the empty state above it. The old fixed
 * "Puppy One is not connected" sat under a green "connected · {device}" pill,
 * which is the one contradiction this surface exists to avoid.
 */
function composerPlaceholder(link: PuppyLink | null): string {
  if (link?.state === "live" && link.device) {
    return `Chat with Puppy One from ${link.device.name}`;
  }
  if (link?.state === "quiet" && link.device) {
    return link.device.lastHeartbeatAt === null
      ? `Puppy One on ${link.device.name} has not reported yet`
      : "Puppy One is asleep or offline";
  }
  if (link?.state === "unlinked" || link?.state === "revoked") {
    return "Connect Puppy One to start";
  }
  return "Puppy One is not connected";
}

/** "seen 3 minutes ago", or null when the device has never reported. */
function seenRelative(link: PuppyLink): string | null {
  const at = link.device?.lastHeartbeatAt ?? null;
  if (at === null) return null;
  return formatRelativeTime(at, Date.now()) || null;
}

/**
 * The header pill when the bridge is not the one answering.
 *
 * Green means "a machine is reporting to One right now" and nothing weaker:
 * a quiet device and an unknown link share the muted form, so the colour
 * that promises a live agent is never spent on a guess.
 */
function describeLinkPill(link: PuppyLink | null): {
  live: boolean;
  label: string;
} {
  if (link?.state === "live" && link.device) {
    return { live: true, label: `connected · ${link.device.name}` };
  }
  if (link?.state === "quiet") {
    const seen = seenRelative(link);
    if (seen) return { live: false, label: `last seen ${seen}` };
  }
  return { live: false, label: "not connected" };
}

/**
 * What a person sees when the bridge on THIS server is not connected.
 *
 * Driven by One's own record of the owner's machine, because that is the fact
 * the person came for. The bridge's own message is a developer's hint about
 * a server-side env key, and it is meaningless on a deployed origin, where the
 * server is a container and not anyone's Mac: it renders only on localhost,
 * and then only as a second line under the real state.
 */
function PuppyLinkEmptyState({
  link,
  status,
}: {
  link: PuppyLink | null;
  status: PuppyStatus;
}) {
  const developerHint = isLocalHost() ? status.message?.trim() || null : null;
  return (
    <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
      <PuppyLinkCopy link={link} />
      {developerHint ? (
        <p className="mt-3 text-[11px] text-muted-foreground/80">
          {developerHint}
        </p>
      ) : null}
    </div>
  );
}

function PuppyLinkCopy({ link }: { link: PuppyLink | null }) {
  const trustedDevices = (
    <Link
      href={ROUTES.PROFILE_SECURITY_DEVICES}
      className="underline underline-offset-2 hover:text-foreground"
    >
      Trusted devices
    </Link>
  );

  if (link?.state === "live" && link.device) {
    const model = link.device.heartbeat?.current_model?.trim();
    const seen = seenRelative(link);
    return (
      <>
        <p>
          {/* The model is the one the machine has CONFIGURED, as it reported
              it. "running" would claim it is loaded, which One cannot see. */}
          Puppy One is connected to your account on {link.device.name}
          {model ? ` · ${model}` : ""}
          {seen ? ` · seen ${seen}` : ""}. Chat here works from that machine.
        </p>
        <p className="mt-2">{trustedDevices}</p>
      </>
    );
  }

  if (link?.state === "quiet" && link.device) {
    const seen = seenRelative(link);
    // A device that has NEVER reported is not asleep: it is trusted and
    // either older than the heartbeat or between connecting and its first
    // push. Saying "offline" about it would be a guess dressed as a fact.
    return (
      <p>
        {seen ? (
          <>
            Puppy One on {link.device.name} was last seen {seen}. It may be
            asleep or offline.
          </>
        ) : (
          <>
            Puppy One on {link.device.name} is trusted but has not reported
            yet.
          </>
        )}{" "}
        On that machine, run{" "}
        <code className="font-mono text-[0.85em]">/hussh-one status</code>.
      </p>
    );
  }

  if (link?.state === "unlinked") {
    return (
      <>
        <p>
          Puppy One isn&apos;t connected to your account yet. Install it on
          your Mac, then run{" "}
          <code className="font-mono text-[0.85em]">/hussh-one connect</code>.
        </p>
        <p className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1">
          <a
            href={PUPPY_ONE_INSTALL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Get Puppy One on GitHub
          </a>
          {trustedDevices}
        </p>
      </>
    );
  }

  if (link?.state === "revoked") {
    return (
      <p>
        {/* `connect`, not `reconnect`: a revoked device is sealed, and the
            agent's own remedy for that state is a fresh connect. `reconnect`
            is the repair for an expired login on a still-trusted machine,
            and refuses to run on a device that is not connected. */}
        Puppy One was unlinked from this account. On that machine, run{" "}
        <code className="font-mono text-[0.85em]">/hussh-one connect</code>.
      </p>
    );
  }

  return <p>Couldn&apos;t check your Puppy One link right now.</p>;
}
