"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type RefObject,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ContactRound,
  KeyRound,
  LocateFixed,
  MapPin,
  ShieldCheck,
  UsersRound,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type OneLocationTourStepId =
  | "readiness"
  | "promises"
  | "one_network"
  | "contact_signal"
  | "share_request"
  | "activity"
  | "access_history";

export type OneLocationTourTargets = Partial<
  Record<OneLocationTourStepId, RefObject<Element | null>>
>;

type TourStep = {
  id: OneLocationTourStepId;
  eyebrow: string;
  title: string;
  description: string;
  icon: ElementType;
  targetLabel: string;
};

const TOUR_STEPS: TourStep[] = [
  {
    id: "readiness",
    eyebrow: "Step 1",
    title: "Check location readiness",
    description:
      "Start here to confirm browser permission, device location services, and the action needed before sharing.",
    icon: LocateFixed,
    targetLabel: "Device readiness",
  },
  {
    id: "promises",
    eyebrow: "Step 2",
    title: "Understand the safety rules",
    description:
      "Chosen people, approval first, and stop anytime explain the privacy guardrails before any share begins.",
    icon: ShieldCheck,
    targetLabel: "Safety promises",
  },
  {
    id: "one_network",
    eyebrow: "Step 3",
    title: "Pick from your One Network",
    description:
      "Use recommendations, readiness tags, and search to choose One users for sharing or requesting location.",
    icon: UsersRound,
    targetLabel: "One Network",
  },
  {
    id: "contact_signal",
    eyebrow: "Step 4",
    title: "Use mobile contact signal",
    description:
      "Sync contacts to lift matching One users while keeping phone-derived identity labels out of the UI.",
    icon: ContactRound,
    targetLabel: "Mobile contact signal",
  },
  {
    id: "share_request",
    eyebrow: "Step 5",
    title: "Share or request with review",
    description:
      "Select people, choose duration, add request context, and review before a private location action is sent.",
    icon: KeyRound,
    targetLabel: "Share and request actions",
  },
  {
    id: "activity",
    eyebrow: "Step 6",
    title: "Track activity history",
    description:
      "Use the dashboard to review shares, requests, public links, and recent activity across date ranges.",
    icon: BarChart3,
    targetLabel: "Activity history",
  },
  {
    id: "access_history",
    eyebrow: "Step 7",
    title: "Review access and responses",
    description:
      "Received shares, approvals, public responses, and your requests stay grouped below for follow-up.",
    icon: MapPin,
    targetLabel: "Access history",
  },
];

let onboardingSeenThisSession = false;

function getOnboardingSeen(): boolean {
  return onboardingSeenThisSession;
}

function setOnboardingSeen(): void {
  onboardingSeenThisSession = true;
}

