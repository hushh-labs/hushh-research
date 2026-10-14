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
  RefreshCw,
  Trash2,
} from "@/components/icons";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
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

function TodoRow({
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
              <CaptionText className="inline-flex items-center gap-1.5 !text-[color:var(--app-secondary-label)]">
                {source === "calendar" ? (
                  <Calendar className="size-3.5" aria-hidden="true" />
                ) : (
                  <Mail className="size-3.5" aria-hidden="true" />
                )}
                {source === "calendar" ? "Calendar" : "Gmail"}
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
                <a
                  href={task.link}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`${source === "gmail" ? "Open" : "Join"} ${task.title}`}
                >
                  {source === "gmail" ? "Open" : "Join"}
                  <ExternalLink className="ml-1 size-3.5" aria-hidden="true" />
                </a>
              </Button>
            ) : null}
          </div>
        ) : null}
        {task.notes ? (
          <HelperText as="p" className="col-span-2 mt-1 line-clamp-2">
            {task.notes}
          </HelperText>
        ) : null}
      </div>
    </SurfaceCard>
  );
}

function TodoRows({
  tasks,
  savingTaskId,
  onToggle,
  onDelete,
}: {
  tasks: TodoItem[];
  savingTaskId: string | null;
  onToggle: (task: TodoItem, complete: boolean) => void;
  onDelete: (task: TodoItem, trigger?: HTMLButtonElement) => void;
}) {
  return (
    <div className="space-y-6" data-no-auto-fade="true">
      {groupByDate(tasks).map((group) => (
        <section
          key={group.id}
          aria-label={group.overdue ? `${group.label}, overdue` : group.label}
        >
          <div className="mb-2 flex items-center justify-between gap-3 px-1">
            <SectionLabel as="h2" compact>
              <span className={group.overdue ? "text-destructive" : undefined}>
                {group.overdue ? `${group.label} · Overdue` : group.label}
              </span>
            </SectionLabel>
            <CaptionText className="tabular-nums !text-[color:var(--app-secondary-label)]">
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
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [deleteRequest, setDeleteRequest] = useState<TodoItem | null>(null);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const addItemRef = useRef<HTMLButtonElement | null>(null);

  const userId = user?.uid ?? null;
  const writeReady = Boolean(
    userId && isVaultUnlocked && vaultKey && vaultOwnerToken,
  );
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
      width="reading"
      headerContentSpacing="compact"
      fitContent
      className="bg-transparent"
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
        <PageHeader
          eyebrow={new Intl.DateTimeFormat(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          }).format(new Date())}
          title="Your tasks"
          actionsInlineMobile
          actions={
            <AddItemButton
              buttonRef={addItemRef}
              disabled={!writeReady || itemsLoading}
              onClick={openCreate}
            />
          }
        />
        {writeReady && !itemsLoading && totalToday > 0 ? (
          <div className="mt-5 flex items-center gap-4" aria-live="polite">
            <CaptionText className="shrink-0 tabular-nums !text-[color:var(--app-secondary-label)]">
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
              <HelperText as="p">
                Unlock your vault to see your list.
              </HelperText>
            </div>
          </SurfaceCard>
        ) : itemsLoading ? (
          <div role="status" className="flex items-center gap-2 px-1">
            <RefreshCw
              className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
              aria-hidden="true"
            />
            <HelperText>Loading your list…</HelperText>
          </div>
        ) : pending.length > 0 ? (
          <TodoRows
            tasks={pending}
            savingTaskId={savingTaskId}
            onToggle={toggleTask}
            onDelete={requestDelete}
          />
        ) : (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <ClipboardCheck
              className="mb-1 size-7 text-[color:var(--app-accent)]"
              aria-hidden="true"
            />
            <MediumRowLabel as="h2">All clear</MediumRowLabel>
            <HelperText as="p">
              {calendar.connected
                ? "Your next meeting will appear here."
                : "Add something for your day."}
            </HelperText>
          </div>
        )}

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
