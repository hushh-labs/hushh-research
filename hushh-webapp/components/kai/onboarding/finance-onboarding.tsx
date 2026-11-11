"use client";

import { useEffect, useRef, useState } from "react";
import {
  Building2,
  Check,
  ChevronRight,
  Database,
  FileUp,
} from "@/components/icons";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { FinanceDemoPhone } from "./finance-demo-phone";
import styles from "./finance-onboarding.module.css";

const slides = [
  {
    label: "Market",
    title: "Follow the market.",
    description: "Indexes and headlines at a glance.",
  },
  {
    label: "Portfolio",
    title: "Know what you own.",
    description: "Your holdings and mix, made clear.",
  },
  {
    label: "Stocks",
    title: "Let three agents debate.",
    description: "Fundamental, Sentiment and Valuation.",
  },
];

/** An illustrative introduction. Its shapes never represent the owner's portfolio. */
export function FinanceOnboardingDemo({
  onContinue,
}: {
  onContinue: () => void;
}) {
  const [scene, setScene] = useState({ slide: 0, previous: -1 });
  const { slide, previous } = scene;
  const [paused, setPaused] = useState(false);
  const [stillScene, setStillScene] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    const visibility = () => setHidden(document.hidden);
    update();
    visibility();
    query.addEventListener("change", update);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      query.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const demoRef = useRef<HTMLElement>(null);
  const select = (next: number, manual = true) => {
    // A paused carousel remains readable when keyboard/Back/dots change scenes.
    // Play explicitly restarts the new scene, rather than leaving it at opacity 0.
    if (manual && paused) setStillScene(true);
    if (manual && next === slide && !paused) {
      // Replay the active illustration without unmounting the phone or losing focus.
      for (const node of demoRef.current?.querySelectorAll(
        `[data-scene="${slide}"], [data-demo-progress="true"]`,
      ) ?? [])
        for (const animation of node.getAnimations?.({ subtree: true }) ?? [])
          animation.currentTime = 0;
    }
    setScene((current) =>
      next === current.slide
        ? current
        : { slide: next, previous: current.slide },
    );
  };
  const pathname = usePathname();
  useBackLayer(pathname, 2, () => {
    if (slide === 0) return false;
    select(slide - 1);
    return true;
  });
  const touch = useRef<{ x: number; y: number } | null>(null);
  return (
    <section
      ref={demoRef}
      className={`${styles.surface} ${styles.demo}`}
      aria-label="Meet Finance"
      data-playing={!paused && !hidden && !reducedMotion}
      data-reduced-motion={reducedMotion || stillScene}
      onFocusCapture={(event) => {
        // Keyboard users must be able to read a scene without auto-advancement.
        // Pointer interaction does not silently disable the demonstration.
        if (event.target.matches(":focus-visible")) setPaused(true);
      }}
      onPointerDown={(event) => {
        touch.current =
          event.target instanceof Element && event.target.closest("button")
            ? null
            : { x: event.clientX, y: event.clientY };
      }}
      onPointerCancel={() => {
        touch.current = null;
      }}
      onPointerUp={(event) => {
        const start = touch.current;
        touch.current = null;
        if (!start) return;
        const dx = event.clientX - start.x;
        if (
          Math.abs(dx) > 50 &&
          Math.abs(dx) > Math.abs(event.clientY - start.y)
        )
          select(Math.max(0, Math.min(2, slide + (dx < 0 ? 1 : -1))));
      }}
    >
      <button type="button" className={styles.skipDemo} onClick={onContinue}>
        Skip
      </button>
      <div className={styles.introduction}>
        {slides.map((item, index) => (
          <div
            key={item.label}
            className={styles.introductionScene}
            data-active={slide === index}
            data-previous={previous === index}
            aria-hidden={slide !== index}
          >
            <p className={styles.eyebrow}>{item.label}</p>
            <h1 className={styles.title}>{item.title}</h1>
            <p className={styles.description}>{item.description}</p>
          </div>
        ))}
      </div>
      <div className={styles.phoneRegion}>
        <FinanceDemoPhone
          slide={slide}
          previous={previous}
          labels={slides.map((item) => item.label)}
        />
      </div>
      <div className={styles.demoFooter}>
        <div className={styles.playback}>
          <div
            className={styles.dots}
            role="group"
            aria-label="Finance introduction slides"
          >
            {slides.map((item, index) => (
              <button
                type="button"
                key={item.label}
                aria-label={`Show ${item.label} introduction`}
                aria-current={slide === index ? "step" : undefined}
                onClick={() => select(index)}
              >
                <span>
                  <i
                    key={slide}
                    data-demo-progress={index === slide}
                    style={{
                      animationDuration: `${slide === 2 ? 11800 : 5600}ms`,
                    }}
                    onAnimationEnd={(event) => {
                      if (
                        event.target === event.currentTarget &&
                        index === slide &&
                        !paused &&
                        !hidden &&
                        !reducedMotion
                      )
                        select((slide + 1) % slides.length, false);
                    }}
                  />
                </span>
              </button>
            ))}
          </div>
          {!reducedMotion && (
            <button
              type="button"
              className={styles.utility}
              aria-label={
                paused
                  ? "Play Finance introduction"
                  : "Pause Finance introduction"
              }
              onClick={() => {
                setStillScene(false);
                setPaused((value) => !value);
              }}
            >
              {paused ? "Play" : "Pause"}
            </button>
          )}
        </div>
        <button
          type="button"
          className={styles.primary}
          onClick={onContinue}
        >
          Continue
        </button>
      </div>
    </section>
  );
}

