import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentCalendarProposalCard } from "../../components/agent/agent-calendar-proposal-card";
import { CalendarConnectedWorkspace } from "../../components/calendar/calendar-connected-workspace";
import { authorizeSyntheticVault, lockSyntheticVault } from "./calendar-connected-boundaries";

/** Synthetic records are supplied by the browser test's Calendar API interceptor. */
function Fixture() {
  const [action, setAction] = useState("");
  const [proposal, setProposal] = useState(false);
  const [busy, setBusy] = useState(false);
  const board = new URLSearchParams(location.search).has("board");
  const boardAccounts = ["qa-owner@example.com", "qa-work@example.com", "qa-projects@example.com"]
    .map((google_email, index) => ({ account_id: index === 0 ? "default" : index === 1 ? "work" : "projects", google_email, status: "connected" as const, connected: true, access_level: "manage" as const, calendar_list_access: true }));
  return <>
    <div className="fixed inset-x-0 top-0 z-50 flex h-12 items-center justify-center bg-background text-xs text-muted-foreground">{location.search.includes("providerReplay=1") ? "Explorer-backed local replay · sanitized dates · not live UAT" : "Synthetic Calendar QA fixture"}</div>
    <div data-testid="calendar-scroll-root" className="h-dvh overflow-y-auto pt-16 pb-[var(--app-bottom-content-clearance)]">
      {proposal ? <div className="mx-auto max-w-[820px] px-4">
        <p className="mb-4">Who should join?</p>
        <AgentCalendarProposalCard action="create" title="Meeting with QA attendee" startAt="2030-01-17T08:30:00Z" endAt="2030-01-17T09:00:00Z" timeZone="Asia/Kolkata" attendees={["long-calendar-attendee-for-responsive-verification@example.test"]} location={null} sendUpdates googleMeet conflicts={[]} confirmLabel="Schedule meeting" busy={busy} timeOptions={["2030-01-17T08:30:00Z", "2030-01-17T08:45:00Z"]} onChangeTime={start => setAction(`change-time:${start}`)} onConfirm={() => { setBusy(true); setAction("confirmed-once"); }} onCancel={() => setAction("cancelled-without-event")} />
      </div> : <CalendarConnectedWorkspace userId="synthetic-calendar-owner"
        status={{ configured: true, connected: true, status: "connected", google_email: "qa-owner@example.com", access_level: "manage", scope_csv: "calendar.events calendar.freebusy", calendar_list_access: true, ...(board ? { accounts: boardAccounts, account_limit: 3 } : {}) }}
        busy={false} getIdToken={async () => "synthetic-firebase-owner-token"} onConnect={access => setAction(`connect:${access}`)}
        onAddAccount={board ? () => setAction("add-account") : undefined}
        onReconnectAccount={board ? accountId => setAction(`reconnect:${accountId}`) : undefined}
        onDisconnectAccount={board ? accountId => setAction(`disconnect:${accountId}`) : undefined}
        onChat={(prompt, slot, _invitation, attendance) => { if (attendance) { void attendance.outcome.then(outcome => setAction("result" in outcome ? `calendar-email:${outcome.result.email}` : `calendar-error:${outcome.error}`)); return; } setAction(slot ? `calendar-slot:${JSON.stringify(slot)}` : prompt ? `calendar-chat:${prompt}` : "calendar-chat"); }} onDisconnect={() => setAction("disconnect-calendar")} />}
    </div>
    <button data-testid="calendar-fixture-proposal" className="sr-only" onClick={() => setProposal(true)}>Synthetic proposal preview</button>
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
