"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { usePathname } from "next/navigation";
import { useVault } from "@/lib/vault/vault-context";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { useNativeWorkspacePresentation } from "@/lib/capacitor/use-native-workspace";
import { NativeWorkspaceSurface, type NativeWorkspaceSurfaceSection, type NativeWorkspaceSurfaceTextEditor, type NativeWorkspaceSurfaceConfirmation } from "@/lib/capacitor/native-workspace-surface";
import { normalizeStaticExportPathname, ROUTES } from "@/lib/navigation/routes";

type LocationTab = "now" | "people" | "links";
type LocationModel = { close: () => void; owner: string | null; tab: LocationTab; flow: string; select: (tab: LocationTab) => void; root: NativeWorkspaceSurfaceSection[] };
type LayerProps = { tabs?: { label: string; options: { key: string; label: string; selected: boolean; run: () => unknown }[] }; navigationDepth?: number; overlay?: boolean; when?: boolean; tab?: LocationTab; flow?: string; title: string; sections: NativeWorkspaceSurfaceSection[]; textEditor?: NativeWorkspaceSurfaceTextEditor; confirmation?: NativeWorkspaceSurfaceConfirmation; nested?: boolean; viewKey?: string;
  search?: { query: string; label: string; change: (query: string) => void }; webChild?: boolean; contentPresentation?: "native" | "rich"; children: ReactNode };
type LayerSlot = { parent?: LayerSlot; token: symbol; depth: number; digest: string; props: { current: LayerProps } };
type Scope = { publish: (slot: LayerSlot) => void; withdraw: (token: symbol) => void; model: LocationModel; frame: RefObject<HTMLDivElement | null>; enabled: boolean; current: () => boolean; presentation: ReturnType<typeof useNativeWorkspacePresentation> };
const LocationPresentation = createContext<Scope | null>(null);

/** Location keeps its existing readers, clocks and task state mounted. Only
 * presentation is shared; the workspace adapter owns admission/retirement. */
export function NativeLocationRoute({ model, frame, children }: { model: LocationModel; frame: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const presentation = useNativeWorkspacePresentation();
  const [slot, setSlot] = useState<LayerSlot | null>(null);
  const { isVaultUnlocked } = useVault();
  const path = normalizeStaticExportPathname(usePathname() ?? "/");
  const live = useRef({ path, owner: model.owner }), mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { live.current = { path, owner: model.owner }; });
  const enabled = Boolean(model.owner && isVaultUnlocked && customNativePresentationEnabled());
  const current = () => mounted.current && live.current.path === ROUTES.ONE_LOCATION && live.current.owner === model.owner;
  // A feature publishes content, not a second presentation owner. Keeping this
  // single surface mounted lets native own navigation motion and input lifetime.
  const publish = (next: LayerSlot) => setSlot(previous => {
    const replace = (value: LayerSlot | null | undefined): LayerSlot => {
      if (!value) return next;
      if (value.token === next.token) return value.digest === next.digest && value.depth === next.depth ? value : { ...next, parent: value.parent };
      if (value.depth > next.depth) { const parent = replace(value.parent); return parent === value.parent ? value : { ...value, parent }; }
      return { ...next, parent: value.depth < next.depth ? value : value.parent };
    };
    return replace(previous);
  });
  const withdraw = (token: symbol) => setSlot(previous => {
    const remove = (value: LayerSlot | null | undefined): LayerSlot | null => {
      if (!value) return null;
      if (value.token === token) return value.parent ?? null;
      const parent = remove(value.parent); return parent === (value.parent ?? null) ? value : { ...value, parent: parent ?? undefined };
    };
    return remove(previous);
  });
  const layer = slot?.props.current;
  const latestRow = (section: string, key: string) => slot?.props.current.sections.find(value => value.key === section)?.rows.find(value => value.key === key);
  const sections = layer?.sections.map(section => ({ ...section, rows: section.rows.map(row => ({ ...row,
    ...(row.run ? { run: () => latestRow(section.key, row.key)?.run?.() } : {}),
    ...(row.toggle ? { toggle: { ...row.toggle, change: (value: boolean) => latestRow(section.key, row.key)?.toggle?.change(value) } } : {}),
    ...(row.choices ? { choices: row.choices.map(choice => ({ ...choice, run: () => latestRow(section.key, row.key)?.choices?.find(value => value.key === choice.key)?.run() })) } : {}),
    ...(row.inlineActions ? { inlineActions: row.inlineActions.map(action => ({ ...action, run: () => latestRow(section.key, row.key)?.inlineActions?.find(value => value.key === action.key)?.run?.() })) } : {}),
  })) })) ?? [];
  return <LocationPresentation.Provider value={{ model, frame, enabled, current, presentation, publish, withdraw }}>
    <div style={presentation.status.held ? { visibility: "hidden" } : undefined} inert={presentation.status.held || undefined} aria-hidden={presentation.status.held || undefined}>{children}</div>
    {enabled && layer ? <NativeWorkspaceSurface owner={model.owner!} workspace="location" active current={current} backPath={ROUTES.ONE_LOCATION}
      presentation={presentation} frame={frame} title={layer.title} contentPresentation={layer.contentPresentation}
      sections={[...(!layer.flow && !layer.nested ? model.root : []), ...sections]} textEditor={layer.textEditor} confirmation={layer.confirmation}
      search={layer.search} webChild={layer.webChild} fallback={null} contentKey={layer.viewKey ?? `${layer.flow ?? layer.tab}:${layer.nested ? "child" : "root"}`}
      depth={layer.navigationDepth ?? (layer.nested ? 5 : layer.flow ? 3 : ["now", "people", "links"].indexOf(layer.tab ?? model.tab))}
      tabs={layer.tabs ?? (!layer.flow && !layer.nested ? { label: "Location sections", options: (["now", "people", "links"] as const).map(tab => ({ key: tab,
        label: tab === "now" ? "Now" : tab === "people" ? "People" : "Links", selected: model.tab === tab, run: () => model.select(tab) })) } : undefined)} /> : null}
  </LocationPresentation.Provider>;
}

