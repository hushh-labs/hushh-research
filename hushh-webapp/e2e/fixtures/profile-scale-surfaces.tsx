// Fixture for e2e/profile-scale-surfaces.layout.spec.ts: the surfaces that take
// the Profile type scale outside Connect's own page, mounted from production
// source inside one app page shell. Data flags on <html> pick the variant.
import { createRoot } from "react-dom/client";
import { Lock, Mail } from "lucide-react";

import { AppPageShell } from "../../components/app-ui/app-page-shell";
import { SettingsPresentationProvider } from "../../components/app-ui/settings-ui";
import { FeedActionableRow } from "../../components/feed/feed-actionable-row";
import { OneAgentRoster } from "../../components/dashboard/one-agent-roster";
import { CircleDiscoveryCard } from "../../components/connect/circle-discovery-card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { ONE_CAPABILITIES } from "../../lib/onboarding/one-capabilities";
import type { FeedActionable } from "../../lib/feed/use-feed-actionables";
import type { CapabilityStatus } from "../../lib/services/capability-setup-state-service";

declare global {
  interface Window {
    __events: string[];
  }
}
window.__events = [];
const log = (event: string) => window.__events.push(event);
const flag = (name: string) => document.documentElement.dataset[name] === "1";
const noop = () => {};

const long = flag("long");
const decline = (name: string) => ({
  key: "decline", label: "Decline", tone: "ghost" as const, confirm: true, run: () => log(`decline:${name}`),
});
const confirm = (name: string) => ({
  key: "confirm", label: "Confirm", tone: "primary" as const, run: () => log(`confirm:${name}`),
});
const NAME_ONE = long ? "Ankit Kumar Singh-Featherstonehaugh" : "Ankit Kumar Singh";
const rows: FeedActionable[] = [
  {
    id: "connection:1", icon: Lock, iconTone: "capability", person: { displayName: NAME_ONE, photoUrl: null },
    title: NAME_ONE, description: long ? "Wants to connect and share a very long introduction about why." : "Wants to connect",
    actions: [decline("one"), confirm("one")], sortAt: 5,
  },
  {
    id: "connection:2", icon: Lock, iconTone: "capability", person: { displayName: "Roopmann V", photoUrl: null },
    title: "Roopmann V", description: "Wants to connect", actions: [decline("two"), confirm("two")], sortAt: 4,
  },
  {
    id: "doc:1", icon: Lock, iconTone: "orange", person: { displayName: "Smirthika Dharmalingam", photoUrl: null },
    title: "Smirthika Dharmalingam", description: "Requested a document", onSelect: noop,
    actions: [{ key: "setup-payout", label: "Link payouts", tone: "primary", run: () => log("link-payouts") }], sortAt: 3,
  },
  {
    id: "drive:1", icon: Lock, iconTone: "orange", title: "Payment link expired",
    description: "From Smirthika Dharmalingam · Requested 12 Oct", href: "/one/consents", chevron: true, actions: [], sortAt: 2,
  },
  {
    id: "gmail-needs-reply", icon: Mail, iconTone: "capability",
    title: "10 messages need your reply", description: "", onSelect: noop, chevron: true,
    actions: [{ key: "open-mail", label: "Open Mail", tone: "primary", run: () => log("open-mail") }], sortAt: 1,
  },
];

const statuses: Record<string, CapabilityStatus> = Object.fromEntries(
  ONE_CAPABILITIES.map((capability) => [
    capability.id,
    {
      id: capability.id,
      state: capability.id === "ria" || capability.id === "gmail" ? "in-progress" : "completed",
      pendingCount: 0,
      prerequisite: null,
      requiresUnlock: false,
    } as CapabilityStatus,
  ]),
);
const connections = ["Alex Chen", "Jordan Lee", "Casey Brooks", "Morgan Diaz", "Riley Park"].map((displayName, index) => ({
  connectionId: `c-${index}`, userId: `u-${index}`, displayName, photoUrl: null,
}));

function Fixture() {
  return (
    <AppPageShell as="main" width="reading" data-profile-fixture="">
      <SettingsPresentationProvider density="compact">
        <section aria-label="Needs you" data-testid="fx-feed" className="mb-8">
          <div data-profile-type-scale="" className="divide-y divide-[color:var(--foundation-hairline)]">
            {rows.map((item) => <FeedActionableRow key={item.id} item={item} />)}
          </div>
        </section>
      </SettingsPresentationProvider>
      <div data-testid="fx-agents" className="mb-8">
        <OneAgentRoster capabilityStatusById={statuses} userId={null} />
      </div>
      <div data-testid="fx-circles" data-profile-type-scale="" className="mb-8">
        <CircleDiscoveryCard
          ownerName="Taylor"
          connections={connections as never}
          totalCount={flag("single") ? 1 : 7}
          loading={false}
          error={false}
          snapshot={{ circles: [], loading: false, available: true, error: null } as never}
          creating={null}
          onFindPeople={() => log("find-people")}
          onCreateCircle={noop}
          onUseStarter={noop}
          onOpenCircle={noop}
          onRetry={noop}
          onRetryCircles={noop}
          onSetupCircles={noop}
        />
      </div>
      <AlertDialog open={flag("dialog")}>
        <AlertDialogContent size="sm" data-profile-type-scale="" data-testid="fx-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove connection?</AlertDialogTitle>
            <AlertDialogDescription>Remove Sharu Khan from your connections?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive">Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppPageShell>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