export function OneLocationOnboardingOverlay({
  onDismiss,
  onStepChange,
  targets,
}: {
  onDismiss: () => void;
  onStepChange?: (step: OneLocationTourStepId | null) => void;
  targets?: OneLocationTourTargets;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [exiting, setExiting] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [spotlightRect, setSpotlightRect] = useState<{
    height: number;
    width: number;
    x: number;
    y: number;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const currentStep = TOUR_STEPS[currentIndex] ?? TOUR_STEPS[0]!;
  const isLast = currentIndex === TOUR_STEPS.length - 1;

  const updateSpotlight = useCallback(() => {
    const element = targets?.[currentStep.id]?.current;
    if (!element) {
      setSpotlightRect(null);
      return;
    }

    const rect = element.getBoundingClientRect();
    const padding = window.innerWidth < 768 ? 8 : 14;
    setSpotlightRect({
      height: Math.min(rect.height + padding * 2, window.innerHeight - 24),
      width: Math.min(rect.width + padding * 2, window.innerWidth - 24),
      x: Math.max(12, rect.left - padding),
      y: Math.max(12, rect.top - padding),
    });
  }, [currentStep.id, targets]);

  useEffect(() => {
    const id = window.setTimeout(() => setMounted(true), 30);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    onStepChange?.(currentStep.id);
    const id = window.setTimeout(() => {
      const element = targets?.[currentStep.id]?.current;
      if (!element) return;
      element.scrollIntoView({
        behavior: "smooth",
        block: window.innerWidth < 768 ? "center" : "nearest",
        inline: "nearest",
      });
      if (element instanceof HTMLElement) {
        element.focus({ preventScroll: true });
      }
      window.setTimeout(updateSpotlight, 220);
      window.setTimeout(updateSpotlight, 520);
    }, 120);
    return () => window.clearTimeout(id);
  }, [currentStep.id, onStepChange, targets, updateSpotlight]);

  useEffect(() => {
    updateSpotlight();
    window.addEventListener("resize", updateSpotlight);
    window.addEventListener("scroll", updateSpotlight, true);
    return () => {
      window.removeEventListener("resize", updateSpotlight);
      window.removeEventListener("scroll", updateSpotlight, true);
    };
  }, [updateSpotlight]);

  useEffect(
    () => () => {
      onStepChange?.(null);
    },
    [onStepChange],
  );

  const dismiss = useCallback(() => {
    setExiting(true);
    setOnboardingSeen();
    onStepChange?.(null);
    window.setTimeout(() => onDismiss(), 250);
  }, [onDismiss, onStepChange]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
        return;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        setCurrentIndex((index) => Math.min(index + 1, TOUR_STEPS.length - 1));
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        setCurrentIndex((index) => Math.max(index - 1, 0));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dismiss]);

  const goNext = () => {
    if (isLast) {
      dismiss();
      return;
    }
    setCurrentIndex((index) => index + 1);
  };

  const goPrevious = () => {
    setCurrentIndex((index) => Math.max(index - 1, 0));
  };

  const Icon = currentStep.icon;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="One Location guided tour"
      className={cn(
        "pointer-events-none fixed inset-0 z-50 transition-opacity duration-250",
        mounted && !exiting ? "opacity-100" : "opacity-0",
      )}
    >
      {spotlightRect ? (
        <div
          aria-hidden="true"
          className="absolute rounded-[24px] border border-[#007aff]/65 shadow-[0_0_0_9999px_rgba(12,12,14,0.24),0_0_0_5px_rgba(0,122,255,0.12),0_16px_42px_rgba(0,0,0,0.18)] transition-all duration-300 dark:border-[#76b7ff]/75"
          style={{
            height: spotlightRect.height,
            left: spotlightRect.x,
            top: spotlightRect.y,
            width: spotlightRect.width,
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/18" />
      )}

      <div
        ref={panelRef}
        className={cn(
          "pointer-events-auto absolute bottom-0 left-0 right-0 mx-auto max-h-[calc(100dvh-96px)] w-full max-w-[640px] overflow-y-auto rounded-t-[20px] border border-black/[0.06] bg-white/95 p-3.5 shadow-[0_-8px_28px_rgba(0,0,0,0.16)] backdrop-blur-sm transition-all duration-300 dark:border-white/10 dark:bg-[#1c1c1e]/95",
          "md:bottom-8 md:left-auto md:right-28 md:w-[360px] md:rounded-[20px] md:shadow-[0_14px_40px_rgba(0,0,0,0.2)]",
          mounted && !exiting
            ? "translate-y-0 opacity-100"
            : "translate-y-8 opacity-0",
        )}
      >
        <div className="flex items-start justify-between gap-2.5">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#eaf3ff] text-[#007aff] dark:bg-[#0a84ff]/15 dark:text-[#76b7ff]">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#007aff] dark:text-[#76b7ff]">
                {currentStep.eyebrow} of {TOUR_STEPS.length}
              </p>
              <h2 className="mt-1 text-[18px] font-bold leading-tight tracking-tight text-[#1c1c1e] dark:text-white">
                {currentStep.title}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Skip One Location guide"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#f2f2f7] text-[#636366] hover:bg-[#e5e5ea] dark:bg-white/10 dark:text-white/60 dark:hover:bg-white/15"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <p className="mt-2.5 text-[13px] font-medium leading-5 text-[#636366] dark:text-white/60">
          {currentStep.description}
        </p>

        <div className="mt-3 rounded-[14px] border border-[#007aff]/15 bg-[#eef5ff] px-3 py-2.5 text-[12px] font-semibold text-[#005bb5] dark:border-[#0a84ff]/25 dark:bg-[#0a84ff]/15 dark:text-[#a7d4ff]">
          Highlighting: {currentStep.targetLabel}
        </div>

        <div className="mt-3 flex items-center gap-1.5" aria-label="Tour progress">
          {TOUR_STEPS.map((step, index) => (
            <button
              key={step.id}
              type="button"
              onClick={() => setCurrentIndex(index)}
              aria-label={`Go to ${step.targetLabel}`}
              aria-current={index === currentIndex ? "step" : undefined}
              className={cn(
                "h-2 rounded-full transition-all",
                index === currentIndex
                  ? "w-8 bg-[#007aff]"
                  : "w-2.5 bg-[#007aff]/25 hover:bg-[#007aff]/40",
              )}
            />
          ))}
        </div>

        <div className="mt-3 grid grid-cols-[40px_minmax(0,1fr)] gap-2 sm:grid-cols-[40px_minmax(0,1fr)_auto]">
          <button
            type="button"
            onClick={goPrevious}
            disabled={currentIndex === 0}
            className="flex h-10 items-center justify-center rounded-[12px] border border-black/[0.06] bg-[#f2f2f7] text-[#1c1c1e] disabled:opacity-40 dark:border-white/[0.08] dark:bg-white/10 dark:text-white"
            aria-label="Previous tour step"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            id="one-location-onboarding-next"
            onClick={goNext}
            className="flex h-10 min-w-0 items-center justify-center gap-2 rounded-[12px] bg-[#007aff] px-4 text-[13px] font-bold text-white shadow-[0_4px_14px_rgba(0,122,255,0.24)] hover:bg-[#006fe6]"
          >
            {isLast ? (
              <>
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Finish guide
              </>
            ) : (
              <>
                Next section
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </>
            )}
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="col-span-2 h-10 rounded-[12px] bg-transparent px-4 text-[13px] font-bold text-[#636366] hover:bg-[#f2f2f7] sm:col-span-1 dark:text-white/55 dark:hover:bg-white/10"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}

export function useOneLocationOnboarding() {
  const [shouldShow, setShouldShow] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => {
      if (!getOnboardingSeen()) {
        setShouldShow(true);
      }
    }, 600);
    return () => window.clearTimeout(id);
  }, []);

  const dismiss = () => {
    setOnboardingSeen();
    setShouldShow(false);
  };

  const showTour = () => {
    setShouldShow(true);
  };

  return useMemo(
    () => ({
      shouldShow,
      dismiss,
      showTour,
    }),
    [shouldShow],
  );
}
