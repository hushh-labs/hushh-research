import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BUNDLE = "0f0e0d0c-0b0a-4908-8706-050403020100";
const OWNER = "owner-1";

const mocks = vi.hoisted(() => ({
  getInformationRequest: vi.fn(),
  streamAgentChat: vi.fn(),
  getAgentChatConsentOutcomes: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: OWNER } }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: "vault-key", getVaultOwnerToken: () => "owner-token" }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/elsewhere",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/interaction/interaction-intent-coordinator", () => ({
  appInteractionCoordinator: {
    getLifecycleSnapshot: () => ({ state: "active" }),
    subscribeLifecycle: () => () => undefined,
  },
}));
vi.mock("@/lib/agent/agent-chat-history-events", () => ({ dispatchAgentChatHistoryInvalidated: vi.fn() }));
vi.mock("@/lib/agent/agent-chat-turn-watch", () => ({
  requestOpenAgentConversation: vi.fn(),
  settleWatchedAgentTurn: vi.fn(),
  watchDetachedAgentTurn: vi.fn(),
}));
vi.mock("@/lib/agent/in-app-chat-selection", () => ({ rememberInAppChat: vi.fn() }));
vi.mock("@/lib/services/agent-chat-client", () => ({
  findInformationRequestConversation: vi.fn(async () => null),
  streamAgentChat: mocks.streamAgentChat,
  getAgentChatConsentOutcomes: mocks.getAgentChatConsentOutcomes,
}));
vi.mock("@/lib/services/person-profile-service", () => ({
  PersonProfileService: { getInformationRequest: mocks.getInformationRequest },
}));
vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({ OneKycClientZkService: {} }));

