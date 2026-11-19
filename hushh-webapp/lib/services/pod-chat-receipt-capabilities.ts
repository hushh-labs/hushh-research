/** Negotiate new client tools without breaking an owner's older installed pod. */
import { WIKI_TOOL_NAMES } from "@/lib/files/wiki/recall-client-tools";
import { RECEIPT_TOOL_DECLARATIONS, RECEIPT_FUNCTIONS } from "@/lib/mail/receipt-analysis";
import { canonicalJson } from "./owner-pod-crypto";

const receiptNames = new Set<string>(RECEIPT_FUNCTIONS);
const clientOnlySharedWikiNames = new Set<string>(WIKI_TOOL_NAMES);
type Item = Record<string, unknown>;
const record = (value: unknown): Item =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Item) : {};

function receiptContinuation(turn: Item): boolean {
  if (Object.hasOwn(record(turn.forwardedProps), "receiptToolResults")) return true;
  return (
    Array.isArray(turn.messages) &&
    turn.messages.some((value: unknown) => {
      const message = record(value);
      return (
        receiptNames.has(String(message.name ?? "")) ||
        (Array.isArray(message.toolCalls) &&
          message.toolCalls.some((call: unknown) =>
            receiptNames.has(String(record(record(call).function).name ?? "")),
          ))
      );
    })
  );
}

export function hasPodReceiptTools(request: RequestInit): boolean {
  if (typeof request.body !== "string") return false;
  const turn = record(JSON.parse(request.body));
  return (
    receiptContinuation(turn) ||
    (Array.isArray(turn.tools) &&
      turn.tools.some((tool: unknown) =>
        receiptNames.has(String(record(tool).name ?? "")),
      ))
  );
}

export function receiptToolVersion(value: unknown): 0 | 1 {
  const capabilities = record(value);
  if (
    record(capabilities.identity).type !== "google-adk" ||
    record(capabilities.transport).streaming !== true ||
    record(capabilities.tools).clientProvided !== true
  ) {
    throw new Error("POD_CHAT_CAPABILITIES_INVALID");
  }
  if (!Object.hasOwn(capabilities, "receiptToolVersion")) return 0;
  if (capabilities.receiptToolVersion !== 1) {
    throw new Error("POD_CHAT_CAPABILITIES_INVALID");
  }
  return 1;
}

export function admittedPodActionIds(value: unknown): ReadonlySet<string> | null {
  const capabilities = record(value);
  if (!Object.hasOwn(capabilities, "admittedActionIds")) return null;
  const raw = capabilities.admittedActionIds;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || !item)) {
    throw new Error("POD_CHAT_CAPABILITIES_INVALID");
  }
  return new Set(raw);
}

function decodeActionToolId(name: string): string | null {
  if (!name.startsWith("hussh_action_")) return null;
  const encoded = name.slice("hussh_action_".length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const padded = encoded
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    return decodeURIComponent(escape(atob(padded)));
  } catch {
    return null;
  }
}

/**
 * Private pods mount `PodWikiRecallToolset` server-side and refuse client-side
 * Shared-wiki tool declarations (`AGENT_TOOL_NOT_ADMITTED`), as well as any
 * newer `hussh_action_*` entry not yet in the installed pod's action gateway.
 */
export function projectPodActionTools(
  request: RequestInit,
  admittedActionIds: ReadonlySet<string> | null | undefined,
): RequestInit {
  if (typeof request.body !== "string") return request;
  const turn = record(JSON.parse(request.body));
  const forwarded = record(turn.forwardedProps);
  const hasSharedWikiProps =
    Object.hasOwn(forwarded, "wikiClientReady") ||
    Object.hasOwn(forwarded, "wikiHotDigest");
  const tools = Array.isArray(turn.tools) ? turn.tools : null;
  const filtered = tools
    ? tools.filter((value: unknown) => {
        const tool = record(value);
        const name = String(tool.name ?? "");
        if (clientOnlySharedWikiNames.has(name)) return false;
        if (!admittedActionIds || !name.startsWith("hussh_action_")) return true;
        const actionId = decodeActionToolId(name);
        return actionId !== null && admittedActionIds.has(actionId);
      })
    : null;
  const toolsChanged = Boolean(tools && filtered && filtered.length !== tools.length);
  if (!toolsChanged && !hasSharedWikiProps) return request;
  if (toolsChanged && filtered) {
    turn.tools = filtered;
  }
  if (hasSharedWikiProps) {
    const nextForwarded = { ...forwarded };
    delete nextForwarded.wikiClientReady;
    delete nextForwarded.wikiHotDigest;
    turn.forwardedProps = nextForwarded;
  }
  return { ...request, body: JSON.stringify(turn) };
}

export function projectPodReceiptTools(
  request: RequestInit,
  version: 0 | 1,
): RequestInit {
  if (version === 1) return request;
  const turn = record(JSON.parse(String(request.body)));
  if (receiptContinuation(turn)) throw new Error("POD_RECEIPT_UPDATE_REQUIRED");
  if (!Array.isArray(turn.tools)) throw new Error("POD_CHAT_REQUEST_INVALID");
  turn.tools = turn.tools.filter((value: unknown) => {
    const tool = record(value);
    if (!receiptNames.has(String(tool.name ?? ""))) return true;
    const declaration = RECEIPT_TOOL_DECLARATIONS.find(
      (item) => item.name === tool.name,
    );
    if (!declaration || canonicalJson(tool) !== canonicalJson(declaration)) {
      throw new Error("POD_CHAT_RECEIPT_DECLARATION_INVALID");
    }
    return false;
  });
  return { ...request, body: JSON.stringify(turn) };
}
