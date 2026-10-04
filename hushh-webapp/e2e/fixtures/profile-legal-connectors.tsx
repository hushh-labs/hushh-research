import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { ProfilePane } from "../../components/app-ui/profile-pane";
import { ProfileConnectorsLink } from "../../components/profile/profile-connectors-link";
import {
  closeProfilePane,
  openProfilePane,
  profileConnectorsLocation,
  resolveProfilePaneUrlState,
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
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => "");
  const open = resolveProfilePaneUrlState(search).open;
  return (
    <main className="min-h-dvh bg-[color:var(--app-grouped-background)] p-6" data-testid="host-screen">
      <h1 className="ui-text-page-title">Chat</h1>
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
        open={open}
        onOpenChange={(next) => {
          if (!next) closeProfilePane(window.location.pathname, window.location.search);
        }}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Host />);
