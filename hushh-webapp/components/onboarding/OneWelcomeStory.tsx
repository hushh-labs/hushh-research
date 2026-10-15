"use client";

import Image from "next/image";
import type { ReactNode, RefObject } from "react";
import styles from "./IntroStep.module.css";

const MASCOT_SRC = "/onboarding/welcome-stitch/one-mascot.png";

type CueKind = "calendar" | "mail" | "consent";

function WelcomeIcon({ name }: { name: CueKind }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {name === "calendar" && (
        <>
          <rect x="3.5" y="5" width="17" height="16" rx="3" />
          <path d="M7.5 3v4m9-4v4M4 10h16m-12 4h1m6 0h1m-8 3h1" />
        </>
      )}
      {name === "mail" && (
        <>
          <rect x="3" y="5" width="18" height="14" rx="3" />
          <path d="m4 7 8 6 8-6" />
        </>
      )}
      {name === "consent" && (
        <>
          <rect x="5" y="10" width="14" height="11" rx="3" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
        </>
      )}
    </svg>
  );
}

function WelcomeCue({ kind, label }: { kind: CueKind; label: string }) {
  const position = {
    calendar: styles.cueCalendar,
    mail: styles.cueMail,
    consent: styles.cueConsent,
  }[kind];

  return (
    <div className={[styles.cue, position].join(" ")} data-welcome-cue={kind}>
      <span className={styles.cueIcon}><WelcomeIcon name={kind} /></span>
      <span>{label}</span>
    </div>
  );
}

/** Canonical mascot collage shared by the welcome and sign-in screens. */
export function OneWelcomeArtwork({ motionEnabled = false }: { motionEnabled?: boolean }) {
  return (
    <div className={styles.visual} data-motion={motionEnabled ? "on" : "off"} data-welcome-scene aria-hidden="true">
      <div className={styles.artboard} data-welcome-artwork>
        <svg className={styles.shapes} viewBox="0 0 400 466" fill="none" focusable="false">
          <path fill="#f7b5d5" d="M63 167C87 151 122 155 135 178L170 266C181 293 169 324 144 337L91 363C61 378 37 363 31 334L20 235C16 205 36 184 63 167Z" />
          <path fill="#ffdd6b" d="M268 155C280 139 304 139 313 157C329 145 353 152 354 173C376 174 384 198 369 213C387 229 379 252 356 255C363 278 343 293 323 283C317 306 291 309 279 288C259 301 239 286 244 263C222 260 215 236 232 220C213 205 222 181 244 180C244 159 257 152 268 155Z" />
          <path fill="#ff715d" d="M284 286C312 279 343 290 356 315C375 351 353 390 317 399L278 409L267 368L300 359C316 355 326 342 319 329C313 318 302 315 292 318L267 325L255 294L284 286Z" />
          <path fill="#b8cfff" d="M97 331C136 313 182 328 198 361C213 392 195 418 164 429C130 441 98 419 90 389C83 366 82 345 97 331Z" />
          <g stroke="#29292e" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M65 139l-6-12M75 135l-1-13M85 138l5-12" />
            <path d="M326 441c-18 8-40 11-61 7M269 443l-7 4 7 5" />
          </g>
        </svg>
        <Image className={styles.wordmark} src="/onboarding/figma/one-light.svg" alt="" width={221} height={91} priority data-welcome-wordmark />
        <Image className={styles.mascot} src={MASCOT_SRC} alt="" width={1254} height={1254} priority data-welcome-mascot />
        <WelcomeCue kind="calendar" label="Find a time" />
        <WelcomeCue kind="mail" label="Catch me up" />
        <WelcomeCue kind="consent" label="My access" />
      </div>
    </div>
  );
}

/** Shared web and iOS WebView welcome, before the existing four-slide introduction. */
export function OneWelcomeStory({
  headingRef,
  motionEnabled,
  children,
}: {
  headingRef: RefObject<HTMLDivElement | null>;
  motionEnabled: boolean;
  children: ReactNode;
}) {
  return (
    <section className={styles.composition} aria-label="Welcome to One">
      <OneWelcomeArtwork motionEnabled={motionEnabled} />
      <div className={styles.content}>
        <div ref={headingRef} tabIndex={-1} className={styles.headingFocus}>
          <h1 className={styles.heading}>
            <span>Your private AI agent</span>{" "}
            <span>for everyday life.</span>
          </h1>
        </div>
        {children}
      </div>
    </section>
  );
}
