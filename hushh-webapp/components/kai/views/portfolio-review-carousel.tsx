"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ArrowRight, Pause, Play } from "@/components/icons";
import { PortfolioDeclineChart } from "@/components/kai/charts/portfolio-decline-chart";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import { useVoiceSurfaceActive } from "@/lib/kai/actions/voice-surface-activity";
import { useMarketCurrency } from "@/lib/kai/use-market-currency";
import { useMediaQuery } from "@/lib/morphy-ux/use-media-query";
import { portfolioDownsideFacts } from "./portfolio-analysis-facts";
import type { DashboardViewModel } from "./dashboard-data-mapper";

const ROTATION_MS = 3000;
const MOBILE_ROTATION_MS = 6000;
const SWIPE_DISTANCE_PX = 40;
const SWIPE_DIRECTION_RATIO = 1.3;
const DROP = 20;

type Slide = { id: "takeaway" | "downside" | "deposits"; label: string; content: ReactNode };

export function PortfolioReviewCarousel({ takeaway, model, netDeposits, missing, onOpen }: {
  takeaway?: string;
  model?: DashboardViewModel;
  netDeposits?: number | null;
  missing?: string;
  onOpen: () => void;
}) {
  const { format: money } = useMarketCurrency();
  const active = useVoiceSurfaceActive();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const mobile = useMediaQuery("(width < 900px)");
  const swipeStart = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [touching, setTouching] = useState(false);
  const [selection, setSelection] = useState<Slide["id"] | null>(null);
  const [pauseOverride, setPauseOverride] = useState<boolean | null>(null);
  const [hovered, setHovered] = useState(false);
  const [reading, setReading] = useState(false);
  const [visible, setVisible] = useState(true);
  const paused = pauseOverride ?? reducedMotion;
  const rotationLabel = paused ? "Resume review rotation" : "Pause review rotation";
  const scenario = useMemo(() => portfolioDownsideFacts(model), [model]);
  const slides: Slide[] = [];
  if (takeaway) {
    slides.push({
      id: "takeaway",
      label: "Takeaway",
      content: <p className={styles.portfolioReviewTakeaway}>{takeaway}</p>,
    });
  }
  if (scenario.stock || scenario.canShowInvestedScenario) {
    slides.push({
      id: "downside",
      label: "Downside",
      content: (
        <div className={styles.portfolioScenarioSlide}>
          <div className={styles.portfolioScenarioCopy}>
            <h3 className={styles.portfolioSlideTitle}>
              {scenario.stock ? "Largest stock down 20%" : "Investments down 20%"}
            </h3>
            <p className={styles.portfolioScenarioResult}>
              <strong>−{(scenario.weight * DROP).toFixed(1)}%</strong>
              <span>estimate if other holdings stay flat</span>
            </p>
          </div>
          <PortfolioDeclineChart drop={DROP} compact />
        </div>
      ),
    });
  }
  if (typeof netDeposits === "number" && Number.isFinite(netDeposits)) {
    slides.push({
      id: "deposits",
      label: netDeposits < 0 ? "Withdrawals" : "Deposits",
      content: <>
        <h3 className={styles.portfolioSlideTitle}>{netDeposits < 0 ? "Net withdrawals" : "Net deposits"}</h3>
        <p className={styles.portfolioDepositsValue}>{money(Math.abs(netDeposits))}</p>
        <p className={styles.portfolioSlideNote}>This statement period.</p>
      </>,
    });
  }
  const index = Math.max(0, slides.findIndex(slide => slide.id === selection));
  const slide = slides[index];
  const next = slides.length > 1 ? slides[(index + 1) % slides.length]?.id : undefined;
  const canSwipe = mobile && Boolean(next);
  const rotationMs = mobile ? MOBILE_ROTATION_MS : ROTATION_MS;

  function selectSlide(id: Slide["id"]) {
    setSelection(id);
    setPauseOverride(true);
  }

  function startSwipe(event: PointerEvent<HTMLDivElement>) {
    if (!canSwipe || event.pointerType !== "touch" || !event.isPrimary) return;
    swipeStart.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setTouching(true);
  }

  function resetSwipe(event: PointerEvent<HTMLDivElement>) {
    if (swipeStart.current?.pointerId !== event.pointerId) return;
    swipeStart.current = null;
    setTouching(false);
  }

  function finishSwipe(event: PointerEvent<HTMLDivElement>) {
    const start = swipeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    resetSwipe(event);
    if (!canSwipe) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const horizontal = Math.abs(dx);
    if (horizontal < SWIPE_DISTANCE_PX || horizontal <= Math.abs(dy) * SWIPE_DIRECTION_RATIO) return;
    const destination = slides[index + (dx < 0 ? 1 : -1)];
    if (destination) selectSlide(destination.id);
  }

  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (!next || !active || !visible || paused || hovered || reading || touching) return;
    const timer = window.setTimeout(() => {
      if (!swipeStart.current) setSelection(next);
    }, rotationMs);
    return () => window.clearTimeout(timer);
  }, [next, active, visible, paused, hovered, reading, touching, rotationMs]);

  return (
    <div
      className={styles.portfolioCarousel}
      data-no-route-swipe
      onPointerEnter={event => { if (event.pointerType === "mouse") setHovered(true); }}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={event => setReading(!event.target.matches("[data-review-playback]"))}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setReading(false); }}
    >
      <div
        className={styles.portfolioSlideStage}
        data-portfolio-review-swipe={canSwipe || undefined}
        data-swipe-views-horizontal-scroll={canSwipe || undefined}
        aria-live={paused ? "polite" : "off"}
        onPointerDown={startSwipe}
        onPointerUp={finishSwipe}
        onPointerCancel={resetSwipe}
        onLostPointerCapture={resetSwipe}
      >
        {slide ? (
          <div className={styles.portfolioSlideTrack} data-portfolio-review-track style={{ transform: `translateX(${index * -100}%)` }}>
            {slides.map(item => (
              <div key={item.id} className={styles.portfolioSlide} aria-hidden={item.id !== slide.id} inert={item.id !== slide.id}>
                {item.content}
              </div>
            ))}
          </div>
        ) : missing ? <p className={styles.description}>Complete your persona</p> : null}
      </div>
      <div className={styles.portfolioSlideControls}>
        {slides.length > 1 ? (
          <div className={styles.portfolioSlideOptions} role="group" aria-label="Portfolio review views">
            {slides.map(option => (
              <button key={option.id} type="button" aria-pressed={option.id === slide?.id} onClick={() => selectSlide(option.id)}>{option.label}</button>
            ))}
            <button
              type="button"
              className={styles.portfolioSlidePlayback}
              data-review-playback
              aria-label={rotationLabel}
              title={rotationLabel}
              onClick={() => setPauseOverride(!paused)}
            >
              {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
            </button>
          </div>
        ) : null}
        <button type="button" className={styles.portfolioBriefingLink} aria-label="View analysis" onClick={onOpen}>
          Open review <ArrowRight size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
