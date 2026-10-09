"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  Calendar,
  Check,
  ChevronDown,
  ClipboardCheck,
  ExternalLink,
  Lock,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "@/components/icons";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
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
  buildTodo,
  calendarTodoInput,
  completedTodoItems,
  createTodo,
  openTodoItems,
  type TodoItem,
} from "@/lib/services/todo-list-pkm-service";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";

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

function taskSort(left: TodoItem, right: TodoItem): number {
  const date = (left.date ?? "9999-12-31").localeCompare(
    right.date ?? "9999-12-31",
  );
  if (date !== 0) return date;
  const time = (left.time ?? "99:99").localeCompare(right.time ?? "99:99");
  if (time !== 0) return time;
  return left.title.localeCompare(right.title);
}

function groupByDate(tasks: TodoItem[]): DateGroup[] {
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
    if (left.id === "anytime") return 1;
    if (right.id === "anytime") return -1;
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
      .filter((task) => task.type === "automatic")
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
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        hapticTick();
        onChange();
      }}
      className={cn(
        "mt-0.5 grid size-8 shrink-0 place-items-center rounded-full border transition-[transform,colors,box-shadow] duration-200 motion-reduce:transition-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)] focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-50",
        checked
          ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-white shadow-[0_3px_10px_color-mix(in_oklab,var(--app-accent)_28%,transparent)]"
          : "border-border/80 bg-background text-transparent hover:border-[color:var(--app-accent)]",
      )}
    >
      <Check
        className={cn(
          "size-4 transition-transform duration-200 motion-reduce:transition-none",
          checked ? "scale-100" : "scale-50",
        )}
        aria-hidden="true"
      />
    </button>
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

