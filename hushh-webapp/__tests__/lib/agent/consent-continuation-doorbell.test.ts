import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the continuation's open path touches these; the doorbell tests never do.
const services = vi.hoisted(() => ({
  getInformationRequest: vi.fn(),
  getInformationRequestExports: vi.fn(),
  readStoredConnector: vi.fn(),
  decryptScopedExport: vi.fn(),
}));
vi.mock("@/lib/services/person-profile-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services/person-profile-service")>()),
  PersonProfileService: {
    getInformationRequest: services.getInformationRequest,
    getInformationRequestExports: services.getInformationRequestExports,
  },
}));
vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({ OneKycClientZkService: {
  readStoredConnector: services.readStoredConnector,
  decryptScopedExport: services.decryptScopedExport,
} }));

import {
  claimConsentContinuation,
  clearSentInformationRequests,
  collectOutgoingRequestCards,
  consentRequestDirectiveDuplicatesAskCard,
  DOORBELL_FAST_WINDOW_MS,
  foldSubmittedRequestReceipts,
  isConsentContinuationUnavailable,
  markConsentContinuationUnavailable,
  mergeServerRedactionFlags,
  prepareConsentContinuation,
  tagAnswersFromLiveAccess,
  informationRequestPhase,
  isConsentContinuationArmed,
  isStaleRestoredAnswer,
  listSentInformationRequests,
  rebuildWaitingRequests,
  redactedConsentAnswers,
  revealConsentContinuationReply,
  setInformationRequestPhase,
  startInformationRequestDoorbell,
  tagConsentContinuationMessages,
  watchSentInformationRequest,
  type InformationRequestDoorbell,
} from "@/lib/agent/consent-continuation";
import {
  CONSENT_OUTCOME_LABELS,
  CONSENT_WIRE_OUTCOME,
  consentAccessEndedChipText,
  consentContinuationSentLabel,
  consentOutcomeDisplayText,
  formatSharedInformationForAgent,
  informationRequestOutcome,
  type ConsentOutcome,
} from "@/lib/consent/open-granted-person-information";
import { parseConsentAccess } from "@/lib/services/agent-chat-client";
import {
  CONSENT_READ_CONCURRENCY,
  CONSENT_READ_SLOT_TIMEOUT_MS,
  readInformationRequest,
  subscribeInformationRequest,
} from "@/lib/consent/information-request-reads";
import {
  LIVE_ACCESS_FAST_WINDOW_MS,
  liveAccessDelayMs,
  liveAccessWatchSnapshot,
  wakeLiveAccessWatch,
  watchLiveAccess,
} from "@/lib/consent/live-access-watch";

const OWNER = "owner-1";
const BUNDLE_A = "0f0e0d0c-0b0a-4908-8706-050403020100";
const BUNDLE_B = "1f1e1d1c-1b1a-4918-9716-151413121110";

/** Seconds (from start) at which `check` ran over the first `untilMs`. */
function checkTimes(
  start: (input: {
    check: () => void;
    hasWaiting: () => boolean;
    waitingSinceMs: () => number | null;
    isVisible: () => boolean;
  }) => { stop: () => void },
  untilMs: number,
): number[] {
  const startedAt = Date.now();
  const times: number[] = [];
  const doorbell = start({
    check: () => times.push((Date.now() - startedAt) / 1000),
    hasWaiting: () => true,
    waitingSinceMs: () => startedAt,
    isVisible: () => true,
  });
  vi.advanceTimersByTime(untilMs);
  doorbell.stop();
  return times;
}

/**
 * The contract: about every 2s for the first five minutes after a send, then
 * 5s until thirty minutes, then 15s (never slower while visible).
 */
function expectAdaptiveCadence(times: number[]): void {
  // Fast window: a check every 2s for the first five minutes.
  expect(times.slice(0, 5)).toEqual([2, 4, 6, 8, 10]);
  expect(times.filter((t) => t <= 300)).toHaveLength(150);
  // Five to thirty minutes: every 5s.
  const steady = times.filter((t) => t > 300 && t <= 1_800);
  expect(steady.slice(0, 3)).toEqual([305, 310, 315]);
  expect(steady).toHaveLength(300);
  // After thirty minutes: every 15s, never slower.
  const slow = times.filter((t) => t > 1_800);
  expect(slow.slice(0, 3)).toEqual([1_815, 1_830, 1_845]);
  const gaps = times.slice(1).map((t, index) => t - times[index]!);
  expect(Math.max(...gaps)).toBe(15);
}

const CADENCE_WINDOW_MS = 1_900_000;

/** A negative control: the old fixed 8s poll, which the contract must reject. */
function startFlatEightSecondPoll(input: { check: () => void }): { stop: () => void } {
  const id = setInterval(input.check, 8_000);
  return { stop: () => clearInterval(id) };
}

/**
 * A negative control: the previous doorbell, 2s for two minutes then 4s, 8s
 * and 15s. Measured 2026-09-28, it made an Allow at minute three take 25s to
 * reach the requester.
 */
function startTwoMinuteBackoffPoll(input: { check: () => void; waitingSinceMs: () => number | null }): { stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let step = 0;
  const schedule = () => {
    const waited = Date.now() - (input.waitingSinceMs() ?? Date.now());
    const delay = waited < 120_000 ? 2_000 : [4_000, 8_000, 15_000][Math.min(step++, 2)]!;
    timer = setTimeout(() => { input.check(); schedule(); }, delay);
  };
  schedule();
  return { stop: () => { if (timer) clearTimeout(timer); } };
}

