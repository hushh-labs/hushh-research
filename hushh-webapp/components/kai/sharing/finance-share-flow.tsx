"use client";

import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { openPersonProfilePreview } from "@/lib/connections/person-profile-preview";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { OnboardingStepper } from "@/components/app-ui/onboarding-stepper";
import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";
import { SectionLabel } from "@/components/app-ui/typography";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useBackLayer } from "@/lib/navigation/back-layers";
import {
  financeSections,
  projectFinance,
  type FinanceGrant,
  type FinanceOwnerConfig,
  type FinancePolicy,
  type FinanceProjection,
  type FinanceSelection,
  type FinanceSource,
} from "@/lib/finance-sharing/contract";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { readSavedFinance } from "@/lib/finance-sharing/saved-source";
import {
  FinanceSharingService,
  pendingFinanceShare,
  type PreparedFinanceShare,
} from "@/lib/services/finance-sharing-service";
import type { OneLocationRecipient } from "@/lib/one-location/types";
import type { DashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { FinanceSharingPreview } from "./finance-sharing-preview";
import { FinanceSharingManager } from "./finance-sharing-manager";
import finance from "@/components/kai/shared/finance-workspace.module.css";
import styles from "./finance-sharing.module.css";

const sectionLabel = {
  allocation: "Allocation",
  performance: "Performance",
  holdings: "Selected stocks",
  note: "Your note",
};
const sharingSteps = [
  { value: "people", label: "Contacts" },
  { value: "sections", label: "What to share" },
  { value: "access", label: "Access" },
] as const;
type EditStep = (typeof sharingSteps)[number]["value"];

export type FinanceShareUpdate = {
  grant: FinanceGrant;
  config: FinanceOwnerConfig;
  recipient: OneLocationRecipient;
};

export function FinanceShareFlow({
  open,
  onOpenChange,
  model,
  source,
  initialShare,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  model: DashboardViewModel;
  source: FinanceSource;
  initialShare?: FinanceShareUpdate;
}) {
  const { capture, session, ready } = useFinanceShareContext();
  const [step, setStep] = useState<"edit" | "review" | "sent">("edit");
  const tabSetId = `finance-share-${useId().replace(/:/g, "")}`;
  const [editStep, setEditStep] = useState<EditStep>("people");
  const peopleHeading = useRef<HTMLParagraphElement>(null);
  const optionsHeading = useRef<HTMLParagraphElement>(null);
  const accessHeading = useRef<HTMLParagraphElement>(null);
  const focusEditStep = useRef(false);
  const editIndex = sharingSteps.findIndex((item) => item.value === editStep);
  const changeEditStep = (next: EditStep) => {
    focusEditStep.current = true;
    setEditStep(next);
  };
  const returnToEdit = () => {
    focusEditStep.current = true;
    setStep("edit");
  };
  useEffect(() => {
    if (!focusEditStep.current || step !== "edit" || !open) return;
    focusEditStep.current = false;
    const frame = requestAnimationFrame(() =>
      (editStep === "people"
        ? peopleHeading
        : editStep === "sections"
          ? optionsHeading
          : accessHeading
      ).current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [editStep, open, step]);
  const [selection, setSelection] = useState<FinanceSelection>({
    sections: ["allocation", "performance"],
    holdingSymbols: [],
    showAmounts: false,
    note: "",
  });
  const [mode, setMode] = useState<FinancePolicy["mode"]>("snapshot");
  const [durationChoice, setDurationChoice] = useState("86400");
  const [customValue, setCustomValue] = useState("2");
  const [customUnit, setCustomUnit] = useState(3600);
  const duration =
    durationChoice === "until_stopped"
      ? null
      : durationChoice === "custom"
        ? Number(customValue) * customUnit
        : Number(durationChoice);
  const durationValid =
    duration === null ||
    (Number.isInteger(duration) &&
      duration >= 60 &&
      duration <= 604800 &&
      (durationChoice !== "custom" || /^\d+$/.test(customValue)));
  const durationUnit = duration !== null && duration % 86400 === 0 ? 86400 : duration !== null && duration % 3600 === 0 ? 3600 : 60;
  const durationCount = duration === null ? 0 : duration / durationUnit;
  const durationNoun = durationUnit === 86400 ? "day" : durationUnit === 3600 ? "hour" : "minute";
  const durationLabel = duration === null ? "When you stop sharing" : `After ${durationCount} ${durationNoun}${durationCount === 1 ? "" : "s"}`;
  const [allowModel, setAllowModel] = useState(false);
  const [people, setPeople] = useState<OneLocationRecipient[]>([]);
  const [selected, setSelected] = useState<OneLocationRecipient[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [peopleBusy, setPeopleBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FinanceProjection | null>(null);
  const [config, setConfig] = useState<FinanceOwnerConfig | null>(null);
  const [manage, setManage] = useState(false);
  const [accessEnded, setAccessEnded] = useState(false);
  const prepared = useRef<PreparedFinanceShare | null>(null);
  const inFlight = useRef(false);
  const requestGeneration = useRef(0);
  const pathname = usePathname();
  const params = useSearchParams();
  useEffect(
    () => () => {
      requestGeneration.current++;
      inFlight.current = false;
    },
    [],
  );
  useBackLayer(
    pathname,
    open && !manage ? (step === "review" ? 4 : editIndex + 1) : 0,
    () => {
      if (inFlight.current) return true;
      if (step === "review" && !prepared.current) returnToEdit();
      else if (step === "edit" && editIndex > 0)
        changeEditStep((sharingSteps[editIndex - 1] ?? sharingSteps[0]).value);
      else onOpenChange(false);
      return true;
    },
    pathname === "/one/kai"
      ? { tab: params.get("tab") || "portfolio" }
      : undefined,
  );
  useEffect(() => {
    requestGeneration.current++;
    inFlight.current = false;
    focusEditStep.current = false;
    prepared.current = null;
    setPreview(null);
    setConfig(null);
    setSelected(initialShare ? [initialShare.recipient] : []);
    setPeople(initialShare ? [initialShare.recipient] : []);
    setMore(false);
    setQuery("");
    setPage(1);
    setError(null);
    setBusy(false);
    setPeopleBusy(false);
    setStep("edit");
    setEditStep(initialShare ? "sections" : "people");
    setManage(false);
    setAccessEnded(false);
    setSelection(
      initialShare?.config.selection ?? {
        sections: ["allocation", "performance"],
        holdingSymbols: [],
        showAmounts: false,
        note: "",
      },
    );
    setAllowModel(initialShare?.grant.policy.model_processing.allowed ?? false);
    setMode(initialShare?.grant.policy.mode ?? "snapshot");
    const previousDuration = initialShare?.grant.policy.durationSeconds;
    setDurationChoice(
      previousDuration === null
        ? "until_stopped"
        : previousDuration === undefined
          ? "86400"
          : [3600, 86400, 604800].includes(previousDuration)
            ? String(previousDuration)
            : "custom",
    );
    setCustomValue(previousDuration ? String(previousDuration / 60) : "2");
    setCustomUnit(previousDuration ? 60 : 3600);
  }, [session, open, initialShare]);
  useEffect(() => {
    if (!open) return;
    const hide = () => {
      if (document.hidden) {
        requestGeneration.current++;
        setPreview(null);
        setConfig(null);
        onOpenChange(false);
      }
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [open, onOpenChange]);
  useEffect(() => {
    if (!open || !ready || step !== "edit" || initialShare) return;
    const context = capture();
    if (!context) return;
    let disposed = false;
    const timer = window.setTimeout(
      async () => {
        setPeopleBusy(true);
        try {
          const [result, alreadyShared] = await Promise.all([
            FinanceSharingService.recipients(context, query, page),
            FinanceSharingService.activeRecipientRefs(context),
          ]);
          if (disposed || !context.isCurrent()) return;
          const items = result.items.filter(
            (person) =>
              !person.publicPersonRef ||
              !alreadyShared.has(person.publicPersonRef),
          );
          setPeople((previous) =>
            page === 1
              ? items
              : [
                  ...previous,
                  ...items.filter(
                    (p) => !previous.some((old) => old.userId === p.userId),
                  ),
                ],
          );
          setMore(result.hasMore);
        } catch (e) {
          if (!disposed && context.isCurrent())
            setError(
              e instanceof Error ? e.message : "Connections are unavailable.",
            );
        } finally {
          if (!disposed && context.isCurrent()) setPeopleBusy(false);
        }
      },
      query ? 250 : 0,
    );
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [capture, initialShare, open, page, query, ready, session, step]);
  const choices = useMemo(
    () => [
      ...new Map(
        model.canonicalModel.positions
          .filter((p) => p.identifierType === "ticker" && p.tickerSymbol)
          .map((p) => [p.tickerSymbol, p]),
      ).values(),
    ],
    [model],
  );
  const allStocksSelected =
    choices.length > 0 &&
    choices.every((p) => selection.holdingSymbols.includes(p.tickerSymbol!));
  const pendingConfirmation = pendingFinanceShare(ready ? capture() : null);
  const availableSteps = sharingSteps.slice(
    0,
    !selected.length ? 1 : !selection.sections.length ? 2 : 3,
  );
  const allAdvisors =
    selected.length > 0 && selected.every((person) => person.isFinanceAdvisor);
  const expiryAllowed = duration !== null || mode === "ongoing" || allAdvisors;
  const canContinue =
    editStep === "people"
      ? selected.length > 0
      : selection.sections.length > 0 &&
        (editStep !== "access" || (durationValid && expiryAllowed));
  const operationContext = () => {
    const base = capture();
    if (!base) return null;
    const generation = requestGeneration.current;
    return {
      ...base,
      isCurrent: () =>
        generation === requestGeneration.current && base.isCurrent(),
    };
  };
  const chooseSection = (
    section: (typeof financeSections)[number],
    checked: boolean,
  ) =>
    setSelection((s) => ({
      ...s,
      sections: checked
        ? [...s.sections, section]
        : s.sections.filter((v) => v !== section),
    }));
  const review = async () => {
    if (inFlight.current || pendingConfirmation) return;
    const context = operationContext();
    if (!context) return;
    inFlight.current = true;
    const generation = requestGeneration.current;
    setBusy(true);
    setError(null);
    try {
      if (!selected.length) throw new Error("Choose at least one connection.");
      if (!selection.sections.length)
        throw new Error("Choose at least one section to share.");
      if (!durationValid || !expiryAllowed)
        throw new Error(
          "Choose an access duration from 1 minute to 7 days, or Always for verified advisors.",
        );
      const saved = await readSavedFinance(context, source);
      const next = projectFinance(saved.model, selection, source);
      if (!context.isCurrent() || requestGeneration.current !== generation)
        return;
      setConfig({
        source: saved.source,
        sourceFence: saved.sourceFence,
        selection,
      });
      setPreview(next);
      setStep("review");
    } catch (e) {
      if (context.isCurrent() && requestGeneration.current === generation)
        setError(e instanceof Error ? e.message : "Review is unavailable.");
    } finally {
      if (requestGeneration.current === generation) {
        inFlight.current = false;
        if (context.isCurrent()) setBusy(false);
      }
    }
  };
  const share = async (fresh?: {
    config: FinanceOwnerConfig;
    preview: FinanceProjection;
  }) => {
    if (inFlight.current) return;
    const context = operationContext();
    const cfg = fresh?.config ?? config,
      proposed = fresh?.preview ?? preview;
    if (!context || !cfg || !proposed) return;
    inFlight.current = true;
    const generation = requestGeneration.current;
    setBusy(true);
    setError(null);
    try {
      if (!prepared.current) {
        const saved = await readSavedFinance(context, cfg.source);
        const current = projectFinance(saved.model, cfg.selection, cfg.source);
        if (
          saved.sourceFence !== cfg.sourceFence ||
          JSON.stringify(current) !== JSON.stringify(proposed)
        )
          throw new Error(
            "Your saved portfolio changed. Go back and review the updated preview.",
          );
        prepared.current = await FinanceSharingService.prepare(
          context,
          cfg,
          proposed,
          {
            ...(allAdvisors && duration === null
              ? { version: 3 as const, purpose: "verified_ria_share" as const }
              : { version: 1 as const }),
            mode,
            sections: selection.sections,
            showAmounts: selection.showAmounts,
            model_processing: { version: 1 as const, allowed: allowModel },
            durationSeconds: duration,
          },
          selected,
        );
      }
      if (requestGeneration.current !== generation) return;
      const receipt = await FinanceSharingService.publish(
        context,
        prepared.current,
      );
      if (!context.isCurrent() || requestGeneration.current !== generation)
        return;
      if (
        receipt.items.length !== selected.length ||
        receipt.items.some((g) => g.requestId !== prepared.current?.requestId)
      )
        throw new Error(
          "Delivery could not be verified. Check Manage sharing.",
        );
      setAccessEnded(receipt.items.some((item) => item.status !== "active"));
      setStep("sent");
      window.dispatchEvent(new Event("finance-sharing-changed"));
    } catch (e) {
      if (context.isCurrent() && requestGeneration.current === generation) {
        if (!pendingFinanceShare(context)) prepared.current = null;
        setError(
          e instanceof Error ? e.message : "Sharing could not be confirmed.",
        );
      }
    } finally {
      if (requestGeneration.current === generation) {
        inFlight.current = false;
        if (context.isCurrent()) setBusy(false);
      }
    }
  };
  const retryPrevious = async () => {
    if (inFlight.current) return;
    const context = operationContext();
    if (!context || !pendingConfirmation) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const receipt = await FinanceSharingService.publish(
        context,
        pendingConfirmation,
      );
      if (context.isCurrent()) {
        setAccessEnded(receipt.items.some((item) => item.status !== "active"));
        setStep("sent");
        window.dispatchEvent(new Event("finance-sharing-changed"));
      }
    } catch (e) {
      if (context.isCurrent())
        setError(
          e instanceof Error ? e.message : "Sharing could not be confirmed.",
        );
    } finally {
      inFlight.current = false;
      if (context.isCurrent()) setBusy(false);
    }
  };
  const peopleSection = (
    title: string,
    id?: string,
    headingRef?: typeof peopleHeading,
  ) => (
    <section
      className={`${styles.group} ${styles.peopleGroup}`}
      data-testid="finance-share-people"
    >
      <SectionLabel
        id={id}
        ref={headingRef}
        tabIndex={headingRef ? -1 : undefined}
        role="heading"
        aria-level={2}
        className={styles.heading}
      >
        {title}
      </SectionLabel>
      {selected.length && !initialShare ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {selected.map((person) => (
            <button
              className={styles.chip}
              key={person.userId}
              onClick={() =>
                setSelected((p) => p.filter((r) => r.userId !== person.userId))
              }
              aria-label={`Remove ${person.displayName}`}
            >
              {person.displayName} ×
            </button>
          ))}
        </div>
      ) : null}
      {!initialShare ? (
        <label className="mt-4 block">
          <span className="sr-only">Search connections</span>
          <Input
            value={query}
            placeholder="Search your connections"
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </label>
      ) : null}
      <div
        className={styles.recipientList}
        aria-label="Connections"
        role="group"
        aria-busy={peopleBusy}
      >
        {people.map((person) => (
          <label key={person.userId} className={styles.choice}>
            <input
              type="checkbox"
              aria-label={`${person.displayName}${person.isFinanceAdvisor ? ", verified advisor" : ""}`}
              disabled={
                Boolean(initialShare) ||
                !person.keyId ||
                !person.publicKeyJwk ||
                (!selected.some((r) => r.userId === person.userId) &&
                  selected.length >= 20)
              }
              checked={selected.some((r) => r.userId === person.userId)}
              onChange={(e) =>
                setSelected((p) =>
                  e.target.checked
                    ? [...p, person]
                    : p.filter((r) => r.userId !== person.userId),
                )
              }
            />
            <ConnectionPersonAvatar
              label={person.displayName}
              photoUrl={person.photoUrl}
              verified={person.isFinanceAdvisor}
              size="compact"
            />
            <span>
              <button
                type="button"
                className="text-left"
                aria-label={`View ${person.displayName}'s profile`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openPersonProfilePreview(
                    { userId: person.userId },
                    event.currentTarget,
                  );
                }}
              >
                {person.displayName}
              </button>
              {person.keyId && person.publicKeyJwk ? null : (
                <small>Needs to unlock One first</small>
              )}
            </span>
          </label>
        ))}
        {!peopleBusy && !people.length ? (
          <p className="py-4 text-sm text-muted-foreground">
            No matching connections. People with access are in Manage sharing.
          </p>
        ) : null}
        {peopleBusy ? (
          <p role="status" className={styles.caption}>
            Checking connections…
          </p>
        ) : null}
        {more ? (
          <ShellActionSurface
            variant="pill"
            disabled={peopleBusy}
            onClick={() => setPage((p) => p + 1)}
          >
            More connections
          </ShellActionSurface>
        ) : null}
      </div>
    </section>
  );
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
    <>
      <KaiControlSurface
        open={open}
        onOpenChange={(value) => {
          if (!inFlight.current) onOpenChange(value);
        }}
        title={
          step === "sent" ? (
            <span className="inline-block motion-step-enter">
              {accessEnded
                ? "Sharing ended"
                : initialShare
                  ? "Access updated"
                  : "Finance shared"}
            </span>
          ) : step === "review" ? (
            "Review before sharing"
          ) : initialShare ? (
            "Update access"
          ) : (
            "Share Finance"
          )
        }
        presentation="sheet"
        bodyClassName={styles.flowBody}
        surfaceClassName={`${finance.detail} ${styles.flowSurface}`}
        footer={
          <div className={styles.toolbar}>
            {step === "edit" ? (
              <>
                {editIndex > 0 ? (
                  <ShellActionSurface
                    variant="pill"
                    disabled={busy}
                    onClick={() =>
                      changeEditStep(
                        (sharingSteps[editIndex - 1] ?? sharingSteps[0]).value,
                      )
                    }
                  >
                    Back
                  </ShellActionSurface>
                ) : (
                  <ShellActionSurface
                    variant="pill"
                    onClick={() => setManage(true)}
                  >
                    Manage sharing
                  </ShellActionSurface>
                )}
                <ShellActionSurface
                  variant="pill"
                  rippleEffect="fill"
                  wrapperClassName={styles.forward}
                  className={styles.primaryAction}
                  disabled={
                    busy ||
                    !ready ||
                    !canContinue ||
                    Boolean(pendingConfirmation)
                  }
                  onClick={() =>
                    editIndex < 2
                      ? changeEditStep(
                          (sharingSteps[editIndex + 1] ?? sharingSteps[0])
                            .value,
                        )
                      : void review()
                  }
                >
                  {busy ? "Preparing…" : editIndex < 2 ? "Continue" : "Preview"}
                </ShellActionSurface>
              </>
            ) : step === "review" ? (
              <>
                <ShellActionSurface
                  variant="pill"
                  disabled={busy || Boolean(prepared.current)}
                  onClick={returnToEdit}
                >
                  Back
                </ShellActionSurface>
                <ShellActionSurface
                  variant="pill"
                  disabled={busy || !ready}
                  onClick={() => void share()}
                >
                  {busy
                    ? "Sharing…"
                    : prepared.current
                      ? "Retry confirmation"
                      : initialShare
                        ? "Update access"
                        : `Share with ${selected.length} ${selected.length === 1 ? "person" : "people"}`}
                </ShellActionSurface>
                <ShellActionSurface
                  variant="pill"
                  disabled={busy}
                  onClick={() => setManage(true)}
                >
                  Manage sharing
                </ShellActionSurface>
              </>
            ) : (
              <>
                <ShellActionSurface
                  variant="pill"
                  onClick={() => setManage(true)}
                >
                  Manage sharing
                </ShellActionSurface>
                <ShellActionSurface
                  variant="pill"
                  onClick={() => onOpenChange(false)}
                >
                  Done
                </ShellActionSurface>
              </>
            )}
          </div>
        }
      >
        {error ? (
          <p role="alert" className="mb-5 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {pendingConfirmation && step === "edit" ? (
          <div className={`${styles.privacy} mb-5`}>
            <p>
              Previous confirmation is unresolved. Retry safely or check Manage
              sharing.
            </p>
            <ShellActionSurface
              variant="pill"
              disabled={busy}
              onClick={() => void retryPrevious()}
            >
              Retry previous confirmation
            </ShellActionSurface>
          </div>
        ) : null}
        {!ready ? (
          <p className={styles.privacy}>
            Unlock your vault to share Finance information.
          </p>
        ) : null}
        {step === "edit" ? (
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
              {peopleSection(
                "Who can see it?",
                `top-shell-${tabSetId}-tab-people`,
                peopleHeading,
              )}
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
                        onChange={(e) =>
                          chooseSection(section, e.target.checked)
                        }
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
                        <option value="until_stopped">
                          When I stop sharing
                        </option>
                      ) : null}
                    </select>
                  </label>
                  {durationChoice === "custom" ? (
                    <fieldset className="mt-3">
                      <legend className={styles.caption}>
                        Custom duration
                      </legend>
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
                          onChange={(e) =>
                            setCustomUnit(Number(e.target.value))
                          }
                        >
                          <option value={60}>Minutes</option>
                          <option value={3600}>Hours</option>
                          <option value={86400}>Days</option>
                        </select>
                      </div>
                      <p className={styles.caption}>
                        Choose 1 minute to 7 days.
                      </p>
                      {!durationValid ? (
                        <p role="alert" className="text-sm text-destructive">
                          Enter a whole number from 1 minute to 7 days.
                        </p>
                      ) : null}
                    </fieldset>
                  ) : null}
                  {!expiryAllowed ? (
                    <p role="alert" className="text-sm text-destructive">
                      Always is available only when everyone selected is a
                      verified advisor. Choose an end time.
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
                  <label className={styles.choice}>
                    <input
                      type="checkbox"
                      checked={allowModel}
                      onChange={(e) => setAllowModel(e.target.checked)}
                    />
                    <span>Allow their Agent One to review</span>
                  </label>
                </div>
              </section>
            </SwipeViews>
          </div>
        ) : preview ? (
          <div
            className={`${styles.layout} ${styles.reviewPanel} motion-step-enter`}
          >
            <div>
              <SectionLabel
                role="heading"
                aria-level={2}
                className={`${styles.heading} mb-4`}
              >
                What they will see
              </SectionLabel>
              <FinanceSharingPreview projection={preview} />
            </div>
            <div className={styles.section}>
              <section className={styles.group}>
                <SectionLabel
                  role="heading"
                  aria-level={2}
                  className={styles.heading}
                >
                  {step === "sent" ? "Shared with" : "Ready to share with"}
                </SectionLabel>
                {selected.map((person) => (
                  <p className={styles.row} key={person.userId}>
                    {person.displayName}
                  </p>
                ))}
                <dl>
                  <div className={styles.row}>
                    <dt>Access</dt>
                    <dd>{mode === "snapshot" ? "Snapshot" : "Real time"}</dd>
                  </div>
                  <div className={styles.row}>
                    <dt>Ends</dt>
                    <dd>{durationLabel}</dd>
                  </div>
                  <div className={styles.row}>
                    <dt>Dollar amounts</dt>
                    <dd>{selection.showAmounts ? "Included" : "Hidden"}</dd>
                  </div>
                  <div className={styles.row}>
                    <dt>Agent One review</dt>
                    <dd>{allowModel ? "Allowed" : "Not allowed"}</dd>
                  </div>
                </dl>
              </section>
            </div>
          </div>
        ) : step === "sent" ? (
          <p className="text-sm">
            {accessEnded ? "Access has ended." : "Sent."}
          </p>
        ) : null}
      </KaiControlSurface>
      <FinanceSharingManager open={manage} onOpenChange={setManage} preferredSource={source} />
    </>
  );
}
