import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AgentConnectionsDrawer,
  transitionConnectionsDrawer,
  type ConnectionsDrawerMode,
} from "../../components/agent/agent-connections-drawer";
import { OneAgentProfileSheet } from "../../components/agent/one-agent-profile-sheet";
import { appInteractionCoordinator } from "../../lib/interaction/interaction-intent-coordinator";

declare const __ONE_PROFILE_TRIGGER_CLASS__: string;
declare const __ONE_HEADER_IDENTITY_CLASS__: string;
declare const __ONE_HEADER_NAME_CLASS__: string;

import { OnePresenceAvatar, resolveOnePresenceState } from "../../components/agent/one-presence-avatar";
import { DriveRecentSharing } from "../../components/agent/drive-background-search";
import { AgentHistorySidebar } from "../../components/agent/agent-history-sidebar";
import type { AgentChatConversation } from "../../lib/services/agent-chat-client";
import { HistoryConnectorsPage } from "../../components/agent/history-connectors-page";
import { registerChatConnectorRecoveryHost } from "../../lib/agent/drive-oauth-chat-recovery";
import { ProfileConnectorsSection } from "../../components/profile/profile-connectors-section";
import { ShellActionSurface } from "../../components/app-ui/shell-action-surface";
import { AppPageShell } from "../../components/app-ui/app-page-shell";
import { NativeHistoryClose, NativeHistoryOpener } from "../../components/app-ui/native-chat-chrome";
import { SettingsPresentationProvider } from "../../components/profile/settings-ui";
import { SettingsGroup, SettingsRow } from "../../components/app-ui/settings-ui";
import { ProfileAccountResetIcon } from "../../components/profile/profile-your-account-icons";
import accountStyles from "../../components/profile/profile-your-account.module.css";
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
  useEffect(() => registerChatConnectorRecoveryHost({
    prepare: async (request) => {
      const fixtureWindow = window as RecoveryFixtureWindow;
      (fixtureWindow.__driveRecoveryRequests ??= []).push(request);
      return fixtureWindow.__driveRecoveryReadiness ?? "unavailable";
    },
    clear: async () => undefined,
  }), []);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const transcriptRef = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [historyRows, setHistoryRows] = useState<AgentChatConversation[]>([{ id: "public-layout-chat", title: "A weekend idea", status: "active", message_count: 0,
    created_at: null, updated_at: null, last_message_at: (Date.now() - 5 * 60_000) / 1000 }]);
  const historySelections = useRef<string[]>([]);
  const newChatRequests = useRef(0);
  Object.assign(window, {
    __seedChatHistory: (title = "Weekly planning") => setHistoryRows([
      { id: "history-one", title, status: "active", message_count: 2, updated_at: new Date().toISOString() },
      { id: "history-two", title: "Draft email", status: "active", message_count: 1, updated_at: new Date().toISOString() },
    ]),
    __chatHistorySelections: historySelections.current,
    __newChatRequests: () => newChatRequests.current,
  });
  const [gestureEnabled, setGestureEnabled] = useState(true);
  Object.assign(window, { __setHistoryGestureEnabled: setGestureEnabled });
  const [mode, setMode] = useState<ConnectionsDrawerMode>("chats");
  const [external, setExternal] = useState(false);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState(1);
  const [oneProfileOpen, setOneProfileOpen] = useState(false);
  const [onePresenceWork, setOnePresenceWork] = useState(() => ({
    working: new URLSearchParams(window.location.search).get("initial-presence") === "working",
    drafting: false, answering: false, thinking: false,
  }));
  Object.assign(window, { __setOnePresenceWork: setOnePresenceWork });
  const onePresenceState = resolveOnePresenceState(onePresenceWork);
  const oneProfileTrigger = useRef<HTMLButtonElement>(null);
  const changeOpen = (nextOpen: boolean) => {
    const next = transitionConnectionsDrawer(
      { open, mode }, { type: "set-open", open: nextOpen },
    );
    setOpen(next.open);
    setMode(next.mode);
  };
  if (new URLSearchParams(window.location.search).has("reset-icon")) {
    return (
      <main className="profile-pane-scroll-root bg-background p-4 text-foreground">
        <div className={accountStyles.paneAccountContent}>
          <SettingsGroup title="Account actions">
            <SettingsRow icon={ProfileAccountResetIcon} iconTone="capability"
              className="profile-account-reset-row" title="Reset account"
              description="Clears saved details" chevron onClick={() => {}} />
          </SettingsGroup>
        </div>
      </main>
    );
  }
  (window as unknown as { __setOnePresenceLifecycle: typeof appInteractionCoordinator.handleLifecycle }).__setOnePresenceLifecycle = state => appInteractionCoordinator.handleLifecycle(state);
  return (
    <main
      className="relative flex h-dvh flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="agent-chat-header flex h-[var(--agent-chat-header-height)] shrink-0 items-center gap-3 px-[var(--agent-chat-header-inline-gutter)] pt-[var(--agent-chat-header-safe-top)]">
      <NativeHistoryOpener owner="fixture-owner" context="public-layout" eligible open={open}
        pendingAttention={0} showAttentionDot={false} focusRef={triggerRef}
        onActivate={(_, trigger) => {
          if (trigger) triggerRef.current = trigger;
          changeOpen(!open);
        }} />
      {!new URLSearchParams(window.location.search).has("one-profile") ? <button
        className="h-11 shrink-0"
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
      </button> : null}
      {new URLSearchParams(window.location.search).has("one-profile") ? <div className="agent-chat-header" data-one-centered-header="true">
        <div data-agent-chat-header-region="identity" className={__ONE_HEADER_IDENTITY_CLASS__}><div data-agent-chat-brand-tile>
          <ShellActionSurface variant="icon" data-testid="one-presence-header" data-agent-chat-one-profile-trigger
            ripple={false}
            aria-label="Open One profile" ref={oneProfileTrigger} className={__ONE_PROFILE_TRIGGER_CLASS__}
            onClick={() => setOneProfileOpen(true)}>
            <OnePresenceAvatar state={onePresenceState} className="size-8 shrink-0" />
          </ShellActionSurface>
        </div><div className="min-w-0"><div data-one-presence-name className={__ONE_HEADER_NAME_CLASS__}>One</div></div></div>
      </div> : null}
      </header>
      <OneAgentProfileSheet presenceState={onePresenceState} open={oneProfileOpen} onOpenChange={setOneProfileOpen} triggerRef={oneProfileTrigger} />
      <AgentConnectionsDrawer
        gestureSurfaceRef={transcriptRef}
        gestureEnabled={gestureEnabled}
        triggerRef={triggerRef}
        open={open}
        onOpenChange={changeOpen}
        mode={mode}
        externalModalOpen={external}
        chats={
          <AgentHistorySidebar
            driveActivity={location.search.includes("drive-sharing") ? <DriveRecentSharing presentation="sidebar" active={open} /> : undefined}
            conversations={historyRows}
            activeConversationId={historyRows[0]?.id === "history-one" ? "history-one" : null}
            onCreateNew={() => { newChatRequests.current += 1; }}
            onSelectConversation={id => { historySelections.current.push(id); changeOpen(false); }}
            onRenameConversation={() => {}}
            onDeleteConversation={() => {}}
            onClose={() => changeOpen(false)}
            closeControl={<NativeHistoryClose owner="fixture-owner" context="public-layout" onClose={() => changeOpen(false)} />}
            hideCloseButton={false}
            mode="mobile"
            className="h-full w-full"
            onOpenConnectors={trigger => { triggerRef.current = trigger; setMode("connections"); }}
          />
        }
        connections={
          <HistoryConnectorsPage
            native={false}
            owner="fixture-owner"
            context="public-layout"
            open={open && mode === "connections"}
            onBack={() => setMode("chats")}
            onClose={() => changeOpen(false)}
            onExternalModalChange={setExternal}
          />
        }
      />
      <section ref={transcriptRef} inert={open} data-gesture-body className="flex min-h-0 flex-1 touch-pan-y flex-col p-4">
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
// Profile's shipped Connectors section inside its shipped reading-width shell.
Object.assign(window, {
  __renderConnectorsSettingsPage: () => root.render(
    <AppPageShell as="main" width="reading" fitContent>
      <SettingsPresentationProvider density="compact">
        <ProfileConnectorsSection connectorId={null} onConnectorChange={() => undefined} />
      </SettingsPresentationProvider>
    </AppPageShell>
  ),
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