describe("information request doorbell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    clearSentInformationRequests(null);
  });

  it("checks every 2s for five minutes, every 5s to thirty minutes, then every 15s", () => {
    const times = checkTimes((input) => startInformationRequestDoorbell({ ...input, listen: false }), CADENCE_WINDOW_MS);
    expectAdaptiveCadence(times);
    // An Allow at minute three is seen within about 2s.
    const afterThreeMinutes = times.find((t) => t >= 180)!;
    expect(afterThreeMinutes - 180).toBeLessThanOrEqual(2);
  });

  it("negative control: a flat 8s poll and the old two-minute backoff both fail the cadence check", () => {
    const flat = checkTimes(startFlatEightSecondPoll, CADENCE_WINDOW_MS);
    expect(flat.slice(0, 3)).toEqual([8, 16, 24]);
    expect(() => expectAdaptiveCadence(flat)).toThrow();
    const old = checkTimes(startTwoMinuteBackoffPoll, CADENCE_WINDOW_MS);
    expect(old.filter((t) => t > 120 && t <= 180).length).toBeLessThan(10);
    expect(() => expectAdaptiveCadence(old)).toThrow();
  });

  it("sets no timer at all while nothing waits", () => {
    const check = vi.fn();
    const doorbell = startInformationRequestDoorbell({
      check,
      hasWaiting: () => false,
      waitingSinceMs: () => null,
      isVisible: () => true,
      listen: false,
    });
    vi.advanceTimersByTime(60_000);
    expect(check).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    doorbell.stop();
  });

  it("pauses while the page is hidden and checks at once when it shows again", () => {
    let visibility: DocumentVisibilityState = "visible";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const check = vi.fn();
    const startedAt = Date.now();
    const doorbell = startInformationRequestDoorbell({
      check,
      hasWaiting: () => true,
      waitingSinceMs: () => startedAt,
      isVisible: () => document.visibilityState !== "hidden",
    });
    vi.advanceTimersByTime(4_000);
    expect(check).toHaveBeenCalledTimes(2);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(check).toHaveBeenCalledTimes(2);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    // Instant, not after the next interval.
    expect(check).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(2_000);
    expect(check).toHaveBeenCalledTimes(4);

    // Focus also resumes at once.
    window.dispatchEvent(new Event("focus"));
    expect(check).toHaveBeenCalledTimes(5);
    doorbell.stop();
    spy.mockRestore();
  });

  it("rings instantly and restarts the cadence from that check", () => {
    const check = vi.fn();
    const startedAt = Date.now();
    let doorbell: InformationRequestDoorbell | null = null;
    doorbell = startInformationRequestDoorbell({
      check,
      hasWaiting: () => true,
      waitingSinceMs: () => startedAt,
      isVisible: () => true,
      listen: false,
    });
    vi.advanceTimersByTime(1_000);
    doorbell.ring();
    expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_999);
    expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(check).toHaveBeenCalledTimes(2);
    doorbell.stop();
  });

  it("gives a newly sent request the fast cadence again after a backoff", () => {
    const check = vi.fn();
    let since = Date.now();
    const doorbell = startInformationRequestDoorbell({
      check,
      hasWaiting: () => true,
      waitingSinceMs: () => since,
      isVisible: () => true,
      listen: false,
    });
    vi.advanceTimersByTime(DOORBELL_FAST_WINDOW_MS + 30_000);
    since = Date.now();
    doorbell.ring();
    check.mockClear();
    vi.advanceTimersByTime(6_000);
    expect(check).toHaveBeenCalledTimes(3);
    doorbell.stop();
  });
});

describe("durable waiting after a reload", () => {
  afterEach(() => clearSentInformationRequests(null));

  const card = (bundleId: string, personName: string, labels: string[]) => ({
    id: `msg-${bundleId}`,
    role: "assistant" as const,
    text: "",
    structuredExperiences: [{
      experience: {
        type: "one.information_request_review.v1" as const,
        personName,
        purpose: "Plan dinner",
        durationLabel: "7 days",
        direction: "outgoing" as const,
        phase: "submitted" as const,
        subjectRef: `person-${personName}`,
        bundleId,
        requestId: null,
        status: "pending" as const,
        fields: labels.map((label) => ({ label, domain: "food", sensitivity: "standard" as const })),
      },
    }],
  });

  it("rebuilds the waiting set from saved outgoing cards not yet continued", () => {
    // The in-memory set is empty, as after a reload.
    expect(listSentInformationRequests(OWNER)).toEqual([]);
    const messages = [
      { id: "u1", role: "user" as const, text: "Ask Kushal about food" },
      card(BUNDLE_A, "Kushal", ["Food preferences"]),
      card(BUNDLE_B, "Maya", ["Travel"]),
    ];
    const cards = collectOutgoingRequestCards(messages);
    expect(cards.map((entry) => entry.bundleId)).toEqual([BUNDLE_A, BUNDLE_B]);

    // BUNDLE_B was already continued (the server's one-time marker).
    const rebuilt = rebuildWaitingRequests({
      ownerId: OWNER,
      conversationId: "conversation-1",
      cards,
      continued: { [BUNDLE_B]: "granted" },
    });
    expect(rebuilt.map((request) => request.bundleId)).toEqual([BUNDLE_A]);
    for (const request of rebuilt) watchSentInformationRequest(request);

    expect(listSentInformationRequests(OWNER)).toEqual([
      expect.objectContaining({ bundleId: BUNDLE_A, conversationId: "conversation-1", personName: "Kushal", restored: true }),
    ]);
    // Rebuilt means armed: the card continues the answer that landed while closed.
    expect(isConsentContinuationArmed(OWNER, BUNDLE_A)).toBe(true);
    expect(isConsentContinuationArmed(OWNER, BUNDLE_B)).toBe(false);
  });

  it("never re-arms an answer this tab already claimed", () => {
    expect(claimConsentContinuation(OWNER, BUNDLE_A)).toBe(true);
    watchSentInformationRequest({
      ownerId: OWNER, bundleId: BUNDLE_A, conversationId: "c", subjectRef: "s", personName: "Kushal", restored: true,
    });
    expect(isConsentContinuationArmed(OWNER, BUNDLE_A)).toBe(false);
  });

  it("leaves an answer decided long ago alone", () => {
    const now = Date.parse("2026-09-28T10:00:00Z");
    expect(isStaleRestoredAnswer({ progress: { decided_at: "2026-09-01T10:00:00Z" } }, now)).toBe(true);
    expect(isStaleRestoredAnswer({ progress: { decided_at: "2026-09-27T10:00:00Z" } }, now)).toBe(false);
    expect(isStaleRestoredAnswer({}, now)).toBe(false);
  });
});

