import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentConnectionsDrawer } from "../../components/agent/agent-connections-drawer";
import { AgentHistorySidebar } from "../../components/agent/agent-history-sidebar";

// Real drawer, sidebar, gesture and production CSS; no profile/connector fixture
// or account runtime is needed to measure this owned motion boundary.
function HistoryMotionFixture() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const transcript = useRef<HTMLElement>(null);
  return <main className="relative flex h-dvh flex-col overflow-hidden bg-background text-foreground">
    <header className="agent-chat-header flex h-14 shrink-0 items-center">
      <button ref={trigger} className="h-11" onClick={() => setOpen(true)}>Open drawer</button>
    </header>
    <AgentConnectionsDrawer open={open} onOpenChange={setOpen} mode="chats" externalModalOpen={false}
      triggerRef={trigger} gestureSurfaceRef={transcript} gestureEnabled connections={null}
      chats={<AgentHistorySidebar conversations={[{ id: "public-layout-chat", title: "A weekend idea", status: "active", message_count: 0, created_at: null, updated_at: null, last_message_at: (Date.now() - 5 * 60_000) / 1000 }]} activeConversationId={null}
        onCreateNew={() => {}} onSelectConversation={() => {}} onRenameConversation={() => {}}
        onDeleteConversation={() => {}} onClose={() => setOpen(false)} mode="mobile"
        className="h-full w-full" onOpenConnectors={() => {}} />} />
    <section ref={transcript} inert={open} data-gesture-body className="flex min-h-0 flex-1 touch-pan-y flex-col p-4">
      <p>Synthetic conversation</p><textarea aria-label="Chat draft" />
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<HistoryMotionFixture />);
