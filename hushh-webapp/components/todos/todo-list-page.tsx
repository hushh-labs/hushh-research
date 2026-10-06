"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  ClipboardCheck,
  Clock,
  Lock,
  Plus,
  RefreshCw,
  Trash2,
} from "@/components/icons";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SectionLabel } from "@/components/app-ui/typography";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/hooks/use-auth";
import { useCalendarConnectionStatus } from "@/lib/calendar/use-calendar-connection-status";
import {
  useCalendarUpcomingEvents,
  type RedactedCalendarEvent,
} from "@/lib/calendar/use-calendar-upcoming-events";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  TODO_CATEGORIES,
  TodoListPkmService,
  openTodoItems,
  type TodoCadence,
  type TodoCategory,
  type TodoItem,
} from "@/lib/services/todo-list-pkm-service";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";

type AgendaItem = {
  id: string;
  event: RedactedCalendarEvent;
  start: Date;
  allDay: boolean;
};

type ListEntry =
  | { id: string; kind: "scheduled"; date: Date; agendaItem: AgendaItem }
  | { id: string; kind: "item"; date: Date | null; task: TodoItem };

type ListGroup = {
  id: string;
  label: string;
  date: Date | null;
  entries: ListEntry[];
};

const CATEGORY_COPY: Record<TodoCategory, { label: string }> = {
  fitness: { label: "Fitness" },
  relationships: { label: "Relationships" },
  finance: { label: "Finance" },
  career: { label: "Career" },
  interests: { label: "Interests" },
  productivity: { label: "Productivity" },
  other: { label: "Something else" },
};

function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function parseCalendarStart(event: RedactedCalendarEvent): { value: Date; allDay: boolean } | null {
  if (event.start?.dateTime) {
    const value = new Date(event.start.dateTime);
    return Number.isNaN(value.getTime()) ? null : { value, allDay: false };
  }
  if (event.start?.date) {
    const value = new Date(`${event.start.date}T00:00:00`);
    return Number.isNaN(value.getTime()) ? null : { value, allDay: true };
  }
  return null;
}

function calendarAgendaItems(events: RedactedCalendarEvent[]): AgendaItem[] {
  return events
    .filter((event) => event.status?.toLowerCase() !== "cancelled")
    .map((event, index) => {
      const start = parseCalendarStart(event);
      return start
        ? {
          id: `${event.title}-${start.value.toISOString()}-${index}`,
          event,
          start: start.value,
          allDay: start.allDay,
        }
        : null;
    })
    .filter((item): item is AgendaItem => item !== null)
    .sort((left, right) => left.start.getTime() - right.start.getTime());
}

function parseTaskDate(task: TodoItem): Date | null {
  if (!task.dueOn) return null;
  const value = new Date(`${task.dueOn}T00:00:00`);
  return Number.isNaN(value.getTime()) ? null : value;
}

function localDayKey(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatListDate(value: Date): string {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (isSameLocalDay(value, today)) return "Today";
  if (isSameLocalDay(value, tomorrow)) return "Tomorrow";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(value);
}

function formatScheduledTime(item: AgendaItem): string {
  if (item.allDay) return "All day";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(item.start);
}

function cadenceLabel(cadence: TodoCadence): string {
  if (cadence === "daily") return "Daily";
  if (cadence === "weekly") return "Weekly";
  return "One time";
}

function buildListGroups(agenda: AgendaItem[], tasks: TodoItem[]): ListGroup[] {
  const datedGroups = new Map<string, ListGroup>();
  const anytimeEntries: Array<Extract<ListEntry, { kind: "item" }>> = [];

  const addDatedEntry = (date: Date, entry: ListEntry) => {
    const id = localDayKey(date);
    const group = datedGroups.get(id) ?? {
      id,
      label: formatListDate(date),
      date,
      entries: [],
    };
    group.entries.push(entry);
    datedGroups.set(id, group);
  };

  for (const item of agenda) {
    addDatedEntry(item.start, {
      id: `scheduled-${item.id}`,
      kind: "scheduled",
      date: item.start,
      agendaItem: item,
    });
  }

  for (const task of openTodoItems(tasks)) {
    const date = parseTaskDate(task);
    const entry: ListEntry = { id: `item-${task.id}`, kind: "item", date, task };
    if (date) addDatedEntry(date, entry);
    else anytimeEntries.push(entry);
  }

  const dated = [...datedGroups.values()]
    .sort((left, right) => left.date!.getTime() - right.date!.getTime())
    .map((group) => ({
      ...group,
      entries: group.entries.sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "scheduled" ? -1 : 1;
        if (left.kind === "scheduled" && right.kind === "scheduled") {
          return left.date.getTime() - right.date.getTime();
        }
        return 0;
      }),
    }));

  if (anytimeEntries.length > 0) {
    dated.push({
      id: "anytime",
      label: "Any time",
      date: null,
      entries: anytimeEntries,
    });
  }

  return dated;
}

