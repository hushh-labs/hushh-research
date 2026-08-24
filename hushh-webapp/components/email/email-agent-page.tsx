"use client";

import { useState } from "react";
import { CheckCircle2, Mail, MessageCircle } from "lucide-react";

import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
import { AppPageContentRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { SurfaceCard, SurfaceCardContent, SurfaceCardDescription, SurfaceCardHeader, SurfaceCardTitle } from "@/components/app-ui/surfaces";
import {
  EMAIL_AGENT_SETUP_REGION_CLASSNAME,
  EMAIL_AGENT_SETUP_SHELL_CLASSNAME,
} from "@/components/email/email-agent-page-layout";
import { GmailSendAccessCard } from "@/components/gmail/gmail-send-access-card";
import { Button } from "@/lib/morphy-ux/button";

/** Gmail email-agent entry point. OAuth is Firebase-only; chat actions still require VAULT_OWNER. */
export function EmailAgentPage() {
  const agentPopover = useOptionalAgentPopover();
  const [connected, setConnected] = useState(false);
  const openChat = () => {
    const createdAtMs = Date.now();
    agentPopover?.openAgent({
      handoff: {
        id: `email-prompt-${createdAtMs}`,
        reason: "user_requested",
        transcript: "Help me draft an email. I will review and approve it before anything is sent.",
        createdAtMs,
      },
    });
  };

  return (
    <AppPageShell width="reading" className={EMAIL_AGENT_SETUP_SHELL_CLASSNAME}>
      <AppPageContentRegion className={EMAIL_AGENT_SETUP_REGION_CLASSNAME}>
        <SurfaceCard className="w-full overflow-hidden text-center shadow-md">
          <SurfaceCardHeader className="flex flex-col items-center space-y-1 pb-3 pt-5 text-center">
            <div className="mb-2 flex size-11 items-center justify-center rounded-[12px] bg-primary/10 text-primary">
              <Mail className="size-5" aria-hidden />
            </div>
            <SurfaceCardTitle>{connected ? "Gmail connected" : "Connect Gmail"}</SurfaceCardTitle>
            <SurfaceCardDescription>
              {connected
                ? "One can classify receipts and inbox context, then prepare email drafts for your final approval."
                : "Allow One to read email for receipt classification and send only after your confirmation."}
            </SurfaceCardDescription>
          </SurfaceCardHeader>
          <SurfaceCardContent className="pt-0">
            <GmailSendAccessCard
              onConnectionStateChange={setConnected}
              presentation="inline"
            />
            {connected ? (
              <div className="flex flex-col items-center gap-3 pt-4">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="size-4" aria-hidden />
                  Connected
                </span>
                <Button
                  disabled={!agentPopover}
                  onClick={openChat}
                  className="w-full justify-center"
                >
                  <MessageCircle className="size-4" aria-hidden />
                  Try Email Agent with One
                </Button>
              </div>
            ) : null}
          </SurfaceCardContent>
        </SurfaceCard>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
