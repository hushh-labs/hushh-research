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
  Lock,
  Plus,
  RefreshCw,
} from "@/components/icons";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { ProfilePaneTaskAddIcon } from "@/components/profile/profile-pane-icons";
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
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  TodoListPkmService,
  completedTodoItems,
  createTodo,
  type TodoItem,
} from "@/lib/services/todo-list-pkm-service";
import { useTodoLiveTasks } from "@/lib/todos/use-todo-live-tasks";
import { TodoAgentSuggestions } from "./todo-agent-suggestions";
import { TodoSourceReviews } from "./todo-source-reviews";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from "@/lib/vault/session-epoch";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import { useTodoReceiptSnapshot } from "@/lib/todos/use-todo-receipt-snapshot";

import {
  TodoRows,
  extractSavedDueReceipts,
  localDateKey,
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
  const { isVaultUnlocked } = useVault();
  const epoch = snapshotVaultSessionEpoch();
  return <OwnerTodoListPage key={`${user?.uid ?? "anonymous"}:${epoch}:${isVaultUnlocked}`} epoch={epoch} />;
}

function OwnerTodoListPage({ epoch }: { epoch: number }) {
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const isCurrent = () => active.current && isVaultSessionEpochCurrent(epoch);
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
  const liveTasks = useTodoLiveTasks({
    userId, vaultOwnerToken, idTokenProvider: user ? idTokenProvider : null, enabled: writeReady, tasks,
  });
  const { pending, agentFeed, retryKyc, calendar, upcoming, agentLoadError, agentLoading, calendarReadLoading, calendarReadError } = liveTasks;
  const gmail = useGmailConnectorStatus({
    userId,
    idTokenProvider: user ? idTokenProvider : null,
  });
  const receiptAccountKey =
    gmail.status?.google_sub || gmail.status?.google_email || null;
  const receipts = useTodoReceiptSnapshot({ userId: userId ?? "", accountKey: receiptAccountKey, vaultKey, vaultOwnerToken, enabled: writeReady });
  const dueReceipts = useMemo(() => extractSavedDueReceipts(receipts.snapshot), [receipts.snapshot]);
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
      if (!isCurrent()) return;
      setTasks((currentTasks) => [task, ...currentTasks]);
      setEditorOpen(false);
    } catch {
      // The shared promise toast owns the failure state.
    } finally {
      if (isCurrent()) setSavingTaskId(null);
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
      if (!isCurrent()) return;
      setTasks((current) =>
        current.some((item) => item.id === task.id)
          ? current.map((item) => (item.id === task.id ? task : item))
          : current,
      );
    } finally {
      if (isCurrent()) setSavingTaskId(null);
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
      if (!isCurrent()) return;
      setTasks((current) =>
        current.some((item) => item.id === task.id)
          ? current.map((item) => (item.id === task.id ? task : item))
          : [task, ...current],
      );
    } finally {
      if (isCurrent()) setSavingTaskId(null);
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
      nativeTest={{
        routeId: "/one/todos",
        marker: "native-route-one-todos",
        authState: user ? "authenticated" : "anonymous",
        dataState: itemsLoading
          ? "loading"
          : writeReady
            ? pending.length > 0 || liveTasks.reviews.length > 0 ||
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
        {writeReady && receipts.error ? (
          <div className="flex items-center gap-2" role="status">
            <HelperText as="p">Saved Mail payments could not refresh.</HelperText>
            <Button variant="none" effect="fade" size="compact" onClick={() => void receipts.refresh()}>Retry</Button>
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
        {writeReady && userId && vaultKey && vaultOwnerToken ? <TodoAgentSuggestions
          userId={userId} vaultKey={vaultKey} vaultOwnerToken={vaultOwnerToken}
          evidence={liveTasks.evidence} coverage={liveTasks.coverage} loading={Boolean(itemsLoading || liveTasks.sourceLoading || receipts.loading)}
          onSaved={() => void loadItems()} onRefresh={() => { void loadItems(); void liveTasks.refreshSources(); void receipts.refresh(); void agentFeed.retry(); void retryKyc(); calendar.refresh(); upcoming.refresh(); }}
        /> : null}
        {writeReady && itemsLoaded && !itemsLoading ? <TodoSourceReviews reviews={liveTasks.reviews} /> : null}
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
          ((agentLoading || calendarReadLoading || liveTasks.sourceLoading || receipts.loading) && pending.length === 0 && dueReceipts.length === 0 && liveTasks.reviews.length === 0) ? (
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
        ) : liveTasks.reviews.length || itemsLoadError || agentLoadError || calendarReadError || liveTasks.sourceError || receipts.error ? null : (
          <div data-todo-empty-state="true" className="flex max-w-sm items-start gap-3 px-1 py-4 text-left">
            <ProfilePaneTaskAddIcon size={26} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <MediumRowLabel as="h2" data-profile-role="name">
                {liveTasks.coverage.some(source => source.status === "incomplete") ? "No tasks in the checked sources" : tasks.length === 0 && completed.length === 0 ? "No tasks yet" : "No pending tasks"}
              </MediumRowLabel>
              <HelperText as="p" data-profile-role="description" className="mt-1">
                {tasks.length === 0 && completed.length === 0
                  ? "Add an item to get started."
                  : "New tasks will appear here."}
              </HelperText>
            </div>
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
