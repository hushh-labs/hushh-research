"use client";

import { createContext, useContext, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { usePathname } from "next/navigation";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { useNativeWorkspacePresentation } from "@/lib/capacitor/use-native-workspace";
import { normalizeStaticExportPathname, ROUTES } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";
import { NativeWorkspaceSurface, type NativeWorkspaceSurfaceRow, type NativeWorkspaceSurfaceSection, type NativeWorkspaceSurfaceConfirmation } from "@/lib/capacitor/native-workspace-surface";
import type { GmailWorkspace } from "./gmail-workspace-navigation";

export type MailNativeRow = NativeWorkspaceSurfaceRow;
export type MailNativeSection = NativeWorkspaceSurfaceSection;
export type MailNativeConfirmation = NativeWorkspaceSurfaceConfirmation;
type MailNativeRouteModel = {
  owner: string | null; onboarding: boolean; view: GmailWorkspace; selectView: (view: GmailWorkspace) => void;
  connected: boolean; webChild: boolean; rootOnly: boolean; root: MailNativeSection[]; confirmation?: MailNativeConfirmation;
};
type MailScope = { model: MailNativeRouteModel; frame: RefObject<HTMLDivElement | null>;
  presentation: ReturnType<typeof useNativeWorkspacePresentation>; enabled: boolean; current: () => boolean };
const MailPresentation = createContext<MailScope | null>(null);

/** One shared presentation owner across the retained Mail panes. Readers,
 * drafts and the receipt-to-Memory effect stay with their existing owners. */
export function NativeMailRoute({ model, frame, children }: { model: MailNativeRouteModel; frame: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const presentation = useNativeWorkspacePresentation();
  const { isVaultUnlocked } = useVault();
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const expected = model.onboarding ? ROUTES.ONE_SETUP_GMAIL : ROUTES.GMAIL;
  const live = useRef({ model, pathname });
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { live.current = { model, pathname }; });
  const enabled = customNativePresentationEnabled() && Boolean(model.owner) && isVaultUnlocked;
  const current = () => mounted.current && live.current.pathname === expected && live.current.model.owner === model.owner;
  return <MailPresentation.Provider value={{ model, frame, presentation, enabled, current }}>
    <div data-native-mail-react-surface="true" style={presentation.status.held ? { visibility: "hidden" } : undefined}
      inert={presentation.status.held || undefined} aria-hidden={presentation.status.held || undefined}>{children}</div>
    {enabled && model.rootOnly ? <NativeMailLayer active title="Mail" sections={model.root} confirmation={model.confirmation} webChild={model.webChild} fallback={null} /> : null}
  </MailPresentation.Provider>;
}

/** Feature mapping only. Admission, late-event fencing, geometry, feedback and
 * confirmed React handoffs reuse the existing workspace infrastructure. */
export function NativeMailLayer(props: { active: boolean; title: string; sections: MailNativeSection[];
  search?: { query: string; label: string; change: (query: string) => void }; includeRoot?: boolean;
  confirmation?: MailNativeConfirmation; webChild?: boolean; fallback: ReactNode }) {
  const scope = useContext(MailPresentation);
  if (!scope?.enabled || !props.active) return props.fallback;
  const tabs = (["overview", "kyc", "receipts"] as const).map(view => ({ key: view,
    label: view === "overview" ? "Overview" : view === "kyc" ? "KYC" : "Receipts", selected: scope.model.view === view,
    run: () => scope.model.selectView(view),
  }));
  return <NativeWorkspaceSurface {...props} owner={scope.model.owner!} workspace="mail" current={scope.current}
    presentation={scope.presentation} frame={scope.frame} backPath={scope.model.onboarding ? ROUTES.ONE_SETUP_GMAIL : ROUTES.GMAIL}
    sections={[...(props.includeRoot ? scope.model.root : []), ...props.sections]} webChild={props.webChild || scope.model.webChild}
    tabs={scope.model.onboarding ? undefined : { label: "Gmail workspace", options: tabs }} />;
}
export function NativeMailReactOnly({ children }: { children: ReactNode }) {
  const scope = useContext(MailPresentation);
  return scope?.presentation.status.held ? null : children;
}
export function useNativeMailPaneActive(view: GmailWorkspace) {
  const scope = useContext(MailPresentation);
  return Boolean(scope?.enabled && !scope.model.rootOnly && scope.model.view === view);
}
