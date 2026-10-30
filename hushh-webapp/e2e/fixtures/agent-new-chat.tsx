import { createRoot } from "react-dom/client";
import { AgentChatWorkspace } from "../../components/agent/agent-chat-workspace";
import { AgentDockProvider, AgentDockVoiceBoundary } from "../../components/agent/agent-dock";
import { AgentBarSurface } from "../../components/agent/agent-bar-surface";
import { Toaster } from "../../components/ui/sonner";
import { publishValidatedAuthSessionPrincipal } from "../../lib/auth/session-owner";
import { OneModelConnection } from "../../components/agent/one-model-connection";

publishValidatedAuthSessionPrincipal(location.search.includes("anonymous=1") ? null : {
  firebaseUid: "new-chat-test-owner", ownerId: "new-chat-test-owner", accountGeneration: 0,
});
const root = createRoot(document.getElementById("root")!);
if (location.search.includes("model_frame=1")) {
  root.render(<div style={{ width: "min(100%, 340px)" }}><OneModelConnection fullWidth connection={{
    user_id: "new-chat-test-owner", selected_model: null, source: "owner_pod", choices: [],
    effective_provider: "azure_openai", effective_model: "a-long-private-deployment-name", verification: "unverified",
  }} /></div>);
} else root.render(
  <AgentDockProvider>
    <div className="fixed inset-x-0 bottom-0 z-50 p-3">
      <AgentDockVoiceBoundary><AgentBarSurface /></AgentDockVoiceBoundary>
    </div>
    <AgentChatWorkspace />
    <Toaster />
  </AgentDockProvider>,
);