export function useNativeLocationPaneActive(tab: LocationTab) {
  const scope = useContext(LocationPresentation);
  return Boolean(scope?.enabled && scope.presentation.status.phase !== "web" && scope.model.flow === "none" && scope.model.tab === tab);
}
export function NativeLocationLayer(props: LayerProps) {
  const scope = useContext(LocationPresentation);
  const token = useRef(Symbol("location-content"));
  const committed = useRef(props);
  const active = Boolean(scope?.enabled && props.when !== false && (props.overlay ? true : props.flow ? scope.model.flow === props.flow : scope.model.flow === "none" && scope.model.tab === props.tab));
  const [page, setPage] = useState(0);
  useLayoutEffect(() => { setPage(0); }, [props.viewKey, props.search?.query]);
  const peopleCount = active ? props.sections.reduce((count, section) => count + section.rows.filter(row => row.person).length, 0) : 0;
  const index = Math.min(page, Math.max(0, Math.ceil(peopleCount / 24) - 1));
  let cursor = 0;
  const sections = peopleCount > 24 ? props.sections.map(section => ({ ...section, rows: section.rows.filter(row => !row.person || Math.floor(cursor++ / 24) === index) })) : props.sections;
  const prepared = { ...props, sections: [...sections, ...(peopleCount > 24 ? [{ key: "native-people-page", rows: [
    { key: "page-label", label: `${index * 24 + 1}–${Math.min((index + 1) * 24, peopleCount)} of ${peopleCount}` },
    { key: "page-previous", label: "Previous people", enabled: index > 0, run: () => setPage(value => value - 1) },
    { key: "page-next", label: "More people", enabled: (index + 1) * 24 < peopleCount, run: () => setPage(value => value + 1) },
  ] }] : [])] };
  const digest = active ? JSON.stringify({ ...prepared, children: undefined }) : "";
  useLayoutEffect(() => {
    committed.current = prepared;
    if (active) scope?.publish({ token: token.current, depth: props.overlay ? 3 : props.nested ? 2 : props.flow ? 1 : 0, digest, props: committed });
    else scope?.withdraw(token.current);
  });
  const lifecycle = useRef(scope);
  useLayoutEffect(() => { lifecycle.current = scope; });
  useLayoutEffect(() => () => lifecycle.current?.withdraw(token.current), []);
  return <>{props.children}</>;
}

/** Suppress a React portal only while its route has opted into native presentation. */
export function useNativeLocationEnabled() {
  const scope = useContext(LocationPresentation);
  return Boolean(scope?.enabled && !(scope.presentation.status.phase === "web" && ["unsupported", "failure"].includes(scope.presentation.status.reason)));
}

/** The authored 15-minute floor and 24-hour cap, presented with native menus. */
export function nativeLocationDurationRows(key: string, value: string, change: (value: string) => void,
  rungs: readonly { value: string; label: string }[], custom: boolean, setCustom: (value: boolean) => void, untilStop = false): NativeWorkspaceSurfaceSection["rows"] {
  const presets = [...rungs, ...(untilStop ? [{ value: "until_stopped", label: "Until I stop" }] : [])];
  const customSelected = custom || !presets.some(option => option.value === value);
  const minutes = value === "until_stopped" ? 15 : Math.min(1440, Math.max(15, Math.round(Number(value) * 60) || 15));
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return [{ key, label: "How long", choices: [
    ...presets.map(option => ({ key: option.value, label: option.label, selected: !customSelected && value === option.value, run: () => { setCustom(false); change(option.value); } })),
    { key: "custom", label: customSelected ? `Custom · ${hours}h ${remainder}m` : "Custom", selected: customSelected, run: () => { setCustom(true); change(String(minutes / 60)); } },
  ] }, ...(customSelected ? [
    { key: `${key}-hours`, label: "Hours", choices: Array.from({ length: 25 }, (_, hour) => ({ key: String(hour), label: String(hour), selected: hours === hour,
      run: () => change(String((hour * 60 + (hour === 24 ? 0 : hour === 0 ? Math.max(15, remainder) : remainder)) / 60)) })) },
    hours === 24 ? { key: `${key}-minutes`, label: "Minutes", detail: "0" } : { key: `${key}-minutes`, label: "Minutes", choices: [0, 15, 30, 45].filter(minute => hours > 0 || minute > 0).map(minute => ({ key: String(minute), label: String(minute), selected: remainder === minute, run: () => change(String((hours * 60 + minute) / 60)) })) },
  ] : [])];
}

export function useNativeLocationClose() { return useContext(LocationPresentation)?.model.close; }
