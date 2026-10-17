/**
 * One calm, persistent notice for a chat turn that is slow or struggling.
 *
 * It is driven only by what the stream actually reports, never by a guess:
 *
 * - `slow`: no visible work (an answer token, a tool or agent step, an
 *   activity update, a thought) within SLOW_FIRST_ACTIVITY_MS of the send. Tool
 *   work counts as work, so a long tool step never raises it.
 * - `connecting`: no bytes at all for CONNECTION_QUIET_MS. The server writes a
 *   keep-alive ping every 15 s while a model or tool call is pending, so
 *   silence this long is the connection, not a slow answer.
 * - `waking`: the person's own private agent is starting up after sleeping
 *   (it scales to zero). The turn is sent once it answers, so the silence is
 *   explained and the `connecting` notice never replaces it.
 * - `busy` / `unavailable`: the server said so, with its authored capacity,
 *   unavailable or restarting code, or the request was refused with 429 / 503.
 *
 * The notice only moves up in severity while a turn runs and updates in place.
 * A person's dismissal holds for the rest of that turn unless the state gets
 * worse. It clears quietly when One starts replying, the turn finishes, or the
 * person stops it. A turn that fails for any reason other than server strain
 * clears it too, so the error in the transcript is the only word on that turn.
 * A strain failure leaves the notice up (the heavy-usage explanation) until the
 * person dismisses it or their next message gets a reply.
 *
 * Framework-free: the port renders, the timers are injectable, and no message
 * text, token or identifier ever passes through here.
 */

/**
 * Measured 2026-09-25 (n=12 per setting, localhost against UAT): the default
 * model's median full turn was 7.7 to 11.7 s, with about 2 s of fixed overhead
 * before the first model call and the first visible event well inside that. A
 * worker's first turn can add 3.6 to 41 s of one-time setup. 15 s with nothing
 * visible is past a normal full answer, so it is a real delay, not an ordinary
 * one.
 */
export const SLOW_FIRST_ACTIVITY_MS = 15_000;

/** Two missed 15 s keep-alive pings plus a 5 s margin for a slow network hop. */
export const CONNECTION_QUIET_MS = 35_000;

export const SLOW_NOTICE_TOAST_ID = "one-chat-slow-notice";

export type SlowNoticeState = "slow" | "waking" | "connecting" | "busy" | "unavailable";
export type BackendStrain = "busy" | "unavailable";

export type SlowNoticeView = {
  state: SlowNoticeState;
  title: string;
};

export type AgentStreamHealthSignal =
  /** Body bytes arrived, keep-alive pings included. */
  | { kind: "bytes" }
  /** The first visible work: a token, a tool or agent step, activity, a thought. */
  | { kind: "activity" }
  /** The owner's private agent is starting up; the turn is sent once it answers. */
  | { kind: "waking" }
  /** The server refused or ended the turn for capacity, availability or a restart. */
  | { kind: "backend_strain"; strain: BackendStrain };

export type SlowNoticePort = {
  show: (view: SlowNoticeView) => void;
  clear: () => void;
};

export type SlowNoticeTimers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
};

export type SlowTurnOutcome = "answered" | "failed" | "stopped";

// One complete, two-line-at-most toast message, even at 320 px with widened
// text. A quiet turn does not prove server capacity, so only the typed busy
// signal names that condition.
export const SLOW_NOTICE_COPY: Record<SlowNoticeState, Omit<SlowNoticeView, "state">> = {
  slow: {
    title: "One is taking longer than usual. Your message is safe.",
  },
  waking: {
    title: "Waking your agent… Your message will send shortly.",
  },
  connecting: {
    title: "Still connecting to One. Your message is safe.",
  },
  busy: {
    title: "One is very busy right now. Please try again in a moment.",
  },
  unavailable: {
    title: "One is briefly unavailable. Please try again shortly.",
  },
};

const SEVERITY: Record<SlowNoticeState, number> = {
  slow: 1,
  waking: 2,
  connecting: 2,
  busy: 3,
  unavailable: 3,
};

const CAPACITY_CODES = new Set(["RESOURCE_EXHAUSTED"]);
const UNAVAILABLE_CODES = new Set(["MODEL_UNAVAILABLE", "SERVER_RESTARTING"]);

/**
 * Server strain from a typed RUN_ERROR code or a refused request's HTTP status.
 * Only exact codes and statuses count; message text is never read.
 */
export function classifyBackendStrain(input: {
  code?: string | null;
  httpStatus?: number | null;
}): BackendStrain | null {
  const code = input.code ?? "";
  if (CAPACITY_CODES.has(code) || input.httpStatus === 429) return "busy";
  if (UNAVAILABLE_CODES.has(code) || input.httpStatus === 503) return "unavailable";
  return null;
}

export function slowNoticeView(state: SlowNoticeState): SlowNoticeView {
  return { state, ...SLOW_NOTICE_COPY[state] };
}

