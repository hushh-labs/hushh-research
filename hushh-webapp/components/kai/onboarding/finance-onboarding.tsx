"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Building2,
  Check,
  Database,
  FileUp,
  LockKeyhole,
} from "@/components/icons";
import { usePathname } from "next/navigation";
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
  const [slide, setSlide] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const pathname = usePathname();
  useBackLayer(pathname, 2, () => {
    if (slide === 0) return false;
    setPaused(true);
    setSlide((value) => value - 1);
    return true;
  });
  const touch = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (reducedMotion || paused || document.hidden) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setSlide((value) => (value + 1) % slides.length);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [paused, reducedMotion]);
  return (
    <section
      className={`${styles.surface} ${styles.demo}`}
      aria-label="Meet Finance"
      onFocusCapture={() => setPaused(true)}
      onPointerDown={(event) => {
        setPaused(true);
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
        ) {
          setSlide((value) =>
            Math.max(0, Math.min(2, value + (dx < 0 ? 1 : -1))),
          );
        }
      }}
    >
      <button type="button" className={styles.skipDemo} onClick={onContinue}>
        Skip
      </button>
      <div className={styles.introduction} key={slide}>
        <p className={styles.eyebrow}>{slides[slide]!.label}</p>
        <h1 className={styles.title}>{slides[slide]!.title}</h1>
        <p className={styles.description}>{slides[slide]!.description}</p>
      </div>
      <div className={styles.phoneRegion}>
        <FinanceDemoPhone
          slide={slide}
          labels={slides.map((item) => item.label)}
        />
      </div>
      <div className={styles.demoFooter}>
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
              onClick={() => {
                setPaused(true);
                setSlide(index);
              }}
            >
              <span />
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.primary}
          onClick={() => {
            setPaused(true);
            if (slide < 2) setSlide(slide + 1);
            else onContinue();
          }}
        >
          {slide < 2 ? "Next" : "Continue"}
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
  const [selected, setSelected] = useState<FinanceSource>(
    plaidAvailable ? "plaid" : "statement",
  );
  const pathname = usePathname();
  useBackLayer(pathname, 2, () => {
    if (busy) return true;
    if (!onBack) return false;
    onBack();
    return true;
  });
  const source =
    (selected === "plaid" && !plaidAvailable) ||
    (selected === "sample" && !sampleAvailable)
      ? "statement"
      : selected;
  const options = [
    {
      id: "plaid" as const,
      title: "Connect an account",
      description: plaidAvailable
        ? "Read-only, via Plaid"
        : "Bank connection unavailable",
      Icon: Building2,
      disabled: !plaidAvailable,
    },
    {
      id: "statement" as const,
      title: "Upload a statement",
      description: "PDF or CSV",
      Icon: FileUp,
      disabled: false,
    },
    {
      id: "sample" as const,
      title: "Try a sample",
      description: "Sample holdings",
      Icon: Database,
      disabled: !sampleAvailable,
    },
  ];
  return (
    <section
      className={`${styles.surface} ${styles.import}`}
      aria-labelledby="finance-source-title"
    >
      {onBack && (
        <button
          type="button"
          className={styles.back}
          aria-label="Back to Finance introduction"
          onClick={onBack}
          disabled={busy}
        >
          <ArrowLeft size={20} />
        </button>
      )}
      <div className={styles.importHeading}>
        <p className={styles.eyebrow}>Optional</p>
        <h1 id="finance-source-title" className={styles.title}>
          Add your portfolio
        </h1>
      </div>
      <div
        className={styles.sourceGrid}
        role="group"
        aria-label="Portfolio source"
      >
        {options.map(({ id, title, description, Icon, disabled }) => (
          <button
            type="button"
            key={id}
            className={styles.sourceCard}
            data-source={id}
            aria-pressed={source === id}
            disabled={disabled || busy}
            onClick={() => setSelected(id)}
          >
            <span className={styles.selection}>
              {source === id && <Check size={14} />}
            </span>
            {id === "plaid" && (
              <span className={styles.recommended}>Recommended</span>
            )}
            {id !== "plaid" && (
              <span className={styles.sourceIcon}>
                <Icon size={22} />
              </span>
            )}
            <span className={styles.cardTitle}>{title}</span>
            <span className={styles.description}>{description}</span>
            {id === "plaid" && (
              <span className={styles.connectionArt} aria-hidden="true">
                <span className={styles.sourceIcon}>
                  <Building2 size={22} />
                </span>
                <span className={styles.connectionLine} />
                <span className={styles.oneIcon}>
                  <ArrowUpRight size={22} />
                </span>
              </span>
            )}
          </button>
        ))}
      </div>
      <p className={styles.trust}>
        <LockKeyhole size={16} aria-hidden="true" /> Read-only. You choose what
        to share.
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.importFooter}>
        <button
          type="button"
          className={styles.primary}
          disabled={busy}
          onClick={() => {
            if (busy) return;
            if (source === "plaid") onConnect();
            else if (source === "statement") onStatement();
            else onSample();
          }}
          aria-busy={busy}
        >
          {busy
            ? (status ?? "Preparing…")
            : source === "plaid"
              ? "Connect account"
              : source === "statement"
                ? "Choose statement"
                : "Load sample"}
        </button>
        <button
          type="button"
          className={styles.utility}
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
}: {
  onFinish: () => void;
  busy: boolean;
  rootSetup: boolean;
  deferred: boolean;
}) {
  return (
    <section
      className={`${styles.surface} ${styles.complete}`}
      aria-labelledby="finance-complete-title"
    >
      <div>
        <span className={styles.completeIcon}>
          <Check size={34} />
        </span>
        <h1 id="finance-complete-title" className={styles.title}>
          You&apos;re all set
        </h1>
        {deferred && (
          <p className={styles.description}>
            You can add your portfolio any time.
          </p>
        )}
      </div>
      <button
        type="button"
        className={styles.primary}
        disabled={busy}
        onClick={onFinish}
        aria-busy={busy}
        data-voice-control-id="one-setup-finance-terminal"
      >
        {busy ? "Finishing…" : rootSetup ? "Continue setup" : "Open Finance"}
      </button>
    </section>
  );
}
