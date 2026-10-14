import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CalendarConnectedWorkspace } from "../../components/calendar/calendar-connected-workspace";
import { authorizeSyntheticVault, lockSyntheticVault } from "./calendar-connected-boundaries";

/** Synthetic records are supplied by the browser test's Calendar API interceptor. */
function Fixture() {
  const [action, setAction] = useState("");
  return <>
    <div className="fixed inset-x-0 top-0 z-50 flex h-12 items-center justify-center bg-background text-xs text-muted-foreground">Synthetic Calendar QA fixture</div>
    <div data-testid="calendar-scroll-root" className="h-dvh overflow-y-auto pt-16 pb-[var(--app-bottom-content-clearance)]">
      <CalendarConnectedWorkspace userId="synthetic-calendar-owner"
        status={{ configured: true, connected: true, status: "connected", google_email: "qa-owner@example.com", access_level: "manage", scope_csv: "calendar.events calendar.freebusy", calendar_list_access: true }}
        busy={false} getIdToken={async () => "synthetic-firebase-owner-token"} onConnect={access => setAction(`connect:${access}`)}
        onChat={prompt => setAction(prompt ? `calendar-chat:${prompt}` : "calendar-chat")} onDisconnect={() => setAction("disconnect-calendar")} />
    </div>
    <output data-testid="calendar-action" className="sr-only">{action}</output>
    <button data-testid="calendar-fixture-authorize" className="sr-only" onClick={authorizeSyntheticVault}>Synthetic QA shared One authority publication</button>
    <button data-testid="calendar-fixture-lock" className="sr-only" onClick={lockSyntheticVault}>Synthetic QA lock boundary</button>
    <aside data-testid="reserved-bottom-chrome" aria-label="Existing shell clearance fixture" className="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-[820px] flex-col gap-2">
      <div className="flex h-12 items-center rounded-full bg-white px-5 text-sm text-foreground">Talk to One</div>
      <div className="flex h-16 items-center justify-around rounded-full bg-white text-xs text-muted-foreground"><span>Chat</span><span className="text-[color:var(--app-accent)]">One</span><span>Connect</span><span>Feed</span><span>Search</span></div>
    </aside>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
