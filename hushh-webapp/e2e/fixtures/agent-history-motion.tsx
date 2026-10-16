import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentConnectionsDrawer } from "../../components/agent/agent-connections-drawer";
import { AgentHistorySidebar } from "../../components/agent/agent-history-sidebar";
import { NativeHistoryClose } from "../../components/app-ui/native-chat-chrome";

// Public motion fixture: retain the real panel, sidebar, gesture and Close
// owners without mounting unrelated connector, agent or provider workflows.
function HistoryMotionFixture() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const transcript = useRef<HTMLElement>(null);
  return <main className="relative flex h-dvh flex-col overflow-hidden bg-background text-foreground">
    <button ref={trigger} onClick={() => setOpen(true)}>Open drawer</button>
    <AgentConnectionsDrawer open={open} onOpenChange={setOpen} mode="chats"
      externalModalOpen={false} triggerRef={trigger} gestureSurfaceRef={transcript}
      gestureEnabled presentationKey="public-motion" connections={null}
      chats={<AgentHistorySidebar mode="mobile" className="h-full w-full"
        conversations={[]} activeConversationId={null} onCreateNew={() => {}}
        onSelectConversation={() => {}} onRenameConversation={() => {}} onDeleteConversation={() => {}}
        onOpenConnectors={() => {}} onClose={() => setOpen(false)}
        closeControl={<NativeHistoryClose owner="synthetic-motion" context="public-motion" onClose={() => setOpen(false)} />} />}
    />
    <section ref={transcript} inert={open} data-gesture-body className="flex min-h-0 flex-1 touch-pan-y flex-col p-4">
      <p>Public conversation</p><input aria-label="Chat draft" />
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<HistoryMotionFixture />);
