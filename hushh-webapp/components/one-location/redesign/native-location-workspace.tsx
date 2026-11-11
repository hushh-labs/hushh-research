"use client";

import { createContext, useContext, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { usePathname } from "next/navigation";
import { useVault } from "@/lib/vault/vault-context";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { useNativeWorkspacePresentation } from "@/lib/capacitor/use-native-workspace";
import { NativeWorkspaceSurface, type NativeWorkspaceSurfaceSection } from "@/lib/capacitor/native-workspace-surface";
import { normalizeStaticExportPathname, ROUTES } from "@/lib/navigation/routes";

type LocationTab = "now" | "people" | "links";
type LocationModel = { owner: string | null; tab: LocationTab; flow: string; richRoot?: boolean; select: (tab: LocationTab) => void; root: NativeWorkspaceSurfaceSection[] };
type Scope = { model: LocationModel; frame: RefObject<HTMLDivElement | null>; enabled: boolean; current: () => boolean; presentation: ReturnType<typeof useNativeWorkspacePresentation> };
const LocationPresentation = createContext<Scope | null>(null);

/** Location keeps its existing readers, clocks and task state mounted. Only
 * presentation is shared; the workspace adapter owns admission/retirement. */
export function NativeLocationRoute({ model, frame, children }: { model: LocationModel; frame: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const presentation = useNativeWorkspacePresentation();
  const { isVaultUnlocked } = useVault();
  const path = normalizeStaticExportPathname(usePathname() ?? "/");
  const live = useRef({ path, owner: model.owner }), mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { live.current = { path, owner: model.owner }; });
  const enabled = Boolean(model.owner && isVaultUnlocked && customNativePresentationEnabled());
  const current = () => mounted.current && live.current.path === ROUTES.ONE_LOCATION && live.current.owner === model.owner;
  return <LocationPresentation.Provider value={{ model, frame, enabled, current, presentation }}>
    <div style={presentation.status.held ? { visibility: "hidden" } : undefined} inert={presentation.status.held || undefined} aria-hidden={presentation.status.held || undefined}>{children}</div>
  </LocationPresentation.Provider>;
}
export function useNativeLocationPaneActive(tab: LocationTab) {
  const scope = useContext(LocationPresentation);
  return Boolean(scope?.enabled && !scope.model.richRoot && scope.presentation.status.phase !== "web" && scope.model.flow === "none" && scope.model.tab === tab);
}
export function NativeLocationLayer(props: { tab?: LocationTab; flow?: string; title: string; sections: NativeWorkspaceSurfaceSection[];
  search?: { query: string; label: string; change: (query: string) => void }; webChild?: boolean; contentPresentation?: "native" | "rich"; children: ReactNode }) {
  const scope = useContext(LocationPresentation);
  const active = Boolean(scope?.enabled && (props.flow ? scope.model.flow === props.flow : scope.model.flow === "none" && scope.model.tab === props.tab));
  // Retain the existing clock/expiry, dialogs and saved-place owners even while
  // native owns their visible controls. No second reader or timer is started.
  return <>{props.children}{active && scope ? <NativeWorkspaceSurface owner={scope.model.owner!} workspace="location" active current={scope.current}
    backPath={ROUTES.ONE_LOCATION} presentation={scope.presentation} frame={scope.frame} title={props.title}
    contentPresentation={props.flow ? props.contentPresentation : scope.model.richRoot ? "rich" : props.contentPresentation} sections={[...(!props.flow ? scope.model.root : []), ...props.sections]} search={props.search} webChild={props.webChild} fallback={null}
    tabs={!props.flow ? { label: "Location sections", options: (["now", "people", "links"] as const).map(tab => ({ key: tab,
      label: tab === "now" ? "Now" : tab === "people" ? "People" : "Links", selected: scope.model.tab === tab, run: () => scope.model.select(tab) })) } : undefined} /> : null}</>;
}