const DEFAULT_TIMERS: SlowNoticeTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export class SlowTurnNotice {
  private shown: SlowNoticeState | null = null;
  private turnActive = false;
  private activitySeen = false;
  private slowElapsed = false;
  private dismissedSeverity = 0;
  private lastBytesAt = 0;
  private slowTimer: unknown = null;
  private quietTimer: unknown = null;

  constructor(
    private readonly port: SlowNoticePort,
    private readonly timers: SlowNoticeTimers = DEFAULT_TIMERS,
  ) {}

  get visibleState(): SlowNoticeState | null {
    return this.shown;
  }

  /**
   * A turn was sent. A notice left up by an earlier turn stays until this one
   * shows it is fine (its first activity) or is itself slow.
   */
  begin(): void {
    this.stopTimers();
    this.turnActive = true;
    this.activitySeen = false;
    this.slowElapsed = false;
    this.dismissedSeverity = 0;
    this.lastBytesAt = this.timers.now();
    this.slowTimer = this.timers.setTimeout(() => this.onSlowThreshold(), SLOW_FIRST_ACTIVITY_MS);
    this.armQuietTimer(CONNECTION_QUIET_MS);
  }

  signal(signal: AgentStreamHealthSignal): void {
    if (!this.turnActive) return;
    if (signal.kind === "backend_strain") {
      this.escalate(signal.strain);
      return;
    }
    if (signal.kind === "waking") {
      this.escalate("waking");
      return;
    }
    this.lastBytesAt = this.timers.now();
    if (signal.kind === "activity") {
      this.activitySeen = true;
      this.clearSlowTimer();
      this.hide();
      return;
    }
    // Bytes are flowing again: the connection is back (or the agent is awake).
    // Say what is still true.
    if (this.shown === "connecting" || this.shown === "waking") {
      if (!this.activitySeen && this.slowElapsed) this.replace("slow");
      else this.hide();
    }
  }

  finish(outcome: SlowTurnOutcome): void {
    if (!this.turnActive) return;
    this.turnActive = false;
    this.stopTimers();
    const strained = this.shown === "busy" || this.shown === "unavailable";
    if (outcome === "failed" && strained) return;
    this.hide();
  }

  /** The person closed or swiped the notice. */
  dismissedByPerson(): void {
    // A programmatic clear echoes through the same callback; it has already
    // set `shown` to null, so only a real dismissal lands here.
    if (this.shown === null) return;
    this.dismissedSeverity = Math.max(this.dismissedSeverity, SEVERITY[this.shown]);
    this.shown = null;
  }

  /** The chat surface is going away: stop timing and take the notice down. */
  dispose(): void {
    this.turnActive = false;
    this.stopTimers();
    this.hide();
  }

  private onSlowThreshold(): void {
    this.slowTimer = null;
    if (!this.turnActive || this.activitySeen) return;
    this.slowElapsed = true;
    this.escalate("slow");
  }

  private onQuietTick(): void {
    this.quietTimer = null;
    if (!this.turnActive) return;
    const quietFor = this.timers.now() - this.lastBytesAt;
    if (quietFor < CONNECTION_QUIET_MS) {
      this.armQuietTimer(CONNECTION_QUIET_MS - quietFor);
      return;
    }
    this.escalate("connecting");
    // Keep watching: bytes returning downgrades it, and a later strain can still escalate.
    this.armQuietTimer(CONNECTION_QUIET_MS);
  }

  private escalate(state: SlowNoticeState): void {
    const severity = SEVERITY[state];
    if (severity <= this.dismissedSeverity) return;
    if (this.shown === state) return;
    if (this.shown !== null && severity < SEVERITY[this.shown]) return;
    // A waking agent explains the quiet; "still connecting" would contradict it.
    if (state === "connecting" && this.shown === "waking") return;
    this.shown = state;
    this.port.show(slowNoticeView(state));
  }

  /** A downgrade that stays visible, used only when bytes come back. */
  private replace(state: SlowNoticeState): void {
    if (SEVERITY[state] <= this.dismissedSeverity) {
      this.hide();
      return;
    }
    this.shown = state;
    this.port.show(slowNoticeView(state));
  }

  private hide(): void {
    if (this.shown === null) return;
    this.shown = null;
    this.port.clear();
  }

  private armQuietTimer(ms: number): void {
    if (this.quietTimer !== null) this.timers.clearTimeout(this.quietTimer);
    this.quietTimer = this.timers.setTimeout(() => this.onQuietTick(), ms);
  }

  private clearSlowTimer(): void {
    if (this.slowTimer === null) return;
    this.timers.clearTimeout(this.slowTimer);
    this.slowTimer = null;
  }

  private stopTimers(): void {
    this.clearSlowTimer();
    if (this.quietTimer !== null) this.timers.clearTimeout(this.quietTimer);
    this.quietTimer = null;
  }
}