describe("outcome chip: human display, fixed sent label", () => {
  const consentContinuationPy = readFileSync(
    path.resolve(__dirname, "../../../../consent-protocol/hushh_mcp/one_adk/consent_continuation.py"),
    "utf8",
  );
  const serverLabels = Object.fromEntries(
    [...(consentContinuationPy.match(/CONSENT_OUTCOME_LABELS[^{]*\{([^}]*)\}/)?.[1] ?? "")
      .matchAll(/"([a-z_]+)":\s*"([^"]+)"/g)]
      .map((match) => [match[1], match[2]]),
  ) as Record<string, string>;

  it("sends exactly the server's admission labels", () => {
    expect(Object.keys(serverLabels).length).toBeGreaterThanOrEqual(5);
    expect(serverLabels).toEqual(CONSENT_OUTCOME_LABELS);
    for (const [outcome, label] of Object.entries(CONSENT_OUTCOME_LABELS)) {
      expect(serverLabels[outcome]).toBe(label);
    }
    const outcomes: ConsentOutcome[] = ["granted", "partially_granted", "denied", "expired", "revoked"];
    for (const outcome of outcomes) {
      const sent = consentContinuationSentLabel(outcome);
      const wire = CONSENT_WIRE_OUTCOME[outcome];
      // Whatever the server admits for an outcome it knows, the client sends verbatim.
      expect(sent).toBe(serverLabels[outcome] ?? serverLabels[wire]);
      expect(Object.values(serverLabels)).toContain(sent);
    }
  });

  it("guards integration: a new server outcome must be sent as itself", () => {
    // When the server learns partially_granted or revoked, its bundle_outcome
    // reports them, so the client must send them as themselves, not mapped.
    for (const outcome of ["partially_granted", "revoked"] as const) {
      if (serverLabels[outcome]) expect(CONSENT_WIRE_OUTCOME[outcome]).toBe(outcome);
    }
  });

  it("shows people what happened in words", () => {
    expect(consentOutcomeDisplayText({ outcome: "granted", personName: "Kushal", sharedLabels: ["Food preferences"] }))
      .toBe("Kushal shared Food preferences");
    expect(consentOutcomeDisplayText({ outcome: "denied", personName: "Kushal" })).toBe("Kushal declined");
    expect(consentOutcomeDisplayText({ outcome: "expired", personName: "Kushal" })).toBe("Kushal's request expired");
    expect(consentOutcomeDisplayText({ outcome: "partially_granted", personName: "Kushal", sharedLabels: ["Food preferences"] }))
      .toBe("Kushal shared Food preferences and declined the rest");
    expect(consentOutcomeDisplayText({ outcome: "revoked", personName: "Kushal", sharedLabels: ["Food preferences", "Travel", "Music"] }))
      .toBe("Kushal stopped sharing Food preferences, Travel and Music");
    // Display copy is never what is sent.
    expect(consentOutcomeDisplayText({ outcome: "granted", personName: "Kushal", sharedLabels: ["Food preferences"] }))
      .not.toBe(consentContinuationSentLabel("granted"));
    for (const outcome of ["granted", "partially_granted", "denied", "expired", "revoked"] as const) {
      const text = consentOutcomeDisplayText({ outcome, personName: "Kushal", sharedLabels: ["Food preferences"] });
      expect(text).not.toMatch(/—|PKM|grant|scope/i);
    }
  });

  it("reads partial and revoked outcomes, and prefers the server's progress outcome", () => {
    const item = (status: "granted" | "denied" | "revoked" | "expired" | "pending") => ({
      requestId: status, scopeRef: "s", label: status, sensitivity: null, status,
    });
    expect(informationRequestOutcome({ cancelled: false, items: [item("granted")] })).toBe("granted");
    expect(informationRequestOutcome({ cancelled: false, items: [item("granted"), item("denied")] })).toBe("partially_granted");
    expect(informationRequestOutcome({ cancelled: false, items: [item("revoked")] })).toBe("revoked");
    expect(informationRequestOutcome({ cancelled: false, items: [item("expired")] })).toBe("expired");
    expect(informationRequestOutcome({ cancelled: false, items: [item("granted"), item("pending")] })).toBeNull();
    expect(informationRequestOutcome({
      cancelled: false,
      items: [item("granted")],
      progress: { outcome: "revoked" },
    } as Parameters<typeof informationRequestOutcome>[0])).toBe("revoked");
    // Every rich outcome travels as itself: the server's progress.outcome
    // distinguishes them and admission refuses a mapped one.
    expect(CONSENT_WIRE_OUTCOME.partially_granted).toBe("partially_granted");
    expect(CONSENT_WIRE_OUTCOME.revoked).toBe("revoked");
  });
});

