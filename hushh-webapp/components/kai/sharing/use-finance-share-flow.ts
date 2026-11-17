"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
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
export const sharingSteps = [
  { value: "people", label: "Contacts" },
  { value: "sections", label: "What to share" },
  { value: "access", label: "Access" },
] as const;
export type EditStep = (typeof sharingSteps)[number]["value"];

export type FinanceShareUpdate = {
  grant: FinanceGrant;
  config: FinanceOwnerConfig;
  recipient: OneLocationRecipient;
};

export type FinanceShareFlowProps = {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  model: DashboardViewModel;
  source: FinanceSource;
  initialShare?: FinanceShareUpdate;
};
export function useFinanceShareFlow({
  open,
  onOpenChange,
  model,
  source,
  initialShare,
}: FinanceShareFlowProps) {
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
  const durationUnit =
    duration !== null && duration % 86400 === 0
      ? 86400
      : duration !== null && duration % 3600 === 0
        ? 3600
        : 60;
  const durationCount = duration === null ? 0 : duration / durationUnit;
  const durationNoun =
    durationUnit === 86400 ? "day" : durationUnit === 3600 ? "hour" : "minute";
  const durationLabel =
    duration === null
      ? "When you stop sharing"
      : `After ${durationCount} ${durationNoun}${durationCount === 1 ? "" : "s"}`;
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
  return {
    step,
    editStep,
    editIndex,
    tabSetId,
    peopleHeading,
    optionsHeading,
    accessHeading,
    changeEditStep,
    returnToEdit,
    selection,
    setSelection,
    mode,
    setMode,
    duration,
    durationChoice,
    setDurationChoice,
    customValue,
    setCustomValue,
    customUnit,
    setCustomUnit,
    durationValid,
    durationLabel,
    allowModel,
    setAllowModel,
    people,
    selected,
    setSelected,
    query,
    setQuery,
    page,
    setPage,
    more,
    peopleBusy,
    busy,
    error,
    preview,
    manage,
    setManage,
    accessEnded,
    prepared,
    inFlight,
    pendingConfirmation,
    availableSteps,
    allAdvisors,
    expiryAllowed,
    canContinue,
    choices,
    allStocksSelected,
    chooseSection,
    review,
    share,
    retryPrevious,
    ready,
  };
}
export type FinanceShareFlowModel = ReturnType<typeof useFinanceShareFlow>;
