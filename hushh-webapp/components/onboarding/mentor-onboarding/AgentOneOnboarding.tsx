"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { clampStep, STORIES } from "./content";
import { OnboardingFooter } from "./components/OnboardingFooter";
import { AskScreen } from "./screens/AskScreen";
import { KnowScreen } from "./screens/KnowScreen";
import { ConnectScreen } from "./screens/ConnectScreen";
import { ControlScreen } from "./screens/ControlScreen";
import type { CompletionReason } from "./types";

import "./onboarding.css";

export interface AgentOneOnboardingProps {
  /** The host owns the zero-based story index and real continuation route. */
  index: number;
  onIndexChange: (index: number) => void;
  onComplete: (reason: CompletionReason) => void | Promise<void>;
  finalActionLabel?: string;
  finalActionDisabled?: boolean;
  invitationContent?: ReactNode;
  motion?: boolean;
}

const SCREENS = [AskScreen, KnowScreen, ConnectScreen, ControlScreen] as const;
const INTERACTIVE_TARGET = "button, a, input, textarea, select, [contenteditable], [role='textbox']";

/** Mentor V7.2 presentation. The host retains routing, auth and invitation authority. */
export function AgentOneOnboarding({
  index,
  onIndexChange,
  onComplete,
  finalActionLabel = "Get started",
  finalActionDisabled = false,
  invitationContent,
  motion = true,
}: AgentOneOnboardingProps) {
  const currentIndex = clampStep(index);
  const Screen = SCREENS[currentIndex] ?? AskScreen;
  const root = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number; id: number } | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const previousIndex = useRef(currentIndex);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const headingId = `${useId()}-heading`;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (previousIndex.current === currentIndex) return;
    previousIndex.current = currentIndex;
    pointer.current = null;
    if (root.current) root.current.scrollTop = 0;
    root.current?.querySelector<HTMLElement>(".ao-title")?.focus({ preventScroll: true });
  }, [currentIndex]);

  const goTo = useCallback((next: number) => {
    if (busyRef.current) return;
    const target = clampStep(next);
    if (target === currentIndex) return;
    setError("");
    onIndexChange(target);
  }, [currentIndex, onIndexChange]);

  async function finish(reason: CompletionReason) {
    if (busyRef.current || finalActionDisabled) return;
    busyRef.current = true;
    pointer.current = null;
    setBusy(true);
    setError("");
    try {
      await onComplete(reason);
    } catch {
      if (mounted.current) setError("Could not continue. Please try again.");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if ((event.target as Element).closest("input, textarea, select, [contenteditable], [role='textbox']")) return;
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    goTo(currentIndex + (event.key === "ArrowRight" ? 1 : -1));
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary) {
      pointer.current = null;
      return;
    }
    if (event.button !== 0 || busyRef.current) return;
    if ((event.target as Element).closest(INTERACTIVE_TARGET)) return;
    pointer.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = pointer.current;
    pointer.current = null;
    if (!start || start.id !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.35) {
      goTo(currentIndex + (dx < 0 ? 1 : -1));
    }
  }

  const footer = (
    <OnboardingFooter
      index={currentIndex}
      onChange={goTo}
      busy={busy}
      error={error}
      finalActionLabel={finalActionLabel}
      completionDisabled={finalActionDisabled}
      onSkip={() => { void finish("skipped"); }}
      onNext={() => {
        if (currentIndex < STORIES.length - 1) goTo(currentIndex + 1);
        else void finish("finished");
      }}
    />
  );

  return (
    <div
      ref={root}
      className="ao-onboarding"
      data-intro-v2="true"
      role="region"
      aria-roledescription="carousel"
      aria-label="Meet Agent One"
      tabIndex={-1}
      data-layout="auto"
      data-motion={motion ? "on" : "off"}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { pointer.current = null; }}
      onLostPointerCapture={() => { pointer.current = null; }}
      onKeyDown={handleKeyDown}
    >
      <Screen
        key={currentIndex}
        headingId={headingId}
        assetBaseUrl="/onboarding/mentor-v72"
        active
        motion={motion}
        paidDocumentAccess={false}
        invitationContent={invitationContent}
        footer={footer}
      />
      <span data-location-type-role="row-description" className="ao-sr-only">Screen {currentIndex + 1} of {STORIES.length}</span>
    </div>
  );
}
