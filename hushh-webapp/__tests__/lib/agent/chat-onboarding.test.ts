import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  reduceChatOnboarding,
  type ChatOnboardingEvent,
  type ChatOnboardingResult,
  type ChatOnboardingState,
} from "@/lib/agent/chat-onboarding/chat-onboarding-machine";
import {
  CHAT_ONBOARDING_FOCUS,
  CHAT_ONBOARDING_FOCUS_PLAN,
  type ChatOnboardingChipId,
} from "@/lib/agent/chat-onboarding/chat-onboarding-script";
import {
  pickDailyTip,
  progressFromWire,
  progressToWire,
} from "@/lib/agent/chat-onboarding/chat-onboarding-progress";
import {
  mergeCommunicationPreferences,
  saveChatOnboardingPreferences,
} from "@/lib/agent/chat-onboarding/chat-onboarding-preferences";
import { ALL_WELCOME_PROMPTS } from "@/lib/agent/agent-welcome-prompts";
import { ROUTES } from "@/lib/navigation/routes";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: vi.fn() },
}));

const TODAY = "2026-09-27";

function run(state: ChatOnboardingState | null, event: ChatOnboardingEvent): ChatOnboardingResult {
  return reduceChatOnboarding(state, event);
}

function start(): ChatOnboardingResult {
  return run(null, { type: "start", displayName: "Kushal", firstName: "Kushal", anchor: null });
}

function chip(state: ChatOnboardingState, chipId: ChatOnboardingChipId, anchor: string | null = null) {
  return run(state, { type: "chip", chipId, anchor, today: TODAY, firstName: "Kushal" });
}

function lastAssistant(state: ChatOnboardingState) {
  return [...state.turns].reverse().find((turn) => turn.role === "assistant")!;
}

