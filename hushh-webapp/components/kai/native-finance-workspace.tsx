"use client";

import { createContext, useContext, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { usePathname } from "next/navigation";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { useNativeWorkspacePresentation } from "@/lib/capacitor/use-native-workspace";
import { NativeWorkspaceSurface, type NativeWorkspaceSurfaceSection, type NativeWorkspaceSurfaceConfirmation } from "@/lib/capacitor/native-workspace-surface";
import { normalizeStaticExportPathname, KAI_MARKET_PATH } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";

type FinanceTab = "market" | "portfolio" | "analysis";
type FinanceModel = { owner: string; view: FinanceTab; navigation?: { select: (view: FinanceTab) => void; tabs: readonly { value: string; label: string }[] } };
type Scope = { model: FinanceModel; frame: RefObject<HTMLDivElement | null>; enabled: boolean; current: () => boolean;
  presentation: ReturnType<typeof useNativeWorkspacePresentation>; path: string };
const FinancePresentation = createContext<Scope | null>(null);

/** The Finance tab owner stays in React. Its retained panes share the existing
 * workspace presentation owner; no feature-local retirement mechanism. */
export function NativeFinanceRoute({ model, frame, children, path: expectedPath = KAI_MARKET_PATH }: { model: FinanceModel; frame: RefObject<HTMLDivElement | null>; children: ReactNode; path?: string }) {
  const presentation = useNativeWorkspacePresentation();
  const { isVaultUnlocked } = useVault();
  const path = normalizeStaticExportPathname(usePathname() ?? "/");
  const live = useRef({ path, model }), mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { live.current = { path, model }; });
  const enabled = Boolean(isVaultUnlocked && customNativePresentationEnabled());
  const current = () => mounted.current && live.current.path === expectedPath && live.current.model.owner === model.owner;
  return <FinancePresentation.Provider value={{ model, frame, enabled, current, presentation, path: expectedPath }}>
    <div style={presentation.status.held ? { visibility: "hidden" } : undefined} inert={presentation.status.held || undefined} aria-hidden={presentation.status.held || undefined}>{children}</div>
  </FinancePresentation.Provider>;
}
export function useNativeFinancePaneActive(view: FinanceTab) {
  const scope = useContext(FinancePresentation);
  return Boolean(scope?.enabled && scope.model.view === view);
}
export function NativeFinanceLayer(props: { active: boolean; title: string; sections: NativeWorkspaceSurfaceSection[];
  contentPresentation?: "native" | "rich";
  confirmation?: NativeWorkspaceSurfaceConfirmation; search?: { query: string; label: string; change: (query: string) => void }; webChild?: boolean; viewKey?: string; fallback: ReactNode }) {
  const scope = useContext(FinancePresentation);
  if (!scope?.enabled || !props.active) return props.fallback;
  const navigation = scope.model.navigation;
  const tabs = navigation ? { label: "Finance sections", options: navigation.tabs.map(tab => ({ key: tab.value, label: tab.label,
    selected: scope.model.view === tab.value, run: () => navigation.select(tab.value as FinanceTab) })) } : undefined;
  return <NativeWorkspaceSurface key={props.viewKey} {...props} owner={scope.model.owner} workspace="finance" current={scope.current}
    backPath={scope.path} presentation={scope.presentation} frame={scope.frame} tabs={tabs} />;
}

export function NativeFinanceReactOnly({ children }: { children: ReactNode }) {
  return useContext(FinancePresentation)?.presentation.status.held ? null : children;
}

export function useFinancePaneSelected(view: FinanceTab) {
  const scope = useContext(FinancePresentation);
  return !scope || scope.model.view === view;
}