export type FinanceSource = "plaid" | "statement" | "sample";
export function FinanceSourcePicker({
  onConnect,
  onStatement,
  onSample,
  onSkip,
  onBack,
  busy,
  plaidAvailable,
  sampleAvailable,
  status,
  error,
}: {
  onConnect: () => void;
  onStatement: () => void;
  onSample: () => void;
  onSkip: () => void;
  onBack?: () => void;
  busy: boolean;
  plaidAvailable: boolean;
  sampleAvailable: boolean;
  status?: string;
  error?: string | null;
}) {
  const pathname = usePathname();
  useBackLayer(pathname, 2, () => {
    if (busy) return true;
    if (!onBack) return false;
    onBack();
    return true;
  });
  // Every source is its own button: tapping a card starts that path at once.
  const options = [
    {
      id: "plaid" as const,
      title: "Connect an account",
      description: plaidAvailable
        ? "Read-only, via Plaid"
        : "Bank connection unavailable",
      Icon: Building2,
      disabled: !plaidAvailable,
      start: onConnect,
    },
    {
      id: "statement" as const,
      title: "Upload a statement",
      description: "PDF or CSV",
      Icon: FileUp,
      disabled: false,
      start: onStatement,
    },
    {
      id: "sample" as const,
      title: "Try a sample",
      description: sampleAvailable ? "Sample holdings" : "Sample unavailable",
      Icon: Database,
      disabled: !sampleAvailable,
      start: onSample,
    },
  ];
  return (
    <section className={`app-type-compact ${styles.surface} ${styles.sourcePicker}`} aria-label="Add your portfolio">
      <div className={styles.sourceContent}>
        <div className={styles.importHeading}>
          <p className={styles.sourceEyebrow}>Optional</p>
          <h1 className={styles.sourceTitle}>Add your portfolio</h1>
        </div>
        <div
          className={styles.sourceGrid}
          role="group"
          aria-label="Portfolio source"
          data-testid="finance-setup-source-options"
        >
          {options.map(({ id, title, description, Icon, disabled, start }) => (
            <button
              key={id}
              type="button"
              className={styles.sourceCard}
              data-source={id}
              data-testid={`finance-source-${id}`}
              disabled={disabled || busy}
              onClick={() => {
                if (!busy) start();
              }}
            >
              <span className={styles.sourceIcon} aria-hidden="true"><Icon size={22} /></span>
              <span className={styles.cardText}>
                <span className={styles.cardTitle}>{title}</span>
                <span className={styles.description}>{description}</span>
              </span>
              <ChevronRight size={18} className={styles.chevron} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
      <div className={styles.sourceFooter}>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {busy && (
          <p className="ui-text-row-description text-muted-foreground" role="status">
            {status ?? "Preparing…"}
          </p>
        )}
        <button
          type="button"
          className="ui-text-row-description min-h-11 px-4 text-muted-foreground"
          onClick={onSkip}
          disabled={busy}
        >
          Skip for now
        </button>
      </div>
    </section>
  );
}

export function FinanceOnboardingComplete({
  onFinish,
  busy,
  rootSetup,
  deferred,
  plaidConnected = false,
  autoContinuing = false,
}: {
  onFinish: () => void;
  busy: boolean;
  rootSetup: boolean;
  deferred: boolean;
  plaidConnected?: boolean;
  autoContinuing?: boolean;
}) {
  return (
    <section
      className={`app-type-compact ${styles.complete}`}
      aria-labelledby="finance-complete-title"
    >
      <div>
        <span className={`${styles.completeIcon} ${plaidConnected ? styles.connectedIcon : ""}`} aria-hidden="true">
          <Check size={34} />
        </span>
        <h1 id="finance-complete-title" className="ui-text-page-title">
          {plaidConnected ? "Account connected" : "You're all set"}
        </h1>
        {autoContinuing && (
          <p className="ui-text-row-description text-muted-foreground" role="status">
            {rootSetup ? "Continuing setup…" : "Opening Finance…"}
          </p>
        )}
        {deferred && (
          <p className="ui-text-row-description text-muted-foreground">
            You can add your portfolio any time.
          </p>
        )}
      </div>
      {!autoContinuing && <Button
        type="button"
        size="standard"
        disabled={busy}
        onClick={onFinish}
        aria-busy={busy}
        data-voice-control-id="one-setup-finance-terminal"
      >
        {busy ? "Finishing…" : rootSetup ? "Continue setup" : "Open Finance"}
      </Button>}
    </section>
  );
}