function TodoDialog({
  open,
  onOpenChange,
  onSave,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (input: {
    title: string;
    category: TodoCategory;
    cadence: TodoCadence;
    dueOn: string | null;
  }) => Promise<void>;
  saving: boolean;
}) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<TodoCategory>("productivity");
  const [cadence, setCadence] = useState<TodoCadence>("once");
  const [dueOn, setDueOn] = useState("");

  const close = (next: boolean) => {
    if (!saving) onOpenChange(next);
  };

  useEffect(() => {
    if (open) return;
    setTitle("");
    setCategory("productivity");
    setCadence("once");
    setDueOn("");
  }, [open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim()) return;
    await onSave({ title: title.trim(), category, cadence, dueOn: dueOn || null });
  };

  return (
    <Dialog modal open={open} onOpenChange={close}>
      <DialogContent className="w-[calc(100%-1rem)] gap-5 sm:max-w-md" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Add an item</DialogTitle>
          <DialogDescription>This stays encrypted in your private agent.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="space-y-2">
            <Label htmlFor="todo-title">What do you want to do?</Label>
            <Input
              id="todo-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="For example, call Mum"
              maxLength={240}
              autoFocus
              disabled={saving}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="todo-category">Area</Label>
              <Select
                value={category}
                onValueChange={(value) => setCategory(value as TodoCategory)}
                disabled={saving}
              >
                <SelectTrigger id="todo-category" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TODO_CATEGORIES.map((value) => (
                    <SelectItem key={value} value={value}>{CATEGORY_COPY[value].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="todo-cadence">Cadence</Label>
              <Select
                value={cadence}
                onValueChange={(value) => setCadence(value as TodoCadence)}
                disabled={saving}
              >
                <SelectTrigger id="todo-cadence" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="once">One time</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="todo-due-date">Date <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="todo-due-date" type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} disabled={saving} />
          </div>
          <DialogFooter>
            <Button type="button" variant="none" effect="glass" disabled={saving} onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !title.trim()} loading={saving}>
              Save item
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ScheduledRow({ item }: { item: AgendaItem }) {
  return (
    <div className="flex min-h-15 items-start gap-3 px-2 py-3">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)]">
        <Clock className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-5">{item.event.title || "Scheduled plan"}</p>
        <p className="mt-1 text-xs text-muted-foreground">{formatScheduledTime(item)}</p>
      </div>
    </div>
  );
}

function TodoItemRow({
  task,
  saving,
  onToggle,
  onRemove,
}: {
  task: TodoItem;
  saving: boolean;
  onToggle: (task: TodoItem, completed: boolean) => void;
  onRemove: (task: TodoItem) => void;
}) {
  const completed = Boolean(task.completedAt);
  return (
    <div className="group flex min-h-15 items-start gap-3 px-2 py-3">
      <Checkbox
        checked={completed}
        disabled={saving}
        aria-label={`Mark ${task.title} as ${completed ? "not completed" : "completed"}`}
        onCheckedChange={(value) => onToggle(task, value === true)}
        className="mt-1"
      />
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-medium leading-5", completed && "text-muted-foreground line-through")}>{task.title}</p>
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{CATEGORY_COPY[task.category].label}</span>
          <span aria-hidden="true">·</span>
          <span>{cadenceLabel(task.cadence)}</span>
        </div>
      </div>
      <button
        type="button"
        className="mt-0.5 grid size-8 place-items-center rounded-lg text-muted-foreground opacity-100 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)] sm:opacity-0 sm:group-hover:opacity-100"
        disabled={saving}
        onClick={() => onRemove(task)}
        aria-label={`Remove ${task.title}`}
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  );
}

