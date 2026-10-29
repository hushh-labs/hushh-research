"use client";

import { useCallback, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { usePathname } from "next/navigation";
import { toast } from "sonner";

import { Bell, Check, ChevronDown, ChevronUp, Receipt, UserRound } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  summarizeMailAttention,
  useMailAttention,
  type MailAttentionItem,
} from "@/lib/agent/use-mail-attention";
import { formatRelativeTime } from "@/lib/format/relative-time";
import { SEMANTIC_ROLE_CLASSES } from "@/lib/morphy-ux/tokens/semantic-roles";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { cn } from "@/lib/utils";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";

import styles from "./mail-attention-stack.module.css";

/** The only prompt this surface sends: fixed and app-authored, never item text. */
export const MAIL_BRIEF_PROMPT = "Brief me on my mail";
const MAX_PEEKS = 2;

type MailAttentionStackProps = {
  onAskOne: (prompt: string) => void;
  onOpenItem?: (item: MailAttentionItem) => void;
  /** Called when an action leaves nothing to show, so the owner can place focus. */
  onEmpty?: () => void;
  /** True while the owner cannot take a prompt. Only Brief me sends one, so only it waits. */
  briefDisabled?: boolean;
};

/** `keyboard` is true for Enter/Space activation, which fires a click with detail 0. */
type ItemAction = (item: MailAttentionItem, choice: "later" | "done", keyboard: boolean) => void;

function ItemIcon({ item }: { item: MailAttentionItem }) {
  const Icon = item.source === "receipt" ? Receipt : UserRound;
  const urgent = item.source === "receipt" && item.reason !== "renewal_due";
  const role = SEMANTIC_ROLE_CLASSES[urgent ? "warning" : "neutral"];
  return (
    <span aria-hidden="true" className={cn(styles.tile, role.tile, role.glyph)}>
      <Icon className="size-5" />
    </span>
  );
}

/** Text block; a button only when the owner of this surface can open the item. */
function ItemText({ item, onOpenItem, children }: {
  item: MailAttentionItem;
  onOpenItem?: (item: MailAttentionItem) => void;
  children: ReactNode;
}) {
  if (!onOpenItem) return <div className="min-w-0 flex-1">{children}</div>;
  return (
    <button
      type="button"
      onClick={() => onOpenItem(item)}
      className="min-h-11 min-w-0 flex-1 rounded-[var(--app-radius-md)] text-left outline-none focus-visible:ring-[3px] focus-visible:ring-[color:var(--app-focus-ring)]"
    >
      {children}
    </button>
  );
}

function AttentionCard({ item, onOpenItem, onAct }: {
  item: MailAttentionItem;
  onOpenItem?: (item: MailAttentionItem) => void;
  onAct: ItemAction;
}) {
  const when = item.receivedAt ? formatRelativeTime(Date.parse(item.receivedAt)) : "";
  return (
    <div data-testid="mail-attention-card" className={cn(styles.surface, styles.card, "p-3 sm:p-4")}>
      <div className="flex min-w-0 items-start gap-3">
        <ItemIcon item={item} />
        <ItemText item={item} onOpenItem={onOpenItem}>
          <span data-profile-role="description" className="block truncate">
            {[item.subtitle, when].filter(Boolean).join(" · ")}
          </span>
          <span data-profile-role="label" className="mt-0.5 block break-words [overflow-wrap:anywhere]">
            {item.title}
          </span>
        </ItemText>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="secondary" size="compact" aria-label={`Remind me later: ${item.title}`}
          onClick={(event) => onAct(item, "later", event.detail === 0)}>
          <Bell aria-hidden="true" />
          Remind me later
        </Button>
        <Button type="button" variant="default" size="compact" aria-label={`Mark as done: ${item.title}`}
          onClick={(event) => onAct(item, "done", event.detail === 0)}>
          <Check aria-hidden="true" />
          Mark as done
        </Button>
      </div>
    </div>
  );
}

function AttentionRow({ item, onOpenItem }: {
  item: MailAttentionItem;
  onOpenItem?: (item: MailAttentionItem) => void;
}) {
  const date = item.receivedAt ? formatLocalDateTime(item.receivedAt, { month: "short", day: "numeric" }) : null;
  return (
    <div className={cn(styles.surface, "flex min-w-0 items-center gap-3 p-3")}>
      <ItemIcon item={item} />
      <ItemText item={item} onOpenItem={onOpenItem}>
        <span data-profile-role="label" className="block truncate">{item.title}</span>
        <span data-profile-role="description" className="block truncate">{item.subtitle}</span>
      </ItemText>
      {date ? <span data-profile-role="description" className="shrink-0 tabular-nums">{date}</span> : null}
    </div>
  );
}