describe("chat onboarding sequence", () => {
  it("asks name, then focus, then tone, one question per assistant turn, then confirms", () => {
    const started = start();
    expect(started.state.step).toBe("name");
    const welcome = started.state.turns[0]!;
    expect(welcome.role).toBe("assistant");
    expect(welcome.text).toMatch(/^Welcome, Kushal\. I'm One, your private agent on Hussh\./);
    expect(welcome.text).not.toMatch(/—/); // no em dashes
    expect(welcome.chips?.map((c) => c.label)).toEqual(["Call me Kushal", "Something else", "Skip for now"]);

    const named = chip(started.state, "name_signin");
    expect(named.state.step).toBe("focus");
    expect(lastAssistant(named.state).text).toBe("Nice to meet you, Kushal. What should I help with first?");
    expect(lastAssistant(named.state).chips?.map((c) => c.label)).toEqual([
      "Email", "Calendar", "Money", "Memory", "Location", "Just chat", "Skip for now",
    ]);

    const focused = chip(named.state, "focus_chat");
    expect(focused.state.step).toBe("tone");
    expect(lastAssistant(focused.state).chips?.map((c) => c.label)).toEqual([
      "Short and direct", "Detailed", "Casual", "Skip for now",
    ]);

    const toned = chip(focused.state, "tone_short_direct");
    expect(toned.state.step).toBe("confirm");
    expect(lastAssistant(toned.state).text).toContain("Call you **Kushal**");
    expect(lastAssistant(toned.state).text).toContain("**short and direct**");

    // Every assistant turn carrying chips asks exactly one question.
    for (const turn of toned.state.turns.filter((t) => t.role === "assistant" && t.chips?.length)) {
      expect(turn.text.match(/\?/g)?.length ?? 0).toBe(1);
    }
  });

  it("skipping every question ends without a confirmation and without saving", () => {
    let state = start().state;
    const effects: ChatOnboardingResult["effects"] = [];
    for (let i = 0; i < 3; i += 1) {
      const next = chip(state, "skip");
      effects.push(...next.effects);
      state = next.state;
    }
    expect(state.step).toBe("done");
    expect(state.progress.status).toBe("completed");
    expect(state.progress.questions).toEqual({ name: "skipped", focus: "skipped", tone: "skipped" });
    expect(effects.some((effect) => effect.type === "save_preferences")).toBe(false);
    expect(lastAssistant(state).text).toBe("You're all set. What's on your mind?");
  });
});

describe("unrelated input never breaks onboarding", () => {
  it("does not take ordinary composer text as an answer unless the person chose to type a name", () => {
    const started = start().state;
    const idle = run(started, { type: "typed_answer", text: "Kushal", anchor: null });
    expect(idle.consumed).toBe(false);
    expect(idle.state).toBe(started);
  });

  it("sends question-shaped text to One and keeps waiting, then accepts a real name", () => {
    const typing = chip(start().state, "name_other").state;
    expect(typing.step).toBe("name_typing");

    const unrelated = run(typing, {
      type: "typed_answer",
      text: "What's on my calendar this week?",
      anchor: "msg-1",
    });
    expect(unrelated.consumed).toBe(false);
    expect(unrelated.state.step).toBe("name");
    expect(unrelated.state.turns).toHaveLength(typing.turns.length);

    // Onboarding resumes from where it waited, anchored after the real exchange.
    const retry = chip(unrelated.state, "name_other", "msg-2").state;
    const named = run(retry, { type: "typed_answer", text: "  Kush  ", anchor: "msg-2" });
    expect(named.consumed).toBe(true);
    expect(named.state.draft.name).toBe("Kush");
    expect(named.state.step).toBe("focus");
    expect(named.state.turns.at(-1)?.anchor).toBe("msg-2");
  });
});

describe("answers are saved only on confirmation", () => {
  function atConfirm() {
    let state = start().state;
    state = chip(state, "name_signin").state;
    state = chip(state, "focus_email").state;
    return chip(state, "tone_casual");
  }

  it("emits no save before the person confirms, and never persists an answer value", () => {
    const reached = atConfirm();
    expect(reached.effects.some((effect) => effect.type === "save_preferences")).toBe(false);
    for (const effect of reached.effects) {
      if (effect.type === "persist_progress") {
        expect(JSON.stringify(progressToWire(effect.progress))).not.toContain("Kushal");
        expect(JSON.stringify(progressToWire(effect.progress))).not.toContain("casual");
      }
    }
  });

  it("saves name and tone once on Save, and nothing on Don't save", () => {
    const saved = chip(atConfirm().state, "save");
    expect(saved.state.step).toBe("saving");
    expect(saved.effects).toEqual([{ type: "save_preferences", name: "Kushal", tone: "casual" }]);

    const finished = run(saved.state, { type: "save_result", ok: true, anchor: null, today: TODAY });
    expect(finished.state.progress.status).toBe("completed");
    expect(finished.state.draft).toEqual({ name: null, tone: null });

    const declined = chip(atConfirm().state, "dont_save");
    expect(declined.effects.some((effect) => effect.type === "save_preferences")).toBe(false);
    expect(declined.state.progress.status).toBe("completed");
  });

  it("keeps the flow open with a retry when the encrypted save fails", () => {
    const saving = chip(atConfirm().state, "save").state;
    const failed = run(saving, { type: "save_result", ok: false, anchor: null, today: TODAY });
    expect(failed.state.step).toBe("save_failed");
    expect(failed.state.progress.status).toBe("in_progress");
    expect(chip(failed.state, "retry_save").effects[0]?.type).toBe("save_preferences");
  });
});

describe("what to help with first", () => {
  it("maps each choice to one existing connect flow and never a write scope", () => {
    expect(CHAT_ONBOARDING_FOCUS_PLAN.email.action).toEqual({ kind: "connector", provider: "gmail", label: "Connect Gmail" });
    expect(CHAT_ONBOARDING_FOCUS_PLAN.calendar.action).toEqual({ kind: "connector", provider: "calendar", label: "Connect Calendar" });
    expect(CHAT_ONBOARDING_FOCUS_PLAN.money.action).toMatchObject({ kind: "route", href: ROUTES.KAI_PORTFOLIO_SOURCES });
    expect(CHAT_ONBOARDING_FOCUS_PLAN.memory.action).toMatchObject({ kind: "route", href: ROUTES.PKM });
    expect(CHAT_ONBOARDING_FOCUS_PLAN.location.action).toMatchObject({ kind: "route", href: ROUTES.ONE_SETUP_LOCATION });
    expect(CHAT_ONBOARDING_FOCUS_PLAN.chat.action).toBeNull();
    for (const focus of CHAT_ONBOARDING_FOCUS) {
      expect(CHAT_ONBOARDING_FOCUS_PLAN[focus].explanation).not.toMatch(/—/);
    }
  });

  it("reaches only read-first connect paths", () => {
    // Calendar routes to the Calendar page, whose setup connect is read-only;
    // Gmail opens the connectors drawer, whose Connect Mail defaults to read.
    const root = process.cwd();
    const calendar = readFileSync(join(root, "components/calendar/calendar-agent-page.tsx"), "utf8");
    const connectors = readFileSync(join(root, "components/agent/connectors-panel.tsx"), "utf8");
    const workspace = readFileSync(join(root, "components/agent/agent-chat-workspace.tsx"), "utf8");
    expect(calendar).toContain('const connect = async (accessLevel: "read" | "manage" = "read") =>');
    expect(connectors).toContain('const connectMail = (purpose: "read" | "compose" = "read") =>');
    expect(workspace).toMatch(/if \(provider === "calendar"\) \{\s*router\.push\(ROUTES\.CALENDAR\);/);
  });

  it("shows the explanation with its single action, then asks the tone", () => {
    const named = chip(start().state, "name_signin").state;
    const focused = chip(named, "focus_money").state;
    const [user, explanation, tone] = focused.turns.slice(-3);
    expect(user).toMatchObject({ role: "user", text: "Money" });
    expect(explanation?.action).toMatchObject({ kind: "route", href: ROUTES.KAI_PORTFOLIO_SOURCES });
    expect(explanation?.chips).toBeUndefined();
    expect(tone?.text).toBe("Last one. How should I talk with you?");
  });
});

describe("durable progress", () => {
  it("round-trips without answer values and resumes at the first open question", () => {
    const wire = progressToWire({
      version: 1,
      status: "in_progress",
      questions: { name: "answered", focus: "skipped", tone: "pending" },
      completedOn: null,
      tipDismissedOn: null,
    });
    expect(wire).toEqual({
      version: 1, status: "in_progress", answered: ["name"], skipped: ["focus"],
      completedOn: null, tipDismissedOn: null,
    });
    const resumed = run(null, {
      type: "resume", progress: progressFromWire(wire), firstName: "Kushal", anchor: "msg-9", today: TODAY,
    });
    expect(resumed.state.step).toBe("tone");
    expect(resumed.state.turns).toHaveLength(1);
    expect(resumed.state.turns[0]?.text).toBe("Picking up where we left off. How should I talk with you?");
    expect(resumed.state.turns[0]?.anchor).toBe("msg-9");
  });

  it("closes a flow whose confirmation was lost to a reload, saving nothing", () => {
    const resumed = run(null, {
      type: "resume",
      progress: progressFromWire({
        version: 1, status: "in_progress", answered: ["name", "focus", "tone"], skipped: [],
        completedOn: null, tipDismissedOn: null,
      }),
      firstName: null, anchor: null, today: TODAY,
    });
    expect(resumed.state.turns).toEqual([]);
    expect(resumed.effects).toEqual([
      { type: "persist_progress", progress: expect.objectContaining({ status: "completed", completedOn: TODAY }) },
    ]);
  });
});

describe("tip of the day", () => {
  const completed = {
    version: 1 as const, status: "completed" as const, answered: [], skipped: [],
    completedOn: "2026-09-26", tipDismissedOn: null,
  };

  it("shows one verified starter a day for three days, and never on a dismissed day", () => {
    expect(pickDailyTip(completed, "2026-09-26")).toBeNull();
    const day1 = pickDailyTip(completed, "2026-09-27");
    const day3 = pickDailyTip(completed, "2026-09-29");
    expect(day1 && ALL_WELCOME_PROMPTS.includes(day1)).toBe(true);
    expect(day3 && ALL_WELCOME_PROMPTS.includes(day3)).toBe(true);
    expect(day1).not.toBe(day3);
    expect(pickDailyTip(completed, "2026-09-30")).toBeNull();
    expect(pickDailyTip({ ...completed, tipDismissedOn: "2026-09-27" }, "2026-09-27")).toBeNull();
    expect(pickDailyTip({ ...completed, status: "in_progress" }, "2026-09-27")).toBeNull();
    // Never repeats a starter already on screen.
    expect(pickDailyTip(completed, "2026-09-27", [day1!])).not.toBe(day1);
  });
});

describe("encrypted preference write", () => {
  beforeEach(() => vi.mocked(PkmWriteCoordinator.saveMergedDomain).mockReset());

  it("merges only confirmed answers into identity.communication_preferences", () => {
    const merged = mergeCommunicationPreferences(
      { identity_profile: { full_name: "K T" }, communication_preferences: { preferred_name: "Old" } },
      { name: null, tone: "short_direct" },
      "2026-09-27T00:00:00.000Z",
    );
    expect(merged).toEqual({
      identity_profile: { full_name: "K T" },
      communication_preferences: {
        preferred_name: "Old",
        tone: "direct",
        length: "short",
        updated_at: "2026-09-27T00:00:00.000Z",
      },
    });
  });

  it("writes through the confirmed PKM coordinator and skips the write when nothing was given", async () => {
    vi.mocked(PkmWriteCoordinator.saveMergedDomain).mockResolvedValue({
      saveState: "saved", success: true, fullBlob: {},
    });
    await expect(saveChatOnboardingPreferences({
      userId: "u1", vaultKey: "k", vaultOwnerToken: "t", name: "Kushal", tone: "detailed",
    })).resolves.toBe(true);
    const call = vi.mocked(PkmWriteCoordinator.saveMergedDomain).mock.calls[0]![0];
    expect(call.domain).toBe("identity");
    expect(call.confirmation).toEqual({ confirmedByUser: true, surface: "chat", source: "one_chat_onboarding" });

    vi.mocked(PkmWriteCoordinator.saveMergedDomain).mockClear();
    await saveChatOnboardingPreferences({
      userId: "u1", vaultKey: "k", vaultOwnerToken: "t", name: null, tone: null,
    });
    expect(PkmWriteCoordinator.saveMergedDomain).not.toHaveBeenCalled();
  });
});
