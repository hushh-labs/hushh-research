"use client";

import { createNativeWorkspaceHandles, useNativeWorkspaceHandoff } from "@/lib/capacitor/use-native-workspace-handoff";

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { usePathname, useRouter } from "next/navigation";
import { OneAgentRosterBody, useOneAgentRosterModel, type OneAgentMode, type OneAgentRosterProps } from "./one-agent-roster";
import { PublicProfileDiscoveryEntryBody, usePublicProfileDiscoveryEntry } from "@/components/profile/public-profile-discovery-card";
import { ScheduledTasksPanelBody, scheduledTaskLabels, useScheduledTasksModel } from "@/components/scheduled-tasks/scheduled-tasks-panel";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { WalletEntryWarmup } from "@/components/wallet/wallet-entry-warmup";
import { snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { AGENT_ICON_MAP } from "@/components/icons/agents/agent-icons";
import { nativeColorTokenHex } from "@/lib/capacitor/native-control-appearance";
import { resolvedAccentHex, useAccent } from "@/lib/theme/accent";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { useNativeWorkspace, useNativeWorkspacePresentation } from "@/lib/capacitor/use-native-workspace";

import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import type { NativeDrawerRow, NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import { normalizeStaticExportPathname, ROUTES } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";

export function NativeOneDashboard(props: OneAgentRosterProps) {
  // Scheduled work retains its existing owner-generation reset boundary.
  const generation = snapshotValidatedAuthSessionOwner()?.generation;
  return <LauncherOwner key={`${props.userId}:${generation}`} {...props} />;
}
function LauncherOwner(props: OneAgentRosterProps) {
  const roster = useOneAgentRosterModel(props);
  const discovery = usePublicProfileDiscoveryEntry(props.userId);
  const tasks = useScheduledTasksModel(props.userId ?? "");
  const frame = useRef<HTMLDivElement>(null);
  const fallback = <>
    <PublicProfileDiscoveryEntryBody model={discovery} />
    <OneAgentRosterBody model={roster} scheduledContent={props.userId ? <ScheduledTasksPanelBody model={tasks} /> : null} />
  </>;
  return <AppPageShell as="main" width="reading" fitContent ref={frame}
    className="relative isolate bg-[color:var(--one-launcher-background)]" data-one-launcher-root="true"
    nativeTest={{ routeId: ROUTES.ONE_HOME, marker: "native-route-one-home", authState: "authenticated", dataState: "loaded" }}>
    <WalletEntryWarmup />
    {customNativePresentationEnabled()
      ? <LauncherPresentation roster={roster} discovery={discovery} tasks={tasks} frame={frame} fallback={fallback} />
      : fallback}
  </AppPageShell>;
}
type LauncherModel = {
  roster: ReturnType<typeof useOneAgentRosterModel>;
  discovery: ReturnType<typeof usePublicProfileDiscoveryEntry>;
  tasks: ReturnType<typeof useScheduledTasksModel>;
  frame: RefObject<HTMLDivElement | null>;
};
function LauncherPresentation({ fallback, ...model }: LauncherModel & { fallback: ReactNode }) {
  const presentation = useNativeWorkspacePresentation();
  const { isVaultUnlocked } = useVault();
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const handoff = useNativeWorkspaceHandoff(presentation.retireForWeb, model.roster.userId);
  const opening = useRef(false);
  const live = useRef({ model, pathname });
  useLayoutEffect(() => { live.current = { model, pathname }; });
  const current = () => live.current.pathname === ROUTES.ONE_HOME && live.current.model.roster.userId === model.roster.userId;
  const openDiscovery = async () => {
    if (opening.current || !current()) return;
    opening.current = true;
    try {
      await handoff.handoff(current, () => live.current.model.discovery.visible && !live.current.model.discovery.ready,
        () => live.current.model.discovery.setOpen(true));
    } finally { opening.current = false; }
  };
  const failed = presentation.status.phase === "web" && ["unsupported", "failure"].includes(presentation.status.reason);
  if (!model.roster.userId || !isVaultUnlocked || model.discovery.open || failed)
    return presentation.status.held ? <div aria-busy="true" /> : fallback;
  return <LauncherBody {...model} presentation={presentation} openDiscovery={openDiscovery} activationRevision={handoff.activationRevision} />;
}
export function nativeLauncherAgent(mode: OneAgentMode, id: string, accentHex: string) {
  return { id, label: mode.title, description: mode.description, metricValue: mode.primaryMetric.value,
    metricLabel: mode.primaryMetric.label, artworkId: `roster-${Object.hasOwn(AGENT_ICON_MAP, mode.id) ? mode.id : "default"}`,
    // Fixed glyph colors are generated from the authored SVG, not app tones.
    iconHex: mode.id === "location" ? nativeColorTokenHex("--agent-location-blue") ?? resolvedAccentHex() : accentHex };
}
function LauncherBody({ roster, discovery, tasks, frame, presentation, openDiscovery, activationRevision }: LauncherModel & {
  presentation: ReturnType<typeof useNativeWorkspacePresentation>; openDiscovery: () => Promise<void>; activationRevision: number;
}) {
  const router = useRouter();
  useAccent(); // Reproject token-backed icons when the shared accent changes.
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const mounted = useRef(false), live = useRef({ roster, discovery, tasks, pathname });
  const [page, setPage] = useState(0);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { live.current = { roster, discovery, tasks, pathname }; });
  useLayoutEffect(() => { setPage(0); }, [tasks.open]);
  const owner = roster.userId!;
  const current = () => mounted.current && live.current.pathname === ROUTES.ONE_HOME && live.current.roster.userId === owner;
  const handles = useMemo(() => createNativeWorkspaceHandles(String(owner)), [owner]);
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>();
  const row = (key: string, label: string, run?: () => unknown, extra: Partial<NativeDrawerRow> = {}): NativeDrawerRow => {
    const id = handles(key);
    if (run) actions.set(id, () => run() as void | Promise<unknown>);
    return { id, label, enabled: !tasks.busy, ...(!run ? { readOnly: true } : {}), ...extra };
  };
  const sections: NativeDrawerSection[] = [];
  const section = (key: string, rows: NativeDrawerRow[], title?: string) => {
    if (rows.length) sections.push({ id: `launcher-${key}`, rows, ...(title ? { title } : {}) });
  };
  if (tasks.open) {
    section("task-intro", [row("task-intro", "Your private agent wakes for approved work.")]);
    if (tasks.message) section("task-error", [row("task-error", tasks.message)]);
    if (tasks.placementMessage) section("task-placement", [row("task-placement", tasks.placementMessage)]);
    if (tasks.checking && !tasks.status) section("task-loading", [row("task-loading", "Checking your agent…", undefined, { pending: true })]);
    if (tasks.status && !tasks.status.available) section("task-unavailable", [row("task-unavailable", "Scheduling isn’t available on this pod yet.")]);
    if (tasks.status?.tasks.length === 0) section("task-empty", [row("task-empty", "No scheduled tasks. Choose a file in Files to schedule organization.")]);
    const all = tasks.status?.tasks ?? [];
    const index = Math.min(page, Math.max(0, Math.ceil(all.length / 24) - 1));
    for (const task of all.slice(index * 24, (index + 1) * 24)) {
      const values = [row(`task:${task.id}`, task.title, undefined, {
        detail: `${scheduledTaskLabels[task.state]} · ${new Date(task.next_run_at * 1000).toLocaleString()}`, pending: tasks.busy === task.id,
      })];
      if (task.last_run?.state === "outcome_uncertain") values.push(row(`uncertain:${task.id}`, "Check the result before scheduling again."));
      const action = (operation: "pause" | "resume" | "cancel", label: string) => row(`${operation}:${task.id}`, label,
        () => tasks.control(task, operation), { enabled: !tasks.checking && !tasks.busy && (operation !== "resume" || Boolean(tasks.status?.available)) });
      if (["scheduled", "pending_delivery"].includes(task.state)) values.push(action("pause", "Pause"));
      if (task.state === "paused") values.push(action("resume", "Resume"));
      if (!["cancelled", "completed", "cancelling"].includes(task.state)) values.push(action("cancel", "Cancel"));
      section(`task-${task.id}`, values);
    }
    section("task-pages", [
      ...(index > 0 ? [row("previous", "Previous tasks", () => setPage(index - 1))] : []),
      ...((index + 1) * 24 < all.length ? [row("next", "More tasks", () => setPage(index + 1))] : []),
    ]);
    section("task-return", [
      row("task-destination", tasks.placementMessage ? "Hosting" : "Open Files", () => {
        if (tasks.busy) return;
        tasks.close();
        router.push(tasks.placementMessage ? ROUTES.PROFILE_HOSTING : ROUTES.ONE_FILES);
      }, { chevron: true }),
      row("task-close", "Close", () => tasks.close()),
    ]);
  } else {
    section("utilities", [
      row("scheduled", "Scheduled tasks", () => tasks.changeOpen(true), { symbol: "calendar.badge.clock", chevron: true }),
      ...(discovery.visible ? [row("discovery", discovery.ready ? "Review your profile" : "Claim your profile",
        () => discovery.ready ? router.push(ROUTES.ONE_PROFILE_DISCOVERY) : openDiscovery(), { chevron: true })] : []),
    ]);
  }
  const agents = roster.visibleModes.map(mode => {
    const id = handles(`agent:${mode.id}`);
    actions.set(id, () => { if (!tasks.open) router.push(mode.href); });
    return nativeLauncherAgent(mode, id, resolvedAccentHex());
  });
  const options = (["grid", "list"] as const).map(view => {
    const id = handles(`view:${view}`);
    actions.set(id, () => { if (!tasks.open) roster.selectView(view); });
    return { id, label: view === "grid" ? "Grid" : "List", selected: roster.view === view };
  });
  const phase = useNativeWorkspace({ owner, content: {
    workspace: "launcher", page: "overview", title: tasks.open ? "Scheduled tasks" : `Agents (${roster.modes.length})`,
    enabled: true, backEnabled: tasks.open, sections,
    ...(!tasks.open ? { tabs: { label: "Agent roster view", options }, launcher: { view: roster.view, agents } } : {}),
  }, actions, current, back: () => tasks.close(), contentFrame: frame, presentationOwner: presentation.owner,
    active: pathname === ROUTES.ONE_HOME, activationRevision });
  return <div aria-busy={phase !== "native"} data-native-launcher-workspace={phase} />;
}
