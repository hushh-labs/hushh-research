import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import {
  CONNECTION_QUIET_MS,
  SLOW_FIRST_ACTIVITY_MS,
  SLOW_NOTICE_COPY,
  SLOW_NOTICE_TOAST_ID,
  SlowTurnNotice,
  classifyBackendStrain,
  type SlowNoticeView,
} from "@/lib/agent/agent-chat-slow-notice";
import { createSlowNoticeToastPort } from "@/components/agent/agent-chat-slow-notice";

/**
 * The slow-reply notice is a contract with the person: it appears only for a
 * real delay or real server strain, never stacks, honours a dismissal for the
 * turn, and gets out of the way of the reply and of the error in the transcript.
 */
function harness() {
  const shown: SlowNoticeView[] = [];
  let cleared = 0;
  let visible: SlowNoticeView | null = null;
  const notice = new SlowTurnNotice({
    show: (view) => {
      shown.push(view);
      visible = view;
    },
    clear: () => {
      cleared += 1;
      visible = null;
    },
  });
  return {
    notice,
    shown,
    get cleared() {
      return cleared;
    },
    get visible() {
      return visible;
    },
  };
}

// Stand-in for the server's 15 s keep-alive comment on an open stream.
function pingEvery15s(notice: SlowTurnNotice, totalMs: number) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += 15_000) {
    notice.signal({ kind: "bytes" });
    vi.advanceTimersByTime(Math.min(15_000, totalMs - elapsed));
  }
}

