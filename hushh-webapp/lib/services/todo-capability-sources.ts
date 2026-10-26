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
import { todoReminderLocalFields } from "@/lib/todos/reminder-schedule";

export type CapabilityRead = { coverage: TaskCoverage; evidence: TaskEvidence[]; cursor?: string | null };
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
      if (!seen.has(item.id)) rows.push({ ...evidence("wallet", `wallet:${item.id}`, "A connected person has a pending card access request.", `Review ${item.requesterName || "a connection"}'s card access request`), context: "Wallet · Decide whether to share your card.", href: walletCardRequestHref(item.id) });
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
  // A non-advisor persona does not prove that no advisor relationship exists.
  if (!persona.personas.includes("ria")) return result("ria", 0, [], "unavailable");
  const home = await RiaService.getHome(idToken, { userId: context.userId, force: true });
  const rows = home.needs_attention.flatMap(item => {
    const href = normalizeInternalRouteHref(item.href);
    return href ? [{ ...evidence("ria", `ria:${item.id}`, item.title, item.next_action || item.title), href, context: [item.title, item.subtitle].filter(Boolean).join(" · ").slice(0, 1200) }] : [];
  });
  return result("ria", home.counts.needs_attention, rows, home.counts.needs_attention > rows.length ? "incomplete" : "ready");
}

export async function readTodoMail(context: TaskReadContext, idToken: string, previous?: CapabilityRead): Promise<CapabilityRead> {
  if (!context.mailStatusKnown) return result("gmail", 0, [], "unavailable");
  if (!context.mailConnected) return result("gmail", 0, [], "not_connected");
  const [scan, recent] = await Promise.allSettled([
    GmailReceiptsService.listNudges({ idToken, userId: context.userId, vaultOwnerToken: context.vaultOwnerToken,
      scanAll: true, cursor: previous?.cursor, signal: context.signal, isCurrent: context.isCurrent }),
    previous ? Promise.resolve(null) : GmailReceiptsService.listNudges({ idToken, userId: context.userId,
      vaultOwnerToken: context.vaultOwnerToken, limit: 25, signal: context.signal, isCurrent: context.isCurrent }),
  ]);
  if (scan.status === "rejected") throw scan.reason;
  const mail = scan.value;
  if (!context.isCurrent()) throw new DOMException("Session changed", "AbortError");
  const rows = await Promise.all(mail.nudges.filter(row => row.type === "needs_reply").map(async row => {
    const sender = row.sender?.trim() || row.sender_email?.trim() || "the sender";
    const subject = row.title.trim() || "the email";
    return { ...evidence("gmail", `mail:${await sourceKey(context.userId, `${mail.account_email ?? ""}:${row.thread_id}:${row.message_id}`)}`,
      subject, `Reply to ${sender}: ${subject}`),
      context: `From ${sender}${row.sender_email && row.sender_email !== sender ? ` <${row.sender_email}>` : ""}${mail.account_email ? ` · To ${mail.account_email}` : ""}` };
  }));
  const recentMail = recent.status === "fulfilled" && recent.value?.account_email?.toLowerCase() === mail.account_email?.toLowerCase() ? recent.value : null;
  const meetings = await Promise.all((recentMail?.nudges ?? []).filter(row => row.type === "upcoming_meeting" && row.starts_at && Date.parse(row.starts_at) > Date.now()).map(async row => {
    const local = todoReminderLocalFields(row.starts_at!);
    const title = `${row.meeting_source === "email" ? "Review meeting" : "Attend"}: ${row.title}`;
    return { ...evidence("gmail", `mail-meeting:${await sourceKey(context.userId, `${mail.account_email}:${row.thread_id}:${row.starts_at}`)}`, row.title, title),
      date: local.date, time: local.time,
      context: `Email ${row.meeting_source === "email" ? "mentions a meeting" : "invitation"} from ${row.sender || row.sender_email || "the organizer"}. Verify the invitation details.`,
      ...(row.ical_uid ? { meetingRef: JSON.stringify([row.ical_uid, new Date(row.starts_at!).toISOString()]) } : {}) };
  }));
  const allRows = [...new Map([...(previous?.evidence ?? []), ...rows, ...meetings].map(row => [row.key, row])).values()];
  return { ...result("gmail", allRows.length, allRows, mail.coverage?.complete ? "ready" : "incomplete"),
    cursor: mail.next_cursor ?? null, coverage: { capability: "gmail", count: allRows.length,
      status: mail.coverage?.complete ? "ready" : "incomplete", scanned: mail.coverage?.scanned_threads,
      canContinue: Boolean(mail.next_cursor), scanFailed: Boolean(mail.coverage?.failed_threads),
      meetings: previous?.coverage.meetings ?? (recentMail && recentMail.meeting_scan?.status !== "unavailable" ? "recent" : "unavailable") } };
}

async function readInvitations(context: TaskReadContext, idToken: string): Promise<CapabilityRead> {
  if (!context.calendarStatusKnown) return result("calendar", 0, [], "unavailable");
  if (!context.calendarConnected) return result("calendar", 0, [], "not_connected");
  const data = await GoogleCalendarService.invitations({ firebaseIdToken: idToken, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, signal: context.signal, isEffectCurrent: context.isCurrent });
  const rows = await Promise.all(data.events.filter(row => row.response_status === "needsAction" && row.can_respond).map(async row =>
    evidence("calendar", `rsvp:${await sourceKey(context.userId, `${row.calendar_id}:${row.id}`)}`, row.title, `Respond to ${row.title}`)));
  return result("calendar", data.pending_count, rows, data.complete && data.pending_count <= rows.length ? "ready" : "incomplete");
}

async function readMemory(context: TaskReadContext): Promise<CapabilityRead> {
  const view = peekLiveMirror(context.userId);
  if (!view || view.ownerId !== context.userId || !isVaultSessionEpochCurrent(view.vaultEpoch)) return result("pkm", 0, [], "unavailable");
  const conflicts = view.conflicts?.length ?? 0;
  const changes = view.sources.reduce((count, source) => count + (source.pendingChanges ?? 0), 0);
  const revision = JSON.stringify([
    (view.conflicts ?? []).map(item => [item.predicate, item.claims.map(claim => [claim.source, claim.revision, claim.sourceUpdatedAt, claim.value]).sort()]).sort(),
    view.sources.filter(source => source.pendingChanges).map(source => [source.id, source.contentRevision, source.pendingChanges]).sort(),
  ]);
  const rows = conflicts || changes ? [evidence("pkm", `memory:${await sourceKey(context.userId, revision)}`, `${conflicts} memory disagreements and ${changes} pending source updates need review.`, "Review Memory updates")] : [];
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
    ["gmail", () => readTodoMail(context, idToken)], ["calendar", () => readInvitations(context, idToken)],
    ["pkm", async () => readMemory(context)],
  ];
  const results = await Promise.allSettled(tasks.map(([, read]) => read()));
  if (!current()) throw new DOMException("Session changed", "AbortError");
  return tasks.map(([capability], index) => {
    const value = results[index];
    return value?.status === "fulfilled" ? value.value : result(capability, 0, [], "unavailable");
  });
}
