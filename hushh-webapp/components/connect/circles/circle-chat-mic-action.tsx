"use client";

import { useRouter } from "next/navigation";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Mic } from "@/components/icons";
import { requestAgentConversationAfterRoute } from "@/lib/agent/agent-voice-settings";
import { ROUTES } from "@/lib/navigation/routes";

export function ChatLaneMicAction() {
  const router = useRouter();
  return <ShellActionSurface className="size-11" aria-label="Talk to One" onClick={() => {
    requestAgentConversationAfterRoute(ROUTES.HOME);
    router.push(ROUTES.HOME);
  }}><Mic aria-hidden="true" className="size-5" /></ShellActionSurface>;
}