describe("continuation answers and access ended", () => {
  const cardMessage = (bundleId: string) => ({
    id: `card-${bundleId}`,
    role: "assistant" as const,
    text: "",
    structuredExperiences: [{
      experience: {
        type: "one.information_request_review.v1" as const,
        personName: "Kushal",
        purpose: "Plan dinner",
        durationLabel: "7 days",
        direction: "outgoing" as const,
        phase: "submitted" as const,
        subjectRef: "person-kushal",
        bundleId,
        requestId: null,
        status: "granted" as const,
        fields: [{ label: "Food preferences", domain: "food", sensitivity: "standard" as const }],
      },
    }],
  });

  it("tags the chip and One's answer with the bundle, then hides only shared answers on revoke", () => {
    const messages = [
      cardMessage(BUNDLE_A),
      cardMessage(BUNDLE_B),
      { id: "chip-a", role: "user" as const, kind: "selection" as const, text: "Consent approved" },
      { id: "answer-a", role: "assistant" as const, text: "Kushal likes Thai food." },
      { id: "chip-b", role: "user" as const, kind: "selection" as const, text: "Request declined" },
      { id: "answer-b", role: "assistant" as const, text: "Kushal declined." },
      { id: "later", role: "user" as const, text: "Thanks" },
      { id: "later-answer", role: "assistant" as const, text: "Anytime." },
    ];
    const cards = collectOutgoingRequestCards(messages);
    const tags = tagConsentContinuationMessages({
      messages,
      cards,
      continued: { [BUNDLE_A]: "granted", [BUNDLE_B]: "denied" },
    });
    expect(tags.get("chip-a")).toEqual({ bundleId: BUNDLE_A, continuedOutcome: "granted", role: "chip" });
    expect(tags.get("answer-a")).toEqual({ bundleId: BUNDLE_A, continuedOutcome: "granted", role: "answer" });
    expect(tags.get("answer-b")).toEqual({ bundleId: BUNDLE_B, continuedOutcome: "denied", role: "answer" });
    expect(tags.has("later-answer")).toBe(false);

    // While sharing holds, nothing is hidden.
    expect(redactedConsentAnswers({ tags, liveOutcomes: { [BUNDLE_A]: "granted" } }).size).toBe(0);
    // Revoked: One's answer from it is hidden; the declined answer and chips stay.
    const hidden = redactedConsentAnswers({
      tags,
      liveOutcomes: { [BUNDLE_A]: "revoked", [BUNDLE_B]: "expired" },
    });
    expect([...hidden]).toEqual(["answer-a"]);
    // Expired access hides it too.
    expect([...redactedConsentAnswers({ tags, liveOutcomes: { [BUNDLE_A]: "expired" } })]).toEqual(["answer-a"]);
  });

  it("uses the server's bundle tag and redaction flag when present", () => {
    const messages = [
      cardMessage(BUNDLE_A),
      cardMessage(BUNDLE_B),
      { id: "chip", role: "user" as const, kind: "selection" as const, text: "Consent approved", consentBundleId: BUNDLE_B },
      { id: "answer", role: "assistant" as const, text: "From Kushal", consentBundleId: BUNDLE_B },
    ];
    const tags = tagConsentContinuationMessages({
      messages,
      cards: collectOutgoingRequestCards(messages),
      continued: { [BUNDLE_A]: "granted", [BUNDLE_B]: "granted" },
    });
    expect(tags.get("answer")?.bundleId).toBe(BUNDLE_B);
    expect([...redactedConsentAnswers({ tags, liveOutcomes: { [BUNDLE_B]: "revoked" } })]).toEqual(["answer"]);
    expect([...redactedConsentAnswers({ tags, liveOutcomes: {}, serverRedacted: new Set(["answer"]) })])
      .toEqual(["answer"]);
  });

  it("hides every server-tagged answer from a partial approval, and a second chip for the same bundle", () => {
    // Lane A tags EVERY answer while access was live, then "Access ended" may
    // continue the same bundle once more.
    const messages = [
      cardMessage(BUNDLE_A),
      { id: "chip", role: "user" as const, kind: "selection" as const, text: "Partly approved", consentBundleId: BUNDLE_A },
      { id: "answer-1", role: "assistant" as const, text: "From Kushal", consentBundleId: BUNDLE_A },
      { id: "ask-again", role: "user" as const, text: "And dessert?" },
      { id: "answer-2", role: "assistant" as const, text: "Still from Kushal", consentBundleId: BUNDLE_A },
      { id: "ended-chip", role: "user" as const, kind: "selection" as const, text: "Access ended", consentBundleId: BUNDLE_A },
    ];
    const tags = tagConsentContinuationMessages({
      messages,
      cards: collectOutgoingRequestCards(messages),
      continued: { [BUNDLE_A]: "partially_granted" },
    });
    expect(tags.get("chip")).toEqual({ bundleId: BUNDLE_A, continuedOutcome: "partially_granted", role: "chip" });
    expect(tags.get("ended-chip")).toEqual({ bundleId: BUNDLE_A, continuedOutcome: "revoked", role: "chip" });
    expect([...redactedConsentAnswers({ tags, liveOutcomes: { [BUNDLE_A]: "revoked" } })].sort())
      .toEqual(["answer-1", "answer-2"]);
  });

  // Localhost run 2026-09-28 (screenshot 16): after a stop to sharing, the
  // follow-up the person typed while access was live ("What's Kushal's
  // favorite restaurant?") kept "Nopa" on screen until a reload.
  it("hides a live follow-up answer at once when sharing ends, and nothing after the end", () => {
    const messages = [
      cardMessage(BUNDLE_A),
      cardMessage(BUNDLE_B),
      { id: "chip", role: "user" as const, kind: "selection" as const, text: "Consent approved", consentBundleId: BUNDLE_A },
      { id: "answer", role: "assistant" as const, text: "Nopa", consentBundleId: BUNDLE_A },
      { id: "ask", role: "user" as const, text: "What's Kushal's favorite restaurant?" },
      { id: "follow-up", role: "assistant" as const, text: "Nopa, again" },
      { id: "other", role: "assistant" as const, text: "From Priya", consentBundleId: BUNDLE_B },
      { id: "ended-chip", role: "user" as const, kind: "selection" as const, text: "Access ended", consentBundleId: BUNDLE_A },
      { id: "after-end", role: "assistant" as const, text: "Kushal stopped sharing." },
    ];
    const continued = { [BUNDLE_A]: "granted", [BUNDLE_B]: "granted" };
    const tagsBefore = tagConsentContinuationMessages({ messages, cards: collectOutgoingRequestCards(messages), continued });
    // Negative control: without the live tag only the continuation answer hides.
    expect([...redactedConsentAnswers({ tags: tagsBefore, liveOutcomes: { [BUNDLE_A]: "revoked" } })]).toEqual(["answer"]);

    const tagged = tagAnswersFromLiveAccess({ messages, bundleId: BUNDLE_A, tags: tagsBefore });
    const tags = tagConsentContinuationMessages({ messages: tagged, cards: collectOutgoingRequestCards(tagged), continued });
    expect([...redactedConsentAnswers({ tags, liveOutcomes: { [BUNDLE_A]: "revoked" } })].sort())
      .toEqual(["answer", "follow-up"]);
    expect(tagged.find((message) => message.id === "other")?.consentBundleId).toBe(BUNDLE_B);
    expect(tagged.find((message) => message.id === "after-end")?.consentBundleId).toBeUndefined();
    // Idempotent: a second pass changes nothing.
    expect(tagAnswersFromLiveAccess({ messages: tagged, bundleId: BUNDLE_A, tags })).toBe(tagged);
  });

  // Run 4 (P1c): stopping Food blanked a still-live Events request card and
  // its answers in the same chat, all labelled "Food preferences".
  it("with two requests in one chat, hides only what came from the one that ended", () => {
    const askCard = (id: string) => ({ id, role: "assistant" as const, text: "I'll ask Kushal. Here's what I'd request:",
      structuredExperiences: [{ experience: { type: "one.scope_discovery.v1" as const } }] });
    const messages = [
      cardMessage(BUNDLE_A),
      { id: "chip-a", role: "user" as const, kind: "selection" as const, text: "Consent approved", consentBundleId: BUNDLE_A },
      { id: "answer-a", role: "assistant" as const, text: "Nopa", consentBundleId: BUNDLE_A },
      { id: "ask-a", role: "user" as const, text: "And dessert?" },
      { id: "follow-up-a", role: "assistant" as const, text: "Tartine, after Nopa" },
      { id: "ask-events", role: "user" as const, text: "What events is Kushal going to?" },
      askCard("events-ask-card"),
      cardMessage(BUNDLE_B),
      { id: "chip-b", role: "user" as const, kind: "selection" as const, text: "Consent approved", consentBundleId: BUNDLE_B },
      { id: "answer-b", role: "assistant" as const, text: "The jazz night on Friday" },
      { id: "ask-b", role: "user" as const, text: "What time?" },
      { id: "follow-up-b", role: "assistant" as const, text: "8pm" },
    ];
    const continued = { [BUNDLE_A]: "granted", [BUNDLE_B]: "granted" };
    const tagsOf = (list: typeof messages) =>
      tagConsentContinuationMessages({ messages: list, cards: collectOutgoingRequestCards(list), continued });

    // Food stops while Events is still live.
    const tagged = tagAnswersFromLiveAccess({
      messages, bundleId: BUNDLE_A, tags: tagsOf(messages), liveOutcomes: { [BUNDLE_A]: "revoked", [BUNDLE_B]: "granted" },
    });
    const tags = tagsOf(tagged);
    const hidden = redactedConsentAnswers({ tags, liveOutcomes: { [BUNDLE_A]: "revoked", [BUNDLE_B]: "granted" } });
    expect([...hidden].sort()).toEqual(["answer-a", "follow-up-a"]);
    // Events' ask card, its request card and every Events answer stay, untouched.
    for (const id of ["events-ask-card", `card-${BUNDLE_B}`, "answer-b", "follow-up-b"]) {
      expect(tagged.find((message) => message.id === id)?.consentBundleId).not.toBe(BUNDLE_A);
    }
    // The hidden answers carry Food's own tag, so they read Food's labels.
    expect([...hidden].map((id) => tags.get(id)?.bundleId)).toEqual([BUNDLE_A, BUNDLE_A]);

    // Control: with Events ended too, nothing live bounds Food's window any
    // more, so the untagged Events follow-ups hide as well.
    const bothEnded = tagAnswersFromLiveAccess({
      messages, bundleId: BUNDLE_A, tags: tagsOf(messages), liveOutcomes: { [BUNDLE_A]: "revoked", [BUNDLE_B]: "revoked" },
    });
    expect(bothEnded.find((message) => message.id === "follow-up-b")?.consentBundleId).toBe(BUNDLE_A);
    // Even then a request card is never taken for an answer.
    expect(bothEnded.find((message) => message.id === "events-ask-card")?.consentBundleId).toBeUndefined();
  });

  it("wires the access watch to hide every answer and re-read the server's flags when sharing ends", () => {
    const workspace = readFileSync(path.join(process.cwd(), "components/agent/agent-chat-workspace.tsx"), "utf8");
    expect(workspace).toContain("if (isAccessEndedOutcome(outcome)) hideAnswersFromEndedAccess(bundleId, token);");
    const hide = workspace.slice(workspace.indexOf("const hideAnswersFromEndedAccess"), workspace.indexOf("// Answers from shared information"));
    expect(hide).toContain("tagAnswersFromLiveAccess({");
    expect(hide).toContain("force: true,");
    expect(hide).toContain("mergeServerRedactionFlags(current, server)");
  });

  it("merges the server's redaction flags by server message id without touching anything else", () => {
    const live = [
      { id: "msg-1-assistant", serverMessageId: "srv-9", role: "assistant" as const, text: "Nopa" },
      { id: "msg-2-assistant", serverMessageId: "srv-10", role: "assistant" as const, text: "Weather" },
    ];
    const merged = mergeServerRedactionFlags(live, [
      { id: "srv-9", consentBundleId: BUNDLE_A.toUpperCase(), consentAccessEnded: true },
      { id: "srv-10" },
    ]);
    expect(merged[0]).toEqual({ ...live[0], consentBundleId: BUNDLE_A, consentAccessEnded: true });
    expect(merged[1]).toBe(live[1]);
    expect(mergeServerRedactionFlags(live, [{ id: "srv-10" }])).toBe(live);
  });

  it("reads the server's consentAccess names and labels, with the response map as the reason", () => {
    const access = parseConsentAccess(
      { bundleId: BUNDLE_A, state: "ended", outcome: null, personName: "Kushal Trivedi", labels: ["Food preferences", 7] },
      { [BUNDLE_A]: "expired" },
    );
    expect(access).toEqual({
      bundleId: BUNDLE_A, state: "ended", outcome: "expired", personName: "Kushal Trivedi", labels: ["Food preferences"],
    });
    expect(parseConsentAccess({ bundleId: BUNDLE_A, state: "live", outcome: null, personName: null, labels: [] }))
      .toMatchObject({ state: "live", outcome: null });
    expect(parseConsentAccess({ state: "ended" })).toBeUndefined();
    expect(parseConsentAccess("ended")).toBeUndefined();
  });
});

