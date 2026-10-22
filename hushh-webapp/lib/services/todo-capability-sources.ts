import { DirectMessagesService } from "./direct-messages-service";
import { WalletCardAccessService } from "./wallet-card-access-service";
import { RiaService } from "./ria-service";
import { GmailReceiptsService } from "./gmail-receipts-service";
import { GoogleCalendarService } from "./google-calendar-service";
import { peekLiveMirror } from "@/lib/pkm/memory-refresh";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { getOneCapability } from "@/lib/onboarding/one-capabilities";
import { normalizeInternalRouteHref } from "@/lib/navigation/routes";
import type { TaskCapability, TaskCoverage, TaskEvidence } from "@/lib/todos/task-suggestion-model";
import { walletCardRequestHref } from "@/lib/wallet/card-request";

export type CapabilityRead = { coverage: TaskCoverage; evidence: TaskEvidence[] };
export type TaskReadContext = {
  userId: string; vaultOwnerToken: string; getIdToken: () => Promise<string>;
  isCurrent: () => boolean; mailConnected: boolean; calendarConnected: boolean;
  mailStatusKnown: boolean; calendarStatusKnown: boolean;
  signal?: AbortSignal;
};
const hrefFor = (id: TaskCapability) => getOneCapability(id)?.href ?? "/one";
const result = (capability: TaskCapability, count: number, evidence: TaskEvidence[] = [], status: TaskCoverage["status"] = "ready"): CapabilityRead => ({ coverage: { capability, count, status }, evidence });
const evidence = (capability: TaskCapability, key: string, summary: string, pendingTitle?: string): TaskEvidence => ({ capability, key, summary: summary.slice(0, 240), href: hrefFor(capability), ...(pendingTitle ? { pendingTitle } : {}) });

/** Provider identifiers stay in this read; only an owner-bound opaque digest
 * participates in private completion state. Nothing here reads message bodies. */
async function sourceKey(owner: string, value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${owner}:${value}`));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function readWallet(context: TaskReadContext): Promise<CapabilityRead> {
  const rows: TaskEvidence[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 50; page += 1) {
    if (!context.isCurrent()) throw new DOMException("Session changed", "AbortError");
    const next = await WalletCardAccessService.listRequests(context, cursor);
    for (const item of next.items) {
      if (!seen.has(item.id)) rows.push({ ...evidence("wallet", `wallet:${item.id}`, "A connected person has a pending card access request.", "Review card access request"), href: walletCardRequestHref(item.id) });
      seen.add(item.id);
    }
    if (!next.hasMore) return result("wallet", rows.length, rows);
    if (!next.nextCursor || next.nextCursor === cursor || !next.items.length) throw new Error("Card request paging could not be verified.");
    cursor = next.nextCursor;
  }
  return result("wallet", rows.length, rows, "incomplete");
}

async function readAdvisor(context: TaskReadContext, idToken: string): Promise<CapabilityRead> {
  const persona = await RiaService.getPersonaState(idToken, { userId: context.userId, force: true });
  if (!persona.personas.includes("ria")) return result("ria", 0, [], "not_connected");
  const home = await RiaService.getHome(idToken, { userId: context.userId, force: true });
  const rows = home.needs_attention.flatMap(item => {
    const href = normalizeInternalRouteHref(item.href);
    return href ? [{ ...evidence("ria", `ria:${item.id}`, item.title, item.next_action || item.title), href }] : [];
  });
  return result("ria", home.counts.needs_attention, rows, home.counts.needs_attention > rows.length ? "incomplete" : "ready");
}

async function readMail(context: TaskReadContext, idToken: string): Promise<CapabilityRead> {
  if (!context.mailStatusKnown) return result("gmail", 0, [], "unavailable");
  if (!context.mailConnected) return result("gmail", 0, [], "not_connected");
  const mail = await GmailReceiptsService.listNudges({ idToken, userId: context.userId, vaultOwnerToken: context.vaultOwnerToken, limit: 50 });
  const rows = await Promise.all(mail.nudges.filter(row => row.type === "needs_reply").map(async row =>
    evidence("gmail", `mail:${await sourceKey(context.userId, `${row.thread_id}:${row.message_id}`)}`, row.title)));
  // This publisher scans recent threads, not the entire mailbox.
  return result("gmail", rows.length, rows, "incomplete");
}

async function readInvitations(context: TaskReadContext, idToken: string): Promise<CapabilityRead> {
  if (!context.calendarStatusKnown) return result("calendar", 0, [], "unavailable");
  if (!context.calendarConnected) return result("calendar", 0, [], "not_connected");
  const data = await GoogleCalendarService.invitations({ firebaseIdToken: idToken, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, signal: context.signal, isEffectCurrent: context.isCurrent });
  const rows = await Promise.all(data.events.filter(row => row.response_status === "needsAction" && row.can_respond).map(async row =>
    evidence("calendar", `rsvp:${await sourceKey(context.userId, `${row.calendar_id}:${row.id}`)}`, row.title, `Respond to ${row.title}`)));
  return result("calendar", data.pending_count, rows, data.complete && data.pending_count <= rows.length ? "ready" : "incomplete");
}

function readMemory(context: TaskReadContext): CapabilityRead {
  const view = peekLiveMirror(context.userId);
  if (!view || view.ownerId !== context.userId || !isVaultSessionEpochCurrent(view.vaultEpoch)) return result("pkm", 0, [], "unavailable");
  const conflicts = view.conflicts?.length ?? 0;
  const changes = view.sources.reduce((count, source) => count + (source.pendingChanges ?? 0), 0);
  const rows = conflicts || changes ? [evidence("pkm", `memory:${view.builtAt}`, `${conflicts} memory disagreements and ${changes} pending source updates need review.`)] : [];
  return result("pkm", conflicts + changes, rows, view.inventoryComplete && view.sources.every(source => ["current", "conflict"].includes(source.state) && source.pendingChanges !== null && source.reason === null) ? "ready" : "incomplete");
}

export async function readTodoCapabilities(context: TaskReadContext): Promise<CapabilityRead[]> {
  const epoch = snapshotVaultSessionEpoch();
  const idToken = await context.getIdToken();
  const current = () => context.isCurrent() && isVaultSessionEpochCurrent(epoch);
  if (!current()) throw new DOMException("Session changed", "AbortError");
  const tasks: [TaskCapability, () => Promise<CapabilityRead>][] = [
    ["messages", async () => { const count = await DirectMessagesService.unreadCount({ idToken }); return result("messages", count, count ? [evidence("messages", "messages:unread", `${count} unread messages across People and Circles.`)] : []); }],
    ["wallet", () => readWallet(context)], ["ria", () => readAdvisor(context, idToken)],
    ["gmail", () => readMail(context, idToken)], ["calendar", () => readInvitations(context, idToken)],
    ["pkm", async () => readMemory(context)],
  ];
  const results = await Promise.allSettled(tasks.map(([, read]) => read()));
  if (!current()) throw new DOMException("Session changed", "AbortError");
  return tasks.map(([capability], index) => {
    const value = results[index];
    return value?.status === "fulfilled" ? value.value : result(capability, 0, [], "unavailable");
  });
}
