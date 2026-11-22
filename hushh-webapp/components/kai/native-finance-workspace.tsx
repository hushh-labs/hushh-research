"use client";

import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { usePathname } from "next/navigation";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { useNativeWorkspacePresentation } from "@/lib/capacitor/use-native-workspace";
import { NativeWorkspaceSurface, type NativeWorkspaceSurfaceSection, type NativeWorkspaceSurfaceConfirmation } from "@/lib/capacitor/native-workspace-surface";
import { normalizeStaticExportPathname, KAI_MARKET_PATH } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";
import { validNativeFinanceContent } from "@/lib/capacitor/native-finance-content";
import { useNativeWorkspaceImages } from "@/components/app-ui/use-native-workspace-portraits";
import { getCompanyLogoUrl } from "@/components/kai/shared/symbol-avatar";
import { prepareNativeSymbolArtwork } from "@/lib/services/native-public-image-service";

type FinanceTab = "market" | "portfolio" | "analysis";
type FinanceModel = { owner: string; view: FinanceTab; rich?: boolean; navigation?: { select: (view: FinanceTab) => void; tabs: readonly { value: string; label: string }[] } };
type LayerProps = { pane?: FinanceTab; active: boolean; title: string; sections: NativeWorkspaceSurfaceSection[];
  contentPresentation?: "native" | "rich"; confirmation?: NativeWorkspaceSurfaceConfirmation;
  search?: { query: string; label: string; change: (query: string) => void }; webChild?: boolean; viewKey?: string; fallback: ReactNode };
type Slot = { token: symbol; visit: string; owner: string; pane: FinanceTab; digest: string; props: { current: LayerProps } };
type Scope = { model: FinanceModel; frame: RefObject<HTMLDivElement | null>; enabled: boolean; current: () => boolean; visit: string;
  presentation: ReturnType<typeof useNativeWorkspacePresentation>; path: string; publish: (slot: Slot) => void; withdraw: (token: symbol) => void };
const FinancePresentation = createContext<Scope | null>(null);

/** React keeps the three pane controllers. Their committed content shares one
 * existing workspace presenter; selecting a tab never replaces its owner. */
