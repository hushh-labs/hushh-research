"use client";

import { createContext, useContext, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { usePathname } from "next/navigation";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { useNativeWorkspacePresentation } from "@/lib/capacitor/use-native-workspace";
import { NativeWorkspaceSurface, type NativeWorkspaceSurfaceRow, type NativeWorkspaceSurfaceSection, type NativeWorkspaceSurfaceConfirmation } from "@/lib/capacitor/native-workspace-surface";
import { normalizeStaticExportPathname, ROUTES } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";

export type CalendarNativeRow = NativeWorkspaceSurfaceRow;
export type CalendarNativeSection = NativeWorkspaceSurfaceSection;
type LayerProps = Omit<Parameters<typeof NativeWorkspaceSurface>[0], "owner" | "workspace" | "current" | "backPath" | "presentation" | "frame" | "tabs">;
type RouteModel = { owner: string | null; onboarding: boolean; rootOnly: boolean; root: CalendarNativeSection[];
  webChild: boolean; confirmation?: NativeWorkspaceSurfaceConfirmation };
type RouteScope = { model: RouteModel; frame: RefObject<HTMLDivElement | null>; enabled: boolean;
  presentation: ReturnType<typeof useNativeWorkspacePresentation>; current: () => boolean; path: string };
const CalendarPresentation = createContext<RouteScope | null>(null);
type PaneScope = { tabs: NonNullable<Parameters<typeof NativeWorkspaceSurface>[0]["tabs"]>; sections: CalendarNativeSection[] };
const CalendarPanes = createContext<PaneScope | null>(null);

export function NativeCalendarRoute({ model, frame, children }: { model: RouteModel; frame: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const presentation = useNativeWorkspacePresentation();
  const { isVaultUnlocked } = useVault();
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const path = model.onboarding ? ROUTES.ONE_SETUP_CALENDAR : ROUTES.CALENDAR;
  const live = useRef({ model, pathname }), mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { live.current = { model, pathname }; });
  const enabled = customNativePresentationEnabled() && Boolean(model.owner) && isVaultUnlocked;
  const current = () => mounted.current && live.current.pathname === path && live.current.model.owner === model.owner;
  return <CalendarPresentation.Provider value={{ model, frame, enabled, presentation, current, path }}>
    <div data-native-calendar-react-surface style={presentation.status.held ? { visibility: "hidden" } : undefined}
      inert={presentation.status.held || undefined} aria-hidden={presentation.status.held || undefined}>{children}</div>
    {enabled && model.rootOnly ? <NativeCalendarLayer active title="Calendar" sections={model.root} fallback={null} /> : null}
  </CalendarPresentation.Provider>;
}
export function NativeCalendarBoardScope({ children, ...value }: PaneScope & { children: ReactNode }) {
  return <CalendarPanes.Provider value={value}>{children}</CalendarPanes.Provider>;
}
export function NativeCalendarLayer(props: LayerProps) {
  const scope = useContext(CalendarPresentation), panes = useContext(CalendarPanes);
  if (!scope?.enabled || !props.active || scope.model.rootOnly && panes) return props.fallback;
  return <NativeWorkspaceSurface {...props} owner={scope.model.owner!} workspace="calendar" current={scope.current}
    contentPresentation={panes ? "rich" : props.contentPresentation}
    backPath={scope.path} presentation={scope.presentation} frame={scope.frame} tabs={panes?.tabs}
    sections={[...(panes?.sections ?? []), ...props.sections]} confirmation={scope.model.confirmation}
    webChild={scope.model.webChild || props.webChild} />;
}
export function useNativeCalendarFrame() { return useContext(CalendarPresentation)?.frame; }
export function useNativeCalendarEnabled() { return Boolean(useContext(CalendarPresentation)?.enabled); }
export function NativeCalendarReactOnly({ children }: { children: ReactNode }) {
  return useContext(CalendarPresentation)?.presentation.status.held ? null : children;
}