function TodoRow({
  task,
  saving,
  onToggle,
  onDelete,
  onEdit,
}: {
  task: TodoItem;
  saving: boolean;
  onToggle: (task: TodoItem, complete: boolean) => void;
  onDelete: (task: TodoItem) => void;
  onEdit?: (task: TodoItem) => void;
}) {
  const swipe = useRowSwipe({
    enabled: !saving,
    onComplete: () => onToggle(task, true),
    onDelete: () => onDelete(task),
  });
  const source = task.sourceAgent;
  const canEdit = task.type === "manual" && Boolean(onEdit);

  return (
    <div
      data-no-route-swipe
      className="group flex min-h-[72px] touch-pan-y items-start gap-3 px-4 py-3.5"
      {...swipe}
    >
      <CircularCheckbox
        checked={task.status === "done"}
        disabled={saving}
        label={`Mark ${task.title} as ${task.status === "done" ? "not completed" : "completed"}`}
        onChange={() => onToggle(task, task.status !== "done")}
      />
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p
            className={cn(
              "min-w-0 break-words text-[15px] font-medium leading-5 tracking-[-0.01em]",
              task.status === "done" && "text-muted-foreground line-through",
            )}
          >
            {task.title}
          </p>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-4 text-muted-foreground">
          {task.date ? (
            <span
              className={
                isOverdue(task) ? "font-medium text-destructive" : undefined
              }
            >
              {formatDateLabel(task.date)}
              {task.time
                ? ` · ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(`1970-01-01T${task.time}:00`))}`
                : ""}
            </span>
          ) : null}
          {source ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--app-accent-surface)] px-1.5 py-0.5 text-[11px] font-medium text-[color:var(--app-accent-deep)]">
              {source === "calendar" ? (
                <Calendar className="size-3" aria-hidden="true" />
              ) : (
                <Mail className="size-3" aria-hidden="true" />
              )}
              {source === "calendar" ? "Calendar" : "Gmail"}
            </span>
          ) : null}
          {task.link ? (
            <a
              href={task.link}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-6 items-center gap-1 font-medium text-[color:var(--app-accent)] underline-offset-2 hover:underline"
              onClick={(event) => event.stopPropagation()}
            >
              Join
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          ) : null}
        </div>
        {task.notes ? (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-muted-foreground">
            {task.notes}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        {canEdit ? (
          <button
            type="button"
            className="grid size-9 place-items-center rounded-full text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)]"
            aria-label={`Edit ${task.title}`}
            onClick={() => onEdit?.(task)}
            disabled={saving}
          >
            <Pencil className="size-4" aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="grid size-9 place-items-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)]"
          aria-label={`Delete ${task.title}`}
          onClick={() => onDelete(task)}
          disabled={saving}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function TodoRows({
  tasks,
  savingTaskId,
  onToggle,
  onDelete,
  onEdit,
  contained = false,
}: {
  tasks: TodoItem[];
  savingTaskId: string | null;
  onToggle: (task: TodoItem, complete: boolean) => void;
  onDelete: (task: TodoItem) => void;
  onEdit?: (task: TodoItem) => void;
  contained?: boolean;
}) {
  return (
    <div
      className={cn(
        !contained &&
          "overflow-hidden rounded-2xl border border-border/55 bg-[color:var(--app-card-surface-default-solid)] shadow-[0_1px_2px_rgb(0_0_0_/_0.035)]",
      )}
    >
      {groupByDate(tasks).map((group, groupIndex) => (
        <div
          key={group.id}
          className={cn(groupIndex > 0 && "border-t border-border/50")}
        >
          <div
            className={cn(
              "px-4 pb-1 pt-3 text-[12px] font-semibold",
              group.overdue ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {group.overdue ? `${group.label} · Overdue` : group.label}
          </div>
          <div className="divide-y divide-border/45">
            {group.tasks.map((task) => (
              <TodoRow
                key={task.id}
                task={task}
                saving={savingTaskId === task.id}
                onToggle={onToggle}
                onDelete={onDelete}
                onEdit={onEdit}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TodoEditorSheet({
  open,
  task,
  saving,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  task: TodoItem | null;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (input: EditableTodoFields) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle(task?.title ?? "");
    setDate(task?.date ?? "");
    setTime(task?.time ?? "");
    setNotes(task?.notes ?? "");
  }, [open, task]);

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
        className="mx-auto max-w-xl gap-0 rounded-t-[24px] border-border/60 bg-[color:var(--app-card-surface-default-solid)] p-0 sm:bottom-6 sm:max-w-lg sm:rounded-[24px]"
        showCloseButton={!saving}
      >
        <form onSubmit={(event) => void submit(event)}>
          <SheetHeader className="px-5 pb-3 pt-2 text-left">
            <SheetTitle className="text-xl tracking-[-0.02em]">
              {task ? "Edit item" : "Add item"}
            </SheetTitle>
            <SheetDescription>
              {task
                ? "Keep the details simple and useful."
                : "This stays encrypted in your private agent."}
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-4 px-5 pb-2">
            <div className="space-y-1.5">
              <Label htmlFor="todo-title">Title</Label>
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
                <Label htmlFor="todo-date">
                  Date{" "}
                  <span className="font-normal text-muted-foreground">
                    optional
                  </span>
                </Label>
                <Input
                  id="todo-date"
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  disabled={saving}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="todo-time">
                  Time{" "}
                  <span className="font-normal text-muted-foreground">
                    optional
                  </span>
                </Label>
                <Input
                  id="todo-time"
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  disabled={saving}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="todo-notes">
                Notes{" "}
                <span className="font-normal text-muted-foreground">
                  optional
                </span>
              </Label>
              <Textarea
                id="todo-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                disabled={saving}
                placeholder="Add a detail"
                maxLength={1200}
                className="min-h-22 resize-none"
              />
            </div>
          </div>
          <SheetFooter className="flex-row items-center justify-end gap-2 px-5 pt-5">
            <Button
              type="button"
              variant="none"
              effect="glass"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
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
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-[color:var(--app-accent-surface)] px-4 text-[15px] font-medium text-[color:var(--app-accent-deep)] transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Plus className="size-4" aria-hidden="true" />
      Add item
    </button>
  );
}

export function TodoListPage() {
  const { user } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TodoItem | null>(null);
  const [tasks, setTasks] = useState<TodoItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [completedOpen, setCompletedOpen] = useState(false);

  const userId = user?.uid ?? null;
  const writeReady = Boolean(
    userId && isVaultUnlocked && vaultKey && vaultOwnerToken,
  );
  const idTokenProvider = useCallback(
    () => user?.getIdToken() ?? Promise.resolve(""),
    [user],
  );
  const calendar = useCalendarConnectionStatus({
    userId,
    idTokenProvider: user ? idTokenProvider : null,
  });
  const upcoming = useCalendarUpcomingEvents({
    userId,
    vaultOwnerToken,
    isConnected: calendar.connected,
    windowHours: 168,
  });

  const loadItems = useCallback(async () => {
    if (!userId || !isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
      setTasks([]);
      return;
    }
    setItemsLoading(true);
    try {
      const state = await TodoListPkmService.load({
        userId,
        vaultKey,
        vaultOwnerToken,
      });
      setTasks(state.tasks);
    } catch {
      morphyToast.error("Your list couldn’t load. Try refreshing the page.");
    } finally {
      setItemsLoading(false);
    }
  }, [isVaultUnlocked, userId, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  const pending = useMemo(
    () =>
      [
        ...mergeAutomaticTasks(upcoming.events, tasks),
        ...openTodoItems(tasks).filter((task) => task.type === "manual"),
      ].sort(taskSort),
    [upcoming.events, tasks],
  );
  const completed = useMemo(() => completedTodoItems(tasks), [tasks]);
  const requireSaved = <T extends { success: boolean; message?: string }>(
    result: T,
  ): T => {
    if (!result.success) throw new Error(result.message || "Saving failed");
    return result;
  };

  const saveTask = async (input: EditableTodoFields) => {
    if (!userId || !vaultKey || !vaultOwnerToken) return;
    const current = editingTask;
    const taskId = current?.id ?? "new-item";
    setSavingTaskId(taskId);

    if (current) {
      const updatedAt = new Date().toISOString();
      const optimistic = { ...current, ...input, updatedAt };
      const operation = TodoListPkmService.update({
        userId,
        vaultKey,
        vaultOwnerToken,
        taskId: current.id,
        update: input,
      }).then(requireSaved);
      void morphyToast.promise(operation, {
        loading: "Saving item…",
        success: "Item saved.",
        error: "Item couldn’t be saved. Try again.",
      });
      try {
        await operation;
        setTasks((currentTasks) =>
          currentTasks.map((task) =>
            task.id === current.id ? optimistic : task,
          ),
        );
        setEditorOpen(false);
        setEditingTask(null);
      } catch {
        // The shared promise toast owns the failure state.
      } finally {
        setSavingTaskId(null);
      }
      return;
    }

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
      setEditingTask(null);
    } catch {
      // The shared promise toast owns the failure state.
    } finally {
      setSavingTaskId(null);
    }
  };

  const toggleTask = async (task: TodoItem, complete: boolean) => {
    if (!userId || !vaultKey || !vaultOwnerToken) return;
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
    if (!userId || !vaultKey || !vaultOwnerToken) return;
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
    setEditingTask(null);
    setEditorOpen(true);
  };

  return (
    <AppPageShell
      as="main"
      width="reading"
      className="min-h-full bg-transparent pb-16"
      nativeTest={{
        routeId: "/one/todos",
        marker: "native-route-one-todos",
        authState: user ? "authenticated" : "anonymous",
        dataState: itemsLoading
          ? "loading"
          : writeReady
            ? pending.length > 0 || completed.length > 0
              ? "loaded"
              : "empty-valid"
            : "unavailable-valid",
      }}
    >
      <AppPageHeaderRegion>
        <div className="flex items-end justify-between gap-4 px-1 pb-4 pt-2 sm:px-0">
          <div>
            <p className="text-[13px] font-medium text-muted-foreground">
              {new Intl.DateTimeFormat(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
              }).format(new Date())}
            </p>
            <h1 className="mt-1 text-4xl font-bold tracking-[-0.04em] text-foreground sm:text-[42px]">
              To-do list
            </h1>
          </div>
          <AddItemButton
            disabled={!writeReady || itemsLoading}
            onClick={openCreate}
          />
        </div>
      </AppPageHeaderRegion>

      <AppPageContentRegion className="space-y-9 pb-28 pt-0">
        {!writeReady ? (
          <div className="flex items-start gap-3 rounded-2xl border border-border/50 bg-[color:var(--app-card-surface-default-solid)] px-4 py-4 text-sm shadow-[0_1px_2px_rgb(0_0_0_/_0.035)]">
            <Lock
              className="mt-0.5 size-5 text-muted-foreground"
              aria-hidden="true"
            />
            <div>
              <p className="font-medium">
                Unlock your vault to manage your list
              </p>
              <p className="mt-1 text-muted-foreground">
                Your items stay encrypted in your private agent.
              </p>
            </div>
          </div>
        ) : null}

        {itemsLoading ? (
          <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
            <RefreshCw className="size-4 animate-spin" /> Loading your list…
          </div>
        ) : null}

        <section aria-labelledby="items-heading">
          <div className="mb-3 px-1">
            <h2
              id="items-heading"
              className="text-xl font-semibold tracking-[-0.025em]"
            >
              Today
            </h2>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border/55 bg-[color:var(--app-card-surface-default-solid)] shadow-[0_1px_2px_rgb(0_0_0_/_0.035)]">
            {pending.length > 0 ? (
              <TodoRows
                tasks={pending}
                savingTaskId={savingTaskId}
                onToggle={toggleTask}
                onDelete={deleteTask}
                contained
                onEdit={(task) => {
                  setEditingTask(task);
                  setEditorOpen(true);
                }}
              />
            ) : (
              <div className="flex items-start gap-3 px-4 py-5 text-sm text-muted-foreground">
                <ClipboardCheck className="mt-0.5 size-5" aria-hidden="true" />{" "}
                {calendar.connected
                  ? "Your list is clear. Scheduled meetings will appear here."
                  : "Your list is clear. Add an item or connect Calendar."}
              </div>
            )}
          </div>
        </section>

        {completed.length > 0 ? (
          <section aria-labelledby="completed-heading">
            <button
              type="button"
              onClick={() => setCompletedOpen((open) => !open)}
              className="flex min-h-11 w-full items-center justify-between px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)]"
            >
              <span>
                <span
                  id="completed-heading"
                  className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                >
                  Completed
                </span>
                <span className="ml-2 text-sm text-muted-foreground">
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
            {completedOpen ? (
              <div className="mt-2">
                <TodoRows
                  tasks={completed}
                  savingTaskId={savingTaskId}
                  onToggle={toggleTask}
                  onDelete={deleteTask}
                  onEdit={(task) => {
                    if (task.type !== "manual") return;
                    setEditingTask(task);
                    setEditorOpen(true);
                  }}
                />
              </div>
            ) : null}
          </section>
        ) : null}
      </AppPageContentRegion>

      <TodoEditorSheet
        open={editorOpen}
        task={editingTask}
        saving={savingTaskId !== null}
        onOpenChange={setEditorOpen}
        onSave={saveTask}
      />
    </AppPageShell>
  );
}
