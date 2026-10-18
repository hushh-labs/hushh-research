"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type Ref,
} from "react";
import Link from "next/link";

import {
  ChevronDown,
  ClipboardCheck,
  Lock,
  Plus,
  RefreshCw,
} from "@/components/icons";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceCard } from "@/components/app-ui/surfaces";
import {
  CaptionText,
  HelperText,
  MediumRowLabel,
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

import {
  TodoRows,
  extractDueReceipts,
  localDateKey,
  taskSort,
} from "./todo-list-presentation";
// Compatibility exports preserve existing callers while previews use the leaf.
export {
  TodoRow,
  TodoRows,
  DueReceiptRow,
  DueReceiptsSection,
  extractDueReceipts,
  groupByDate,
  taskSort,
} from "./todo-list-presentation";
export type { DueReceiptItem } from "./todo-list-presentation";

type EditableTodoFields = {
  title: string;
  date: string | null;
  time: string | null;
  notes: string | null;
};

function calendarStart(event: RedactedCalendarEvent): Date | null {
  const value =
    event.start?.dateTime ??
    (event.start?.date ? `${event.start.date}T00:00:00` : null);
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
  const agentFeed = useFeedActionables({ enabled: writeReady });
  const { pendingKyc, kycLoading, kycError, retryKyc } = useFeedBriefing({
    enabled: writeReady,
    includeCalendar: false,
    includeNudges: false,
  });
  const agentLoadError = agentFeed.error || agentFeed.progressError || kycError;
  const agentLoading =
    agentFeed.loading || agentFeed.progressLoading || kycLoading;
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

  const pending = useMemo(() => {
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
        source: "kyc",
        title:
          pendingKyc.count > 1
            ? `Review ${pendingKyc.count} information requests`
            : "Review information request",
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
  }, [agentFeed.actionables, pendingKyc, upcoming.events, tasks]);
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
      fitContent
      className="bg-transparent"
      nativeTest={{
        routeId: "/one/todos",
        marker: "native-route-one-todos",
        authState: user ? "authenticated" : "anonymous",
        dataState: itemsLoading
          ? "loading"
          : writeReady
            ? pending.length > 0 ||
              completed.length > 0 ||
              dueReceipts.length > 0
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
          titleRole="agent"
          className="[--foundation-title1-size:var(--type-agent-title-size)] [--foundation-title1-line:var(--type-agent-title-line)] [--foundation-title1-weight:var(--type-agent-title-weight)] [--foundation-title1-tracking:var(--type-agent-title-tracking)]"
          actionsInlineMobile
          actions={
            <div className="flex items-center gap-2">
              {writeReady && agentLoadError ? (
                <Button
                  variant="none"
                  effect="fade"
                  size="compact"
                  aria-label="Retry agent tasks"
                  disabled={agentLoading}
                  onClick={() =>
                    void Promise.all([agentFeed.retry(), retryKyc()]).catch(
                      () => {
                        morphyToast.error(
                          "Agent tasks couldn’t refresh. Try again.",
                        );
                      },
                    )
                  }
                >
                  Retry
                </Button>
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
          <HelperText as="p" role="status">
            Some agent tasks couldn’t refresh. Your other items are still here.
          </HelperText>
        ) : null}
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
        ) : itemsLoading || (agentLoading && pending.length === 0) ? (
          <div role="status" className="flex items-center gap-2 px-1">
            <RefreshCw
              className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
              aria-hidden="true"
            />
            <HelperText>Loading your list…</HelperText>
          </div>
        ) : pending.length > 0 || dueReceipts.length > 0 ? (
          <TodoRows
            tasks={pending}
            dueReceipts={dueReceipts}
            savingTaskId={savingTaskId}
            onToggle={toggleTask}
            onDelete={requestDelete}
          />
        ) : agentLoadError ? null : (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <ClipboardCheck
              className="mb-1 size-7 text-[color:var(--app-accent)]"
              aria-hidden="true"
            />
            <MediumRowLabel as="h2">All clear</MediumRowLabel>
            <HelperText as="p">
              Tasks that need you will appear here, or you can add an item.
            </HelperText>
          </div>
        )}
        {writeReady &&
        agentFeed.actionables.some((item) => item.id === "consent:overflow") ? (
          <Button asChild variant="none" effect="fade" size="compact">
            <Link
              href={
                agentFeed.actionables.find(
                  (item) => item.id === "consent:overflow",
                )!.href || "/one/feed"
              }
            >
              View all pending requests
            </Link>
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
