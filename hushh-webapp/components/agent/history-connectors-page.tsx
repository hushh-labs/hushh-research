"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ArrowLeftIcon, XIcon } from "@/components/icons";
import { NativeFeaturePage } from "@/components/app-ui/native-feature-page";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { ProfileConnectorsSection } from "@/components/profile/profile-connectors-section";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { connectorDetailTitle } from "@/lib/navigation/profile-routes";

/** History's presentation stack, reusing Profile's connector/OAuth authority. */
export function HistoryConnectorsPage({ open, native, owner, context, onBack, onClose, onReady, onExternalModalChange }: {
  open: boolean; native: boolean; owner: string | null; context: string;
  onBack: () => void; onClose: () => void; onReady?: () => void;
  onExternalModalChange: (open: boolean) => void;
}) {
  const pathname = usePathname();
  const [connector, setConnector] = useState<string | null>(null);
  const [external, setExternal] = useState(false);
  const backButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (open && !native && !external) backButton.current?.focus({ preventScroll: true });
  }, [open, native, external]);
  const back = () => {
    if (external) return;
    if (connector) setConnector(null);
    else onBack();
  };
  useBackLayer(pathname, open ? 2 : 0, () => { back(); return true; });
  const handleExternalModalChange = useCallback((next: boolean) => {
    setExternal(next);
    onExternalModalChange(next);
  }, [onExternalModalChange]);
  const title = (connector ? connectorDetailTitle(`connector:${connector}`) : null) ?? "Connectors";
  const content = <div className="px-[var(--page-inline-gutter-standard)] py-4">
    <ProfileConnectorsSection open={open} connectorId={connector} onConnectorChange={setConnector}
      onExternalModalChange={handleExternalModalChange} />
  </div>;
  if (native) return <NativeFeaturePage pane side="left" layer="chat-history" open={open} title={title}
    owner={owner} context={`${context}:${connector ?? "list"}`} onBack={back} onClose={onClose}
    backLabel={connector ? "Back to connectors" : "Back to chats"} closeLabel="Close connectors" onReady={onReady}>
    {content}
  </NativeFeaturePage>;
  return <div className="flex h-full min-h-0 flex-col bg-background" inert={!open || external}
    onKeyDown={event => {
      if (event.key !== "Escape" || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
      event.preventDefault(); event.stopPropagation(); back();
    }}>
    <header className="flex min-h-14 shrink-0 items-center gap-2 px-4 py-3">
      <ShellActionSurface ref={backButton} aria-label={connector ? "Back to connectors" : "Back to chats"} onClick={back}><ArrowLeftIcon className="size-5" /></ShellActionSurface>
      <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h2>
      <ShellActionSurface aria-label="Close connectors" onClick={onClose}><XIcon className="size-5" /></ShellActionSurface>
    </header>
    <div data-history-connectors-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{content}</div>
  </div>;
}