describe("continuation presentation", () => {
  afterEach(() => clearSentInformationRequests(null));

  it("moves the card from reading to answered", () => {
    expect(informationRequestPhase(OWNER, BUNDLE_A)).toBeNull();
    setInformationRequestPhase(OWNER, BUNDLE_A, "reading");
    expect(informationRequestPhase(OWNER, BUNDLE_A)).toBe("reading");
    setInformationRequestPhase(OWNER, BUNDLE_A, "answered");
    expect(informationRequestPhase(OWNER, BUNDLE_A)).toBe("answered");
    clearSentInformationRequests("someone-else");
    expect(informationRequestPhase(OWNER, BUNDLE_A)).toBeNull();
  });

  it("brings the reply into view even after the reader scrolled up", () => {
    const refs = { userScrolled: { current: true }, scrollToSubmittedTurn: { current: false } };
    revealConsentContinuationReply(refs);
    expect(refs).toEqual({ userScrolled: { current: false }, scrollToSubmittedTurn: { current: true } });
  });
});

// --- Fix round 2026-09-28 (localhost run): receipt, one Send, reload, revoke --

const PERSON = "11111111-1111-4111-8111-111111111111";
const OTHER_PERSON = "22222222-2222-4222-8222-222222222222";

function review(phase: "draft" | "submitted", subjectRef: string, bundleId: string | null) {
  return {
    type: "one.information_request_review.v1" as const,
    personName: "Kushal Trivedi",
    purpose: "Planning a dinner for Kushal",
    durationLabel: "7 days",
    direction: "outgoing" as const,
    phase,
    subjectRef,
    bundleId,
    requestId: null,
    status: phase === "draft" ? "awaiting_review" as const : "pending" as const,
    fields: [{ label: phase === "draft" ? "Kind" : "Food preferences", domain: "Information", sensitivity: "standard" as const }],
  };
}

function askCard(personRef: string) {
  return {
    type: "one.scope_discovery.v1" as const,
    person: { personRef, displayName: "Kushal Trivedi", profilePath: `/people/${personRef}`, relationship: "connected" },
    domainFilter: null,
    scopes: [],
    proposal: { proposed: [{ scopeRef: "psr_food", label: "Food preferences", why: null }], durationHours: 168, reasonSuggestion: "dinner" },
  };
}

