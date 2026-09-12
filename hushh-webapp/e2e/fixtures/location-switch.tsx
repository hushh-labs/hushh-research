import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Switch } from "../../components/ui/switch";
import { usePageEnterAnimation } from "../../lib/morphy-ux/hooks/use-page-enter";
import { PageHeader } from "../../components/app-ui/page-sections";
import { MapPin } from "lucide-react";
import { DurationPresetPicker } from "../../components/one-location/redesign/duration-presets";
import {
  LOCATION_HEADER_ACTIONS_CLASSNAME,
  LOCATION_HEADER_STATUS_CLASSNAME,
  LOCATION_HUB_PAGE_HEADER_CLASSNAME,
} from "../../components/one-location/redesign/location-header-layout";

function Fixture() {
  const [checked, setChecked] = useState(
    document.body.dataset.initial === "on",
  );
  const [version, setVersion] = useState(0);
  const [duration, setDuration] = useState("0.25");
  const ref = useRef<HTMLDivElement>(null);
  usePageEnterAnimation(ref);
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
