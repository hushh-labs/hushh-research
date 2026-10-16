import { createRoot } from "react-dom/client";
import { AgentChatWorkspace } from "../../components/agent/agent-chat-workspace";
import { AgentDockProvider, AgentDockVoiceBoundary } from "../../components/agent/agent-dock";
import { AgentBarSurface } from "../../components/agent/agent-bar-surface";
import { Toaster } from "../../components/ui/sonner";
import { publishValidatedAuthSessionOwner } from "../../lib/auth/session-owner";

publishValidatedAuthSessionOwner(location.search.includes("anonymous=1") ? null : "new-chat-test-owner");
createRoot(document.getElementById("root")!).render(
  <AgentDockProvider>
    <div className="fixed inset-x-0 bottom-0 z-50 p-3">
      <AgentDockVoiceBoundary><AgentBarSurface /></AgentDockVoiceBoundary>
    </div>
    <AgentChatWorkspace />
    <Toaster />
  </AgentDockProvider>,
);
