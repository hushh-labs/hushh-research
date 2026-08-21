"use client";

import { useState } from "react";
import { CheckCircle2, Mail, MessageCircle } from "lucide-react";

import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceCard, SurfaceCardContent, SurfaceCardDescription, SurfaceCardHeader, SurfaceCardTitle } from "@/components/app-ui/surfaces";
import { GmailSendAccessCard } from "@/components/gmail/gmail-send-access-card";
import { Button } from "@/lib/morphy-ux/button";

/** Gmail email-agent entry point. OAuth is Firebase-only; chat actions still require VAULT_OWNER. */
export function EmailAgentPage() {
  const agentPopover = useOptionalAgentPopover();
  const [connected, setConnected] = useState(false);
  const openChat = () => agentPopover?.openAgent({ handoff: { id: `email-prompt-${Date.now()}`, reason: "user_requested", transcript: "Help me draft an email. I will review and approve it before anything is sent.", createdAtMs: Date.now() } });
  return (
    <AppPageShell width="reading" className="motion-step-enter fixed inset-x-0 top-[64px] bottom-[115px] z-10 m-auto flex w-full max-w-[720px] flex-col items-center justify-center overflow-hidden px-4">
      <AppPageHeaderRegion className="mb-4 w-full max-w-md text-center"><PageHeader title="Email" className="flex flex-col items-center text-center" /></AppPageHeaderRegion>
      <AppPageContentRegion className="w-full max-w-md">
        <SurfaceCard className="w-full overflow-hidden text-center shadow-md">
          <SurfaceCardHeader className="flex flex-col items-center space-y-1 pb-3 pt-5 text-center"><div className="mb-2 flex size-11 items-center justify-center rounded-[12px] bg-primary/10 text-primary"><Mail className="size-5" /></div><SurfaceCardTitle>{connected ? "Gmail connected" : "Connect Gmail"}</SurfaceCardTitle><SurfaceCardDescription>{connected ? "Read receipts and inbox context, then draft emails for your final approval." : "Give One access to read email for receipt classification and send only after your confirmation."}</SurfaceCardDescription></SurfaceCardHeader>
          <SurfaceCardContent className="border-t border-border/60 pt-4"><GmailSendAccessCard onConnectionStateChange={setConnected} />{connected ? <div className="flex flex-col items-center gap-3"><span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="size-4" />Connected</span><Button disabled={!agentPopover} onClick={openChat} className="w-full justify-center"><MessageCircle className="size-4" />Try Email Agent with One</Button></div> : null}</SurfaceCardContent>
        </SurfaceCard>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
