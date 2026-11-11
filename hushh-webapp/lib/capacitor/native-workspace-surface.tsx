"use client";

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useVault } from "@/lib/vault/vault-context";
import { customNativePresentationEnabled } from "./native-presentation-policy";
import { usePathname } from "next/navigation";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { normalizeStaticExportPathname } from "@/lib/navigation/routes";
import { ownerFacingConsentError } from "@/lib/consent/consent-owner-copy";
import { nativeFeedbackToast } from "./native-feedback";
import { useNativeWorkspace, useNativeWorkspacePresentation } from "./use-native-workspace";
import { useNativeWorkspaceHandoff } from "./use-native-workspace-handoff";
import { nativePersonInitials, useNativeWorkspacePortraits } from "@/components/app-ui/use-native-workspace-portraits";
import type { NativeWorkspaceChoice, NativeWorkspaceIdentity } from "./native-workspace";
import type { NativeWorkspaceLocationShare } from "./native-drawers";
import { useNativeShellOverlayBlocked } from "./native-navigation";

export type NativeWorkspaceSurfaceRow = { key: string; label: string; detail?: string; run?: () => unknown; web?: boolean;
  enabled?: boolean; pending?: boolean; selected?: boolean; destructive?: boolean; prominent?: boolean; symbol?: string;
  artworkId?: string; iconHex?: string; trailing?: string;
  person?: { name: string; photoUrl?: string | null; verified?: boolean; active?: boolean };
  locationShare?: Omit<NativeWorkspaceLocationShare, "people"> & { people: { name: string; photoUrl?: string | null }[] };
  inlineActions?: (Pick<NativeWorkspaceSurfaceRow, "key" | "label" | "run" | "web" | "enabled" | "pending" | "symbol"> & { tone: "primary" | "ghost" | "danger" | "success" })[];
  toggle?: { value: boolean; change: (value: boolean) => unknown };
  choices?: { key: string; label: string; selected: boolean; run: () => unknown }[] };
export type NativeWorkspaceSurfaceSection = { key: string; title?: string; layout?: "cards" | "tiles"; rows: NativeWorkspaceSurfaceRow[] };
export type NativeWorkspaceSurfaceConfirmation = { title: string; description: string; confirm: NativeWorkspaceSurfaceRow; cancel: () => unknown; cancelLabel: string };
type SurfaceProps = {
  owner: string; workspace: NativeWorkspaceIdentity["workspace"]; active: boolean; current: () => boolean; backPath: string;
  presentation: ReturnType<typeof useNativeWorkspacePresentation>; frame: RefObject<HTMLDivElement | null>;
  title: string; sections: NativeWorkspaceSurfaceSection[];
  /** Keep the complete authored presentation until native can express its visuals. */
  contentPresentation?: "native" | "rich";
  tabs?: { label: string; options: { key: string; label: string; selected: boolean; run: () => unknown }[] };
  search?: { query: string; label: string; change: (query: string) => void };
  calendarDate?: { key: string; label: string; value: string; timeZone: string; enabled: boolean; change: (value: string) => void };
  confirmation?: NativeWorkspaceSurfaceConfirmation; webChild?: boolean; fallback: ReactNode;
};

/** Single-pane routes compose through the same workspace owner. Feature
 * readers and complete React content remain mounted beneath the projection. */
export function NativeWorkspaceRoute(props: Omit<SurfaceProps, "owner" | "current" | "backPath" | "presentation" | "fallback"> & { owner: string | null; path: string; viewKey?: string; children: ReactNode }) {
  const presentation = useNativeWorkspacePresentation();
  const { isVaultUnlocked } = useVault();
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const live = useRef({ owner: props.owner, pathname }), mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { live.current = { owner: props.owner, pathname }; });
  const enabled = props.active && props.owner && isVaultUnlocked && customNativePresentationEnabled();
  const current = () => mounted.current && live.current.owner === props.owner && live.current.pathname === props.path;
  return <>
    <div style={presentation.status.held ? { visibility: "hidden" } : undefined} inert={presentation.status.held || undefined} aria-hidden={presentation.status.held || undefined}>{props.children}</div>
    {enabled ? <NativeWorkspaceSurface key={props.viewKey} {...props} owner={props.owner!} current={current} backPath={props.path} presentation={presentation} fallback={null} /> : null}
  </>;
}

/** Shared content/callback composition for Mail and Calendar. The existing
 * workspace owner still controls every admission, lifetime and retirement. */
