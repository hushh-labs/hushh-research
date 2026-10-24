import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../lib/morphy-ux/button";
import {
  SettingsGroup,
  SettingsPresentationProvider,
  SettingsRow,
} from "../../components/app-ui/settings-ui";
import {
  bundleEntryToOpen,
  ConsentPendingRequestRow,
  pendingBundleSummary,
} from "../../components/consent/consent-pending-row";
import { consentEntryInformationLabel } from "../../lib/consent/consent-owner-copy";
import { bundleAllowLabel, ConsentBundleChoice } from "../../components/consent/consent-bundle-choice";
import profileAccountStyles from "../../components/profile/profile-your-account.module.css";
import type { ConsentCenterEntry } from "../../lib/services/consent-center-service";

/**
 * The Consent Center's Requests rows, from the production row component. The
 * spec measures them and drives them; every tap is recorded on <body> so the
 * spec can tell a row open from a decision.
 */
function record(kind: "opened" | "decided", value: string) {
  document.body.dataset[kind] = value;
}

function single(
  id: string,
  label: string,
  scope: string,
  description: string,
  email?: string,
): ConsentCenterEntry {
  return {
    id,
    request_id: id,
    kind: "incoming_request",
    status: "pending",
    action: "REQUESTED",
    allowed_next_action: "review_request",
    scope,
    scope_description: description,
    counterpart_type: "person",
    counterpart_id: `user-${id}`,
    counterpart_label: label,
    counterpart_email: email ?? null,
    metadata: { expiry_hours: 168 },
  };
}

function bundle(id: string, complete: boolean): ConsentCenterEntry {
  return {
    id: `bundle:${id}`,
    bundle_id: id,
    bundle_complete: complete,
    bundle_items: Array.from({ length: 12 }, (_, index) => ({
      request_id: `${id}-${index + 1}`,
      label: `Professional detail ${index + 1}`,
      status: index < 2 ? "granted" : "pending",
      entry:
        index < 2
          ? null
          : {
              ...single(`${id}-${index + 1}`, "A member", `attr.professional.detail_${index + 1}`, `Professional detail ${index + 1}`),
              metadata: { bundle_id: id, expiry_hours: 24 },
            },
    })),
    kind: "incoming_request",
    status: "pending",
    action: "REQUESTED",
    counterpart_type: "person",
    counterpart_label: complete ? "A member" : "Someone still sending",
    metadata: { bundle_id: id },
  };
}

const ROWS: Array<{ entry: ConsentCenterEntry; decides: boolean }> = [
  { entry: single("food", "Kushal Trivedi", "attr.food.preferences.*", "Preferences", "kushal@example.com"), decides: true },
  { entry: single("tax", "Manish Sainani Venkataraman Subramaniam", "attr.financial.tax_record.*", "Tax record"), decides: true },
  { entry: bundle("professional", true), decides: true },
  { entry: bundle("arriving", false), decides: false },
  { entry: single("location", "Smirthika Dharmalingam", "one_location.live", "Live location"), decides: false },
];

/** The sheet's per-item choice on a grouped request (R5), as the sheet draws it. */
const CHOICE_ITEMS = [
  { key: "request-food", label: "Food preferences" },
  { key: "request-events", label: "Financial events from the 2025 federal tax return and brokerage statements" },
];

function BundleChoiceFixture() {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(CHOICE_ITEMS.map((item) => item.key)));
  const count = CHOICE_ITEMS.filter((item) => chosen.has(item.key)).length;
  return (
    <section data-testid="bundle-choice-fixture" className="mt-6 px-4">
      <dl className="grid gap-x-6 gap-y-4 px-1 py-1 sm:grid-cols-2">
        <ConsentBundleChoice items={CHOICE_ITEMS} chosen={chosen} onToggle={(key, include) => setChosen((current) => {
          const next = new Set(current);
          if (include) next.add(key);
          else next.delete(key);
          return next;
        })} />
      </dl>
      <p data-testid="bundle-choice-allow">{bundleAllowLabel(CHOICE_ITEMS.length, count)}</p>
    </section>
  );
}

function Fixture() {
  return (
    <main className="app-page-shell min-h-dvh bg-background py-4 text-foreground" data-app-density="compact" data-app-surface="one" data-consent-presentation="workspace">
      <div className="mx-auto max-w-[var(--app-page-max-w-reading,720px)]">
        <SettingsPresentationProvider density="compact">
          <SettingsGroup embedded separatorInset>
            {ROWS.map(({ entry, decides }) => {
              const toOpen = entry.bundle_items ? bundleEntryToOpen(entry) : entry;
              return (
                <ConsentPendingRequestRow
                  key={entry.id}
                  entry={entry}
                  summary={entry.bundle_items ? pendingBundleSummary(entry) : consentEntryInformationLabel(entry)}
                  selected={false}
                  onOpen={toOpen ? () => record("opened", entry.id) : undefined}
                  decision={
                    decides
                      ? {
                          onAllow: () => record("decided", `allow:${entry.id}`),
                          onDecline: () => record("decided", `decline:${entry.id}`),
                        }
                      : null
                  }
                  fallbackTrailing={
                    !decides && !entry.bundle_items ? <Badge className="shrink-0">Pending</Badge> : undefined
                  }
                />
              );
            })}
          </SettingsGroup>
        </SettingsPresentationProvider>
        <BundleChoiceFixture />
        <div className="px-4 py-3">
          <Button variant="none" effect="fade" size="sm" data-consent-quiet-action="true" data-testid="consent-quiet-action" onClick={() => record("opened", "payment")}>Review payment</Button>
        </div>
      </div>
      <section className="profile-pane-scroll-root mt-6" data-testid="consent-profile-composition">
        <div className="app-page-shell" data-profile-type-scale="account">
          <div data-profile-stack-content="true" className={profileAccountStyles.walletContent}>
            <SettingsGroup className="consent-presentation-surface" title="Information access" description="Purchase balance and earnings">
              <SettingsRow title="Payments and earnings" description="Sharing status stays available"
                trailing={<span className="profile-account-inline-action">Review receipt</span>} />
            </SettingsGroup>
          </div>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
