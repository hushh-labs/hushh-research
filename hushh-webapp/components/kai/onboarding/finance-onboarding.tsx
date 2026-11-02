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
        <FinanceDemoPhone slide={slide} />
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

function FinanceDemoPhone({ slide }: { slide: number }) {
  return (
    <div className={styles.phone} aria-hidden="true" data-demo-slide={slide}>
      <div className={styles.phoneScreen}>
        <div className={styles.island} />
        <div className={styles.phoneTabs}>
          {slides.map((item, index) => (
            <span key={item.label} data-active={index === slide}>
              {item.label}
            </span>
          ))}
        </div>
        <div className={styles.phoneContent} key={slide}>
          {slide === 0 ? (
            <>
              <div className={styles.marketTiles}>
                {[0, 1, 2, 3].map((index) => (
                  <div key={index}>
                    <i />
                    <b />
                    <i className={styles.shortLine} />
                    <svg viewBox="0 0 72 30" fill="none">
                      <path
                        stroke={
                          index % 2
                            ? "var(--app-destructive-deep, #d3302b)"
                            : "var(--app-success-deep, #1e7b34)"
                        }
                        strokeWidth="2"
                        d={
                          index % 2
                            ? "M2 5C14 3 19 14 29 12S48 25 70 25"
                            : "M2 25C14 25 19 14 29 16S48 5 70 5"
                        }
                      />
                    </svg>
                  </div>
                ))}
              </div>
              <div className={styles.miniCard}>
                {[0, 1, 2].map((item) => (
                  <div className={styles.newsRow} key={item}>
                    <div>
                      <b />
                      <i />
                      <i />
                    </div>
                    <span />
                  </div>
                ))}
              </div>
            </>
          ) : slide === 1 ? (
            <>
              <div className={styles.miniCard}>
                <i />
                <b className={styles.valueLine} />
                <div className={styles.factLines}>
                  <i />
                  <i />
                </div>
              </div>
              <div className={`${styles.miniCard} ${styles.ringCard}`}>
                <svg viewBox="0 0 64 64">
                  <circle
                    cx="32"
                    cy="32"
                    r="24"
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth="7"
                  />
                  <circle
                    cx="32"
                    cy="32"
                    r="24"
                    fill="none"
                    stroke="var(--app-accent)"
                    strokeWidth="7"
                    strokeDasharray="105 151"
                    transform="rotate(-90 32 32)"
                  />
                </svg>
                <div>
                  <b />
                  <i />
                  <i />
                </div>
              </div>
              <div className={styles.miniCard}>
                <b />
                <div className={styles.allocation}>
                  <span />
                  <span />
                  <span />
                </div>
                {[0, 1, 2].map((item) => (
                  <div key={item} className={styles.allocationRow}>
                    <span />
                    <i />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className={styles.miniCard}>
                <div className={styles.stockLine}>
                  <span />
                  <div>
                    <b />
                    <i />
                  </div>
                </div>
                <svg
                  className={styles.stockChart}
                  viewBox="0 0 170 54"
                  fill="none"
                >
                  <path
                    d="M0 45L20 35 38 39 62 19 84 28 109 10 132 17 170 2"
                    stroke="var(--app-accent)"
                    strokeWidth="2.5"
                  />
                </svg>
              </div>
              {["Fundamental", "Sentiment", "Valuation"].map((label, index) => (
                <div
                  key={label}
                  className={`${styles.miniCard} ${styles.agentCard}`}
                >
                  <span>{index + 1}</span>
                  <div>
                    <strong>{label}</strong>
                    <i />
                    <i />
                  </div>
                </div>
              ))}
              <div className={styles.miniCard}>
                <strong>Consensus</strong>
                <div className={styles.allocation}>
                  <span />
                </div>
              </div>
            </>
          )}
        </div>
        <div className={styles.phoneDock}>
          <span />
          <span data-active />
          <span />
          <span />
        </div>
      </div>
    </div>
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