function TodoList({
  groups,
  ready,
  loading,
  savingTaskId,
  onAdd,
  onToggle,
  onRemove,
}: {
  groups: ListGroup[];
  ready: boolean;
  loading: boolean;
  savingTaskId: string | null;
  onAdd: () => void;
  onToggle: (task: TodoItem, completed: boolean) => void;
  onRemove: (task: TodoItem) => void;
}) {
  return (
    <section aria-labelledby="todo-list-heading" className="space-y-3">
      <div className="flex items-end justify-between gap-3 px-1">
        <div>
          <SectionLabel as="p">Today</SectionLabel>
          <h2 id="todo-list-heading" className="mt-1 text-lg font-semibold tracking-tight">On your list</h2>
        </div>
        <Button size="sm" onClick={onAdd} disabled={!ready || loading}>
          <Plus className="size-4" aria-hidden="true" />
          Add item
        </Button>
      </div>

      {!ready ? (
        <SurfaceCard>
          <SurfaceCardContent className="flex items-start gap-3 py-5">
            <Lock className="mt-0.5 size-5 text-muted-foreground" />
            <div>
              <p className="font-medium">Unlock your vault to manage your list</p>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">Your items stay encrypted in your private agent.</p>
            </div>
          </SurfaceCardContent>
        </SurfaceCard>
      ) : loading ? (
        <SurfaceCard>
          <SurfaceCardContent className="flex items-center gap-3 py-5 text-sm text-muted-foreground">
            <RefreshCw className="size-4 animate-spin" />
            Loading your list…
          </SurfaceCardContent>
        </SurfaceCard>
      ) : groups.length === 0 ? (
        <SurfaceCard>
          <SurfaceCardContent className="flex items-start gap-3 py-5">
            <ClipboardCheck className="mt-0.5 size-5 text-muted-foreground" />
            <div>
              <p className="font-medium">Your day is clear</p>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">Add something meaningful, or ask One to help you plan it.</p>
            </div>
          </SurfaceCardContent>
        </SurfaceCard>
      ) : (
        <SurfaceCard>
          <SurfaceCardContent className="divide-y divide-border/60 py-1">
            {groups.map((group) => (
              <div key={group.id} className="py-4 first:pt-4 last:pb-4">
                <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{group.label}</p>
                <div className="divide-y divide-border/60">
                  {group.entries.map((entry) => entry.kind === "scheduled" ? (
                    <ScheduledRow key={entry.id} item={entry.agendaItem} />
                  ) : (
                    <TodoItemRow key={entry.id} task={entry.task} saving={savingTaskId === entry.task.id} onToggle={onToggle} onRemove={onRemove} />
                  ))}
                </div>
              </div>
            ))}
          </SurfaceCardContent>
        </SurfaceCard>
      )}
    </section>
  );
}

