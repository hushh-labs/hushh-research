"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type Ref,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Link from "next/link";

import {
  Calendar,
  Check,
  ChevronDown,
  ClipboardCheck,
  Clock,
  ExternalLink,
  Lock,
  Mail,
  Plus,
  Receipt,
  RefreshCw,
  Trash2,
} from "@/components/icons";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { ProfilePaneTaskAddIcon } from "@/components/profile/profile-pane-icons";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceCard } from "@/components/app-ui/surfaces";
import {
  CaptionText,
  HelperText,
  MediumRowLabel,
  SectionLabel,
} from "@/components/app-ui/typography";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { useCalendarConnectionStatus } from "@/lib/calendar/use-calendar-connection-status";
import {
  useCalendarUpcomingEvents,
  type RedactedCalendarEvent,
} from "@/lib/calendar/use-calendar-upcoming-events";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  TodoListPkmService,
  TODO_SOURCE_LABELS,
  agentTodoInput,
  buildTodo,
  calendarTodoInput,
  completedTodoItems,
  createTodo,
  openTodoItems,
  isLiveAgentTodo,
  type TodoItem,
} from "@/lib/services/todo-list-pkm-service";
import { useFeedActionables } from "@/lib/feed/use-feed-actionables";
import { useFeedBriefing } from "@/lib/feed/use-feed-briefing";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import {
  getCachedGmailReceipts,
  cachedGmailReceiptDisplayItems,
} from "@/lib/profile/gmail-receipts-cache";
import type { ReceiptListItem } from "@/lib/services/gmail-receipts-service";
import { buildGmailWorkspaceRoute } from "@/lib/navigation/routes";

type EditableTodoFields = {
  title: string;
  date: string | null;
  time: string | null;
  notes: string | null;
};

type DateGroup = {
  id: string;
  label: string;
  overdue: boolean;
  tasks: TodoItem[];
};

