"use client";
import { OnboardingStepper } from "@/components/app-ui/onboarding-stepper";
import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";
import { SectionLabel } from "@/components/app-ui/typography";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { financeSections } from "@/lib/finance-sharing/contract";
import {
  sharingSteps,
  type EditStep,
  type FinanceShareFlowModel,
  type FinanceShareUpdate,
} from "./use-finance-share-flow";
import { FinanceSharePeople } from "./finance-share-people";
import styles from "./finance-sharing.module.css";
const sectionLabel = {
  allocation: "Allocation",
  performance: "Performance",
  holdings: "Selected stocks",
  note: "Your note",
};
export function FinanceShareEditor({
  flow,
  initialShare,
}: {
  flow: FinanceShareFlowModel;
  initialShare?: FinanceShareUpdate;
}) {
  const {
    editIndex,
    availableSteps,
    tabSetId,
    editStep,
    busy,
    ready,
    pendingConfirmation,
    inFlight,
    changeEditStep,
    optionsHeading,
    accessHeading,
    selection,
    setSelection,
    chooseSection,
    choices,
    allStocksSelected,
    mode,
    setMode,
    allAdvisors,
    duration,
    setDurationChoice,
    durationChoice,
    customUnit,
    customValue,
    durationValid,
    setCustomValue,
    setCustomUnit,
    expiryAllowed,
  } = flow;
  const modeButtons = (
    <div className={styles.mode}>
      <button
        aria-pressed={mode === "snapshot"}
        onClick={() => {
          setMode("snapshot");
          if (!allAdvisors && duration === null) setDurationChoice("86400");
        }}
      >
        Snapshot
        <MaterialRipple variant="none" effect="fade" className="z-10" />
      </button>
      <button
        aria-pressed={mode === "ongoing"}
        onClick={() => setMode("ongoing")}
      >
        Real time
        <MaterialRipple variant="none" effect="fade" className="z-10" />
      </button>
    </div>
  );
  return (
    <div className={styles.editLayout}>
      <OnboardingStepper
        steps={sharingSteps.map((item) => ({
          id: item.value,
          label: item.label,
        }))}
        currentIndex={editIndex}
        showLabel={false}
        ariaLabel="Sharing steps"
      />
      <SwipeViews
        options={availableSteps}
        tabSetId={tabSetId}
        activeValue={editStep}
        disabled={busy || !ready || Boolean(pendingConfirmation)}
        onSelectionChange={(value) => {
          if (
            !inFlight.current &&
            availableSteps.some((item) => item.value === value)
          )
            changeEditStep(value as EditStep);
        }}
        viewportMinHeight="0px"
        className={styles.pager}
      >
        <FinanceSharePeople flow={flow} initialShare={initialShare} />
        <section className={`${styles.group} ${styles.optionGroup}`}>
          <SectionLabel
            id={`top-shell-${tabSetId}-tab-sections`}
            ref={optionsHeading}
            tabIndex={-1}
            role="heading"
            aria-level={2}
            className={styles.heading}
          >
            What do you want to share?
          </SectionLabel>
          <div className={styles.optionBody}>
            {financeSections.map((section) => (
              <label className={styles.choice} key={section}>
                <input
                  type="checkbox"
                  checked={selection.sections.includes(section)}
                  onChange={(e) => chooseSection(section, e.target.checked)}
                />
                <span>{sectionLabel[section]}</span>
              </label>
            ))}
            {selection.sections.includes("holdings") ? (
              <fieldset className="motion-step-enter mt-3 border-t border-border pt-3">
                <legend className={styles.caption}>Choose stocks</legend>
                <ShellActionSurface
                  variant="pill"
                  className="mb-2 min-h-9"
                  onClick={() =>
                    setSelection((s) => ({
                      ...s,
                      holdingSymbols: allStocksSelected
                        ? []
                        : choices.map((p) => p.tickerSymbol!),
                    }))
                  }
                >
                  {allStocksSelected ? "Clear all" : "Select all"}
                </ShellActionSurface>
                {choices.map((p) => (
                  <label key={p.id} className={styles.choice}>
                    <input
                      type="checkbox"
                      checked={selection.holdingSymbols.includes(
                        p.tickerSymbol!,
                      )}
                      onChange={(e) =>
                        setSelection((s) => ({
                          ...s,
                          holdingSymbols: e.target.checked
                            ? [...s.holdingSymbols, p.tickerSymbol!]
                            : s.holdingSymbols.filter(
                                (v) => v !== p.tickerSymbol,
                              ),
                        }))
                      }
                    />
                    <span>
                      {p.tickerSymbol}
                      <small>{p.name}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            {selection.sections.includes("note") ? (
              <label className="motion-step-enter mt-3 block text-sm">
                Your note
                <Textarea
                  className="mt-2"
                  value={selection.note}
                  maxLength={1000}
                  placeholder="Add context for your connection"
                  onChange={(e) =>
                    setSelection((s) => ({ ...s, note: e.target.value }))
                  }
                />
              </label>
            ) : null}
          </div>
        </section>
        <section className={`${styles.group} ${styles.optionGroup}`}>
          <SectionLabel
            id={`top-shell-${tabSetId}-tab-access`}
            ref={accessHeading}
            tabIndex={-1}
            role="heading"
            aria-level={2}
            className={styles.heading}
          >
            Access
          </SectionLabel>
          <div className={styles.optionBody}>
            {modeButtons}
            <label className="mt-5 block text-sm">
              Access ends
              <select
                className="mt-2 min-h-11 w-full rounded-full border border-input bg-background px-4"
                value={durationChoice}
                onChange={(e) => setDurationChoice(e.target.value)}
              >
                <option value="3600">In 1 hour</option>
                <option value="86400">In 1 day</option>
                <option value="604800">In 7 days</option>
                <option value="custom">Custom duration</option>
                {allAdvisors ? (
                  <option value="until_stopped">Always</option>
                ) : mode === "ongoing" ? (
                  <option value="until_stopped">When I stop sharing</option>
                ) : null}
              </select>
            </label>
            {durationChoice === "custom" ? (
              <fieldset className="mt-3">
                <legend className={styles.caption}>Custom duration</legend>
                <div className="mt-2 flex gap-2">
                  <Input
                    aria-label="Duration amount"
                    type="number"
                    min={1}
                    step={1}
                    max={604800 / customUnit}
                    value={customValue}
                    aria-invalid={!durationValid}
                    onChange={(e) => setCustomValue(e.target.value)}
                  />
                  <select
                    aria-label="Duration unit"
                    className="min-h-11 rounded-full border border-input bg-background px-4"
                    value={customUnit}
                    onChange={(e) => setCustomUnit(Number(e.target.value))}
                  >
                    <option value={60}>Minutes</option>
                    <option value={3600}>Hours</option>
                    <option value={86400}>Days</option>
                  </select>
                </div>
                <p className={styles.caption}>Choose 1 minute to 7 days.</p>
                {!durationValid ? (
                  <p role="alert" className="text-sm text-destructive">
                    Enter a whole number from 1 minute to 7 days.
                  </p>
                ) : null}
              </fieldset>
            ) : null}
            {!expiryAllowed ? (
              <p role="alert" className="text-sm text-destructive">
                Always is available only when everyone selected is a verified
                advisor. Choose an end time.
              </p>
            ) : null}
            <label className={styles.choice}>
              <input
                type="checkbox"
                checked={selection.showAmounts}
                onChange={(e) =>
                  setSelection((s) => ({
                    ...s,
                    showAmounts: e.target.checked,
                  }))
                }
              />
              <span>Show dollar amounts</span>
            </label>
          </div>
        </section>
      </SwipeViews>
    </div>
  );
}
