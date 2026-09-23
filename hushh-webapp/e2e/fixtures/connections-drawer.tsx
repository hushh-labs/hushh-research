import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AgentConnectionsDrawer,
  type ConnectionsDrawerMode,
} from "../../components/agent/agent-connections-drawer";
import { AgentHistorySidebar } from "../../components/agent/agent-history-sidebar";
import { ConnectorsPanel } from "../../components/agent/connectors-panel";
import { ConnectorReadReceipt } from "../../components/agent/connector-read-receipt";

type RecoveryFixtureWindow = Window & {
  __driveRecoveryReadiness?: "busy" | "unavailable";
  __driveRecoveryRequests?: { attemptId: string; reason: string }[];
};

// Fake only Google's external UI; exercise the actual Picker adapter and its
// real DOM focus interaction with the mounted production drawer.
class DocsView {
  setMimeTypes() {
    return this;
  }
  setIncludeFolders() {
    return this;
  }
}
class PickerBuilder {
  callback: (value: unknown) => void = () => {};
  addView() {
    return this;
  }
  enableFeature() {
    return this;
  }
  setOAuthToken() {
    return this;
  }
  setDeveloperKey() {
    return this;
  }
  setAppId() {
    return this;
  }
  setOrigin() {
    return this;
  }
  setSize() {
    return this;
  }
  setCallback(callback: (value: unknown) => void) {
    this.callback = callback;
    return this;
  }
  build() {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "Synthetic Google Picker");
    dialog.style.cssText =
      "position:fixed;inset:16px;z-index:2000;background:var(--background);padding:24px;border:1px solid";
    const choose = document.createElement("button");
    choose.textContent = "Pick synthetic file";
    choose.onclick = () =>
      this.callback({
        action: "picked",
        docs: [
          { id: "synthetic-file", name: "<script>untrusted filename</script>" },
        ],
      });
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel Picker";
    cancel.onclick = () => this.callback({ action: "cancel" });
    dialog.append(choose, cancel);
    dialog.onkeydown = (event) => {
      if (event.key === "Escape") this.callback({ action: "cancel" });
    };
    return {
      setVisible: () => {
        document.body.append(dialog);
        choose.focus();
      },
      dispose: () => dialog.remove(),
    };
  }
}
Object.assign(window, {
  google: {
    picker: {
      DocsView,
      PickerBuilder,
      Feature: { MULTISELECT_ENABLED: "multi" },
      Action: { PICKED: "picked", CANCEL: "cancel" },
    },
  },
});

function Fixture() {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ConnectionsDrawerMode>("chats");
  const [available, setAvailable] = useState(false);
  const [external, setExternal] = useState(false);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState(1);
  return (
    <main
      className="relative flex h-dvh flex-col overflow-hidden bg-background text-foreground"
      style={{ "--agent-chat-header-height": "56px" } as React.CSSProperties}
    >
      <button
        ref={triggerRef}
        className="h-14 shrink-0"
        onClick={(event) => { triggerRef.current = event.currentTarget; setOpen(!open); }}
      >
        Open drawer
      </button>
      <AgentConnectionsDrawer
        triggerRef={triggerRef}
        open={open}
        onOpenChange={setOpen}
        mode={mode}
        externalModalOpen={external}
        chats={
          <AgentHistorySidebar
            conversations={[]}
            activeConversationId={null}
            onCreateNew={() => {}}
            onSelectConversation={() => {}}
            onRenameConversation={() => {}}
            onDeleteConversation={() => {}}
            hideCloseButton
            mode="mobile"
            className="h-full w-full"
            onOpenConnectors={
              available ? () => setMode("connections") : undefined
            }
          />
        }
        connections={
          <ConnectorsPanel
            open={open && mode === "connections"}
            onBack={() => setMode("chats")}
            onClose={() => { setOpen(false); setMode("chats"); }}
            onAvailableChange={setAvailable}
            onExternalModalChange={setExternal}
            onPrepareRecovery={async (request) => {
              const fixtureWindow = window as RecoveryFixtureWindow;
              (fixtureWindow.__driveRecoveryRequests ??= []).push(request);
              return fixtureWindow.__driveRecoveryReadiness ?? "unavailable";
            }}
            onClearRecovery={async () => undefined}
          />
        }
      />
      <section inert={open} className="flex min-h-0 flex-1 flex-col p-4">
        <ConnectorReadReceipt experience={{ type: "one.connector_read.v1", connector: "mail",
          status: "reconnect_required", sourceRefs: [], truncated: false, metadataOnly: true }}
          onOpenConnections={(trigger) => { triggerRef.current = trigger; setMode("connections"); setOpen(true); }} />
        <p>Conversation one</p>
        <p data-testid="stream">Streaming turn {turns}</p>
        <button onClick={() => setTurns(turns + 1)}>
          Advance synthetic stream
        </button>
        <textarea
          aria-label="Chat draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