function localDateKey(value: Date): string {
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

function calendarStart(event: RedactedCalendarEvent): Date | null {
  const value =
    event.start?.dateTime ??
    (event.start?.date ? `${event.start.date}T00:00:00` : null);
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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

export function taskSort(left: TodoItem, right: TodoItem): number {
  const date = (left.date ?? "9999-12-31").localeCompare(
    right.date ?? "9999-12-31",
  );
  if (date !== 0) return date;
  const time = (left.time ?? "99:99").localeCompare(right.time ?? "99:99");
  if (time !== 0) return time;
  return left.title.localeCompare(right.title);
}

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

function calendarTask(
  event: RedactedCalendarEvent,
  index: number,
): TodoItem | null {
  const start = calendarStart(event);
  if (!start || event.status?.toLowerCase() === "cancelled") return null;
  const sourceId = event.id ?? `${event.title}-${start.toISOString()}-${index}`;
  const input = calendarTodoInput({
    id: sourceId,
    title: event.title,
    start: event.start,
    conferenceUrl: event.conferenceUrl,
  });
  return input ? buildTodo(input, start.toISOString()) : null;
}

/** Merge fresh Calendar projection with encrypted owner completion/dismissal state. */
function mergeAutomaticTasks(
  events: RedactedCalendarEvent[],
  saved: TodoItem[],
): TodoItem[] {
  const savedAutomatic = new Map(
    saved
      .filter((task) => task.type === "automatic" && !isLiveAgentTodo(task))
      .map((task) => [task.sourceId ?? task.id, task]),
  );
  const seen = new Set<string>();
  const projected = events.flatMap((event, index) => {
    const fromCalendar = calendarTask(event, index);
    if (!fromCalendar) return [];
    const key = fromCalendar.sourceId ?? fromCalendar.id;
    seen.add(key);
    const stored = savedAutomatic.get(key);
    if (stored?.status === "done" || stored?.status === "deleted") return [];
    return [
      {
        ...fromCalendar,
        ...(stored
          ? {
              status: stored.status,
              completedAt: stored.completedAt,
              deletedAt: stored.deletedAt,
              createdAt: stored.createdAt,
              updatedAt: stored.updatedAt,
            }
          : {}),
      },
    ];
  });

  // The Calendar read may lag briefly after a successful booking. Keep the
  // encrypted automatic snapshot visible until the provider projection catches up.
  for (const task of savedAutomatic.values()) {
    const key = task.sourceId ?? task.id;
    if (task.status === "pending" && !seen.has(key)) projected.push(task);
  }
  return projected.sort(taskSort);
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
      <Check className="size-5" aria-hidden="true" />
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
}: {
  task: TodoItem;
  saving: boolean;
  onToggle: (task: TodoItem, complete: boolean) => void;
  onDelete: (task: TodoItem, trigger?: HTMLButtonElement) => void;
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
    <SurfaceCard data-todo-item={task.id}>
      <div
        data-no-route-swipe
        className="grid touch-pan-y grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 px-4 py-3 sm:gap-x-4 sm:px-5 sm:py-4"
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
        <div className="flex shrink-0 items-center gap-1">
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
          <div className="col-span-2 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
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
                className="ml-auto !px-2 !text-[color:var(--app-accent)]"
              >
                {task.link.startsWith("/") ? (
                  <Link href={task.link} aria-label={`Open ${task.title}`}>Open</Link>
                ) : (
                  <a href={task.link} target="_blank" rel="noreferrer"
                    aria-label={`${source === "calendar" ? "Join" : "Open"} ${task.title}`}>
                    {source === "calendar" ? "Join" : "Open"}
                    <ExternalLink className="ml-1 size-3.5" aria-hidden="true" />
                  </a>
                )}
              </Button>
            ) : null}
          </div>
        ) : null}
        {task.notes ? (
          <HelperText as="p" data-profile-role="description" className="col-span-2 mt-1 break-words [overflow-wrap:anywhere]">
            {task.notes}
          </HelperText>
        ) : null}
      </div>
    </SurfaceCard>
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
      item.status === "renewal_due" ||
      item.attention_reason === "renewal_due";
    const isSuspended =
      item.status === "suspended" || item.attention_reason === "suspended";
    const needsAttention =
      item.attention_state === "needs_attention" ||
      item.attention_state === "coming_up" ||
      item.attention_state === "needs_review";

    if (!isOverdue && !isFailed && !isRenewal && !isSuspended && !needsAttention) {
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
    <SurfaceCard data-receipt-item={receipt.id}>
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:gap-4 sm:px-5 sm:py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-neutral-fill)] text-foreground">
            <Receipt className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <MediumRowLabel as="h3" data-profile-role="name" className="truncate">
                {receipt.merchantName}
              </MediumRowLabel>
              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                  receipt.status === "overdue" || receipt.status === "payment_failed"
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
                  <span className="truncate max-w-[200px]">{receipt.title}</span>
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
          className="shrink-0 !px-2 !text-[color:var(--app-accent)]"
        >
          <Link href={receipt.href} aria-label={`View ${receipt.merchantName} receipt`}>
            View
            <ExternalLink className="ml-1 size-3.5" aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </SurfaceCard>
  );
}

export function DueReceiptsSection({ receipts }: { receipts: DueReceiptItem[] }) {
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
      <div className="space-y-2.5">
        {receipts.map((receipt) => (
          <DueReceiptRow key={receipt.id} receipt={receipt} />
        ))}
      </div>
    </section>
  );
}

