import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AgentConnectionsDrawer,
  transitionConnectionsDrawer,
  type ConnectionsDrawerMode,
} from "../../components/agent/agent-connections-drawer";
import { AgentHistorySidebar } from "../../components/agent/agent-history-sidebar";
import { ConnectorsPanel } from "../../components/agent/connectors-panel";
import { ConnectorReadReceipt } from "../../components/agent/connector-read-receipt";
import ExternalConnectorsPage from "../../app/one/profile/connectors/page";
import {
  readGoogleOAuthPopupAttempt,
  settleGoogleOAuthPopup,
} from "../../lib/google/google-oauth-popup";
import {
  clearGmailOAuthPopupAttempt,
  notifyGmailOAuthPopupOpener,
  notifyGmailOAuthPopupOpenerFallback,
  readGmailOAuthPopupAttempt,
} from "../../lib/profile/gmail-oauth-popup";
import {
  connectCalendarInPlace,
  connectGmailInPlace,
  inPlaceConnectCopy,
} from "../../lib/connections/google-connect-in-place";
import { OAUTH_WINDOW_BLOCKED_COPY } from "../../lib/connections/oauth-window";
import { useInPlaceConnect } from "../../lib/connections/use-in-place-connect";
import {
  EmailDeliveryHistoryCard,
  type EmailDeliveryHistoryItem,
} from "../../components/agent/email-delivery-history-card";
import { SpecialistDirectiveCard } from "../../components/agent/specialist-directive-card";

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

const chatOwner = { uid: "fixture-owner", getIdToken: async () => "synthetic-firebase" };
const failedDelivery: EmailDeliveryHistoryItem = {
  id: "delivery-1",
  instruction: "Email Sam the plan",
  draft: { to: "sam@synthetic.invalid", cc: "", bcc: "", subject: "The plan", body: "Draft body" },
  status: "failed",
  errorCode: "GMAIL_SEND_DISABLED",
  errorMessage: "Enable Gmail sending to send this.",
};

/**
 * The shipped in-chat cards, driven by the shipped in-place connector and its
 * hook. Only the outcome handling below mirrors agent-chat-workspace.tsx,
 * which cannot be mounted standalone.
 */
function ChatConnectCards() {
  const send = useInPlaceConnect();
  const directive = useInPlaceConnect();
  const [notice, setNotice] = useState("");
  const [reopened, setReopened] = useState<string | null>(null);
  const [directiveOpen, setDirectiveOpen] = useState(true);
  return (
    <section aria-label="Chat connect cards">
      <EmailDeliveryHistoryCard
        item={failedDelivery}
        enablingGmailSend={send.pending?.key === failedDelivery.id}
        onCancelEnableGmailSend={send.pending?.cancellable ? send.cancel : undefined}
        onEnableGmailSend={(item) => {
          const started = send.start(
            item.id,
            (controls) => connectGmailInPlace({ owner: chatOwner, purpose: "send", ...controls }),
            (outcome, { cancelled }) => {
              if (outcome === "connected") setReopened(item.draft.subject);
              if (!cancelled) setNotice(inPlaceConnectCopy("gmail_send", outcome));
            },
          );
          if (started === "blocked") setNotice(OAUTH_WINDOW_BLOCKED_COPY);
        }}
      />
      {reopened ? <p>Draft reopened for review: {reopened}</p> : null}
      {directiveOpen ? (
        <SpecialistDirectiveCard
          summary="Allow One to schedule on your Google Calendar."
          confirmLabel="Allow Calendar scheduling"
          busy={Boolean(directive.pending)}
          busyLabel={directive.pending?.cancellable ? "Waiting for Google…" : undefined}
          cancelWhileBusy={directive.pending?.cancellable === true}
          onConfirm={() => {
            const started = directive.start(
              "calendar",
              (controls) => connectCalendarInPlace({ owner: chatOwner, accessLevel: "manage", ...controls }),
              (outcome, { cancelled }) => {
                if (cancelled) return;
                if (outcome === "connected") setDirectiveOpen(false);
                setNotice(inPlaceConnectCopy("calendar", outcome));
              },
            );
            if (started === "blocked") setNotice(OAUTH_WINDOW_BLOCKED_COPY);
          }}
          onCancel={() => {
            directive.cancel();
            setDirectiveOpen(false);
            setNotice("Calendar change cancelled. Nothing was changed.");
          }}
        />
      ) : null}
      <p data-testid="chat-connect-notice">{notice}</p>
    </section>
  );
}

function Fixture() {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ConnectionsDrawerMode>("chats");
  const [external, setExternal] = useState(false);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState(1);
  const changeOpen = (nextOpen: boolean) => {
    const next = transitionConnectionsDrawer(
      { open, mode }, { type: "set-open", open: nextOpen },
    );
    setOpen(next.open);
    setMode(next.mode);
  };
  return (
    <main
      className="relative flex h-dvh flex-col overflow-hidden bg-background text-foreground"
      style={{ "--agent-chat-header-height": "56px" } as React.CSSProperties}
    >
      <button
        ref={triggerRef}
        className="h-14 shrink-0"
        onClick={(event) => {
          triggerRef.current = event.currentTarget;
          const next = transitionConnectionsDrawer(
            { open, mode }, { type: "toggle-chats" },
          );
          setOpen(next.open);
          setMode(next.mode);
        }}
      >
        Open drawer
      </button>
      <AgentConnectionsDrawer
        triggerRef={triggerRef}
        open={open}
        onOpenChange={changeOpen}
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
            onClose={() => changeOpen(false)}
            hideCloseButton={false}
            mode="mobile"
            className="h-full w-full"
            onOpenConnectors={() => setMode("connections")}
          />
        }
        connections={
          <ConnectorsPanel
            open={open && mode === "connections"}
            onBack={() => setMode("chats")}
            onClose={() => changeOpen(false)}
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
          onOpenConnections={(_provider, trigger) => { triggerRef.current = trigger; setMode("connections"); setOpen(true); }} />
        <ChatConnectCards />
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
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
// The shipped Profile > Connectors route, mounted in place of the chat fixture.
Object.assign(window, {
  __renderConnectorsSettingsPage: () => root.render(<ExternalConnectorsPage />),
});
// The Gmail callback's settlement, built from the same exported helpers the
// real /one/profile/gmail/oauth/return page uses.
Object.assign(window, {
  __settleGmailOAuthCallback: (outcome: "succeeded" | "cancelled" | "failed") => {
    const attempt = readGmailOAuthPopupAttempt();
    if (!attempt) return false;
    const settlement = { schemaVersion: 1 as const, type: "gmail_oauth_settlement" as const, attemptId: attempt.attemptId, outcome };
    notifyGmailOAuthPopupOpener(settlement);
    notifyGmailOAuthPopupOpenerFallback(settlement);
    clearGmailOAuthPopupAttempt();
    window.setTimeout(() => window.close(), 0);
    return true;
  },
});
// The production callback-side settlement, so a synthetic Google return page
// settles through the exact code the real /one/profile/google/oauth/return uses.
Object.assign(window, {
  __settleGoogleOAuthCallback: (outcome: "succeeded" | "cancelled" | "failed") => {
    const attempt = readGoogleOAuthPopupAttempt();
    if (!attempt) return false;
    settleGoogleOAuthPopup(attempt, outcome);
    return true;
  },
});