export function TodoListPage() {
  const { user, loading: authLoading } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [tasks, setTasks] = useState<TodoItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);

  const userId = user?.uid ?? null;
  const writeReady = Boolean(userId && isVaultUnlocked && vaultKey && vaultOwnerToken);
  const idTokenProvider = useCallback(() => user?.getIdToken() ?? Promise.resolve(""), [user]);
  const calendar = useCalendarConnectionStatus({ userId, idTokenProvider: user ? idTokenProvider : null });
  const upcoming = useCalendarUpcomingEvents({
    userId,
    vaultOwnerToken,
    isConnected: calendar.connected,
    windowHours: 168,
  });

  const loadItems = useCallback(async () => {
    if (!userId || !isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
      setTasks([]);
      setItemsLoaded(false);
      return;
    }
    setItemsLoading(true);
    try {
      const state = await TodoListPkmService.load({ userId, vaultKey, vaultOwnerToken });
      setTasks(state.tasks);
      setItemsLoaded(true);
    } catch {
      morphyToast.error("Your list couldn’t load. Try refreshing the page.");
    } finally {
      setItemsLoading(false);
    }
  }, [isVaultUnlocked, userId, vaultKey, vaultOwnerToken]);

  useEffect(() => { void loadItems(); }, [loadItems]);

  const agenda = useMemo(() => calendarAgendaItems(upcoming.events), [upcoming.events]);
  const groups = useMemo(() => buildListGroups(agenda, tasks), [agenda, tasks]);

  const addTask = async (input: {
    title: string;
    category: TodoCategory;
    cadence: TodoCadence;
    dueOn: string | null;
  }) => {
    if (!userId || !vaultKey || !vaultOwnerToken) return;
    const now = new Date().toISOString();
    const task: TodoItem = {
      id: `todo_${crypto.randomUUID()}`,
      title: input.title,
      category: input.category,
      cadence: input.cadence,
      dueOn: input.dueOn,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    setSavingTaskId(task.id);
    const operation = TodoListPkmService.add({ userId, vaultKey, vaultOwnerToken, task })
      .then((result) => {
        if (!result.success) throw new Error(result.message || "Saving failed");
        return result;
      });
    void morphyToast.promise(operation, {
      loading: "Saving item…",
      success: "Item saved.",
      error: "Item couldn’t be saved. Try again.",
    });
    try {
      await operation;
      setTasks((current) => [task, ...current]);
      setDialogOpen(false);
    } catch {
      // The promise toast owns the visible failure state.
    } finally {
      setSavingTaskId(null);
    }
  };

  const toggleTask = async (task: TodoItem, completed: boolean) => {
    if (!userId || !vaultKey || !vaultOwnerToken) return;
    const updatedAt = new Date().toISOString();
    const completedAt = completed ? updatedAt : null;
    setSavingTaskId(task.id);
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, completedAt, updatedAt } : item));
    const operation = TodoListPkmService.setCompletion({
      userId,
      vaultKey,
      vaultOwnerToken,
      taskId: task.id,
      completedAt,
      updatedAt,
    }).then((result) => {
      if (!result.success) throw new Error(result.message || "Saving failed");
      return result;
    });
    void morphyToast.promise(operation, {
      loading: completed ? "Completing item…" : "Restoring item…",
      success: completed ? "Item completed." : "Item restored.",
      error: "Item couldn’t be updated. Try again.",
    });
    try {
      await operation;
    } catch {
      setTasks((current) => current.map((item) => item.id === task.id ? task : item));
    } finally {
      setSavingTaskId(null);
    }
  };

  const removeTask = async (task: TodoItem) => {
    if (!userId || !vaultKey || !vaultOwnerToken) return;
    setSavingTaskId(task.id);
    const operation = TodoListPkmService.remove({ userId, vaultKey, vaultOwnerToken, taskId: task.id })
      .then((result) => {
        if (!result.success) throw new Error(result.message || "Saving failed");
        return result;
      });
    void morphyToast.promise(operation, {
      loading: "Removing item…",
      success: "Item removed.",
      error: "Item couldn’t be removed. Try again.",
      variant: "destructive",
    });
    try {
      await operation;
      setTasks((current) => current.filter((item) => item.id !== task.id));
    } catch {
      // The promise toast owns the visible failure state.
    } finally {
      setSavingTaskId(null);
    }
  };

  const dataState = authLoading
    ? "loading"
    : !user
      ? "empty-valid"
      : calendar.loading || upcoming.loading || (writeReady && !itemsLoaded)
        ? "loading"
        : "loaded";

  return (
    <AppPageShell
      as="main"
      width="reading"
      className="pb-12"
      nativeTest={{
        routeId: "/one/todos",
        marker: "native-route-one-todos",
        authState: user ? "authenticated" : authLoading ? "pending" : "anonymous",
        dataState,
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="One"
          title="To-do List"
          description="A calm view of what your private agent is keeping in view."
          icon={ClipboardCheck}
          accent="neutral"
          actions={(
            <Button size="sm" onClick={() => setDialogOpen(true)} disabled={!writeReady}>
              <Plus className="size-4" />
              Add item
            </Button>
          )}
          actionsInlineMobile
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="pb-24 pt-0">
        <TodoList
          groups={groups}
          ready={writeReady}
          loading={itemsLoading}
          savingTaskId={savingTaskId}
          onAdd={() => setDialogOpen(true)}
          onToggle={toggleTask}
          onRemove={removeTask}
        />
      </AppPageContentRegion>
      <TodoDialog open={dialogOpen} onOpenChange={setDialogOpen} onSave={addTask} saving={savingTaskId !== null} />
    </AppPageShell>
  );
}
