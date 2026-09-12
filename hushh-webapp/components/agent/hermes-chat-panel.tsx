"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { HttpAgent } from "@ag-ui/client";
import { Check, Copy, Laptop, Loader2, Send } from "lucide-react";

import { AgentMarkdown } from "@/components/agent/agent-markdown";
import { copyTextToClipboard } from "@/components/agent/chat-markdown-link";
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
  /**
   * "notice" is the panel speaking, not the agent. It exists because the
   * model-switch line used to be written as an assistant turn, and once
   * assistant turns render markdown and carry a copy button an app-authored
   * sentence starts presenting as something the agent said, on the one
   * surface whose whole claim is who answered and where.
   */
  role: "user" | "assistant" | "notice";
  text: string;
  activity?: string[];
}

export function HermesChatPanel({
  className,
  active = true,
}: {
  className?: string;
  /**
   * Whether this panel is the surface on screen.
   *
   * The workspace keeps Puppy mounted and hidden so a slow local answer is not
   * destroyed by a glance at One, so `active` is what stops a hidden panel
   * becoming a permanent poller. It gates TIMERS only: the send path, the
   * stream callbacks and `turns` keep running while hidden, because an
   * in-flight turn finishing into a hidden panel and waiting there is the
   * entire point.
   */
  active?: boolean;
}) {
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
  // Which assistant turn is streaming right now, so only that one is a live
  // region. `sending` is panel-wide and would re-announce older answers.
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // One's record of the machine comes from the shared store, so this panel
  // and the strip above it change in the same moment. Deliberately NOT tied
  // to the bridge read: the loopback gateway answers in under a second and
  // the backend list can take a minute when One is slow, and awaiting both
  // together held a connected agent hostage to a hung backend.
  const link = usePuppyLink();

  const loadStatus = useCallback(async () => {
    // Through the service layer, not a raw fetch: not-running is an ordinary
    // state and every surface should render the same one.
    const next = await fetchPuppyStatus();
    if (!mountedRef.current) return;
    setStatus(next);
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadStatus();
    const timer = setInterval(() => void loadStatus(), 30_000);
    return () => clearInterval(timer);
  }, [active, loadStatus]);

  useEffect(() => {
    // `block: "nearest"` and not the default "start": on `/one/puppy` the
    // panel sits in the page's own scroll root, and every streamed delta
    // scrolling an ancestor yanks the whole page under the reader.
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
          role: "notice",
          text: selection.onDevice
            ? `Switched to ${selection.model} on this machine. Starting a new session.`
            : `Switched to ${selection.model}. This model runs off this machine. Starting a new session.`,
        },
      ]);
    },
    [setOnDevice],
  );

  const togglePin = useCallback(() => {
    // Hermes applies provider/model at SESSION creation, so flipping the pin
    // mid-session would leave the pill claiming one thing while the session
    // already running answers another. The same treatment `applyModel` gives a
    // model change: drop the session, and say so rather than changing where
    // answers come from invisibly.
    // Computed outside the state updater, not inside it: an updater must stay
    // pure, and React can call it twice.
    const next = !onDevice;
    sessionRef.current = "";
    setOnDevice(next);
    setTurns((prior) => [
      ...prior,
      {
        id: `sys-${Date.now()}`,
        role: "notice",
        text: next
          ? "Pinned to this machine. Starting a new session."
          : "Unpinned from this machine, so a model that runs off it may answer. Starting a new session.",
      },
    ]);
  }, [onDevice, setOnDevice]);

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
    setStreamingId(assistantId);
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
      // A real unmount (route change, workspace close) fails quietly rather
      // than writing into a dead tree. Being HIDDEN is not an unmount, so a
      // turn started before a toggle to One still lands and waits.
      if (mountedRef.current) {
        setError("Puppy One is not answering on this machine.");
      }
    } finally {
      if (mountedRef.current) {
        setSending(false);
        setStreamingId(null);
      }
    }
  }

  const connected = status?.connected === true;
  // Null is "the first read has not landed", and nothing else: `fetchPuppyLink`
  // never throws and answers "unavailable" on failure. Gating on `status`
  // instead would be wrong twice. It lands before the link, so the worse
  // falsehood ("Couldn't check your Puppy One link right now.") would stay
  // painted for the whole link window; and the link store survives an unmount
  // while `status` does not, so a warm re-entry would be downgraded from a
  // true "connected · {device}" back to a guess.
  const checking = !connected && link === null;
  // The bridge, when it is connected, is the stronger claim and keeps the
  // pill. Then the pre-answer form. Only then does One's record speak.
  const pill = connected
    ? { live: true, label: status?.model ?? "connected", pending: false }
    : checking
      ? { live: false, label: "checking…", pending: true }
      : { ...describeLinkPill(link), pending: false };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5 text-xs">
        <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5",
            // The success role tokens, not a flat #34C759: the raw hex measured
            // 2.01:1 on white and had no dark form, so the one label that says
            // the owner's machine is alive was the least legible text on the
            // surface. `-deep` is the LIGHT-surface tone and is inherited
            // unchanged in dark, which is why the `dark:` half selecting
            // `-bright` is load-bearing and not decoration.
            pill.live
              ? "bg-[color:var(--app-success-tint)] text-[color:var(--app-success-deep)] dark:text-[color:var(--app-success-bright)]"
              : "bg-muted text-muted-foreground",
          )}
        >
          {pill.pending ? (
            // A spinner, not the grey dot: that dot already means "there is no
            // machine", and "we have not asked yet" must not look like it.
            <Loader2 className="size-2.5 animate-spin" aria-hidden />
          ) : (
            <span
              className={cn(
                "size-1.5 rounded-full",
                pill.live ? "bg-current" : "bg-muted-foreground/60",
              )}
            />
          )}
          {pill.label}
        </span>
        {connected ? (
          <PuppyModelPicker onApplied={applyModel} className="ml-auto" />
        ) : null}
        {connected ? (
          <button
            type="button"
            onClick={togglePin}
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
        {/* Always mounted, so the region is in the accessibility tree before
            the run begins rather than being inserted with its own content.
            One's "Thinking" is deliberately suppressed in Puppy mode, which
            left a screen reader with nothing at all between send and answer. */}
        <p className="sr-only" role="status" aria-live="polite">
          {sending ? "Puppy One is thinking" : ""}
        </p>
        {checking ? (
          <p className="flex items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Checking Puppy One…
          </p>
        ) : !connected && (status || link) ? (
          <PuppyLinkEmptyState link={link} status={status} />
        ) : null}
        {connected && turns.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            {/* The pin is what makes the promise, so the promise follows the
                pin. With "any model" chosen the gateway is free to resolve a
                model that runs off this machine, and this is the largest piece
                of copy on the surface. */}
            {onDevice
              ? "Ask Puppy One. Its answers are generated on this machine, and this conversation stays separate from One."
              : "Ask Puppy One. This turn is not pinned to this machine, so a model that runs off it may answer. This conversation still stays separate from One."}
          </p>
        ) : null}
        <div className="flex flex-col gap-6">
          {turns.map((turn) => (
            <PuppyTurnView
              key={turn.id}
              turn={turn}
              streaming={turn.id === streamingId}
              sending={sending}
            />
          ))}
        </div>
        {/* role="alert": a machine refusing to answer is the one thing on this
            surface a screen reader must not have to go looking for. */}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
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
          // Still disabled while checking: not knowing yet is not permission
          // to send. Only the words change.
          disabled={!connected || sending}
          rows={1}
          placeholder={
            connected
              ? "Ask Puppy One…"
              : checking
                ? "Checking Puppy One…"
                : composerPlaceholder(link)
          }
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
 * One turn, in the same grammar One's transcript uses.
 *
 * The assistant half goes through the SHARED markdown renderer and is
 * unbubbled, exactly as One's is, because a Puppy answer arriving as literal
 * `**bold**` and unrendered fences made the on-device tier read as the
 * half-finished half of the app. The user half keeps `whitespace-pre-wrap`:
 * parsing what the owner typed as markdown would eat their asterisks. A
 * "notice" is the panel speaking and gets neither bubble, markdown nor copy,
 * so it can never be mistaken for the agent's own words.
 */
function PuppyTurnView({
  turn,
  streaming,
  sending,
}: {
  turn: PuppyTurn;
  streaming: boolean;
  sending: boolean;
}) {
  const [copied, setCopied] = useState(false);

  if (turn.role === "notice") {
    return (
      <p className="motion-step-enter text-center text-[11px] text-muted-foreground">
        {turn.text}
      </p>
    );
  }

  if (turn.role === "user") {
    return (
      <div className="motion-step-enter flex w-full justify-end">
        <span className="max-w-[min(76%,42rem)] whitespace-pre-wrap break-words rounded-[22px] rounded-br-[7px] bg-[linear-gradient(145deg,var(--app-accent),var(--app-accent-deep))] px-4 py-2.5 text-sm leading-6 text-[color:var(--app-accent-fg)] shadow-[0_14px_34px_-24px_var(--app-accent-deep)]">
          {turn.text}
        </span>
      </div>
    );
  }

  return (
    <div className="motion-step-enter flex w-full flex-col items-start">
      <div
        // Only the turn actually streaming is a live region.
        aria-live={streaming ? "polite" : undefined}
        className="min-w-0 max-w-[90%] px-1 py-2 text-sm leading-6 text-foreground sm:max-w-[min(82%,48rem)]"
      >
        {turn.activity && turn.activity.length > 0 ? (
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            {turn.activity.join(" · ")}
          </p>
        ) : null}
        {turn.text ? <AgentMarkdown text={turn.text} /> : null}
        {sending && !turn.text ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : null}
      </div>
      {turn.text && !streaming ? (
        <button
          type="button"
          onClick={() => {
            void copyTextToClipboard(turn.text)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              })
              .catch(() => undefined);
          }}
          aria-label="Copy answer"
          className="ml-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {copied ? (
            <Check className="size-3" aria-hidden />
          ) : (
            <Copy className="size-3" aria-hidden />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      ) : null}
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
    // Hedged to the same strength as the body copy, which says the machine
    // "may be" asleep. A flat "is asleep or offline" beside a "may be" is two
    // confidences about one fact on one screen.
    return link.device.lastHeartbeatAt === null
      ? `Puppy One on ${link.device.name} has not reported yet`
      : `Puppy One on ${link.device.name} is quiet right now`;
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
  /** Null while the bridge read is still out: the link alone can carry it. */
  status: PuppyStatus | null;
}) {
  const developerHint = isLocalHost() ? status?.message?.trim() || null : null;
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
      <>
        {seen ? (
          <p>
            {/* The human action leads and the slash command is the fallback,
                because the state being explained is precisely the one in which
                that machine is not available to type into. No promise of
                recovery: quiet also covers a stopped gateway, no network, and
                an expired device login One cannot see from a deployed
                origin. */}
            Puppy One on {link.device.name} was last seen {seen}. It answers
            only while that Mac is on and awake, so waking it is the first
            thing to try. If it stays quiet after that, run{" "}
            <code className="font-mono text-[0.85em]">/hussh-one status</code>{" "}
            on that machine.
          </p>
        ) : (
          <p>
            Puppy One on {link.device.name} is trusted but has not reported
            yet. On that machine, run{" "}
            <code className="font-mono text-[0.85em]">/hussh-one status</code>.
          </p>
        )}
        <p className="mt-2">{trustedDevices}</p>
      </>
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
      <>
        <p>
          {/* `connect`, not `reconnect`: a revoked device is sealed, and the
              agent's own remedy for that state is a fresh connect. `reconnect`
              is the repair for an expired login on a still-trusted machine,
              and refuses to run on a device that is not connected. */}
          Puppy One was unlinked from this account. On that machine, run{" "}
          <code className="font-mono text-[0.85em]">/hussh-one connect</code>.
        </p>
        {/* Unlinking can be done from another session or by someone else on
            the account, so this is news to the reader, and Trusted devices is
            the only page that says which device and when. No install anchor:
            that machine already has Puppy One on it. */}
        <p className="mt-2">{trustedDevices}</p>
      </>
    );
  }

  return <p>Couldn&apos;t check your Puppy One link right now.</p>;
}
