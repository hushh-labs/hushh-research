import { PodNotReachedError, PodSendUnconfirmedError, isAgentStillWaking, notReachedBeforeSend } from "@/lib/agent/owner-pod-wake";
import { legacyReceiptResult } from "@/lib/mail/receipt-availability";
import { hasPodReceiptTools, projectPodReceiptTools, receiptToolVersion } from "./pod-chat-receipt-capabilities";

/**
 * When each agent address last gave a real answer. An agent that answered this
 * recently is awake, so its next turn goes straight out. Scale-to-zero waits
 * minutes of idle time (Azure Container Apps defaults to 300 s), well past this.
 */
const agentAnswered = new Map<string, number>();
const AGENT_AWAKE_MS = 60_000;

export function markAgentAnswered(url: string): void {
  agentAnswered.set(url, Date.now());
}

/** Forget which agents answered recently. Tests start from a cold agent. */
export function forgetAgentAnswers(): void {
  agentAnswered.clear();
}

function isCancellation(error: unknown, signal?: AbortSignal | null): boolean {
  return (
    Boolean(signal?.aborted) ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

/**
 * A version 1 pod may run the older validator that refuses the newer receipt
 * setup codes, so its continuation carries them in the generic form. The device
 * still shows its setup card from the specific code, and a hub turn never passes
 * through here.
 */
function legacyReceiptResults(request: RequestInit): RequestInit {
  const turn = JSON.parse(String(request.body)) as { forwardedProps?: { receiptToolResults?: unknown } } | null;
  const results = turn?.forwardedProps?.receiptToolResults;
  if (!turn?.forwardedProps || !Array.isArray(results)) return request;
  turn.forwardedProps.receiptToolResults = results.map((item: { result?: unknown } | null) => {
    const result = legacyReceiptResult(item?.result);
    return result === item?.result ? item : { ...item, result };
  });
  return { ...request, body: JSON.stringify(turn) };
}

/**
 * Send a chat turn so that a failure is classified honestly. A sleeping agent
 * whose ingress resets the first connection would otherwise fail the turn's own
 * POST, where nothing proves whether it arrived. So an agent not heard from
 * recently is asked a cheap, side-effect-free question first (capabilities): if
 * that gets no answer, or only a gateway page, the turn provably was never sent
 * and can wait for the wake. A failure of the POST itself stays ambiguous.
 */
const receiptCapabilities = new WeakMap<object, { version: 0 | 1; checkedAt: number }>();

export async function sendChatTurn(
  url: string,
  request: RequestInit,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  directVerifiedAt?: number,
  session?: object,
  assertCurrent?: () => void,
): Promise<Response> {
  const now = Date.now();
  const receipts = hasPodReceiptTools(request);
  const cached = session ? receiptCapabilities.get(session) : undefined;
  let version = cached && now - cached.checkedAt <= AGENT_AWAKE_MS ? cached.version : undefined;
  const recentlyAdmitted =
    typeof directVerifiedAt === "number" &&
    Number.isFinite(directVerifiedAt) &&
    directVerifiedAt <= now &&
    now - directVerifiedAt <= AGENT_AWAKE_MS;
  const answeredAt = agentAnswered.get(url);
  if (
    (receipts && version === undefined) ||
    (!recentlyAdmitted && (answeredAt === undefined || now - answeredAt > AGENT_AWAKE_MS))
  ) {
    let probe: Response;
    try {
      probe = await fetch(`${url}/api/one/pod/agent-chat/capabilities`, {
        method: "GET",
        headers: request.headers,
        credentials: "omit",
        cache: "no-store",
        signal: request.signal,
      });
    } catch (error) {
      if (isCancellation(error, request.signal)) throw error;
      throw notReachedBeforeSend();
    }
    if (isAgentStillWaking(probe)) {
      void probe.body?.cancel().catch(() => undefined);
      throw new PodNotReachedError();
    }
    if (receipts) {
      if (!probe.ok) {
        void probe.body?.cancel().catch(() => undefined);
        throw new Error("POD_CHAT_CAPABILITIES_UNAVAILABLE");
      }
      version = receiptToolVersion(await probe.json().catch(() => null));
      if (session) receiptCapabilities.set(session, { version, checkedAt: Date.now() });
    } else {
      void probe.body?.cancel().catch(() => undefined);
    }
    agentAnswered.set(url, Date.now());
  }
  assertCurrent?.();
  if (receipts) {
    if (version === undefined) throw new Error("POD_CHAT_CAPABILITIES_INVALID");
    request = projectPodReceiptTools(request, version);
    if (version === 1) request = legacyReceiptResults(request);
  }
  try {
    return await fetch(`${url}/api/one/pod/agent-chat`, request);
  } catch (error) {
    if (isCancellation(error, request.signal)) throw error;
    throw new PodSendUnconfirmedError();
  }
}
