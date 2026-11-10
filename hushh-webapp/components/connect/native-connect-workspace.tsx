"use client";

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { usePathname } from "next/navigation";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { useNativeWorkspace, useNativeWorkspacePresentation, type WorkspaceEditor } from "@/lib/capacitor/use-native-workspace";
import { useNativeWorkspaceHandoff } from "@/lib/capacitor/use-native-workspace-handoff";
import type { NativeDrawerRow, NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import type { NativeWorkspaceChoice, NativeWorkspaceCircleDraft, NativeWorkspaceProjection } from "@/lib/capacitor/native-workspace";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { normalizeStaticExportPathname } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";
import { nativeFeedbackToast as toast } from "@/lib/capacitor/native-feedback";
import { ownerFacingConsentError } from "@/lib/consent/consent-owner-copy";
import styles from "./connect-workspace.module.css";
import { connectViewTabs, TOP_SHELL_TAB_REGISTRY } from "@/lib/navigation/top-shell-tabs";
import { nativePersonInitials, useNativeWorkspacePortraits } from "@/components/app-ui/use-native-workspace-portraits";

export type NativeConnectAction = {
  key: string; label: string; run: () => unknown; enabled?: boolean;
  destructive?: boolean; web?: boolean; pending?: boolean;
  portrait?: { label: string; photoUrl: string | null };
  overflow?: boolean;
};
export type NativeConnectPerson = {
  key: string; label: string; detail?: string; group?: string;
  photoUrl?: string | null; verified?: boolean; primary?: NativeConnectAction;
  enabled?: boolean; selected?: boolean; toggle?: () => void; actions: NativeConnectAction[];
};
export type NativeConnectModel = {
  confirmation?: { title: string; description: string; confirm: NativeConnectAction; cancel: () => void };
  editor?: WorkspaceEditor<NativeWorkspaceCircleDraft>; page?: NativeWorkspaceProjection["page"]; task?: boolean;
  variant?: "circles"; frameRef?: RefObject<HTMLDivElement | null>;
  owner: string | null; current: () => boolean;
  surface: "all" | "circles"; selectSurface: (surface: "all" | "circles") => void;
  view: string; setView: (view: "connections" | "discover") => void;
  directory: string; directories: readonly { value: string; label: string; run: () => void; web?: boolean }[];
  query: string; setQuery: (query: string) => void; searchLabel: string;
  summary?: string; connectionsLabel?: string; heading: string; people: NativeConnectPerson[]; loading: boolean; error: string | null;
  empty: string; actions: NativeConnectAction[]; footer: NativeConnectAction[];
  selectionMode: boolean; selectionCount: number; selectionLimit: number; cancelSelection: () => void;
  webOnly: boolean; webChildOpen: boolean;
};

/** The route still owns every query, relationship and operation. This maps
 * values and callbacks, using the same admission and rich-child handoff as Feed. */
export function NativeConnectWorkspace(props: { model: NativeConnectModel; fallback: ReactNode }) {
  if (!customNativePresentationEnabled()) return props.fallback;
  return <NativeConnectPresentation {...props} />;
}

function NativeConnectPresentation({ model, fallback }: { model: NativeConnectModel; fallback: ReactNode }) {
  const presentation = useNativeWorkspacePresentation();
  const { isVaultUnlocked } = useVault();
  const handoff = useNativeWorkspaceHandoff(presentation.retireForWeb, model.owner);
  const [child, setChild] = useState<{ done: boolean } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  useLayoutEffect(() => { if (child?.done && !model.webChildOpen) setChild(null); }, [child, model.webChildOpen]);
  useLayoutEffect(() => { setChild(null); setSelected(null); setPage(0); }, [model.owner]);
  useLayoutEffect(() => { setSelected(null); setPage(0); }, [model.surface, model.view, model.directory, model.query]);
  const runWeb = async (action: () => unknown) => {
    const current = () => model.current() && normalizeStaticExportPathname(window.location.pathname) === "/one/connect";
    await handoff.handoff(current, () => true, () => {
      const intent = handoff.intent.current;
      setChild({ done: false });
      void Promise.resolve().then(action).catch(error => {
        if (intent === handoff.intent.current && current()) toast.error(ownerFacingConsentError(error, "That didn't go through. Try again."));
      }).finally(() => { if (intent === handoff.intent.current && current()) setChild({ done: true }); });
    });
  };
  const failed = presentation.status.phase === "web" && (presentation.status.reason === "unsupported" || presentation.status.reason === "failure");
  if (!model.owner || !isVaultUnlocked || model.webOnly || model.webChildOpen || child || failed || model.people.some(person => person.actions.length > 6 || person.actions.filter(action => action.portrait).length > 1))
    return presentation.status.held ? <div aria-busy="true" /> : fallback;
  return <NativeConnectBody model={model} presentation={presentation} runWeb={runWeb} activationRevision={handoff.activationRevision}
    selected={selected} setSelected={setSelected} page={page} setPage={setPage} />;
}

function NativeConnectBody({ model, presentation, runWeb, activationRevision, selected, setSelected, page, setPage }: {
  model: NativeConnectModel; presentation: ReturnType<typeof useNativeWorkspacePresentation>;
  runWeb: (action: () => unknown) => Promise<void>; activationRevision: number;
  selected: string | null; setSelected: (key: string | null) => void; page: number; setPage: (page: number) => void;
}) {
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const localFrame = useRef<HTMLDivElement>(null), mounted = useRef(false), running = useRef(false);
  const contentFrame = model.frameRef ?? localFrame;
  const [busy, setBusy] = useState(false);
  const latest = useRef({ model, pathname });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { latest.current = { model, pathname }; });
  const current = () => mounted.current && latest.current.pathname === "/one/connect" && latest.current.model.current();
  const handles = useMemo(() => {
    const map = new Map<string, string>();
    return (key: string) => { let id = map.get(key); if (!id) { id = crypto.randomUUID(); map.set(key, id); } return id; };
  }, [model.owner]);
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>();
  const run = async (action: NativeConnectAction) => {
    if (!current() || running.current || action.enabled === false) return;
    running.current = true; setBusy(true);
    try { if (action.web) await runWeb(action.run); else await action.run(); }
    catch (error) { if (current()) toast.error(ownerFacingConsentError(error, "That didn't go through. Try again.")); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  const bind = (action: NativeConnectAction): NativeDrawerRow => {
    const id = handles(action.key); actions.set(id, () => run(action));
    return { id, label: action.label, enabled: !busy && action.enabled !== false, destructive: action.destructive, pending: action.pending };
  };
  const read = (key: string, label: string, detail?: string): NativeDrawerRow => ({ id: handles(key), label, detail, enabled: true, readOnly: true });
  const sections: NativeDrawerSection[] = [];
  const section = (id: string, rows: NativeDrawerRow[], title?: string) => { if (rows.length) sections.push({ id: `connect-${id}`, rows, ...(title ? { title } : {}) }); };
  const person = model.people.find(value => value.key === selected);
  const index = Math.min(page, Math.max(0, Math.ceil(model.people.length / 24) - 1));
  const visible = person ? [person] : model.people.slice(index * 24, (index + 1) * 24);
  const portraits = useNativeWorkspacePortraits(model.owner, pathname === "/one/connect", visible.flatMap(item => [
    { key: item.key, source: item.photoUrl },
    ...item.actions.filter(action => action.portrait).map(action => ({ key: `action:${item.key}:${action.key}`, source: action.portrait!.photoUrl })),
  ]));
  const avatar = (item: NativeConnectPerson) => item.photoUrl !== undefined || item.verified !== undefined
    ? { initials: nativePersonInitials(item.label), verified: item.verified === true, ...(portraits.get(item.key) ? { jpeg: portraits.get(item.key) } : {}) } : undefined;
  useLayoutEffect(() => { if (selected && !person) setSelected(null); }, [selected, person, setSelected]);
  const back = () => {
    if (running.current) return true;
    if (model.confirmation) { model.confirmation.cancel(); return true; }
    if (selected) { setSelected(null); return true; }
    if (model.selectionMode) { model.cancelSelection(); return true; }
    return false;
  };
  useBackLayer("/one/connect", model.confirmation ? 3 : selected ? 2 : model.selectionMode ? 1 : 0, back);
  const tab = (key: string, label: string, selected: boolean, callback: () => unknown) => {
    const id = handles(key); actions.set(id, () => { if (current() && !running.current) return callback() as void | Promise<unknown>; });
    return { id, label, selected };
  };
  if (model.confirmation) {
    section("confirmation", [read("confirmation", model.confirmation.title, model.confirmation.description), bind(model.confirmation.confirm),
      bind({ key: `cancel:${model.confirmation.confirm.key}`, label: "Cancel", enabled: model.confirmation.confirm.enabled, run: model.confirmation.cancel })]);
  } else if (model.editor) {
    // The shared native editor owns the form and its immediate interactions.
  } else if (person) {
    section("person", [{ ...read("person", person.label, person.detail), ...(avatar(person) ? { avatar: avatar(person) } : {}) }]);
    section("person-actions", person.actions.map(bind));
  } else {
    if (!model.variant) {
      const filters: NativeDrawerRow[] = [];
      if (model.view === "discover" && model.directories.length >= 2) {
        const directories = model.directories.map(option => ({ ...bind({ key: `directory:${option.value}`, label: option.label, run: option.run, web: option.web }), selected: model.directory === option.value }));
        filters.push({ id: handles("directory-picker"), label: "Directory", trailing: directories.find(option => option.selected)?.label,
          enabled: !busy, options: directories.map(({ id, label, selected }) => ({ id, label, selected })) });
      }
      if (filters.length) section("views", filters);
    }
    if (model.summary) section("summary", [read("summary", model.summary)]);
    section("actions", model.actions.map(bind));
    if (model.selectionMode) section("selection", [read("selection", `${model.selectionCount} selected`, `Pick up to ${model.selectionLimit}, across pages.`), bind({ key: "cancel-selection", label: "Cancel selection", run: model.cancelSelection })]);
    if (model.error) section("error", [read("error", model.error)]);
    if (model.loading && !model.people.length) section("loading", [read("loading", "Loading…")]);
    else if (!model.people.length) section("empty", [read("empty", model.empty)]);
    const groups = new Map<string, NativeDrawerRow[]>();
    for (const item of visible) {
      const id = handles(`person:${item.key}`);
      const primary = !model.selectionMode && item.primary;
      if (item.toggle) actions.set(id, () => { if (current() && !running.current && item.enabled !== false) item.toggle!(); });
      else if (primary) actions.set(id, () => item.enabled !== false ? run(primary) : undefined);
      else if (!model.selectionMode && item.actions.length && !item.photoUrl && item.verified === undefined) actions.set(id, () => { if (current() && !running.current) setSelected(item.key); });
      const key = item.group ?? model.heading, rows = groups.get(key) ?? [];
      const secondary = model.selectionMode || item.toggle ? [] : item.actions.map(action => {
        const row = bind(action);
        return { id: row.id, label: row.label, enabled: row.enabled, pending: row.pending,
          tone: action.destructive ? "danger" as const : "ghost" as const,
          ...(action.overflow ? { placement: "menu" as const } : {}),
          ...(action.portrait ? { avatar: { initials: nativePersonInitials(action.portrait.label),
            ...(portraits.get(`action:${item.key}:${action.key}`) ? { jpeg: portraits.get(`action:${item.key}:${action.key}`) } : {}) } } : {}) };
      });
      rows.push({ id, label: item.label, detail: item.detail, enabled: !busy && item.enabled !== false,
        ...(!actions.has(id) ? { readOnly: true } : { chevron: !item.toggle }),
        ...(item.toggle ? { selected: item.selected } : {}), ...(avatar(item) ? { avatar: avatar(item) } : {}),
        ...(secondary.length ? { inlineActions: secondary } : {}) });
      groups.set(key, rows);
    }
    for (const [title, rows] of groups) section(`people-${sections.length}`, rows, title);
    section("pages", [
      ...(index > 0 ? [bind({ key: "previous", label: "Previous people", run: () => setPage(index - 1) })] : []),
      ...((index + 1) * 24 < model.people.length ? [bind({ key: "next", label: "More people", run: () => setPage(index + 1) })] : []),
      ...model.footer.map(bind),
    ]);
  }
  const searchId = handles("search");
  actions.set(searchId, choice => { if (current() && !running.current && typeof choice.text === "string") model.setQuery(choice.text); });
  const showTabs = !person && !model.task && !model.confirmation;
  const primaryTabs = TOP_SHELL_TAB_REGISTRY.connect.tabs.map(option => tab(`surface-${option.value}`, option.label,
    model.surface === option.value, () => model.selectSurface(option.value as "all" | "circles")));
  const secondaryTabs = connectViewTabs(model.view, model.connectionsLabel).tabs.map(option => tab(`view-${option.value}`, option.label,
    model.view === option.value, () => model.setView(option.value as "connections" | "discover")));
  const phase = useNativeWorkspace({ owner: model.owner!, content: { workspace: "connect", page: model.page ?? "overview", title: "Connect", enabled: true, backEnabled: false, sections,
    ...(showTabs ? { tabs: { label: TOP_SHELL_TAB_REGISTRY.connect.label, options: primaryTabs },
      ...(!model.variant ? { secondaryTabs: { label: "Connection views", options: secondaryTabs } } : {}) } : {}),
    ...(!person && !model.editor && !model.confirmation ? { search: { id: searchId, query: model.query, label: model.searchLabel, live: true } } : {}),
  }, actions, current, back, editor: model.editor, contentFrame, active: pathname === "/one/connect", presentationOwner: presentation.owner, activationRevision });
  if (model.frameRef) return <div aria-busy={phase !== "native"} data-native-connect-workspace={phase} />;
  return <AppPageShell as="main" ref={contentFrame} className={styles.workspace} width="reading" aria-busy={phase !== "native"} data-native-connect-workspace={phase}
    nativeTest={{ routeId: "/one/connect", marker: phase === "native" ? "native-route-connect" : "native-connect-admission", authState: "authenticated",
      dataState: phase === "blocked" ? "error" : phase !== "native" ? "booting" : model.loading ? "loading" : model.people.length ? "loaded" : "empty-valid" }} />;
}
