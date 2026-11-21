"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { SettingsDetailPanel, SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { useBackLayer } from "@/lib/navigation/back-layers";
import type { FeedActionable } from "@/lib/feed/use-feed-actionables";

export function FeedPrerequisiteDetail({ requests, actions, onClose, onNavigate }: {
  requests: NonNullable<FeedActionable["affectedRequests"]>;
  actions: ReactNode;
  onClose: () => void;
  onNavigate?: (href: string) => void;
}) {
  useBackLayer("/one/feed", 2, () => { onClose(); return true; });
  return <SettingsDetailPanel open onOpenChange={open => { if (!open) onClose(); }}
    title="Connect Google Drive" mobilePresentation="sheet" headerTextOverflow="wrap" footer={actions}>
    <SettingsGroup>
      {requests.map(request => <SettingsRow key={request.requestId} asChild title={request.label}
        description="Document request" textOverflow="wrap" chevron>
        <Link href={request.href} prefetch={false} onClick={() => { onClose(); onNavigate?.(request.href); }} />
      </SettingsRow>)}
    </SettingsGroup>
  </SettingsDetailPanel>;
}