import { AgentConsentContinuationNotifier } from "@/components/agent/agent-consent-continuation-notifier";
import {
  clearSentInformationRequests,
  informationRequestPhase,
  isConsentContinuationArmed,
  listSentInformationRequests,
  markConsentContinuationUnavailable,
  mountInformationRequestCard,
  watchSentInformationRequest,
} from "@/lib/agent/consent-continuation";
import { CONSENT_STATE_CHANGED_EVENT, dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { readInformationRequest } from "@/lib/consent/information-request-reads";

const BUNDLE_2 = "1f1e1d1c-1b1a-4918-9716-151413121110";

function bundle(status: "pending" | "denied" | "granted", bundleId: string = BUNDLE) {
  return {
    personRef: "person-kushal",
    bundleId,
    purpose: "Plan dinner",
    durationSeconds: 604_800,
    cancelled: false,
    items: [{ requestId: "r1", scopeRef: "s1", label: "Food preferences", sensitivity: null, status }],
  };
}

function waitOnKushal(bundleId: string = BUNDLE) {
  watchSentInformationRequest({
    ownerId: OWNER,
    bundleId,
    conversationId: "conversation-1",
    subjectRef: "person-kushal",
    personName: "Kushal",
  });
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("AgentConsentContinuationNotifier doorbell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.getInformationRequest.mockReset();
    mocks.streamAgentChat.mockReset();
    mocks.getAgentChatConsentOutcomes.mockReset();
    mocks.toast.mockClear();
    mocks.toast.error.mockClear();
    mocks.toast.dismiss.mockClear();
  });
  afterEach(() => {
    clearSentInformationRequests(null);
    vi.useRealTimers();
  });

  it("checks about every 2s while a request waits, with the same server call", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("pending"));
    waitOnKushal();
    render(<AgentConsentContinuationNotifier />);
    await flush();
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(1);
    expect(mocks.getInformationRequest).toHaveBeenCalledWith({ bundleId: BUNDLE, vaultOwnerToken: "owner-token" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    // A flat 8s poll would have made one call here, not four.
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(5);
  });

  // Run 4 (R3): one approved request was polled 166 times in 18 minutes, two
  // to four reads at once, because each surface read it on its own.
  async function tenSecondsWithACardReading(cardRead: () => unknown): Promise<Record<string, number>> {
    // A read takes a while on a busy pool (10-38s measured); here, 500ms.
    mocks.getInformationRequest.mockImplementation(({ bundleId }: { bundleId: string }) =>
      new Promise((resolve) => setTimeout(() => resolve(bundle("pending", bundleId)), 500)));
    waitOnKushal(BUNDLE);
    waitOnKushal(BUNDLE_2);
    render(<AgentConsentContinuationNotifier />);
    // Each tick, a card showing the first request reads it at the same moment.
    cardRead();
    await flush();
    for (let tick = 0; tick < 5; tick += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
        cardRead();
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const counts: Record<string, number> = {};
    for (const [input] of mocks.getInformationRequest.mock.calls) {
      const id = (input as { bundleId: string }).bundleId;
      counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  }

  it("reads each waiting bundle once per tick, shared with any card reading it", async () => {
    const counts = await tenSecondsWithACardReading(() =>
      void readInformationRequest({ bundleId: BUNDLE, vaultOwnerToken: "owner-token" }));
    // Six checks in ten seconds (at once, then every 2s): one read each, per bundle.
    expect(counts).toEqual({ [BUNDLE]: 6, [BUNDLE_2]: 6 });
  });

  it("negative control: a card reading on its own doubles the reads of its bundle", async () => {
    const counts = await tenSecondsWithACardReading(() =>
      void mocks.getInformationRequest({ bundleId: BUNDLE, vaultOwnerToken: "owner-token" }));
    expect(counts).toEqual({ [BUNDLE]: 12, [BUNDLE_2]: 6 });
  });

  // Run 4 (R3): an answered request whose card was on screen stayed "waiting",
  // so it kept the 2s cadence and a card-wide refresh event every 10s.
  it("stops the fast checks once a request is answered, and the card may still continue it", async () => {
    mocks.getInformationRequest.mockImplementation(async ({ bundleId }: { bundleId: string }) =>
      bundle(bundleId === BUNDLE ? "granted" : "pending", bundleId));
    mocks.getAgentChatConsentOutcomes.mockResolvedValue({});
    waitOnKushal(BUNDLE);
    waitOnKushal(BUNDLE_2);
    const releaseCard = mountInformationRequestCard(OWNER, BUNDLE);
    const events: unknown[] = [];
    const onEvent = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, onEvent);
    render(<AgentConsentContinuationNotifier />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const reads = (id: string) => mocks.getInformationRequest.mock.calls
      .filter(([input]) => (input as { bundleId: string }).bundleId === id).length;
    // Answered on the first check: never read by the doorbell again.
    expect(reads(BUNDLE)).toBe(1);
    // Control: the request still waiting kept its 2s cadence meanwhile.
    expect(reads(BUNDLE_2)).toBe(31);
    expect(listSentInformationRequests(OWNER).map((request) => request.bundleId)).toEqual([BUNDLE_2]);
    expect(isConsentContinuationArmed(OWNER, BUNDLE)).toBe(true);
    expect(informationRequestPhase(OWNER, BUNDLE)).toBe("reading");
    // No refresh events: the card takes the published reading instead.
    expect(events).toEqual([]);
    window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, onEvent);
    releaseCard();
  });

  it("checks at once on a push or live event for the waiting request", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("pending"));
    waitOnKushal();
    render(<AgentConsentContinuationNotifier />);
    await flush();
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(1);
    act(() => {
      dispatchConsentStateChanged({
        source: "information_request_updated",
        bundleId: BUNDLE,
        requestId: "r1",
        action: "CONSENT_GRANTED",
      });
    });
    await flush();
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(2);
  });

  it("pauses while hidden and checks at once when the app shows again", async () => {
    let visibility: DocumentVisibilityState = "visible";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    mocks.getInformationRequest.mockResolvedValue(bundle("pending"));
    waitOnKushal();
    render(<AgentConsentContinuationNotifier />);
    await flush();
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(1);

    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("treats a continuation another device already gave as handled: no error toast", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("denied"));
    // The server refuses the second continuation (409 "already continued").
    mocks.streamAgentChat.mockRejectedValue(new Error("This conversation already continued after that answer."));
    mocks.getAgentChatConsentOutcomes.mockResolvedValue({ [BUNDLE]: "denied" });
    waitOnKushal();
    render(<AgentConsentContinuationNotifier />);
    await flush();
    await flush();

    expect(mocks.streamAgentChat).toHaveBeenCalledWith(expect.objectContaining({
      message: "Request declined",
      consentContinuation: { bundleId: BUNDLE, outcome: "denied" },
    }));
    // The person sees what happened in words, never the fixed label.
    expect(mocks.toast).toHaveBeenCalledWith("Kushal declined", expect.anything());
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(mocks.toast.dismiss).toHaveBeenCalledWith(`consent-outcome-${BUNDLE}`);
    expect(informationRequestPhase(OWNER, BUNDLE)).toBe("answered");
  });

  // Regression (localhost run 2026-09-28): the receipt was refused (404), so
  // the follow-up turn got 409 and "One couldn't complete that response".
  it("never starts a follow-up the server would refuse for a request without a receipt", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("denied"));
    waitOnKushal();
    markConsentContinuationUnavailable(OWNER, BUNDLE);
    render(<AgentConsentContinuationNotifier />);
    await flush();
    await flush();
    expect(mocks.streamAgentChat).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
    // It stops waiting: no endless polling of a settled request.
    expect(listSentInformationRequests(OWNER)).toEqual([]);
  });

  it("control: a failure nobody else answered still says so", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("denied"));
    mocks.streamAgentChat.mockRejectedValue(new Error("offline"));
    mocks.getAgentChatConsentOutcomes.mockResolvedValue({});
    waitOnKushal();
    render(<AgentConsentContinuationNotifier />);
    await flush();
    await flush();
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(informationRequestPhase(OWNER, BUNDLE)).toBeNull();
  });
});
