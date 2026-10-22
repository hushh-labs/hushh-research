import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";

import { ProfilePane } from "../../components/app-ui/profile-pane";
import { ProfileConnectorsLink } from "../../components/profile/profile-connectors-link";
import { ConnectorReadReceipt } from "../../components/agent/connector-read-receipt";
import { useAuth } from "@/hooks/use-auth";
import {
  closeProfilePane,
  openProfilePane,
  profileConnectorsLocation,
  resolveProfilePaneUrlState,
  PROFILE_PANE_OPEN_EVENT,
  type ProfilePaneOpenDetail,
} from "../../lib/navigation/profile-pane";

function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}

/**
 * The screen under the pane, with the entry points that open Connectors from
 * outside Profile: a Drive card's reconnect link (production component) and
 * chat's "Open connectors" (the exact call the chat workspace makes).
 */
function Host() {
  const [draft, setDraft] = useState("");
  const { user } = useAuth();
  const owner = user?.uid ?? null;
  const returnFocus = useRef<{ owner: string | null; target: HTMLElement } | null>(null);
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => "");
  const open = resolveProfilePaneUrlState(search).open;
  // The fixture stands in for the existing shell event owner, including its
  // explicit owner-bound return target and selected destination.
  useEffect(() => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<ProfilePaneOpenDetail>).detail;
      if (open) { detail.onResult?.("already_open"); return; }
      returnFocus.current = detail.returnFocus?.isConnected ? { owner, target: detail.returnFocus } : null;
      openProfilePane(window.location.pathname, window.location.search,
        detail.destination?.location, { returnsToOrigin: detail.destination?.returnsToOrigin });
      detail.onResult?.("opening");
    };
    window.addEventListener(PROFILE_PANE_OPEN_EVENT, handle);
    return () => window.removeEventListener(PROFILE_PANE_OPEN_EVENT, handle);
  }, [open, owner]);
  return (
    <main className="min-h-dvh bg-[color:var(--app-grouped-background)] p-6" data-testid="host-screen">
      <h1 className="ui-text-page-title">Chat</h1>
      <textarea aria-label="Chat draft" value={draft} onChange={event => setDraft(event.target.value)} />
      <p data-testid="stream">Streaming turn 1</p>
      <ConnectorReadReceipt experience={{ type: "one.connector_read.v1", connector: "mail",
        status: "reconnect_required", sourceRefs: [], truncated: false, metadataOnly: true }}
        onOpenConnections={(_, trigger) => openProfilePane(window.location.pathname, window.location.search,
          profileConnectorsLocation("gmail"), { returnsToOrigin: true, returnFocus: trigger })} />
      <div className="mt-4 flex flex-col gap-3">
        <ProfileConnectorsLink connectorId="google_drive" data-testid="drive-card-reconnect">
          Reconnect Google Drive
        </ProfileConnectorsLink>
        <button
          type="button"
          data-testid="chat-open-connectors"
          onClick={() =>
            openProfilePane(
              window.location.pathname,
              window.location.search,
              profileConnectorsLocation(null),
              { returnsToOrigin: true },
            )
          }
        >
          Open connectors
        </button>
        <button
          type="button"
          data-testid="open-profile"
          onClick={() => openProfilePane(window.location.pathname, window.location.search)}
        >
          Profile
        </button>
      </div>
      <ProfilePane
        owner={owner}
        returnFocusRef={returnFocus}
        open={open}
        onOpenChange={(next) => {
          if (!next) closeProfilePane(window.location.pathname, window.location.search);
        }}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<ThemeProvider attribute="class" defaultTheme="system"><Host /></ThemeProvider>);
