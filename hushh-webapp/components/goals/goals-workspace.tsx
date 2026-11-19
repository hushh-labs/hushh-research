"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceCard } from "@/components/app-ui/surfaces";
import { HelperText } from "@/components/app-ui/typography";
import { useAuth } from "@/hooks/use-auth";
import type { Goal, GoalStatus } from "@/lib/goals/goal-model";
import { Button } from "@/lib/morphy-ux/button";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { usePkmDomainChangeRevision } from "@/lib/pkm/use-pkm-domain-change-revision";
import { GoalsPkmService, type GoalPlanInput } from "@/lib/services/goals-pkm-service";
import { TODO_LIST_PKM_DOMAIN, type TodoWriteParams } from "@/lib/services/todo-list-pkm-service";
import { useVault } from "@/lib/vault/vault-context";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { GoalEditor } from "./goal-editor";

type Workspace = Awaited<ReturnType<typeof GoalsPkmService.loadWorkspace>>;
type Draft = { id: string; goal: Goal | null; initial: GoalPlanInput };
const EMPTY_PLAN: GoalPlanInput = { title: "", outcome: "", category: null, taskIds: [] };
const STATUS_LABEL = { active: "Active", completed: "Completed", archived: "Archived" } as const;

function GoalsShell({ title = "Goals", actions, dataState, children }: {
  title?: string;
  actions?: React.ReactNode;
  dataState: "loading" | "loaded" | "empty-valid" | "unavailable-valid";
  children: React.ReactNode;
}) {
  return (
    <AppPageShell width="reading" fitContent nativeTest={{
      routeId: ROUTES.ONE_GOALS, marker: "native-route-one-goals", authState: "authenticated", dataState,
    }}>
      <AppPageHeaderRegion>
        <PageHeader title={title} titleRole="agent" actionsInlineMobile actions={actions} />
      </AppPageHeaderRegion>
      <AppPageContentRegion className="space-y-4 pb-6">{children}</AppPageContentRegion>
    </AppPageShell>
  );
}

export function GoalsWorkspace() {
  const { userId } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const credentials = useMemo(() => userId && isVaultUnlocked && vaultKey && vaultOwnerToken
    ? { userId, vaultKey, vaultOwnerToken } : null, [userId, isVaultUnlocked, vaultKey, vaultOwnerToken]);

  if (!credentials) return (
    <GoalsShell dataState="unavailable-valid">
      <SurfaceCard className="p-4"><HelperText>Unlock your vault to view and edit your goals.</HelperText></SurfaceCard>
    </GoalsShell>
  );
  return <OwnerGoalsWorkspace key={credentials.userId} credentials={credentials} />;
}