export function NativeWorkspaceSurface(props: SurfaceProps) {
  if (!props.active || props.contentPresentation === "rich") return props.presentation.status.held ? <div aria-busy="true" /> : props.fallback;
  return <SurfaceOwner {...props} />;
}
function SurfaceOwner(props: SurfaceProps) {
  const handoff = useNativeWorkspaceHandoff(props.presentation.retireForWeb, props.owner);
  const webCovered = useNativeShellOverlayBlocked();
  const [child, setChild] = useState<{ owner: string; active: boolean }>({ owner: props.owner, active: false });
  const live = useRef(props);
  useLayoutEffect(() => { live.current = props; });
  useBackLayer(props.backPath, props.confirmation ? 3 : 0, () => {
    const confirmation = live.current.confirmation;
    if (!confirmation) return false;
    if (confirmation.confirm.enabled !== false && !confirmation.confirm.pending) confirmation.cancel();
    return true;
  });
  const runWeb = async (sectionKey: string, rowKey: string, toggleValue?: boolean) => {
    const owner = props.owner;
    const current = () => live.current.owner === owner && live.current.current();
    const resolve = () => {
      const value = live.current;
      const row = value.confirmation ? sectionKey === "confirmation" && value.confirmation.confirm.key === rowKey ? value.confirmation.confirm : undefined
        : value.sections.find(section => section.key === sectionKey)?.rows.flatMap(row => row.enabled !== false && !row.pending ? [row, ...(row.inlineActions ?? [])] : []).find(row => row.key === rowKey);
      return row?.web && (toggleValue === undefined ? row.run : "toggle" in row && row.toggle && row.toggle.value !== toggleValue) && row.enabled !== false && !row.pending ? row : undefined;
    };
    await handoff.handoff(current, () => Boolean(resolve()), () => {
      const intent = handoff.intent.current;
      setChild({ owner, active: true });
      void Promise.resolve().then(() => {
        if (intent !== handoff.intent.current || !current()) return;
        const row = resolve();
        return toggleValue === undefined ? row?.run?.() : row && "toggle" in row ? row.toggle?.change(toggleValue) : undefined;
      }).catch(error => {
        if (intent === handoff.intent.current && current())
          nativeFeedbackToast.error(ownerFacingConsentError(error, "That didn't go through. Try again."));
      }).finally(() => { if (intent === handoff.intent.current && current()) setChild({ owner, active: false }); });
    });
  };
  const status = props.presentation.status;
  if (child.owner === props.owner && child.active || props.webChild || webCovered || status.phase === "web" && ["unsupported", "failure"].includes(status.reason))
    return status.held ? <div aria-busy="true" /> : props.fallback;
  return <SurfaceBody {...props} runWeb={runWeb} activationRevision={handoff.activationRevision} />;
}
function SurfaceBody(props: SurfaceProps & { runWeb: (sectionKey: string, rowKey: string, toggleValue?: boolean) => Promise<void>; activationRevision: number }) {
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const live = useRef(props), mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { live.current = props; });
  const current = () => mounted.current && live.current.current();
  const handles = useMemo(() => {
    const map = new Map<string, string>();
    return (key: string) => { let id = map.get(key); if (!id) { id = crypto.randomUUID(); map.set(key, id); } return id; };
  }, [props.owner, props.workspace]);
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>();
  const confirmation = props.confirmation;
  const projected: NativeWorkspaceSurfaceSection[] = confirmation ? [{ key: "confirmation", rows: [
    { key: "confirmation-description", label: confirmation.title, detail: confirmation.description }, confirmation.confirm,
    { key: "confirmation-cancel", label: confirmation.cancelLabel, enabled: confirmation.confirm.enabled !== false && !confirmation.confirm.pending, run: confirmation.cancel },
  ] }] : props.sections;
  const portraits = useNativeWorkspacePortraits(props.owner, props.active, projected.flatMap(section => section.rows.flatMap(row => [
    ...(row.person ? [{ key: row.key, source: row.person.photoUrl }] : []),
    ...(row.locationShare?.people.map((person, index) => ({ key: `${row.key}:share:${index}`, source: person.photoUrl })) ?? []),
  ])));
  const sections = projected.filter(section => section.rows.length).map(section => ({ id: handles(`section:${section.key}`), title: section.title, ...(section.layout ? { layout: section.layout } : {}),
    rows: section.rows.map(row => {
      const id = handles(`row:${row.key}`);
      const options = row.toggle ? ([true, false] as const).map(value => {
        const optionId = handles(`row:${row.key}:${value}`);
        actions.set(optionId, () => {
          if (current() && row.enabled !== false && !row.pending && row.toggle && row.toggle.value !== value)
            return row.web ? props.runWeb(section.key, row.key, value) : row.toggle.change(value) as void | Promise<unknown>;
          return undefined;
        });
        return { id: optionId, label: value ? "On" : "Off", selected: row.toggle!.value === value };
      }) : row.choices?.map(choice => {
        const optionId = handles(`row:${row.key}:choice:${choice.key}`);
        actions.set(optionId, () => current() && row.enabled !== false && !row.pending && !choice.selected ? choice.run() as void | Promise<unknown> : undefined);
        return { id: optionId, label: choice.label, selected: choice.selected };
      });
      if (row.run) actions.set(id, () => { if (current() && row.enabled !== false && !row.pending) return row.web ? props.runWeb(section.key, row.key) : row.run!() as void | Promise<unknown>; });
      return { id, label: row.label, detail: row.detail ?? row.choices?.find(choice => choice.selected)?.label, enabled: row.enabled !== false, pending: row.pending, selected: row.selected,
        destructive: row.destructive, ...(row.prominent !== undefined ? { prominent: row.prominent } : {}), symbol: row.symbol, artworkId: row.artworkId, iconHex: row.iconHex, trailing: row.trailing,
        ...(row.person ? { avatar: { initials: nativePersonInitials(row.person.name), verified: row.person.verified === true, ...(row.person.active !== undefined ? { active: row.person.active } : {}), ...(portraits.get(row.key) ? { jpeg: portraits.get(row.key) } : {}) } } : {}),
        ...(row.locationShare ? { locationShare: { ...row.locationShare, people: row.locationShare.people.map((person, index) => ({ initials: nativePersonInitials(person.name),
          ...(portraits.get(`${row.key}:share:${index}`) ? { jpeg: portraits.get(`${row.key}:share:${index}`) } : {}) })) } } : {}),
        ...(row.inlineActions?.length ? { inlineActions: row.inlineActions.map(action => {
          const actionId = handles(`row:${row.key}:action:${action.key}`);
          actions.set(actionId, () => { if (current() && row.enabled !== false && !row.pending && action.enabled !== false && !action.pending)
            return action.web ? props.runWeb(section.key, action.key) : action.run?.() as void | Promise<unknown>; });
          return { id: actionId, label: action.label, enabled: action.enabled !== false, pending: action.pending, tone: action.tone, symbol: action.symbol };
        }) } : {}), ...(options ? { ...(row.toggle ? { toggle: true } : {}), options } : {}), ...(!row.run && !options ? { readOnly: true } : {}) };
    }),
  }));
  const options = props.tabs?.options.map(option => {
    const id = handles(`tab:${option.key}`);
    actions.set(id, () => { if (current()) return option.run() as void | Promise<unknown>; });
    return { id, label: option.label, selected: option.selected };
  });
  const searchId = handles("search");
  if (props.search) actions.set(searchId, choice => { if (current() && typeof choice.text === "string") live.current.search?.change(choice.text); });
  const dateId = handles(`date:${props.calendarDate?.key}`);
  if (props.calendarDate) actions.set(dateId, choice => { if (current() && live.current.calendarDate?.enabled && typeof choice.text === "string") live.current.calendarDate.change(choice.text); });
  const phase = useNativeWorkspace({ owner: props.owner, content: {
    workspace: props.workspace, page: "overview", title: props.title, enabled: true, backEnabled: false, sections,
    ...(props.tabs && options && !confirmation ? { tabs: { label: props.tabs.label, options } } : {}),
    ...(props.search && !confirmation ? { search: { id: searchId, query: props.search.query, label: props.search.label, live: true } } : {}),
    ...(props.calendarDate && !confirmation ? { calendarDate: { id: dateId, label: props.calendarDate.label, value: props.calendarDate.value, timeZone: props.calendarDate.timeZone, enabled: props.calendarDate.enabled } } : {}),
  }, actions, current, back: () => {}, contentFrame: props.frame, presentationOwner: props.presentation.owner,
    active: pathname === props.backPath, activationRevision: props.activationRevision });
  return <div aria-busy={phase !== "native"} data-native-feature-workspace={phase} />;
}