function CollapsedStack({ items, onOpenItem, onAct }: {
  items: readonly MailAttentionItem[];
  onOpenItem?: (item: MailAttentionItem) => void;
  onAct: ItemAction;
}) {
  const [top] = items;
  if (!top) return null;
  const peeks = Math.min(items.length - 1, MAX_PEEKS);
  return (
    <div className={styles.stack} style={{ "--peek-count": peeks } as CSSProperties}>
      <AttentionCard key={top.id} item={top} onOpenItem={onOpenItem} onAct={onAct} />
      {Array.from({ length: peeks }, (_, index) => (
        <div key={index} aria-hidden="true" className={cn(styles.surface, styles.peek)}
          style={{ "--peek-index": index + 1 } as CSSProperties} />
      ))}
    </div>
  );
}

/**
 * Chat welcome nudges for factual, already classified Mail items: receipts
 * that need attention and detected requests for the owner's details. Renders
 * nothing unless something qualifies. Choices are per viewer on this device;
 * Mail itself is unchanged.
 */
export function MailAttentionStack({ onAskOne, onOpenItem, onEmpty, briefDisabled }: MailAttentionStackProps) {
  const { items, remindLater, markDone } = useMailAttention();
  const pathname = usePathname() || "/";
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  const regionId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const canExpand = items.length > 1;
  const isExpanded = expanded && canExpand;
  const setListExpanded = useCallback((next: boolean) => {
    // The region's content is replaced; focus inside it would drop to the page.
    if (regionRef.current?.contains(document.activeElement)) toggleRef.current?.focus({ preventScroll: true });
    setExpanded(next);
  }, []);
  const collapse = useCallback(() => {
    setListExpanded(false);
    return true;
  }, [setListExpanded]);
  useBackLayer(pathname, isExpanded ? 1 : 0, collapse);
  const act = useCallback<ItemAction>((item, choice, keyboard) => {
    // Commit before placing focus: the write re-reads storage, so it can bring
    // items back as well as hide the last one.
    const undo = flushSync(() => (choice === "later" ? remindLater(item) : markDone(item)));
    // The acted-on card is gone. Keep focus in the stack, or, for keyboard use,
    // let its owner place focus once the whole stack has unmounted. A tap leaves
    // it: focusing a text field there would open the phone's keyboard.
    if (sectionRef.current) regionRef.current?.focus({ preventScroll: true });
    else if (keyboard) onEmpty?.();
    toast(choice === "later" ? "Hidden for 24 hours" : "Marked as done", {
      action: { label: "Undo", onClick: () => undo() },
    });
  }, [onEmpty, remindLater, markDone]);
  if (!items.length) return null;
  return (
    <section ref={sectionRef} aria-labelledby={headingId} data-testid="mail-attention-stack" className="mx-auto mt-3 w-full max-w-2xl px-1 sm:px-2">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} data-profile-role="group-label">Mail</h3>
          <p data-profile-role="description" className="break-words">{summarizeMailAttention(items)}</p>
        </div>
        <Button type="button" variant="ghost" size="compact" className="shrink-0" aria-label="Brief me on my mail"
          disabled={briefDisabled} onClick={() => onAskOne(MAIL_BRIEF_PROMPT)}>
          Brief me
        </Button>
      </div>
      <div id={regionId} ref={regionRef} tabIndex={-1} className="mt-3 outline-none">
        {isExpanded ? (
          <ul aria-label="Mail items" className={cn(styles.list, "motion-step-enter")}>
            {items.map((item) => (
              <li key={item.id}><AttentionRow item={item} onOpenItem={onOpenItem} /></li>
            ))}
          </ul>
        ) : (
          <CollapsedStack items={items} onOpenItem={onOpenItem} onAct={act} />
        )}
      </div>
      {canExpand ? (
        <div className="mt-3 flex justify-center">
          <Button ref={toggleRef} type="button" variant="secondary" size="compact" aria-expanded={isExpanded} aria-controls={regionId}
            onClick={() => setListExpanded(!isExpanded)}>
            {isExpanded ? "Hide" : "Show all"}
            {isExpanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
