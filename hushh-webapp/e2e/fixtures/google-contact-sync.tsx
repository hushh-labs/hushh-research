import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ContactSyncResultsSheet } from "../../components/one-location/contact-sync-results-sheet";
import {
  GoogleContactSyncSessionContext,
  useGoogleContactSync,
  useGoogleContactSyncSession,
} from "../../lib/contacts/use-google-contact-sync-session";

// Only the external consent UI and matching backend are simulated. The browser
// token client, People source, session controller and results sheet are real.
const fixture = globalThis as typeof globalThis & {
  google: unknown;
  contactFixture: {
    syncCalls: number;
    tokenCalls: number;
    activation: boolean[];
    block: (value: boolean) => void;
    consent: (cancelled?: boolean) => void;
  };
};
fixture.contactFixture = {
  syncCalls: 0,
  tokenCalls: 0,
  activation: [],
  block: () => {},
  consent: (cancelled = false) =>
    cancelled
      ? consent.error_callback({ type: "popup_closed" })
      : consent.callback({
          access_token: "fixture-google-token",
          scope: "https://www.googleapis.com/auth/contacts.readonly",
        }),
};
let consent: {
  callback: (value: unknown) => void;
  error_callback: (value: unknown) => void;
};
fixture.google = {
  accounts: {
    oauth2: {
      initTokenClient: (config: typeof consent) => {
        consent = config;
        return {
          requestAccessToken: () => {
            fixture.contactFixture.tokenCalls++;
            fixture.contactFixture.activation.push(
              navigator.userActivation.isActive,
            );
          },
        };
      },
    },
  },
};

function ProtectedRoute() {
  const sync = useGoogleContactSync("fixture-owner");
  const run = () =>
    sync.run({
      routeId: "connect",
      resolveIdToken: async () => "fixture-token",
    });
  return (
    <>
      <h1>Contact sync browser fixture</h1>
      <button onClick={() => void run()}>Find contacts</button>
      <ContactSyncResultsSheet
        open={sync.open}
        onOpenChange={(open) => {
          if (!open) sync.clear();
        }}
        result={sync.result}
        syncing={sync.busy}
        googleSync={sync}
        onSyncAgain={async () => {
          await run();
        }}
        onInvite={async () => {}}
        onRequestConnection={async () => {}}
      />
    </>
  );
}
function App() {
  const [blocked, setBlocked] = useState(false);
  useEffect(() => { fixture.contactFixture.block = setBlocked; }, []);
  const sync = useGoogleContactSyncSession("fixture-owner", "/connect");
  return (
    <GoogleContactSyncSessionContext.Provider
      value={{ owner: "fixture-owner", controller: sync }}
    >
      <main className="p-6">
        {blocked ? <p>Checking session</p> : <ProtectedRoute />}
      </main>
    </GoogleContactSyncSessionContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