export function NativeFinanceRoute({ model, frame, children, path: expectedPath = KAI_MARKET_PATH }: { model: FinanceModel; frame: RefObject<HTMLDivElement | null>; children: ReactNode; path?: string }) {
  const presentation = useNativeWorkspacePresentation();
  const [slot, setSlot] = useState<Slot | null>(null);
  const { isVaultUnlocked } = useVault();
  const path = normalizeStaticExportPathname(usePathname() ?? "/");
  const visit = useMemo(() => ({ owner: model.owner, view: model.view, path, token: crypto.randomUUID() }), [model.owner, model.view, path]).token;
  const live = useRef({ path, model, visit, slot }), mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { live.current = { path, model, visit, slot }; });
  const enabled = Boolean(isVaultUnlocked && customNativePresentationEnabled());
  const current = () => mounted.current && live.current.path === expectedPath && live.current.model.owner === model.owner;
  const publish = (next: Slot) => setSlot(previous => previous?.token === next.token && previous.visit === next.visit && previous.owner === next.owner && previous.digest === next.digest ? previous : next);
  const withdraw = (token: symbol) => setSlot(previous => previous?.token === token ? null : previous);
  const selected = slot?.owner === model.owner && slot.visit === visit && slot.pane === model.view ? slot : null;
  const layer = selected?.props.current;
  const latest = () => current() && selected && live.current.slot?.token === selected.token && live.current.visit === selected.visit && live.current.model.view === selected.pane ? selected.props.current : undefined;
  const latestRow = (section: string, key: string) => latest()?.sections.find(value => value.key === section)?.rows.find(value => value.key === key);
  const images = useNativeWorkspaceImages(model.owner, enabled && Boolean(layer) && !model.rich && layer?.contentPresentation !== "rich" && !layer?.webChild,
    layer?.sections.flatMap(section => section.rows.flatMap(row => row.finance?.kind === "security" && row.finance.style !== "holding" && row.finance.symbol ? [{ key: row.key, source: getCompanyLogoUrl({ symbol: row.finance.symbol }) }] : [])) ?? [], prepareNativeSymbolArtwork);
  // Visit-scoped section/row IDs also fence a web handoff which finishes after
  // Market -> Stocks -> Market. Its old key cannot resolve in the new visit.
  const sections = layer?.sections.map(section => ({ ...section, key: `${visit}:${section.key}`, rows: section.rows.map(row => ({ ...row, key: `${visit}:${row.key}`,
    ...(row.finance?.kind === "security" && images.get(row.key) ? { finance: { ...row.finance, artwork: { ...row.finance.artwork, png: images.get(row.key) } } } : {}),
    ...(row.run ? { run: () => { const next = latestRow(section.key, row.key); if (next?.enabled !== false && !next?.pending) return next?.run?.(); return undefined; } } : {}),
    ...(row.toggle ? { toggle: { ...row.toggle, change: (value: boolean) => { const next = latestRow(section.key, row.key); if (next?.enabled !== false && !next?.pending) return next?.toggle?.change(value); return undefined; } } } : {}),
    ...(row.choices ? { choices: row.choices.map(choice => ({ ...choice, run: () => { const next = latestRow(section.key, row.key); const option = next?.choices?.find(value => value.key === choice.key); if (next?.enabled !== false && !next?.pending && !option?.selected) return option?.run(); return undefined; } })) } : {}),
  })) })) ?? [{ key: `${visit}:loading`, rows: [{ key: `${visit}:loading`, label: "Loading Finance…", pending: true }] }];
  const complete = !layer || layer.sections.every(section => section.rows.every(row => !row.finance || validNativeFinanceContent(row.finance)));
  return <FinancePresentation.Provider value={{ model, frame, enabled, current, presentation, path: expectedPath, visit, publish, withdraw }}>
    <div style={presentation.status.held ? { visibility: "hidden" } : undefined} inert={presentation.status.held || undefined} aria-hidden={presentation.status.held || undefined}>{children}</div>
    {enabled && model.navigation ? <NativeWorkspaceSurface owner={model.owner} workspace="finance" active current={current} backPath={expectedPath}
      presentation={presentation} frame={frame} title={layer?.title ?? "Finance"} sections={sections}
      contentPresentation={model.rich || !complete ? "rich" : layer?.contentPresentation} webChild={layer?.webChild}
      search={layer?.search ? { ...layer.search, change: query => latest()?.search?.change(query) } : undefined}
      confirmation={layer?.confirmation} tabs={{ label: "Finance sections", options: model.navigation.tabs.map(tab => ({ key: tab.value, label: tab.label,
        selected: model.view === tab.value, run: () => { if (current()) live.current.model.navigation?.select(tab.value as FinanceTab); } })) }} fallback={null} /> : null}
  </FinancePresentation.Provider>;
}
export function useNativeFinancePaneActive(view: FinanceTab) {
  const scope = useContext(FinancePresentation);
  return Boolean(scope?.enabled && scope.model.view === view);
}
export function NativeFinanceLayer(props: LayerProps) {
  const scope = useContext(FinancePresentation);
  const token = useRef(Symbol("finance-content"));
  const committed = useRef(props), lifecycle = useRef(scope);
  const active = Boolean(scope?.enabled && scope.model.navigation && props.active && props.pane === scope.model.view);
  const digest = active ? JSON.stringify({ ...props, fallback: undefined }, (_key, value: unknown) => typeof value === "function" ? "callback" : value) : "";
  useLayoutEffect(() => {
    committed.current = props; lifecycle.current = scope;
    if (active && scope && props.pane) scope.publish({ token: token.current, visit: scope.visit, owner: scope.model.owner, pane: props.pane, digest, props: committed });
    else scope?.withdraw(token.current);
  });
  useLayoutEffect(() => () => lifecycle.current?.withdraw(token.current), []);
  if (!scope?.enabled || !props.active || scope.model.navigation) return props.fallback;
  return <NativeWorkspaceSurface key={props.viewKey} {...props} owner={scope.model.owner} workspace="finance" current={scope.current}
    backPath={scope.path} presentation={scope.presentation} frame={scope.frame} />;
}
export function NativeFinanceReactOnly({ children }: { children: ReactNode }) {
  return useContext(FinancePresentation)?.presentation.status.held ? null : children;
}
export function useFinancePaneSelected(view: FinanceTab) {
  const scope = useContext(FinancePresentation);
  return !scope || scope.model.view === view;
}