describe("one Send per ask", () => {
  const withCard = (experience: object) => [{ structuredExperiences: [{ id: "card", experience: experience as never }] }];

  it("hides a consent.request bar while that person's ask card, or the card it became, is on screen", () => {
    const directive = { actionId: "consent.request", slots: { personRef: PERSON, labels: ["Kind"] } };
    expect(consentRequestDirectiveDuplicatesAskCard({ ...directive, messages: withCard(askCard(PERSON)) })).toBe(true);
    // After Send the ask card is the sent card: still no second Send.
    expect(consentRequestDirectiveDuplicatesAskCard({ ...directive, messages: withCard(review("submitted", PERSON, BUNDLE_A)) })).toBe(true);
    // A directive that names nobody is a duplicate once any ask card shows.
    expect(consentRequestDirectiveDuplicatesAskCard({ actionId: "consent.request", slots: {}, messages: withCard(askCard(PERSON)) })).toBe(true);
  });

  it("negative control: keeps the bar with no ask card, for another person, or for another action", () => {
    const directive = { actionId: "consent.request", slots: { personRef: PERSON } };
    expect(consentRequestDirectiveDuplicatesAskCard({ ...directive, messages: [{ structuredExperiences: [] }] })).toBe(false);
    expect(consentRequestDirectiveDuplicatesAskCard({ ...directive, messages: withCard(askCard(OTHER_PERSON)) })).toBe(false);
    expect(consentRequestDirectiveDuplicatesAskCard({ actionId: "consent.revoke", slots: {}, messages: withCard(askCard(PERSON)) })).toBe(false);
  });
});

describe("a sent request after a reload", () => {
  it("restores in place as sent: the receipt replaces the explanatory draft, never 'Not sent yet'", () => {
    const messages = [
      { id: "q", role: "user" as const, text: "What's Kushal's favorite restaurant?" },
      { id: "turn", role: "assistant" as const, text: "I'll ask Kushal Trivedi.",
        structuredExperiences: [{ id: "evt:propose-call", experience: review("draft", PERSON, null) }] },
      { id: "receipt", role: "assistant" as const, text: "",
        structuredExperiences: [{ id: "request_submission_x", experience: review("submitted", PERSON, BUNDLE_A) }] },
    ];
    const folded = foldSubmittedRequestReceipts(messages);
    expect(folded.map((message) => message.id)).toEqual(["q", "turn"]);
    const card = folded[1]!.structuredExperiences![0]!;
    expect(card.id).toBe("evt:propose-call");
    expect(card.experience).toMatchObject({ phase: "submitted", bundleId: BUNDLE_A, status: "pending" });
    // The restored card is a real outgoing card: the chat waits for its answer again.
    expect(collectOutgoingRequestCards(folded).map((entry) => entry.bundleId)).toEqual([BUNDLE_A]);
  });

  it("negative control: a draft for someone else, or one never sent, stays as it was", () => {
    const messages = [
      { id: "turn", role: "assistant" as const, text: "",
        structuredExperiences: [{ id: "draft", experience: review("draft", OTHER_PERSON, null) }] },
      { id: "receipt", role: "assistant" as const, text: "",
        structuredExperiences: [{ id: "sent", experience: review("submitted", PERSON, BUNDLE_A) }] },
    ];
    expect(foldSubmittedRequestReceipts(messages)).toBe(messages);
  });

  it("restores the continuation label as the human chip even when the server never recorded it", () => {
    // History after the 409: the label came back as a plain user turn.
    const messages = [
      { id: "turn", role: "assistant" as const, text: "",
        structuredExperiences: [{ id: "c", experience: review("submitted", PERSON, BUNDLE_A) }] },
      { id: "chip", role: "user" as const, kind: "selection" as const, text: "Consent approved" },
      { id: "answer", role: "assistant" as const, text: "Kushal likes Nopa." },
    ];
    const cards = collectOutgoingRequestCards(messages);
    const tags = tagConsentContinuationMessages({ messages, cards, continued: {} });
    expect(tags.get("chip")).toEqual({ bundleId: BUNDLE_A, continuedOutcome: "granted", role: "chip" });
    expect(consentOutcomeDisplayText({ outcome: "granted", personName: "Kushal", sharedLabels: cards[0]!.labels }))
      .toBe("Kushal shared Food preferences");
    // And that answer is hidden once access ends, like any answer from shared information.
    expect([...redactedConsentAnswers({ tags, liveOutcomes: { [BUNDLE_A]: "revoked" } })]).toEqual(["answer"]);
  });
});

describe("a request whose receipt was not recorded", () => {
  afterEach(() => clearSentInformationRequests(null));

  it("never auto-continues (the server would refuse with 409), while the card still reads its answer", () => {
    watchSentInformationRequest({ ownerId: OWNER, bundleId: BUNDLE_A, conversationId: "c1", subjectRef: PERSON, personName: "Kushal" });
    expect(isConsentContinuationArmed(OWNER, BUNDLE_A)).toBe(true);
    markConsentContinuationUnavailable(OWNER, BUNDLE_A);
    expect(isConsentContinuationUnavailable(OWNER, BUNDLE_A)).toBe(true);
    expect(isConsentContinuationArmed(OWNER, BUNDLE_A)).toBe(false);
    expect(claimConsentContinuation(OWNER, BUNDLE_A)).toBe(false);
    // Another request is unaffected.
    watchSentInformationRequest({ ownerId: OWNER, bundleId: BUNDLE_B, conversationId: "c1", subjectRef: PERSON, personName: "Kushal" });
    expect(claimConsentContinuation(OWNER, BUNDLE_B)).toBe(true);
  });
});