export function TodoRows({
  tasks,
  savingTaskId,
  dueReceipts = [],
  onToggle,
  onDelete,
}: {
  tasks: TodoItem[];
  savingTaskId: string | null;
  dueReceipts?: DueReceiptItem[];
  onToggle: (task: TodoItem, complete: boolean) => void;
  onDelete: (task: TodoItem, trigger?: HTMLButtonElement) => void;
}) {
  const groups = groupByDate(tasks);
  const anytimeGroup = groups.find((g) => g.id === "anytime");
  const datedGroups = groups.filter((g) => g.id !== "anytime");

  return (
    <div className="space-y-6" data-no-auto-fade="true">
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
              <span className={anytimeGroup.overdue ? "text-destructive" : undefined}>
                {anytimeGroup.overdue
                  ? `${anytimeGroup.label} · Overdue`
                  : anytimeGroup.label}
              </span>
            </SectionLabel>
            <CaptionText data-profile-role="group-label" className="tabular-nums !text-[color:var(--app-secondary-label)]">
              {anytimeGroup.tasks.length}
            </CaptionText>
          </div>
          <div className="space-y-2.5">
            {anytimeGroup.tasks.map((task) => (
              <TodoRow
                key={task.id}
                task={task}
                saving={savingTaskId === task.id}
                onToggle={onToggle}
                onDelete={onDelete}
              />
            ))}
          </div>
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
          <div className="space-y-2.5">
            {group.tasks.map((task) => (
              <TodoRow
                key={task.id}
                task={task}
                saving={savingTaskId === task.id}
                onToggle={onToggle}
                onDelete={onDelete}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TodoAddItemSheet({
  open,
  saving,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (input: EditableTodoFields) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDate("");
    setTime("");
    setNotes("");
    setNotesOpen(false);
  }, [open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim()) return;
    await onSave({
      title: title.trim(),
      date: date || null,
      time: time || null,
      notes: notes.trim() || null,
    });
  };

  return (
    <Sheet
      modal
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <SheetContent
        side="bottom"
        className="mx-auto max-w-xl gap-0 rounded-t-[var(--app-card-radius-feature)] border-0 bg-[color:var(--app-card-surface-default-solid)] p-0 sm:bottom-6 sm:max-w-lg sm:rounded-[var(--app-card-radius-feature)]"
        showCloseButton={!saving}
      >
        <form onSubmit={(event) => void submit(event)}>
          <SheetHeader className="px-5 pb-3 pt-2 text-left">
            <SheetTitle className="text-xl tracking-[-0.02em]">
              Add item
            </SheetTitle>
            <SheetDescription className="sr-only">
              This stays encrypted in your private agent.
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-4 px-5 pb-2">
            <div className="space-y-1.5">
              <Label htmlFor="todo-title" className="sr-only">
                Title
              </Label>
              <Input
                id="todo-title"
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={saving}
                placeholder="What do you want to do?"
                maxLength={240}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="todo-date">Date</Label>
                <Input
                  id="todo-date"
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  disabled={saving}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="todo-time">Time</Label>
                <Input
                  id="todo-time"
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  disabled={saving}
                />
              </div>
            </div>
            {notesOpen ? (
              <div className="space-y-1.5">
                <Label htmlFor="todo-notes">Notes</Label>
                <Textarea
                  id="todo-notes"
                  autoFocus
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  disabled={saving}
                  placeholder="Add a detail"
                  maxLength={1200}
                  className="min-h-22 resize-none"
                />
              </div>
            ) : (
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="compact"
                className="!px-0"
                disabled={saving}
                onClick={() => setNotesOpen(true)}
              >
                Add a note
              </Button>
            )}
          </div>
          <SheetFooter className="flex-row items-center justify-end gap-2 px-5 pt-5">
            <Button
              type="button"
              variant="none"
              effect="fill"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="prominent"
              disabled={saving || !title.trim()}
              loading={saving}
            >
              Save
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function AddItemButton({
  disabled,
  onClick,
  buttonRef,
}: {
  disabled: boolean;
  onClick: () => void;
  buttonRef: Ref<HTMLButtonElement>;
}) {
  return (
    <Button
      ref={buttonRef}
      data-todo-add-item="true"
      size="compact"
      onClick={onClick}
      disabled={disabled}
    >
      <Plus className="mr-1.5 size-4" aria-hidden="true" />
      Add item
    </Button>
  );
}

export function TodoListPage() {
  const { user } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const [editorOpen, setEditorOpen] = useState(false);
  const [tasks, setTasks] = useState<TodoItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const [itemsLoadError, setItemsLoadError] = useState(false);
  const itemsLoadRevision = useRef(0);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [deleteRequest, setDeleteRequest] = useState<TodoItem | null>(null);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const addItemRef = useRef<HTMLButtonElement | null>(null);

  const userId = user?.uid ?? null;
  const writeReady = Boolean(
    userId && isVaultUnlocked && vaultKey && vaultOwnerToken,
  );
  const agentFeed = useFeedActionables({ enabled: writeReady });
  const { pendingKyc, kycLoading, kycError, retryKyc } = useFeedBriefing({ enabled: writeReady, includeCalendar: false, includeNudges: false });
  const agentLoadError = agentFeed.error || agentFeed.progressError || kycError;
  const agentLoading = agentFeed.loading || agentFeed.progressLoading || kycLoading;
  useEffect(() => {
    if (writeReady) return;
    setEditorOpen(false);
    setDeleteRequest(null);
    deleteTriggerRef.current = null;
  }, [writeReady]);
  const idTokenProvider = useCallback(
    () => user?.getIdToken() ?? Promise.resolve(""),
    [user],
  );
  const calendar = useCalendarConnectionStatus({
    userId,
    idTokenProvider: user ? idTokenProvider : null,
  });
  const gmail = useGmailConnectorStatus({
    userId,
    idTokenProvider: user ? idTokenProvider : null,
  });
  const receiptAccountKey =
    gmail.status?.google_sub || gmail.status?.google_email || null;
  const cachedReceipts = useMemo(() => {
    if (!writeReady || !receiptAccountKey) return null;
    return getCachedGmailReceipts(userId, receiptAccountKey);
  }, [receiptAccountKey, userId, writeReady]);
  const dueReceipts = useMemo(() => {
    if (!cachedReceipts) return [];
    return extractDueReceipts(cachedGmailReceiptDisplayItems(cachedReceipts));
  }, [cachedReceipts]);
  const upcoming = useCalendarUpcomingEvents({
    userId,
    vaultOwnerToken,
    isConnected: calendar.connected,
    windowHours: 168,
  });
  const calendarReadLoading = !calendar.loaded || calendar.loading ||
    (calendar.connected && (!upcoming.loaded || upcoming.loading));
  const calendarReadError = Boolean(calendar.error || upcoming.error);

  const loadItems = useCallback(async () => {
    const revision = ++itemsLoadRevision.current;
    if (!userId || !isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
      setTasks([]);
      setItemsLoading(false);
      setItemsLoaded(false);
      setItemsLoadError(false);
      return;
    }
    setItemsLoading(true);
    setItemsLoaded(false);
    setItemsLoadError(false);
    setTasks([]);
    try {
      const state = await TodoListPkmService.load({
        userId,
        vaultKey,
        vaultOwnerToken,
      });
      if (revision !== itemsLoadRevision.current) return;
      setTasks(state.tasks);
    } catch {
      if (revision !== itemsLoadRevision.current) return;
      setItemsLoadError(true);
      morphyToast.error("Your list couldn’t load. Try refreshing the page.");
    } finally {
      if (revision === itemsLoadRevision.current) {
        setItemsLoaded(true);
        setItemsLoading(false);
      }
    }
  }, [isVaultUnlocked, userId, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    void loadItems();
    return () => { itemsLoadRevision.current += 1; };
  }, [loadItems]);

  const pending = useMemo(
    () => {
      const saved = new Map(tasks.map((task) => [task.id, task]));
      const live = new Map<string, TodoItem>();
      for (const item of agentFeed.actionables) {
        if (!item.todo) continue;
        const input = agentTodoInput(item.id, item.todo);
        if (!input) continue;
        const task = buildTodo(input);
        const status = saved.get(task.id)?.status;
        if (status !== "done" && status !== "deleted") live.set(task.id, task);
      }
      if (pendingKyc) {
        const input = agentTodoInput(`kyc:${pendingKyc.workflowId}`, {
          source: "kyc", title: pendingKyc.count > 1 ? `Review ${pendingKyc.count} information requests` : "Review information request",
          href: "/one/gmail?workspace=kyc",
        });
        if (input) {
          const task = buildTodo(input);
          const status = saved.get(task.id)?.status;
          if (status !== "done" && status !== "deleted") live.set(task.id, task);
        }
      }
      return [
        ...mergeAutomaticTasks(upcoming.events, tasks),
        ...live.values(),
        ...openTodoItems(tasks).filter((task) => task.type === "manual"),
      ].sort(taskSort);
    },
    [agentFeed.actionables, pendingKyc, upcoming.events, tasks],
  );
  const completed = useMemo(() => completedTodoItems(tasks), [tasks]);
  const today = localDateKey(new Date());
  const doneToday = completed.filter((task) => task.date === today).length;
  const totalToday =
    doneToday + pending.filter((task) => task.date === today).length;

  const requireSaved = <T extends { success: boolean; message?: string }>(
    result: T,
  ): T => {
    if (!result.success) throw new Error(result.message || "Saving failed");
    return result;
  };

  const saveTask = async (input: EditableTodoFields) => {
    if (!writeReady || !userId || !vaultKey || !vaultOwnerToken) return;
    setSavingTaskId("new-item");

    const operation = createTodo(
      { ...input, type: "manual" },
      { userId, vaultKey, vaultOwnerToken },
    ).then(({ task, result }) => ({ task, result: requireSaved(result) }));
    void morphyToast.promise(operation, {
      loading: "Saving item…",
      success: "Item saved.",
      error: "Item couldn’t be saved. Try again.",
    });
    try {
      const { task } = await operation;
      setTasks((currentTasks) => [task, ...currentTasks]);
      setEditorOpen(false);
    } catch {
      // The shared promise toast owns the failure state.
    } finally {
      setSavingTaskId(null);
    }
  };

  const toggleTask = async (task: TodoItem, complete: boolean) => {
    if (!writeReady || !userId || !vaultKey || !vaultOwnerToken) return;
    const nextStatus: "pending" | "done" = complete ? "done" : "pending";
    const optimistic: TodoItem = {
      ...task,
      status: nextStatus,
      completedAt: complete ? new Date().toISOString() : null,
      deletedAt: null,
      updatedAt: new Date().toISOString(),
    };
    setSavingTaskId(task.id);
    setTasks((current) =>
      current.some((item) => item.id === task.id)
        ? current.map((item) => (item.id === task.id ? optimistic : item))
        : [optimistic, ...current],
    );
    const operation = TodoListPkmService.setStatus({
      userId,
      vaultKey,
      vaultOwnerToken,
      task,
      status: nextStatus,
    }).then(requireSaved);
    void morphyToast.promise(operation, {
      loading: complete ? "Completing item…" : "Restoring item…",
      success: complete ? "Item completed." : "Item restored.",
      error: "Item couldn’t be updated. Try again.",
    });
    try {
      await operation;
    } catch {
      setTasks((current) =>
        current.some((item) => item.id === task.id)
          ? current.map((item) => (item.id === task.id ? task : item))
          : current,
      );
    } finally {
      setSavingTaskId(null);
    }
  };

  const deleteTask = async (task: TodoItem) => {
    if (!writeReady || !userId || !vaultKey || !vaultOwnerToken) return;
    const tombstone: TodoItem = {
      ...task,
      status: "deleted",
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setSavingTaskId(task.id);
    setTasks((current) =>
      task.type === "automatic"
        ? current.some((item) => item.id === task.id)
          ? current.map((item) => (item.id === task.id ? tombstone : item))
          : [tombstone, ...current]
        : current.filter((item) => item.id !== task.id),
    );
    const operation = TodoListPkmService.remove({
      userId,
      vaultKey,
      vaultOwnerToken,
      task,
    }).then(requireSaved);
    void morphyToast.promise(operation, {
      loading: "Deleting item…",
      success: "Item deleted.",
      error: "Item couldn’t be deleted. Try again.",
      variant: "destructive",
    });
    try {
      await operation;
    } catch {
      setTasks((current) =>
        current.some((item) => item.id === task.id)
          ? current.map((item) => (item.id === task.id ? task : item))
          : [task, ...current],
      );
    } finally {
      setSavingTaskId(null);
    }
  };

  const openCreate = () => {
    setEditorOpen(true);
  };

  const requestDelete = (task: TodoItem, trigger?: HTMLButtonElement) => {
    deleteTriggerRef.current =
      trigger ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    setDeleteRequest(task);
  };

  return (
    <AppPageShell
      as="main"
      data-profile-type-scale="page"
      data-todo-list-page="true"
      width="reading"
      fitContent
      className="bg-transparent"
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow={new Intl.DateTimeFormat(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          }).format(new Date())}
          title="Your tasks"
          titleRole="agent"
          actionsInlineMobile
          actions={
            <div className="flex items-center gap-2">
            {writeReady && agentLoadError ? (
              <Button variant="none" effect="fade" size="compact"
                aria-label="Retry agent tasks" disabled={agentLoading}
                onClick={() => void Promise.all([agentFeed.retry(), retryKyc()]).catch(() => {
                  morphyToast.error("Agent tasks couldn’t refresh. Try again.");
                })}>Retry</Button>
            ) : null}
            <AddItemButton
              buttonRef={addItemRef}
              disabled={!writeReady || itemsLoading}
              onClick={openCreate}
            />
            </div>
          }
        />
        {writeReady && agentLoadError ? (
          <HelperText as="p" role="status">Some agent tasks couldn’t refresh. Your other items are still here.</HelperText>
        ) : null}
        {writeReady && itemsLoadError ? (
          <div className="flex items-center gap-2" role="status">
            <HelperText as="p">Your saved items couldn’t load.</HelperText>
            <Button variant="none" effect="fade" size="compact" onClick={() => void loadItems()}>Retry</Button>
          </div>
        ) : null}
        {writeReady && calendarReadError ? (
          <div className="flex items-center gap-2" role="status">
            <HelperText as="p">Some Calendar tasks couldn’t load.</HelperText>
            <Button variant="none" effect="fade" size="compact" onClick={() => { calendar.refresh(); upcoming.refresh(); }}>Retry</Button>
          </div>
        ) : null}
        {writeReady && !itemsLoading && totalToday > 0 ? (
          <div className="mt-5 flex items-center gap-4" aria-live="polite">
            <CaptionText data-profile-role="description" className="shrink-0 tabular-nums !text-[color:var(--app-secondary-label)]">
              {doneToday} of {totalToday} done today
            </CaptionText>
            <div
              role="progressbar"
              aria-label="Today's completion"
              aria-valuemin={0}
              aria-valuemax={totalToday}
              aria-valuenow={doneToday}
              aria-valuetext={`${doneToday} of ${totalToday} tasks completed`}
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-[color:var(--app-accent-surface)]"
            >
              <div
                className="h-full origin-left rounded-full bg-[color:var(--app-accent)] transition-transform duration-150 motion-reduce:transition-none"
                style={{ transform: `scaleX(${doneToday / totalToday})` }}
              />
            </div>
          </div>
        ) : null}
      </AppPageHeaderRegion>

      <AppPageContentRegion className="space-y-6 pb-6">
        {!writeReady ? (
          <SurfaceCard>
            <div className="flex items-center gap-3 px-4 py-5">
              <Lock
                className="size-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <HelperText as="p" data-profile-role="description">
                Unlock your vault to see your list.
              </HelperText>
            </div>
          </SurfaceCard>
        ) : !itemsLoaded || itemsLoading ||
          ((agentLoading || calendarReadLoading) && pending.length === 0) ? (
          <div role="status" className="flex items-center gap-2 px-1">
            <RefreshCw
              className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
              aria-hidden="true"
            />
            <HelperText data-profile-role="description">Loading your list…</HelperText>
          </div>
        ) : pending.length > 0 || dueReceipts.length > 0 ? (
          <TodoRows
            tasks={pending}
            dueReceipts={dueReceipts}
            savingTaskId={savingTaskId}
            onToggle={toggleTask}
            onDelete={requestDelete}
          />
        ) : itemsLoadError || agentLoadError || calendarReadError ? null : (
          <div data-todo-empty-state="true" className="flex max-w-sm items-start gap-3 px-1 py-4 text-left">
            <ProfilePaneTaskAddIcon size={26} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <MediumRowLabel as="h2" data-profile-role="name">
                {tasks.length === 0 && completed.length === 0 ? "No tasks yet" : "No pending tasks"}
              </MediumRowLabel>
              <HelperText as="p" data-profile-role="description" className="mt-1">
                {tasks.length === 0 && completed.length === 0
                  ? "Add an item to get started."
                  : "New tasks will appear here."}
              </HelperText>
            </div>
          </div>
        )}
        {writeReady && agentFeed.actionables.some((item) => item.id === "consent:overflow") ? (
          <Button asChild variant="none" effect="fade" size="compact">
            <Link href={agentFeed.actionables.find((item) => item.id === "consent:overflow")!.href || "/one/feed"}>View all pending requests</Link>
          </Button>
        ) : null}

        {writeReady && !itemsLoading && completed.length > 0 ? (
          <section aria-labelledby="completed-heading">
            <button
              type="button"
              onClick={() => setCompletedOpen((open) => !open)}
              aria-expanded={completedOpen}
              aria-controls="todo-completed-items"
              className="flex min-h-11 w-full items-center justify-between px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)]"
            >
              <span>
                <span
                  id="completed-heading"
                  data-profile-role="group-label"
                  className="text-muted-foreground"
                >
                  Completed
                </span>
                <span data-profile-role="group-label" className="ml-2 text-muted-foreground">
                  {completed.length}
                </span>
              </span>
              <ChevronDown
                className={cn(
                  "size-4 text-muted-foreground transition-transform motion-reduce:transition-none",
                  completedOpen && "rotate-180",
                )}
                aria-hidden="true"
              />
            </button>
            <div
              id="todo-completed-items"
              className="mt-2"
              hidden={!completedOpen}
            >
              {completedOpen ? (
                <TodoRows
                  tasks={completed}
                  savingTaskId={savingTaskId}
                  onToggle={toggleTask}
                  onDelete={requestDelete}
                />
              ) : null}
            </div>
          </section>
        ) : null}
      </AppPageContentRegion>

      {writeReady ? (
        <TodoAddItemSheet
          open={editorOpen}
          saving={savingTaskId !== null}
          onOpenChange={setEditorOpen}
          onSave={saveTask}
        />
      ) : null}
      {writeReady ? (
        <AlertDialog
          open={deleteRequest !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteRequest(null);
          }}
        >
          <AlertDialogContent
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const trigger = deleteTriggerRef.current;
              if (trigger?.isConnected && !trigger.hasAttribute("disabled")) {
                trigger.focus();
              } else {
                addItemRef.current?.focus();
              }
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Delete item?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes “{deleteRequest?.title}” from your to-do list.
                Calendar events and emails stay in place.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  if (deleteRequest) void deleteTask(deleteRequest);
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </AppPageShell>
  );
}
