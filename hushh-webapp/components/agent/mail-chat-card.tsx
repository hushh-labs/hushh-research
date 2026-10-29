"use client";

import { useCallback, useId, useState, type CSSProperties } from "react";
import { usePathname, useRouter } from "next/navigation";

import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Receipt,
  ShieldAlert,
  UserRound,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  MAIL_BRIEF_CATEGORIES,
  RECEIPT_SETUP_EXPERIENCE_TYPE,
  type MailBriefCategory,
  type MailBriefExperience,
  type MailBriefItem,
  type MailBriefState,
  type ReceiptSetupExperience,
} from "@/lib/agent/mail-chat-experiences";
import { formatRelativeTime } from "@/lib/format/relative-time";
import { SEMANTIC_ROLE_CLASSES } from "@/lib/morphy-ux/tokens/semantic-roles";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { buildGmailWorkspaceRoute } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";

import styles from "./mail-attention-stack.module.css";

const MAX_PEEKS = 2;
// How each category reads: its item label, "1 {one}", "2 {many}", and "No {kind}" or "Couldn't check for {kind}".
const LABELS: Record<MailBriefCategory, { label: string; one: string; many: string; kind: string }> = {
  action_items: { label: "Needs you", one: "needs you", many: "need you", kind: "action items" },
  personal_info: {
    label: "Asks for your details", one: "asks for your details", many: "ask for your details",
    kind: "requests for your details",
  },
  payments_due: { label: "Payment due", one: "payment due", many: "payments due", kind: "payments due" },
  security_alerts: { label: "Security", one: "security notice", many: "security notices", kind: "security notices" },
  meetings: { label: "Meeting", one: "meeting", many: "meetings", kind: "meetings" },
};
const ICONS = {
  action_items: CircleAlert,
  personal_info: UserRound,
  payments_due: Receipt,
  security_alerts: ShieldAlert,
  meetings: CalendarClock,
} satisfies Record<MailBriefCategory, unknown>;
// How a settled item ended, which its row shows in place of its category.
const SETTLED_LABELS: Partial<Record<MailBriefState, string>> = { completed: "Done", cancelled: "Cancelled" };

/** Completed and cancelled items stay as context with a neutral icon and are never counted as open. */
function settled(item: MailBriefItem): boolean {
  return SETTLED_LABELS[item.state] !== undefined;
}

/** Categories in card order: "meetings", "payments due or meetings", "a, b or c". */
function kinds(names: MailBriefCategory[]): string {
  const words = MAIL_BRIEF_CATEGORIES.filter((name) => names.includes(name)).map((name) => LABELS[name].kind);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words.at(-1)}` : words.join("");
}

/** The headline with nothing open. Only a brief that checked every category can say nothing needs you. */
function nothingOpen(requested: MailBriefCategory[], failed: MailBriefCategory[], anySettled: boolean): string {
  const broad = MAIL_BRIEF_CATEGORIES.every((name) => requested.includes(name));
  const finished = requested.filter((name) => !failed.includes(name));
  // A narrower brief names the kinds it finished checking; "open" keeps a Done row below from contradicting it.
  if (!broad && finished.length) return `No ${anySettled ? "open " : ""}${kinds(finished)} in the mail checked`;
  return failed.length ? "The checks that finished found nothing that needs you" : "Nothing needs you in the mail checked";
}

/** "2 need you · 1 payment due" over open items, in category order; zero counts are left out. */
export function summarizeMailBrief({ requested, failed, items }: MailBriefExperience): string {
  const parts = MAIL_BRIEF_CATEGORIES.flatMap((name) => {
    const count = items.filter((item) => item.category === name && !settled(item)).length;
    return count ? [`${count} ${count === 1 ? LABELS[name].one : LABELS[name].many}`] : [];
  });
  const found = parts.length ? parts.join(" · ") : nothingOpen(requested, failed, items.some(settled));
  if (failed.length) {
    // An unfinished check may have missed something, so nothing is cleared; past two names it stays generic.
    const unfinished = failed.length > 2 ? "Some checks didn't finish" : `Couldn't check for ${kinds(failed)}`;
    return `${found} · ${unfinished}`;
  }
  // Standing alone, the quiet headline is a sentence.
  return parts.length ? found : `${found}.`;
}

/** What the check couldn't see, so a quiet brief never reads as complete. */
function coverageNotes(experience: MailBriefExperience): string[] {
  return [
    experience.moreMailOutsidePage && "Only recent mail was checked.",
    experience.someUnreadable && "Some messages couldn't be read.",
    experience.textShortened && "Some messages were only partly read.",
  ].filter((note) => note !== false);
}

