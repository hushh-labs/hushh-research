"use client";

import { useNativeWorkspaceEvent } from "@/lib/capacitor/use-native-workspace-handoff";

import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { useNativeWorkspace, useNativeWorkspacePresentation } from "@/lib/capacitor/use-native-workspace";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import { normalizeStaticExportPathname, ROUTES } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";

type EmailPresentation = {
  owner: string | null; loading: boolean; connected: boolean;
  introduction: string; explanation: string;
  openMail: () => void; askOne: () => void; fallback: ReactNode;
};

/** Presentation only; the existing connector store owns connection status. */
export function NativeEmailWorkspace(props: EmailPresentation) {
  if (!customNativePresentationEnabled()) return props.fallback;
  return <EmailPresentationOwner {...props} />;
}
function EmailPresentationOwner(props: EmailPresentation) {
  const presentation = useNativeWorkspacePresentation();
  const { isVaultUnlocked } = useVault();
  const failed = presentation.status.phase === "web" && ["unsupported", "failure"].includes(presentation.status.reason);
  if (!props.owner || !isVaultUnlocked || failed) return presentation.status.held ? <div aria-busy="true" /> : props.fallback;
  return <EmailBody {...props} presentation={presentation} />;
}
function EmailBody({ presentation, ...model }: EmailPresentation & { presentation: ReturnType<typeof useNativeWorkspacePresentation> }) {
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  const frame = useRef<HTMLDivElement>(null), mounted = useRef(false);
  const latest = useRef({ model, pathname });
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { latest.current = { model, pathname }; });
  const owner = model.owner!;
  const current = () => mounted.current && latest.current.model.owner === owner && latest.current.pathname === ROUTES.EMAIL_AGENT;
  const ids = useMemo(() => ({ owner, intro: crypto.randomUUID(), status: crypto.randomUUID(), mail: crypto.randomUUID(), chat: crypto.randomUUID() }), [owner]);
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void>();
  const onMail = useNativeWorkspaceEvent(() => { if (current() && !latest.current.model.loading && !latest.current.model.connected) latest.current.model.openMail(); });
  actions.set(ids.mail, onMail);
  const onChat = useNativeWorkspaceEvent(() => { if (current() && !latest.current.model.loading && latest.current.model.connected) latest.current.model.askOne(); });
  actions.set(ids.chat, onChat);
  const phase = useNativeWorkspace({ owner, content: {
    workspace: "email", page: "overview", title: "Mail Agent", enabled: true, backEnabled: false,
    sections: [
      { id: "email-introduction", rows: [{ id: ids.intro, label: model.introduction, enabled: true, readOnly: true }] },
      { id: "email-status", rows: [{ id: ids.status, label: model.loading ? "Loading Mail connection…" : model.connected ? "Mail connected" : "Connect Mail",
        ...(model.loading ? { pending: true } : { detail: model.explanation, symbol: model.connected ? "checkmark.circle" : "envelope", ...(model.connected ? { iconHex: "#16a34a" } : {}) }),
        enabled: true, readOnly: true }] },
      ...(!model.loading ? [{ id: "email-action", rows: [{ id: model.connected ? ids.chat : ids.mail, label: model.connected ? "Ask One about Mail" : "Connect Mail", enabled: true, chevron: true }] }] : []),
    ],
  }, actions, current, back: () => {}, contentFrame: frame, presentationOwner: presentation.owner, active: pathname === ROUTES.EMAIL_AGENT });
  return <AppPageShell as="main" ref={frame} width="reading" aria-busy={phase !== "native"} data-native-email-workspace={phase}
    nativeTest={{ routeId: ROUTES.EMAIL_AGENT, marker: phase === "native" ? "native-route-email-agent" : "native-email-admission", authState: "authenticated",
      dataState: phase === "blocked" ? "error" : phase !== "native" ? "booting" : model.loading ? "loading" : model.connected ? "loaded" : "unavailable-valid" }} />;
}
