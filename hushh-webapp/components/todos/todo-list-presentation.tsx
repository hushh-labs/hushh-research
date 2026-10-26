"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import {
  Calendar,
  Check,
  ClipboardCheck,
  Clock,
  ExternalLink,
  Mail,
  Pencil,
  Receipt,
  Trash2,
} from "@/components/icons";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import {
  CaptionText,
  HelperText,
  MediumRowLabel,
  SectionLabel,
} from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";
import { taskSort, TODO_SOURCE_LABELS, type TodoItem } from "@/lib/todos/todo-list-model";
import { cn } from "@/lib/utils";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";
import { buildGmailWorkspaceRoute } from "@/lib/navigation/routes";

/** Shared presentation and gestures only. The workspace/preview supplies all
 * read and mutation owners; importing a row never initializes a workspace. */
type DateGroup = {
  id: string;
  label: string;
  overdue: boolean;
  tasks: TodoItem[];
};

export function localDateKey(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return localDateKey(left) === localDateKey(right);
}

function dateFromKey(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateLabel(value: string | null): string {
  const date = dateFromKey(value);
  if (!date) return "No date";
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (isSameLocalDay(date, today)) return "Today";
  if (isSameLocalDay(date, tomorrow)) return "Tomorrow";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

function isOverdue(task: TodoItem): boolean {
  const date = dateFromKey(task.date);
  if (!date || task.status !== "pending") return false;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return date < startOfToday;
}

export { taskSort } from "@/lib/todos/todo-list-model";

export function groupByDate(tasks: TodoItem[]): DateGroup[] {
  const groups = new Map<string, DateGroup>();
  for (const task of [...tasks].sort(taskSort)) {
    const id = task.date ?? "anytime";
    const group = groups.get(id) ?? {
      id,
      label: task.date ? formatDateLabel(task.date) : "Any time",
      overdue: isOverdue(task),
      tasks: [],
    };
    group.tasks.push(task);
    group.overdue ||= isOverdue(task);
    groups.set(id, group);
  }
  return [...groups.values()].sort((left, right) => {
    if (left.id === "anytime") return -1;
    if (right.id === "anytime") return 1;
    return left.id.localeCompare(right.id);
  });
}

function hapticTick(): void {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    navigator.vibrate(8);
  }
}

function CircularCheckbox({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <ShellActionSurface
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        hapticTick();
        onChange();
      }}
      className={cn(
        "h-11 w-11 disabled:cursor-wait",
        checked
          ? "!bg-[color:var(--app-accent)] !text-[color:var(--app-accent-fg)]"
          : "!text-[color:var(--app-accent)]",
      )}
    >
      <Check className="size-4" aria-hidden="true" />
    </ShellActionSurface>
  );
}

function useRowSwipe({
  enabled,
  onComplete,
  onDelete,
}: {
  enabled: boolean;
  onComplete: () => void;
  onDelete: () => void;
}) {
  const start = useRef<{ x: number; y: number; pointerId: number } | null>(
    null,
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || event.pointerType === "mouse") return;
    if ((event.target as HTMLElement).closest("button, a, input, textarea"))
      return;
    start.current = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const initial = start.current;
    start.current = null;
    if (!initial || initial.pointerId !== event.pointerId) return;
    const dx = event.clientX - initial.x;
    const dy = event.clientY - initial.y;
    if (Math.abs(dx) < 64 || Math.abs(dx) <= Math.abs(dy)) return;
    if (dx > 0) onComplete();
    else onDelete();
  };

  return {
    onPointerDown,
    onPointerUp,
    onPointerCancel: () => {
      start.current = null;
    },
  };
}