describe("the slow-reply notice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("appears once when nothing visible arrives within the threshold", () => {
    const h = harness();
    h.notice.begin();
    vi.advanceTimersByTime(SLOW_FIRST_ACTIVITY_MS - 1);
    expect(h.shown).toEqual([]); // negative control: not a moment early

    vi.advanceTimersByTime(1);
    expect(h.shown.map((view) => view.state)).toEqual(["slow"]);
    expect(h.visible?.title).toBe(SLOW_NOTICE_COPY.slow.title);

    // Still slow with the connection alive: it does not fire again.
    pingEvery15s(h.notice, 30_000);
    expect(h.shown).toHaveLength(1);
  });

  it("stays quiet through long tool work, which is activity, not slowness", () => {
    const h = harness();
    h.notice.begin();
    vi.advanceTimersByTime(4_000);
    h.notice.signal({ kind: "activity" }); // TOOL_CALL_START
    // A 90 s specialist step: nothing but keep-alive pings.
    pingEvery15s(h.notice, 90_000);
    expect(h.shown).toEqual([]);

    // Negative control: the same 90 s with no activity does raise it.
    const control = harness();
    control.notice.begin();
    pingEvery15s(control.notice, 90_000);
    expect(control.shown.map((view) => view.state)).toEqual(["slow"]);
  });

  it("says the connection is slow only when even the keep-alive stops, and updates in place", () => {
    const h = harness();
    h.notice.begin();
    vi.advanceTimersByTime(SLOW_FIRST_ACTIVITY_MS);
    vi.advanceTimersByTime(CONNECTION_QUIET_MS - SLOW_FIRST_ACTIVITY_MS);
    expect(h.shown.map((view) => view.state)).toEqual(["slow", "connecting"]);
    expect(h.visible?.title).toBe(SLOW_NOTICE_COPY.connecting.title);
    expect(h.cleared).toBe(0); // replaced in place, never taken down and re-raised

    // Bytes return but still no answer: back to the honest "slow".
    h.notice.signal({ kind: "bytes" });
    expect(h.visible?.state).toBe("slow");
  });

  it("maps server strain to its copy: 429 and capacity to busy, 503, restart and unavailable to unavailable", () => {
    expect(classifyBackendStrain({ httpStatus: 429 })).toBe("busy");
    expect(classifyBackendStrain({ code: "RESOURCE_EXHAUSTED" })).toBe("busy");
    expect(classifyBackendStrain({ httpStatus: 503 })).toBe("unavailable");
    expect(classifyBackendStrain({ code: "MODEL_UNAVAILABLE" })).toBe("unavailable");
    expect(classifyBackendStrain({ code: "SERVER_RESTARTING" })).toBe("unavailable");
    // Negative controls: other failures are the error UI's alone.
    for (const input of [
      { httpStatus: 500 }, { httpStatus: 401 }, { httpStatus: 403 }, { code: "MODEL_ERROR" },
      { code: "CHAT_KEY_REQUIRED" }, { code: "resource_exhausted" }, { code: null, httpStatus: null },
    ]) {
      expect(classifyBackendStrain(input), JSON.stringify(input)).toBeNull();
    }

    const h = harness();
    h.notice.begin();
    vi.advanceTimersByTime(SLOW_FIRST_ACTIVITY_MS);
    h.notice.signal({ kind: "backend_strain", strain: "busy" });
    expect(h.visible).toEqual({ state: "busy", ...SLOW_NOTICE_COPY.busy });
  });

  it("respects a dismissal for the turn unless things get worse", () => {
    const h = harness();
    h.notice.begin();
    vi.advanceTimersByTime(SLOW_FIRST_ACTIVITY_MS);
    h.notice.dismissedByPerson();
    expect(h.notice.visibleState).toBeNull();
    // The dismissal's own echo from the toast is not a second dismissal.
    h.notice.dismissedByPerson();

    // Still just slow a minute later: not re-shown.
    pingEvery15s(h.notice, 60_000);
    expect(h.shown).toHaveLength(1);

    // Worse: the server reports capacity. That is new information, so it shows.
    h.notice.signal({ kind: "backend_strain", strain: "busy" });
    expect(h.shown.map((view) => view.state)).toEqual(["slow", "busy"]);

    // A new turn starts clean: a slow reply may be said again.
    h.notice.finish("answered");
    h.notice.begin();
    vi.advanceTimersByTime(SLOW_FIRST_ACTIVITY_MS);
    expect(h.shown.at(-1)?.state).toBe("slow");
  });

  it("clears quietly when the reply starts, and when the turn finishes", () => {
    const h = harness();
    h.notice.begin();
    vi.advanceTimersByTime(SLOW_FIRST_ACTIVITY_MS);
    h.notice.signal({ kind: "activity" });
    expect(h.cleared).toBe(1);
    expect(h.notice.visibleState).toBeNull();
    // No "back to normal" toast: the reply itself is the signal.
    expect(h.shown).toHaveLength(1);

    const finished = harness();
    finished.notice.begin();
    vi.advanceTimersByTime(CONNECTION_QUIET_MS);
    finished.notice.finish("answered");
    expect(finished.notice.visibleState).toBeNull();
    // Nothing keeps timing a finished turn.
    vi.advanceTimersByTime(10 * CONNECTION_QUIET_MS);
    expect(finished.shown.map((view) => view.state)).toEqual(["slow", "connecting"]);
  });

  it("hands a failed turn to the error in the transcript, but keeps the heavy-usage notice for strain", () => {
    const plain = harness();
    plain.notice.begin();
    vi.advanceTimersByTime(CONNECTION_QUIET_MS);
    plain.notice.finish("failed");
    expect(plain.notice.visibleState).toBeNull();
    expect(plain.cleared).toBe(1);

    const strained = harness();
    strained.notice.begin();
    vi.advanceTimersByTime(SLOW_FIRST_ACTIVITY_MS);
    strained.notice.signal({ kind: "backend_strain", strain: "unavailable" });
    strained.notice.finish("failed");
    expect(strained.notice.visibleState).toBe("unavailable");
    // It never leaves on its own while the problem is the latest word...
    vi.advanceTimersByTime(10 * 60_000);
    expect(strained.notice.visibleState).toBe("unavailable");
    // ...and the next turn's first reply clears it.
    strained.notice.begin();
    strained.notice.signal({ kind: "activity" });
    expect(strained.notice.visibleState).toBeNull();

    // A stopped turn never leaves a notice behind.
    const stopped = harness();
    stopped.notice.begin();
    vi.advanceTimersByTime(SLOW_FIRST_ACTIVITY_MS);
    stopped.notice.finish("stopped");
    expect(stopped.notice.visibleState).toBeNull();
    stopped.notice.signal({ kind: "backend_strain", strain: "busy" }); // late event from the stopped stream
    expect(stopped.shown.map((view) => view.state)).toEqual(["slow"]);
  });
});

describe("the notice as a sonner toast", () => {
  afterEach(() => {
    toast.dismiss();
  });

  const live = () => toast.getToasts().filter((item) => !("dismiss" in item && item.dismiss));

  it("is one persistent, closable toast under a stable id that updates in place", () => {
    const onDismiss = vi.fn();
    const port = createSlowNoticeToastPort(onDismiss);
    port.show({ state: "slow", ...SLOW_NOTICE_COPY.slow });
    port.show({ state: "connecting", ...SLOW_NOTICE_COPY.connecting });
    port.show({ state: "busy", ...SLOW_NOTICE_COPY.busy });

    const toasts = live();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      id: SLOW_NOTICE_TOAST_ID,
      title: SLOW_NOTICE_COPY.busy.title,
      duration: Infinity,
      closeButton: true,
      dismissible: true,
    });

    port.clear();
    expect(live()).toHaveLength(0);
  });

  it("uses calm copy: no dashes, no provider, no jargon", () => {
    for (const { title } of Object.values(SLOW_NOTICE_COPY)) {
      expect(title).not.toMatch(/[\u2013\u2014]/);
      expect(title).not.toMatch(/gemini|google|vertex|model|server|429|503|error|quota|api/i);
      expect(title.length).toBeLessThanOrEqual(72);
    }
  });
});
