// Fixture for e2e/settings-row-surface.layout.spec.ts.
//
// Renders the real consumers of the SettingsRow primitive whose click surface
// the founder reported as "a box inside a box": the person profile's
// "Available to request" list (ConsentScopeNestedList), a Profile settings
// screen, a Consent Center list and the chat request card's scope rows
// (ConsentScopeList). Every row action appends to window.__rowEvents so the
// spec can prove WHICH action a click reached, not merely that one did.
//
// LegacySplitRow is a frozen copy of the markup the primitive used to render
// for a row with an interactive trailing control. It is the negative control:
// the spec runs the same contract against it and requires it to FAIL.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bell,
  CaretRightIcon as ChevronRight,
  LockIcon as Lock,
  UserIcon as User,
} from "../../components/icons";
import {
  AdaptiveDetailSurface,
  SettingsGroup,
  SettingsRow,
} from "../../components/app-ui/settings-ui";
import { ConsentScopeNestedList } from "../../components/consent/consent-scope-nested-list";
import { ConsentScopeList } from "../../components/consent/consent-scope-list";
import { Switch } from "../../components/ui/switch";
import { MaterialRipple } from "../../lib/morphy-ux/material-ripple";
import type { ConsentScopeItem } from "../../lib/consent/consent-scope-items";

declare global {
  interface Window {
    __rowEvents: string[];
  }
}
window.__rowEvents = [];
const record = (event: string) => window.__rowEvents.push(event);

function scope(
  domainKey: string,
  domainLabel: string,
  path: string[],
  label: string,
  description?: string,
): ConsentScopeItem {
  return {
    id: `attr.${domainKey}.${path.join(".")}`,
    label,
    description: description ?? null,
    domainKey,
    pathSegments: path,
    domainLabel,
    searchText: `${label} ${description ?? ""} ${domainKey}`.toLowerCase(),
  };
}

const FINANCIAL = [
  "Checking balance",
  "Savings balance",
  "Credit card balance",
  "Monthly income",
  "Monthly spending",
  "Investment holdings",
  "Retirement accounts",
  "Loans",
  "Mortgage",
  "Credit score",
  "Tax filings",
  "Insurance policies",
  "Net worth",
].map((label, index) =>
  scope("financial", "Financial", [`item_${index}`], label),
);

const PERSON_ITEMS: ConsentScopeItem[] = [
  ...FINANCIAL,
  scope("health", "Health", ["steps"], "Daily steps"),
  scope("health", "Health", ["sleep"], "Sleep"),
  scope("health", "Health", ["heart_rate"], "Resting heart rate"),
  scope("location", "Location", ["home"], "Home"),
  scope("location", "Location", ["work"], "Work"),
];

const CHAT_ITEMS: ConsentScopeItem[] = [
  scope("financial", "Financial", ["income"], "Monthly income", "Last 12 months"),
  scope("financial", "Financial", ["spending"], "Monthly spending"),
  scope("location", "Location", ["home"], "Home"),
];

function PersonProfileAvailable() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return (
    <section data-testid="consumer-person-profile" className="space-y-3">
      <h2 className="text-lg font-semibold">Available to request</h2>
      <ConsentScopeNestedList
        items={PERSON_ITEMS}
        rootLabel="All"
        testIdPrefix="person-profile-scope"
        searchThreshold={100}
        selection={{
          selectedIds: selected,
          onToggleMany: (ids, select) => {
            record(`toggle:${ids.length}:${select}`);
            setSelected((current) => {
              const next = new Set(current);
              for (const id of ids) {
                if (select) next.add(id);
                else next.delete(id);
              }
              return next;
            });
          },
        }}
      />
    </section>
  );
}

function ProfileSettings() {
  const [notify, setNotify] = useState(true);
  return (
    <section data-testid="consumer-profile-settings">
      <SettingsGroup title="Account" separatorInset>
        <SettingsRow
          icon={User}
          iconTone="blue"
          title="Personal information"
          description="Name, email and phone"
          chevron
          onClick={() => record("profile:personal")}
          testId="profile-row-personal"
        />
        <SettingsRow
          icon={Bell}
          iconTone="orange"
          title="Notifications"
          description="Requests and reminders"
          chevron
          onClick={() => record("profile:notifications")}
          trailing={
            <Switch
              size="ios"
              checked={notify}
              aria-label="Notifications switch"
              onCheckedChange={(next) => {
                record(`profile:notify:${next}`);
                setNotify(next);
              }}
            />
          }
          testId="profile-row-notifications"
        />
        <SettingsRow
          icon={Lock}
          iconTone="gray"
          title="Vault"
          description="Unlocked on this device"
          trailing="On"
          testId="profile-row-static"
        />
      </SettingsGroup>
    </section>
  );
}