/** An unreadable date is left out rather than shown as "Due null", and a settled item is no longer due. */
function when(item: MailBriefItem): string {
  const due = item.dueAt && !settled(item) ? formatLocalDateTime(item.dueAt, { month: "short", day: "numeric" }) : null;
  if (due) return `Due ${due}`;
  const event = item.eventAt ? formatLocalDateTime(item.eventAt) : null;
  if (event) return event;
  return item.receivedAt ? formatRelativeTime(Date.parse(item.receivedAt)) : "";
}

function BriefItem({ item, top }: { item: MailBriefItem; top: boolean }) {
  const Icon = ICONS[item.category];
  const role = SEMANTIC_ROLE_CLASSES[settled(item) ? "neutral" : "warning"];
  // A settled row says how it ended, not what it asked, so it never reads as open under the headline.
  const label = SETTLED_LABELS[item.state] ?? LABELS[item.category].label;
  const meta = [label, item.senderName, when(item)].filter(Boolean).join(" · ");
  return (
    <div data-testid="mail-brief-item" className={cn(styles.surface, top && styles.card, "flex min-w-0 items-start gap-3 p-3")}>
      <span aria-hidden="true" className={cn(styles.tile, role.tile, role.glyph)}>
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <span data-profile-role="description" className="block truncate">{meta}</span>
        <span data-profile-role="label" className="mt-0.5 block break-words [overflow-wrap:anywhere]">
          {item.subject ?? item.detail ?? "Mail"}
        </span>
        {item.subject && item.detail ? (
          <span data-profile-role="description" className="mt-0.5 block break-words">{item.detail}</span>
        ) : null}
      </div>
    </div>
  );
}

function MailBriefCard({ experience }: { experience: MailBriefExperience }) {
  const pathname = usePathname() || "/";
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();
  // Open items first; a completed or cancelled one is context, not a nudge.
  const items = [...experience.items].sort((a, b) => Number(settled(a)) - Number(settled(b)));
  const notes = coverageNotes(experience);
  const isExpanded = expanded && items.length > 1;
  const collapse = useCallback(() => {
    setExpanded(false);
    return true;
  }, []);
  useBackLayer(pathname, isExpanded ? 1 : 0, collapse);
  const [top] = items;
  const peeks = Math.min(items.length - 1, MAX_PEEKS);
  return (
    <section data-testid="mail-brief" aria-label="Mail brief" className="w-full">
      <p data-profile-role="group-label">Mail brief</p>
      <p data-profile-role="description" className="break-words">{summarizeMailBrief(experience)}</p>
      <div id={regionId} className="mt-3">
        {isExpanded ? (
          <ul aria-label="Mail brief items" className={cn(styles.list, "motion-step-enter")}>
            {items.map((item) => <li key={item.sourceRef + item.category}><BriefItem item={item} top={false} /></li>)}
          </ul>
        ) : top ? (
          <div className={styles.stack} style={{ "--peek-count": peeks } as CSSProperties}>
            <BriefItem item={top} top />
            {Array.from({ length: peeks }, (_, index) => (
              <div key={index} aria-hidden="true" className={cn(styles.surface, styles.peek)}
                style={{ "--peek-index": index + 1 } as CSSProperties} />
            ))}
          </div>
        ) : null}
      </div>
      {items.length > 1 ? (
        <div className="mt-3 flex justify-center">
          <Button type="button" variant="secondary" size="compact" aria-expanded={isExpanded} aria-controls={regionId}
            onClick={() => setExpanded(!isExpanded)}>
            {isExpanded ? "Hide" : `Show all ${items.length}`}
            {isExpanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </Button>
        </div>
      ) : null}
      {notes.length ? (
        <div className="mt-2">
          {notes.map((note) => <p key={note} data-profile-role="description">{note}</p>)}
        </div>
      ) : null}
    </section>
  );
}

function ReceiptSyncNotice() {
  const router = useRouter();
  return (
    <div data-testid="receipt-setup" className={cn(styles.surface, "flex min-w-0 items-center gap-3 p-3")}>
      <span aria-hidden="true" className={cn(styles.tile, SEMANTIC_ROLE_CLASSES.neutral.tile, SEMANTIC_ROLE_CLASSES.neutral.glyph)}>
        <Receipt className="size-5" />
      </span>
      <p data-profile-role="label" className="min-w-0 flex-1">Receipts aren&apos;t synced on this device yet.</p>
      <Button type="button" variant="secondary" size="compact" className="shrink-0"
        onClick={() => router.push(buildGmailWorkspaceRoute("receipts"))}>
        Open receipts
      </Button>
    </div>
  );
}

/** A mail brief from One's Email specialist, or the receipt sync hint. */
export function MailChatCard({ experience }: { experience: MailBriefExperience | ReceiptSetupExperience }) {
  return experience.type === RECEIPT_SETUP_EXPERIENCE_TYPE
    ? <ReceiptSyncNotice />
    : <MailBriefCard experience={experience} />;
}