export function TodoRow({
  task,
  saving,
  onToggle,
  onDelete,
  onEdit,
}: {
  task: TodoItem;
  saving: boolean;
  onToggle: (task: TodoItem, complete: boolean) => void;
  onDelete: (task: TodoItem, trigger?: HTMLButtonElement) => void;
  onEdit?: (task: TodoItem, trigger?: HTMLButtonElement) => void;
}) {
  const swipe = useRowSwipe({
    enabled: !saving,
    onComplete: () => onToggle(task, true),
    onDelete: () => onDelete(task),
  });
  const source = task.sourceAgent;
  const time = task.time
    ? new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(`1970-01-01T${task.time}:00`))
    : source === "calendar" && task.date
      ? "All day"
      : null;

  return (
    <div data-todo-item={task.id}>
      <div
        data-no-route-swipe
        className="grid touch-pan-y grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 px-3 py-1.5"
        {...swipe}
      >
        <MediumRowLabel
          as="h3"
          data-profile-role="name"
          className={cn(
            "self-center break-words [overflow-wrap:anywhere]",
            task.status === "done" && "text-muted-foreground line-through",
          )}
        >
          {task.title}
        </MediumRowLabel>
        <div className="flex shrink-0 items-center">
          {onEdit ? <ShellActionSurface className="h-11 w-11" aria-label={`Edit ${task.title}`}
            disabled={saving} onClick={event => onEdit(task, event.currentTarget)}>
            <Pencil className="size-4" aria-hidden="true" />
          </ShellActionSurface> : null}
          <CircularCheckbox
            checked={task.status === "done"}
            disabled={saving}
            label={`Mark ${task.title} as ${task.status === "done" ? "not completed" : "completed"}`}
            onChange={() => onToggle(task, task.status !== "done")}
          />
          <ShellActionSurface
            className="h-11 w-11 hover:text-destructive"
            aria-label={`Delete ${task.title}`}
            onClick={(event) => onDelete(task, event.currentTarget)}
            disabled={saving}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </ShellActionSurface>
        </div>
        {time || source || task.link ? (
          <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {time ? (
              <CaptionText
                data-profile-role="description"
                className={cn(
                  "inline-flex items-center gap-1.5 tabular-nums !text-[color:var(--app-secondary-label)]",
                  isOverdue(task) && "!text-destructive",
                )}
              >
                <Clock className="size-3.5" aria-hidden="true" />
                {time}
              </CaptionText>
            ) : null}
            {source ? (
              <CaptionText data-profile-role="description" className="inline-flex items-center gap-1.5 !text-[color:var(--app-secondary-label)]">
                {source === "calendar" ? (
                  <Calendar className="size-3.5" aria-hidden="true" />
                ) : source === "gmail" ? (
                  <Mail className="size-3.5" aria-hidden="true" />
                ) : (
                  <ClipboardCheck className="size-3.5" aria-hidden="true" />
                )}
                {TODO_SOURCE_LABELS[source]}
              </CaptionText>
            ) : null}
            {task.link ? (
              <Button
                asChild
                variant="none"
                effect="fade"
                size="compact"
                data-profile-role="action"
                className="ml-auto min-h-11 !px-2 !text-[color:var(--app-accent)]"
              >
                {task.link.startsWith("/") ? (
                  <Link href={task.link} aria-label={`Open ${task.title}`}>
                    Open
                  </Link>
                ) : (
                  <a
                    href={task.link}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${source === "calendar" ? "Join" : "Open"} ${task.title}`}
                  >
                    {source === "calendar" ? "Join" : "Open"}
                    <ExternalLink
                      className="ml-1 size-3.5"
                      aria-hidden="true"
                    />
                  </a>
                )}
              </Button>
            ) : null}
          </div>
        ) : null}
        {task.context ? <HelperText as="p" data-profile-role="description" className="col-span-2 mt-1 break-words [overflow-wrap:anywhere]">{task.context}</HelperText> : null}
        {source === "calendar" && !task.link ? <Button asChild variant="none" effect="fade" size="compact" className="col-span-2 ml-auto min-h-11"><Link href="/one/calendar" aria-label={`Open ${task.title} in Calendar`}>Open Calendar</Link></Button> : null}
        {task.notes ? (
          <HelperText as="p" data-profile-role="description" className="col-span-2 mt-1 break-words [overflow-wrap:anywhere]">
            {task.notes}
          </HelperText>
        ) : null}
      </div>
    </div>
  );
}

export interface DueReceiptItem {
  id: string;
  merchantName: string;
  title: string;
  amount: string | null;
  date: string | null;
  status: "overdue" | "renewal_due" | "payment_failed" | "attention";
  statusLabel: string;
  href: string;
}

export function extractDueReceipts(
  items: readonly ReceiptListItem[],
): DueReceiptItem[] {
  const dueItems: DueReceiptItem[] = [];
  for (const item of items) {
    const isOverdue =
      item.status === "overdue" || item.attention_reason === "overdue";
    const isFailed =
      item.status === "payment_failed" ||
      item.attention_reason === "payment_failed";
    const isRenewal =
      item.status === "renewal_due" || item.attention_reason === "renewal_due";
    const isSuspended =
      item.status === "suspended" || item.attention_reason === "suspended";
    const needsAttention =
      item.attention_state === "needs_attention" ||
      item.attention_state === "coming_up" ||
      item.attention_state === "needs_review";

    if (
      !isOverdue &&
      !isFailed &&
      !isRenewal &&
      !isSuspended &&
      !needsAttention
    ) {
      continue;
    }

    const status: DueReceiptItem["status"] = isFailed
      ? "payment_failed"
      : isOverdue
        ? "overdue"
        : isRenewal
          ? "renewal_due"
          : "attention";

    const statusLabel = isFailed
      ? "Payment failed"
      : isOverdue
        ? "Payment overdue"
        : isRenewal
          ? "Renewal due"
          : isSuspended
            ? "Payment suspended"
            : "Review payment";

    const merchant = item.merchant_name || item.from_name || "Payment due";
    const amountStr =
      typeof item.amount === "number" && Number.isFinite(item.amount)
        ? new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: item.currency || "USD",
          }).format(item.amount)
        : null;

    const dateStr =
      item.attention_date || item.receipt_date || item.transaction_date || null;
    let formattedDate: string | null = null;
    if (dateStr) {
      const parsed = new Date(dateStr);
      if (!Number.isNaN(parsed.getTime())) {
        formattedDate = new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
        }).format(parsed);
      }
    }

    dueItems.push({
      id: String(item.source_id || item.gmail_message_id || item.id),
      merchantName: merchant,
      title: item.subject || item.short_detail || merchant,
      amount: amountStr,
      date: formattedDate,
      status,
      statusLabel,
      href: buildGmailWorkspaceRoute("receipts"),
    });
  }
  return dueItems;
}

export function DueReceiptRow({ receipt }: { receipt: DueReceiptItem }) {
  return (
    <div data-receipt-item={receipt.id}>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[color:var(--app-neutral-fill)] text-foreground">
            <Receipt className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <MediumRowLabel as="h3" data-profile-role="name" className="min-w-0 break-words [overflow-wrap:anywhere]">
                {receipt.merchantName}
              </MediumRowLabel>
              <span
                data-profile-role="description"
                className={cn(
                  "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                  receipt.status === "overdue" ||
                    receipt.status === "payment_failed"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)]",
                )}
              >
                {receipt.statusLabel}
              </span>
            </div>
            <div data-profile-role="description" className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {receipt.amount ? (
                <span className="font-semibold text-foreground">
                  {receipt.amount}
                </span>
              ) : null}
              {receipt.amount && receipt.date ? <span>·</span> : null}
              {receipt.date ? <span>{receipt.date}</span> : null}
              {receipt.title && receipt.title !== receipt.merchantName ? (
                <>
                  <span>·</span>
                  <span className="truncate max-w-[200px]">
                    {receipt.title}
                  </span>
                </>
              ) : null}
            </div>
          </div>
        </div>
        <Button
          asChild
          variant="none"
          effect="fade"
          size="compact"
          data-profile-role="action"
          className="min-h-11 shrink-0 !px-2 !text-[color:var(--app-accent)]"
        >
          <Link
            href={receipt.href}
            aria-label={`View ${receipt.merchantName} receipt`}
          >
            View
            <ExternalLink className="ml-1 size-3.5" aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

export function DueReceiptsSection({
  receipts,
}: {
  receipts: DueReceiptItem[];
}) {
  if (receipts.length === 0) return null;
  return (
    <section aria-label="Due payments and receipts">
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <SectionLabel as="h2" data-profile-role="group-label" compact>
          <span>Receipts & Due Payments</span>
        </SectionLabel>
        <CaptionText data-profile-role="group-label" className="tabular-nums !text-[color:var(--app-secondary-label)]">
          {receipts.length}
        </CaptionText>
      </div>
      <SurfaceInset className="divide-y divide-border/60 p-0">
        {receipts.map((receipt) => (
          <DueReceiptRow key={receipt.id} receipt={receipt} />
        ))}
      </SurfaceInset>
    </section>
  );
}

export function TodoRows({
  tasks,
  savingTaskId,
  dueReceipts = [],
  onToggle,
  onDelete,
  onEdit,
}: {
  tasks: TodoItem[];
  savingTaskId: string | null;
  dueReceipts?: DueReceiptItem[];
  onToggle: (task: TodoItem, complete: boolean) => void;
  onDelete: (task: TodoItem, trigger?: HTMLButtonElement) => void;
  onEdit?: (task: TodoItem, trigger?: HTMLButtonElement) => void;
}) {
  const groups = groupByDate(tasks);
  const anytimeGroup = groups.find((g) => g.id === "anytime");
  const datedGroups = groups.filter((g) => g.id !== "anytime");

  return (
    <div className="space-y-3" data-no-auto-fade="true">
      {anytimeGroup ? (
        <section
          key={anytimeGroup.id}
          aria-label={
            anytimeGroup.overdue
              ? `${anytimeGroup.label}, overdue`
              : anytimeGroup.label
          }
        >
          <div className="mb-2 flex items-center justify-between gap-3 px-1">
            <SectionLabel as="h2" data-profile-role="group-label" compact>
              <span
                className={
                  anytimeGroup.overdue ? "text-destructive" : undefined
                }
              >
                {anytimeGroup.overdue
                  ? `${anytimeGroup.label} · Overdue`
                  : anytimeGroup.label}
              </span>
            </SectionLabel>
            <CaptionText data-profile-role="group-label" className="tabular-nums !text-[color:var(--app-secondary-label)]">
              {anytimeGroup.tasks.length}
            </CaptionText>
          </div>
          <SurfaceInset className="divide-y divide-border/60 p-0">
            {anytimeGroup.tasks.map((task) => (
              <TodoRow
                key={task.id}
                task={task}
                saving={Boolean(savingTaskId)}
                onToggle={onToggle}
                onDelete={onDelete}
                onEdit={onEdit}
              />
            ))}
          </SurfaceInset>
        </section>
      ) : null}

      <DueReceiptsSection receipts={dueReceipts} />

      {datedGroups.map((group) => (
        <section
          key={group.id}
          aria-label={group.overdue ? `${group.label}, overdue` : group.label}
        >
          <div className="mb-2 flex items-center justify-between gap-3 px-1">
            <SectionLabel as="h2" data-profile-role="group-label" compact>
              <span className={group.overdue ? "text-destructive" : undefined}>
                {group.overdue ? `${group.label} · Overdue` : group.label}
              </span>
            </SectionLabel>
            <CaptionText data-profile-role="group-label" className="tabular-nums !text-[color:var(--app-secondary-label)]">
              {group.tasks.length}
            </CaptionText>
          </div>
          <SurfaceInset className="divide-y divide-border/60 p-0">
            {group.tasks.map((task) => (
              <TodoRow
                key={task.id}
                task={task}
                saving={Boolean(savingTaskId)}
                onToggle={onToggle}
                onDelete={onDelete}
                onEdit={onEdit}
              />
            ))}
          </SurfaceInset>
        </section>
      ))}
    </div>
  );
}
