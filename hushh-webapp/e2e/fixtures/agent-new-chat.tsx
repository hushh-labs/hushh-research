import { createRoot } from "react-dom/client";
import { AgentChatWorkspace } from "../../components/agent/agent-chat-workspace";
import { AgentDockProvider, AgentDockVoiceBoundary } from "../../components/agent/agent-dock";
import { AgentBarSurface } from "../../components/agent/agent-bar-surface";
import { Toaster } from "../../components/ui/sonner";
import { publishValidatedAuthSessionPrincipal } from "../../lib/auth/session-owner";

publishValidatedAuthSessionPrincipal(location.search.includes("anonymous=1") ? null : {
  firebaseUid: "new-chat-test-owner", ownerId: "new-chat-test-owner", accountGeneration: 0,
});
createRoot(document.getElementById("root")!).render(
  <AgentDockProvider>
    <div className="fixed inset-x-0 bottom-0 z-50 p-3">
      <AgentDockVoiceBoundary><AgentBarSurface /></AgentDockVoiceBoundary>
    </div>
    <AgentChatWorkspace />
    <Toaster />
  </AgentDockProvider>,
);
