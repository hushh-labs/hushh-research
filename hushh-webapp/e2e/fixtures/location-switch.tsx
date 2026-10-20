import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Switch } from "../../components/ui/switch";
import { Button } from "../../components/ui/button";
import { RefreshCw } from "../../components/icons";
import { usePageEnterAnimation } from "../../lib/morphy-ux/hooks/use-page-enter";
import { PageHeader } from "../../components/app-ui/page-sections";
import { MapPin } from "lucide-react";
import { LocationHeaderActions, LocationPrimaryShareCard, LocationRequestDurationHeader } from "../../components/one-location/redesign/location-hub-summary";
import { LiveShareStatusCard } from "../../components/one-location/redesign/live-share-status-card";
import { DurationPresetPicker } from "../../components/one-location/redesign/duration-presets";
import {
  LOCATION_HEADER_ACTIONS_CLASSNAME,
  LOCATION_HEADER_STATUS_CLASSNAME,
  LOCATION_HUB_PAGE_HEADER_CLASSNAME,
} from "../../components/one-location/redesign/location-header-layout";

declare const __LOCATION_REFRESH_ROW_CLASSNAME__: string;
declare const __LOCATION_REFRESH_BUTTON_CLASSNAME__: string;

function Fixture() {
  const [checked, setChecked] = useState(
    document.body.dataset.initial === "on",
  );
  const [version, setVersion] = useState(0);
  const [duration, setDuration] = useState("0.25");
  const ref = useRef<HTMLDivElement>(null);
  usePageEnterAnimation(ref);
  if (document.body.dataset.stalePreview) return <main style={{ padding: 16, maxWidth: 768, margin: "auto" }}>
    <section className="overflow-hidden rounded-2xl bg-[color:var(--app-card-surface-default-solid)]">
      <div style={{ height: 208, background: "var(--app-secondary-fill)" }} aria-label="Map preview" />
      <div data-testid="preview-refresh-row" className={__LOCATION_REFRESH_ROW_CLASSNAME__}>
        <Button variant="outline" size="sm" className={__LOCATION_REFRESH_BUTTON_CLASSNAME__}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Ask to refresh
        </Button>
      </div>
    </section>
  </main>;
  if (document.body.dataset.requestDuration) return <main className="app-page-shell" data-app-shell-width="agent">
    <div className="mx-auto w-full max-w-[560px]">
      <LocationRequestDurationHeader />
    </div>
  </main>;
  if (document.body.dataset.compact) return <main className="app-page-shell" data-app-shell-width="agent">
    <PageHeader title="Location" accent="location" titleRole="agent" actionsInlineMobile
      actions={<LocationHeaderActions vm={{ locationEnabled: checked, locationAcquiring: false, locationBlocked: false,
        locationPaused: false, locationAccuracyLimited: false, onShowMyLocation: () => setChecked(true), onHideMyLocation: () => setChecked(false) }} />}
      className="[&>div:first-child]:!gap-2.5 [&_[data-slot=page-header-actions]]:!self-center [&_[data-slot=page-header-row]]:!items-center" />
    <LocationPrimaryShareCard onClick={() => { document.body.dataset.shared = "true"; }} />
    <LiveShareStatusCard status={{ count: 1, grantCount: 1, names: ["Asha"], startedAt: new Date().toISOString(), endsAt: null, stoppableGrantId: "sms-grant", singleGrantIsSms: true }}
      onManage={() => {}} onStop={() => { document.body.dataset.stopped = "true"; }} />
  </main>;
  return (
    <main
      ref={ref}
      style={{ padding: "32px 20px", maxWidth: 880, margin: "auto" }}
    >
      <div key={version}>
        <PageHeader
          title="Location"
          icon={MapPin}
          accent="location"
          actionsInlineMobile
          className={LOCATION_HUB_PAGE_HEADER_CLASSNAME}
          actions={
            <div className={LOCATION_HEADER_ACTIONS_CLASSNAME}>
              <Switch
                size="ios"
                checked={checked}
                onCheckedChange={setChecked}
                aria-label="Location"
              />
              <span className={LOCATION_HEADER_STATUS_CLASSNAME}>
                Location {checked ? "on" : "off"}
              </span>
            </div>
          }
        />
      </div>
      <section style={{ marginTop: 32 }}>
        <p style={{ color: "var(--app-secondary-label)" }}>Step 2 of 2</p>
        <h2 style={{ fontSize: 28, fontWeight: 700, marginBottom: 20 }}>
          Ready to share?
        </h2>
        <div
          data-share-card
          style={{
            padding: 24,
            borderRadius: 24,
            background: "var(--app-primary-surface)",
          }}
        >
          <p id="duration-label" style={{ marginBottom: 10 }}>
            How long
          </p>
          <DurationPresetPicker
            compact
            value={duration}
            onChange={setDuration}
            labelledBy="duration-label"
          />
          <label
            htmlFor="note"
            style={{ display: "block", marginTop: 24, marginBottom: 8 }}
          >
            Optional note
          </label>
          <textarea
            id="note"
            placeholder="On my way to the meeting"
            style={{
              width: "100%",
              minHeight: 92,
              padding: 16,
              border: "1px solid var(--app-separator)",
              borderRadius: 14,
            }}
          />
        </div>
      </section>
      <div data-fixture-tools style={{ marginTop: 24 }}>
        <button onClick={() => setVersion((v) => v + 1)}>
          Remount controls
        </button>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