function OwnerGoalsWorkspace({ credentials }: { credentials: TodoWriteParams }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(false);
  const inFlight = useRef(false);
  const readVersion = useRef(0);
  const domainRevision = usePkmDomainChangeRevision(credentials.userId, TODO_LIST_PKM_DOMAIN);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const reload = useCallback(async () => {
    const version = ++readVersion.current;
    const epoch = snapshotVaultSessionEpoch();
    const current = () => alive.current && version === readVersion.current && isVaultSessionEpochCurrent(epoch);
    setLoadError(false);
    try {
      const result = await GoalsPkmService.loadWorkspace(credentials);
      if (current()) setWorkspace(result);
    } catch {
      if (current()) setLoadError(true);
    }
  }, [credentials]);

  useEffect(() => {
    void reload();
    return () => { readVersion.current += 1; };
  }, [reload, domainRevision]);

  const goals = useMemo(() => (workspace?.goals ?? [])
    .filter(goal => goal.status !== "deleted")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [workspace]);
  const selected = goals.find(goal => goal.id === selectedId);
  const tasks = useMemo(() => (workspace?.tasks ?? []).filter(task => task.status !== "deleted"), [workspace]);
  const tasksById = new Map(tasks.map(task => [task.id, task]));

  function cancelDraft() {
    if (inFlight.current) return;
    setDraft(null);
    setError(null);
  }

  useBackLayer(ROUTES.ONE_GOALS, draft || selectedId ? 2 : 0, () => {
    if (inFlight.current) return true;
    if (draft) cancelDraft();
    else setSelectedId(null);
    return true;
  });

  function openEditor(goal: Goal | null) {
    setError(null);
    setDraft({ id: crypto.randomUUID(), goal, initial: goal ?? EMPTY_PLAN });
  }

  async function write(operation: () => Promise<boolean>, onSaved: () => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    const epoch = snapshotVaultSessionEpoch();
    const current = () => alive.current && isVaultSessionEpochCurrent(epoch);
    setSaving(true);
    setError(null);
    try {
      if (await operation()) {
        if (current()) {
          onSaved();
          await reload();
        }
      } else if (current()) {
        setError("Couldn’t save this goal. Refresh if it changed elsewhere, then try again.");
      }
    } catch {
      if (current()) setError("Couldn’t save this goal. Check the details and try again.");
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setSaving(false);
        if (!current()) setError("Your session changed during the save. Check your goal before trying again.");
      }
    }
  }

  function savePlan(plan: GoalPlanInput) {
    if (!draft) return;
    const confirmed = { ...credentials, confirmedByUser: true } as const;
    const normalized = { ...plan, category: plan.category?.trim() || null };
    let savedId = draft.goal?.id ?? null;
    void write(async () => {
      if (draft.goal) {
        const result = await GoalsPkmService.savePlan({ ...confirmed,
          goalId: draft.goal.id, expectedRevision: draft.goal.revision, plan: normalized });
        return result.success;
      }
      const { goalId, result } = await GoalsPkmService.create(normalized, { ...confirmed, draftId: draft.id });
      savedId = goalId;
      return result.success;
    }, () => { setDraft(null); setSelectedId(savedId); });
  }

  function setStatus(goal: Goal, status: GoalStatus) {
    void write(async () => {
      const result = await GoalsPkmService.setStatus({ ...credentials, confirmedByUser: true,
        goalId: goal.id, expectedRevision: goal.revision, status });
      return result.success;
    }, () => undefined);
  }

  const title = draft ? (draft.goal ? "Edit goal" : "New goal") : selected ? selected.title : "Goals";
  return (
    <GoalsShell title={title}
      dataState={loadError ? "unavailable-valid" : !workspace ? "loading" : goals.length ? "loaded" : "empty-valid"}
      actions={!draft && !selectedId ? (
        <Button disabled={!workspace || loadError} onClick={() => openEditor(null)}>New goal</Button>
      ) : null}>
      {loadError ? (
        <SurfaceCard className="flex flex-wrap items-center justify-between gap-3 p-4">
          <HelperText as="p" role="alert">Your goals couldn’t refresh.</HelperText>
          <Button variant="none" onClick={() => void reload()}>Retry</Button>
        </SurfaceCard>
      ) : null}
      {!workspace && !loadError ? <HelperText role="status">Loading your goals…</HelperText> : null}
      {draft ? (
        <SurfaceCard>
          <GoalEditor key={draft.id} initial={draft.initial} tasks={tasks} editing={Boolean(draft.goal)}
            saving={saving} error={error} onSave={savePlan} onCancel={cancelDraft} />
        </SurfaceCard>
      ) : selected ? (
        <SurfaceCard className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
            <span>{selected.status === "deleted" ? "Unavailable" : STATUS_LABEL[selected.status]}</span>
            {selected.category ? <span>· {selected.category}</span> : null}
          </div>
          <p className="whitespace-pre-wrap break-words">{selected.outcome}</p>
          <div className="space-y-2">
            <h2 className="text-sm font-medium">Linked tasks</h2>
            {selected.taskIds.length ? <ul className="space-y-2">{selected.taskIds.map(id => (
              <li key={id} className="flex flex-wrap justify-between gap-2 text-sm">
                <span className="break-all">{tasksById.get(id)?.title ?? "Unavailable task"}</span>
                {tasksById.get(id)?.status === "done" ? <span className="text-muted-foreground">Done</span> : null}
              </li>
            ))}</ul> : <HelperText>No tasks linked yet.</HelperText>}
            <Link href={ROUTES.ONE_TASKS} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
              Open Tasks
            </Link>
          </div>
          {error ? <HelperText as="p" role="alert">{error}</HelperText> : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="none" disabled={saving || loadError} onClick={() => openEditor(selected)}>Edit goal</Button>
            <Button variant="none" disabled={saving || loadError}
              onClick={() => setStatus(selected, selected.status === "active" ? "completed" : "active")}>
              {selected.status === "active" ? "Mark goal complete" : "Reopen goal"}
            </Button>
          </div>
        </SurfaceCard>
      ) : selectedId ? (
        <SurfaceCard className="space-y-2 p-4">
          <HelperText role="status">{loadError ? "Refresh to check your goal." : "This goal is unavailable."}</HelperText>
          <Button variant="none" onClick={() => setSelectedId(null)}>All goals</Button>
        </SurfaceCard>
      ) : goals.length ? (
        <ul className="space-y-2">{goals.map(goal => (
          <li key={goal.id}>
            <button type="button" onClick={() => { setError(null); setSelectedId(goal.id); }}
              className="w-full rounded-xl text-left outline-offset-2 focus-visible:outline-2">
              <SurfaceCard className="space-y-1 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0 break-all font-medium">{goal.title}</span>
                  <span className="text-sm text-muted-foreground">{goal.status === "deleted" ? "Unavailable" : STATUS_LABEL[goal.status]}</span>
                </div>
                <p className="line-clamp-2 text-sm text-muted-foreground">{goal.outcome}</p>
              </SurfaceCard>
            </button>
          </li>
        ))}</ul>
      ) : workspace && !loadError ? (
        <SurfaceCard className="space-y-1 p-4 sm:p-5">
          <h2 className="font-medium">No goals yet</h2>
          <HelperText>Describe an outcome you want to reach, then link the tasks that help you get there.</HelperText>
        </SurfaceCard>
      ) : null}
    </GoalsShell>
  );
}
