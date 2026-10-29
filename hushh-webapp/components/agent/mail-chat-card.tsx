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
const LABELS: Record<MailBriefCategory, { label: string; one: string; many: string }> = {
  action_items: { label: "Needs you", one: "needs you", many: "need you" },
  personal_info: { label: "Asks for your details", one: "asks for your details", many: "ask for your details" },
  payments_due: { label: "Payment due", one: "payment due", many: "payments due" },
  security_alerts: { label: "Security", one: "security notice", many: "security notices" },
  meetings: { label: "Meeting", one: "meeting", many: "meetings" },
};
const ICONS = {
  action_items: CircleAlert,
  personal_info: UserRound,
  payments_due: Receipt,
  security_alerts: ShieldAlert,
  meetings: CalendarClock,
} satisfies Record<MailBriefCategory, unknown>;

/** "2 need you · 1 payment due", in category order; zero counts are left out. */
export function summarizeMailBrief(experience: MailBriefExperience): string {
  const parts = MAIL_BRIEF_CATEGORIES.flatMap((name) => {
    const count = experience.counts[name] ?? 0;
    return count ? [`${count} ${count === 1 ? LABELS[name].one : LABELS[name].many}`] : [];
  });
  if (!parts.length) return "Nothing needs you in the mail checked.";
  return parts.join(" · ") + (experience.failed.length ? " · Some checks didn't finish" : "");
}

/** An unreadable date is left out rather than shown as "Due null". */
function when(item: MailBriefItem): string {
  const due = item.dueAt ? formatLocalDateTime(item.dueAt, { month: "short", day: "numeric" }) : null;
  if (due) return `Due ${due}`;
  const event = item.eventAt ? formatLocalDateTime(item.eventAt) : null;
  if (event) return event;
  return item.receivedAt ? formatRelativeTime(Date.parse(item.receivedAt)) : "";
}

function BriefItem({ item, top }: { item: MailBriefItem; top: boolean }) {
  const Icon = ICONS[item.category];
  const settled = item.state === "completed" || item.state === "cancelled";
  const role = SEMANTIC_ROLE_CLASSES[settled ? "neutral" : "warning"];
  const meta = [LABELS[item.category].label, item.senderName, when(item)].filter(Boolean).join(" · ");
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
  const items = [...experience.items].sort((a, b) =>
    Number(a.state === "completed" || a.state === "cancelled") - Number(b.state === "completed" || b.state === "cancelled"));
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
      {experience.moreMailOutsidePage ? (
        <p data-profile-role="description" className="mt-2">Only recent mail was checked.</p>
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
