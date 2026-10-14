"use client";

import { useRef, type KeyboardEvent, type ReactNode, type TouchEvent } from "react";
import Image from "next/image";

import styles from "./IntroV2Carousel.module.css";

const STORIES = [
  {
    className: "story-find",
    moment: "Busy morning",
    title: "Start with a clearer day.",
    description: "See what's ahead, what needs a reply, and who needs you.",
    prompt: "What needs my attention today?",
    presence: "answering",
    icons: ["calendar", "mail", "messages"],
  },
  {
    className: "story-act",
    moment: "Looking for something",
    title: "Find what you already have.",
    description: "Ask about a file, a saved detail, or your investments.",
    prompt: "Where did I save that document?",
    presence: "thinking",
    icons: ["memory", "finance", "wallet"],
  },
  {
    className: "story-know",
    moment: "Making plans",
    title: "Make the next move easier.",
    description: "Plan a meeting, draft a reply, or check in with someone.",
    prompt: "When can we meet?",
    presence: "working",
    icons: ["calendar", "mail", "location"],
  },
  {
    className: "story-control",
    moment: "Sharing something personal",
    title: "Share only what you choose.",
    description: "Choose who sees your documents, details, or cards—and for how long.",
    prompt: "Who can see my details?",
    presence: "connected",
    icons: ["consent", "advisor", "wallet"],
  },
] as const;

const ASSET_ROOT = "/onboarding/intro-v2";

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14m-6-6 6 6-6 6" />
    </svg>
  );
}

export function IntroV2Carousel({
  step,
  onStepChange,
  onStart,
  finalActionLabel,
  finalActionDisabled = false,
  invitationContent,
}: {
  /** One-based V2 story index. Zero returns to the existing welcome screen. */
  step: number;
  onStepChange: (step: number) => void;
  onStart: () => void;
  finalActionLabel: string;
  finalActionDisabled?: boolean;
  invitationContent?: ReactNode;
}) {
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable], [role='textbox']")) return;
    const next = step + (event.key === "ArrowRight" ? 1 : -1);
    if (next < 1 || next > STORIES.length) return;
    event.preventDefault();
    onStepChange(next);
  }

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    const touch = event.touches.length === 1 ? event.touches.item(0) : null;
    if (!touch) return;
    touchStart.current = {
      x: touch.clientX,
      y: touch.clientY,
    };
  }

  function handleTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const start = touchStart.current;
    touchStart.current = null;
    const touch = event.changedTouches.length === 1 ? event.changedTouches.item(0) : null;
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    const next = step + (dx < 0 ? 1 : -1);
    if (next >= 1 && next <= STORIES.length) onStepChange(next);
  }

  return (
    <div
      className={styles.experience}
      data-intro-v2="true"
      role="region"
      aria-label="Introducing One"
      aria-roledescription="carousel"
      onKeyDown={handleKeyDown}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={() => { touchStart.current = null; }}
    >
      <span className={`${styles.orbit} ${styles["orbit-one"]}`} aria-hidden="true" />
      <span className={`${styles.orbit} ${styles["orbit-two"]}`} aria-hidden="true" />
      <div className={styles["card-deck"]}>
        {STORIES.map((story, index) => {
          const number = index + 1;
          const active = step === number;
          const Heading = active ? "h1" : "h2";
          return (
            <section
              key={story.title}
              className={`${styles["story-card"]} ${styles[story.className]} ${active ? styles["is-active"] : ""}`}
              data-intro-v2-card="true"
              data-story-index={number}
              aria-label={`${number} of ${STORIES.length}: ${story.title}`}
              aria-roledescription="slide"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("button, a")) return;
                if (!active) onStepChange(number);
              }}
            >
              <div className={styles["art-panel"]} aria-hidden="true">
                <span className={styles.halo} />
                {story.icons.map((icon, position) => (
                  <span
                    key={`${icon}-${position}`}
                    className={`${styles["agent-icon"]} ${styles[`agent-icon-${position}`]}`}
                  >
                    <Image
                      className={styles["icon-light"]}
                      src={`${ASSET_ROOT}/icons/${icon}-light.webp`}
                      alt=""
                      width={256}
                      height={256}
                    />
                    <Image
                      className={styles["icon-dark"]}
                      src={`${ASSET_ROOT}/icons/${icon}-dark.webp`}
                      alt=""
                      width={256}
                      height={256}
                    />
                  </span>
                ))}
                <Image
                  className={styles["one-presence"]}
                  src={`${ASSET_ROOT}/${story.presence}-poster.png`}
                  alt=""
                  width={500}
                  height={500}
                  priority={number === 1}
                />
              </div>
              <div className={styles["card-content"]}>
                <div className={styles["story-copy"]}>
                  <span className={styles["story-kicker"]}>
                    {String(number).padStart(2, "0")} / {String(STORIES.length).padStart(2, "0")}
                    <span aria-hidden="true"> · </span>{story.moment}
                  </span>
                  <Heading
                    data-intro-v2-title="true"
                    data-intro-v2-active-heading={active ? "true" : undefined}
                    tabIndex={active ? -1 : undefined}
                  >
                    {story.title}
                  </Heading>
                  <p>{story.description}</p>
                  <div className={styles["story-prompt"]} aria-label="Try asking One">
                    <span aria-hidden="true">✦</span>{story.prompt}
                  </div>
                  {number === STORIES.length && invitationContent && (
                    <div className={styles["invite-context"]}>{invitationContent}</div>
                  )}
                </div>
                <div className={styles["card-footer"]}>
                  <nav className={styles.dots} aria-label="Choose an introduction screen">
                    {STORIES.map((target, targetIndex) => (
                      <button
                        key={target.title}
                        type="button"
                        className={`${styles.dot} ${targetIndex + 1 === number ? styles["is-active"] : ""}`}
                        aria-label={`Screen ${targetIndex + 1}: ${target.title}`}
                        aria-current={step === targetIndex + 1 ? "step" : undefined}
                        onClick={() => onStepChange(targetIndex + 1)}
                      >
                        <span />
                      </button>
                    ))}
                  </nav>
                  <div className={styles["footer-actions"]}>
                    <button
                      type="button"
                      className={`${styles["text-action"]} ${styles["back-action"]}`}
                      aria-label="Previous screen"
                      onClick={() => onStepChange(number - 1)}
                    >
                      Back
                    </button>
                    {number === 1 && (
                      <button
                        type="button"
                        className={styles["text-action"]}
                        onClick={() => onStepChange(STORIES.length)}
                      >
                        Skip
                      </button>
                    )}
                    {number < STORIES.length ? (
                      <button
                        type="button"
                        className={styles["circle-action"]}
                        aria-label="Next screen"
                        onClick={() => onStepChange(number + 1)}
                      >
                        <ArrowIcon />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={styles["start-action"]}
                        data-voice-control-id="onboarding_claim_one"
                        disabled={finalActionDisabled}
                        onClick={onStart}
                      >
                        {finalActionLabel}<ArrowIcon />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