function ConsentCenterList() {
  return (
    <section data-testid="consumer-consent-center">
      <SettingsGroup title="Needs you" separatorInset>
        {[
          { id: "a", name: "Asha Rao", summary: "Wants Monthly income, Home" },
          { id: "b", name: "Ben Ortiz", summary: "Wants Daily steps" },
        ].map((entry) => (
          <SettingsRow
            key={entry.id}
            layout="person"
            leading={
              <span className="inline-flex size-10 items-center justify-center rounded-full bg-[color:var(--app-accent-surface)] text-sm font-semibold">
                {entry.name[0]}
              </span>
            }
            title={entry.name}
            description={entry.summary}
            onClick={() => record(`consent:open:${entry.id}`)}
            ariaLabel={`${entry.name}, review`}
            trailingInteractive
            trailing={
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  className="min-h-11 rounded-full px-3 text-sm font-semibold"
                  onClick={() => record(`consent:deny:${entry.id}`)}
                >
                  Deny
                </button>
                <button
                  type="button"
                  className="min-h-11 rounded-full bg-[color:var(--app-accent)] px-3 text-sm font-semibold text-white"
                  onClick={() => record(`consent:allow:${entry.id}`)}
                >
                  Allow
                </button>
              </span>
            }
            testId={`consent-row-${entry.id}`}
          />
        ))}
        <SettingsRow
          title="History"
          description="Everything you decided"
          chevron
          onClick={() => record("consent:history")}
          testId="consent-row-history"
        />
      </SettingsGroup>
    </section>
  );
}

function ChatRequestCard() {
  return (
    <section
      data-testid="consumer-chat-card"
      className="rounded-[24px] border border-border/60 bg-background/70 p-4"
    >
      <p className="text-sm">To confirm your loan pre-approval.</p>
      <div className="mt-3">
        <ConsentScopeList
          items={CHAT_ITEMS}
          groupByDomain
          collapsible={false}
          testIdPrefix="information-request-review-scopes"
        />
      </div>
    </section>
  );
}

/** Frozen copy of the pre-fix split row. Never import this pattern. */
function LegacySplitRow() {
  const [checked, setChecked] = useState(false);
  return (
    <section data-testid="consumer-legacy">
      <div
        data-slot="settings-group-shell"
        className="relative isolate overflow-hidden rounded-[16px] bg-[color:var(--app-card-surface-default-solid)] [--settings-group-radius:16px]"
      >
        <div
          data-testid="legacy-row"
          className="group/settings-row relative isolate overflow-hidden bg-transparent [--settings-row-py:8px]"
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 z-[1] rounded-[inherit] bg-transparent [@media(hover:hover)]:group-hover/settings-row:bg-foreground/[0.04]"
          />
          <div className="relative z-10 grid w-full grid-cols-[minmax(0,1fr)_fit-content(58%)] items-center gap-x-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <button
              type="button"
              onClick={() => record("legacy:open")}
              className="relative isolate min-h-[56px] min-w-0 rounded-[inherit] bg-transparent px-[var(--settings-row-px)] py-[var(--settings-row-py)] text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <div data-slot="settings-row-title">Financial</div>
              <MaterialRipple variant="none" effect="fade" disableHover className="z-10" />
            </button>
            <div role="presentation">
              <div data-slot="settings-row-trailing" className="flex items-center gap-2.5">
                <span>13</span>
                <input
                  type="checkbox"
                  aria-label="Everything in Financial"
                  checked={checked}
                  onChange={() => {
                    record("legacy:toggle");
                    setChecked((value) => !value);
                  }}
                  className="h-5 w-5"
                />
                <ChevronRight data-slot="settings-row-chevron" className="h-4 w-4" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function DetailTarget() {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button type="button" onClick={() => setOpen(true)}>Open detail target</button>
      <AdaptiveDetailSurface
        open={open}
        onOpenChange={setOpen}
        title="Request details"
        mobilePresentation="fullscreen"
      >
        <p>Review this synthetic request.</p>
      </AdaptiveDetailSurface>
    </section>
  );
}

function Fixture() {
  return (
    <main className="min-h-dvh space-y-8 bg-[color:var(--app-grouped-background,var(--background))] p-4 text-foreground">
      <PersonProfileAvailable />
      <ProfileSettings />
      <ConsentCenterList />
      <ChatRequestCard />
      <LegacySplitRow />
      <DetailTarget />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