describe("watching live access for its end: one shared watch", () => {
  const bundleFor = (bundleId: string, status: "granted" | "revoked" = "granted") => ({
    bundleId, personRef: "person-kushal", purpose: "Plan dinner", durationSeconds: 604_800, cancelled: false,
    items: [{ requestId: `r-${bundleId}`, scopeRef: "s1", label: "Food preferences", sensitivity: "standard", status }],
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T10:00:00Z"));
    services.getInformationRequest.mockReset();
    services.getInformationRequest.mockImplementation(async ({ bundleId }: { bundleId: string }) => bundleFor(bundleId));
  });
  afterEach(() => {
    clearSentInformationRequests(null);
    vi.useRealTimers();
  });

  /** Seconds (from start) at which `bundleId` was read over the first `untilMs`. */
  async function readTimes(bundleId: string, untilMs: number, startedAt: number): Promise<number[]> {
    const times: number[] = [];
    services.getInformationRequest.mockImplementation(async (input: { bundleId: string }) => {
      if (input.bundleId === bundleId) times.push((Date.now() - startedAt) / 1000);
      return bundleFor(input.bundleId);
    });
    await vi.advanceTimersByTimeAsync(untilMs);
    return times;
  }

  // Run 4 (P1a): the request card took 20-26s to read "Access ended".
  it("checks about every 5s for the first minute after an answer, then every 10s", async () => {
    const startedAt = Date.now();
    const release = watchLiveAccess({ bundleId: BUNDLE_A, vaultOwnerToken: "owner-token" });
    const times = await readTimes(BUNDLE_A, 120_000, startedAt);
    release();
    expect(times.filter((t) => t <= 60)).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]);
    expect(times.filter((t) => t > 60)).toEqual([70, 80, 90, 100, 110, 120]);
    expect(liveAccessDelayMs(0)).toBe(5_000);
    expect(liveAccessDelayMs(LIVE_ACCESS_FAST_WINDOW_MS)).toBe(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Run 4 (R3): the same bundle was read two to four times per tick, once by
  // each surface that showed it.
  it("reads each bundle once per tick however many surfaces watch it", async () => {
    const startedAt = Date.now();
    const releases = [
      watchLiveAccess({ bundleId: BUNDLE_A, vaultOwnerToken: "owner-token" }), // the chat
      watchLiveAccess({ bundleId: BUNDLE_A, vaultOwnerToken: "owner-token" }), // the request card
      watchLiveAccess({ bundleId: BUNDLE_A, vaultOwnerToken: "owner-token" }), // the secure card
      watchLiveAccess({ bundleId: BUNDLE_B, vaultOwnerToken: "owner-token" }),
    ];
    const heard: string[] = [];
    const unsubscribe = subscribeInformationRequest(BUNDLE_A, (bundle) => heard.push(bundle.bundleId));
    const times = await readTimes(BUNDLE_A, 60_000, startedAt);
    expect(times).toHaveLength(12);
    const calls = services.getInformationRequest.mock.calls.map(([input]) => (input as { bundleId: string }).bundleId);
    expect(calls.filter((id) => id === BUNDLE_B)).toHaveLength(12);
    // Every surface hears every reading.
    expect(heard).toHaveLength(12);
    // Releasing two of three holders keeps the bundle watched; the last one stops it.
    releases[0]!(); releases[1]!();
    expect(liveAccessWatchSnapshot().bundles).toContain(BUNDLE_A);
    releases[2]!(); releases[3]!();
    expect(liveAccessWatchSnapshot().bundles).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });

  it("negative control: one watch per surface reads the same bundle three times per tick", async () => {
    // What each surface did on its own before: a private 10s timer and read.
    const ids = [1, 2, 3].map(() => setInterval(() => {
      void services.getInformationRequest({ bundleId: BUNDLE_A, vaultOwnerToken: "owner-token" });
    }, 10_000));
    await vi.advanceTimersByTimeAsync(60_000);
    ids.forEach(clearInterval);
    expect(services.getInformationRequest).toHaveBeenCalledTimes(18);
  });

  it("pauses while hidden and checks at once when woken", async () => {
    let visibility: DocumentVisibilityState = "visible";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const release = watchLiveAccess({ bundleId: BUNDLE_A, vaultOwnerToken: "owner-token" });
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(services.getInformationRequest).not.toHaveBeenCalled();
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(services.getInformationRequest).toHaveBeenCalledTimes(1);
    // A push or live event wakes it; its listeners share the one read.
    services.getInformationRequest.mockImplementation(() => new Promise(() => undefined));
    wakeLiveAccessWatch();
    void readInformationRequest({ bundleId: BUNDLE_A, vaultOwnerToken: "owner-token", joinWithinMs: 250 });
    await vi.advanceTimersByTimeAsync(0);
    expect(services.getInformationRequest).toHaveBeenCalledTimes(2);
    release();
    spy.mockRestore();
  });

  it("caps reads app-wide and gives a hung read's slot back", async () => {
    const pending: Array<(value: unknown) => void> = [];
    services.getInformationRequest.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    const bundles = ["a", "b", "c", "d"].map((letter) => `${letter}0000000-0000-4000-8000-000000000000`);
    for (const bundleId of bundles) void readInformationRequest({ bundleId, vaultOwnerToken: "owner-token" }).catch(() => undefined);
    // The same bundle twice: one request.
    void readInformationRequest({ bundleId: bundles[0]!, vaultOwnerToken: "owner-token" });
    await vi.advanceTimersByTimeAsync(0);
    expect(services.getInformationRequest).toHaveBeenCalledTimes(CONSENT_READ_CONCURRENCY);
    pending[0]!(bundleFor(bundles[0]!));
    await vi.advanceTimersByTimeAsync(0);
    expect(services.getInformationRequest).toHaveBeenCalledTimes(3);
    // The second read hangs: after the slot timeout the last one still starts.
    await vi.advanceTimersByTimeAsync(CONSENT_READ_SLOT_TIMEOUT_MS);
    expect(services.getInformationRequest).toHaveBeenCalledTimes(4);
    // A re-check after decrypting never shares a read already on the wire.
    void readInformationRequest({ bundleId: bundles[3]!, vaultOwnerToken: "owner-token", fresh: true }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(CONSENT_READ_SLOT_TIMEOUT_MS);
    expect(services.getInformationRequest).toHaveBeenCalledTimes(5);
  });

  it("words the shared chip in its ended form", () => {
    expect(consentAccessEndedChipText({ reason: "revoked", personName: "Kushal", sharedLabels: ["Food preferences"] }))
      .toBe("Kushal stopped sharing Food preferences");
    expect(consentAccessEndedChipText({ reason: "expired", personName: "Kushal", sharedLabels: ["Food preferences"] }))
      .toBe("Access to Food preferences ended");
  });
});

describe("sensitive information never reaches the model (CONTRACT-2 C7)", () => {
  const SUBJECT = "manish_public_ref_0001";
  // "Head of household": a key that is itself the answer. Counted, never named.
  const TAX = { filing_year: 2024, adjusted_gross_income: 85000, filing_status: "Married filing jointly", "Head of household": false };
  const MEDS = { medication: "Atorvastatin 20mg", dose_time: "Every evening" };
  const FOOD = { cuisine: "Neapolitan pizza" };
  const HOBBIES = { weekend: "Sailing in Sausalito" };
  const SECRETS = ["85000", "Married filing jointly", "2024", "Head of household", "Atorvastatin", "Every evening", "Sailing"];
  const items = [
    // An older server may call tax "standard"; the tax family is sensitive regardless.
    { requestId: "req_tax_000001", scopeRef: "s-tax", label: "Tax record", sensitivity: "standard", status: "granted" },
    // A harmless label, but the scope is health: sensitive from progress.fields[].scope.
    { requestId: "req_meds_00001", scopeRef: "s-meds", label: "Daily routine", sensitivity: null, status: "granted" },
    { requestId: "req_food_00001", scopeRef: "s-food", label: "Food preferences", sensitivity: "standard", status: "granted" },
    // Nothing says what this is: deny by default.
    { requestId: "req_hobby_0001", scopeRef: "s-hobby", label: "Hobbies", sensitivity: null, status: "granted" },
  ];
  const valuesByRequest: Record<string, Record<string, unknown>> = {
    req_tax_000001: TAX, req_meds_00001: MEDS, req_food_00001: FOOD, req_hobby_0001: HOBBIES,
  };

  beforeEach(() => {
    services.getInformationRequest.mockResolvedValue({
      bundleId: BUNDLE_A, personRef: SUBJECT, purpose: "Preparing the joint return", durationSeconds: 86400,
      cancelled: false, items,
      progress: { requested_at: "2026-09-28T10:00:00Z", outcome: "granted", fields: [
        { scope: "attr.financial.tax_record.*", label: "Tax record", status: "granted" },
        { scope: "attr.health.medications.*", label: "Daily routine", status: "granted" },
        { scope: "attr.food.preferences.*", label: "Food preferences", status: "granted" },
        { scope: "attr.lifestyle.hobbies.*", label: "Hobbies", status: "granted" },
      ] },
    });
    services.readStoredConnector.mockResolvedValue({ connector_key_id: "ck_1" });
    services.getInformationRequestExports.mockResolvedValue(items.map((item) => ({
      requestId: item.requestId, scopeRef: item.scopeRef,
      encryptedExport: {
        request_id: item.requestId, scope: `attr.${item.scopeRef}`, export_revision: 1,
        export_envelope: { version: 2, export_id: `x-${item.requestId}`, aad: {
          version: 2, app_id: "agent_one", grant_id: item.requestId, export_id: `x-${item.requestId}`,
          revision: 1, machine_scope: `attr.${item.scopeRef}`, payload_algorithm: "AES-256-GCM",
          expires_at_ms: Date.now() + 3_600_000,
        } },
      },
    })));
    services.decryptScopedExport.mockImplementation(async ({ exportPackage }: { exportPackage: { request_id: string } }) =>
      valuesByRequest[exportPackage.request_id]);
  });

  it("the follow-up turn carries a sensitive item's field names, never its values", async () => {
    const prepared = await prepareConsentContinuation({
      userId: OWNER, vaultKey: "vault-key", vaultOwnerToken: "owner-token",
      bundleId: BUNDLE_A, subjectRef: SUBJECT, outcome: "granted",
    });
    const wire = JSON.stringify(prepared?.continuation);
    for (const secret of SECRETS) expect(wire, `leaked ${secret}`).not.toContain(secret);
    const text = prepared?.continuation.sharedInformation ?? "";
    expect(text).toContain("Tax record: 4 fields (Filing year, Adjusted gross income, Filing status and 1 more)");
    expect(text).toContain("Daily routine: 2 fields (Medication, Dose time)");
    expect(text).toContain("Hobbies: 1 field (Weekend)");
    // Each placeholder line holds field names only: no string from the decrypted export.
    const exported = [TAX, MEDS, HOBBIES].flatMap((record) => Object.values(record).map(String));
    for (const line of text.split("\n").filter((entry) => /: \d+ fields?/.test(entry))) {
      for (const value of exported) expect(line, `value in placeholder: ${value}`).not.toContain(value);
    }
    // Negative control: a standard item still flows, so a leak would be visible here.
    expect(text).toContain("Neapolitan pizza");
  });

  it("negative control: marked standard with a harmless label, the same values would be sent", () => {
    const text = formatSharedInformationForAgent([
      { requestId: "r1", label: "Dinner notes", data: { ...TAX, ...MEDS }, sensitivity: "standard" },
    ]);
    expect(text).toContain("85000");
    expect(text).toContain("Atorvastatin 20mg");
  });

  it("a server's sensitive wins over a harmless label", () => {
    const text = formatSharedInformationForAgent([
      { requestId: "r1", label: "Dinner notes", data: TAX, sensitivity: "sensitive" },
    ]);
    expect(text).not.toContain("85000");
    expect(text).toContain("Dinner notes: 4 fields");
  });

  // Localhost run 4 (S3): the EIN was standard as "Fein" under "Legal entity",
  // so a Legal entity follow-up sent it to the model. Field level, it leaves
  // as its name only, in the exact line the server's strip writes and reads back.
  it("sends an identifier field inside a standard item as its name only", () => {
    const text = formatSharedInformationForAgent([{
      requestId: "r1", label: "Legal entity", sensitivity: "standard",
      data: { entity: { fein: "12-3456789", trade_name_dba: "Acme Coffee", notes: "Card 4111 1111 1111 1111 on file" } },
    }]);
    expect(text).not.toContain("12-3456789");
    expect(text).not.toContain("4111");
    expect(text).toContain("- Legal entity > entity > trade name dba: Acme Coffee");
    expect(text).toContain("- Legal entity: sensitive fields (Federal EIN, Notes). Shown to the person in "
      + "the secure card on their device; the values are not shared with you.");
  });

  it("withholds a field the server's fields[] names sensitive, even when the rule would not", () => {
    const data = { registered_agent: "Jordan Lee", trade_name: "Acme Coffee" };
    const marked = formatSharedInformationForAgent([{
      requestId: "r1", label: "Legal entity", sensitivity: "standard", data,
      fields: [{ name: "Registered agent", sensitivity: "sensitive" }, { name: "Trade name", sensitivity: "standard" }],
    }]);
    expect(marked).not.toContain("Jordan Lee");
    expect(marked).toContain("- Legal entity: sensitive field (Registered agent).");
    expect(marked).toContain("Acme Coffee");
    // Negative control: without fields[], an ordinary field is sent as before.
    expect(formatSharedInformationForAgent([{ requestId: "r1", label: "Legal entity", sensitivity: "standard", data }]))
      .toContain("Jordan Lee");
  });
});
